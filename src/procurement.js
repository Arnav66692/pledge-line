// Quote collection and exact all-in allocation. Network checkout is a separate durable PayPal sandbox workflow.
// The approval methods in this module dispatch simulated settlement only.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createMockSuppliers, PROCUREMENT_SCENARIOS } from './supplier-mock.js';

const MAX_QUANTITY = 500;
const MAX_CENTS = 100000000;
const COUNTEROFFER_REASONS = new Set(['volume', 'split_order', 'deadline', 'budget']);
const QUOTE_REJECTION_CODES = new Map([
  ['Supplier returned no usable quote.', 'quote_missing'],
  ['Supplier identity changed.', 'supplier_identity_mismatch'],
  ['Supplier payee does not match the registered payee.', 'payee_mismatch'],
  ['Supplier currency does not match the request.', 'currency_mismatch'],
  ['Supplier specification does not match the request.', 'specification_mismatch'],
  ['Supplier quote identity is invalid.', 'quote_identity_invalid'],
  ['Supplier reused a quote identity with changed commercial terms.', 'quote_identity_changed'],
  ['Supplier stock or minimum quantity is invalid.', 'quantity_bounds_invalid'],
  ['Supplier prices must be bounded whole cents and tax basis points.', 'price_invalid'],
  ['Supplier quote has expired.', 'quote_expired'],
  ['Supplier cannot meet the delivery deadline.', 'delivery_deadline_missed'],
  ['Supplier quote is outside the supported amount range.', 'amount_out_of_range'],
]);
const copy = (value) => structuredClone(value);
const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const has = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length > 512 || b.length > 512) return false;
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
};

export class ProcurementError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'ProcurementError'; this.status = status; }
}

function readRequest(raw, at) {
  if (!has(raw)) throw new ProcurementError('An order request is required.');
  if (!integer(raw.quantity, 1, MAX_QUANTITY)) throw new ProcurementError(`Quantity must be a whole number from 1 to ${MAX_QUANTITY}.`);
  if (!integer(raw.budgetCents, 1, MAX_CENTS)) throw new ProcurementError('Budget must be a positive whole number of cents.');
  if (raw.currency !== 'USD') throw new ProcurementError('This simulated procurement demo supports USD only.');
  if (typeof raw.deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw.deadline) || !Number.isFinite(Date.parse(raw.deadline)) || Date.parse(raw.deadline) <= at) {
    throw new ProcurementError('Choose a future delivery deadline as an ISO timestamp.');
  }
  const specification = typeof raw.specification === 'string' ? raw.specification.trim() : '';
  if (specification.length < 8 || specification.length > 1000) throw new ProcurementError('Describe the exact merchandise specification in 8 to 1000 characters.');
  const scenario = raw.scenario ?? 'normal';
  if (!PROCUREMENT_SCENARIOS.includes(scenario)) throw new ProcurementError('Unknown simulated supplier scenario.');
  return { quantity: raw.quantity, budgetCents: raw.budgetCents, currency: raw.currency,
    deadline: new Date(raw.deadline).toISOString(), specification, scenario, allowSplit: raw.allowSplit !== false };
}

function costs(quote, quantity) {
  const goodsCents = quote.unitPriceCents * quantity;
  const taxCents = Math.round((goodsCents + quote.setupCents) * quote.taxBps / 10000);
  const totalCents = goodsCents + quote.setupCents + quote.shippingCents + taxCents;
  if (!Number.isSafeInteger(totalCents) || totalCents > MAX_CENTS) throw new ProcurementError('Supplier quote is outside the supported amount range.');
  return { quantity, goodsCents, setupCents: quote.setupCents, shippingCents: quote.shippingCents, taxCents, totalCents };
}

