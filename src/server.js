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
const STATIC_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
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
export function createWebhookHandler({ paypal, ledger, webhookId, log }) {
  const verifiedIds = new Set();
  const inflight = new Map();

  function record(entry) {
    ledger.append({ type: 'webhook', ...entry });
    log.info(`webhook ${entry.eventType} ${entry.resourceId} verified=${entry.verified}`);
  }

  async function verifyOnce(entry, headers, rawBody) {
    if (verifiedIds.has(entry.eventId)) {
      log.info(`webhook ${entry.eventType} ${entry.resourceId} duplicate`);
      return;
    }
    const { verified, verifyStatus } = await paypal.verifyWebhookSignature({ headers, rawBody, webhookId });
    if (verified) verifiedIds.add(entry.eventId);
    record({ ...entry, verified, verifyStatus });
  }

  async function handle({ rawBody, headers }) {
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
      record({ ...entry, verified: false, verifyStatus: 'BAD_BODY' });
      return;
    }
    const before = inflight.get(entry.eventId) ?? Promise.resolve();
    const run = before.then(() => verifyOnce(entry, headers, rawBody));
    inflight.set(entry.eventId, run.catch(() => {}));
    await run;
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
  const paypal = config.paypal.mode === 'mock'
    ? applyFaultDrill(createMockPayPal({ tokens, now, onWebhook: (delivery) => webhooks?.handle(delivery), ...(overrides.mockOptions ?? {}) }), config.faultDrill, tokens)
    : createPayPal({ baseUrl: config.paypal.baseUrl, clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, tokens, fetchImpl: overrides.fetchImpl ?? fetch });
  webhooks = createWebhookHandler({ paypal, ledger, webhookId: config.paypal.webhookId, log });
  const router = overrides.router ?? createRouter({ mode: config.router.mode, apiKey: config.router.apiKey, model: config.router.model });
  const gate = createGate({ ledger, tokens, now, pendingTtlMs: config.limits.pendingTtlMs });
  // Only the public Render service needs it. Locally the line listens on this computer alone, and Script 8 uses three wrong PINs.
  const pinGuard = config.trustProxy ? createPinGuard({ limit: config.limits.wrongPinsPerHour, windowMs: HOUR_MS, now: () => now().getTime() }) : null;
  const desk = createRefundDesk({ ledger, tokens });
  const calls = createCallService({ config, ledger, paypal, router, gate, now, pinGuard, desk, ...(overrides.sleep ? { sleep: overrides.sleep } : {}) });
  return { config, ledger, tokens, paypal, router, gate, calls, webhooks, log, now };
}

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(payload);
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

function serveFile(res, file) {
  fs.stat(file, (statError, stat) => {
    if (statError || !stat.isFile()) return send(res, 404, { error: 'Not found.' });
    fs.readFile(file, (readError, data) => {
      if (readError) return send(res, 500, { error: 'Something went wrong on our side.' });
      send(res, 200, data, STATIC_TYPES[path.extname(file)]);
    });
  });
}

