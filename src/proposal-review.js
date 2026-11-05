import { createHash } from 'node:crypto';

const integer = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 100000000;
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9-]{1,120}$/.test(value);
const date = (value) => typeof value === 'string' ? Date.parse(value) : NaN;
const moneyKeys = ['goodsCents', 'setupCents', 'shippingCents', 'taxCents', 'totalCents'];

/** Explanations of code checks, never a substitute for the checkout's independent validation. */
export function proposalEvidenceChecks({ request, proposal, quotes, now = Date.now() } = {}) {
  const allocations = Array.isArray(proposal?.allocations) && proposal.allocations.length <= 5 ? proposal.allocations : [];
  const evidence = Array.isArray(quotes) && quotes.length <= 5 ? quotes : [];
  const checks = [];
  const add = (code, label, available, passed, failureCode, message, detail = {}) => {
    checks.push({ code, label, status: !available ? 'unverified' : passed ? 'pass' : 'fail',
      ...(!available ? { reasonCode: 'EVIDENCE_INCOMPLETE', message: `${label}: the supplied evidence is incomplete.` }
        : !passed ? { reasonCode: failureCode, message } : { message: `${label}: the supplied evidence matches.` }), evidence: detail });
  };
  const bounded = allocations.length > 0;
  const selected = allocations.map((leg) => evidence.find((quote) => quote?.supplierId === leg?.supplierId && quote?.quoteId === leg?.quoteId));
  const safeAmounts = allocations.every((leg) => leg && moneyKeys.every((key) => integer(leg[key])) && integer(leg.quantity) && leg.quantity > 0 && integer(leg.unitPriceCents) && leg.unitPriceCents > 0);
  const total = safeAmounts ? allocations.reduce((sum, leg) => sum + leg.totalCents, 0) : null;
  const quantity = allocations.every((leg) => integer(leg?.quantity) && leg.quantity > 0)
    ? allocations.reduce((sum, leg) => sum + leg.quantity, 0) : null;

  add('BUDGET', 'All-in budget', integer(request?.budgetCents) && request.budgetCents > 0 && integer(proposal?.totalCents),
    proposal?.totalCents <= request?.budgetCents, 'BUDGET_EXCEEDED', 'The proposed total exceeds the requested all-in budget.',
    { budgetCents: integer(request?.budgetCents) ? request.budgetCents : null, totalCents: integer(proposal?.totalCents) ? proposal.totalCents : null });
  add('QUANTITY', 'Complete quantity', bounded && integer(request?.quantity) && request.quantity > 0 && integer(proposal?.quantity) && quantity !== null,
    quantity === request?.quantity && proposal?.quantity === request?.quantity, 'QUANTITY_MISMATCH', 'The allocated quantity does not match the complete requested order.',
    { requested: integer(request?.quantity) ? request.quantity : null, allocated: quantity });
  add('SPLIT_POLICY', 'Split-order permission', bounded && typeof request?.allowSplit === 'boolean',
    request?.allowSplit === true || allocations.length === 1, 'SPLIT_NOT_ALLOWED', 'The request does not permit splitting the order between suppliers.');

  const bindingAvailable = bounded && selected.every(Boolean) && allocations.every((leg) => id(leg?.supplierId) && id(leg?.quoteId));
  const bindingMatches = bindingAvailable && allocations.every((leg, index) => {
    const quote = selected[index];
    return typeof quote.payeeId === 'string' && quote.payeeId.length > 0 && quote.payeeId === leg.payeeId &&
      ['unitPriceCents', 'setupCents', 'shippingCents', 'taxBps', 'deliveryAt', 'expiresAt'].every((key) => quote[key] !== undefined && quote[key] === leg[key]) &&
      integer(quote.minQuantity) && quote.minQuantity > 0 && integer(quote.maxQuantity) && quote.maxQuantity <= 500 &&
      leg.quantity >= quote.minQuantity && leg.quantity <= quote.maxQuantity;
  }) && new Set(allocations.map((leg) => leg.supplierId)).size === allocations.length;
  add('QUOTE_BINDING', 'Supplier and payee binding', bindingAvailable, bindingMatches, 'QUOTE_BINDING_MISMATCH',
    'A selected allocation differs from its supplier quote, payee or quantity bounds.',
    { selectedQuoteIds: allocations.filter((leg) => id(leg?.quoteId)).map((leg) => leg.quoteId) });

  const costsAvailable = bounded && safeAmounts && selected.every((quote) => integer(quote?.taxBps) && quote.taxBps <= 5000) && integer(proposal?.totalCents);
  const costsMatch = costsAvailable && allocations.every((leg, index) => leg.goodsCents === leg.unitPriceCents * leg.quantity &&
    leg.taxCents === Math.round((leg.goodsCents + leg.setupCents) * selected[index].taxBps / 10000) &&
    leg.totalCents === leg.goodsCents + leg.setupCents + leg.shippingCents + leg.taxCents) && total === proposal.totalCents;
  add('COST_TOTAL', 'Goods, fees and tax arithmetic', costsAvailable, costsMatch, 'COST_MISMATCH',
    'The goods, setup, shipping, tax or summed allocation total does not match.', { allocationTotalCents: total });

  const deliveryAvailable = bounded && Number.isFinite(date(request?.deadline)) && allocations.every((leg) => Number.isFinite(date(leg?.deliveryAt)));
  add('DEADLINE', 'Delivery deadline', deliveryAvailable,
    allocations.every((leg) => date(leg?.deliveryAt) <= date(request?.deadline) && date(leg?.deliveryAt) >= now),
    'DEADLINE_MISSED', 'A selected supplier cannot meet the requested delivery deadline.');
  const expiryAvailable = bounded && Number.isFinite(date(proposal?.expiresAt)) && allocations.every((leg) => Number.isFinite(date(leg?.expiresAt)));
  add('QUOTE_FRESHNESS', 'Quote expiry', expiryAvailable,
    date(proposal?.expiresAt) > now && allocations.every((leg) => date(leg?.expiresAt) > now) &&
      date(proposal?.expiresAt) === Math.min(...allocations.map((leg) => date(leg?.expiresAt))),
    'QUOTE_EXPIRED_OR_CHANGED', 'The quote or proposed approval expiry is expired or does not match the selected terms.');
  const currencyAvailable = bounded && typeof request?.currency === 'string' && typeof proposal?.currency === 'string' && selected.every(Boolean);
  add('CURRENCY', 'Currency', currencyAvailable,
    currencyAvailable && request.currency === 'USD' && proposal.currency === request.currency && allocations.every((leg, index) => leg.currency === request.currency && selected[index].currency === request.currency),
    'CURRENCY_MISMATCH', 'The request, selected quotes and proposal do not share the supported USD currency.');
  const specificationAvailable = bounded && typeof request?.specification === 'string' && request.specification.length >= 8 && request.specification.length <= 1000 && selected.every(Boolean);
  const fingerprint = specificationAvailable ? createHash('sha256').update(request.specification).digest('hex') : null;
  add('SPECIFICATION', 'Exact specification', specificationAvailable,
    specificationAvailable && allocations.every((leg, index) => leg.specificationHash === fingerprint && selected[index]?.specificationHash === fingerprint),
    'SPECIFICATION_MISMATCH', 'A selected quote or allocation differs from the requested merchandise specification.');
  return checks;
}

