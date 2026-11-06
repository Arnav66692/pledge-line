import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetIsGrounded, canonicalZone, goalCurrencyContext, groundedDelivery, hasUnknownZoneReference, numberWords, quantityIsGrounded, resolveLocalDelivery, sourceClauses, splitPermission, splitPolicy, strictIsoInstant } from '../src/goal-grounding.js';
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

test('paper-size descriptors do not hide an explicit item count or manufacture one', () => {
  for (const size of ['A0', 'A3', 'A10', 'B4', 'C5']) assert.equal(quantityIsGrounded(144, `144 ${size} matte paper posters`), true, size);
  for (const phrase of ['Size A3 posters', 'A3 matte paper posters', 'SKU 144 A3 posters', '13-inch posters']) {
    assert.equal(quantityIsGrounded(144, phrase), false, phrase);
    assert.equal(quantityIsGrounded(3, phrase), false, phrase);
  }
});

test('an edit to one field retains unchanged limits and their original source quotes', () => {
  const input = raw(); input.quantity = 76; input.evidence.quantity = '76 shirts';
  const update = 'Change the count to 76 shirts; retain the same white cotton shirts, total ceiling, supplier policy and deadline.';
  const result = normalized(input, update, { priorGoals: [goal] });
  assert.equal(result.ready, true); assert.equal(result.rfq.quantity, 76);
  assert.equal(result.rfq.budgetCents, 80000); assert.equal(result.rfq.deadline, raw().deadline);
  assert.equal(result.rfq.specification, 'white cotton shirts');
  const noBudgetChange = normalized(input, 'Do not change the budget; change the count to 76 shirts.', { priorGoals: [goal] });
  assert.equal(noBudgetChange.ready, true);
  const newFeature = normalized(input, 'Change the count to 76 shirts and keep blue artwork.', { priorGoals: [goal] });
  assert.equal(newFeature.ready, false); assert.ok(newFeature.missingFields.includes('specification'));
  for (const update of ['Please change the budget.', 'Replace the budget.', 'Change the quantity.']) {
    const missing = normalized(raw(), update, { priorGoals: [goal] });
    assert.equal(missing.ready, false, update);
    assert.ok(missing.missingFields.includes(/quantity/.test(update) ? 'quantity' : 'budget'), update);
  }
});

test('current numeric restatements can prove retained values but cannot revive superseded limits', () => {
  const input = raw(); input.evidence.quantity = 'Keep 100 shirts'; input.budgetCents = 95000; input.evidence.budget = 'cap to USD 950';
  const update = 'Keep 100 shirts and raise the cap to USD 950.';
  const retained = normalized(input, update, { priorGoals: [goal] });
  assert.equal(retained.ready, true); assert.equal(retained.rfq.quantity, 100); assert.equal(retained.rfq.budgetCents, 95000);
  const sameBudget = raw(); sameBudget.quantity = 64; sameBudget.evidence.quantity = '64 shirts'; sameBudget.evidence.budget = 'keep the USD 800 budget';
  const retainedBudget = normalized(sameBudget, 'Change the count to 64 shirts; keep the USD 800 budget.', { priorGoals: [goal] });
  assert.equal(retainedBudget.ready, true); assert.equal(retainedBudget.rfq.budgetCents, 80000);
  const stale = raw(); stale.evidence.quantity = '100 white cotton shirts';
  assert.equal(normalized(stale, 'Change the count to 64 shirts.', { priorGoals: [goal] }).ready, false);
  const earlierProof = raw(); earlierProof.quantity = 64; earlierProof.evidence.quantity = '64 shirts';
  assert.equal(normalized(earlierProof, 'Actually change the count to 70 shirts.', {
    priorGoals: [goal, 'Change the count to 64 shirts.'] }).ready, false);
});

