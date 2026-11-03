import fs from 'node:fs';
import path from 'node:path';
import { extractSpokenFacts } from './say.js';

export const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';
export const ROUTER_MODEL = 'claude-haiku-5-5';
// Gemini's free tier, which needs no card. GEMINI_MODEL can name another model the key can use.
export const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_MODEL_ID = /^[a-z0-9][a-z0-9.-]*$/;
export const MOCK_SUBSCRIPTION_ID = 'I-MOCK0000001';
export const MOCK_PLAN_ID = 'P-MOCK0000001';
export const MOCK_WEBHOOK_ID = 'WH-MOCK-WEBHOOK';
export const MOCK_DEFAULT_PIN = '2468';
export const STATE_FILE = '.pilot/state.json';
export const PILOT_LEDGER = '.pilot/ledger.jsonl';
export const MOCK_LEDGER = '.pilot/mock-ledger.jsonl';
// The public Vercel demo can only write under /tmp, and loses it on every cold start.
export const VERCEL_LEDGER = '/tmp/pledge-line/mock-ledger.jsonl';
// /tmp is /private/tmp on a Mac, so a local run of the demo can put its ledger there too.
const TMP_DIRS = ['/tmp/', '/private/tmp/'];
// The Vercel copy is a public demo with no real keys, so a key set there by mistake stops it starting.
const VERCEL_REFUSED_KEYS = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY'];

// Script 8 uses these as the wrong PINs, so the real PIN must differ.
const SCRIPT_8_PINS = new Set(['1111', '2222', '3333']);
const PLACEHOLDERS = new Set(['', 'pending']);
const PIN_PATTERN = /^\d{4,6}$/;
// seed-sandbox names the product and plan "<ORG_NAME> monthly gift", and PayPal caps both names at 127 characters.
const ORG_NAME_MAX = 127 - ' monthly gift'.length;

export const LIMITS = Object.freeze({
  pendingTtlMs: 120000,
  tokenTtlMs: 60000,
  callIdleMs: 600000,
  maxTurnsPerCall: 40,
  maxTextChars: 500,
  pinTries: 3,
  // A person needs this long at least to hear or read a proposal and answer it. A yes that reaches the server
  // sooner after the asking reply was finished never counts (I1).
  minAnswerMs: 250,
  invoiceMinDollars: 1,
  invoiceMaxDollars: 500,
  newCallsPerHour: 20,
  turnsPerMinute: 60,
  // Wrong PINs from one address in an hour, across all its calls, before PIN entry stops (Render only).
  wrongPinsPerHour: 10,
  // Staff view requests from one address in a minute, wrong keys included.
  staffPerMinute: 60,
});
// The staff key guards every donor's call record, so a short one is refused.
export const STAFF_KEY_MIN = 16;

function clean(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return PLACEHOLDERS.has(trimmed.toLowerCase()) ? null : trimmed;
}

function readState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return {};
  }
}

function parsePort(raw, errors) {
  if (raw === null) return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) errors.push('PORT must be a whole number from 0 to 65535');
  return port;
}

function parseBaseUrl(env, port, errors) {
  const explicit = clean(env.PUBLIC_BASE_URL);
  const render = clean(env.RENDER_EXTERNAL_URL);
  const url = explicit ?? render ?? `http://localhost:${port}`;
  const from = explicit ? 'env' : render ? 'render' : 'default';
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) errors.push('PUBLIC_BASE_URL must start with http or https');
  } catch {
    errors.push('PUBLIC_BASE_URL is not a valid URL');
  }
  return { url: url.replace(/\/+$/, ''), from };
}

function parseTimeZone(raw, errors) {
  const zone = raw ?? 'America/Los_Angeles';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    errors.push('TIME_ZONE is not a valid IANA time zone');
  }
  return zone;
}

function parseOrgName(raw, errors) {
  const name = raw ?? 'Sunny Hollow Pantry';
  if (name.length > ORG_NAME_MAX) errors.push(`ORG_NAME must be ${ORG_NAME_MAX} characters or fewer`);
  // The name is spoken, and every spoken amount, date and status word must come from PayPal (I3).
  if (/[\d@$]/.test(name)) {
    errors.push('ORG_NAME must not contain digits, @ or $');
    return name;
  }
  // The strict scan, the same one the facts check runs, so a name like "Second Harvest" can never fail a call.
  const facts = extractSpokenFacts(name, { strict: true });
  if (facts.length > 0) errors.push(`ORG_NAME must not contain a status word, amount or date the line only takes from PayPal, found ${facts.map((f) => `"${f.value}"`).join(', ')}`);
  return name;
}

