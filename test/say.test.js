import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as say from '../src/say.js';

const SUB = { id: 'I-1', status: 'ACTIVE', plan_id: 'P-1', next_billing_time: '2026-12-01T10:00:00Z', subscriber_email: 'sb-maria@personal.example.com', subscriber_given_name: 'Maria' };
const PLAN = { id: 'P-1', price_value: '25', price_currency: 'USD' };
const INV = { id: 'INV2-1', status: 'DRAFT', number: '0007', amount_value: '50.00', amount_currency: 'USD', recipient_email: 'sb-maria@personal.example.com', recipient_view_url: 'https://example.invalid/x' };
const BANNED = /[;\u2014]|\b(leverage|tapestry|foster|delve|seamless|robust|game-changer|cutting-edge)\b/i;

test('money is formatted in en-US with two decimals whatever PayPal echoes', () => {
  assert.equal(say.formatMoney('25'), '$25.00');
  assert.equal(say.formatMoney('25.0'), '$25.00');
  assert.equal(say.formatMoney('50.00', 'USD'), '$50.00');
  assert.equal(say.formatMoney('1234.5', 'USD'), '$1,234.50');
  assert.equal(say.formatMoney(null), null);
  assert.equal(say.formatMoney('abc'), null);
});

test('dates are spoken as month and day in the configured time zone', () => {
  assert.equal(say.formatDate('2026-12-01T10:00:00Z', 'America/Los_Angeles'), 'December 1');
  assert.equal(say.formatDate('2026-12-01T05:00:00Z', 'America/Los_Angeles'), 'November 30');
  assert.equal(say.formatDate('not a date'), null);
});

test('the masked email has no digits and reads dots as words', () => {
  assert.equal(say.maskEmail('sb-maria@personal.example.com'), 's b at personal dot example dot com');
  const masked = say.maskEmail('42jo@mail2.example.com');
  assert.doesNotMatch(masked, /\d/);
  assert.equal(masked, 'four two at mail two dot example dot com');
  assert.equal(say.maskEmail('no-at-sign'), null);
});

test('the empathy filter keeps plain kindness and drops anything that could carry a fact', () => {
  assert.equal(say.filterEmpathy('I understand, thank you for calling'), 'I understand, thank you for calling.');
  assert.equal(say.filterEmpathy('That makes sense.'), 'That makes sense.');
  const dropped = [
    'Your gift is 25 now.', 'That is $ well spent.', 'Twenty more minutes.', 'See you in December.', 'Talk on Monday.',
    'Write to me at a@b.co.', 'reach me at gmail dot com', 'It is active again.', 'It is paid.', 'It is unpaid.',
    'Your gift is cancelled.', 'Sure; done.', 'Sure \u2014 done.', 'I paused it for you.',
    'I hear you, \uFF12\uFF15 is a lot.', 'Of course, \u0662\u0665 each month adds up.', 'All done, it is taken care of.',
    'It is off now, nothing more is taken.', 'Done, your gift is inactive now.', 'I ended it for you.', 'Half a grand is generous.',
    'Done, it went out to bob at gmail.', 'You are all set.',
    'one two three four five six seven eight nine ten eleven twelve thirteen',
    'okay okay okay okay okay okay okay okay okay okay okay okay okay',
  ];
  for (const text of dropped) assert.equal(say.filterEmpathy(text), '', text);
  assert.equal(say.filterEmpathy(null), '');
});

test('the empathy the line speaks is only ever one of its own fixed phrases', () => {
  assert.equal(say.empathyPhrase('sorry'), "I'm sorry to hear that.");
  assert.equal(say.empathyPhrase('none'), '');
  for (const key of ['Done, I cancelled it.', 'constructor', '', null, undefined, 42]) assert.equal(say.empathyPhrase(key), '', String(key));
  for (const phrase of Object.values(say.EMPATHY_PHRASES).filter(Boolean)) assert.equal(say.filterEmpathy(phrase), phrase);
});

test('extractSpokenFacts finds amounts and dates said in words, and digits from any script', () => {
  assert.deepEqual(say.extractSpokenFacts('Your gift is twenty five dollars, and the next one is on the first of December.'),
    [{ kind: 'money', value: '$25.00' }, { kind: 'date', value: 'December 1' }]);
  assert.deepEqual(say.extractSpokenFacts('It is a hundred dollars on December twenty first.'),
    [{ kind: 'money', value: '$100.00' }, { kind: 'date', value: 'December 21' }]);
  assert.deepEqual(say.extractSpokenFacts('Your gift is \uFF12\uFF15 dollars.'), [{ kind: 'number', value: '\uFF12\uFF15' }]);
  assert.deepEqual(say.extractSpokenFacts('That PIN did not match. You have two tries left. I need your PIN first.'), []);
  assert.deepEqual(say.extractSpokenFacts('It may take a minute to update. I can set up a one-time gift.'), []);
});