function serveStatic(req, res, webDir, staffOn) {
  const rawPath = req.url.split('?')[0];
  const file = resolveStatic(rawPath, webDir);
  if (!file) return send(res, rawPath.includes('..') ? 400 : 404, { error: 'Not found.' });
  // Checked on the resolved file, so an encoded path such as /%73taff.js can't reach it either.
  if (!staffOn && isStaffFile(file, webDir)) return send(res, 404, { error: 'Not found.' });
  serveFile(res, file);
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
  const staffRequests = createRateLimiter({ limit: config.limits.staffPerMinute, windowMs: MINUTE_MS });
  const limitOr429 = (limiter, ip) => { if (!limiter.allow(ip)) throw tooManyRequests(limiter.waitMs(ip), !config.trustProxy); };

  // A second gap for a turn is a 409, and so is one for a reply the line has not finished (Test 4).
  function logGap(id, gap) {
    try {
      return calls.logGap(id, gap);
    } catch (error) {
      if (error instanceof GapRefused) throw new HttpError(error.status, error.message);
      throw error;
    }
  }

  async function callRoute(req, res, ip, id, action) {
    if (!action) {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
      return send(res, 200, calls.get(id));
    }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    // When the turn reached the server, before its body is read, so a yes can't count before a person could answer (I1).
    const receivedAt = performance.now();
    const body = await readJson(req);
    if (action === 'turn') {
      limitOr429(turns, ip);
      return send(res, 200, await calls.turn(id, validTurnBody(body), { receivedAt }));
    }
    if (action === 'gap') return send(res, 200, logGap(id, validGapBody(body)));
    return send(res, 200, await calls.end(id, 'client'));
  }

  /**
   * The staff view. Off, as a 404, when STAFF_KEY is unset. The page itself holds no data. The API needs the key in
   * x-staff-key, and the limit runs before the key check, so wrong keys are limited too.
   */
  function staffRoute(req, res, pathname, ip) {
    if (!config.staffKey) throw new HttpError(404, 'Not found.');
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
    if (pathname === '/staff') return serveFile(res, path.join(deps.webDir ?? WEB_DIR, 'staff.html'));
    const match = pathname.match(STAFF_CALLS_PATH);
    if (!match) throw new HttpError(404, 'Not found.');
    limitOr429(staffRequests, ip);
    const given = req.headers['x-staff-key'];
    if (!staffKeyMatches(typeof given === 'string' ? given : '', config.staffKey)) throw new HttpError(401, 'That staff key is not right.');
    if (!match[1]) return send(res, 200, { calls: staffCalls(deps.ledger, config) });
    const call = staffCall(deps.ledger, match[1], config);
    if (!call) throw new HttpError(404, 'That call is not in the record.');
    return send(res, 200, { call });
  }

  async function webhookRoute(req, res) {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    const rawBody = await readBody(req, WEBHOOK_LIMIT_BYTES);
    send(res, 200, { ok: true });
    setImmediate(() => {
      webhooks.handle({ rawBody, headers: req.headers }).catch((error) => deps.log.error(`webhook handling failed ${error?.name ?? 'Error'}`));
    });
  }

  return async function route(req, res, pathname, ip) {
    if (pathname === '/staff' || pathname === '/api/staff' || pathname.startsWith('/api/staff/')) return staffRoute(req, res, pathname, ip);
    if (pathname === '/healthz' && req.method === 'GET') return send(res, 200, { ok: true, mode: { paypal: config.paypal.mode, router: config.router.mode } });
    if (pathname === '/api/pilot-scripts' && req.method === 'GET') return send(res, 200, { scripts });
    if (pathname === '/api/webhooks' && req.method === 'GET') return send(res, 200, { webhooks: webhooks.recent(WEBHOOK_LIST_MAX) });
    if (pathname === '/webhooks/paypal') return webhookRoute(req, res);
    if (pathname === '/api/calls') {
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      const body = await readJson(req);
      limitOr429(newCalls, ip);
      const userAgent = typeof body.userAgent === 'string' ? body.userAgent : req.headers['user-agent'] ?? '';
      // The page's engine signals, which a user-agent override does not change. call.js keeps only those fields.
      return send(res, 200, calls.start({ script: body.script ?? null, userAgent, client: body.client ?? null, clientKey: ip }));
    }
    const match = pathname.match(CALL_PATH);
    if (match) return callRoute(req, res, ip, match[1], match[2]);
    if (pathname.startsWith('/api/') || pathname.startsWith('/webhooks/')) throw new HttpError(404, 'Not found.');
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
    return serveStatic(req, res, deps.webDir ?? WEB_DIR, Boolean(config.staffKey));
  };
}

const redactPath = (pathname) => pathname.replace(/\/api\/(calls|staff\/calls)\/[0-9a-f-]{36}/, '/api/$1/:id');

export function createServer(deps) {
  const route = createApi(deps);
  const log = deps.log ?? createLogger();
  return http.createServer(async (req, res) => {
    const started = performance.now();
    const pathname = req.url.split('?')[0];
    res.on('finish', () => log.info(`${req.method} ${redactPath(pathname)} ${res.statusCode} ${Math.round(performance.now() - started)}ms`));
    try {
      await route(req, res, pathname, clientIp(req, deps.config.trustProxy));
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof HttpError) return send(res, error.status, { error: error.message }, undefined, error.headers);
      if (error instanceof CallNotFound) return send(res, 404, { error: 'That call was not found. Please start a new call.' });
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

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  const deps = buildDeps(config);
  const server = createServer(deps);
  for (const warning of templateWarnings()) deps.log.error(warning);
  server.listen(config.port, config.host, () => {
    deps.log.info(`Pledge Line listening on http://${config.host}:${server.address().port}, PayPal ${config.paypal.mode}, router ${config.router.mode}`);
  });
  if (config.paypal.mode === 'sandbox') {
    deps.paypal.warmUp().then(() => deps.log.info('PayPal token ready')).catch((error) => deps.log.error(`PayPal token warm-up failed ${error?.name ?? 'Error'}`));
  }
  const sweeper = setInterval(() => { deps.calls.sweep().catch((error) => deps.log.error(`sweep failed ${error?.name ?? 'Error'}`)); }, SWEEP_EVERY_MS);
  sweeper.unref();
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
