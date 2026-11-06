import test from 'node:test';
import assert from 'node:assert/strict';
import { latestSourceIssues, quantityIsGrounded, quantityProofMatches, verifyQuantityProof } from '../src/goal-grounding.js';
import { normalizeGoalDraft } from '../src/goal-intake.js';
import { deterministicGoalDraft } from '../scripts/goal-intake-eval.js';

const now = Date.parse('2026-11-05T20:00:00Z'), timeZone = 'America/Los_Angeles';
function example(quantity = 73, goods = 'white cotton shirts') {
  const quantityQuote = `The complete quantity for this order is ${quantity}`;
  const goal = `Buy ${goods}. ${quantityQuote}. Budget USD 950 total. Deliver 2026-11-23 at 3 PM Pacific. Use one supplier.`;
  const draft = { ready: true, quantity, budgetCents: 95000, currency: 'USD', deadline: '2026-11-23T23:00:00Z',
    specification: goods, allowSplit: false, clarification: '', assumptions: [],
    evidence: { quantity: quantityQuote, budget: 'Budget USD 950 total', specification: goods,
      delivery: 'Deliver 2026-11-23 at 3 PM Pacific', split: 'Use one supplier' },
    localDelivery: { date: '2026-11-23', time: '15:00', timeZone, offset: '' } };
  return { goal, draft, quantityQuote };
}
const normalize = ({ goal, draft }, extra = {}) => normalizeGoalDraft(draft, { goal, now, timeZone, ...extra });

function directExample() {
  const input = example(48, 'custom soft durable lined reversible washable reusable cobalt-blue lightweight shirts');
  const purchase = `Buy 48 ${input.draft.specification}`;
  input.goal = input.goal.replace(`Buy ${input.draft.specification}. ${input.quantityQuote}.`, `${purchase}.`);
  input.draft.evidence.quantity = purchase;
  return input;
}

test('a complete original Buy clause verifies a long descriptor count while extraction can abstain', () => {
  const input = directExample();
  assert.equal(quantityIsGrounded(48, input.draft.evidence.quantity, [input.goal]), false);
  assert.equal(deterministicGoalDraft({ goal: input.goal, now, timeZone }).ready, false);
  const result = normalize(input);
  assert.equal(result.ready, true); assert.equal(result.rfq.quantity, 48);
  assert.equal(result.sourceEvidence.quantity, input.draft.evidence.quantity);
  assert.equal(result.requiresReview, true); assert.equal(result.authorizesPayment, false);
});

test('direct quantity proof requires the entire affirmative original purchase clause', () => {
  for (const wrap of [(q) => `Do not ${q.toLowerCase()}`, (q) => `The invoice says ${q}`, (q) => `If approved, ${q}`, (q) => `"${q}"`]) {
    const input = directExample(); input.goal = input.goal.replace(input.draft.evidence.quantity, wrap(input.draft.evidence.quantity));
    assert.equal(normalize(input).ready, false);
  }
  const cropped = directExample(); cropped.draft.evidence.quantity = cropped.draft.evidence.quantity.slice(4);
  assert.equal(normalize(cropped).ready, true, 'The source occurrence retains the full affirmative Buy role.');
  const standalone = directExample(); standalone.goal = standalone.goal.replace('Buy 48', '48'); standalone.draft.evidence.quantity = standalone.draft.evidence.quantity.slice(4);
  assert.equal(normalize(standalone).ready, false, 'A standalone long count phrase has no proof role in its original source.');
});

test('a complete scoped quantity proof admits a review-only draft without a whole-goal quantity winner', () => {
  for (const [quantity, goods] of [[73, 'white cotton shirts'], [48, 'custom soft durable lined reversible washable reusable cobalt-blue lightweight shirts']]) {
    const input = example(quantity, goods);
    assert.equal(quantityIsGrounded(quantity, input.quantityQuote, [input.goal]), false, 'The legacy extractor remains unchanged.');
    const result = normalize(input);
    assert.equal(result.ready, true, goods); assert.equal(result.rfq.quantity, quantity);
    assert.equal(result.sourceEvidence.quantity, input.quantityQuote);
    assert.equal(result.requiresReview, true); assert.equal(result.authorizesPayment, false);
  }
});