function parseLedgerPath(raw, isMock, onVercel, errors) {
  if (onVercel) {
    if (raw !== null && !TMP_DIRS.some((dir) => path.resolve(raw).startsWith(dir))) errors.push('LEDGER_PATH must be under /tmp on Vercel. Leave it unset');
    return raw ?? VERCEL_LEDGER;
  }
  const ledgerPath = raw ?? (isMock ? MOCK_LEDGER : PILOT_LEDGER);
  // Mock and rules calls never count, so they must never land in the ledger the pilot is graded from.
  if (isMock && path.resolve(ledgerPath) === path.resolve(PILOT_LEDGER)) {
    errors.push(`LEDGER_PATH must not be ${PILOT_LEDGER} when PAYPAL_MODE is mock or ROUTER_MODE is rules. Leave it unset`);
  }
  return ledgerPath;
}

/** Optional. Unset means the staff view is off and every staff route is a 404. */
function parseStaffKey(raw, errors) {
  if (raw === null) return null;
  if (raw.length < STAFF_KEY_MIN) errors.push(`STAFF_KEY must be at least ${STAFF_KEY_MIN} characters when set`);
  // The page sends it as a header, and a browser refuses a header with a space or a character outside plain ASCII.
  if (!/^[\x21-\x7e]+$/.test(raw)) errors.push('STAFF_KEY must use plain letters, digits and marks, with no spaces');
  return raw;
}

function parseModes(env, onVercel, errors) {
  // On Vercel an unset mode means the demo's mock and rules, never sandbox.
  const paypalMode = clean(env.PAYPAL_MODE) ?? (onVercel ? 'mock' : 'sandbox');
  const routerMode = clean(env.ROUTER_MODE) ?? (onVercel ? 'rules' : 'haiku');
  if (!['sandbox', 'mock'].includes(paypalMode)) errors.push('PAYPAL_MODE must be sandbox or mock');
  if (!['haiku', 'gemini', 'rules'].includes(routerMode)) errors.push('ROUTER_MODE must be haiku, gemini or rules');
  return { paypalMode, routerMode };
}

/**
 * Vercel runs only the public demo. Mock PayPal, the offline rules router and the mock PIN, so no real key, real PIN
 * or real money can reach it, and the graded pilot stays on Render.
 */
function checkVercel(env, { paypalMode, routerMode }, errors) {
  if (paypalMode !== 'mock') errors.push('PAYPAL_MODE must be mock on Vercel, the Vercel copy is a public demo');
  if (routerMode !== 'rules') errors.push('ROUTER_MODE must be rules on Vercel, the Vercel copy is a public demo');
  for (const name of VERCEL_REFUSED_KEYS) {
    if (clean(env[name])) errors.push(`${name} must not be set on Vercel, the demo uses no real keys`);
  }
  const pin = clean(env.PILOT_PIN);
  if (pin !== null && pin !== MOCK_DEFAULT_PIN) errors.push('PILOT_PIN must be unset on Vercel, the demo uses the mock PIN');
}

function parsePin(env, paypalMode, partial, errors) {
  const pin = clean(env.PILOT_PIN) ?? (paypalMode === 'mock' ? MOCK_DEFAULT_PIN : null);
  if (pin === null) {
    if (!partial) errors.push('PILOT_PIN is required in sandbox mode');
    return null;
  }
  if (!PIN_PATTERN.test(pin)) errors.push('PILOT_PIN must be 4 to 6 digits');
  if (SCRIPT_8_PINS.has(pin)) errors.push('PILOT_PIN must not be 1111, 2222 or 3333');
  return pin;
}

function parsePayPal(env, mode, partial, errors) {
  const baseUrl = clean(env.PAYPAL_BASE_URL) ?? SANDBOX_BASE_URL;
  if (baseUrl !== SANDBOX_BASE_URL) errors.push(`PAYPAL_BASE_URL must be ${SANDBOX_BASE_URL}, the pilot is sandbox only`);
  const clientId = clean(env.PAYPAL_CLIENT_ID);
  const clientSecret = clean(env.PAYPAL_CLIENT_SECRET);
  if (mode === 'sandbox' && !partial) {
    if (!clientId) errors.push('PAYPAL_CLIENT_ID is required in sandbox mode');
    if (!clientSecret) errors.push('PAYPAL_CLIENT_SECRET is required in sandbox mode');
  }
  const webhookId = clean(env.PAYPAL_WEBHOOK_ID) ?? (mode === 'mock' ? MOCK_WEBHOOK_ID : null);
  return Object.freeze({ mode, baseUrl, clientId, clientSecret, webhookId });
}