test('current-order earmarks are budgets while unrelated reserves and the program fund are not', () => {
  const globalOnly = 'The organization has USD 15000 program budget. Buy 60 burgundy fleece blankets. Deliver 2026-11-13 at 5 PM Pacific. Use one supplier.';
  assert.equal(budgetIsGrounded(1500000, 'USD 15000 program budget', [globalOnly]), false);
  assert.equal(budgetIsGrounded(1500000, 'program budget is 15000', [globalOnly.replace('USD 15000 program budget', 'program budget is 15000')]), false);
  const allocatedFund = globalOnly.replace('USD 15000 program budget', 'USD 15000 program budget allocated for this order');
  assert.equal(budgetIsGrounded(1500000, 'USD 15000 program budget allocated for this order', [allocatedFund]), true);
  for (const allocation of ['USD 2100 is earmarked for these blankets all in', 'The amount earmarked for these blankets is USD 2100 all in',
    'USD 2100 is reserved for this order all in']) {
    const text = `The organization has USD 15000 program budget. ${allocation}. USD 500 is reserved for travel. Buy 60 burgundy fleece blankets. Deliver 2026-11-13 at 5 PM Pacific. Use one supplier.`;
    assert.equal(budgetIsGrounded(210000, allocation, [text]), true, allocation);
    assert.equal(budgetIsGrounded(1500000, 'USD 15000 program budget', [text]), false);
    assert.equal(budgetIsGrounded(50000, 'USD 500 is reserved for travel', [text]), false);
    const final = `${text} Actually the final cap is USD 1900.`;
    assert.equal(budgetIsGrounded(210000, allocation, [final]), false);
    assert.equal(budgetIsGrounded(190000, 'final cap is USD 1900', [final]), true);
  }
  const incomplete = normalized(raw(), 'Keep the count unchanged and revise the budget.', { priorGoals: [goal] });
  assert.equal(incomplete.ready, false); assert.ok(incomplete.missingFields.includes('budget'));
});

test('qualified global funds do not compete with a current purchase allocation', () => {
  for (const scope of ['overall event', 'overall annual operating', 'organization-wide project', 'company-wide quarterly']) {
    for (const funds of [`${scope} budget is USD 24000`, `${scope} budget is 24000`]) {
      const allocation = 'USD 1680 is allocated for these jackets all in';
      const text = `Our ${funds}. ${allocation}. Buy 48 navy fleece jackets.`;
      assert.equal(budgetIsGrounded(168000, allocation, [text]), true, text);
      assert.equal(budgetIsGrounded(2400000, funds, [text]), false, text);
      assert.equal(budgetIsGrounded(2400000, funds, [`Our ${funds}. Buy 48 navy fleece jackets.`]), false, text);
    }
  }
  const specificallyAllocated = 'USD 24000 overall event budget allocated for this order';
  assert.equal(budgetIsGrounded(2400000, specificallyAllocated), true);
});

test('a replace-with budget update inherits the stated currency and refuses stale money', () => {
  const update = 'Replace the all-in cap with 2,750 and retain the same goods, count, delivery deadline and supplier policy.';
  assert.equal(normalized(raw(), update, { priorGoals: [goal] }).ready, false);
  const input = raw(); input.budgetCents = 275000; input.evidence.budget = 'cap with 2,750';
  const result = normalized(input, update, { priorGoals: [goal] });
  assert.equal(result.ready, true); assert.equal(result.rfq.budgetCents, 275000);
  assert.ok(!result.assumptions.includes('currency_usd'));
});

test('shared, divided and distributed supplier permissions retain denial and conditional safeguards', () => {
  for (const phrase of ['The order may be shared among suppliers', 'We can divide across vendors', 'The order may be distributed between multiple suppliers']) {
    assert.equal(splitPermission([phrase]), 'allow', phrase);
    const input = raw(); input.allowSplit = true;
    const result = normalized(input, goal.replace('Use one supplier', phrase));
    assert.equal(result.ready, true, phrase); assert.equal(result.rfq.allowSplit, true);
    assert.equal(result.sourceEvidence.split, phrase);
  }
  for (const phrase of ['The order may not be shared among suppliers', "We don't allow the order to be divided across vendors", 'The order must not be distributed between suppliers']) {
    assert.equal(splitPermission([phrase]), 'deny', phrase);
    const input = raw(); input.allowSplit = true;
    assert.equal(normalized(input, goal.replace('Use one supplier', phrase)).ready, false);
  }
  for (const phrase of ['The order may be shared among suppliers only if I confirm', 'The order can be divided across vendors after buyer approval']) {
    assert.equal(splitPermission([phrase]), 'conflict', phrase);
  }
  assert.equal(splitPermission(['The order was shared among suppliers']), 'unspecified');
});

