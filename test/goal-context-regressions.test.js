import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetIsGrounded, explicitCityClockZones, groundedDelivery, hasUnknownZoneReference, latestDeliveryZonePolicy, latestSourceIssues, projectSpecification, quantityIsGrounded, splitPermission } from '../src/goal-grounding.js';
import { normalizeGoalDraft } from '../src/goal-intake.js';

const now = Date.parse('2026-11-05T20:00:00Z'), timeZone = 'America/Los_Angeles';

test('complete purchase settings and current order assertions ground counts without granting authority', () => {
  const prior = 'Buy 43 felt desk mats. Budget USD 300.';
  for (const reply of ['Make the purchase 57 mats in total.', 'Lock the quantity at 57.']) {
    assert.equal(quantityIsGrounded(57, reply, [prior, reply]), true, reply);
    const denied = 'Do not ' + reply.toLowerCase();
    assert.equal(quantityIsGrounded(57, denied, [prior, denied]), false, denied);
  }
  for (const label of ['new purchase', 'current order', 'approved order']) {
    const text = `The ${label} is 23 rechargeable LED floor lamps.`;
    assert.equal(quantityIsGrounded(23, text, [text]), true, text);
    assert.equal(quantityIsGrounded(23, text, [`The previous invoice says: ${text}`]), false, text);
  }
  const discarded = 'Ignore the discarded draft that says "90 trays for $400." The approved order is 23 steel mixing trays, 3 liters each.';
  assert.equal(quantityIsGrounded(23, 'The approved order is 23 steel mixing trays, 3 liters each', [discarded]), true);
  assert.equal(quantityIsGrounded(90, '90 trays', [discarded]), false);
});

test('explicit final totals resolve deltas and alternatives without arithmetic', () => {
  const prior = 'Order 31 wash kits. Budget USD 300.';
  const total = 'Add nine kits, making 40 kits total.';
  assert.equal(quantityIsGrounded(40, total, [prior, total]), true);
  assert.equal(quantityIsGrounded(9, 'nine kits', [prior, total]), false);
  assert.equal(quantityIsGrounded(40, '40 kits', [prior, 'Add nine kits.']), false);
  assert.equal(quantityIsGrounded(31, '31 wash kits', [prior, 'Add nine kits.']), false);
  for (const reply of ['Do not add nine kits.', 'Add nine dollars to the budget. Final cap USD 270.', 'Add nine to the budget. Final cap USD 309.']) {
    assert.equal(quantityIsGrounded(31, '31 wash kits', [prior, reply]), true, reply);
  }
  const choice = 'We need either 74 or 96 woven lanyards; that count is not final.';
  assert.equal(quantityIsGrounded(96, '96 woven lanyards', [choice]), false);
  assert.equal(quantityIsGrounded(74, 'Lock the quantity at 74.', [choice, 'Lock the quantity at 74.']), true);
  const corrected = 'Add nine kits, making 40 kits total. Actually lock the quantity at 41.';
  assert.equal(quantityIsGrounded(41, 'lock the quantity at 41', [prior, corrected]), true);
  assert.equal(quantityIsGrounded(40, '40 kits', [prior, corrected]), false);
  const settled = 'We need either 74 or 96 woven lanyards. Actually lock the quantity at 74.';
  assert.equal(quantityIsGrounded(74, 'lock the quantity at 74', [settled]), true);
});

test('declared package contents establish the purchased package unit without multiplying', () => {
  const text = 'Order 31 packs of graphite pencils, with 14 pencils per pack. Budget USD 300.';
  assert.equal(quantityIsGrounded(31, 'Order 31 packs of graphite pencils', [text]), true);
  assert.equal(quantityIsGrounded(14, '14 pencils', [text]), false);
  assert.equal(quantityIsGrounded(434, '434 pencils', [text]), false);
  const historical = 'An old invoice lists 31 packs of graphite pencils. ' + text;
  assert.equal(quantityIsGrounded(31, 'An old invoice lists 31 packs of graphite pencils', [historical]), false, 'A same-valued historical occurrence cannot borrow the current source candidate.');
  for (const text of ['Buy 6 boxes of white cotton shirts.', 'Order 31 packs of 14 graphite pencils.', 'Do not order 31 packs of graphite pencils, with 14 pencils per pack.']) {
    assert.equal(quantityIsGrounded(31, text, [text]), false, text);
  }
});

test('physical-property units cannot compete with the actual count and current all-goods restatements can cite it', () => {
  const text = 'Order 23 stainless steel jugs, 3 liters each.';
  assert.equal(quantityIsGrounded(23, text, [text]), true);
  assert.equal(quantityIsGrounded(3, '3 liters', [text]), false);
  const prior = 'Buy 33 replacement cartridges matching our previous order.';
  const reply = 'Use ZX-51 printer cartridges with black pigment ink. This is the specification for all 33 cartridges.';
  assert.equal(quantityIsGrounded(33, 'This is the specification for all 33 cartridges', [prior, reply]), true);
  assert.equal(quantityIsGrounded(33, '33 cartridges', ['This is the specification for all 33 cartridges.']), false);
});

