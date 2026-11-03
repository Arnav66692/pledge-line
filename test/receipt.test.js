import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildReceipts } from '../src/receipt.js';
import * as check from '../src/check.js';
import { PILOT_SCRIPTS, scriptByNumber } from '../src/pilot-scripts.js';
import { buildStack, runScript, say, verifiedCall, copyProject } from './helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// The pilot branch tip this work started from, whose check.js every existing check must still agree with.
const BASE = '0d5ad85';
const SUB = { id: 'I-1', status: 'ACTIVE', plan_id: 'P-1', next_billing_time: '2026-12-01T10:00:00Z', subscriber_email: 'sb-maria@personal.example.com', subscriber_given_name: 'Maria' };
const PLAN = { id: 'P-1', price_value: '25.00', price_currency: 'USD' };
const GIFT = 'PayPal shows your monthly gift of $25.00 as active.';
const GIFT_FACTS = [{ kind: 'money', value: '$25.00', source: 'plan.price' }, { kind: 'status', value: 'active', source: 'subscription.status' }];
const ANYTHING_ELSE = 'What else can I help with?';

function ledger(callId = 'c1') {
  let seq = 0;
  const events = [];
  const add = (type, fields = {}) => {
    seq += 1;
    events.push({ type, callId, seq, ts: new Date(Date.UTC(2026, 10, 3, 18, 0, seq)).toISOString(), ...fields });
    return add;
  };
  add.events = events;
  return add;
}

/** A verified call that read the gift in turn 2. */
function readCall(callId = 'c1', start = {}) {
  const add = ledger(callId);
  add('call_start', { script: null, timeZone: 'America/Los_Angeles', orgName: 'Sunny Hollow Pantry', ...start });
  add('heard', { turn: 1, text: '####', source: 'keypad' });
  add('pin_ok', { turn: 1 });
  add('said', { turn: 1, text: 'Thanks, you are verified.', facts: [], claims: [{ claim: 'pin_ok', sentence: 'Thanks, you are verified.' }] });
  add('heard', { turn: 2, text: 'How much is my gift?', source: 'voice' });
  add('read', { turn: 2, what: 'subscription', id: 'I-1', status: 'ACTIVE', snapshot: SUB, debugId: 'dbg-sub' });
  add('read', { turn: 2, what: 'plan', id: 'P-1', status: null, snapshot: PLAN, debugId: 'dbg-plan' });
  return add;
}

const sentenceOf = (receipts, turn, text) => receipts.find((r) => r.turn === turn).sentences.find((s) => s.text === text);
const blockedTurns = (receipts) => receipts.filter((r) => r.sentences.some((s) => s.verdict === 'blocked')).map((r) => r.turn);
const problemTurns = (problems) => [...new Set(problems.map((p) => p.turn))].filter((turn) => turn !== null);

test('a reply read from PayPal is proven sentence by sentence, and a sentence with no fact and no claim is plain', () => {
  const add = readCall();
  add('said', { turn: 2, text: `${GIFT} ${ANYTHING_ELSE}`, facts: GIFT_FACTS, claims: [] });
  const receipts = buildReceipts(add.events);
  assert.deepEqual(receipts.map((r) => r.turn), [1, 2]);
  assert.deepEqual(Object.keys(receipts[1]), ['turn', 'seq', 'ts', 'sentences']);
  const gift = sentenceOf(receipts, 2, GIFT);
  assert.equal(gift.verdict, 'proven');
  assert.deepEqual(gift.problems, []);
  assert.deepEqual(Object.keys(gift), ['text', 'verdict', 'facts', 'claims', 'problems']);
  assert.deepEqual(sentenceOf(receipts, 2, ANYTHING_ELSE), { text: ANYTHING_ELSE, verdict: 'plain', facts: [], claims: [], problems: [] });
});

test('each fact carries the latest earlier PayPal read of the object it came from as its proof', () => {
  const add = readCall();
  add('said', { turn: 2, text: GIFT, facts: GIFT_FACTS, claims: [] });
  const [subRead, planRead] = add.events.filter((e) => e.type === 'read');
  const { facts } = sentenceOf(buildReceipts(add.events), 2, GIFT);
  assert.deepEqual(facts, [
    { ...GIFT_FACTS[0], proof: { seq: planRead.seq, ts: planRead.ts, what: 'plan', id: 'P-1', debugId: 'dbg-plan', status: null } },
    { ...GIFT_FACTS[1], proof: { seq: subRead.seq, ts: subRead.ts, what: 'subscription', id: 'I-1', debugId: 'dbg-sub', status: 'ACTIVE' } },
  ]);
});

