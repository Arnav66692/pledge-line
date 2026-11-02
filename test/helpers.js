// Shared test wiring: mock PayPal, rules router, temp ledgers under os.tmpdir().
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A scratch copy of the line's code with some text swapped, as a later edit or a slip would make, for tests that
 * run another version of the code. Each edit is [file, from, to], and an edit marked optional skips a file without
 * that text. node_modules is linked, not copied, and the cleanup removes only the link.
 */
export function copyProject(edits = []) {
  const dir = tempDir();
  for (const name of ['src', 'scripts', 'package.json']) fs.cpSync(path.join(ROOT, name), path.join(dir, name), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  for (const [file, from, to, { optional = false } = {}] of edits) {
    const target = path.join(dir, file);
    const text = fs.readFileSync(target, 'utf8');
    if (!text.includes(from)) {
      if (optional) continue;
      throw new Error(`${file} has no ${JSON.stringify(from)}`);
    }
    fs.writeFileSync(target, text.split(from).join(to));
  }
  return dir;
}

export function makeClock(start = Date.parse('2026-11-03T18:00:00Z')) {
  const clock = { t: start };
  clock.now = () => new Date(clock.t);
  clock.advance = (ms) => { clock.t += ms; };
  return clock;
}

const OWN_CODE = Object.freeze({ loadConfig, createLedger, createMockPayPal, createTokens, createGate, createRouter, createCallService });

/** The modules of a copy made by copyProject, so a test can build calls and grade them with that version of the code. */
export async function codeOf(dir) {
  const load = (name) => import(pathToFileURL(path.join(dir, 'src', `${name}.js`)).href);
  const [config, ledger, mock, gate, router, call, check] = await Promise.all(['config', 'ledger', 'paypal-mock', 'gate', 'router', 'call', 'check'].map(load));
  return { ...config, ...ledger, ...mock, ...gate, ...router, ...call, check };
}

export function buildStack({ env = {}, clock = makeClock(), mockOptions = {}, router = null, code = OWN_CODE } = {}) {
  const config = code.loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules', ...env });
  const ledger = code.createLedger({ path: tempLedgerPath(), now: clock.now });
  const tokens = code.createTokens({ now: clock.now, ttlMs: config.limits.tokenTtlMs });
  const paypal = code.createMockPayPal({ tokens, now: clock.now, ...mockOptions });
  const gate = code.createGate({ ledger, tokens, now: clock.now, pendingTtlMs: config.limits.pendingTtlMs });
  const routerImpl = router ?? code.createRouter({ mode: 'rules' });
  const calls = code.createCallService({ config, ledger, paypal, router: routerImpl, gate, now: clock.now, sleep: async () => {} });
  // The turn of the last reply each call received, sent with the next turn as the page does.
  return { config, ledger, tokens, paypal, gate, router: routerImpl, calls, clock, answered: new Map() };
}

/** One turn, sent the way the page sends it, answering the last reply this call received (turn 0 is the greeting). */
async function turnAsPage(stack, callId, input) {
  const result = await stack.calls.turn(callId, { ...input, answering: stack.answered.get(callId) ?? 0 });
  stack.answered.set(callId, result.turn);
  return result;
}

export async function runScript(stack, script) {
  const { callId } = stack.calls.start({ script: script.number, userAgent: 'node-test' });
  const replies = [];
  for (const turn of scriptTurns(script, stack.config.pin)) {
    replies.push((await turnAsPage(stack, callId, turn)).reply);
  }
  return { callId, replies };
}

export async function say(stack, callId, text, source = 'typed') {
  return turnAsPage(stack, callId, { text, source });
}

export async function verifiedCall(stack, script = null) {
  const { callId } = stack.calls.start({ script, userAgent: 'node-test' });
  await turnAsPage(stack, callId, { text: stack.config.pin, source: 'keypad' });
  return callId;
}

export const eventsOf = (stack, callId, type) => stack.ledger.byCall(callId).filter((e) => !type || e.type === type);
