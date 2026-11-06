import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetIsGrounded, canonicalZone, goalCurrencyContext, groundedDelivery, numberWords, quantityIsGrounded, resolveLocalDelivery, sourceClauses, splitPermission, strictIsoInstant } from '../src/goal-grounding.js';
import { normalizeGoalDraft } from '../src/goal-intake.js';

const now = Date.parse('2026-11-05T20:00:00Z');
const goal = 'Buy 100 white cotton shirts under USD 800 total. Deliver 2026-11-13 at 5 PM Pacific. Use one supplier.';
const raw = () => ({ ready: true, quantity: 100, budgetCents: 80000, currency: 'USD', deadline: '2026-11-14T01:00:00.000Z',
  specification: 'white cotton shirts', allowSplit: false, clarification: '', assumptions: [],
  evidence: { quantity: '100 white cotton shirts', budget: 'USD 800 total', specification: 'white cotton shirts', delivery: '2026-11-13 at 5 PM Pacific', split: 'Use one supplier' },
  localDelivery: { date: '2026-11-13', time: '17:00', timeZone: 'America/Los_Angeles', offset: '' } });
const normalized = (input = raw(), text = goal, extra = {}) => normalizeGoalDraft(input, { goal: text, now, timeZone: 'America/Los_Angeles', ...extra });

test('local calendar resolver distinguishes unique instants, gaps, folds and explicit occurrences', () => {
  assert.deepEqual(resolveLocalDelivery({ date: '2026-11-13', time: '17:00:45.123', timeZone: 'America/Los_Angeles' }), {
    status: 'ok', instant: '2026-11-14T01:00:45.123Z', candidates: ['2026-11-14T01:00:45.123Z'] });
  assert.deepEqual(resolveLocalDelivery({ date: '2027-03-14', time: '02:30', timeZone: 'America/Los_Angeles' }), { status: 'gap', candidates: [] });
  const fold = { date: '2026-11-01', time: '01:30', timeZone: 'America/Los_Angeles' };
  assert.deepEqual(resolveLocalDelivery(fold), { status: 'fold', candidates: ['2026-11-01T08:30:00.000Z', '2026-11-01T09:30:00.000Z'] });
  assert.equal(resolveLocalDelivery({ ...fold, offset: '-08:00' }).instant, '2026-11-01T09:30:00.000Z');
  assert.equal(resolveLocalDelivery({ ...fold, offset: '-06:00' }).status, 'invalid');
  assert.equal(resolveLocalDelivery({ date: '2026-11-13', time: '17:00', timeZone: 'Asia/Kathmandu' }).instant, '2026-11-13T11:15:00.000Z');
});

test('calendar, ISO and timezone checks reject rollover and unsupported inputs', () => {
  for (const input of [{ date: '2027-02-30', time: '12:00', timeZone: 'UTC' }, { date: '2026-11-13', time: '25:00', timeZone: 'UTC' },
    { date: '2026-11-13', time: '12:00', timeZone: 'No/SuchZone' }, { date: '2026-11-13', time: '12:00' }]) assert.equal(resolveLocalDelivery(input).status, 'invalid');
  for (const value of ['2027-02-30T12:00:00Z', '2026-11-13T25:00:00Z', '2026-11-13T12:00:00+15:00', '2026-11-13T12:00:00']) assert.equal(strictIsoInstant(value), null);
  assert.equal(strictIsoInstant('2026-11-13T17:00:45.123-08:00'), '2026-11-14T01:00:45.123Z');
  assert.equal(canonicalZone(undefined), null);
});

