import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFacts, checkWrites, checkSafety, checkScript, medianGap, countedGaps, gradeCall, latestCallsByScript } from '../src/check.js';
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
  // Every sentence a passing reply says is one the templates say (R3-6).
  add('said', { turn: 0, text: 'Thanks for calling. Please enter your PIN on the keypad, or say its digits.', facts: [] });
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
  // A plan fact comes only from the plan of the call's own subscription, so the subscription is read first (R3-7).
  add('read', { turn: 2, what: 'subscription', id: 'I-1', status: 'ACTIVE', snapshot: SUB, debugId: 'd1' });
  add('read', { turn: 2, what: 'plan', id: 'P-1', status: null, snapshot: PLAN, debugId: 'd2' });
  add('said', { turn: 2, text: 'That is twenty five dollars.', facts: [{ kind: 'money', value: '$25.00', source: 'plan.price' }] });
  add('said', { turn: 3, text: "That PIN didn't match. You have two tries left.", facts: [] });
  // The scans read the amount in words and the read covers it. The sentence is no template's, so only that is a problem (R3-6).
  assert.deepEqual(checkFacts(add.events).map((v) => `${v.turn} ${v.message}`), ['2 said "That is twenty five dollars.", a sentence the line\'s own templates never say']);
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

/** The yes turn of pauseYes, with extra fields on its heard event and chosen times. */
function pauseYesWith(add, { heard = {}, ts, writeTs = ts } = {}) {
  const at = (when) => (when ? { ts: when } : {});
  add('heard', { turn: 3, text: 'Yes.', source: 'voice', ...heard, ...at(ts) });
  add('yes', { turn: 3, pendingId: 'p1', tokenId: 't1', text: heard.text ?? 'Yes.', ...at(ts) });
  add('write', { turn: 3, kind: 'suspend', targetId: 'I-1', tokenId: 't1', ok: true, debugId: 'd3', ms: 0, ...at(writeTs) });
  add('read', { turn: 3, what: 'subscription', id: 'I-1', status: 'SUSPENDED', snapshot: SUSPENDED, debugId: 'd4', ...at(writeTs) });
  add('said', { turn: 3, text: 'Done. PayPal now shows your monthly gift of $25.00 as suspended.', facts: [
    { kind: 'money', value: '$25.00', source: 'plan.price' }, { kind: 'status', value: 'suspended', source: 'subscription.status' }], ...at(writeTs) });
  return add;
}

const DRAFT = { id: 'INV2-1', status: 'DRAFT', number: '0001', amount_value: '50.00', amount_currency: 'USD', recipient_email: 'sb-maria@personal.example.com', recipient_view_url: null };
const INVOICE_OFFER = 'PayPal shows a one-time gift invoice ending in 0001, for $50.00, with the status draft. Should I send it?';
const INVOICE_FACTS = [{ kind: 'number_suffix', value: '0001', source: 'invoice.number_last4' }, { kind: 'money', value: '$50.00', source: 'invoice.amount' },
  { kind: 'status', value: 'draft', source: 'invoice.status' }];

function proposeInvoice(add, { draft = DRAFT, target = 'INV2-1', readBack = INVOICE_OFFER, facts = INVOICE_FACTS } = {}) {
  add('heard', { turn: 2, text: "I'd like to give fifty dollars, just once.", source: 'voice' });
  add('read', { turn: 2, what: 'subscription', id: 'I-1', status: 'ACTIVE', snapshot: SUB, debugId: 'd1' });
  add('staging_write', { turn: 2, kind: 'create_draft', id: 'INV2-1', ok: true, debugId: 'd2' });
  add('read', { turn: 2, what: 'invoice', id: 'INV2-1', status: draft.status, snapshot: draft, debugId: 'd3' });
  add('proposed', { turn: 2, pendingId: 'p5', kind: 'send_invoice', targetId: target, origin: 'request', readBack });
  add('said', { turn: 2, text: readBack, facts });
  return add;
}

test('a yes turn the PIN mask touched never grades as a clear yes', () => {
  assert.match(writeMessages(pauseFlow(verifiedStart(), { heardText: 'yes # it # ###' })), /not a clear yes for suspend/);
});

