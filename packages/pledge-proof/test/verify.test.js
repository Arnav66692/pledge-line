import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify, receipt } from '../src/index.js';

const GIFT = 'I-GIFT0001';
const OTHER = 'I-GIFT0002';
const read = (turn, values, id = GIFT, at = `2026-11-07T17:0${turn}:00Z`) => ({ turn, at, object: { type: 'subscription', id }, values });
const write = (turn, action, ok, subject = GIFT) => ({ turn, at: `2026-11-07T17:0${turn}:30Z`, action, subject, ok });
const verdictOf = (input) => verify(input).map((s) => s.verdict);

test('a status the latest read shows is backed', () => {
  const sentences = [{ turn: 1, text: 'Your gift is active.', facts: [{ kind: 'status', value: 'active', subject: GIFT }] }];
  const reads = [read(1, { status: 'active' })];
  assert.deepEqual(verdictOf({ sentences, reads, writes: [] }), ['backed']);
});

test('an amount that differs from the read is unbacked', () => {
  const sentences = [{ turn: 1, text: 'Your gift is 30 dollars.', facts: [{ kind: 'amount', value: '30.00', currency: 'USD', subject: GIFT }] }];
  const reads = [read(1, { amount: { value: '25.00', currency: 'USD' } })];
  const [result] = receipt({ sentences, reads, writes: [] });
  assert.equal(result.verdict, 'unbacked');
  assert.match(result.facts[0].reason, /gives amount \{"value":"25\.00","currency":"USD"\}, not "30\.00"/);
});

test('an amount with the same cents in a different written form is backed', () => {
  const sentences = [{ turn: 1, text: 'Your gift is 25 dollars.', facts: [{ kind: 'amount', value: '25', currency: 'USD', subject: GIFT }] }];
  const reads = [read(1, { amount: { value: '25.00', currency: 'USD' } })];
  assert.deepEqual(verdictOf({ sentences, reads, writes: [] }), ['backed']);
});

test('a status said before the suspend succeeded is unbacked, and the same status is backed once the read shows it', () => {
  const paused = { kind: 'status', value: 'suspended', subject: GIFT };
  const sentences = [
    { turn: 1, text: 'Your gift is paused.', facts: [paused] },
    { turn: 2, text: 'Your gift is paused.', facts: [paused] },
  ];
  const reads = [read(1, { status: 'active' }), read(2, { status: 'suspended' })];
  const writes = [write(2, 'suspend', true)];
  assert.deepEqual(verdictOf({ sentences, reads, writes }), ['unbacked', 'backed']);
});

test('a completed-action phrase with no successful write in its turn is unbacked', () => {
  const sentences = [{ turn: 2, text: 'I paused it.', facts: [{ kind: 'action', value: 'suspend', subject: GIFT }] }];
  const reads = [read(2, { status: 'active' })];
  const writes = [write(2, 'suspend', false)];
  const [result] = receipt({ sentences, reads, writes });
  assert.equal(result.verdict, 'unbacked');
  assert.equal(result.facts[0].reason, `no successful suspend write of ${GIFT} in turn 2`);
});

test('a completed-action phrase with a successful write in its turn is backed by that write', () => {
  const sentences = [{ turn: 2, text: 'I paused it.', facts: [{ kind: 'action', value: 'suspend', subject: GIFT }] }];
  const writes = [write(2, 'suspend', true)];
  const [result] = receipt({ sentences, reads: [], writes });
  assert.equal(result.verdict, 'backed');
  assert.deepEqual(result.facts[0].backing, { source: 'write', turn: 2, at: '2026-11-07T17:02:30Z', reference: GIFT });
});

test('a question that declares no fact is no-claim', () => {
  const sentences = [{ turn: 1, text: 'Would you like me to pause it?', facts: [] }];
  assert.deepEqual(verdictOf({ sentences, reads: [read(1, { status: 'active' })], writes: [] }), ['no-claim']);
});

test('a sentence with no facts field is also no-claim', () => {
  assert.deepEqual(verdictOf({ sentences: [{ turn: 0, text: 'Hello.' }] }), ['no-claim']);
});

test('a read of a different subscription does not back a fact about this one', () => {
  const sentences = [{ turn: 1, text: 'Your gift is paused.', facts: [{ kind: 'status', value: 'suspended', subject: GIFT }] }];
  const reads = [read(1, { status: 'suspended' }, OTHER)];
  const [result] = receipt({ sentences, reads, writes: [] });
  assert.equal(result.verdict, 'unbacked');
  assert.equal(result.facts[0].reason, `no read of ${GIFT} in turns 0 to 1 gives a status`);
});

test('a read two turns earlier is outside the window and does not back a fact', () => {
  const sentences = [{ turn: 3, text: 'Your gift is active.', facts: [{ kind: 'status', value: 'active', subject: GIFT }] }];
  const reads = [read(1, { status: 'active' })];
  assert.deepEqual(verdictOf({ sentences, reads, writes: [] }), ['unbacked']);
});

test('the latest read in the window decides, so an older matching read does not back a newer change', () => {
  const sentences = [{ turn: 2, text: 'Your gift is paused.', facts: [{ kind: 'status', value: 'suspended', subject: GIFT }] }];
  const reads = [read(1, { status: 'suspended' }), read(2, { status: 'active' })];
  const [result] = receipt({ sentences, reads, writes: [] });
  assert.equal(result.verdict, 'unbacked');
  assert.match(result.facts[0].reason, /the latest read of .* gives status "active", not "suspended"/);
});

test('a date is backed by a read whose date part matches', () => {
  const sentences = [{ turn: 1, text: 'Your next gift is on December 1.', facts: [{ kind: 'date', value: '2026-12-01', subject: GIFT }] }];
  const reads = [read(1, { date: '2026-12-01' })];
  assert.deepEqual(verdictOf({ sentences, reads, writes: [] }), ['backed']);
});

test('receipt keeps sentence order and gives each backing read its time and reference', () => {
  const sentences = [
    { turn: 1, text: 'Your gift is active.', facts: [{ kind: 'status', value: 'active', subject: GIFT }] },
    { turn: 1, text: 'Would you like to pause it?', facts: [] },
    { turn: 1, text: 'Your gift is 25 dollars.', facts: [{ kind: 'amount', value: '25.00', currency: 'USD', subject: GIFT }] },
  ];
  const reads = [read(1, { status: 'active', amount: { value: '25.00', currency: 'USD' } }, GIFT, '2026-11-07T17:01:00Z')];
  const result = receipt({ sentences, reads, writes: [] });
  assert.deepEqual(result.map((s) => s.text), sentences.map((s) => s.text));
  assert.deepEqual(result.map((s) => s.verdict), ['backed', 'no-claim', 'backed']);
  assert.deepEqual(result[0].facts[0].backing, { source: 'read', turn: 1, at: '2026-11-07T17:01:00Z', reference: GIFT });
});

test('verify and receipt reject a malformed input with a TypeError', () => {
  assert.throws(() => verify({ sentences: 'Your gift is active.' }), TypeError);
  assert.throws(() => verify({ sentences: [{ turn: -1, text: 'x' }] }), TypeError);
  assert.throws(() => verify({ sentences: [{ turn: 1, text: 'x', facts: [{ kind: 'mood', value: 'happy', subject: GIFT }] }] }), TypeError);
  assert.throws(() => receipt({ sentences: [{ turn: 1, text: 'x', facts: [{ kind: 'amount', value: '5', subject: GIFT }] }] }), TypeError);
});
