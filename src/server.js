import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createLedger } from './ledger.js';
import { createPayPal } from './paypal.js';
import { createMockPayPal } from './paypal-mock.js';
import { createTokens, createGate } from './gate.js';
import { createRouter } from './router.js';
import { applyFaultDrill } from './fault-drill.js';
import { createCallService, CallNotFound, GapRefused, LIVE_TEMPLATE_HASH, LIVE_UNREVIEWED, LIVE_TEMPLATE_ERROR } from './call.js';
import { createRefundDesk } from './refund-desk.js';
import { TEMPLATE_HASH } from './template-words.js';
import { PILOT_SCRIPTS, displayLines } from './pilot-scripts.js';
import { staffCalls, staffCall, staffKeyMatches } from './staff.js';
import { DRILLS, DrillRefused, drillLines, drillOpen } from './drill.js';
import { createReceiptSigner, secretMatches, verifyReceipt, RECEIPT_ALG, RECEIPT_MAX_BYTES } from './receipt-seal.js';
import { receiptFile } from './receipt-file.js';
import { createProcurementService } from './procurement.js';
import { createProcurementHttp } from './procurement-http.js';
import { connectDatabase } from './database.js';
import { configureRuntimeServices } from './runtime-services.js';
import { wrapDurableCalls, observeMockPayPal, DonorDurabilityError } from './donor-durability.js';
import { createReadiness } from './readiness.js';
import { runRehearsal } from './rehearsal.js';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const JSON_LIMIT_BYTES = 16 * 1024;
const WEBHOOK_LIMIT_BYTES = 64 * 1024;
const WEBHOOK_LIST_MAX = 50;
const TEXT_LIMIT_CHARS = 2000;
const GAP_MAX_MS = 600000;
const SWEEP_EVERY_MS = 30000;
const HOUR_MS = 3600000;
const MINUTE_MS = 60000;
const RATE_KEYS_MAX = 10000;
const CALL_PATH = /^\/api\/calls\/([0-9a-f-]{36})(?:\/(turn|gap|end))?$/;
const STAFF_CALLS_PATH = /^\/api\/staff\/calls(?:\/([0-9a-f-]{36}))?$/;
// The staff page and its files. With no STAFF_KEY they are 404s like every staff route, so the view is simply off.
const STAFF_FILES = new Set(['staff.html', 'staff.js', 'staff.css']);
const STAFF_DIRS = new Set(['vendor']);
// The donor's receipt page and the check page. With no RECEIPT_SIGNING_KEY they are 404s like every receipt route.
const RECEIPT_FILES = new Set(['receipt.html', 'receipt.js', 'receipt.css', 'check.html', 'receipt-check.js']);
const RECEIPT_PAGES = Object.freeze({ '/receipt': 'receipt.html', '/check': 'check.html' });
const RECEIPT_PATH = /^\/api\/receipts\/([0-9a-f-]{36})$/;
const STATIC_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.vtt': 'text/vtt; charset=utf-8',
});
const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
});

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export function createLogger(write = (line) => process.stdout.write(`${line}\n`)) {
  return {
    info: (line) => write(line),
    error: (line) => write(`error ${line}`),
  };
}

export function createRateLimiter({ limit, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  const recent = (key, at) => (hits.get(key) ?? []).filter((t) => at - t < windowMs);
  return {
    allow(key) {
      const at = now();
      const kept = recent(key, at);
      if (kept.length >= limit) {
        hits.set(key, kept);
        return false;
      }
      if (!hits.has(key) && hits.size >= RATE_KEYS_MAX) hits.delete(hits.keys().next().value);
      hits.set(key, [...kept, at]);
      return true;
    },
    /** How long until this key may go again, 0 when it may go now. */
    waitMs(key) {
      const at = now();
      const kept = recent(key, at);
      return kept.length < limit ? 0 : Math.max(0, windowMs - (at - kept[0]));
    },
  };
}

/** Counts wrong PINs per caller address, so starting new calls never buys more PIN guesses. */
export function createPinGuard({ limit, windowMs, now = () => Date.now() }) {
  const misses = new Map();
  const recent = (key, at) => (misses.get(key) ?? []).filter((t) => at - t < windowMs);
  return {
    blocked: (key) => recent(key, now()).length >= limit,
    record(key) {
      const at = now();
      if (!misses.has(key) && misses.size >= RATE_KEYS_MAX) misses.delete(misses.keys().next().value);
      misses.set(key, [...recent(key, at), at]);
    },
  };
}

/** PayPal's docs put the invoice id at resource.id, the live v2 shape is unconfirmed (facts note 5). */
export function resourceIdOf(event) {
  const resource = event?.resource;
  const id = typeof resource?.id === 'string' ? resource.id : null;
  if (id && id.startsWith('INV2-')) return id.slice(0, 100);
  if (typeof resource?.invoice?.id === 'string') return resource.invoice.id.slice(0, 100);
  return id ? id.slice(0, 100) : null;
}

const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);