test('a yes whose client had not yet received the proposal fails the writes check', () => {
  assert.match(writeMessages(pauseYesWith(proposePause(verifiedStart()), { heard: { answering: 1 } })), /left its client before the proposal reached it/);
  assert.equal(writeMessages(pauseYesWith(proposePause(verifiedStart()), { heard: { answering: 2 } })), '');
});

test('a write on a proposal that timed out, was set aside or was declined fails the writes check', () => {
  for (const [type, words] of [['expired', 'already timed out'], ['withdrawn', 'already been set aside'], ['no', 'already been declined']]) {
    const add = proposePause(verifiedStart());
    add(type, { turn: 3, pendingId: 'p1' });
    assert.match(writeMessages(pauseYes(add)), new RegExp(`proposal that had ${words}`), type);
  }
  const offeredAt = (add) => Date.parse(add.events.find((e) => e.type === 'proposed').ts);
  const lateYes = proposePause(verifiedStart());
  pauseYesWith(lateYes, { ts: new Date(offeredAt(lateYes) + 121000).toISOString() });
  assert.match(writeMessages(lateYes), /yes for suspend came after its proposal timed out/);
  const lateWrite = proposePause(verifiedStart());
  const yesAt = offeredAt(lateWrite) + 5000;
  pauseYesWith(lateWrite, { ts: new Date(yesAt).toISOString(), writeTs: new Date(yesAt + 61000).toISOString() });
  assert.match(writeMessages(lateWrite), /suspend ran after its one-time token timed out/);
});

