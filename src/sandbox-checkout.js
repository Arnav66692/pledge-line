import { createHash, randomUUID } from 'node:crypto';
import { sandboxApprovalUrl, usdCents } from './paypal-orders.js';
import { canCloseUnpaidCheckout } from './checkout-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAYPAL_ID = /^[A-Z0-9]{8,40}$/;
const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const copy = (value) => structuredClone(value);
const integer = (value, min = 0, max = 100000000) => Number.isSafeInteger(value) && value >= min && value <= max;

export class SandboxCheckoutError extends Error {
  constructor(code, status = 409) { super(code); this.name = 'SandboxCheckoutError'; this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new SandboxCheckoutError(code, status); };

function approvedTerms(rfq, proposal, at, { allowExpired = false, verifyHash = true } = {}) {
  if (!rfq || !proposal || rfq.currency !== 'USD' || proposal.currency !== 'USD' || !integer(rfq.quantity, 1, 500) ||
    !integer(rfq.budgetCents, 1) || typeof rfq.specification !== 'string' || rfq.specification.length < 8 || rfq.specification.length > 1000 ||
    !Number.isFinite(Date.parse(rfq.deadline)) || !integer(proposal.totalCents, 1) || proposal.totalCents > rfq.budgetCents ||
    proposal.quantity !== rfq.quantity || !/^[0-9a-f]{64}$/.test(proposal.termsHash ?? '') || typeof proposal.disclosure !== 'string' ||
    !Array.isArray(proposal.allocations) || proposal.allocations.length < 1 || proposal.allocations.length > 5) fail('CHECKOUT_TERMS_INVALID', 400);
  const terms = { request: rfq, allocations: proposal.allocations, totalCents: proposal.totalCents, expiresAt: proposal.expiresAt, disclosure: proposal.disclosure };
  if (verifyHash && hash(terms) !== proposal.termsHash) fail('CHECKOUT_TERMS_CHANGED');
  const suppliers = new Set();
  let total = 0, quantity = 0;
  for (const allocation of proposal.allocations) {
    if (!allocation || typeof allocation.supplierId !== 'string' || !/^[a-z0-9-]{1,48}$/.test(allocation.supplierId) || suppliers.has(allocation.supplierId) ||
      !PAYPAL_ID.test(allocation.payeeId ?? '') || typeof allocation.quoteId !== 'string' || !/^[A-Za-z0-9-]{1,120}$/.test(allocation.quoteId) ||
      allocation.currency !== 'USD' || !integer(allocation.quantity, 1, rfq.quantity) || !integer(allocation.unitPriceCents, 1) ||
      !['goodsCents', 'setupCents', 'shippingCents', 'taxCents', 'totalCents'].every((field) => integer(allocation[field])) ||
      allocation.goodsCents !== allocation.quantity * allocation.unitPriceCents ||
      allocation.totalCents !== allocation.goodsCents + allocation.setupCents + allocation.shippingCents + allocation.taxCents ||
      !Number.isFinite(Date.parse(allocation.expiresAt)) || !Number.isFinite(Date.parse(allocation.deliveryAt)) ||
      Date.parse(allocation.deliveryAt) > Date.parse(rfq.deadline)) fail('CHECKOUT_ALLOCATION_INVALID', 400);
    suppliers.add(allocation.supplierId); total += allocation.totalCents; quantity += allocation.quantity;
  }
  if (total !== proposal.totalCents || quantity !== rfq.quantity ||
    Date.parse(proposal.expiresAt) !== Math.min(...proposal.allocations.map((leg) => Date.parse(leg.expiresAt)))) fail('CHECKOUT_ALLOCATION_INVALID', 400);
  if (!allowExpired && (Date.parse(proposal.expiresAt) <= at || Date.parse(rfq.deadline) <= at)) fail('CHECKOUT_TERMS_EXPIRED');
}

function publicState(workflow, at) {
  const confirmed = workflow.legs.filter((leg) => leg.captureState === 'confirmed').length;
  const uncertain = workflow.legs.some((leg) => ['claimed', 'unknown'].includes(leg.createState) || ['claimed', 'unknown'].includes(leg.captureState));
  let status = confirmed === workflow.legs.length ? 'completed' : uncertain ? 'uncertain' : confirmed ? 'partial'
    : workflow.legs.every((leg) => leg.createState === 'ready') ? 'awaiting_paypal_approval' : 'awaiting_checkout';
  if (workflow.blockedReason) status = uncertain || workflow.blockedReason === 'unexpected_capture' ? 'uncertain'
    : confirmed ? 'partial' : workflow.blockedReason === 'order_voided' ? 'failed' : 'expired';
  if (workflow.blockedReason === 'closed_unpaid') status = 'closed_unpaid';
  else if (!workflow.blockedReason && !confirmed && !uncertain && Date.parse(workflow.proposal.expiresAt) <= at) status = 'expired';
  return {
    id: workflow.id, request: copy(workflow.request), proposal: copy(workflow.proposal), status,
    mode: { suppliers: 'mcp', payments: 'paypal-sandbox' },
    checkout: { nonAtomic: true, blockedReason: workflow.blockedReason ?? null, canCloseUnpaid: canCloseUnpaidCheckout(workflow, at),
      closedUnpaidAt: workflow.blockedReason === 'closed_unpaid' ? workflow.legs[0]?.closedUnpaidEvidence?.closedAt ?? workflow.updatedAt : null,
      legs: workflow.legs.map((leg) => ({
      id: leg.id, supplierId: leg.allocation.supplierId, supplierName: leg.allocation.supplierName,
      orderId: leg.orderId, captureId: leg.captureId, amountCents: leg.allocation.totalCents,
      currency: leg.allocation.currency, quantity: leg.allocation.quantity,
      status: workflow.blockedReason === 'closed_unpaid' ? 'closed_unpaid' : leg.captureState === 'confirmed' ? 'confirmed' : ['claimed', 'unknown'].includes(leg.captureState) || ['claimed', 'unknown'].includes(leg.createState) ? 'uncertain'
        : leg.createState === 'ready' ? leg.orderStatus === 'APPROVED' ? 'ready_to_capture' : 'awaiting_paypal_approval' : 'awaiting_checkout',
      approvalUrl: workflow.blockedReason !== 'closed_unpaid' && leg.createState === 'ready' && leg.captureState === 'reserved' ? leg.approvalUrl : null,
    })) },
    settlements: workflow.legs.filter((leg) => leg.captureState !== 'reserved').map((leg) => ({ supplierId: leg.allocation.supplierId,
      quantity: leg.allocation.quantity, amountCents: leg.allocation.totalCents, currency: leg.allocation.currency,
      status: leg.captureState === 'confirmed' ? 'confirmed' : 'unknown', providerId: leg.captureId })),
  };
}

function boundOrder(order, workflow, leg) {
  const unit = order?.purchase_units?.[0];
  if (!order || !PAYPAL_ID.test(order.id ?? '') || order.id !== leg.orderId || order.intent !== 'CAPTURE' ||
    !Array.isArray(order.purchase_units) || order.purchase_units.length !== 1 || unit.reference_id !== leg.referenceId ||
    unit.custom_id !== leg.referenceId || unit.payee?.merchant_id !== leg.allocation.payeeId ||
    unit.amount?.currency_code !== leg.allocation.currency || usdCents(unit.amount?.value) !== leg.allocation.totalCents) fail('PAYPAL_ORDER_BINDING_CHANGED');
  return unit;
}

function orderProof(order, leg) {
  return { orderId: order.id, status: order.status, payeeId: leg.allocation.payeeId,
    amountCents: leg.allocation.totalCents, currency: leg.allocation.currency, referenceId: leg.referenceId };
}

/** A durable API workflow, separate from the simulated procurement settlement service. */
export function createSandboxCheckout({ store, paypal, getQuote, now = () => new Date(), organizationId = 'demo-organization',
  checkoutOrigin, allowSandboxWrites = false } = {}) {
  if (!store || !paypal || typeof getQuote !== 'function' || paypal.mode !== 'paypal-sandbox') fail('SANDBOX_CHECKOUT_CONFIGURATION_REQUIRED', 503);
  const time = () => {
    const at = new Date(now()).getTime();
    if (!Number.isFinite(at)) fail('CHECKOUT_CLOCK_UNAVAILABLE', 503);
    return at;
  };
  const scope = (id, extra = {}) => ({ organizationId, id, ...extra });
  const view = (workflow) => publicState(workflow, time());
  async function load(id) {
    if (!UUID.test(id ?? '')) fail('CHECKOUT_ID_INVALID', 400);
    const workflow = await store.get(scope(id));
    if (!workflow) fail('CHECKOUT_NOT_FOUND', 404);
    return workflow;
  }
  function callbacks(workflow, leg) {
    let base;
    try {
      base = new URL(checkoutOrigin);
      if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) ||
        base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error();
    } catch { fail('CHECKOUT_ORIGIN_INVALID', 503); }
    const returned = new URL('/procurement', base);
    returned.searchParams.set('checkout', workflow.id); returned.searchParams.set('leg', leg.id); returned.searchParams.set('returned', '1');
    const cancelled = new URL(returned); cancelled.searchParams.delete('returned'); cancelled.searchParams.set('cancelled', '1');
    return { returnUrl: returned.toString(), cancelUrl: cancelled.toString() };
  }
  async function freshQuote(workflow, allocation) {
    try {
      const quote = await getQuote(copy(allocation), copy(workflow.request));
      const goods = quote.unitPriceCents * allocation.quantity;
      if (Date.parse(workflow.proposal.expiresAt) <= time() || quote.supplierId !== allocation.supplierId || quote.payeeId !== allocation.payeeId ||
        quote.quoteId !== allocation.quoteId || quote.specificationHash !== hash(workflow.request.specification) || quote.currency !== allocation.currency ||
        !integer(quote.minQuantity, 1, allocation.quantity) || !integer(quote.maxQuantity, allocation.quantity, 500) ||
        quote.unitPriceCents !== allocation.unitPriceCents || quote.setupCents !== allocation.setupCents || quote.shippingCents !== allocation.shippingCents ||
        !integer(quote.taxBps, 0, 5000) || Math.round((goods + quote.setupCents) * quote.taxBps / 10000) !== allocation.taxCents ||
        quote.deliveryAt !== allocation.deliveryAt || quote.expiresAt !== allocation.expiresAt || Date.parse(quote.expiresAt) <= time() ||
        Date.parse(quote.deliveryAt) > Date.parse(workflow.request.deadline)) throw new Error();
      return true;
    } catch {
      await store.block(scope(workflow.id, { reason: 'quote_changed' }));
      return false;
    }
  }
  async function inspect(workflow, leg) {
    const order = await paypal.getOrder(leg.orderId);
    // Another process can commit its claim and finish capture while this provider read is in flight.
    // The claim precedes dispatch, so reloading after the read distinguishes our own capture from an external one.
    const refreshed = await load(workflow.id);
    const refreshedLeg = refreshed.legs.find((item) => item.id === leg.id);
    if (!refreshedLeg || refreshedLeg.orderId !== leg.orderId) fail('PAYPAL_ORDER_BINDING_CHANGED');
    workflow = refreshed;
    leg = refreshedLeg;
    let unit;
    try { unit = boundOrder(order, workflow, leg); }
    catch (error) { await store.block(scope(workflow.id, { reason: 'provider_binding_changed' })); throw error; }
    if (leg.createState !== 'ready') {
      const link = leg.approvalUrl ?? order.links?.find((item) => ['approve', 'payer-action'].includes(item.rel))?.href;
      const approvalUrl = sandboxApprovalUrl(link, leg.orderId);
      await store.recordOrder(scope(workflow.id, { legId: leg.id, orderId: leg.orderId, approvalUrl, orderStatus: order.status, proof: orderProof(order, leg) }));
    } else {
      await store.recordOrder(scope(workflow.id, { legId: leg.id, orderId: leg.orderId, approvalUrl: leg.approvalUrl, orderStatus: order.status, proof: orderProof(order, leg) }));
    }
    if (order.status === 'VOIDED' && leg.captureState === 'reserved') {
      await store.block(scope(workflow.id, { reason: 'order_voided' }));
      return false;
    }
    const captures = unit.payments?.captures;
    if (order.status === 'COMPLETED' || (Array.isArray(captures) && captures.some((capture) => capture.status === 'COMPLETED'))) {
      if (leg.captureState === 'reserved') {
        await store.block(scope(workflow.id, { reason: 'unexpected_capture' }));
        return false;
      }
      if (order.status !== 'COMPLETED' || !Array.isArray(captures) || captures.length !== 1 || captures[0].status !== 'COMPLETED') return false;
      const summary = captures[0];
      if (!PAYPAL_ID.test(summary.id ?? '') || summary.amount?.currency_code !== leg.allocation.currency || usdCents(summary.amount?.value) !== leg.allocation.totalCents) return false;
      const capture = await paypal.getCapture(summary.id);
      if (capture.id !== summary.id || capture.status !== 'COMPLETED' || capture.amount?.currency_code !== leg.allocation.currency ||
        usdCents(capture.amount?.value) !== leg.allocation.totalCents ||
        (capture.payee?.merchant_id && capture.payee.merchant_id !== leg.allocation.payeeId) ||
        (capture.supplementary_data?.related_ids?.order_id && capture.supplementary_data.related_ids.order_id !== leg.orderId)) return false;
      await store.recordCapture(scope(workflow.id, { legId: leg.id, state: 'confirmed', captureId: capture.id,
        proof: { orderId: leg.orderId, captureId: capture.id, status: 'COMPLETED', payeeId: leg.allocation.payeeId,
          amountCents: leg.allocation.totalCents, currency: leg.allocation.currency, referenceId: leg.referenceId } }));
      return true;
    }
    return false;
  }
  async function reconcile({ id }) {
    const workflow = await load(id);
    if (workflow.blockedReason === 'closed_unpaid') return view(workflow);
    for (const leg of workflow.legs) {
      if (!leg.orderId || leg.captureState === 'confirmed') continue;
      try { await inspect(workflow, leg); }
      catch { /* A read failure never clears an attempt or authorizes another payment. */ }
    }
    return view(await load(id));
  }
  async function closeUnpaid({ id }) {
    const workflow = await load(id);
    if (workflow.blockedReason === 'closed_unpaid') return view(workflow);
    if (!canCloseUnpaidCheckout(workflow, time())) fail('CHECKOUT_CLOSE_UNPAID_BLOCKED');
    if (typeof store.closeExpiredUnpaid !== 'function') fail('SANDBOX_CHECKOUT_CONFIGURATION_REQUIRED', 503);
    const orderChecks = [];
    for (const leg of workflow.legs) {
      let status = 'NOT_CREATED';
      if (leg.orderId) {
        const order = await paypal.getOrder(leg.orderId);
        let unit;
        try { unit = boundOrder(order, workflow, leg); }
        catch (error) { await store.block(scope(id, { reason: 'provider_binding_changed' })); throw error; }
        if (unit.payments !== undefined && (unit.payments === null || typeof unit.payments !== 'object' || Array.isArray(unit.payments) ||
          Object.values(unit.payments).some((payments) => !Array.isArray(payments) || payments.length !== 0))) {
          await store.block(scope(id, { reason: 'unexpected_capture' }));
          fail('CHECKOUT_CLOSE_UNPAID_BLOCKED');
        }
        if (!['CREATED', 'PAYER_ACTION_REQUIRED', 'APPROVED'].includes(order.status)) fail('CHECKOUT_CLOSE_UNPAID_BLOCKED');
        status = order.status;
      }
      orderChecks.push({ legId: leg.id, orderId: leg.orderId, status, payeeId: leg.allocation.payeeId,
        amountCents: leg.allocation.totalCents, currency: leg.allocation.currency, referenceId: leg.referenceId,
        checkedAt: new Date(time()).toISOString(), noPaymentEvidence: true });
    }
    try { return view(await store.closeExpiredUnpaid(scope(id, { at: time(), orderChecks }))); }
    catch (error) {
      if (error?.code === 'CHECKOUT_CLOSE_UNPAID_BLOCKED') fail('CHECKOUT_CLOSE_UNPAID_BLOCKED');
      throw error;
    }
  }
  return {
    async start({ id = randomUUID(), rfq, proposal, sessionSecretHash }) {
      approvedTerms(rfq, proposal, time());
      // Only the credential hash is retained. The quote confirmation token is no longer needed after approval.
      const persistedProposal = copy(proposal); delete persistedProposal.confirmationToken;
      const workflow = await store.reserve({ organizationId, id, rfq: copy(rfq), proposal: persistedProposal, sessionSecretHash });
      return view(workflow);
    },
    async get({ id }) { return view(await load(id)); },
    async prepare({ id }) {
      if (allowSandboxWrites !== true) fail('SANDBOX_WRITES_DISABLED', 503);
      let workflow = await load(id);
      if (workflow.blockedReason === 'closed_unpaid') return view(workflow);
      // start() checked the original ordered fingerprint before reservation. PostgreSQL JSONB preserves values,
      // not object-key order, and the database trigger freezes that complete binding after reservation.
      approvedTerms(workflow.request, workflow.proposal, time(), { verifyHash: false });
      if (workflow.blockedReason) return view(workflow);
      for (const leg of workflow.legs) {
        if (!await freshQuote(workflow, leg.allocation)) return view(await load(id));
        callbacks(workflow, leg);
      }
      for (const leg of workflow.legs) {
        if (leg.createState === 'ready') continue;
        if (leg.createState !== 'reserved') break;
        if (!await freshQuote(workflow, leg.allocation)) break;
        const claim = await store.claimCreate(scope(id, { legId: leg.id }));
        if (!claim.claimed) break;
        if (Date.parse(workflow.proposal.expiresAt) <= time()) {
          await store.markCreateUnknown(scope(id, { legId: leg.id }));
          await store.block(scope(id, { reason: 'quote_changed' }));
          break;
        }
        try {
          const data = await paypal.createOrder({ requestId: claim.requestId, payeeId: leg.allocation.payeeId,
            amountCents: leg.allocation.totalCents, currency: leg.allocation.currency, referenceId: leg.referenceId, ...callbacks(workflow, leg) });
          if (!PAYPAL_ID.test(data.id ?? '')) fail('PAYPAL_RESPONSE_INVALID', 503);
          const received = { legId: leg.id, state: 'unknown', orderId: data.id, approvalUrl: null,
            orderStatus: typeof data.status === 'string' ? data.status : 'UNKNOWN', proof: { orderId: data.id, outcome: 'awaiting_authoritative_read' } };
          await store.recordOrder(scope(id, received));
          let approvalUrl = null;
          const link = data.links?.find((item) => ['approve', 'payer-action'].includes(item.rel))?.href;
          if (link) approvalUrl = sandboxApprovalUrl(link, data.id);
          if (approvalUrl) await store.recordOrder(scope(id, { ...received, approvalUrl }));
          workflow = await load(id);
          await inspect(workflow, workflow.legs.find((item) => item.id === leg.id));
        } catch {
          await store.markCreateUnknown(scope(id, { legId: leg.id }));
          break;
        }
        workflow = await load(id);
      }
      return view(await load(id));
    },
    async capture({ id, legId }) {
      if (allowSandboxWrites !== true) fail('SANDBOX_WRITES_DISABLED', 503);
      const workflow = await load(id), leg = workflow.legs.find((item) => item.id === legId);
      if (!leg) fail('CHECKOUT_LEG_NOT_FOUND', 404);
      if (workflow.blockedReason || leg.captureState === 'confirmed') return view(workflow);
      if (leg.captureState !== 'reserved') return reconcile({ id });
      if (leg.createState !== 'ready' || !leg.orderId) return view(workflow);
      if (workflow.legs.some((item) => item.createState !== 'ready' || ['claimed', 'unknown'].includes(item.captureState)) ||
        workflow.legs.slice(0, workflow.legs.indexOf(leg)).some((item) => item.captureState !== 'confirmed')) return view(workflow);
      if (!await freshQuote(workflow, leg.allocation)) return view(await load(id));
      const order = await paypal.getOrder(leg.orderId);
      try { boundOrder(order, workflow, leg); }
      catch (error) { await store.block(scope(id, { reason: 'provider_binding_changed' })); throw error; }
      if (order.status === 'COMPLETED') return reconcile({ id });
      if (order.status === 'VOIDED') {
        await store.block(scope(id, { reason: 'order_voided' }));
        return view(await load(id));
      }
      if (order.status !== 'APPROVED') return view(workflow);
      const claim = await store.claimCapture(scope(id, { legId }));
      if (!claim.claimed) return view(await load(id));
      if (Date.parse(workflow.proposal.expiresAt) <= time()) {
        await store.recordCapture(scope(id, { legId, state: 'unknown', proof: { reason: 'quote_expired_before_dispatch' } }));
        await store.block(scope(id, { reason: 'quote_changed' }));
        return view(await load(id));
      }
      try { await paypal.captureOrder({ id: leg.orderId, requestId: claim.requestId }); }
      catch { /* Only authoritative reads can establish whether a timed-out capture completed. */ }
      try {
        const current = await load(id);
        if (await inspect(current, current.legs.find((item) => item.id === legId))) return view(await load(id));
      } catch { /* Keep the committed attempt unknown when its provider read cannot be verified. */ }
      await store.recordCapture(scope(id, { legId, state: 'unknown', proof: { reason: 'capture_not_authoritatively_confirmed' } }));
      return view(await load(id));
    },
    reconcile,
    closeUnpaid,
  };
}