function readQuote(raw, supplier, request, at) {
  if (!has(raw)) throw new ProcurementError('Supplier returned no usable quote.');
  if (raw.supplierId !== supplier.id) throw new ProcurementError('Supplier identity changed.');
  if (raw.payeeId !== supplier.payeeId) throw new ProcurementError('Supplier payee does not match the registered payee.');
  if (raw.currency !== request.currency) throw new ProcurementError('Supplier currency does not match the request.');
  if (raw.specificationHash !== hash(request.specification)) throw new ProcurementError('Supplier specification does not match the request.');
  if (typeof raw.quoteId !== 'string' || !/^[A-Za-z0-9-]{1,120}$/.test(raw.quoteId)) throw new ProcurementError('Supplier quote identity is invalid.');
  if (!integer(raw.minQuantity, 1, request.quantity) || !integer(raw.maxQuantity, raw.minQuantity, request.quantity)) throw new ProcurementError('Supplier stock or minimum quantity is invalid.');
  if (!integer(raw.unitPriceCents, 1, MAX_CENTS) || !integer(raw.setupCents, 0, MAX_CENTS) || !integer(raw.shippingCents, 0, MAX_CENTS) || !integer(raw.taxBps, 0, 5000)) {
    throw new ProcurementError('Supplier prices must be bounded whole cents and tax basis points.');
  }
  const expires = Date.parse(raw.expiresAt), delivery = Date.parse(raw.deliveryAt);
  if (!Number.isFinite(expires) || expires <= at) throw new ProcurementError('Supplier quote has expired.');
  if (!Number.isFinite(delivery) || delivery < at || delivery > Date.parse(request.deadline)) throw new ProcurementError('Supplier cannot meet the delivery deadline.');
  const quote = { supplierId: supplier.id, supplierName: supplier.name, payeeId: supplier.payeeId, quoteId: raw.quoteId,
    specificationHash: raw.specificationHash, currency: raw.currency, minQuantity: raw.minQuantity, maxQuantity: raw.maxQuantity,
    unitPriceCents: raw.unitPriceCents, setupCents: raw.setupCents, shippingCents: raw.shippingCents, taxBps: raw.taxBps,
    deliveryAt: new Date(delivery).toISOString(), expiresAt: new Date(expires).toISOString() };
  return { ...quote, ...costs(quote, quote.maxQuantity) };
}

export { readQuote as validateProcurementQuote };

// Retain only validated commercial evidence. Rejected payloads and provider error text never enter the trace.
function traceQuote(quote) {
  return Object.fromEntries(['supplierId', 'payeeId', 'quoteId', 'specificationHash', 'currency', 'minQuantity', 'maxQuantity',
    'unitPriceCents', 'setupCents', 'shippingCents', 'taxBps', 'deliveryAt', 'expiresAt', 'totalCents'].map((key) => [key, quote[key]]));
}

function quoteRejection(supplier, error) {
  const reasonCode = error instanceof ProcurementError ? QUOTE_REJECTION_CODES.get(error.message) : null;
  return { supplierId: supplier.id, reasonCode: reasonCode ?? 'supplier_unavailable',
    reason: reasonCode ? error.message : 'Supplier quote was unavailable.' };
}

function counteroffersOf(offers, initialQuotes) {
  if (!Array.isArray(offers) || offers.length < 1 || offers.length > initialQuotes.length) throw new ProcurementError('The main agent returned invalid counteroffers.', 503);
  const seen = new Set();
  for (const offer of offers) {
    const initial = initialQuotes.find((quote) => quote.supplierId === offer?.supplierId);
    if (!initial || seen.has(offer.supplierId) || !integer(offer.unitPriceCents, 1, initial.unitPriceCents) ||
      !COUNTEROFFER_REASONS.has(offer.rationale) || Object.keys(offer).some((key) => !['supplierId', 'unitPriceCents', 'rationale'].includes(key))) {
      throw new ProcurementError('The main agent returned invalid counteroffers.', 503);
    }
    seen.add(offer.supplierId);
  }
  return copy(offers);
}

function supplierRound(supplier, initial = null, rejection = null) {
  return { supplierId: supplier.id,
    supplierName: supplier.name.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100),
    initialQuote: initial ? traceQuote(initial) : null, baselineQuote: null, baselineReasonCode: null,
    counteroffer: null, responseQuote: null, responseReasonCode: null, acceptedQuoteId: null,
    outcome: 'rejected', reasonCode: rejection?.reasonCode ?? 'supplier_unavailable', selectedForAllocation: false };
}

function allocation(quote, quantity) {
  return { supplierId: quote.supplierId, supplierName: quote.supplierName, payeeId: quote.payeeId,
    quoteId: quote.quoteId, unitPriceCents: quote.unitPriceCents, currency: quote.currency, taxBps: quote.taxBps,
    specificationHash: quote.specificationHash,
    ...costs(quote, quantity), deliveryAt: quote.deliveryAt, expiresAt: quote.expiresAt };
}