/** Verifies and logs PayPal webhooks. PayPal delivers at least once, so copies dedupe by event id. */
export function createWebhookHandler({ paypal, ledger, webhookId, log, journal = null, organizationId = 'demo-organization' }) {
  // Reload accepted IDs from the ledger so a provider retry after a process restart stays idempotent.
  const verifiedIds = new Set(ledger.byType('webhook').filter((e) => e.verified && e.eventId).map((e) => e.eventId));
  const inflight = new Map();

  async function record(entry) {
    await ledger.ensureCapacity?.();
    ledger.append({ type: 'webhook', ...entry }, { durable: true });
    await ledger.flush?.();
    log.info(`webhook ${entry.eventType} ${entry.resourceId} verified=${entry.verified}`);
  }

  async function verifyOnce(entry, headers, rawBody) {
    const { verified, verifyStatus } = await paypal.verifyWebhookSignature({ headers, rawBody, webhookId });
    if (verified && journal) await journal.acceptVerifiedWebhook({ organizationId, provider: 'paypal-sandbox', eventId: entry.eventId, rawBody, verified: true });
    // The id is untrusted until this delivery is verified. A forged body must not inherit a prior event's status.
    if (verified && (verifiedIds.has(entry.eventId) || ledger.byType('webhook').some((event) => event.verified && event.eventId === entry.eventId))) {
      log.info(`webhook ${entry.eventType} ${entry.resourceId} duplicate`);
      return { verified: true, verifyStatus: 'DUPLICATE' };
    }
    await record({ ...entry, verified, verifyStatus });
    if (verified) verifiedIds.add(entry.eventId);
    return { verified, verifyStatus };
  }

  async function handle({ rawBody, headers }) {
    await ledger.reload?.();
    let event = null;
    try {
      event = JSON.parse(Buffer.from(rawBody).toString('utf8'));
    } catch {
      event = null;
    }
    const entry = {
      eventId: clip(event?.id, 200),
      eventType: clip(event?.event_type, 100),
      resourceId: resourceIdOf(event),
      transmissionId: clip(headers?.['paypal-transmission-id'], 200),
    };
    if (!entry.eventId) {
      await record({ ...entry, verified: false, verifyStatus: 'BAD_BODY' });
      return { verified: false, verifyStatus: 'BAD_BODY' };
    }
    const before = inflight.get(entry.eventId) ?? Promise.resolve();
    const run = before.then(() => verifyOnce(entry, headers, rawBody));
    const settled = run.catch(() => {});
    inflight.set(entry.eventId, settled);
    try {
      return await run;
    } finally {
      if (inflight.get(entry.eventId) === settled) inflight.delete(entry.eventId);
    }
  }

  function recent(limit = WEBHOOK_LIST_MAX) {
    const byId = new Map();
    const loose = [];
    for (const e of ledger.byType('webhook')) {
      if (!e.eventId) loose.push(e);
      else if (!byId.has(e.eventId) || !byId.get(e.eventId).verified) byId.set(e.eventId, e);
    }
    return [...byId.values(), ...loose]
      .sort((a, b) => b.seq - a.seq)
      .slice(0, limit)
      .map((e) => ({ eventId: e.eventId, eventType: e.eventType, resourceId: e.resourceId, verified: e.verified, verifyStatus: e.verifyStatus, transmissionId: e.transmissionId, ts: e.ts }));
  }

  return { handle, recent };
}