test('numeric source checks support ordinary words and money but reject unrelated or malformed amounts', () => {
  assert.equal(numberWords('eight hundred'), 800); assert.equal(numberWords('two dozen'), 24);
  assert.equal(numberWords('1,200'), 1200); assert.ok(Number.isNaN(numberWords('1,20')));
  assert.equal(quantityIsGrounded(100, '100 white cotton shirts', [goal]), true);
  assert.equal(quantityIsGrounded(80, 'Actually make that 80 instead', [goal, 'Actually make that 80 instead']), true);
  assert.equal(quantityIsGrounded(100, 'quantity:100 shirts', [goal]), true);
  for (const evidence of ['$100 shirts budget', 'USD 100 for shirts', '100 dollars for shirts', '100.5 shirts', 'shirts 2026-11-13']) assert.equal(quantityIsGrounded(100, evidence, [goal]), false, evidence);
  for (const evidence of ['USD 800 total', 'eight hundred dollars', '$800, including shipping', 'budget 800 total']) assert.equal(budgetIsGrounded(80000, evidence), true, evidence);
  for (const evidence of ['$800.999 total', '$8,00 total', '$-800 total', 'EUR 800 total', '800 shirts']) assert.equal(budgetIsGrounded(80000, evidence), false, evidence);
  assert.equal(budgetIsGrounded(100, '$1.999 total'), false);
});

test('quantity grounding accepts bounded unfamiliar descriptors without treating other numeric roles as item counts', () => {
  for (const phrase of ['48 cobalt-blue lightweight woven-cotton shirts', 'forty-eight brushed satin-finish insulated bottles',
    '48 custom soft durable lined reversible washable reusable cobalt-blue bags', 'quantity: 48']) {
    assert.equal(quantityIsGrounded(48, phrase), true, phrase);
  }
  for (const [value, phrase] of [[2, '2 print colors on white cotton shirts'], [2, '2 logos on custom shirts'],
    [6, '6 boxes of white cotton shirts'], [24, '6 boxes of 24 shirts'], [2, '2 dozen cotton shirts'],
    [100, '100 percent recycled cotton shirts'], [48, 'SKU 48 cobalt-blue shirts'], [48, 'price 48 cotton shirts'],
    [13, 'November 13 lightweight shirts'], [48, '48 cotton shirts per box'],
    [48, '48 custom soft durable lined reversible washable reusable cobalt-blue lightweight shirts']]) {
    assert.equal(quantityIsGrounded(value, phrase), false, phrase);
  }
  const phrase = '48 cobalt-blue lightweight woven-cotton shirts', input = raw();
  input.quantity = 48; input.specification = 'cobalt-blue lightweight woven-cotton shirts';
  input.evidence.quantity = phrase; input.evidence.specification = input.specification;
  const result = normalized(input, goal.replace('100 white cotton shirts', phrase));
  assert.equal(result.ready, true); assert.equal(result.rfq.quantity, 48);
});

test('split permission respects surrounding negation, same-turn conflict and later explicit correction', () => {
  for (const phrase of ['Do not split.', "Don't split.", 'Don’t split.', 'No splits.', 'Use one supplier.', 'I am not allowing split orders across suppliers.',
    'We may not split across suppliers.', 'We cannot allow splitting.', 'You may not split the order.', "We can't permit splitting."]) assert.equal(splitPermission([phrase]), 'deny', phrase);
  for (const phrase of ['Split orders allowed.', 'Multiple suppliers are fine.', 'We may split across suppliers.', 'We can use multiple suppliers.']) assert.equal(splitPermission([phrase]), 'allow', phrase);
  assert.equal(splitPermission(['Compare quotes across suppliers.']), 'unspecified');
  assert.equal(splitPermission(['Do not split. Split orders allowed.']), 'conflict');
  assert.equal(splitPermission(['Do not split. Actually split orders are allowed.']), 'allow');
  assert.equal(splitPermission(['Split orders allowed.', 'Use one supplier.']), 'deny');
  assert.equal(splitPermission(['Do not split.', 'We may split across suppliers.']), 'allow');
});