test('the amount limits pass the facts check only when they match the config', () => {
  const ask = 'I can set up a one-time gift from one dollar to five hundred dollars. How much would you like to give?';
  const limits = (max) => [{ kind: 'money', value: '$1.00', source: 'config.invoice_min_dollars' }, { kind: 'money', value: max, source: 'config.invoice_max_dollars' }];
  const add = verifiedStart();
  add('said', { turn: 2, text: ask, facts: limits('$500.00') });
  assert.deepEqual(checkFacts(add.events), []);
  const wrong = verifiedStart();
  wrong('said', { turn: 2, text: ask, facts: limits('$900.00') });
  assert.match(checkFacts(wrong.events).map((v) => v.message).join('\n'), /the config gives "\$500\.00"/);
  // A config source covers the limits only inside the line's own amount question.
  const borrowed = verifiedStart();
  borrowed('said', { turn: 2, text: 'Your monthly gift is $500.00.', facts: [{ kind: 'money', value: '$500.00', source: 'config.invoice_max_dollars' }] });
  assert.match(checkFacts(borrowed.events).map((v) => v.message).join('\n'), /only for the line's own amount limits/);
});

test('facts said in other forms fail the facts check, and a masked email proven by a read never does', () => {
  const add = verifiedStart();
  add('read', { turn: 2, what: 'subscription', id: 'I-1', status: 'ACTIVE', snapshot: SUB, debugId: 'd1' });
  add('read', { turn: 2, what: 'plan', id: 'P-1', status: null, snapshot: PLAN, debugId: 'd2' });
  add('said', { turn: 2, text: 'PayPal shows your monthly gift of $25.00 as active. The next gift is on Dec fifteenth, then every thirty days.', facts: OFFER_FACTS });
  add('said', { turn: 3, text: 'PayPal shows your monthly gift of forty as active.', facts: [OFFER_FACTS[1]] });
  add('said', { turn: 4, text: 'OK, I have put your monthly gift on hold. It is stopped until you call back on Tuesday.', facts: [] });
  const messages = checkFacts(add.events).map((v) => `${v.turn} ${v.message}`);
  for (const [turn, word] of [[2, 'fifteenth'], [2, 'thirty'], [3, 'forty'], [4, 'on hold'], [4, 'stopped'], [4, 'tuesday']]) {
    assert.ok(messages.some((m) => m.startsWith(`${turn} `) && m.includes(`"${word}"`)), `${turn} ${word}\n${messages.join('\n')}`);
  }
  const digits = verifiedStart();
  // An invoice fact comes only from the call's own draft, so the draft is made first (R3-7).
  digits('staging_write', { turn: 2, kind: 'create_draft', id: 'INV2-1', ok: true, debugId: 'd0' });
  digits('read', { turn: 2, what: 'invoice', id: 'INV2-1', status: 'DRAFT', snapshot: { ...DRAFT, recipient_email: '42jo@mail2.example.com' }, debugId: 'd1' });
  digits('said', { turn: 2, text: 'It would go to the email on file, four two at mail two dot example dot com.',
    facts: [{ kind: 'email', value: 'four two at mail two dot example dot com', source: 'invoice.recipient_email' }] });
  assert.deepEqual(checkFacts(digits.events), []);
});

test('a proposal that skips its amount, or a write whose reply skips the new status, fails the behavior check', () => {
  const bare = 'Before you stop it, I can pause it instead. Would you like me to pause it?';
  const add = verifiedStart();
  add('heard', { turn: 2, text: 'I want to stop my monthly gift.', source: 'voice' });
  add('read', { turn: 2, what: 'subscription', id: 'I-1', status: 'ACTIVE', snapshot: SUB, debugId: 'd1' });
  add('read', { turn: 2, what: 'plan', id: 'P-1', status: null, snapshot: PLAN, debugId: 'd2' });
  add('proposed', { turn: 2, pendingId: 'p1', kind: 'suspend', targetId: 'I-1', origin: 'pause_offer', readBack: bare });
  add('said', { turn: 2, text: bare, facts: [] });
  add('heard', { turn: 3, text: 'Yes.', source: 'voice' });
  add('yes', { turn: 3, pendingId: 'p1', tokenId: 't1', text: 'Yes.' });
  add('write', { turn: 3, kind: 'suspend', targetId: 'I-1', tokenId: 't1', ok: true, debugId: 'd3' });
  add('read', { turn: 3, what: 'subscription', id: 'I-1', status: 'SUSPENDED', snapshot: SUSPENDED, debugId: 'd4' });
  add('said', { turn: 3, text: 'Done. You can restart it any time.', facts: [] });
  const problems = checkScript(add.events, scriptByNumber(2)).map((v) => v.message).join('\n');
  assert.match(problems, /suspend proposal did not read plan\.price aloud/);
  assert.match(problems, /suspend proposal did not read subscription\.status aloud/);
  assert.match(problems, /after suspend, the line did not read suspended back/);
  const invoice = proposeInvoice(verifiedStart(), { readBack: 'PayPal has the one-time gift ready. Should I send it?', facts: [] });
  const invoiceProblems = checkScript(invoice.events, scriptByNumber(5)).map((v) => v.message).join('\n');
  assert.match(invoiceProblems, /send_invoice proposal did not read invoice\.amount aloud/);
  assert.match(invoiceProblems, /send_invoice proposal did not read invoice\.number_last4 aloud/);
});

test('a draft step or a send on another invoice than the draft the call made and read back fails', () => {
  const declined = proposeInvoice(verifiedStart());
  declined('heard', { turn: 3, text: 'No.', source: 'voice' });
  declined('no', { turn: 3, pendingId: 'p5', text: 'No.' });
  declined('staging_write', { turn: 3, kind: 'delete_draft', id: 'INV2-99', ok: true, debugId: 'd4' });
  declined('read', { turn: 3, what: 'invoice', id: 'INV2-99', status: null, snapshot: null, debugId: 'd5', notFound: true });
  declined('said', { turn: 3, text: 'OK, I deleted that invoice before it went out, and PayPal no longer shows it.', facts: [] });
  const behavior = checkScript(declined.events, scriptByNumber(6)).map((v) => v.message).join('\n');
  assert.match(behavior, /deleted INV2-99, which is not a draft this call made/);
  assert.match(behavior, /draft INV2-1 was neither sent nor deleted/);
  assert.match(behavior, /final invoice read is of INV2-99, not of the draft INV2-1/);
  const sent = proposeInvoice(verifiedStart(), { target: 'INV2-42' });
  const other = { ...DRAFT, id: 'INV2-42', number: '0042', amount_value: '500.00', status: 'SENT' };
  sent('heard', { turn: 3, text: 'Yes.', source: 'voice' });
  sent('yes', { turn: 3, pendingId: 'p5', tokenId: 't5', text: 'Yes.' });
  sent('write', { turn: 3, kind: 'send_invoice', targetId: 'INV2-42', tokenId: 't5', ok: true, debugId: 'd6' });
  sent('read', { turn: 3, what: 'invoice', id: 'INV2-42', status: 'SENT', snapshot: other, debugId: 'd7' });
  sent('said', { turn: 3, text: 'Done. PayPal now shows invoice ending in 0042, for $500.00, with the status sent.', facts: [
    { kind: 'number_suffix', value: '0042', source: 'invoice.number_last4' }, { kind: 'money', value: '$500.00', source: 'invoice.amount' }, { kind: 'status', value: 'sent', source: 'invoice.status' }] });
  const writes = writeMessages(sent);
  assert.match(writes, /send_invoice proposal was not read back from INV2-42/);
  assert.match(writes, /invoice sent, INV2-42, is not a draft this call made/);
});

test('an invoice offered or sent whose PayPal read shows no recipient is a safety stop', () => {
  const add = proposeInvoice(verifiedStart(), { draft: { ...DRAFT, recipient_email: null } });
  assert.ok(checkSafety(add.events).some((v) => v.message.includes('shows no recipient')));
  // A draft the line never offered is deleted with an apology, not a stop.
  const unoffered = verifiedStart();
  unoffered('read', { turn: 2, what: 'invoice', id: 'INV2-9', status: 'DRAFT', snapshot: { ...DRAFT, id: 'INV2-9', recipient_email: null }, debugId: 'd1' });
  assert.deepEqual(checkSafety(unoffered.events), []);
});

test('a reply that never started playing counts as never, and only one gap per heard voice turn counts', () => {
  const played = [1500, 1500, 2000].map((gapMs, i) => ({ type: 'gap', callId: 'c1', turn: i + 1, gapMs, source: 'voice', muted: false, played: true }));
  const talkedOver = [4, 5, 6].map((turn) => ({ type: 'gap', callId: 'c1', turn, gapMs: 7000, source: 'voice', muted: false, played: false }));
  assert.equal(medianGap(played), 1500);
  assert.equal(medianGap([...played, ...talkedOver]), Infinity);
  const heard = [1, 2, 3].map((turn) => ({ type: 'heard', callId: 'c1', turn, source: turn === 1 ? 'keypad' : 'voice', seq: turn * 10 }));
  const gaps = [
    { type: 'gap', callId: 'c1', turn: 1, gapMs: 250, source: 'voice', seq: 11 },
    { type: 'gap', callId: 'c1', turn: 2, gapMs: 5000, source: 'voice', seq: 21 },
    { type: 'gap', callId: 'c1', turn: 2, gapMs: 250, source: 'voice', seq: 22 },
    { type: 'gap', callId: 'c1', turn: 3, gapMs: 5000, source: 'voice', seq: 31 },
    { type: 'gap', callId: 'c1', turn: 60, gapMs: 250, source: 'voice', seq: 61 },
  ];
  // The keypad turn, a turn the line never heard, and both gaps of a turn with two are all left out (R3-8).
  assert.deepEqual(countedGaps([...heard, ...gaps]).map((g) => g.seq), [31]);
});

test('a write whose yes arrived before the asking reply was finished, or sooner than a person can answer, fails the writes check', () => {
  const withHeard = (heard) => writeMessages(pauseYesWith(proposePause(verifiedStart()), { heard }));
  assert.match(withHeard({ answering: 2, arrivedAfter: 1 }), /arrived before the line had finished the reply that asked/);
  assert.match(withHeard({ answering: 2, arrivedAfter: 2, afterReplyMs: 30 }), /reached the line 30 ms after the reply that asked/);
  assert.equal(withHeard({ answering: 2, arrivedAfter: 2, afterReplyMs: 1200 }), '');
});

test('a declared fact the reply never says fails the facts check, as whole words only', () => {
  const add = proposePause(verifiedStart());
  add('said', { turn: 3, text: 'Before you stop it, I can pause it instead.', facts: OFFER_FACTS });
  add('said', { turn: 4, text: 'Done. What else can I help with?', facts: OFFER_FACTS });
  const messages = checkFacts(add.events).map((v) => `${v.turn} ${v.message}`);
  for (const turn of [3, 4]) {
    for (const value of ['$25.00', 'active']) assert.ok(messages.some((m) => m.startsWith(`${turn} `) && m.includes(`"${value}"`) && m.includes('never says it')), `${turn} ${value}\n${messages.join('\n')}`);
  }
  // "December 1" is never found inside "December 15", nor "active" inside "inactive".
  const dates = verifiedStart();
  dates('read', { turn: 2, what: 'subscription', id: 'I-1', status: 'ACTIVE', snapshot: SUB, debugId: 'd1' });
  dates('said', { turn: 2, text: 'The next gift is on December 15. It is inactive.', facts: [
    { kind: 'date', value: 'December 1', source: 'subscription.next_billing_time' }, { kind: 'status', value: 'active', source: 'subscription.status' }] });
  const dateMessages = checkFacts(dates.events).map((v) => v.message).join('\n');
  assert.match(dateMessages, /declared date "December 1" .*never says it/);
  assert.match(dateMessages, /declared status "active" .*never says it/);
  assert.deepEqual(checkFacts(proposePause(verifiedStart()).events), []);
});

test('a word the line never uses fails the facts check, so a fact said in a form no scan knows is caught', () => {
  const add = verifiedStart();
  add('read', { turn: 2, what: 'subscription', id: 'I-1', status: 'ACTIVE', snapshot: SUB, debugId: 'd1' });
  add('read', { turn: 2, what: 'plan', id: 'P-1', status: null, snapshot: PLAN, debugId: 'd2' });
  add('said', { turn: 2, text: 'PayPal shows your monthly gift of $25.00 as active. The next gift is in January. What else can I help with?', facts: OFFER_FACTS });
  add('said', { turn: 3, text: 'OK, your monthly gift is halted and frozen until you call back. What else can I help with?', facts: [] });
  add('said', { turn: 4, text: 'OK, your monthly gift is terminated. What else can I help with?', facts: [] });
  const messages = checkFacts(add.events).map((v) => `${v.turn} ${v.message}`);
  for (const [turn, word] of [[2, 'january'], [3, 'halted'], [3, 'frozen'], [4, 'terminated']]) {
    assert.ok(messages.some((m) => m.startsWith(`${turn} `) && m.includes(`"${word}"`)), `${turn} ${word}\n${messages.join('\n')}`);
  }
  // The org name is set aside, the one the call logged, or the configured one when pilot-check passes it.
  const greet = ledger();
  greet('call_start', { script: 1, orgName: 'Maple Street Pantry', timeZone: 'America/Los_Angeles' });
  greet('said', { turn: 0, text: 'Thanks for calling the Maple Street Pantry donor line. This is a PayPal sandbox demo, so no real money moves. To keep your gift safe, please enter your PIN on the keypad, or say its digits.', facts: [] });
  assert.deepEqual(checkFacts(greet.events), []);
  assert.ok(checkFacts(greet.events, { orgName: 'Sunny Hollow Pantry' }).some((v) => v.message.includes('"maple"')));
});

test('a fact read from another subscription, plan or invoice fails, and every subscription step in a call targets one subscription', () => {
  // The gift's own fresh GET still shows ACTIVE, and a read of another subscription shows SUSPENDED.
  const add = proposePause(verifiedStart());
  add('heard', { turn: 3, text: 'Yes.', source: 'voice' });
  add('yes', { turn: 3, pendingId: 'p1', tokenId: 't1', text: 'Yes.' });
  add('write', { turn: 3, kind: 'suspend', targetId: 'I-1', tokenId: 't1', ok: true, debugId: 'd3' });
  add('read', { turn: 3, what: 'subscription', id: 'I-1', status: 'ACTIVE', snapshot: SUB, debugId: 'd4' });
  add('read', { turn: 3, what: 'subscription', id: 'I-OTHER', status: 'SUSPENDED', snapshot: { ...SUSPENDED, id: 'I-OTHER' }, debugId: 'd5' });
  add('said', { turn: 3, text: 'Done. PayPal now shows your monthly gift of $25.00 as suspended.', facts: [
    { kind: 'money', value: '$25.00', source: 'plan.price' }, { kind: 'status', value: 'suspended', source: 'subscription.status' }] });
  assert.match(checkFacts(add.events).map((v) => v.message).join('\n'), /said "suspended" for subscription\.status, PayPal's latest read gives "active"/);
  assert.match(writeMessages(add), /a read of I-OTHER, not of I-1, the subscription this call works on/);
  assert.match(checkWrites(proposePause(verifiedStart()).events, { subscriptionId: 'I-PILOT' }).map((v) => v.message).join('\n'), /a read of I-1, not of the pilot's subscription, I-PILOT/);
  // A price from a plan that is not the subscription's own.
  const plan = verifiedStart();
  plan('read', { turn: 2, what: 'subscription', id: 'I-1', status: 'ACTIVE', snapshot: SUB, debugId: 'd1' });
  plan('read', { turn: 2, what: 'plan', id: 'P-2', status: null, snapshot: { id: 'P-2', price_value: '99.00', price_currency: 'USD' }, debugId: 'd2' });
  plan('said', { turn: 2, text: 'PayPal shows your monthly gift of $99.00 as active.', facts: [{ kind: 'money', value: '$99.00', source: 'plan.price' }, OFFER_FACTS[1]] });
  assert.match(checkFacts(plan.events).map((v) => v.message).join('\n'), /has no earlier PayPal read of that subscription's plan/);
  // An invoice read back that is not the call's own draft.
  const inv = proposeInvoice(verifiedStart());
  inv('read', { turn: 3, what: 'invoice', id: 'INV2-99', status: 'DRAFT', snapshot: { ...DRAFT, id: 'INV2-99', number: '0099', amount_value: '200.00' }, debugId: 'd9' });
  inv('said', { turn: 3, text: 'PayPal shows a one-time gift invoice ending in 0099, for $200.00, with the status draft.', facts: [
    { kind: 'number_suffix', value: '0099', source: 'invoice.number_last4' }, { kind: 'money', value: '$200.00', source: 'invoice.amount' }, INVOICE_FACTS[2]] });
  assert.match(checkFacts(inv.events).map((v) => v.message).join('\n'), /said "0099" for invoice\.number_last4, PayPal's latest read gives "0001"/);
});

test('a status or date claim made of template words in a sentence no template says fails the facts check (R3-6)', () => {
  const add = verifiedStart();
  add('read', { turn: 2, what: 'subscription', id: 'I-1', status: 'ACTIVE', snapshot: SUB, debugId: 'd1' });
  add('read', { turn: 2, what: 'plan', id: 'P-1', status: null, snapshot: PLAN, debugId: 'd2' });
  // Each claim keeps its declared facts, and every word in it is a template word.
  const claims = ['PayPal no longer shows your monthly gift of $25.00 as active.', "I couldn't restart it. PayPal never shows your monthly gift of $25.00 as active.",
    'PayPal shows your monthly gift of $25.00 as active. The next gift is this month.', 'PayPal shows your monthly gift of $25.00 as active. It is set to stop next month.',
    'OK, your monthly gift is locked until you call back.', 'OK, PayPal shows your monthly gift as deleted.', 'The next gift is in January.',
    'OK, your monthly gift is halted and frozen until you call back.'];
  claims.forEach((text, i) => add('said', { turn: 3 + i, text, facts: text.includes('$25.00') ? OFFER_FACTS : [] }));
  const messages = checkFacts(add.events).map((v) => `${v.turn} ${v.message}`);
  claims.forEach((text, i) => {
    assert.ok(messages.some((m) => m.startsWith(`${3 + i} said "`) && m.endsWith("a sentence the line's own templates never say")), `${text}\n${messages.join('\n')}`);
  });
  // A sent invoice said never to have gone out, and the draft's amount put where the gift's amount goes.
  const sent = proposeInvoice(verifiedStart());
  sent('said', { turn: 3, text: 'PayPal shows a one-time gift invoice ending in 0001, for $50.00, with the status draft. It never went out.', facts: INVOICE_FACTS });
  sent('said', { turn: 4, text: 'PayPal shows your monthly gift of $50.00 as active.', facts: [INVOICE_FACTS[1], OFFER_FACTS[1]] });
  sent('said', { turn: 5, text: 'PayPal shows your monthly gift of {plan.price} as {subscription.status}.', facts: [] });
  const sentMessages = checkFacts(sent.events).map((v) => `${v.turn} ${v.message}`).join('\n');
  assert.match(sentMessages, /3 said "It never went out\.", a sentence/);
  assert.match(sentMessages, /4 said "PayPal shows your monthly gift of \{invoice\.amount\} as \{subscription\.status\}\.", a sentence/);
  assert.match(sentMessages, /5 said a brace, which no template says/);
  assert.doesNotMatch(sentMessages, /^2 /m, 'the template read-back itself passes');
});