test('original unfamiliar specification citations use their own affirmative buying context', () => {
  const original = 'Please source 680 mL stainless steel lunch boxes with a total budget of USD 320. The quantity is undecided.';
  const reply = 'Set the delivery deadline to 2026-11-23 at 3 PM Pacific. Keep the quantity, budget and lunch-box specification from above.';
  const evidence = { quantity: '', budget: 'USD 320', specification: '680 mL stainless steel lunch boxes', delivery: '2026-11-23 at 3 PM Pacific', split: '' };
  const issues = latestSourceIssues(evidence, [original, reply], evidence.specification, { date: '2026-11-23', time: '15:00', timeZone, offset: '' });
  assert.ok(!issues.missingFields.includes('specification'));
  for (const context of ['Do not source', 'Historical invoice: source', 'Our source has']) {
    const text = `${context} 680 mL stainless steel lunch boxes. Quantity is undecided.`;
    const bad = latestSourceIssues(evidence, [text, reply], evidence.specification);
    assert.ok(bad.missingFields.includes('specification'), context);
  }
  const changed = latestSourceIssues(evidence, [original, 'Use titanium closures instead.'], evidence.specification);
  assert.ok(changed.missingFields.includes('specification'));
});

test('an original specification citation must retain the principal purchased item, not only its property', () => {
  const goal = 'Buy 31 cotton shirts with titanium closures. Budget USD 300. Deliver 2026-11-23 at 3 PM Pacific. Use one supplier.';
  const draft = { ready: true, quantity: 31, budgetCents: 30000, currency: 'USD', deadline: '2026-11-23T23:00:00Z', specification: 'titanium closures', allowSplit: false,
    clarification: '', assumptions: [], evidence: { quantity: '31 cotton shirts', budget: 'USD 300', specification: 'titanium closures', delivery: '2026-11-23 at 3 PM Pacific', split: 'Use one supplier' },
    localDelivery: { date: '2026-11-23', time: '15:00', timeZone, offset: '' } };
  const refused = normalizeGoalDraft(draft, { goal, now, timeZone });
  assert.equal(refused.ready, false); assert.ok(refused.missingFields.includes('specification'));
  draft.evidence.specification = 'cotton shirts with titanium closures';
  const accepted = normalizeGoalDraft(draft, { goal, now, timeZone });
  assert.equal(accepted.ready, true); assert.match(accepted.rfq.specification, /shirts/);
});

test('currency replacement is verified in its complete source clause even when the quote is cropped', () => {
  const prior = 'Buy 31 cotton shirts. Budget EUR 500.';
  const reply = 'Replace that euro amount with a total budget of USD 472.';
  assert.equal(budgetIsGrounded(47200, reply, [prior, reply]), true);
  assert.equal(budgetIsGrounded(47200, 'euro amount with a total budget of USD 472', [prior, reply]), true);
  for (const prefix of ['Do not ', 'If approved, ']) {
    const denied = prefix + reply.toLowerCase();
    assert.equal(budgetIsGrounded(47200, 'euro amount with a total budget of USD 472', [prior, denied]), false, denied);
  }
  const retain = 'Budget USD 472 total; do not ignore EUR 400 total cap.';
  assert.equal(budgetIsGrounded(47200, 'ignore EUR 400 total cap', [retain]), false);
  const historical = 'A previous quote was EUR 400. Final budget USD 472 total.';
  assert.equal(budgetIsGrounded(47200, 'USD 472 total', [historical]), true);
  const suffix = 'Budget USD 472 total and EUR 400; the EUR 400 cap must not be ignored.';
  assert.equal(budgetIsGrounded(47200, suffix, [suffix]), false);
  const rejectedReplacement = 'Replace that euro amount with a total budget of USD 472, but do not use that replacement.';
  assert.equal(budgetIsGrounded(47200, 'euro amount with a total budget of USD 472', [prior, rejectedReplacement]), false);
});

test('valid unambiguous IANA city aliases resolve without guessing unknown cities', () => {
  for (const [name, zone, instant] of [['Kathmandu', 'Asia/Kathmandu', '2026-11-23T09:15:00.000Z'], ['Kolkata', 'Asia/Kolkata', '2026-11-23T09:30:00.000Z']]) {
    const source = `Deliver 2026-11-23 at 3 PM ${name} time.`;
    assert.equal(hasUnknownZoneReference(source), false, name); assert.equal(explicitCityClockZones(source).length, 1, name);
    const local = { date: '2026-11-23', time: '15:00', timeZone: zone, offset: '' };
    assert.equal(groundedDelivery(local, instant, [source], { now, timeZone: 'UTC', turns: [source] }).status, 'ok', name);
  }
  assert.equal(hasUnknownZoneReference('Deliver at 3 PM Avalon time.'), true);
  assert.equal(hasUnknownZoneReference('Use europe/Avalon timezone.'), true);
});

