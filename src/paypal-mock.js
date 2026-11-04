import { createHash, randomUUID } from 'node:crypto';
import { PayPalError, WriteNotAuthorized, safeId, pickVerifyHeaders, chargeWindow } from './paypal.js';
import { MOCK_SUBSCRIPTION_ID, MOCK_PLAN_ID, MOCK_WEBHOOK_ID, MOCK_HOLD_ID } from './config.js';
import { moneyBinding, toCents } from './cover.js';
import { drillByWriteId } from './drill.js';

const MOCK_EMAIL = 'sb-maria@personal.example.com';
const MONEY_PATTERN = /^\d{1,7}\.\d{2}$/;
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function nextBillingTime(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 10, 0, 0)).toISOString();
}

function seedSubscription(date) {
  const iso = date.toISOString();
  return {
    id: MOCK_SUBSCRIPTION_ID,
    status: 'ACTIVE',
    status_update_time: iso,
    plan_id: MOCK_PLAN_ID,
    start_time: iso,
    subscriber: { email_address: MOCK_EMAIL, name: { given_name: 'Maria', surname: 'Lopez' }, payer_id: 'MOCKPAYER01' },
    billing_info: { next_billing_time: nextBillingTime(date), failed_payments_count: 0 },
  };
}

// The mock's one completed charge, so the charge check has a transaction to read, as a seeded sandbox gift would after its first bill.
export const MOCK_TRANSACTION_ID = 'MOCKTX00000000042';

/** The first of this month at 10:00 UTC, or of last month when that is still ahead, the gift's latest bill. */
function lastBillingTime(date) {
  const thisMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 10, 0, 0);
  const at = thisMonth <= date.getTime() ? thisMonth : Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1, 10, 0, 0);
  return new Date(at).toISOString();
}

/** One transaction in the shape GET /v1/billing/subscriptions/{id}/transactions lists. */
export function mockCharge({ id = MOCK_TRANSACTION_ID, status = 'COMPLETED', value = '25.00', currency = 'USD', time }) {
  const money = (v) => ({ currency_code: currency, value: v });
  const fee = mockFee(value);
  return {
    id,
    status,
    amount_with_breakdown: { gross_amount: money(value), fee_amount: money(fee), net_amount: money((Number(value) - Number(fee)).toFixed(2)) },
    payer_name: { given_name: 'Maria', surname: 'Lopez' },
    payer_email: MOCK_EMAIL,
    time,
  };
}

const HOLD_DAYS_MS = 29 * 24 * 60 * 60 * 1000;
const mockFee = (value) => (Math.round(Number(value) * 2.89 + 49) / 100).toFixed(2);

/** The sponsor's standing hold, in the shape GET /v2/payments/authorizations/{id} gives it. */
function seedHold(date, id = MOCK_HOLD_ID) {
  return { id, status: 'CREATED', amount: { currency_code: 'USD', value: '200.00' }, expiration_time: new Date(date.getTime() + HOLD_DAYS_MS).toISOString(), create_time: date.toISOString() };
}

function seedPlan() {
  return {
    id: MOCK_PLAN_ID,
    product_id: 'PROD-MOCK0000001',
    name: 'Monthly gift',
    status: 'ACTIVE',
    billing_cycles: [{
      frequency: { interval_unit: 'MONTH', interval_count: 1 },
      tenure_type: 'REGULAR',
      sequence: 1,
      total_cycles: 0,
      pricing_scheme: { fixed_price: { value: '25.00', currency_code: 'USD' } },
    }],
  };
}

/**
 * In-memory PayPal with the same methods and return shapes as paypal.js.
 * Transitions follow PayPal's docs. The invoice errors are a guess (facts note 3).
 */
