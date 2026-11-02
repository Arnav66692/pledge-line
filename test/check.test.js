import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFacts, checkWrites, checkSafety, checkScript, medianGap, gradeCall, latestCallsByScript } from '../src/check.js';
import { scriptByNumber } from '../src/pilot-scripts.js';

const SUB = { id: 'I-1', status: 'ACTIVE', plan_id: 'P-1', next_billing_time: '2026-12-01T10:00:00Z', subscriber_email: 'sb-maria@personal.example.com', subscriber_given_name: 'Maria' };
const SUSPENDED = { ...SUB, status: 'SUSPENDED' };
const PLAN = { id: 'P-1', price_value: '25.00', price_currency: 'USD' };
// The proposal's read-back is logged on the proposed event and is part of what the line said.
const OFFER = 'PayPal shows your monthly gift of $25.00 as active. Would you like me to pause it?';
const OFFER_FACTS = [{ kind: 'money', value: '$25.00', source: 'plan.price' }, { kind: 'status', value: 'active', source: 'subscription.status' }];

function ledger() {
  let seq = 0;
  const events = [];
  const add = (type, fields = {}) => {
    seq += 1;
    events.push({ type, callId: 'c1', seq, ts: new Date(Date.UTC(2026, 10, 3, 18, 0, seq)).toISOString(), ...fields });
    return add;
  };
  add.events = events;
  return add;
}

function verifiedStart() {
  const add = ledger();
  add('call_start', { script: 2, browser: 'chrome', mode: { paypal: 'sandbox', router: 'haiku' }, timeZone: 'America/Los_Angeles' });
  add('said', { turn: 0, text: 'Thanks for calling. Please enter your PIN.', facts: [] });
  add('heard', { turn: 1, text: '####', source: 'keypad' });
  add('pin_ok', { turn: 1 });
  add('said', { turn: 1, text: 'Thanks, you are verified.', facts: [] });
  return add;
}

function proposePause(add) {
  add('heard', { turn: 2, text: 'I want to stop my monthly gift.', source: 'voice' });
  add('read', { turn: 2, what: 'subscription', id: 'I-1', status: 'ACTIVE', snapshot: SUB, debugId: 'd1' });
  add('read', { turn: 2, what: 'plan', id: 'P-1', status: null, snapshot: PLAN, debugId: 'd2' });
  add('proposed', { turn: 2, pendingId: 'p1', kind: 'suspend', targetId: 'I-1', origin: 'pause_offer', readBack: OFFER });
  add('said', { turn: 2, text: OFFER, facts: OFFER_FACTS });
  return add;
}

function pauseYes(add, { yesTurn = 3, heardText = 'Yes.', yesText = heardText, tokenId = 't1', rereadId = 'I-1' } = {}) {
  if (yesTurn !== 2) add('heard', { turn: yesTurn, text: heardText, source: 'voice' });
  add('yes', { turn: yesTurn, pendingId: 'p1', tokenId, text: yesText });
  add('write', { turn: yesTurn, kind: 'suspend', targetId: 'I-1', tokenId, ok: true, debugId: 'd3' });
  add('read', { turn: yesTurn, what: 'subscription', id: rereadId, status: 'SUSPENDED', snapshot: { ...SUSPENDED, id: rereadId }, debugId: 'd4' });
  add('said', { turn: yesTurn, text: 'Done. PayPal now shows your monthly gift of $25.00 as suspended.', facts: [
    { kind: 'money', value: '$25.00', source: 'plan.price' }, { kind: 'status', value: 'suspended', source: 'subscription.status' }] });
  return add;
}

const pauseFlow = (add, options = {}) => pauseYes(proposePause(add), options);
const writeMessages = (add) => checkWrites(add.events).map((v) => v.message).join('\n');

test('a clean pause ledger passes every check', () => {
  const add = pauseFlow(verifiedStart());
  add('call_end', { reason: 'goodbye' });
  const grade = gradeCall(add.events, scriptByNumber(2));
  assert.equal(grade.passed, true, JSON.stringify(grade));
});

test('a write before any yes fails the writes check', () => {
  const add = verifiedStart();
  add('heard', { turn: 2, text: 'Pause it.', source: 'voice' });
  add('write', { turn: 2, kind: 'suspend', targetId: 'I-1', tokenId: 't9', ok: true, debugId: 'd3' });
  assert.match(checkWrites(add.events).map((v) => v.message).join('\n'), /without an earlier yes/);
});