test('validated city-alias spans also enforce prefix and suffix denials until an explicit positive correction', () => {
  for (const [name, zone, deadline] of [['Kathmandu', 'Asia/Kathmandu', '2026-11-23T09:15:00Z'], ['Kolkata', 'Asia/Kolkata', '2026-11-23T09:30:00Z']]) {
    const source = `Buy 31 white cotton shirts. Budget USD 230 total. Deliver 2026-11-23 at 3 PM ${name} time. Use one supplier.`;
    const draft = { ready: true, quantity: 31, budgetCents: 23000, currency: 'USD', deadline, specification: 'white cotton shirts', allowSplit: false,
      clarification: '', assumptions: [], evidence: { quantity: '31 white cotton shirts', budget: 'USD 230 total', specification: 'white cotton shirts',
        delivery: `2026-11-23 at 3 PM ${name} time`, split: 'Use one supplier' }, localDelivery: { date: '2026-11-23', time: '15:00', timeZone: zone, offset: '' } };
    for (const denial of [`Do not use ${name} time.`, `${name} time is not allowed.`]) {
      const policy = latestDeliveryZonePolicy([source, denial]);
      assert.equal(policy.denied, true, denial); assert.equal(policy.unresolved, true, denial);
      const refused = normalizeGoalDraft(draft, { goal: denial, priorGoals: [source], now, timeZone: zone });
      assert.equal(refused.ready, false, denial); assert.ok(refused.missingFields.includes('time_zone'), denial);
      const correction = `Use ${name} time instead.`, corrected = structuredClone(draft);
      corrected.evidence.delivery += '\n' + correction;
      assert.equal(latestDeliveryZonePolicy([source, denial, correction]).unresolved, false, name);
      const accepted = normalizeGoalDraft(corrected, { goal: correction, priorGoals: [source, denial], now, timeZone: zone });
      assert.equal(accepted.ready, true, name); assert.equal(accepted.authorizesPayment, false);
    }
  }
});

test('an OLD-absent component directive projects only its exact NEW source for one purchased object', () => {
  const prior = 'Purchase 37 A4 polypropylene document wallets.';
  const reply = 'Replace snap fasteners with zip closures.';
  const source = prior + ' ' + reply, projected = projectSpecification(source, [prior, reply]);
  assert.ok(projected); assert.match(projected, /zip closures/); assert.doesNotMatch(projected, /snap fasteners/);
  for (const prior of ['Purchase 37 wallets and 12 folders.', 'Do not purchase 37 document wallets.']) {
    assert.equal(projectSpecification(prior + ' ' + reply, [prior, reply]), null, prior);
  }
  for (const reply of ['Replace snap fasteners with zip closures if approved.', 'Replace snap fasteners with painted snap fasteners.']) {
    assert.equal(projectSpecification(prior + ' ' + reply, [prior, reply]), null, reply);
  }
});

test('fulfillment policy distinguishes filling an order from sharing its information', () => {
  assert.equal(splitPermission(['Multiple suppliers may fill the order.']), 'allow');
  assert.equal(splitPermission(['Multiple suppliers may not fill the order.']), 'deny');
  assert.notEqual(splitPermission(['Multiple suppliers may fill the order details.']), 'allow');
  assert.notEqual(splitPermission(['Multiple suppliers may fill the order if I approve.']), 'allow');
});

test('a DST occurrence clarification reports the actual unresolved delivery constraint', () => {
  const goal = 'Buy 17 wool blankets. Budget USD 400. Deliver 2027-11-07 at 1:30 AM America/New_York; I have not chosen an occurrence.';
  const input = { ready: false, quantity: 0, budgetCents: 0, currency: 'USD', deadline: '', specification: '', allowSplit: false,
    clarification: 'Do you mean the first or second occurrence of 1:30 AM?', assumptions: [], evidence: { quantity: '', budget: '', specification: '', delivery: '', split: '' },
    localDelivery: { date: '2027-11-07', time: '01:30', timeZone: 'America/New_York', offset: '' } };
  const result = normalizeGoalDraft(input, { goal, now: Date.parse('2027-11-01T12:00:00Z'), timeZone: 'America/New_York' });
  assert.equal(result.ready, false); assert.equal(result.rfq, null); assert.deepEqual(result.missingFields, ['delivery_time']);
  assert.equal(result.authorizesPayment, false);
});
