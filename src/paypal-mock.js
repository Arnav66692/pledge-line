import { createHash, randomUUID } from 'node:crypto';
import { PayPalError, WriteNotAuthorized, safeId, pickVerifyHeaders } from './paypal.js';
import { MOCK_SUBSCRIPTION_ID, MOCK_PLAN_ID, MOCK_WEBHOOK_ID } from './config.js';

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

  function authorize(token, kind, id, ctx) {
    if (!tokens || typeof tokens.consume !== 'function') throw new WriteNotAuthorized('no_token_store');
    tokens.consume(token, { kind, targetId: id, callId: ctx?.callId });
  }

  async function read(map, id) {
    safeId(id);
    await wait();
    const found = map.get(id);
    return found ? reply(found) : { notFound: true, debugId: debug(), ms: latencyMs };
  }

  async function subscriptionWrite(kind, id, token, ctx, from, to) {
    authorize(token, kind, id, ctx);
    await wait();
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
    createDraftInvoice,
    deleteDraftInvoice,
    suspendSubscription: (id, token, ctx) => subscriptionWrite('suspend', id, token, ctx, ['ACTIVE'], 'SUSPENDED'),
    activateSubscription: (id, token, ctx) => subscriptionWrite('activate', id, token, ctx, ['SUSPENDED'], 'ACTIVE'),
    cancelSubscription: (id, token, ctx) => subscriptionWrite('cancel', id, token, ctx, ['ACTIVE', 'SUSPENDED'], 'CANCELLED'),
    sendInvoice,
    verifyWebhookSignature,
    mockPay,
    /** The public demo shares one gift among all visitors, so it puts the seeded gift back when nobody is on a call. */
    resetSubscription: () => { subs.set(MOCK_SUBSCRIPTION_ID, seedSubscription(now())); },
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