export function createMockPayPal({ tokens, now = () => new Date(), onWebhook = null, latencyMs = 0, sendStatus = 'SENT', webhookId = MOCK_WEBHOOK_ID } = {}) {
  const subs = new Map([[MOCK_SUBSCRIPTION_ID, seedSubscription(now())]]);
  const plans = new Map([[MOCK_PLAN_ID, seedPlan()]]);
  const invoices = new Map();
  const charges = new Map([[MOCK_SUBSCRIPTION_ID, [mockCharge({ time: lastBillingTime(now()) })]]]);
  const holds = new Map([[MOCK_HOLD_ID, seedHold(now())]]);
  // Sponsor captures by id, with what each hold has given and which request made them, as PayPal keeps them.
  const captures = new Map();
  const replays = new Map();
  const refundedCents = new Map();
  const bornAt = now().toISOString();
  const produced = new Map();
  const events = [];
  const counters = { invoice: 0, debug: 0, event: 0 };

  const debug = () => `mock-${(counters.debug += 1).toString(16).padStart(6, '0')}`;
  const wait = async () => { if (latencyMs > 0) await sleep(latencyMs); };
  const reply = (data) => ({ data: structuredClone(data), debugId: debug(), ms: latencyMs });
  const done = () => ({ debugId: debug(), ms: latencyMs });
  const fail = (status, name, message, issue) => {
    throw new PayPalError({ status, name, message, debugId: debug(), details: issue ? [{ field: null, issue, description: message }] : [] });
  };

  function authorize(token, kind, id, ctx, binding) {
    if (!tokens || typeof tokens.consume !== 'function') throw new WriteNotAuthorized('no_token_store');
    tokens.consume(token, { kind, targetId: id, callId: ctx?.callId, ...(binding ? { binding } : {}) });
  }

  async function read(map, id) {
    safeId(id);
    await wait();
    const found = map.get(id);
    return found ? reply(found) : { notFound: true, debugId: debug(), ms: latencyMs };
  }

  /** The subscription's charges inside the window, as PayPal lists them. A subscription the mock lacks is a 404. */
  async function listCharges(id, window) {
    safeId(id);
    const { start_time: start, end_time: end } = chargeWindow(window);
    await wait();
    if (!subs.has(id)) return { notFound: true, debugId: debug(), ms: latencyMs };
    const inside = (charges.get(id) ?? []).filter((t) => t.time >= start && t.time <= end);
    return reply({ transactions: inside, total_items: inside.length, total_pages: 1 });
  }

  const findCharge = (id) => [...charges.values()].flat().find((t) => t.id === id) ?? null;

  /** A subscription's transaction reads as a capture too, as Keepwell's spike found (Q1). */
  function chargeAsCapture(t) {
    const gross = t.amount_with_breakdown?.gross_amount;
    return { id: t.id, status: t.status, amount: gross ? { currency_code: gross.currency_code, value: gross.value } : null, final_capture: true, create_time: t.time,
      seller_receivable_breakdown: { paypal_fee: t.amount_with_breakdown?.fee_amount ?? null } };
  }

  async function readCapture(id) {
    safeId(id);
    await wait();
    const found = captures.get(id) ?? (findCharge(id) ? chargeAsCapture(findCharge(id)) : null);
    return found ? reply(found) : { notFound: true, debugId: debug(), ms: latencyMs };
  }

  /** A second request with the same PayPal-Request-Id gets the first answer back and moves nothing, per Keepwell's spike. */
  const replayOf = (requestId) => (requestId && replays.has(requestId) ? { ...replays.get(requestId), status: captures.get(replays.get(requestId).id)?.status ?? replays.get(requestId).status, debugId: debug(), ms: latencyMs } : null);

  function remember(requestId, answer) {
    if (requestId) replays.set(requestId, answer);
    return { ...answer, debugId: debug(), ms: latencyMs };
  }

  async function captureSponsorHold(holdId, token, ctx) {
    authorize(token, 'cover_capture', holdId, ctx, moneyBinding(ctx?.amountValue, ctx?.currency));
    await wait();
    const replay = replayOf(ctx.requestId);
    if (replay) return replay;
    const hold = holds.get(holdId);
    if (!hold) fail(404, 'RESOURCE_NOT_FOUND', 'The specified resource does not exist.');
    if (!['CREATED', 'PARTIALLY_CAPTURED'].includes(hold.status)) fail(422, 'UNPROCESSABLE_ENTITY', 'The authorization cannot be captured.', 'AUTHORIZATION_ALREADY_CAPTURED');
    if (Date.parse(hold.expiration_time) <= now().getTime()) fail(422, 'UNPROCESSABLE_ENTITY', 'The authorization has expired.', 'AUTHORIZATION_EXPIRED');
    const taken = [...captures.values()].filter((c) => c.hold_id === holdId && c.status !== 'REFUNDED').reduce((sum, c) => sum + toCents(c.amount.value), 0);
    if (taken + toCents(ctx.amountValue) > toCents(hold.amount.value)) fail(422, 'UNPROCESSABLE_ENTITY', 'The capture is more than the authorization has left.', 'MAX_CAPTURE_AMOUNT_EXCEEDED');
    counters.capture = (counters.capture ?? 0) + 1;
    const id = `MOCKCAP${String(counters.capture).padStart(10, '0')}`;
    const capture = { id, hold_id: holdId, status: 'COMPLETED', amount: { currency_code: ctx.currency, value: String(ctx.amountValue) }, final_capture: false,
      seller_receivable_breakdown: { paypal_fee: { currency_code: ctx.currency, value: mockFee(ctx.amountValue) } } };
    captures.set(id, capture);
    holds.set(holdId, { ...hold, status: 'PARTIALLY_CAPTURED' });
    return remember(ctx.requestId, { id, status: capture.status, amountValue: capture.amount.value });
  }

  /** A refund of a charge or a capture, which PayPal keeps its own status for. It never refunds more than is left. */
  function refund(id, ctx) {
    const charge = findCharge(id);
    const capture = captures.get(id);
    if (!charge && !capture) fail(404, 'RESOURCE_NOT_FOUND', 'The specified resource does not exist.');
    const gross = charge ? charge.amount_with_breakdown?.gross_amount?.value : capture.amount.value;
    const status = charge ? charge.status : capture.status;
    if (status === 'REFUNDED') fail(422, 'UNPROCESSABLE_ENTITY', 'The capture has already been fully refunded.', 'CAPTURE_FULLY_REFUNDED');
    if (!['COMPLETED', 'PARTIALLY_REFUNDED'].includes(status)) fail(422, 'UNPROCESSABLE_ENTITY', 'The capture cannot be refunded.', 'INVALID_RESOURCE_STATE');
    const total = (refundedCents.get(id) ?? 0) + toCents(ctx.amountValue);
    if (total > toCents(gross)) fail(422, 'UNPROCESSABLE_ENTITY', 'The refund is more than the capture has left.', 'REFUND_AMOUNT_EXCEEDED');
    refundedCents.set(id, total);
    const after = total === toCents(gross) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    if (charge) charge.status = after;
    if (capture) captures.set(id, { ...capture, status: after });
    counters.refund = (counters.refund ?? 0) + 1;
    return remember(ctx.requestId, { id: `MOCKREF${String(counters.refund).padStart(10, '0')}`, status: 'COMPLETED', amountValue: String(ctx.amountValue) });
  }

  async function refundCharge(transactionId, token, ctx) {
    authorize(token, 'cover_refund', transactionId, ctx, moneyBinding(ctx?.amountValue, ctx?.currency));
    await wait();
    return replayOf(ctx.requestId) ?? refund(transactionId, ctx);
  }

  async function unwindSponsorCapture(holdId, token, ctx) {
    authorize(token, 'cover_unwind', holdId, ctx, moneyBinding(ctx?.amountValue, ctx?.currency));
    await wait();
    if (captures.get(ctx.captureId)?.hold_id !== holdId) fail(404, 'RESOURCE_NOT_FOUND', 'The specified resource does not exist.');
    return replayOf(ctx.requestId) ?? refund(ctx.captureId, ctx);
  }

  async function subscriptionWrite(kind, id, token, ctx, from, to) {
    authorize(token, kind, id, ctx);
    await wait();
    // PayPal's sandbox test ids for a suspend that fails on purpose, ERRSUB062 with 422 and ERRSUB059 with 500 (A12).
    const drill = kind === 'suspend' ? drillByWriteId(id) : null;
    if (drill) fail(drill.httpStatus, drill.name, drill.message);
    const sub = subs.get(id);
    if (!sub) fail(404, 'RESOURCE_NOT_FOUND', 'The specified resource does not exist.');
    if (!from.includes(sub.status)) fail(422, 'UNPROCESSABLE_ENTITY', 'The requested action could not be performed.', 'SUBSCRIPTION_STATUS_INVALID');
    subs.set(id, { ...sub, status: to, status_update_time: now().toISOString() });
    return done();
  }

  async function createDraftInvoice({ recipientEmail, amountValue, currency, orgName }) {
    if (typeof recipientEmail !== 'string' || !recipientEmail.includes('@')) fail(400, 'BAD_RECIPIENT', 'No email on file');
    if (!MONEY_PATTERN.test(String(amountValue))) fail(400, 'BAD_AMOUNT', 'Amount must have two decimals');
    await wait();
    counters.invoice += 1;
    const number = String(counters.invoice).padStart(4, '0');
    const id = `INV2-MOCK-${number}`;
    const money = { currency_code: currency, value: String(amountValue) };
    const invoice = {
      id,
      status: 'DRAFT',
      detail: {
        invoice_number: number,
        currency_code: currency,
        note: `Thank you for your gift to ${orgName}.`,
        metadata: { create_time: now().toISOString(), recipient_view_url: `https://example.invalid/mock-invoice/${id}` },
      },
      invoicer: { business_name: orgName },
      primary_recipients: [{ billing_info: { email_address: recipientEmail } }],
      items: [{ name: 'One-time gift', quantity: '1', unit_amount: money, unit_of_measure: 'AMOUNT' }],
      amount: money,
      due_amount: money,
    };
    invoices.set(id, invoice);
    return { id, data: structuredClone(invoice), debugId: debug(), ms: latencyMs };
  }

  async function deleteDraftInvoice(id) {
    safeId(id);
    await wait();
    const invoice = invoices.get(id);
    if (!invoice) fail(404, 'RESOURCE_NOT_FOUND', 'The specified resource does not exist.');
    if (!['DRAFT', 'SCHEDULED'].includes(invoice.status)) fail(422, 'UNPROCESSABLE_ENTITY', 'Only draft or scheduled invoices can be deleted.');
    invoices.delete(id);
    return done();
  }

  async function sendInvoice(id, token, ctx) {
    authorize(token, 'send_invoice', id, ctx);
    await wait();
    const invoice = invoices.get(id);
    if (!invoice) fail(404, 'RESOURCE_NOT_FOUND', 'The specified resource does not exist.');
    if (invoice.status !== 'DRAFT') fail(422, 'UNPROCESSABLE_ENTITY', 'Only a draft invoice can be sent.');
    invoices.set(id, { ...invoice, status: sendStatus });
    return { ...done(), status: 200 };
  }

  async function emit(event) {
    const rawBody = Buffer.from(JSON.stringify(event, null, 1), 'utf8');
    const headers = {
      'content-type': 'application/json',
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-MOCK',
      'paypal-transmission-id': randomUUID(),
      'paypal-transmission-sig': 'mock-signature',
      'paypal-transmission-time': now().toISOString(),
    };
    produced.set(headers['paypal-transmission-id'], sha256(rawBody));
    if (onWebhook) await onWebhook({ event, rawBody, headers });
    return { event, rawBody, headers };
  }

  async function mockPay(invoiceId) {
    const invoice = invoices.get(invoiceId);
    if (!invoice) fail(404, 'RESOURCE_NOT_FOUND', 'The specified resource does not exist.');
    if (!['SENT', 'UNPAID'].includes(invoice.status)) fail(422, 'UNPROCESSABLE_ENTITY', 'Only a sent invoice can be paid.');
    const paid = { ...invoice, status: 'PAID', due_amount: { currency_code: invoice.amount.currency_code, value: '0.00' } };
    invoices.set(invoiceId, paid);
    counters.event += 1;
    const event = {
      id: `WH-MOCK${String(counters.event).padStart(4, '0')}-${randomUUID().slice(0, 8).toUpperCase()}`,
      event_version: '1.0',
      create_time: now().toISOString(),
      resource_type: 'invoices',
      resource_version: '2.0',
      event_type: 'INVOICING.INVOICE.PAID',
      summary: 'An invoice was paid',
      resource: { id: invoiceId, status: 'PAID', detail: { invoice_number: paid.detail.invoice_number }, amount: paid.amount },
      links: [],
    };
    events.push(event);
    return emit(event);
  }

  async function verifyWebhookSignature({ headers, rawBody, webhookId: givenId }) {
    const picked = pickVerifyHeaders(headers);
    if (!picked) return { verified: false, verifyStatus: 'MISSING_HEADERS' };
    if (!givenId) return { verified: false, verifyStatus: 'NO_WEBHOOK_ID' };
    await wait();
    const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
    const known = produced.get(picked['paypal-transmission-id']);
    const ok = givenId === webhookId && known !== undefined && known === sha256(raw);
    return { verified: ok, verifyStatus: ok ? 'SUCCESS' : 'FAILURE', debugId: debug() };
  }

  return {
    mode: 'mock',
    warmUp: async () => true,
    tokenScope: () => 'mock',
    getSubscription: (id) => read(subs, id),
    getPlan: (id) => read(plans, id),
    getInvoice: (id) => read(invoices, id),
    getSubscriptionCharges: listCharges,
    getSponsorHold: (id) => read(holds, id),
    getCapture: readCapture,
    captureSponsorHold,
    refundCharge,
    unwindSponsorCapture,
    // The ledger outlives a mock, whose money restarts with the server, so only covers since then count against it.
    historyStart: bornAt,
    createDraftInvoice,
    deleteDraftInvoice,
    suspendSubscription: (id, token, ctx) => subscriptionWrite('suspend', id, token, ctx, ['ACTIVE'], 'SUSPENDED'),
    activateSubscription: (id, token, ctx) => subscriptionWrite('activate', id, token, ctx, ['SUSPENDED'], 'ACTIVE'),
    cancelSubscription: (id, token, ctx) => subscriptionWrite('cancel', id, token, ctx, ['ACTIVE', 'SUSPENDED'], 'CANCELLED'),
    sendInvoice,
    verifyWebhookSignature,
    mockPay,
    /** Changes the sponsor's hold, for tests of a hold that expired, was voided or is too small. */
    mockSetHold: (id, patch) => { holds.set(id, { ...(holds.get(id) ?? seedHold(now(), id)), ...patch }); },
    mockRemoveHold: (id) => { holds.delete(id); },
    /** What the mock moved, so a test can check PayPal's side rather than the line's own words. */
    mockMoney: () => ({ captures: structuredClone([...captures.values()]), refunded: Object.fromEntries(refundedCents), holds: structuredClone([...holds.values()]) }),
    /** Replaces a subscription's charges, for tests of a newer charge, none at all, or one PayPal returns half filled. */
    mockSetCharges: (id, list) => { charges.set(id, structuredClone(list)); },
    mockSetSubscriptionStatus: (id, status) => {
      const sub = subs.get(id);
      if (sub) subs.set(id, { ...sub, status });
    },
    ...createMockSetup({ wait, debug, latencyMs, events, emit }),
  };
}