test('quantity proof cannot crop its source role, numeric token or full original clause', () => {
  for (const wrap of [(q) => `Do not use this: ${q}`, (q) => `The invoice says ${q}`, (q) => `If approved, ${q}`,
    (q) => `"${q}"`, (q) => `${q}?`, (q) => `${q} or 82`]) {
    const input = example(); input.goal = input.goal.replace(input.quantityQuote + '.', wrap(input.quantityQuote) + '.');
    assert.equal(normalize(input).ready, false, wrap(input.quantityQuote));
  }
  const cropped = example(); cropped.draft.evidence.quantity = 'The complete quantity for this order is 7';
  assert.equal(normalize(cropped).ready, false);
  const mismatched = example(); mismatched.draft.quantity = 74;
  assert.equal(normalize(mismatched).ready, false);
});

test('quantity proof refuses unknown clauses, quantity events, history and unresolved purchased units', () => {
  for (const change of ['Please halve that.', 'The quantity may be 73 or 82.', 'Do not use that quantity.', 'An invoice lists 73 shirts.',
    'I must confirm whether the quantity counts shirts or packs.', 'Make the fabric softer.', 'Buy another 2 shirts.', 'Keep a few spares.']) {
    const input = example(); input.goal += ' ' + change;
    assert.equal(normalize(input).ready, false, change);
  }
  const input = example();
  assert.equal(normalize(input, { priorGoals: ['We previously discussed a different purchase.'] }).ready, false);
  for (const goods of ['shirts in 10-shirt packs', 'shirts with two logos', 'shirts and mugs', 'shirts per attendee']) {
    assert.equal(normalize(example(73, goods)).ready, false, goods);
  }
});

test('a quantity proof does not supply budget inference, currency, calendar or authority', () => {
  const wrongBudget = example(); wrongBudget.draft.budgetCents = 96000;
  assert.equal(normalize(wrongBudget).ready, false);
  const bareBudget = example(); bareBudget.goal = bareBudget.goal.replace('Budget USD 950 total', '950'); bareBudget.draft.evidence.budget = '950';
  assert.equal(normalize(bareBudget).ready, false);
  const foreign = example(); foreign.goal = foreign.goal.replace('USD 950', 'EUR 950'); foreign.draft.evidence.budget = 'Budget EUR 950 total';
  assert.equal(normalize(foreign).ready, false);
  const wrongClock = example(); wrongClock.draft.localDelivery.time = '16:00'; wrongClock.draft.deadline = '2026-11-24T00:00:00Z';
  assert.equal(normalize(wrongClock).ready, false);
});

test('server-produced quantity proof is bound to exact evidence, value and original request', () => {
  const input = directExample(), quote = input.draft.evidence.quantity, turns = [input.goal];
  const proof = verifyQuantityProof(48, quote, turns);
  assert.ok(proof); assert.equal(Object.isFrozen(proof), true);
  assert.equal(quantityProofMatches(proof, 48, quote, turns), true);
  assert.equal(quantityProofMatches({ kind: 'quantity_source_proof' }, 48, quote, turns), false);
  assert.equal(quantityProofMatches({ ...proof }, 48, quote, turns), false);
  assert.equal(quantityProofMatches(proof, 49, quote, turns), false);
  assert.equal(quantityProofMatches(proof, 48, quote.slice(4), turns), false);
  assert.equal(quantityProofMatches(proof, 48, quote, [input.goal + ' Make the fabric softer.']), false);
  assert.equal(quantityProofMatches(proof, 48, quote, ['Buy another item.', ...turns]), false);
  assert.equal(verifyQuantityProof(48, quote, [input.goal + ' ' + quote]), null, 'Duplicate source occurrences are ambiguous.');
  const stale = example(48); stale.draft.evidence.quantity = '3 PM';
  const issues = latestSourceIssues(stale.draft.evidence, [stale.goal.replace('Buy white cotton shirts.', 'Buy 48 white cotton shirts.')], 'white cotton shirts', stale.draft.localDelivery, proof);
  assert.ok(issues.missingFields.includes('quantity'), 'A proof from another request cannot skip legacy source checks.');
});

test('whole field clauses cannot conceal extra counts or unknown quantity edits', () => {
  const replacements = [
    ['Budget USD 950 total', 'Budget USD 950 total and halve that order'],
    ['Deliver 2026-11-23 at 3 PM Pacific', 'Deliver 2026-11-23 at 3 PM Pacific but use fewer shirts'],
    ['Use one supplier', 'Use one supplier and add spares'],
  ];
  for (const [before, after] of replacements) {
    const input = directExample(); input.goal = input.goal.replace(before, after);
    assert.equal(verifyQuantityProof(48, input.draft.evidence.quantity, [input.goal]), null, after);
    assert.equal(normalize(input).ready, false, after);
  }
  for (const suffix of ['per box', 'for each attendee', 'with two prints', 'from last year’s invoice', 'not this order']) {
    const input = directExample(); input.goal = input.goal.replace(input.draft.evidence.quantity + '.', input.draft.evidence.quantity + ' ' + suffix + '.');
    assert.equal(normalize(input).ready, false, suffix);
  }
});