test('only bounded exact clauses may be exposed as source evidence', () => {
  assert.deepEqual(sourceClauses('100 white cotton shirts\nUse one supplier', [goal]), ['100 white cotton shirts', 'Use one supplier']);
  assert.equal(sourceClauses('100 blue polyester shirts', [goal]), null);
  assert.equal(sourceClauses('a\na\na\na\na', ['a']), null);
  assert.equal(sourceClauses('a'.repeat(501), ['a'.repeat(501)]), null);
});

test('source-written ISO offsets remain explicit and need not match the organization default', () => {
  const local = { date: '2026-11-13', time: '17:00', timeZone: 'Asia/Kolkata', offset: '+05:30' };
  assert.deepEqual(groundedDelivery(local, '2026-11-13T17:00:00+05:30', ['Delivery 2026-11-13T17:00:00+05:30'], { now, timeZone: 'America/Los_Angeles' }), {
    status: 'ok', instant: '2026-11-13T11:30:00.000Z' });
  assert.deepEqual(groundedDelivery(local, '2026-11-13T17:00:00+05:30', ['Delivery 2026-11-13 at 5 PM UTC+05:30'], { now, timeZone: 'America/Los_Angeles' }), {
    status: 'ok', instant: '2026-11-13T11:30:00.000Z' });
  assert.equal(groundedDelivery({ date: '2026-11-13', time: '17:00', timeZone: 'America/Los_Angeles', offset: '-08:00' },
    '2026-11-13T17:00:00-08:00', ['2026-11-13T17:00:00-08:00 Pacific'], { now, timeZone: 'America/Los_Angeles' }).instant, '2026-11-14T01:00:00.000Z');
});

test('model-supplied daylight-saving offset cannot make a nonexistent local time ready', () => {
  const input = raw(); input.deadline = '2027-03-14T02:30:00-08:00'; input.localDelivery = { date: '2027-03-14', time: '02:30', timeZone: 'America/Los_Angeles', offset: '-08:00' };
  input.evidence.delivery = '2027-03-14 at 2:30 AM Pacific';
  const result = normalized(input, goal.replace('2026-11-13 at 5 PM Pacific', input.evidence.delivery));
  assert.equal(result.ready, false); assert.equal(result.rfq, null); assert.match(result.clarification, /does not exist/);
  assert.deepEqual(result.missingFields, ['delivery_time']);
});

test('a repeated clock time requires the buyer offset or occurrence instead of the model choice', () => {
  const input = raw(); input.deadline = '2026-11-01T01:30:00-07:00'; input.localDelivery = { date: '2026-11-01', time: '01:30', timeZone: 'America/Los_Angeles', offset: '-07:00' };
  input.evidence.delivery = '2026-11-01 at 1:30 AM Pacific';
  const text = goal.replace('2026-11-13 at 5 PM Pacific', input.evidence.delivery), extra = { now: Date.parse('2026-10-30T20:00:00Z') };
  assert.equal(normalized(input, text, extra).ready, false);
  for (const [word, instant] of [['first', '2026-11-01T08:30:00.000Z'], ['second', '2026-11-01T09:30:00.000Z']]) {
    input.localDelivery.offset = ''; input.deadline = instant; input.evidence.delivery = `2026-11-01 at 1:30 AM Pacific, ${word} occurrence`;
    const result = normalized(input, text.replace('2026-11-01 at 1:30 AM Pacific', input.evidence.delivery), extra);
    assert.equal(result.ready, true, word); assert.equal(result.rfq.deadline, instant);
  }
});

test('organization reference zone is explicit and named source zones must agree', () => {
  const input = raw(); input.localDelivery.timeZone = 'Asia/Tokyo'; input.deadline = '2026-11-13T08:00:00Z'; input.evidence.delivery = '2026-11-13 at 5 PM';
  const result = normalized(input, goal.replace('2026-11-13 at 5 PM Pacific', input.evidence.delivery), { timeZone: 'Asia/Tokyo' });
  assert.equal(result.ready, true); assert.equal(result.reference.timeZone, 'Asia/Tokyo');
  input.evidence.delivery = '2026-11-13 at 5 PM Pacific';
  const mismatch = normalized(input, goal);
  assert.equal(mismatch.ready, false); assert.deepEqual(mismatch.missingFields, ['time_zone']);
});