test('a claim sentence is proven by its events, with the grader\'s own words for what it claims', () => {
  const add = readCall();
  add('said', { turn: 2, text: `${GIFT} ${ANYTHING_ELSE}`, facts: GIFT_FACTS, claims: [] });
  const receipts = buildReceipts(add.events);
  assert.deepEqual(sentenceOf(receipts, 1, 'Thanks, you are verified.').claims, [{ name: 'pin_ok', meaning: check.CLAIM_MEANINGS.pin_ok, proven: true }]);
  assert.equal(check.CLAIM_MEANINGS.pin_ok, 'a PIN that passed in that turn');
  assert.equal(sentenceOf(receipts, 1, 'Thanks, you are verified.').verdict, 'proven');
});

test('a sentence checkFacts flags is blocked with its message, and the clean sentences beside it are not', () => {
  // "Done." with no write in the turn, and an amount PayPal never returned.
  const add = readCall();
  add('said', { turn: 2, text: `Done. PayPal shows your monthly gift of $30.00 as active. ${ANYTHING_ELSE}`,
    facts: [{ kind: 'money', value: '$30.00', source: 'plan.price' }, GIFT_FACTS[1]], claims: [{ claim: 'wrote', sentence: 'Done.' }] });
  const receipts = buildReceipts(add.events);
  const done = sentenceOf(receipts, 2, 'Done.');
  assert.equal(done.verdict, 'blocked');
  assert.deepEqual(done.claims, [{ name: 'wrote', meaning: 'an ok write in that turn', proven: false }]);
  assert.ok(done.problems.some((m) => /claims an ok write in that turn/.test(m)), done.problems.join('\n'));
  const amount = sentenceOf(receipts, 2, 'PayPal shows your monthly gift of $30.00 as active.');
  assert.equal(amount.verdict, 'blocked');
  assert.ok(amount.problems.some((m) => m.includes('$30.00')), amount.problems.join('\n'));
  assert.equal(sentenceOf(receipts, 2, ANYTHING_ELSE).verdict, 'plain');
  // Every message is checkFacts' own, for that turn.
  const own = check.checkFacts(add.events).filter((p) => p.turn === 2).map((p) => p.message);
  for (const message of [...done.problems, ...amount.problems]) assert.ok(own.includes(message), message);
});

test('a problem that names no one sentence, or the whole call, blocks every sentence it could touch', () => {
  const unspoken = readCall();
  unspoken('said', { turn: 2, text: `PayPal shows your monthly gift as active. ${ANYTHING_ELSE}`, facts: GIFT_FACTS, claims: [] });
  const turn2 = buildReceipts(unspoken.events).find((r) => r.turn === 2);
  assert.deepEqual(turn2.sentences.map((s) => s.verdict), ['blocked', 'blocked'], 'a declared fact the reply never says can\'t be pinned to a sentence');
  // A template list the history lacks can't vouch for any reply.
  const unknown = readCall('c2', { templates: 'not-a-list' });
  unknown('said', { turn: 2, text: GIFT, facts: GIFT_FACTS, claims: [] });
  const receipts = buildReceipts(unknown.events);
  assert.ok(receipts.every((r) => r.sentences.every((s) => s.verdict === 'blocked' && s.problems.some((m) => m.includes('not-a-list')))));
});

test('receipts agree with checkFacts: a turn has a blocked sentence exactly when checkFacts reports a problem in it', async () => {
  const stack = buildStack();
  const ledgers = [];
  for (const script of PILOT_SCRIPTS) ledgers.push(stack.ledger.byCall((await runScript(stack, script)).callId));
  const proof = await verifiedCall(stack);
  for (const line of ['How do you know?', 'I want to stop my monthly gift.', 'Are you sure?', 'Yes.', 'Give fifty dollars once.', 'Prove it.', 'No.', 'Says who?']) await say(stack, proof, line);
  ledgers.push(stack.ledger.byCall(proof));
  const bad = readCall('c3');
  bad('said', { turn: 2, text: `Done. ${GIFT}`, facts: GIFT_FACTS, claims: [{ claim: 'wrote', sentence: 'Done.' }] });
  bad('heard', { turn: 3, text: 'Thanks.', source: 'voice' });
  bad('said', { turn: 3, text: 'The next gift is this month.', facts: [], claims: [] });
  ledgers.push(bad.events);
  const options = { orgName: stack.config.orgName, subscriptionId: null };
  for (const events of ledgers) {
    const problems = check.checkFacts(events, options);
    const receipts = buildReceipts(events, options);
    assert.deepEqual(blockedTurns(receipts), problemTurns(problems), JSON.stringify(problems));
    for (const r of receipts) {
      for (const s of r.sentences) {
        if (s.verdict === 'blocked') assert.ok(s.problems.length > 0, s.text);
        else assert.deepEqual(s.problems, [], s.text);
        if (s.verdict === 'proven') assert.ok(s.facts.length + s.claims.length > 0, s.text);
        if (s.verdict === 'proven') assert.ok(s.facts.every((f) => f.proof || f.source.startsWith('config.')) && s.claims.every((c) => c.proven), s.text);
      }
    }
  }
  assert.deepEqual(blockedTurns(buildReceipts(bad.events)), [2, 3]);
  // The ten scripts and the proof call grade clean, so every sentence is proven or plain.
  assert.ok(ledgers.slice(0, -1).every((events) => blockedTurns(buildReceipts(events, options)).length === 0));
});