function matchesAllocation(quote, leg) {
  if (!quote || !leg || leg.quantity < quote.minQuantity || leg.quantity > quote.maxQuantity) return false;
  const candidate = allocation(quote, leg.quantity);
  return Object.keys(candidate).every((key) => candidate[key] === leg[key]);
}

function selectPlan(quotes, request) {
  // Each supplier is consumed once, even when initial and negotiated alternatives have different stock or fees.
  const supplierOptions = new Map();
  for (const quote of [...quotes].sort((a, b) => a.supplierId.localeCompare(b.supplierId))) {
    const options = supplierOptions.get(quote.supplierId) ?? [];
    options.push(quote); supplierOptions.set(quote.supplierId, options);
  }
  let states = new Map([[0, { totalCents: 0, allocations: [] }]]);
  for (const options of supplierOptions.values()) {
    const next = new Map(states);
    for (const [have, state] of states) {
      if (!request.allowSplit && state.allocations.length) continue;
      for (const quote of options) for (let qty = quote.minQuantity; qty <= Math.min(quote.maxQuantity, request.quantity - have); qty += 1) {
        const leg = allocation(quote, qty);
        const totalCents = state.totalCents + leg.totalCents;
        if (totalCents > request.budgetCents) continue;
        const current = next.get(have + qty);
        const candidate = { totalCents, allocations: [...state.allocations, leg] };
        const key = JSON.stringify(candidate.allocations.map((a) => [a.supplierId, a.quantity]));
        const currentKey = current && JSON.stringify(current.allocations.map((a) => [a.supplierId, a.quantity]));
        if (!current || totalCents < current.totalCents || (totalCents === current.totalCents && key < currentKey)) next.set(have + qty, candidate);
      }
    }
    states = next;
  }
  return states.get(request.quantity) ?? null;
}

const quoteBinding = (quote) => [quote.supplierId, quote.payeeId, quote.quoteId, quote.specificationHash, quote.currency,
  quote.minQuantity, quote.maxQuantity, quote.unitPriceCents, quote.setupCents, quote.shippingCents, quote.taxBps, quote.deliveryAt, quote.expiresAt];
const sameQuote = (a, b) => JSON.stringify(quoteBinding(a)) === JSON.stringify(quoteBinding(b));

function readBoundQuote(raw, supplier, request, at, knownQuotes) {
  const quote = readQuote(raw, supplier, request, at);
  const previous = knownQuotes.find((known) => known.quoteId === quote.quoteId);
  if (previous && !sameQuote(previous, quote)) throw new ProcurementError('Supplier reused a quote identity with changed commercial terms.');
  return quote;
}

/**
 * request(raw) -> state, approve(id, { confirmationToken, termsHash }) -> state,
 * reconcile(id) -> state, get(id) -> copied state.
 * A journal, when configured, is awaited before every simulated side effect. Sessions are still in memory.
 */