export function explainProposalReview({ answer, request, proposal, quotes, threshold = 0.99, now } = {}) {
  const checks = proposalEvidenceChecks({ request, proposal, quotes, now });
  const reasons = checks.filter((check) => check.status !== 'pass').map((check) => ({
    code: check.reasonCode, source: 'code', check: check.code, message: check.message, evidence: check.evidence,
  }));
  const choiceProbability = answer.probabilities[answer.choice];
  const strong = answer.confidence >= threshold && choiceProbability >= threshold;
  if (!strong) reasons.push({ code: 'JEV_LOW_CONFIDENCE', source: 'reviewer',
    message: `Jev did not reach the ${Math.round(threshold * 100)}% review threshold. This is uncertainty, not a confirmed constraint violation.`,
    evidence: { confidence: answer.confidence, choiceProbability, threshold } });
  else if (answer.choice === 'needs_review') reasons.push({ code: 'JEV_REVIEW_REQUESTED', source: 'reviewer',
    message: 'Jev requested closer review. Its response does not identify a specific constraint failure; inspect the independent checks.', evidence: { confidence: answer.confidence } });
  const decision = strong && answer.choice === 'within_limits' && checks.every((check) => check.status === 'pass') ? 'within_limits' : 'needs_review';
  return { decision, confidence: answer.confidence, reviewerDecision: answer.choice, checks, reasons,
    summary: decision === 'within_limits'
      ? 'The supplied plan passed the listed code checks and Jev met the review threshold. This does not grant payment permission.'
      : reasons.some((reason) => reason.source === 'code')
        ? 'Independent checks found mismatched or incomplete evidence. Review the listed reasons before deciding.'
        : 'The supplied plan passed the listed code checks, but Jev requested review or did not meet the confidence threshold.',
    advisory: true, authorizesPayment: false, model: 'jev-1.14.0' };
}