function parseRouter(env, mode, partial, errors) {
  if (mode === 'gemini') {
    const apiKey = clean(env.GEMINI_API_KEY);
    if (!apiKey && !partial) errors.push('GEMINI_API_KEY is required when ROUTER_MODE is gemini');
    // AI Studio shows ids as models/gemini-..., and the router adds models/ itself.
    const model = (clean(env.GEMINI_MODEL) ?? GEMINI_MODEL).replace(/^models\//, '');
    if (!GEMINI_MODEL_ID.test(model)) errors.push(`GEMINI_MODEL must be a model id such as ${GEMINI_MODEL}`);
    return Object.freeze({ mode, apiKey, model });
  }
  const apiKey = clean(env.ANTHROPIC_API_KEY);
  if (mode === 'haiku' && !apiKey && !partial) errors.push('ANTHROPIC_API_KEY is required when ROUTER_MODE is haiku');
  return Object.freeze({ mode, apiKey, model: ROUTER_MODEL });
}

function parseIds(env, paypalMode) {
  if (paypalMode === 'mock') {
    return { subscriptionId: clean(env.DEMO_SUBSCRIPTION_ID) ?? MOCK_SUBSCRIPTION_ID, planId: MOCK_PLAN_ID };
  }
  const state = readState(STATE_FILE);
  const fromState = typeof state.subscriptionId === 'string' ? state.subscriptionId : null;
  const planId = typeof state.planId === 'string' ? state.planId : null;
  return { subscriptionId: clean(env.DEMO_SUBSCRIPTION_ID) ?? fromState, planId };
}

/**
 * Builds the frozen config. `partial` skips the per-mode secret checks, for
 * scripts such as pilot-check that only read the ledger.
 */
export function loadConfig(env = process.env, { partial = false } = {}) {
  const errors = [];
  const onVercel = Boolean(clean(env.VERCEL));
  const port = parsePort(clean(env.PORT), errors);
  const { paypalMode, routerMode } = parseModes(env, onVercel, errors);
  if (onVercel) checkVercel(env, { paypalMode, routerMode }, errors);
  const base = parseBaseUrl(env, port, errors);
  const ids = parseIds(env, paypalMode);
  const config = {
    port,
    host: clean(env.HOST) ?? (clean(env.RENDER) ? '0.0.0.0' : '127.0.0.1'),
    // Render and Vercel both put the caller's address at the end of X-Forwarded-For.
    trustProxy: Boolean(clean(env.RENDER)) || onVercel,
    publicBaseUrl: base.url,
    publicBaseUrlFrom: base.from,
    timeZone: parseTimeZone(clean(env.TIME_ZONE), errors),
    orgName: parseOrgName(clean(env.ORG_NAME), errors),
    ledgerPath: parseLedgerPath(clean(env.LEDGER_PATH), paypalMode === 'mock' || routerMode === 'rules', onVercel, errors),
    stateFile: STATE_FILE,
    paypal: parsePayPal(env, paypalMode, partial, errors),
    router: parseRouter(env, routerMode, partial, errors),
    pin: parsePin(env, paypalMode, partial, errors),
    staffKey: parseStaffKey(clean(env.STAFF_KEY), errors),
    demoSubscriptionId: ids.subscriptionId,
    demoPlanId: ids.planId,
    limits: LIMITS,
    currency: 'USD',
  };
  if (errors.length > 0) throw new Error(`Config problems:\n- ${errors.join('\n- ')}`);
  return Object.freeze(config);
}

const NEEDS = {
  paypal: (c) => (c.paypal.mode !== 'sandbox' ? 'PAYPAL_MODE must be sandbox'
    : !c.paypal.clientId || !c.paypal.clientSecret ? 'PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required' : null),
  router: (c) => (!['haiku', 'gemini'].includes(c.router.mode) ? 'ROUTER_MODE must be haiku or gemini'
    : !c.router.apiKey ? `${c.router.mode === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY'} is required` : null),
  pin: (c) => (c.pin ? null : 'PILOT_PIN is required'),
  subscription: (c) => (c.demoSubscriptionId ? null : 'DEMO_SUBSCRIPTION_ID is not set and .pilot/state.json has no subscriptionId'),
  webhook: (c) => (c.paypal.webhookId ? null : 'PAYPAL_WEBHOOK_ID is required'),
  publicUrl: (c) => (c.publicBaseUrlFrom !== 'default' ? null : 'PUBLIC_BASE_URL is required'),
};

export function assertReady(config, { need = [] } = {}) {
  const problems = need.map((name) => {
    const check = NEEDS[name];
    if (!check) return `unknown need ${name}`;
    return check(config);
  }).filter(Boolean);
  if (problems.length > 0) throw new Error(`Not ready:\n- ${problems.join('\n- ')}`);
  return config;
}

export function isMockConfig(config) {
  return config.paypal.mode === 'mock' || config.router.mode === 'rules';
}