export function createProcurementService({ suppliers = null, now = () => new Date(),
  tokenFactory = () => randomBytes(32).toString('hex'), journal = null, agent = null, organizationId = 'demo-organization', maxSessions = 200 } = {}) {
  if (!integer(maxSessions, 1, 10000)) throw new ProcurementError('Procurement session limit is invalid.');
  const sessions = new Map();
  const time = () => new Date(now()).getTime();
  const event = (session, type, message) => session.state.timeline.push({ type, at: new Date(time()).toISOString(), message });
  const find = (id) => { const s = sessions.get(id); if (!s) throw new ProcurementError('That procurement session was not found.', 404); return s; };
  const stateOf = (session) => copy(session.state);
  const operationKey = (session) => `procurement:${session.state.id}`;

  function statusOf(session) {
    const list = session.state.settlements;
    if (list.some((s) => s.status === 'unknown')) return 'uncertain';
    if (list.length === session.state.proposal.allocations.length && list.every((s) => s.status === 'confirmed')) return 'completed';
    if (list.some((s) => s.status === 'confirmed')) return 'partial';
    return 'failed';
  }

  async function checkQuote(session, leg) {
    const supplier = session.registry.get(leg.supplierId);
    const raw = await supplier.getQuote(leg.quoteId);
    const fresh = readQuote(raw, supplier, session.state.request, time());
    const original = session.state.quotes.find((quote) => matchesAllocation(quote, leg));
    return Boolean(original && sameQuote(original, fresh) && fresh.maxQuantity >= leg.quantity && costs(fresh, leg.quantity).totalCents === leg.totalCents);
  }

  async function record(session, leg, outcome, providerId = null) {
    if (!journal) return;
    await journal.recordLegOutcome({ organizationId, operationKey: operationKey(session), kind: leg.supplierId,
      state: outcome, providerId, evidence: { quoteId: leg.quoteId, payeeId: leg.payeeId, quantity: leg.quantity,
        amountCents: leg.totalCents, currency: leg.currency, termsHash: session.state.proposal.termsHash } });
  }

  async function verifySettlement(session, leg, item) {
    const supplier = session.registry.get(leg.supplierId);
    let read;
    try { read = await supplier.getSettlement(item.requestId); } catch { return false; }
    if (!has(read) || read.requestId !== item.requestId || read.payeeId !== leg.payeeId || read.quoteId !== leg.quoteId ||
        read.quantity !== leg.quantity || read.amountCents !== leg.totalCents || read.currency !== leg.currency ||
        read.termsHash !== session.state.proposal.termsHash || typeof read.providerId !== 'string') return false;
    if (read.status === 'DECLINED') {
      try { await record(session, leg, 'failed', read.providerId ?? null); } catch { return false; }
      item.status = 'failed'; item.providerId = read.providerId ?? null;
      event(session, 'payment_declined', `${leg.supplierName} declined its simulated payment. No replacement was purchased.`);
      return true;
    }
    if (read.status !== 'COMPLETED') return false;
    try { await record(session, leg, 'confirmed', read.providerId); } catch { return false; }
    item.status = 'confirmed'; item.providerId = read.providerId;
    event(session, 'payment_verified', `Verified the simulated payment for ${leg.quantity} units from ${leg.supplierName}.`);
    return true;
  }

  async function executeRemaining(session) {
    const { state } = session;
    for (const leg of state.proposal.allocations) {
      const existing = state.settlements.find((s) => s.supplierId === leg.supplierId);
      if (existing?.status === 'confirmed') continue;
      if (existing || state.settlements.some((s) => s.status !== 'confirmed')) break;
      let unchanged = false;
      try { unchanged = await checkQuote(session, leg); } catch { /* Unreadable terms cannot authorize a new payment. */ }
      if (!unchanged) {
        event(session, 'quote_changed', 'A remaining quote expired or changed. No new payment was attempted.');
        state.status = state.settlements.length ? 'partial' : 'expired';
        return;
      }
      const item = { supplierId: leg.supplierId, quantity: leg.quantity, amountCents: leg.totalCents, currency: leg.currency,
        status: 'unknown', requestId: `proc-${state.id}-${leg.supplierId}`, providerId: null };
      // Persist the claim before the simulated side effect. Ambiguous commit or unavailable storage blocks the call.
      if (journal) {
        let claim;
        try { claim = await journal.claimLeg({ organizationId, operationKey: operationKey(session), kind: leg.supplierId }); }
        catch { event(session, 'storage_unavailable', 'The payment claim could not be persisted. No new payment was attempted.'); state.status = state.settlements.length ? 'partial' : 'failed'; return; }
        if (!claim?.claimed || typeof claim.requestId !== 'string') {
          event(session, 'claim_blocked', 'The journal did not authorize a fresh payment attempt.');
          state.status = state.settlements.length ? 'partial' : 'uncertain'; return;
        }
        item.requestId = claim.requestId;
      }
      state.settlements.push(item);
      event(session, 'payment_attempt', `Attempting the approved simulated payment for ${leg.quantity} units from ${leg.supplierName}.`);
      let uncertain = false;
      try {
        await session.registry.get(leg.supplierId).settle({ requestId: item.requestId, quoteId: leg.quoteId,
          quantity: leg.quantity, amountCents: leg.totalCents, currency: leg.currency, payeeId: leg.payeeId, termsHash: state.proposal.termsHash });
      } catch {
        uncertain = true;
        event(session, 'payment_uncertain', 'A simulated supplier response was lost. Checking the same payment identity before doing anything else.');
      }
      const verified = await verifySettlement(session, leg, item);
      if (!verified) {
        try { await record(session, leg, 'unknown'); } catch { /* The in-memory unknown guard still blocks a repeat. */ }
        event(session, 'reconciliation_needed', 'The payment remains unverified. Later supplier payments are blocked until it can be reconciled.');
        break;
      }
      if (uncertain && item.status === 'confirmed') event(session, 'recovered', 'Recovered by checking the original simulated payment. It was not charged again.');
      if (item.status === 'failed') break;
    }
    state.status = statusOf(session);
    if (state.status === 'completed') event(session, 'completed', 'All approved simulated supplier payments are verified. Delivery is a supplier promise, not a verified fulfillment.');
    if (state.status === 'partial') event(session, 'partial', 'Only part of the approved order is paid. Payments across suppliers are not atomic and no refund or replacement was authorized.');
  }

  return {
    async request(raw) {
      const request = readRequest(raw, time());
      if (sessions.size >= maxSessions) throw new ProcurementError('This simulated procurement service has reached its session limit.', 429);
      const adapters = suppliers ?? createMockSuppliers({ scenario: request.scenario, now });
      if (!Array.isArray(adapters) || adapters.length < 1 || adapters.length > 5) throw new ProcurementError('Configure one to five supplier adapters.');
      const network = adapters.every((supplier) => supplier?.mode === 'mcp-sandbox');
      if (network && request.scenario !== 'normal') throw new ProcurementError('Mock fault scenarios cannot be applied to network suppliers.');
      const registry = new Map();
      for (const supplier of adapters) {
        if (!supplier || supplier.mode !== (network ? 'mcp-sandbox' : 'simulated') || !/^[a-z0-9-]{1,48}$/.test(supplier.id) || registry.has(supplier.id) ||
            typeof supplier.name !== 'string' || supplier.name.length > 100 || typeof supplier.payeeId !== 'string' || supplier.payeeId.length < 1 || supplier.payeeId.length > 120 ||
            !(network ? ['quote', 'negotiate', 'getQuote'] : ['quote', 'negotiate', 'getQuote', 'settle', 'getSettlement']).every((name) => typeof supplier[name] === 'function')) {
          throw new ProcurementError('A supplier adapter is invalid or mixes network and mock authority.');
        }
        registry.set(supplier.id, supplier);
      }
      const state = { id: randomUUID(), status: 'collecting_quotes', mode: { suppliers: network ? 'mcp' : 'simulated', payments: network ? 'paypal-sandbox' : 'mock' }, request,
        quotes: [], rejections: [], proposal: null, settlements: [], timeline: [],
        negotiationTrace: { version: 1, supplierRounds: [], allocation: null } };
      const session = { state, registry, approved: false, operation: null };
      sessions.set(state.id, session);
      event(session, 'request', network ? 'Contacting registered MCP supplier endpoints and checking the exact specification, complete quantity, all-in budget and deadline.' : 'Comparing simulated suppliers for the exact specification, complete quantity, all-in budget and deadline.');
      const initialResults = await Promise.all([...registry.values()].map(async (supplier) => {
        try {
          const initial = readQuote(await supplier.quote(copy(request)), supplier, request, time());
          return { supplier, initial, round: supplierRound(supplier, initial) };
        } catch (error) {
          const rejection = quoteRejection(supplier, error);
          return { rejection, round: supplierRound(supplier, null, rejection) };
        }
      }));
      const initialQuotes = initialResults.filter((item) => item.initial).map((item) => item.initial);
      let offers = [];
      if (agent && initialQuotes.length) {
        try { offers = counteroffersOf(await agent.planNegotiation({ request: copy(request), quotes: copy(initialQuotes) }), initialQuotes); }
        catch { throw new ProcurementError('The main agent could not verify a negotiation plan. No purchase was approved.', 503); }
        event(session, 'agent_counteroffers', 'Anthropic proposed bounded counteroffers. Supplier prices and every order constraint are checked by code.');
      }
      if (agent) {
        await Promise.all(initialResults.map(async (item) => {
          if (!item.initial) return;
          const { supplier, initial, round } = item;
          try {
            const { supplierName, ...quote } = copy(initial);
            item.baseline = readBoundQuote(await supplier.negotiate({ request: copy(request), quote }), supplier, request, time(), [initial]);
            round.baselineQuote = traceQuote(item.baseline);
            round.baselineReasonCode = 'baseline_verified';
          } catch (error) {
            round.baselineReasonCode = quoteRejection(supplier, error).reasonCode;
          }
        }));
      }
      const results = await Promise.all(initialResults.map(async (item) => {
        if (item.rejection) return item;
        const { supplier, initial, round } = item;
        try {
          const offer = offers.find((candidate) => candidate.supplierId === supplier.id);
          round.counteroffer = offer ? { unitPriceCents: offer.unitPriceCents, rationale: offer.rationale,
            source: agent?.mode === 'anthropic' ? 'anthropic' : 'main_agent' } : null;
          // The registered display name belongs to our UI, not to the supplier's strict commercial quote schema.
          const { supplierName, ...supplierQuote } = copy(initial);
          // A supplier omitted from the model's offers uses its already checked policy quote, without a retry.
          const negotiated = agent && !offer ? item.baseline
            : readBoundQuote(await supplier.negotiate({ request: copy(request), quote: supplierQuote, ...(offer ? { counterOffer: { unitPriceCents: offer.unitPriceCents } } : {}) }), supplier, request, time(), [initial, ...(item.baseline ? [item.baseline] : [])]);
          if (!negotiated) throw new ProcurementError('Supplier returned no usable quote.');
          const cheaper = negotiated.maxQuantity === initial.maxQuantity && negotiated.minQuantity === initial.minQuantity &&
            negotiated.unitPriceCents <= initial.unitPriceCents && negotiated.setupCents <= initial.setupCents &&
            negotiated.shippingCents <= initial.shippingCents && negotiated.taxBps <= initial.taxBps;
          const selectedQuote = cheaper && !sameQuote(initial, negotiated) ? negotiated : initial;
          round.responseQuote = traceQuote(negotiated);
          round.acceptedQuoteId = selectedQuote.quoteId;
          round.outcome = selectedQuote === initial ? 'kept_initial' : 'accepted_response';
          round.reasonCode = cheaper ? negotiated.totalCents < initial.totalCents ? 'discount_verified' : 'no_discount' : 'terms_not_improved';
          round.responseReasonCode = round.reasonCode;
          return { round, response: negotiated, quote: { ...selectedQuote, negotiated: cheaper && negotiated.totalCents < initial.totalCents,
            initialTotalCents: initial.totalCents, initialUnitPriceCents: initial.unitPriceCents,
            counterOfferCents: offer?.unitPriceCents ?? null, counterOfferReason: offer?.rationale ?? null } };
        } catch (error) {
          const rejection = quoteRejection(supplier, error);
          round.reasonCode = rejection.reasonCode;
          round.responseReasonCode = rejection.reasonCode;
          return { rejection, round };
        }
      }));
      for (const result of results) {
        state.negotiationTrace.supplierRounds.push(result.round);
        if (result.quote) state.quotes.push(result.quote);
        else state.rejections.push(result.rejection);
      }
      let plan = selectPlan(state.quotes, request);
      if (agent) {
        const baselineOptions = [...initialQuotes, ...initialResults.filter((item) => item.baseline).map((item) => item.baseline)];
        const agentOptions = [...initialQuotes, ...results.filter((item) => item.response).map((item) => item.response)];
        const baselinePlan = selectPlan(baselineOptions, request), agentPlan = selectPlan(agentOptions, request);
        const unionOptions = [...baselineOptions, ...results.filter((item) => item.response).map((item) => item.response)];
        const unionPlan = selectPlan(unionOptions, request);
        const chooseBaseline = baselinePlan && baselinePlan.totalCents === unionPlan?.totalCents;
        const chooseAgent = !chooseBaseline && agentPlan && agentPlan.totalCents === unionPlan?.totalCents;
        plan = chooseBaseline ? baselinePlan : chooseAgent ? agentPlan : unionPlan;
        const selectedSource = plan ? chooseBaseline ? 'baseline' : chooseAgent ? 'agent' : 'hybrid' : 'none';
        const comparisonComplete = Boolean(baselinePlan && agentPlan);
        state.negotiationTrace.priceGuard = { version: 1, baselineTotalCents: baselinePlan?.totalCents ?? null,
          agentTotalCents: agentPlan?.totalCents ?? null, selectedTotalCents: plan?.totalCents ?? null, selectedSource,
          comparisonComplete, avoidedCents: agentPlan ? Math.max(0, agentPlan.totalCents - plan.totalCents) : null };
        const selectedOptions = chooseBaseline ? baselineOptions : chooseAgent ? agentOptions : unionOptions;
        state.quotes = initialResults.filter((item) => item.initial).map((item) => {
          const leg = plan?.allocations.find((allocation) => allocation.supplierId === item.supplier.id);
          const chosen = leg ? selectedOptions.find((quote) => matchesAllocation(quote, leg))
            : chooseBaseline ? item.baseline ?? item.initial : results.find((result) => result.round.supplierId === item.supplier.id)?.response ?? item.initial;
          const { round, initial } = item;
          round.acceptedQuoteId = chosen.quoteId;
          if (sameQuote(chosen, initial)) { round.outcome = 'kept_initial'; round.reasonCode = 'initial_terms_selected'; }
          else if (round.baselineQuote && sameQuote(chosen, round.baselineQuote)) { round.outcome = 'accepted_baseline'; round.reasonCode = 'baseline_price_guard'; }
          else if (round.responseQuote && sameQuote(chosen, round.responseQuote)) { round.outcome = 'accepted_response'; round.reasonCode = 'allocation_constraints_verified'; }
          else throw new ProcurementError('The selected allocation has no matching validated quote.', 503);
          return { ...chosen, negotiated: chosen.unitPriceCents < initial.unitPriceCents || chosen.setupCents < initial.setupCents || chosen.shippingCents < initial.shippingCents || chosen.taxBps < initial.taxBps,
            initialTotalCents: initial.totalCents, initialUnitPriceCents: initial.unitPriceCents,
            counterOfferCents: round.counteroffer?.unitPriceCents ?? null, counterOfferReason: round.counteroffer?.rationale ?? null };
        });
        event(session, 'price_guard', chooseBaseline
          ? 'The complete code-policy allocation was no more expensive than the agent allocation. Its exact validated quotes were retained for review.'
          : chooseAgent ? 'The complete agent allocation was cheaper or satisfied constraints the checked code-policy allocation could not meet.'
            : plan ? 'Combining validated quote alternatives produced a cheaper complete allocation or satisfied constraints neither separate portfolio could meet.'
              : 'No combination of the checked quotes could satisfy the complete request. No purchase was approved.');
      }
      state.negotiationTrace.allocation = { status: plan ? 'feasible' : 'no_feasible_quote', totalCents: plan?.totalCents ?? null,
        allocations: (plan?.allocations ?? []).map(({ supplierId, quoteId, quantity, totalCents }) => ({ supplierId, quoteId, quantity, totalCents })),
        rejections: state.rejections.map(({ supplierId, reasonCode }) => ({ supplierId, reasonCode })) };
      for (const round of state.negotiationTrace.supplierRounds) {
        round.selectedForAllocation = Boolean(plan?.allocations.some((leg) => matchesAllocation(state.quotes.find((quote) => quote.supplierId === round.supplierId), leg)));
      }
      const baseline = selectPlan(initialQuotes, { ...request, budgetCents: MAX_CENTS });
      state.comparison = { method: 'Same complete-quantity solver using initial quotes, without negotiation.', baselineTotalCents: baseline?.totalCents ?? null,
        baselineWithinBudget: Boolean(baseline && baseline.totalCents <= request.budgetCents), negotiatedTotalCents: plan?.totalCents ?? null,
        savingsCents: baseline && plan ? baseline.totalCents - plan.totalCents : null, scope: network ? 'Registered sandbox supplier quotes only.' : 'Simulated supplier quotes only.' };
      if (!plan) {
        state.status = 'no_feasible_quote';
        event(session, 'no_feasible_quote', 'No complete order satisfies every constraint. Nothing was purchased.');
        return stateOf(session);
      }
      const expiresAt = new Date(Math.min(...plan.allocations.map((a) => Date.parse(a.expiresAt)))).toISOString();
      const terms = { request, allocations: plan.allocations, totalCents: plan.totalCents, expiresAt,
        disclosure: network ? 'PayPal sandbox checkout requires buyer approval. Supplier payments are not atomic. No live money, automatic refunds or replacement purchases are authorized. A supplier connection does not verify fulfillment.' : 'Simulated payments. Supplier payments are not atomic. No automatic refunds or replacement purchases are authorized.' };
      const confirmationToken = tokenFactory();
      if (typeof confirmationToken !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(confirmationToken)) throw new ProcurementError('Approval token generator is misconfigured.', 500);
      state.proposal = { id: randomUUID(), termsHash: hash(terms), confirmationToken, expiresAt,
        totalCents: plan.totalCents, currency: request.currency, quantity: request.quantity, allocations: plan.allocations,
        disclosure: terms.disclosure };
      session.terms = terms;
      if (agent) {
        const reviewed = copy(state.proposal); delete reviewed.confirmationToken;
        try { state.review = await agent.reviewProposal({ request: copy(request), proposal: reviewed, quotes: copy(state.quotes), reviewedAt: time() }); }
        catch { throw new ProcurementError('The reviewer is unavailable. No purchase was approved.', 503); }
        event(session, 'advisory_review', state.review.decision === 'within_limits' ? 'Jev returned an advisory constraint review. It grants no payment permission.' : 'Jev flagged the plan for closer review. Exact terms and payment permissions remain enforced by code.');
      }
      state.status = 'awaiting_approval';
      event(session, 'proposal', 'A complete allocation is ready. Review every supplier, amount, specification and deadline before approving.');
      return stateOf(session);
    },

    async approve(id, approval) {
      const session = find(id);
      const { state } = session;
      if (state.mode.payments !== 'mock') throw new ProcurementError('Network suppliers require the durable PayPal sandbox checkout flow.', 409);
      if (!state.proposal) throw new ProcurementError('There is no feasible proposal to approve.');
      if (!has(approval) || !equal(approval.confirmationToken, state.proposal.confirmationToken) || !equal(approval.termsHash, state.proposal.termsHash)) {
        throw new ProcurementError('Approval does not match this exact proposal.', 409);
      }
      if (session.operation) { await session.operation; return stateOf(session); }
      if (session.approved || state.status !== 'awaiting_approval') return stateOf(session);
      // Set the lock synchronously before the first await, including the fresh-quote check.
      session.operation = (async () => {
        if (Date.parse(state.proposal.expiresAt) <= time()) { state.status = 'expired'; return; }
        for (const leg of state.proposal.allocations) {
          let same = false;
          try { same = await checkQuote(session, leg); } catch { /* No payment on unreadable fresh terms. */ }
          if (!same) { state.status = 'expired'; event(session, 'quote_changed', 'The offer changed or expired. Request fresh quotes and approve the new terms.'); return; }
        }
        session.approved = true;
        event(session, 'approved', 'The buyer approved this exact complete allocation and its non-atomic payment terms.');
        if (journal) {
          try {
            await journal.reserveOperation({ organizationId, operationKey: operationKey(session), consent: copy(session.terms),
              legs: state.proposal.allocations.map((a) => ({ kind: a.supplierId, targetId: a.payeeId, quantity: a.quantity,
                amountCents: a.totalCents, currency: a.currency })) });
          } catch {
            state.status = 'failed'; event(session, 'storage_unavailable', 'The approval could not be persisted. No supplier payment was attempted.'); return;
          }
        }
        await executeRemaining(session);
      })();
      try { await session.operation; } finally { session.operation = null; }
      return stateOf(session);
    },

    async reconcile(id) {
      const session = find(id);
      if (session.operation) { await session.operation; return stateOf(session); }
      if (!session.approved || !session.state.proposal || ['completed', 'failed', 'expired'].includes(session.state.status)) return stateOf(session);
      session.operation = (async () => {
        for (const item of session.state.settlements.filter((s) => s.status === 'unknown')) {
          const leg = session.state.proposal.allocations.find((a) => a.supplierId === item.supplierId);
          const verified = await verifySettlement(session, leg, item);
          if (verified && item.status === 'confirmed') event(session, 'recovered', 'Reconciled the existing simulated payment identity without a second charge.');
        }
        if (session.state.settlements.some((s) => s.status !== 'confirmed')) { session.state.status = statusOf(session); return; }
        await executeRemaining(session);
      })();
      try { await session.operation; } finally { session.operation = null; }
      return stateOf(session);
    },

    get(id) { return stateOf(find(id)); },
  };
}