export function buildDeps(config, overrides = {}) {
  const now = overrides.now ?? (() => new Date());
  const log = overrides.log ?? createLogger();
  const ledger = overrides.ledger ?? createLedger({ path: overrides.ledgerPath ?? config.ledgerPath, now });
  const tokens = createTokens({ now, ttlMs: config.limits.tokenTtlMs });
  let webhooks = null;
  let paypal = config.paypal.mode === 'mock'
    ? applyFaultDrill(createMockPayPal({ tokens, now, onWebhook: (delivery) => webhooks?.handle(delivery), ...(overrides.mockOptions ?? {}) }), config.faultDrill, tokens)
    : createPayPal({ baseUrl: config.paypal.baseUrl, clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, tokens, fetchImpl: overrides.fetchImpl ?? fetch });
  if (overrides.durability) paypal = observeMockPayPal(paypal);
  webhooks = createWebhookHandler({ paypal, ledger, webhookId: config.paypal.webhookId, log, journal: overrides.journal ?? null });
  const router = overrides.router ?? overrides.agent ?? (['anthropic', 'haiku'].includes(config.router.mode)
    ? { mode: config.router.mode, route: async () => ({ intent: 'unclear', amountDollars: 0, empathy: 'none', latencyMs: 0, model: config.router.model, error: 'AI_GATEWAY_REQUIRED' }) }
    : createRouter({ mode: config.router.mode, apiKey: config.router.apiKey, model: config.router.model }));
  const gate = createGate({ ledger, tokens, now, pendingTtlMs: config.limits.pendingTtlMs, durability: overrides.durability });
  // Only the public Render service needs it. Locally the line listens on this computer alone, and Script 8 uses three wrong PINs.
  const pinGuard = config.trustProxy ? createPinGuard({ limit: config.limits.wrongPinsPerHour, windowMs: HOUR_MS, now: () => now().getTime() }) : null;
  const desk = createRefundDesk({ ledger, tokens });
  const rawCalls = createCallService({ config, ledger, paypal, router, gate, now, pinGuard, desk, durability: overrides.durability, ...(overrides.sleep ? { sleep: overrides.sleep } : {}) });
  const calls = overrides.durability ? wrapDurableCalls({ calls: rawCalls, store: overrides.donorStore, ledger, durability: overrides.durability, paypal, now }) : rawCalls;
  // Off, with every receipt route a 404, unless RECEIPT_SIGNING_KEY is set.
  const receiptSigner = config.receiptSigningKey ? createReceiptSigner(config.receiptSigningKey) : null;
  return { config, ledger, tokens, paypal, router, gate, calls, webhooks, log, now, receiptSigner, journal: overrides.journal ?? null,
    agent: overrides.agent ?? null, aiGateway: overrides.aiGateway ?? null, suppliers: overrides.suppliers ?? null,
    checkout: overrides.checkout ?? null, checkoutStore: overrides.checkoutStore ?? null, commerceStatus: overrides.commerceStatus ?? null,
    checkReadiness: overrides.checkReadiness ?? null };
}

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(res.headOnly ? undefined : payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      // Past the limit the rest is drained and dropped, so the 413 still reaches the client.
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => (size > limit ? reject(new HttpError(413, 'That request is too large.')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req, JSON_LIMIT_BYTES);
  if (raw.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'That request body is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'The request body must be a JSON object.');
  return parsed;
}

/** Maps a raw request path to a file inside web/, or null. Decodes first, then refuses traversal. */
export function resolveStatic(rawPath, webDir = WEB_DIR) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const parts = (decoded === '/' ? '/index.html' : decoded).split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p === '..' || p === '.' || path.isAbsolute(p) || /^[a-zA-Z]:/.test(p))) return null;
  const full = path.resolve(webDir, ...parts);
  if (!full.startsWith(webDir + path.sep)) return null;
  return STATIC_TYPES[path.extname(full)] ? full : null;
}

/** True for a file only the staff view uses, which stays a 404 while the staff view is off. */
export function isStaffFile(file, webDir = WEB_DIR) {
  const parts = path.relative(webDir, file).split(path.sep);
  // Lowercased, since a Mac's disk serves /Staff.js as staff.js.
  const head = parts[0].toLowerCase();
  return parts.length === 1 ? STAFF_FILES.has(head) : STAFF_DIRS.has(head);
}

/** True for a file only the receipt pages use, which stays a 404 while receipts are off. */
export function isReceiptFile(file, webDir = WEB_DIR) {
  const parts = path.relative(webDir, file).split(path.sep);
  return parts.length === 1 && RECEIPT_FILES.has(parts[0].toLowerCase());
}

function serveFile(res, file, { hideStaffLinks = false, paymentMode = null } = {}) {
  fs.stat(file, (statError, stat) => {
    if (statError || !stat.isFile()) return send(res, 404, { error: 'Not found.' });
    fs.readFile(file, (readError, data) => {
      if (readError) return send(res, 500, { error: 'Something went wrong on our side.' });
      // Render the donor navigation on the server. It stays correct without JavaScript and never sends the key.
      let body = hideStaffLinks
        ? data.toString('utf8').replace(/<!-- staff-only:start -->[\s\S]*?<!-- staff-only:end -->/g, '')
        : data;
      if (paymentMode) body = body.toString('utf8').replace(/<body(?: data-payments="mock")?>/, `<body data-payments="${paymentMode === 'paypal-sandbox' ? 'paypal-sandbox' : 'mock'}">`);
      send(res, 200, body, STATIC_TYPES[path.extname(file)]);
    });
  });
}