test('ambiguous zone abbreviations and invented date-only times require clarification', () => {
  for (const abbreviation of ['CST', 'IST']) {
    const input = raw(); input.evidence.delivery = '2026-11-13 at 5 PM ' + abbreviation;
    const result = normalized(input, goal.replace('2026-11-13 at 5 PM Pacific', input.evidence.delivery));
    assert.equal(result.ready, false); assert.deepEqual(result.missingFields, ['time_zone']);
  }
  const input = raw(); input.evidence.delivery = 'Deliver 2026-11-13';
  const result = normalized(input, goal.replace('Deliver 2026-11-13 at 5 PM Pacific', input.evidence.delivery));
  assert.equal(result.ready, false); assert.deepEqual(result.missingFields, ['delivery_time']);
});

test('selected goods clauses cannot contain invented material or an uncited paraphrase', () => {
  const input = raw(); input.specification = 'white cotton shirts with navy print';
  const result = normalized(input);
  assert.equal(result.ready, false); assert.ok(result.missingFields.includes('specification'));
  input.evidence.specification = 'white polyester shirts'; input.specification = input.evidence.specification;
  assert.equal(normalized(input).ready, false);
});

test('split conflicts or source-disagreeing evidence cannot acquire ready status', () => {
  const input = raw(); input.evidence.split = 'Use one supplier';
  const result = normalized(input, goal + ' Split orders allowed.');
  assert.equal(result.ready, false); assert.deepEqual(result.missingFields, ['split_policy']);
});

test('quantity roles exclude print colors and budget roles exclude historic vendor quotes', () => {
  const text = goal.replace('100 white cotton shirts', '100 white cotton shirts with 2 print colors');
  const quantity = raw(); quantity.quantity = 2; quantity.evidence.quantity = '100 white cotton shirts with 2 print colors';
  assert.equal(normalized(quantity, text).ready, false);
  assert.equal(quantityIsGrounded(2, quantity.evidence.quantity, [text]), false);
  assert.equal(quantityIsGrounded(100, quantity.evidence.quantity, [text]), true);
  const historic = 'Previous vendor quote was $900';
  const budget = raw(); budget.budgetCents = 90000; budget.evidence.budget = historic;
  assert.equal(normalized(budget, historic + '. ' + goal).ready, false);
  assert.equal(budgetIsGrounded(90000, historic, [historic + '. ' + goal]), false);
  assert.equal(normalized(raw(), historic + '. ' + goal).ready, true);
});

test('latest explicit field corrections invalidate older citations without losing other limits', () => {
  const changedQuantity = 'Actually make that 80 shirts instead.';
  const stale = raw();
  const rejected = normalized(stale, changedQuantity, { priorGoals: [goal] });
  assert.equal(rejected.ready, false); assert.ok(rejected.missingFields.includes('quantity'));
  const corrected = raw(); corrected.quantity = 80; corrected.evidence.quantity = '80 shirts';
  const accepted = normalized(corrected, changedQuantity, { priorGoals: [goal] });
  assert.equal(accepted.ready, true); assert.equal(accepted.rfq.quantity, 80); assert.equal(accepted.rfq.budgetCents, 80000);
  const changedBudget = 'Actually the final budget is USD 700.';
  assert.equal(normalized(raw(), changedBudget, { priorGoals: [goal] }).ready, false);
  const budget = raw(); budget.budgetCents = 70000; budget.evidence.budget = 'final budget is USD 700';
  assert.equal(normalized(budget, changedBudget, { priorGoals: [goal] }).ready, true);
  const timeReply = raw(); timeReply.evidence.delivery = 'Deliver 2026-11-13\n5 PM Pacific';
  const previous = goal.replace('Deliver 2026-11-13 at 5 PM Pacific', 'Deliver 2026-11-13');
  assert.equal(normalized(timeReply, '5 PM Pacific', { priorGoals: [previous] }).ready, true);
});