test('supplier-subject order permissions preserve provenance without granting information sharing', () => {
  for (const phrase of ['Several suppliers may share the order', 'A few vendors can split this purchase',
    'Different suppliers may divide this order', 'Two or more vendors can distribute the purchase', 'Multiple vendors may share this order']) {
    assert.equal(splitPermission([phrase]), 'allow', phrase);
    const input = raw(); input.allowSplit = true;
    const accepted = normalized(input, goal.replace('Use one supplier', phrase));
    assert.equal(accepted.ready, true, phrase); assert.equal(accepted.rfq.allowSplit, true);
    assert.equal(accepted.sourceEvidence.split, phrase);
    input.allowSplit = false;
    assert.equal(normalized(input, goal.replace('Use one supplier', phrase)).ready, false, 'Flag disagreement still asks.');
  }
  for (const phrase of ['Several suppliers may not share the order', "A few vendors don't split this purchase",
    'Different suppliers cannot divide the order', 'No multiple vendors may distribute the purchase']) {
    assert.equal(splitPermission([phrase]), 'deny', phrase);
    const input = raw(); input.allowSplit = true;
    assert.equal(normalized(input, goal.replace('Use one supplier', phrase)).ready, false, phrase);
    input.allowSplit = false;
    const denied = normalized(input, goal.replace('Use one supplier', phrase));
    assert.equal(denied.ready, true, phrase); assert.equal(denied.rfq.allowSplit, false);
  }
  for (const phrase of ['Several suppliers may share the order if I confirm', 'Different vendors can divide this order after buyer approval']) {
    assert.equal(splitPermission([phrase]), 'conflict', phrase);
  }
  for (const phrase of ['Several suppliers may share quotes', 'Multiple vendors can share pricing information',
    "Different suppliers may share the order's details", 'A few vendors can split the quote', 'Several suppliers may split the order price']) {
    assert.equal(splitPermission([phrase]), 'unspecified', phrase);
    const input = raw(); input.allowSplit = true;
    assert.equal(normalized(input, goal.replace('Use one supplier', phrase)).ready, false, phrase);
  }
});