function serveStatic(req, res, webDir, staffOn, receiptsOn) {
  const rawPath = req.url.split('?')[0];
  const file = resolveStatic(rawPath, webDir);
  if (!file) return send(res, rawPath.includes('..') ? 400 : 404, { error: 'Not found.' });
  // Checked on the resolved file, so an encoded path such as /%73taff.js can't reach it either.
  if (!staffOn && isStaffFile(file, webDir)) return send(res, 404, { error: 'Not found.' });
  if (!receiptsOn && isReceiptFile(file, webDir)) return send(res, 404, { error: 'Not found.' });
  const donorPage = path.relative(webDir, file).toLowerCase() === 'index.html';
  serveFile(res, file, { hideStaffLinks: donorPage && !staffOn });
}

/**
 * A client can send its own X-Forwarded-For, and a proxy adds the address it saw at the end.
 * So only the right-most entry is used. A client cannot set it whether Render appends or replaces.
 */
export function clientIp(req, trustProxy) {
  const socketIp = req.socket?.remoteAddress ?? 'unknown';
  const forwarded = req.headers['x-forwarded-for'];
  if (!trustProxy || typeof forwarded !== 'string') return socketIp;
  return forwarded.split(',').map((part) => part.trim()).filter(Boolean).pop() ?? socketIp;
}

