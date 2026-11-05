import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { explainProposalReview } from '../src/proposal-review.js';

function evidence() {
  const specification = 'Matching cotton volunteer shirts';
  const quote = { supplierId: 'campus', quoteId: 'quote-one', payeeId: 'merchant-one', currency: 'USD',
    specificationHash: createHash('sha256').update(specification).digest('hex'), minQuantity: 1, maxQuantity: 100,
    unitPriceCents: 500, setupCents: 1000, shippingCents: 1000, taxBps: 1000,
    deliveryAt: '2030-01-05T00:00:00Z', expiresAt: '2030-01-02T00:00:00Z' };
  const allocation = { ...quote, quantity: 100, goodsCents: 50000, taxCents: 5100, totalCents: 57100 };
  return { now: Date.parse('2030-01-01T00:00:00Z'), answer: { choice: 'within_limits', confidence: 0.999, probabilities: { within_limits: 0.999 } },
    request: { quantity: 100, budgetCents: 80000, currency: 'USD', specification, allowSplit: true, deadline: '2030-01-06T00:00:00Z' },
    proposal: { quantity: 100, totalCents: 57100, currency: 'USD', expiresAt: quote.expiresAt, allocations: [allocation] }, quotes: [quote] };
}

test('complete code evidence and a strong reviewer recommendation remain advisory', () => {
  const result = explainProposalReview(evidence());
  assert.equal(result.decision, 'within_limits');
  assert.equal(result.checks.length, 9);
  assert.ok(result.checks.every((check) => check.status === 'pass'));
  assert.deepEqual(result.reasons, []);
  assert.equal(result.advisory, true);
  assert.equal(result.authorizesPayment, false);
  assert.match(result.summary, /does not grant payment permission/);
});

test('low confidence is explained as uncertainty without inventing a constraint violation', () => {
  const input = evidence();
  input.answer = { choice: 'within_limits', confidence: 0.76, probabilities: { within_limits: 0.98 } };
  const result = explainProposalReview(input);
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.checks.every((check) => check.status === 'pass'));
  assert.deepEqual(result.reasons.map((reason) => reason.code), ['JEV_LOW_CONFIDENCE']);
  assert.equal(result.reasons[0].evidence.confidence, 0.76);
  assert.match(result.reasons[0].message, /not a confirmed constraint violation/);
  assert.equal(result.authorizesPayment, false);
});

test('low selected-choice probability cannot masquerade as confident review', () => {
  const input = evidence(); input.answer.probabilities.within_limits = 0.7;
  assert.equal(explainProposalReview(input).reasons[0].code, 'JEV_LOW_CONFIDENCE');
});

test('Jev requesting review does not invent a reason the provider never supplied', () => {
  const input = evidence(); input.answer = { choice: 'needs_review', confidence: 0.999, probabilities: { needs_review: 0.999 } };
  const result = explainProposalReview(input);
  assert.equal(result.decision, 'needs_review');
  assert.deepEqual(result.reasons.map((reason) => reason.code), ['JEV_REVIEW_REQUESTED']);
  assert.match(result.reasons[0].message, /does not identify a specific constraint failure/);
});

test('independent checks explain budget, quantity, payee, costs, dates, currency and specification failures', () => {
  const cases = [
    ['BUDGET_EXCEEDED', (input) => { input.request.budgetCents = 57099; }],
    ['QUANTITY_MISMATCH', (input) => { input.proposal.allocations[0].quantity = 99; }],
    ['QUOTE_BINDING_MISMATCH', (input) => { input.proposal.allocations[0].payeeId = 'replacement'; }],
    ['COST_MISMATCH', (input) => { input.proposal.allocations[0].taxCents = 5000; }],
    ['DEADLINE_MISSED', (input) => { input.request.deadline = '2030-01-04T00:00:00Z'; }],
    ['QUOTE_EXPIRED_OR_CHANGED', (input) => { input.now = Date.parse('2030-01-03T00:00:00Z'); }],
    ['CURRENCY_MISMATCH', (input) => { input.proposal.currency = 'EUR'; }],
    ['SPECIFICATION_MISMATCH', (input) => { input.request.specification = 'Different embroidery and shirt quality'; }],
  ];
  for (const [code, mutate] of cases) {
    const input = evidence(); mutate(input);
    const result = explainProposalReview(input);
    assert.equal(result.decision, 'needs_review', code);
    assert.ok(result.reasons.some((reason) => reason.code === code && reason.source === 'code'), code);
    assert.equal(result.authorizesPayment, false);
  }
});

test('missing evidence is never described as a verified complete plan', () => {
  const input = evidence(); input.quotes = []; delete input.request.budgetCents;
  const result = explainProposalReview(input);
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.some((reason) => reason.code === 'EVIDENCE_INCOMPLETE'));
  assert.ok(result.checks.some((check) => check.status === 'unverified'));
  assert.doesNotMatch(JSON.stringify(result), /authorization|confirmationToken/);
});