test('modal split denials cannot be overridden by a positive model flag', () => {
  for (const denial of ['We may not split across suppliers', 'We cannot allow splitting', 'I am not allowing split orders across suppliers']) {
    const input = raw(); input.allowSplit = true; input.evidence.split = denial;
    const text = goal.replace('Use one supplier', denial);
    assert.equal(normalized(input, text).ready, false, denial);
    input.allowSplit = false;
    assert.equal(normalized(input, text).ready, true, denial);
  }
});

test('written calendar years and this-week weekday anchors cannot move into a later year or week', () => {
  const input = raw(); input.evidence.delivery = 'November 13, 2025 at 5 PM Pacific';
  assert.equal(normalized(input, goal.replace('2026-11-13 at 5 PM Pacific', input.evidence.delivery)).ready, false);
  input.evidence.delivery = 'this Friday at 5 PM Pacific';
  const text = goal.replace('2026-11-13 at 5 PM Pacific', input.evidence.delivery);
  assert.equal(normalized(input, text).ready, false);
  input.localDelivery.date = '2026-11-06'; input.deadline = '2026-11-07T01:00:00.000Z';
  assert.equal(normalized(input, text).ready, true);
  input.evidence.delivery = 'next Friday at 5 PM Pacific';
  assert.equal(normalized(input, goal.replace('2026-11-13 at 5 PM Pacific', input.evidence.delivery)).ready, true);
  input.evidence.delivery = 'Friday next week at 5 PM Pacific';
  input.localDelivery.date = '2026-11-13'; input.deadline = '2026-11-14T01:00:00.000Z';
  assert.equal(normalized(input, goal.replace('2026-11-13 at 5 PM Pacific', input.evidence.delivery)).ready, true);
});

test('written standard offsets bind even when the model leaves its offset field blank', () => {
  for (const source of ['June 15, 2027 at 5 PM PST', '2027-06-15T17:00:00-08:00 Pacific']) {
    const local = { date: '2027-06-15', time: '17:00', timeZone: 'America/Los_Angeles', offset: '' };
    assert.notEqual(groundedDelivery(local, '2027-06-16T00:00:00.000Z', [source], { now, timeZone: 'America/Los_Angeles' }).status, 'ok', source);
  }
  assert.equal(groundedDelivery({ date: '2027-06-15', time: '17:00', timeZone: 'America/Los_Angeles', offset: '' },
    '2027-06-16T00:00:00.000Z', ['June 15, 2027 at 5 PM PDT'], { now, timeZone: 'America/Los_Angeles' }).status, 'ok');
  assert.equal(groundedDelivery({ date: '2026-11-13', time: '17:00', timeZone: 'America/Los_Angeles', offset: '' },
    '2026-11-14T01:00:00.000Z', ['November 13, 2026 at 5 PM PST'], { now, timeZone: 'America/Los_Angeles' }).status, 'ok');
});

test('fold occurrence, numeric offsets and abbreviation evidence must all agree', () => {
  const reference = { now: Date.parse('2026-10-30T20:00:00Z'), timeZone: 'America/Los_Angeles' };
  const local = { date: '2026-11-01', time: '01:30', timeZone: 'America/Los_Angeles', offset: '-08:00' };
  for (const source of ['2026-11-01 at 1:30 AM Pacific, first occurrence, UTC-08:00',
    '2026-11-01 at 1:30 AM Pacific, UTC-07:00 or UTC-08:00', '2026-11-01 at 1:30 AM Pacific, first occurrence and second occurrence']) {
    assert.notEqual(groundedDelivery(local, '2026-11-01T09:30:00.000Z', [source], reference).status, 'ok', source);
    assert.notEqual(groundedDelivery({ ...local, offset: '' }, '2026-11-01T09:30:00.000Z', [source], reference).status, 'ok', source);
  }
  assert.equal(groundedDelivery(local, '2026-11-01T09:30:00.000Z', ['2026-11-01 at 1:30 AM Pacific, second occurrence, UTC-08:00'], reference).status, 'ok');
});