test('a yes in the same turn as the proposal fails the writes check', () => {
  const add = pauseFlow(verifiedStart(), { yesTurn: 2 });
  assert.match(checkWrites(add.events).map((v) => v.message).join('\n'), /same turn as the proposal|never spoken/);
});

test('a number that no PayPal read covers fails the facts check', () => {
  const add = verifiedStart();
  add('read', { turn: 2, what: 'subscription', id: 'I-1', status: 'ACTIVE', snapshot: SUB, debugId: 'd1' });
  add('said', { turn: 2, text: 'Your gift is $30.00 and you have 3 days.', facts: [] });
  const messages = checkFacts(add.events).map((v) => v.message);
  assert.ok(messages.some((m) => m.includes('$30.00')));
  assert.ok(messages.some((m) => m.includes('"3"')));
});

test('a declared fact that disagrees with the latest read fails the facts check', () => {
  const add = verifiedStart();
  add('read', { turn: 2, what: 'subscription', id: 'I-1', status: 'SUSPENDED', snapshot: SUSPENDED, debugId: 'd1' });
  add('said', { turn: 2, text: 'PayPal shows it as active.', facts: [{ kind: 'status', value: 'active', source: 'subscription.status' }] });
  assert.match(checkFacts(add.events)[0].message, /PayPal's latest read gives "suspended"/);
});

test('a read before pin_ok fails the writes check', () => {
  const add = ledger();
  add('call_start', { script: 1, browser: 'chrome', mode: { paypal: 'sandbox', router: 'haiku' } });
  add('read', { turn: 1, what: 'subscription', id: 'I-1', status: 'ACTIVE', snapshot: SUB, debugId: 'd1' });
  add('pin_ok', { turn: 1 });
  assert.match(checkWrites(add.events)[0].message, /before the PIN passed/);
});

test('a token used twice fails the writes check', () => {
  const add = pauseFlow(verifiedStart());
  add('write', { turn: 3, kind: 'suspend', targetId: 'I-1', tokenId: 't1', ok: false, debugId: 'd5' });
  assert.ok(checkWrites(add.events).some((v) => v.message.includes('used twice')));
});

test('an invoice to another email and a read after a lock are safety stops', () => {
  const add = verifiedStart();
  add('read', { turn: 2, what: 'subscription', id: 'I-1', status: 'ACTIVE', snapshot: SUB, debugId: 'd1' });
  add('read', { turn: 2, what: 'invoice', id: 'INV2-1', status: 'DRAFT', snapshot: { id: 'INV2-1', status: 'DRAFT', number: '0001', amount_value: '25.00', amount_currency: 'USD', recipient_email: 'bob@gmail.com' }, debugId: 'd2' });
  add('pin_locked', { turn: 3 });
  add('read', { turn: 4, what: 'subscription', id: 'I-1', status: 'ACTIVE', snapshot: SUB, debugId: 'd3' });
  const messages = checkSafety(add.events).map((v) => v.message);
  assert.ok(messages.some((m) => m.includes('email other than the one on file')));
  assert.ok(messages.some((m) => m.includes('after the call was locked')));
});

test('checkScript catches a missing write and a wrong final status', () => {
  const add = verifiedStart();
  add('read', { turn: 2, what: 'subscription', id: 'I-1', status: 'ACTIVE', snapshot: SUB, debugId: 'd1' });
  const problems = checkScript(add.events, scriptByNumber(2)).map((v) => v.message).join('\n');
  assert.match(problems, /writes \[\], expected \["suspend"\]/);
  assert.match(problems, /final subscription status ACTIVE, expected SUSPENDED/);
});

test('medianGap counts only unmuted voice turns', () => {
  const events = [
    { type: 'gap', gapMs: 1000, source: 'voice', muted: false },
    { type: 'gap', gapMs: 3000, source: 'voice', muted: false },
    { type: 'gap', gapMs: 2000, source: 'voice', muted: false },
    { type: 'gap', gapMs: 9000, source: 'voice', muted: true },
    { type: 'gap', gapMs: 8000, source: 'typed', muted: false },
  ];
  assert.equal(medianGap(events), 2000);
  assert.equal(medianGap([]), null);
});

test('a write whose yes turn heard a clear no fails the writes check', () => {
  const add = pauseFlow(verifiedStart(), { heardText: 'No, do not pause it.' });
  assert.match(writeMessages(add), /not a clear yes for suspend/);
  const mismatch = pauseFlow(verifiedStart(), { heardText: 'Please repeat that.', yesText: 'Yes.' });
  assert.match(writeMessages(mismatch), /not a clear yes for suspend/);
});

test('a write with no token, or a null one, fails the writes check', () => {
  for (const tokenId of [undefined, null, '']) {
    const add = pauseFlow(verifiedStart());
    for (const event of add.events.filter((e) => e.type === 'yes' || e.type === 'write')) {
      if (tokenId === undefined) delete event.tokenId;
      else event.tokenId = tokenId;
    }
    assert.match(writeMessages(add), /without a one-time token/, String(tokenId));
  }
});

test('a write, read or draft step after the call ended fails the writes check', () => {
  const add = proposePause(verifiedStart());
  add('call_end', { reason: 'goodbye' });
  pauseYes(add);
  assert.match(writeMessages(add), /write happened after the call ended/);
  assert.match(writeMessages(add), /read happened after the call ended/);
});

test('a read-back of a different subscription fails the writes check', () => {
  const add = pauseFlow(verifiedStart(), { rereadId: 'I-OTHER' });
  assert.match(writeMessages(add), /no fresh PayPal read of I-1 after suspend/);
});

test('a yes that answers an unrelated reply, not the proposal, fails the writes check', () => {
  const add = proposePause(verifiedStart());
  add('heard', { turn: 3, text: 'How much is my monthly gift?', source: 'voice' });
  add('said', { turn: 3, text: 'PayPal shows your monthly gift of $25.00 as active. What else can I help with?', facts: OFFER_FACTS });
  pauseYes(add, { yesTurn: 4, heardText: 'Okay, thanks.' });
  assert.match(writeMessages(add), /did not answer a proposal spoken in the turn before it/);
});

test('amounts and dates said in words, and digits from other scripts, fail the facts check', () => {
  const add = verifiedStart();
  add('heard', { turn: 2, text: 'Yes.', source: 'voice' });
  add('said', { turn: 2, text: 'Your gift is twenty five dollars, and it is off now.', facts: [] });
  add('said', { turn: 3, text: 'Your gift is twenty five dollars, and the next one is on the first of December.', facts: [] });
  add('said', { turn: 4, text: 'Your gift is \uFF12\uFF15 dollars.', facts: [] });
  add('said', { turn: 5, text: 'That is \u0662\u0665 each month.', facts: [] });
  const messages = checkFacts(add.events).map((v) => `${v.turn} ${v.message}`);
  assert.ok(messages.some((m) => m.startsWith('2 ') && m.includes('money "$25.00"')), messages.join('\n'));
  assert.ok(messages.some((m) => m.startsWith('3 ') && m.includes('date "December 1"')), messages.join('\n'));
  assert.ok(messages.some((m) => m.startsWith('4 ') && m.includes('number')), messages.join('\n'));
  assert.ok(messages.some((m) => m.startsWith('5 ') && m.includes('number')), messages.join('\n'));
});

test('an amount in words matching a PayPal read is covered, and tries left in words never count', () => {
  const add = verifiedStart();
  add('read', { turn: 2, what: 'plan', id: 'P-1', status: null, snapshot: PLAN, debugId: 'd2' });
  add('said', { turn: 2, text: 'That is twenty five dollars.', facts: [{ kind: 'money', value: '$25.00', source: 'plan.price' }] });
  add('said', { turn: 3, text: "That PIN didn't match. You have two tries left.", facts: [] });
  assert.deepEqual(checkFacts(add.events), []);
});

test('latestCallsByScript compares --since as a time and skips calls with no turns', () => {
  const call = (callId, seq, ts, heard = true) => [
    { type: 'call_start', callId, seq, ts, script: 2, browser: 'chrome' },
    ...(heard ? [{ type: 'heard', callId, seq: seq + 1, ts, turn: 1, text: '####', source: 'keypad' }] : []),
  ];
  const practice = call('practice', 1, '2026-11-03T20:00:00.000Z');
  const graded = call('graded', 10, '2026-11-04T03:30:00.000Z');
  const misclick = call('misclick', 20, '2026-11-04T03:40:00.000Z', false);
  // 7 pm PT on Nov 3 is 03:00 UTC on Nov 4, so the noon practice call is before it.
  const since = '2026-11-03T19:00:00-08:00';
  assert.deepEqual([...latestCallsByScript(practice, { since }).keys()], []);
  assert.equal(latestCallsByScript([...practice, ...graded, ...misclick], { since }).get(2).callId, 'graded');
  assert.equal(latestCallsByScript([...practice, ...misclick]).get(2).callId, 'practice');
});