test('quantity proof refuses arithmetic, malformed tokens and typed-role counts', () => {
  for (const count of ['-48', '48.5', '4,8', '48mm', '48:00', '48/2', 'four dozen', 'twenty and twenty-eight', 'forty eight and eight']) {
    const input = directExample(); input.goal = input.goal.replace('Buy 48 ', `Buy ${count} `);
    input.draft.evidence.quantity = input.draft.evidence.quantity.replace('Buy 48 ', `Buy ${count} `);
    assert.equal(verifyQuantityProof(48, input.draft.evidence.quantity, [input.goal]), null, count);
    assert.equal(normalize(input).ready, false, count);
  }
  const input = directExample();
  for (const value of [0, 501, 48.5, NaN]) assert.equal(verifyQuantityProof(value, input.draft.evidence.quantity, [input.goal]), null);
  for (const goods of ['units', 'pieces', 'packs', 'people', 'suppliers', 'additional shirts', 'fewer shirts', 'shirts and mugs']) {
    const original = directExample(), replacement = `Buy 48 ${goods}`;
    original.goal = original.goal.replace(original.draft.evidence.quantity, replacement); original.draft.evidence.quantity = replacement;
    assert.equal(verifyQuantityProof(48, replacement, [original.goal]), null, goods);
  }
});

test('quantity proof supports complete ordinary cardinal words without evaluating arithmetic', () => {
  const input = directExample(); input.goal = input.goal.replace('Buy 48 ', 'Buy forty-eight ');
  input.draft.evidence.quantity = input.draft.evidence.quantity.replace('Buy 48 ', 'Buy forty-eight ');
  assert.ok(verifyQuantityProof(48, input.draft.evidence.quantity, [input.goal]));
  assert.equal(normalize(input).ready, true);
  const labeled = example(173); labeled.goal = labeled.goal.replace('is 173', 'is one hundred and seventy-three');
  labeled.draft.evidence.quantity = labeled.draft.evidence.quantity.replace('is 173', 'is one hundred and seventy-three');
  assert.ok(verifyQuantityProof(173, labeled.draft.evidence.quantity, [labeled.goal]));
  assert.equal(normalize(labeled).ready, true);
});

test('word and digit measurements do not become purchased counts through a long goods description', () => {
  const descriptors = 'long weather resistant reversible washable fleece lined emergency thermal blankets';
  for (const count of ['six', '6']) for (const unit of ['feet', 'foot', 'inch', 'inches', 'meters', 'metres', 'm', 'cm', 'liters', 'litres', 'ml',
    'grams', 'kg', 'ounces', 'pounds', 'hours']) {
    const input = example(6, `${unit} ${descriptors}`), purchase = `Buy ${count} ${unit} ${descriptors}`;
    input.goal = input.goal.replace(`Buy ${input.draft.specification}. ${input.quantityQuote}.`, `${purchase}.`);
    input.draft.evidence.quantity = purchase;
    assert.equal(verifyQuantityProof(6, purchase, [input.goal]), null, `${count} ${unit}`);
    assert.equal(normalize(input).ready, false, `${count} ${unit}`);
  }
  for (const count of ['six', '6']) {
    const input = example(6, descriptors), purchase = `Buy ${count} ${descriptors}`;
    input.goal = input.goal.replace(`Buy ${input.draft.specification}. ${input.quantityQuote}.`, `${purchase}.`);
    input.draft.evidence.quantity = purchase;
    assert.ok(verifyQuantityProof(6, purchase, [input.goal]), count); assert.equal(normalize(input).ready, true, count);
  }
  for (const count of ['six', '6']) {
    const goods = 'M cotton shirts';
    const input = example(6, goods), purchase = `Buy ${count} ${goods}`;
    input.goal = input.goal.replace(`Buy ${goods}. ${input.quantityQuote}.`, `${purchase}.`); input.draft.evidence.quantity = purchase;
    assert.ok(verifyQuantityProof(6, purchase, [input.goal]), `${count} size M`); assert.equal(normalize(input).ready, true);
  }
});