function createMockSetup({ wait, debug, latencyMs, events, emit }) {
  const webhooks = [];
  return {
    createSponsorOrder: async () => { await wait(); return { id: 'ORDER-MOCK0000001', status: 'CREATED', approveUrl: 'https://example.invalid/mock-order-approve', debugId: debug(), ms: latencyMs }; },
    authorizeSponsorOrder: async () => { await wait(); return { holdId: MOCK_HOLD_ID, status: 'CREATED', expirationTime: null, debugId: debug(), ms: latencyMs }; },
    createProduct: async () => { await wait(); return { id: 'PROD-MOCK0000001', debugId: debug(), ms: latencyMs }; },
    createPlan: async () => { await wait(); return { id: MOCK_PLAN_ID, status: 'ACTIVE', debugId: debug(), ms: latencyMs }; },
    createSubscription: async () => {
      await wait();
      return { id: MOCK_SUBSCRIPTION_ID, status: 'APPROVAL_PENDING', approveUrl: 'https://example.invalid/mock-approve', debugId: debug(), ms: latencyMs };
    },
    listWebhooks: async () => { await wait(); return { webhooks: structuredClone(webhooks), debugId: debug(), ms: latencyMs }; },
    createWebhook: async ({ url, eventTypes }) => {
      await wait();
      const hook = { id: MOCK_WEBHOOK_ID, url, event_types: eventTypes.map((name) => ({ name })) };
      webhooks.push(hook);
      return { id: hook.id, data: structuredClone(hook), debugId: debug(), ms: latencyMs };
    },
    listWebhookEvents: async ({ eventType }) => {
      await wait();
      return { events: structuredClone(events.filter((e) => e.event_type === eventType)), debugId: debug(), ms: latencyMs };
    },
    resendWebhookEvent: async (eventId) => {
      const event = events.find((e) => e.id === eventId);
      if (!event) throw new PayPalError({ status: 404, name: 'RESOURCE_NOT_FOUND', message: 'No such event', debugId: debug() });
      await emit(structuredClone(event));
      return { status: 202, debugId: debug(), ms: latencyMs };
    },
  };
}