test('latest budget corrections bind amount and active currency including bare labeled amounts', () => {
  for (const correction of ['Actually change the budget to EUR 800 total.', 'Actually change the budget to 800 euros.', 'Actually change the budget to CHF 800.', 'Actually change the budget to 700.']) {
    const result = normalized(raw(), correction, { priorGoals: [goal] });
    assert.equal(result.ready, false, correction); assert.ok(result.missingFields.includes('budget'));
  }
  const corrected = raw(); corrected.budgetCents = 70000; corrected.evidence.budget = 'budget to 700'; corrected.assumptions = ['currency_usd'];
  const result = normalized(corrected, 'Actually change the budget to 700.', { priorGoals: [goal] });
  assert.equal(result.ready, true); assert.equal(result.rfq.budgetCents, 70000);
  assert.equal(result.assumptions.includes('currency_usd'), false, 'explicit USD context is retained across a bare-amount correction');
  const croppedCurrency = raw(); croppedCurrency.evidence.budget = '800 total';
  assert.equal(normalized(croppedCurrency, 'Actually change the budget to EUR 800 total.', { priorGoals: [goal] }).ready, false);
  const dollarDefault = goal.replace('USD 800', '$800');
  assert.equal(normalized(corrected, 'Actually change the budget to 700.', { priorGoals: [dollarDefault] }).assumptions.includes('currency_usd'), true);
});

test('a new explicit USD budget supersedes earlier unsupported currency without using historic quote units', () => {
  const earlier = goal.replace('USD 800', 'EUR 800'), input = raw();
  input.budgetCents = 70000; input.evidence.budget = 'budget to USD 700';
  const result = normalized(input, 'Actually change the budget to USD 700.', { priorGoals: [earlier] });
  assert.equal(result.ready, true); assert.equal(result.rfq.budgetCents, 70000); assert.equal(result.assumptions.includes('currency_usd'), false);
  assert.deepEqual(goalCurrencyContext([goal + ' A previous vendor quote was EUR 900.']), { currency: 'USD', explicit: true });
});

test('latest delivery date and clock changes cannot be supported exclusively by older clauses', () => {
  const correction = 'Actually deliver 2026-11-20 at 5 PM Pacific instead.';
  assert.equal(normalized(raw(), correction, { priorGoals: [goal] }).ready, false);
  const correct = raw(); correct.localDelivery.date = '2026-11-20'; correct.deadline = '2026-11-21T01:00:00.000Z';
  correct.evidence.delivery = '2026-11-20 at 5 PM Pacific';
  assert.equal(normalized(correct, correction, { priorGoals: [goal] }).ready, true);
  const clockCorrection = 'Actually change the delivery time to 6 PM Pacific.';
  assert.equal(normalized(raw(), clockCorrection, { priorGoals: [goal] }).ready, false);
  const clock = raw(); clock.localDelivery.time = '18:00'; clock.deadline = '2026-11-14T02:00:00.000Z';
  clock.evidence.delivery = '2026-11-13\n6 PM Pacific';
  assert.equal(normalized(clock, clockCorrection, { priorGoals: [goal] }).ready, true);
});

test('latest goods replacements invalidate stale or positively retained replaced material', () => {
  const prior = goal.replace('white cotton shirts', 'white cotton shirts with navy print');
  const old = raw(); old.specification = 'white cotton shirts with navy print'; old.evidence.specification = old.specification;
  const correction = 'Actually use blue print instead of navy print.';
  assert.equal(normalized(old, correction, { priorGoals: [prior] }).ready, false);
  const correct = raw(); correct.specification = 'white cotton shirts blue print'; correct.evidence.specification = 'white cotton shirts\nblue print';
  assert.equal(normalized(correct, correction, { priorGoals: [prior] }).ready, true);
  const stillOld = raw(); stillOld.specification = 'white cotton shirts navy print'; stillOld.evidence.specification = 'white cotton shirts\nnavy print';
  assert.equal(normalized(stillOld, correction, { priorGoals: [prior] }).ready, false, 'citing the new turn\'s negated old material cannot retain it positively');
});