function tooManyRequests(waitMs, local) {
  const minutes = Math.max(1, Math.ceil(waitMs / MINUTE_MS));
  const wait = `Too many requests from here. Please try again in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
  const hint = local ? ' Restarting npm start also clears this.' : '';
  return new HttpError(429, `${wait}${hint}`, { 'Retry-After': String(Math.max(1, Math.ceil(waitMs / 1000))) });
}

const isTurnNumber = (value) => Number.isInteger(value) && value >= 0;

function validTurnBody(body) {
  if (typeof body.text !== 'string' || body.text.length > TEXT_LIMIT_CHARS) throw new HttpError(400, 'text must be a short string.');
  if (body.source !== undefined && !['voice', 'typed', 'keypad'].includes(body.source)) throw new HttpError(400, 'source must be voice, typed or keypad.');
  // answering is the turn of the last reply the page received. Without it a yes never counts (I6).
  if (body.answering !== undefined && !isTurnNumber(body.answering)) throw new HttpError(400, 'answering must be a turn number.');
  return { text: body.text, source: body.source ?? 'typed', answering: body.answering ?? null };
}

function validGapBody(body) {
  const ok = isTurnNumber(body.turn) && Number.isFinite(body.gapMs) && body.gapMs >= 0 && body.gapMs <= GAP_MAX_MS
    && ['voice', 'typed', 'keypad'].includes(body.source) && (body.muted === undefined || typeof body.muted === 'boolean')
    && (body.played === undefined || typeof body.played === 'boolean');
  if (!ok) throw new HttpError(400, 'gap needs turn, gapMs, source and muted.');
  return { turn: body.turn, gapMs: Math.round(body.gapMs), source: body.source, muted: Boolean(body.muted), ...(typeof body.played === 'boolean' ? { played: body.played } : {}) };
}

function createApi(deps) {
  const { config, calls, webhooks } = deps;
  const newCalls = createRateLimiter({ limit: config.limits.newCallsPerHour, windowMs: HOUR_MS });
  const turns = createRateLimiter({ limit: config.limits.turnsPerMinute, windowMs: MINUTE_MS });
  const scripts = PILOT_SCRIPTS.map((s) => ({ number: s.number, title: s.title, lines: displayLines(s), expected: s.expected }));
  const drills = Object.values(DRILLS).map(drillLines);
  const clock = deps.now ?? (() => new Date());
  const checkReadiness = deps.checkReadiness ?? createReadiness({ requireDatabase: Boolean(deps.journal || deps.ledger.durable),
    requireAi: config.router.mode === 'anthropic', aiStatus: deps.aiGateway ? () => deps.aiGateway.status() : null,
    commerceStatus: deps.commerceStatus ?? (() => ({})), now: () => clock().getTime() });
  const staffRequests = createRateLimiter({ limit: config.limits.staffPerMinute, windowMs: MINUTE_MS });
  const receiptRequests = createRateLimiter({ limit: config.limits.receiptsPerMinute, windowMs: MINUTE_MS });
  const rehearsals = createRateLimiter({ limit: 12, windowMs: MINUTE_MS });
  const limitOr429 = (limiter, ip) => { if (!limiter.allow(ip)) throw tooManyRequests(limiter.waitMs(ip), !config.trustProxy); };
  const procurementRoute = createProcurementHttp({
    createService: (scenario) => {
      const service = createProcurementService({ now: clock, journal: deps.journal ?? null, agent: deps.agent ?? null, suppliers: deps.suppliers ?? null });
      return { ...service, request: (rfq) => service.request({ ...rfq, scenario }) };
    },
    send, readJson, limiter: createRateLimiter({ limit: 60, windowMs: MINUTE_MS }), now: () => clock().getTime(),
    interpretGoal: typeof deps.agent?.interpretGoal === 'function'
      ? (goal, priorGoals = []) => deps.agent.interpretGoal({ goal, ...(priorGoals.length ? { priorGoals } : {}), now: clock().getTime(), timeZone: config.timeZone }) : null,
    checkout: deps.checkout, checkoutStore: deps.checkoutStore, commerceStatus: deps.commerceStatus ?? (() => ({})),
  });

  // A drill asked for with a script, by an unknown name, or on the sandbox before the deadline is refused (A12).
  async function startCall(input) {
    try {
      return await calls.start(input);
    } catch (error) {
      if (error instanceof DrillRefused) throw new HttpError(error.status, error.message);
      throw error;
    }
  }

  // A second gap for a turn is a 409, and so is one for a reply the line has not finished (Test 4).
  async function logGap(id, gap) {
    try {
      return await calls.logGap(id, gap);
    } catch (error) {
      if (error instanceof GapRefused) throw new HttpError(error.status, error.message);
      throw error;
    }
  }

  async function callRoute(req, res, ip, id, action) {
    // Keep arrival time before storage/authentication waits. An early yes must never become late consent.
    const receivedAt = performance.now();
    const secret = req.headers['x-call-secret'];
    if (!await calls.authenticate(id, typeof secret === 'string' ? secret : '')) throw new HttpError(401, 'That call session is not available.');
    if (!action) {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
      return send(res, 200, await calls.get(id));
    }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    // When the turn reached the server, before its body is read, so a yes can't count before a person could answer (I1).
    const body = await readJson(req);
    if (action === 'turn') {
      limitOr429(turns, ip);
      return send(res, 200, await calls.turn(id, validTurnBody(body), { receivedAt }));
    }
    if (action === 'gap') return send(res, 200, await logGap(id, validGapBody(body)));
    return send(res, 200, await calls.end(id, 'client'));
  }

  /**
   * The staff view. Off, as a 404, when STAFF_KEY is unset. The page itself holds no data. The API needs the key in
   * x-staff-key, and the limit runs before the key check, so wrong keys are limited too.
   */
  async function staffRoute(req, res, pathname, ip) {
    if (!config.staffKey) throw new HttpError(404, 'Not found.');
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
    if (pathname === '/staff') return serveFile(res, path.join(deps.webDir ?? WEB_DIR, 'staff.html'));
    const match = pathname.match(STAFF_CALLS_PATH);
    if (!match) throw new HttpError(404, 'Not found.');
    limitOr429(staffRequests, ip);
    const given = req.headers['x-staff-key'];
    if (!staffKeyMatches(typeof given === 'string' ? given : '', config.staffKey)) throw new HttpError(401, 'That staff key is not right.');
    await deps.ledger.reload?.();
    if (!match[1]) return send(res, 200, { calls: staffCalls(deps.ledger, config) });
    const call = staffCall(deps.ledger, match[1], config);
    if (!call) throw new HttpError(404, 'That call is not in the record.');
    return send(res, 200, { call });
  }

  /**
   * The donor's receipt. Off, as a 404, when RECEIPT_SIGNING_KEY is unset. A call's receipt needs the secret its page
   * got when the call started, in x-receipt-secret. The limit runs before the secret check, so wrong secrets are
   * limited too, and a wrong secret is a 401 whether or not the call exists.
   */
  async function receiptRoute(req, res, pathname, ip) {
    const signer = deps.receiptSigner;
    if (!signer) throw new HttpError(404, 'Not found.');
    if (Object.hasOwn(RECEIPT_PAGES, pathname)) {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
      return serveFile(res, path.join(deps.webDir ?? WEB_DIR, RECEIPT_PAGES[pathname]));
    }
    if (pathname === '/receipt-key') {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
      return send(res, 200, { alg: RECEIPT_ALG, keyId: signer.keyId, publicKey: signer.publicHex, pem: signer.publicPem });
    }
    if (pathname === '/api/receipts/check') {
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      limitOr429(receiptRequests, ip);
      const raw = await readBody(req, RECEIPT_MAX_BYTES);
      return send(res, 200, { check: verifyReceipt(raw, { publicKey: signer.publicKey, keyId: signer.keyId }), keyId: signer.keyId });
    }
    const match = pathname.match(RECEIPT_PATH);
    if (!match) throw new HttpError(404, 'Not found.');
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
    limitOr429(receiptRequests, ip);
    const given = req.headers['x-receipt-secret'];
    if (!secretMatches(signer, match[1], typeof given === 'string' ? given : '')) throw new HttpError(401, "That receipt link isn't right for this call.");
    await deps.ledger.reload?.();
    const { text, error } = receiptFile(deps.ledger.byCall(match[1]), config, signer);
    if (error === 'not_ended') throw new HttpError(409, 'The call is still going. Its receipt is ready once it ends.');
    if (error) throw new HttpError(404, 'That call is not in the receipt record.');
    return send(res, 200, text);
  }

  async function webhookRoute(req, res) {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    const rawBody = await readBody(req, WEBHOOK_LIMIT_BYTES);
    // Never acknowledge before verification and ledger persistence. A transient PayPal or storage error receives
    // a non-2xx response so the delivery can be retried. Invalid signatures are not accepted as payment evidence.
    const result = await webhooks.handle({ rawBody, headers: req.headers });
    if (result.verified) return send(res, 200, { ok: true });
    const invalid = ['BAD_BODY', 'EMPTY_BODY', 'MISSING_HEADERS', 'FAILURE'].includes(result.verifyStatus);
    return send(res, invalid ? 400 : 503, { ok: false });
  }

  return async function route(req, res, pathname, ip) {
    if (pathname === '/demo') {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
      return serveFile(res, path.join(deps.webDir ?? WEB_DIR, 'demo.html'));
    }
    if (pathname === '/rehearsal') {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
      return serveFile(res, path.join(deps.webDir ?? WEB_DIR, 'rehearsal.html'));
    }
    if (pathname === '/subscribers') {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
      return serveFile(res, path.join(deps.webDir ?? WEB_DIR, 'subscribers.html'));
    }
    if (pathname === '/api/rehearsal') {
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      limitOr429(rehearsals, ip);
      const input = await readJson(req);
      try { return send(res, 200, await runRehearsal(input)); }
      catch (error) { if (error.status === 400) throw new HttpError(400, error.message); throw error; }
    }
    if (pathname === '/procurement') {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
      return serveFile(res, path.join(deps.webDir ?? WEB_DIR, 'procurement.html'), { paymentMode: deps.commerceStatus?.().payments ?? 'mock' });
    }
    if (pathname === '/api/procurement' || pathname.startsWith('/api/procurement/')) return procurementRoute(req, res, pathname, ip);
    if (pathname === '/api/storage-status' && req.method === 'GET') return send(res, 200, { procurementJournal: deps.journal ? 'postgres' : 'memory', donorLedger: deps.ledger.durable ? 'postgres' : 'local', livePayments: false });
    if (pathname === '/api/commerce-status' && req.method === 'GET') return send(res, 200, deps.commerceStatus?.() ?? { suppliers: 'mock', payments: 'mock', sandboxWritesEnabled: false, livePayments: false });
    if (pathname === '/api/ai/status' && req.method === 'GET') return send(res, 200, deps.aiGateway ? { ...await deps.aiGateway.status(), enabled: true, mainAgent: 'claude-sonnet-5-5', reviewer: 'jev-1.14.0', jevPaymentAuthority: false } : { enabled: false, stopped: true, apiKeyOnly: true, providerBalanceVerified: false });
    if (pathname === '/staff' || pathname === '/api/staff' || pathname.startsWith('/api/staff/')) return staffRoute(req, res, pathname, ip);
    if (Object.hasOwn(RECEIPT_PAGES, pathname) || pathname === '/receipt-key' || pathname === '/api/receipts' || pathname.startsWith('/api/receipts/')) {
      return receiptRoute(req, res, pathname, ip);
    }
    if (pathname === '/healthz' && req.method === 'GET') return send(res, 200, { ok: true, mode: { paypal: config.paypal.mode, router: config.router.mode } });
    if (pathname === '/readyz') {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
      const readiness = await checkReadiness();
      return send(res, readiness.ready ? 200 : 503, readiness, undefined, readiness.ready ? {} : { 'Retry-After': '1' });
    }
    if (pathname === '/api/pilot-scripts' && req.method === 'GET') return send(res, 200, { scripts });
    // The fault drills, listed only while one may start: in mock mode, or on the sandbox after the deadline (A12).
    if (pathname === '/api/drills' && req.method === 'GET') return send(res, 200, { drills: drillOpen(config.paypal.mode, clock()) ? drills : [] });
    if (pathname === '/api/webhooks' && req.method === 'GET') { await deps.ledger.reload?.(); return send(res, 200, { webhooks: webhooks.recent(WEBHOOK_LIST_MAX) }); }
    if (pathname === '/webhooks/paypal') return webhookRoute(req, res);
    if (pathname === '/api/calls') {
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      const body = await readJson(req);
      limitOr429(newCalls, ip);
      const userAgent = typeof body.userAgent === 'string' ? body.userAgent : req.headers['user-agent'] ?? '';
      // The page's engine signals, which a user-agent override does not change. call.js keeps only those fields.
      const started = await startCall({ script: body.script ?? null, userAgent, client: body.client ?? null, clientKey: ip, drill: body.drill ?? null });
      // Only the page that started the call gets its receipt secret. It is never logged or stored.
      return send(res, 200, deps.receiptSigner ? { ...started, receiptSecret: deps.receiptSigner.secretFor(started.callId) } : started);
    }
    const match = pathname.match(CALL_PATH);
    if (match) return callRoute(req, res, ip, match[1], match[2]);
    if (pathname.startsWith('/api/') || pathname.startsWith('/webhooks/')) throw new HttpError(404, 'Not found.');
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
    return serveStatic(req, res, deps.webDir ?? WEB_DIR, Boolean(config.staffKey), Boolean(deps.receiptSigner));
  };
}

const redactPath = (pathname) => pathname.replace(/\/api\/(calls|staff\/calls|receipts|procurement)\/[0-9a-f-]{36}/, '/api/$1/:id');

export function createServer(deps) {
  const route = createApi(deps);
  const log = deps.log ?? createLogger();
  return http.createServer(async (req, res) => {
    const started = performance.now();
    const pathname = req.url.split('?')[0];
    const method = req.method;
    // HEAD is read-only and shares GET access checks. It never becomes a mutation route.
    if (method === 'HEAD' && (['/healthz', '/readyz'].includes(pathname) ||
      !pathname.startsWith('/api/') && !pathname.startsWith('/webhooks/'))) {
      res.headOnly = true;
      req.method = 'GET';
    }
    res.on('finish', () => log.info(`${method} ${redactPath(pathname)} ${res.statusCode} ${Math.round(performance.now() - started)}ms`));
    try {
      await route(req, res, pathname, clientIp(req, deps.config.trustProxy));
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof HttpError) return send(res, error.status, { error: error.message }, undefined, error.headers);
      if (error instanceof CallNotFound) return send(res, 404, { error: 'That call was not found. Please start a new call.' });
      if (error instanceof DonorDurabilityError) return send(res, 503,
        { error: 'The call could not safely complete this step. Please wait for the current reply and try again.' }, undefined, { 'Retry-After': '1' });
      log.error(`500 ${error?.name ?? 'Error'} ${error?.message ?? ''}`);
      send(res, 500, { error: 'Something went wrong on our side.' });
    }
  });
}

/**
 * Loud warnings when say.js speaks a template list pilot-check can't grade yet. The line still starts, since Render
 * must keep taking webhooks, and pilot-check refuses those calls, never fails them, until the list is fixed (R4-1, R4-2).
 */
export function templateWarnings({ live = LIVE_TEMPLATE_HASH, checkedIn = TEMPLATE_HASH, unreviewed = LIVE_UNREVIEWED, error = LIVE_TEMPLATE_ERROR } = {}) {
  const warnings = [];
  if (error) {
    warnings.push(`WARNING. The template list could not be built from say.js, ${error} pilot-check refuses every call made now. Fix say.js, run npm run vocabulary and npm test, then start the line again.`);
  } else if (live !== checkedIn) {
    warnings.push(`WARNING. say.js speaks the template list ${live}, but src/template-words.js holds ${checkedIn}, so npm run vocabulary has not run since say.js changed. pilot-check refuses calls made now until it has. Stop the line, run npm run vocabulary and npm test, then start it again.`);
  }
  if (unreviewed.length > 0) {
    warnings.push(`WARNING. say.js says sentences the review in src/vocabulary.js never passed with their claims, ${unreviewed.map((sentence) => JSON.stringify(sentence)).join(', ')}. pilot-check refuses every call made with them. Read each one, and list it on CLAIM_FREE when it claims nothing, or on CLAIMED with claims that cover what it says, else fix it in src/say.js. Then run npm run vocabulary and npm test.`);
  }
  return warnings;
}

/** Construction is inert; recovery begins only after the HTTP socket is listening. */
export function listenWithRecovery({ server, host, port, recovery = null }) {
  return new Promise((resolve, reject) => {
    const failed = (error) => { server.off('error', failed); reject(error); };
    server.once('error', failed);
    try {
      server.listen(port, host, () => {
        server.off('error', failed);
        try { recovery?.start(); resolve(server); }
        catch (error) { reject(error); }
      });
    } catch (error) { failed(error); }
  });
}

/** All shutdown signals share one drain, retaining storage until recovery has stopped. */
export async function drainRuntimeServices({ calls = null, runtime = null } = {}) {
  let failure;
  try { await calls?.flush?.(); } catch (error) { failure = error; }
  try { await runtime?.close?.(); } catch (error) { failure ??= error; }
  if (failure) throw failure;
}

export function createServerShutdown({ server, recovery = null, pool = null, beforeClose = () => {}, beforePoolClose = async () => {}, onComplete = () => {} }) {
  let stopping = null;
  return function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      let failure;
      const attempt = async (work) => { try { await work(); } catch (error) { failure ??= error; } };
      try { beforeClose(); } catch (error) { failure = error; }
      const closed = new Promise((resolve) => {
        try { server.close((error) => resolve(error)); } catch (error) { resolve(error); }
      });
      await attempt(() => recovery?.stop());
      const error = await closed;
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') failure ??= error;
      await attempt(beforePoolClose);
      await attempt(() => pool?.end());
      if (failure) throw failure;
      await onComplete();
    })();
    return stopping;
  };
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  const database = process.env.DATABASE_URL ? await connectDatabase(process.env.DATABASE_URL) : null;
  let runtime;
  try { runtime = await configureRuntimeServices({ config, database }); }
  catch (error) { await database?.pool.end(); throw error; }
  let deps, server;
  try {
    deps = buildDeps(config, { journal: database?.store, ...runtime });
    server = createServer(deps);
    for (const warning of templateWarnings()) deps.log.error(warning);
    await listenWithRecovery({ server, host: config.host, port: config.port, recovery: runtime.checkoutRecovery });
  }
  catch (error) {
    const cleanup = createServerShutdown({ server: server ?? { close: (done) => done() },
      recovery: runtime.checkoutRecovery, pool: database?.pool, beforePoolClose: () => runtime.close?.() });
    try { await cleanup(); } catch { /* Every cleanup runs; retain the original startup error. */ }
    throw error;
  }
  deps.log.info(`Pledge Line listening on http://${config.host}:${server.address().port}, PayPal ${config.paypal.mode}, router ${config.router.mode}`);
  if (config.paypal.mode === 'sandbox') {
    deps.paypal.warmUp().then(() => deps.log.info('PayPal token ready')).catch((error) => deps.log.error(`PayPal token warm-up failed ${error?.name ?? 'Error'}`));
  }
  const sweeper = setInterval(() => { deps.calls.sweep().catch((error) => deps.log.error(`sweep failed ${error?.name ?? 'Error'}`)); }, SWEEP_EVERY_MS);
  sweeper.unref();
  const stop = createServerShutdown({ server, recovery: runtime.checkoutRecovery, pool: database?.pool,
    beforeClose: () => clearInterval(sweeper), beforePoolClose: () => drainRuntimeServices({ calls: deps.calls, runtime }),
    onComplete: () => process.exit(0) });
  const stopOnSignal = () => { void stop().catch(() => { deps.log.error('shutdown failed'); process.exitCode = 1; }); };
  process.on('SIGTERM', stopOnSignal);
  process.on('SIGINT', stopOnSignal);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    const safe = ['USE_GUARDED_ANTHROPIC_MODE', 'AI_DATABASE_REQUIRED', 'AI_PREPAID_CONFIRMATION_REQUIRED', 'AI_ALLOCATION_INVALID', 'SUPPLIER_MODE_INVALID', 'SUPPLIER_REGISTRY_REQUIRED', 'SUPPLIER_REGISTRY_INVALID', 'SUPPLIER_CREDENTIAL_REQUIRED', 'CHECKOUT_DATABASE_REQUIRED'].includes(error?.code) ? error.code : 'STARTUP_CONFIGURATION_FAILED';
    process.stderr.write(`${safe}. Check private configuration and explicit migrations. No credentials are printed.\n`); process.exitCode = 1;
  });
}