test('the call state from start, turn, get and end carries the receipts pilot-check would grade', async () => {
  const stack = buildStack();
  const { callId, state } = stack.calls.start({ script: 1, userAgent: 'node-test' });
  assert.equal(state.receipts.length, 1, 'the greeting');
  await say(stack, callId, stack.config.pin, 'keypad');
  const turn = await say(stack, callId, 'How much is my monthly gift?');
  const options = { orgName: stack.config.orgName, subscriptionId: stack.config.demoSubscriptionId, timeZone: stack.config.timeZone };
  assert.deepEqual(turn.state.receipts, buildReceipts(stack.ledger.byCall(callId), options));
  assert.equal(sentenceOf(turn.state.receipts, turn.turn, 'PayPal shows your monthly gift of $25.00 as active.').verdict, 'proven');
  assert.deepEqual(stack.calls.get(callId).receipts, turn.state.receipts);
  const ended = await stack.calls.end(callId);
  assert.equal(ended.ok, true);
  assert.deepEqual(ended.state.receipts, buildReceipts(stack.ledger.byCall(callId), options));
  assert.ok(!JSON.stringify(stack.calls.get(callId).receipts).includes(stack.config.pin), 'the PIN never reaches a receipt');
});

test('every existing check grades the same events the same way before and after the receipt helpers were added', async (t) => {
  const base = spawnSync('git', ['show', `${BASE}:src/check.js`], { cwd: ROOT, encoding: 'utf8' });
  if (base.status !== 0) {
    t.skip(`git has no ${BASE} here, ${base.stderr.trim()}`);
    return;
  }
  const dir = copyProject();
  fs.writeFileSync(path.join(dir, 'src', 'check.js'), base.stdout);
  const before = await import(pathToFileURL(path.join(dir, 'src', 'check.js')).href);
  assert.equal(before.claimBacked, undefined, 'the copy is the old grader');
  // Calls the old grader can read: the ten scripts, which say no new sentence, and hand-built ones that fail.
  const stack = buildStack();
  const calls = [];
  for (const script of PILOT_SCRIPTS) calls.push({ script, events: stack.ledger.byCall((await runScript(stack, script)).callId) });
  const bad = readCall('c4');
  bad('said', { turn: 2, text: `Done. PayPal shows your monthly gift of $30.00 as active. It will stop next month.`,
    facts: [{ kind: 'money', value: '$30.00', source: 'plan.price' }, GIFT_FACTS[1]], claims: [{ claim: 'wrote', sentence: 'Done.' }] });
  bad('write', { turn: 2, kind: 'suspend', targetId: 'I-1', tokenId: 't9', ok: true, debugId: 'd9' });
  calls.push({ script: scriptByNumber(2), events: bad.events });
  const options = [{}, { orgName: stack.config.orgName, subscriptionId: stack.config.demoSubscriptionId }, { lenientTemplates: true }];
  for (const { script, events } of calls) {
    for (const o of options) {
      for (const name of ['checkFacts', 'checkWrites', 'checkSafety']) assert.deepEqual(check[name](events, o), before[name](events, o), `${name} ${JSON.stringify(o)}`);
      assert.deepEqual(check.gradeCall(events, script, o), before.gradeCall(events, script, o));
    }
    assert.deepEqual(check.checkScript(events, script), before.checkScript(events, script));
  }
  const all = calls.flatMap((c) => c.events);
  assert.deepEqual(check.checkFacts(all), before.checkFacts(all));
  assert.ok(check.checkFacts(bad.events).length > 0 && check.checkWrites(bad.events).length > 0, 'the hand-built call fails both, so the comparison covers failures');
});