test('a split-only correction does not overwrite quantity, money or delivery context', () => {
  const input = raw(); input.evidence.split = 'We may not split across suppliers';
  const result = normalized(input, 'Actually, we may not split across suppliers.', { priorGoals: [goal] });
  assert.equal(result.ready, false, 'source quotes remain exact and case-sensitive');
  input.evidence.split = 'we may not split across suppliers';
  const accepted = normalized(input, 'Actually, we may not split across suppliers.', { priorGoals: [goal] });
  assert.equal(accepted.ready, true); assert.equal(accepted.rfq.quantity, 100); assert.equal(accepted.rfq.budgetCents, 80000);
});

test('an unrelated correction cannot choose between equal amounts in conflicting currencies', () => {
  const text = 'Buy 100 white cotton shirts. Actually keep one supplier. Budget EUR 800 or USD 800 total. Deliver 2026-11-13 at 5 PM Pacific. Use one supplier.';
  const input = raw(); input.evidence.budget = 'USD 800 total';
  const result = normalized(input, text);
  assert.equal(result.ready, false); assert.ok(result.missingFields.includes('budget'));
  assert.equal(goalCurrencyContext([text]).currency, 'conflict');
});

test('an unknown explicit currency cannot be masked by an untagged total candidate', () => {
  for (const unit of ['CHF', 'chf']) {
    const input = raw(); input.evidence.budget = '800';
    const text = `Actually change the budget to ${unit} 800 total.`;
    const result = normalized(input, text, { priorGoals: [goal] });
    assert.equal(result.ready, false, unit); assert.ok(result.missingFields.includes('budget'));
    assert.equal(goalCurrencyContext([goal, text]).currency, 'CHF');
  }
});

test('negated or ambiguous clocks cannot justify retaining the earlier delivery time', () => {
  const text = 'Actually change delivery time to 6 PM, not 5 PM Pacific.';
  const input = raw(); input.evidence.delivery = '2026-11-13\n6 PM, not 5 PM Pacific';
  const result = normalized(input, text, { priorGoals: [goal] });
  assert.equal(result.ready, false); assert.ok(result.missingFields.includes('delivery_time'));
  input.localDelivery.time = '18:00'; input.deadline = '2026-11-14T02:00:00.000Z';
  assert.equal(normalized(input, text, { priorGoals: [goal] }).ready, true);
  const ambiguous = 'Actually change delivery time to 6 PM or 5 PM Pacific.';
  input.evidence.delivery = '2026-11-13\n6 PM or 5 PM Pacific';
  assert.equal(normalized(input, ambiguous, { priorGoals: [goal] }).ready, false);
});

test('a not-at clock denial without a replacement must clarify rather than retain the denied time', () => {
  const input = raw(); input.evidence.delivery = '2026-11-13\nnot at 5 PM Pacific';
  const result = normalized(input, 'Actually delivery is not at 5 PM Pacific.', { priorGoals: [goal] });
  assert.equal(result.ready, false); assert.ok(result.missingFields.includes('delivery_time'));
  input.evidence.delivery = '2026-11-13\nat 6 PM, not at 5 PM Pacific';
  const corrected = 'Actually delivery is at 6 PM, not at 5 PM Pacific.';
  assert.equal(normalized(input, corrected, { priorGoals: [goal] }).ready, false);
  input.localDelivery.time = '18:00'; input.deadline = '2026-11-14T02:00:00.000Z';
  assert.equal(normalized(input, corrected, { priorGoals: [goal] }).ready, true);
});
