// Shared test wiring: mock PayPal, rules router, temp ledgers under os.tmpdir().
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { after } from 'node:test';
import { loadConfig } from '../src/config.js';
import { createLedger } from '../src/ledger.js';
import { createMockPayPal } from '../src/paypal-mock.js';
import { createTokens, createGate } from '../src/gate.js';
import { createRouter } from '../src/router.js';
import { createCallService } from '../src/call.js';
import { scriptTurns } from '../src/pilot-scripts.js';

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

export function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pledge-line-test-'));
  made.push(dir);
  return dir;
}

export const tempLedgerPath = () => path.join(tempDir(), 'ledger.jsonl');

export function makeClock(start = Date.parse('2026-11-03T18:00:00Z')) {
  const clock = { t: start };
  clock.now = () => new Date(clock.t);
  clock.advance = (ms) => { clock.t += ms; };
  return clock;
}

export function buildStack({ env = {}, clock = makeClock(), mockOptions = {}, router = null } = {}) {
  const config = loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules', ...env });
  const ledger = createLedger({ path: tempLedgerPath(), now: clock.now });
  const tokens = createTokens({ now: clock.now, ttlMs: config.limits.tokenTtlMs });
  const paypal = createMockPayPal({ tokens, now: clock.now, ...mockOptions });
  const gate = createGate({ ledger, tokens, now: clock.now, pendingTtlMs: config.limits.pendingTtlMs });
  const routerImpl = router ?? createRouter({ mode: 'rules' });
  const calls = createCallService({ config, ledger, paypal, router: routerImpl, gate, now: clock.now, sleep: async () => {} });
  return { config, ledger, tokens, paypal, gate, router: routerImpl, calls, clock };
}

export async function runScript(stack, script) {
  const { callId } = stack.calls.start({ script: script.number, userAgent: 'node-test' });
  const replies = [];
  for (const turn of scriptTurns(script, stack.config.pin)) {
    replies.push((await stack.calls.turn(callId, turn)).reply);
  }
  return { callId, replies };
}

export async function say(stack, callId, text, source = 'typed') {
  return stack.calls.turn(callId, { text, source });
}

export async function verifiedCall(stack, script = null) {
  const { callId } = stack.calls.start({ script, userAgent: 'node-test' });
  await stack.calls.turn(callId, { text: stack.config.pin, source: 'keypad' });
  return callId;
}

export const eventsOf = (stack, callId, type) => stack.ledger.byCall(callId).filter((e) => !type || e.type === type);