test('extractSpokenFacts finds money, dates, suffixes, status words and stray digits', () => {
  const found = say.extractSpokenFacts('PayPal shows your monthly gift of $25.00 as active. The next gift is on December 1.');
  assert.deepEqual(found, [{ kind: 'money', value: '$25.00' }, { kind: 'date', value: 'December 1' }, { kind: 'status', value: 'active' }]);
  assert.deepEqual(say.extractSpokenFacts('invoice ending in 0001 with the status unpaid'), [{ kind: 'number_suffix', value: '0001' }, { kind: 'status', value: 'unpaid' }]);
  assert.deepEqual(say.extractSpokenFacts('Call 555 1234 today.'), [{ kind: 'number', value: '555' }, { kind: 'number', value: '1234' }]);
  assert.deepEqual(say.extractSpokenFacts('PayPal is great.'), []);
});

test('builders declare every spoken fact with its PayPal source', () => {
  const status = say.giftStatus(SUB, PLAN, { timeZone: 'America/Los_Angeles' });
  assert.equal(status.text, 'PayPal shows your monthly gift of $25.00 as active. The next gift is on December 1. What else can I help with?');
  assert.deepEqual(status.facts.map((f) => f.source), ['plan.price', 'subscription.status', 'subscription.next_billing_time']);
  const suspended = say.giftStatus({ ...SUB, status: 'SUSPENDED' }, PLAN, { timeZone: 'America/Los_Angeles' });
  assert.doesNotMatch(suspended.text, /December/);
  const offer = say.pauseOffer(SUB, PLAN);
  assert.match(offer.text, /Would you like me to pause it\? Please say yes or no\.$/);
  const invoice = say.invoiceConfirm(INV, 'Sunny Hollow Pantry');
  assert.match(invoice.text, /ending in 0007, for \$50\.00, with the status draft/);
  assert.match(invoice.text, /s b at personal dot example dot com/);
  assert.match(invoice.text, /never asks you to call a number/);
  assert.deepEqual(invoice.facts.map((f) => f.source).sort(), ['invoice.amount', 'invoice.number_last4', 'invoice.recipient_email', 'invoice.status']);
});

test('afterWrite says what PayPal shows now, and never claims a change PayPal did not return', () => {
  const done = say.afterWrite('suspend', { ...SUB, status: 'SUSPENDED' }, PLAN);
  assert.match(done.text, /^Done\. PayPal now shows your monthly gift of \$25\.00 as suspended\./);
  const stale = say.afterWrite('suspend', SUB, PLAN);
  assert.match(stale.text, /I asked PayPal to pause it\. PayPal now shows your monthly gift of \$25\.00 as active\./);
  assert.doesNotMatch(stale.text, /suspended/);
  const failed = say.afterWrite('cancel', SUB, PLAN, { ok: false });
  assert.match(failed.text, /didn't accept that change/);
  const unknown = say.afterWrite('activate', null, PLAN);
  assert.doesNotMatch(unknown.text, /active/);
});

test('limits and tries are spoken as words, never digits', () => {
  assert.equal(say.numberToWords(500), 'five hundred');
  assert.equal(say.numberToWords(25), 'twenty five');
  assert.match(say.amountOutOfRange(1, 500).text, /from one dollar to five hundred dollars/);
  assert.match(say.pinBad(2).text, /two tries left/);
  assert.match(say.pinBad(1).text, /one try left/);
  assert.doesNotMatch(say.amountOutOfRange(1, 500).text, /\d/);
});

test('every template follows the voice rules', () => {
  const texts = [
    say.greeting('Sunny Hollow Pantry'), say.askPin(), say.pinOk(), say.pinBad(2), say.pinLocked(),
    say.giftStatus(SUB, PLAN, { timeZone: 'America/Los_Angeles' }), say.pauseOffer(SUB, PLAN), say.cancelConfirm(SUB, PLAN),
    say.resumeConfirm({ ...SUB, status: 'SUSPENDED' }, PLAN), say.pauseConfirm(SUB, PLAN), say.invoiceConfirm(INV, 'Sunny Hollow Pantry'),
    say.afterWrite('send_invoice', { ...INV, status: 'SENT' }, null), say.nothingTo('activate', SUB, PLAN), say.declined('cancel'),
    say.draftDeleted(true), say.draftDeleted(false), say.otherEmail(), say.help(), say.goodbye(), say.unclear(), say.notVerified(),
    say.noSubscription(), say.noEmail(), say.amountOutOfRange(1, 500), say.nothingPending(), say.callEnded(), say.staffCallback(),
    say.paypalProblem(), say.tooLong(), say.turnLimit(), say.expiredNotice(), say.noPause(), say.setAside(), say.pinLimit(),
    ...Object.values(say.EMPATHY_PHRASES).map((text) => ({ text })),
  ].map((p) => p.text);
  for (const text of texts) assert.doesNotMatch(text, BANNED, text);
  for (const text of texts.slice(0, 5)) assert.doesNotMatch(text, /\d/, text);
  // Templates that carry no PayPal read must not say anything the facts check reads as a fact.
  for (const p of [say.setAside(), say.pinLimit(), say.nothingPending(), say.callEnded(), say.goodbye(), say.help(), say.unclear()]) {
    assert.deepEqual(say.extractSpokenFacts(p.text), [], p.text);
  }
});
