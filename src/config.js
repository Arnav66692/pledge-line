import fs from 'node:fs';
import path from 'node:path';
import { extractSpokenFacts } from './say.js';

export const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';
export const ROUTER_MODEL = 'claude-haiku-5-5';
export const MOCK_SUBSCRIPTION_ID = 'I-MOCK0000001';
export const MOCK_PLAN_ID = 'P-MOCK0000001';
export const MOCK_WEBHOOK_ID = 'WH-MOCK-WEBHOOK';
export const MOCK_DEFAULT_PIN = '2468';
export const STATE_FILE = '.pilot/state.json';
export const PILOT_LEDGER = '.pilot/ledger.jsonl';
export const MOCK_LEDGER = '.pilot/mock-ledger.jsonl';

// Script 8 uses these as the wrong PINs, so the real PIN must differ.
const SCRIPT_8_PINS = new Set(['1111', '2222', '3333']);
const PLACEHOLDERS = new Set(['', 'pending']);
const PIN_PATTERN = /^\d{4,6}$/;
// seed-sandbox names the product and plan "<ORG_NAME> monthly gift", and PayPal caps both names at 127 characters.
const ORG_NAME_MAX = 127 - ' monthly gift'.length;

const LIMITS = Object.freeze({
  pendingTtlMs: 120000,
  tokenTtlMs: 60000,
  callIdleMs: 600000,
  maxTurnsPerCall: 40,
  maxTextChars: 500,
  pinTries: 3,
  invoiceMinDollars: 1,
  invoiceMaxDollars: 500,
  newCallsPerHour: 20,
  turnsPerMinute: 60,
  // Wrong PINs from one address in an hour, across all its calls, before PIN entry stops (Render only).
  wrongPinsPerHour: 10,
});

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
  const facts = extractSpokenFacts(name);
  if (facts.length > 0) errors.push(`ORG_NAME must not contain a status word, amount or date the line only takes from PayPal, found ${facts.map((f) => `"${f.value}"`).join(', ')}`);
  return name;
}

function parseLedgerPath(raw, isMock, errors) {
  const ledgerPath = raw ?? (isMock ? MOCK_LEDGER : PILOT_LEDGER);
  // Mock and rules calls never count, so they must never land in the ledger the pilot is graded from.
  if (isMock && path.resolve(ledgerPath) === path.resolve(PILOT_LEDGER)) {
    errors.push(`LEDGER_PATH must not be ${PILOT_LEDGER} when PAYPAL_MODE is mock or ROUTER_MODE is rules. Leave it unset`);
  }
  return ledgerPath;
}

function parseModes(env, errors) {
  const paypalMode = clean(env.PAYPAL_MODE) ?? 'sandbox';
  const routerMode = clean(env.ROUTER_MODE) ?? 'haiku';
  if (!['sandbox', 'mock'].includes(paypalMode)) errors.push('PAYPAL_MODE must be sandbox or mock');
  if (!['haiku', 'rules'].includes(routerMode)) errors.push('ROUTER_MODE must be haiku or rules');
  return { paypalMode, routerMode };
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
  const port = parsePort(clean(env.PORT), errors);
  const { paypalMode, routerMode } = parseModes(env, errors);
  const base = parseBaseUrl(env, port, errors);
  const ids = parseIds(env, paypalMode);
  const config = {
    port,
    host: clean(env.HOST) ?? (clean(env.RENDER) ? '0.0.0.0' : '127.0.0.1'),
    trustProxy: Boolean(clean(env.RENDER)),
    publicBaseUrl: base.url,
    publicBaseUrlFrom: base.from,
    timeZone: parseTimeZone(clean(env.TIME_ZONE), errors),
    orgName: parseOrgName(clean(env.ORG_NAME), errors),
    ledgerPath: parseLedgerPath(clean(env.LEDGER_PATH), paypalMode === 'mock' || routerMode === 'rules', errors),
    stateFile: STATE_FILE,
    paypal: parsePayPal(env, paypalMode, partial, errors),
    router: parseRouter(env, routerMode, partial, errors),
    pin: parsePin(env, paypalMode, partial, errors),
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
  router: (c) => (c.router.mode !== 'haiku' ? 'ROUTER_MODE must be haiku'
    : !c.router.apiKey ? 'ANTHROPIC_API_KEY is required' : null),
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