test('fulfillment, object-bearing distribution and acceptable supplier policies preserve their boundaries', () => {
  for (const phrase of ['Multiple vendors may fulfill this purchase', 'Different suppliers can fulfil the order',
    'We may divide this order among suppliers', 'We can distribute the purchase between several vendors',
    'More than one vendor is acceptable', 'Splitting the order is acceptable']) {
    assert.equal(splitPermission([phrase]), 'allow', phrase);
    const input = raw(); input.allowSplit = true;
    const result = normalized(input, goal.replace('Use one supplier', phrase));
    assert.equal(result.ready, true, phrase); assert.equal(result.sourceEvidence.split, phrase);
  }
  for (const phrase of ['Multiple vendors may not fulfill this purchase', 'Different suppliers cannot fulfil the order',
    'We may not divide this order among suppliers', 'We must not distribute the purchase between several vendors',
    'More than one vendor is not acceptable', 'Multiple suppliers are unacceptable', 'Splitting the order is not acceptable']) {
    assert.equal(splitPermission([phrase]), 'deny', phrase);
  }
  for (const phrase of ['Multiple vendors may fulfill this purchase if I confirm', 'We can divide this order among suppliers after buyer approval',
    'More than one vendor is acceptable unless I refuse']) assert.equal(splitPermission([phrase]), 'conflict', phrase);
  for (const phrase of ["Multiple vendors may fulfill this purchase's specifications", 'Different suppliers can fulfill the order details',
    'We may divide this order information among suppliers', 'We can distribute the purchase pricing between several vendors']) {
    assert.equal(splitPermission([phrase]), 'unspecified', phrase);
  }
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

test('split policy distinguishes comparative supplier permission from single-source limits and returns exact provenance', () => {
  for (const phrase of ['More than one supplier is allowed', 'Multiple vendors are fine', 'We may use several vendors']) {
    assert.deepEqual(splitPolicy([phrase + '.']), { permission: 'allow', source: phrase, turnIndex: 0 }, phrase);
  }
  for (const phrase of ['Use a single supplier', 'Use one vendor', 'No more than one supplier is allowed',
    'Not more than one vendor is permitted', 'Multiple vendors are not allowed', 'No multiple vendors are allowed',
    "We don't allow multiple vendors", 'We dont allow multiple vendors', 'We don’t permit several suppliers']) {
    assert.deepEqual(splitPolicy([phrase + '.']), { permission: 'deny', source: phrase, turnIndex: 0 }, phrase);
  }
  for (const phrase of ['Use one vendor. Multiple vendors are allowed.', 'Split only if the buyer confirms',
    'Multiple suppliers are allowed when delivery is late', 'Split unless shipping costs more',
    'We can split after buyer approval', 'We may use multiple vendors before buyer confirmation', 'Splitting is allowed until I consent']) {
    assert.equal(splitPolicy([phrase]).permission, 'conflict', phrase);
  }
  assert.deepEqual(splitPolicy(['More than one supplier is allowed.', 'Actually use a single vendor.']), {
    permission: 'deny', source: 'Actually use a single vendor', turnIndex: 1 });
  assert.deepEqual(splitPolicy(['Compare vendor quotes.']), { permission: 'unspecified', source: '', turnIndex: null });
  assert.deepEqual(splitPolicy(['Don’t split across vendors.']), { permission: 'deny', source: 'Don’t split across vendors', turnIndex: 0 });
  assert.equal(splitPolicy(['x'.repeat(501) + ' Use one supplier.']).source, '', 'An overlong source clause cannot exceed the evidence bound.');
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

test('goods specification comes only from validated source clauses and ignores the duplicated model summary', () => {
  const input = raw(); input.specification = 'white cotton shirts with navy print';
  const result = normalized(input);
  assert.equal(result.ready, true); assert.equal(result.rfq.specification, 'white cotton shirts');
  assert.doesNotMatch(result.rfq.specification, /navy/);
  input.specification = 'Invented titanium mugs with free shipping and embroidery';
  assert.equal(normalized(input).rfq.specification, 'white cotton shirts');
  input.evidence.specification = 'white polyester shirts'; input.specification = input.evidence.specification;
  assert.equal(normalized(input).ready, false);
  input.evidence.specification = 'shirts';
  assert.equal(normalized(input).ready, false, 'The canonical source goods description must still be at least8characters.');
});

test('known matching supplier policy uses server source provenance rather than a duplicate model citation', () => {
  const input = raw(); input.quantity = 72; input.specification = 'Seventy-two mugs';
  input.evidence.quantity = '72 ceramic mugs'; input.evidence.specification = 'ceramic mugs'; input.evidence.split = 'single';
  const text = goal.replace('100 white cotton shirts', '72 ceramic mugs').replace('Use one supplier', 'Use a single supplier');
  const single = normalized(input, text);
  assert.equal(single.ready, true); assert.equal(single.rfq.allowSplit, false);
  assert.equal(single.sourceEvidence.split, 'Use a single supplier');
  assert.equal(single.rfq.specification, 'ceramic mugs');
  assert.ok(!single.assumptions.includes('single_supplier_default'));
  input.evidence.split = 'Invented model policy is never source evidence';
  const canonical = normalized(input, text);
  assert.equal(canonical.ready, true); assert.equal(canonical.sourceEvidence.split, 'Use a single supplier');
  assert.doesNotMatch(JSON.stringify(canonical), /Invented model policy/);
  const mismatch = normalized(input, text.replace('Use a single supplier', 'More than one supplier is allowed'));
  assert.equal(mismatch.ready, false); assert.ok(mismatch.missingFields.includes('split_policy'));
  input.allowSplit = true; input.evidence.split = '';
  const multiple = normalized(input, text.replace('Use a single supplier', 'More than one supplier is allowed'));
  assert.equal(multiple.ready, true); assert.equal(multiple.rfq.allowSplit, true);
  assert.equal(multiple.sourceEvidence.split, 'More than one supplier is allowed');
  const denied = normalized(input, text.replace('Use a single supplier', 'No more than one supplier is allowed'));
  assert.equal(denied.ready, false); assert.ok(denied.missingFields.includes('split_policy'));
  const conditional = normalized(input, text.replace('Use a single supplier', 'Multiple suppliers are allowed only if I confirm'));
  assert.equal(conditional.ready, false); assert.ok(conditional.missingFields.includes('split_policy'));
  const needsApproval = normalized(input, text.replace('Use a single supplier', 'We can split after buyer approval'));
  assert.equal(needsApproval.ready, false); assert.ok(needsApproval.missingFields.includes('split_policy'));
  const contractedDenial = normalized(input, text.replace('Use a single supplier', "We don't allow multiple vendors"));
  assert.equal(contractedDenial.ready, false); assert.ok(contractedDenial.missingFields.includes('split_policy'));
  input.allowSplit = false;
  const canonicalDenial = normalized(input, text.replace('Use a single supplier', "We don't allow multiple vendors"));
  assert.equal(canonicalDenial.ready, true); assert.equal(canonicalDenial.rfq.allowSplit, false);
  assert.equal(canonicalDenial.sourceEvidence.split, "We don't allow multiple vendors");
  input.allowSplit = true;
  const unknown = normalized(input, text.replace('Use a single supplier', 'Compare supplier quotes'));
  assert.equal(unknown.ready, false); assert.ok(unknown.missingFields.includes('split_policy'));
  input.allowSplit = false;
  const defaulted = normalized(input, text.replace('Use a single supplier', 'Compare supplier quotes'));
  assert.equal(defaulted.ready, true); assert.equal(defaulted.rfq.allowSplit, false);
  assert.equal(defaulted.sourceEvidence.split, ''); assert.ok(defaulted.assumptions.includes('single_supplier_default'));
});

test('conflicting buyer split policies cannot acquire ready status', () => {
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
  assert.equal(result.ready, true); assert.equal(result.sourceEvidence.split, 'Actually, we may not split across suppliers');
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


test('explicit purchase counts ground catalog-free nouns while retaining numeric-role boundaries', () => {
  for (const goods of ['ivory linen serviettes', 'ceramic ramekins', 'steel ladles', 'bamboo document trays', 'pairs of wool mittens', 'reusable storage boxes', 'cardboard storage boxes supplied flat']) {
    const order = `Please order 73 ${goods} under USD 950 total. Deliver November 21, 2026 at 3 PM Pacific.`;
    assert.equal(quantityIsGrounded(73, `73 ${goods}`, [order]), true, goods);
  }
  for (const phrase of ['Buy 3 print colors for linen serviettes', 'Order 8 packs of 12 ceramic ramekins',
    'Order 73 ceramic ramekins per carton', 'Order SKU 73 ceramic ramekins', 'Order 73-inch document trays',
    'Buy 73 ceramic ramekins or 82 ceramic ramekins', 'Buy 73 ceramic ramekins, deliver at 5 PM Pacific',
    'Previous invoice shows 73 ceramic ramekins', 'Do not order 73 ceramic ramekins', 'The old order was 73 ceramic ramekins']) {
    const candidate = /deliver at/.test(phrase) ? 5 : 73;
    assert.equal(quantityIsGrounded(candidate, phrase), false, phrase);
  }
  assert.equal(quantityIsGrounded(73, 'Buy 73 ceramic ramekins at 5 PM Pacific'), true);
  const historic = 'The historical invoice shows 146 mugs; this event needs 73 plain mugs under USD 950 total.';
  assert.equal(quantityIsGrounded(73, '73 plain mugs', [historic]), true);
  assert.equal(quantityIsGrounded(146, '146 mugs', [historic]), false);
  const revision = 'Use 81 for the quantity instead.';
  assert.equal(quantityIsGrounded(81, revision, [historic, revision]), true);
  assert.equal(quantityIsGrounded(73, '73 plain mugs', [historic, revision]), false);
});

test('a later cited clock replaces the old clock while retaining its buyer-provided date', () => {
  const input = raw(), update = 'Deliver at 2 PM Pacific instead; keep the date and every other limit.';
  input.deadline = '2026-11-13T22:00:00.000Z'; input.localDelivery.time = '14:00';
  input.evidence.delivery += '\nat 2 PM Pacific';
  const result = normalized(input, update, { priorGoals: [goal] });
  assert.equal(result.ready, true); assert.equal(result.rfq.deadline, input.deadline);
  const stale = normalized(raw(), update, { priorGoals: [goal] });
  assert.equal(stale.ready, false); assert.ok(stale.missingFields.includes('delivery_time'));
});


test('quantity roles retain modal and setting negations, historic document scope and financial units', () => {
  const denied = ['We should not buy 67 ceramic ramekins', 'We shall not order 67 ceramic ramekins',
    'We will not order 67 ceramic ramekins', 'We shouldn’t order 67 ceramic ramekins', 'We won’t order 67 ceramic ramekins',
    'Do not use 67 for the quantity', 'Never use 67 for quantity', 'Do not set quantity 67'];
  for (const text of denied) assert.equal(quantityIsGrounded(67, text), false, text);
  for (const noun of ['ceramic ramekins', 'mugs']) {
    const text = `The previous invoice was for an order of 67 ${noun}. Our budget is USD 920. Deliver November 23, 2026 at 3 PM Pacific. Use one supplier.`;
    assert.equal(quantityIsGrounded(67, `67 ${noun}`, [text]), false, noun);
  }
  for (const unit of ['cents', 'euros', 'pounds', 'credits']) {
    const text = `I need 67 ${unit} for parking. Buy ivory linen serviettes under USD 920 total. Deliver November 23, 2026 at 3 PM Pacific.`;
    assert.equal(quantityIsGrounded(67, `67 ${unit}`, [text]), false, unit);
  }
  assert.equal(quantityIsGrounded(67, 'Use 67 for the quantity instead'), true);
  assert.equal(quantityIsGrounded(67, 'Keep quantity 67'), true);
});


test('supplier policy is not an item count and short citations retain the same bounded purchase identity', () => {
  const text = 'Buy 84 felt coasters dyed sapphire. Use one supplier only.';
  assert.equal(quantityIsGrounded(84, '84 felt coasters', [text]), true);
  assert.equal(quantityIsGrounded(1, 'Use one supplier only', [text]), false);
  const made = 'Buy 84 felt coasters made from wool. Use one vendor only.';
  assert.equal(quantityIsGrounded(84, '84 felt coasters', [made]), true);
  for (const evidence of ['USD 84', 'SKU 84 felt coasters', '84 centimeters', '8 felt coasters']) {
    assert.equal(quantityIsGrounded(84, evidence, [text, `Ignore historical ${evidence}.`]), false, evidence);
  }
});

test('replacement orders and bounded count-plus-goods replies inherit only actual buyer context', () => {
  const prior = 'Buy 84 felt coasters under USD 920 total. Deliver November 23, 2026 at 3 PM Pacific.';
  const update = 'The smaller trial replaces that order: 19 felt coasters.';
  assert.equal(quantityIsGrounded(19, '19 felt coasters', [prior, update]), true);
  assert.equal(quantityIsGrounded(84, '84 felt coasters', [prior, update]), false);
  for (const text of ['Do not replace that order: 19 felt coasters.', 'The historical invoice replaced that order: 19 felt coasters.']) {
    assert.equal(quantityIsGrounded(19, '19 felt coasters', [prior, text]), false, text);
  }
  const incomplete = 'Buy felt coasters under USD 920 total. Deliver November 23, 2026 at 3 PM Pacific.';
  const answer = '19 felt coasters, please';
  assert.equal(quantityIsGrounded(19, answer, [incomplete, answer]), true);
  assert.equal(quantityIsGrounded(19, answer), false);
  for (const text of ['19 cents, please', '19 days, please', 'SKU 19 felt coasters', '19 felt coasters per carton', '19 packs of 7 felt coasters']) {
    assert.equal(quantityIsGrounded(19, text, [incomplete, text]), false, text);
  }
});

test('explicit city-time names use runtime IANA zones without inferring a location from other text', () => {
  const input = raw(), text = goal.replace('Pacific', 'Vienna time');
  input.evidence.delivery = input.evidence.delivery.replace('Pacific', 'Vienna time');
  input.localDelivery.timeZone = 'Europe/Vienna'; input.deadline = '2026-11-13T16:00:00.000Z';
  const result = normalized(input, text);
  assert.equal(result.ready, true); assert.equal(result.rfq.deadline, input.deadline);
  const conflict = raw(); conflict.evidence.delivery = '2026-11-13 at 5 PM Vienna time and Lisbon time';
  conflict.localDelivery.timeZone = 'Europe/Vienna'; conflict.deadline = input.deadline;
  const refused = normalized(conflict, goal.replace('2026-11-13 at 5 PM Pacific', conflict.evidence.delivery));
  assert.equal(refused.ready, false); assert.ok(refused.missingFields.includes('time_zone'));
  const invented = structuredClone(input); invented.evidence.delivery = '2026-11-13 at 5 PM Avalon time';
  assert.equal(normalized(invented, goal.replace('2026-11-13 at 5 PM Pacific', invented.evidence.delivery)).ready, false);
});


test('unknown explicit city-time references cannot fall through to the organization clock or a matching offset', () => {
  assert.equal(hasUnknownZoneReference('Buy black/white cotton shirts from https://example.com/catalog. Deliver at local time.'), false);
  assert.equal(hasUnknownZoneReference('Deliver in Europe/Avalon.'), true);
  for (const label of ['Avalon time', 'time zone: Avalon', 'timezone is Avalon', 'Pacific time and Avalon time', 'Avalon time UTC-08:00']) {
    const input = raw(), text = goal.replace('Pacific', label);
    input.evidence.delivery = input.evidence.delivery.replace('Pacific', label);
    const result = normalized(input, text);
    assert.equal(result.ready, false, label); assert.ok(result.missingFields.includes('time_zone'), label);
  }
  const omitted = raw(), text = goal.replace('Pacific', 'Pacific time and Avalon time');
  omitted.evidence.delivery = '2026-11-13 at 5 PM Pacific';
  assert.equal(normalized(omitted, text).ready, false, 'Citing only the recognized alias cannot hide another explicit unknown name.');
  for (const label of ['local time', 'organization time', "organization's time", 'configured timezone', 'delivery time', 'timezone America/Los_Angeles', 'timezone UTC-08:00']) {
    const input = raw(); input.evidence.delivery = input.evidence.delivery.replace('Pacific', label);
    const result = normalized(input, goal.replace('Pacific', label));
    assert.equal(result.ready, true, label); assert.equal(result.rfq.deadline, raw().deadline);
  }
});


test('unknown IANA references are case-insensitive and an explicit later zone correction can recover', () => {
  for (const label of ['europe/Avalon', 'europe/avalon']) {
    const input = raw(); input.evidence.delivery = input.evidence.delivery.replace('Pacific', label);
    const result = normalized(input, goal.replace('Pacific', label));
    assert.equal(result.ready, false, label); assert.ok(result.missingFields.includes('time_zone'), label);
  }
  const prior = goal.replace('Pacific', 'Avalon time');
  for (const [reply, citation] of [['Use Pacific time instead.', 'Pacific time'],
    ['Use organization timezone instead.', 'Use organization timezone instead.']]) {
    const input = raw(); input.evidence.delivery = `2026-11-13 at 5 PM\n${citation}`;
    const result = normalized(input, reply, { priorGoals: [prior] });
    assert.equal(result.ready, true, reply); assert.equal(result.rfq.deadline, raw().deadline);
    assert.equal(result.rfq.quantity, 100); assert.equal(result.rfq.budgetCents, 80000);
  }
  const omitted = raw(); omitted.evidence.delivery = '2026-11-13 at 5 PM';
  assert.equal(normalized(omitted, 'Use Pacific time instead.', { priorGoals: [prior] }).ready, false);
  for (const reply of ['Use same timezone instead.', 'Use Pacific time and Avalon time instead.']) {
    const input = raw(); input.evidence.delivery = `2026-11-13 at 5 PM\n${reply}`;
    const result = normalized(input, reply, { priorGoals: [prior] });
    assert.equal(result.ready, false, reply); assert.ok(result.missingFields.includes('time_zone'), reply);
  }
});


test('denied zone choices remain unresolved and cannot clear an earlier unknown policy', () => {
  const prior = goal.replace('Pacific', 'Avalon time');
  for (const reply of ['Do not use Pacific time.', 'Never use Pacific time.', 'We shouldn’t use Pacific time.',
    'Use Pacific time, not Eastern time.', 'Use Pacific time; Eastern time is not allowed.']) {
    const input = raw(); input.evidence.delivery = `2026-11-13 at 5 PM\n${reply}`;
    const result = normalized(input, reply, { priorGoals: [prior] });
    assert.equal(result.ready, false, reply); assert.ok(result.missingFields.includes('time_zone'), reply);
  }
  const positive = raw(); positive.evidence.delivery = '2026-11-13 at 5 PM\nPacific time';
  assert.equal(normalized(positive, 'Use Pacific time instead.', { priorGoals: [prior] }).ready, true);
  const noGoodsConfusion = raw(), text = goal.replace('white cotton shirts', 'white cotton shirts, no embroidery');
  noGoodsConfusion.specification = 'white cotton shirts, no embroidery'; noGoodsConfusion.evidence.specification = noGoodsConfusion.specification;
  assert.equal(normalized(noGoodsConfusion, text).ready, true);
});
