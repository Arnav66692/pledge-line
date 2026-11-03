import { randomUUID } from 'node:crypto';
import { SANDBOX_BASE_URL } from './config.js';
import { moneyBinding } from './cover.js';

const REFRESH_EARLY_MS = 60000;
const ID_PATTERN = /^[A-Za-z0-9-]{1,100}$/;
const MONEY_PATTERN = /^\d{1,7}\.\d{2}$/;
const REASON_MAX = 127;
const REASONS = Object.freeze({
  suspend: 'Donor asked to pause the gift on the donor line',
  activate: 'Donor asked to restart the gift on the donor line',
  cancel: 'Donor asked to cancel the gift on the donor line',
});
const VERIFY_HEADERS = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];

export class PayPalError extends Error {
  constructor({ status = 0, name = 'PAYPAL_ERROR', message = 'PayPal error', debugId = null, details = [] } = {}) {
    super(message);
    this.name = name;
    this.status = status;
    this.debugId = debugId;
    this.details = details;
  }
}

export class WriteNotAuthorized extends Error {
  constructor(reason = 'missing') {
    super(`Write not authorized (${reason})`);
    this.name = 'WriteNotAuthorized';
    this.reason = reason;
  }
}

const str = (value) => (typeof value === 'string' && value !== '' ? value : null);

/** Trims a PayPal response down to what the line may speak or show. */
export function toSnapshot(what, data) {
  if (!data || typeof data !== 'object') return null;
  if (what === 'subscription') {
    return {
      id: str(data.id),
      status: str(data.status),
      plan_id: str(data.plan_id),
      next_billing_time: str(data.billing_info?.next_billing_time),
      subscriber_email: str(data.subscriber?.email_address),
      subscriber_given_name: str(data.subscriber?.name?.given_name),
    };
  }
  if (what === 'plan') {
    const cycles = Array.isArray(data.billing_cycles) ? data.billing_cycles : [];
    const price = cycles.find((cycle) => cycle?.tenure_type === 'REGULAR')?.pricing_scheme?.fixed_price;
    return { id: str(data.id), price_value: str(price?.value), price_currency: str(price?.currency_code) };
  }
  if (what === 'charge') return chargeSnapshot(data);
  if (what === 'hold') return holdSnapshot(data);
  if (what === 'capture' || what === 'gift_charge') return captureSnapshot(data);
  if (what === 'invoice') {
    const amount = data.amount ?? data.due_amount;
    const recipients = Array.isArray(data.primary_recipients) ? data.primary_recipients : [];
    return {
      id: str(data.id),
      status: str(data.status),
      number: str(data.detail?.invoice_number),
      amount_value: str(amount?.value),
      amount_currency: str(amount?.currency_code),
      recipient_email: str(recipients[0]?.billing_info?.email_address),
      recipient_view_url: str(data.detail?.metadata?.recipient_view_url),
    };
  }
  throw new Error(`unknown snapshot type ${what}`);
}

/** A sponsor's hold, from GET /v2/payments/authorizations/{id}. PayPal's read has no field for what is left of it. */
function holdSnapshot(data) {
  return { id: str(data.id), status: str(data.status), amount_value: str(data.amount?.value), amount_currency: str(data.amount?.currency_code), expiration_time: str(data.expiration_time) };
}

/**
 * A capture, from GET /v2/payments/captures/{id}. A subscription's transaction id works here too (Keepwell's spike, Q1),
 * which gives the donor's charge its own status beside the list. The fee is what PayPal's breakdown names, for the page.
 */
function captureSnapshot(data) {
  return { id: str(data.id), status: str(data.status), amount_value: str(data.amount?.value), amount_currency: str(data.amount?.currency_code),
    fee_value: str(data.seller_receivable_breakdown?.paypal_fee?.value) };
}

const timeOf = (t) => {
  const ms = Date.parse(t?.time);
  return Number.isNaN(ms) ? -Infinity : ms;
};

/**
 * The latest charge of a subscription's transaction list, the one the line reads aloud, and how many PayPal listed.
 * A list with no charges keeps count 0 and nulls, so the line can say PayPal shows none.
 */
function chargeSnapshot(data) {
  const list = Array.isArray(data.transactions) ? data.transactions.filter((t) => t && typeof t === 'object') : [];
  const latest = list.reduce((best, t) => (best === null || timeOf(t) > timeOf(best) ? t : best), null);
  const gross = latest?.amount_with_breakdown?.gross_amount;
  return {
    transaction_id: str(latest?.id),
    status: str(latest?.status),
    amount_value: str(gross?.value),
    amount_currency: str(gross?.currency_code),
    time: str(latest?.time),
    count: list.length,
    // Charges in the window PayPal already shows as refunded, which Covered Month's yearly rule counts.
    refunded_count: list.filter((t) => t.status === 'REFUNDED' || t.status === 'PARTIALLY_REFUNDED').length,
  };
}

/** start_time and end_time as PayPal's list call wants them, ISO 8601 in UTC. */
export function chargeWindow({ startTime, endTime }) {
  const start = new Date(startTime);
  const end = new Date(endTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    throw new PayPalError({ status: 400, name: 'INVALID_WINDOW', message: 'That time window is not valid' });
  }
  return { start_time: start.toISOString(), end_time: end.toISOString() };
}

export function safeId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new PayPalError({ status: 400, name: 'INVALID_ID', message: 'That PayPal id is not valid' });
  }
  return encodeURIComponent(id);
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toPayPalError(status, data, debugId) {
  const details = Array.isArray(data?.details)
    ? data.details.map((d) => ({ field: str(d?.field), issue: str(d?.issue), description: str(d?.description) }))
    : [];
  return new PayPalError({
    status,
    name: str(data?.name) ?? str(data?.error) ?? `HTTP_${status}`,
    message: str(data?.message) ?? str(data?.error_description) ?? `PayPal returned ${status}`,
    debugId,
    details,
  });
}

function networkError(error) {
  const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
  return new PayPalError({
    status: 0,
    name: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
    message: timedOut ? 'PayPal did not answer in time' : 'Could not reach PayPal',
  });
}

export function pickVerifyHeaders(headers) {
  const picked = {};
  for (const name of VERIFY_HEADERS) {
    const value = headers?.[name];
    if (typeof value !== 'string' || value === '') return null;
    picked[name] = value;
  }
  return picked;
}

/** The verify body is built around the raw bytes so webhook_event is exactly what PayPal sent. */
export function buildVerifyBody(h, webhookId, rawBody) {
  const head = '{"auth_algo":' + JSON.stringify(h['paypal-auth-algo'])
    + ',"cert_url":' + JSON.stringify(h['paypal-cert-url'])
    + ',"transmission_id":' + JSON.stringify(h['paypal-transmission-id'])
    + ',"transmission_sig":' + JSON.stringify(h['paypal-transmission-sig'])
    + ',"transmission_time":' + JSON.stringify(h['paypal-transmission-time'])
    + ',"webhook_id":' + JSON.stringify(webhookId)
    + ',"webhook_event":';
  return Buffer.concat([Buffer.from(head, 'utf8'), rawBody, Buffer.from('}', 'utf8')]);
}

function idFromHref(href) {
  if (typeof href !== 'string') return null;
  const last = href.split('?')[0].split('/').filter(Boolean).pop();
  return last && ID_PATTERN.test(last) ? last : null;
}

function createTransport({ baseUrl, clientId, clientSecret, fetchImpl, timeoutMs }) {
  let cached = null;
  let inflight = null;

  async function send(url, init) {
    let res;
    let text = '';
    const started = performance.now();
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      text = res.status === 204 ? '' : await res.text();
    } catch (error) {
      throw networkError(error);
    }
    const data = parseJson(text);
    const debugId = res.headers.get('paypal-debug-id') ?? str(data?.debug_id) ?? str(data?.debugId);
    return { res, data, debugId, ms: Math.round(performance.now() - started) };
  }

  async function fetchToken() {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const { res, data, debugId } = await send(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw toPayPalError(res.status, data, debugId);
    if (!str(data?.access_token) || !Number.isFinite(data?.expires_in)) {
      throw new PayPalError({ status: res.status, name: 'BAD_TOKEN_RESPONSE', message: 'PayPal sent an unusable token', debugId });
    }
    cached = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000, scope: str(data.scope) };
    return cached;
  }

  async function accessToken() {
    if (cached && Date.now() < cached.expiresAt - REFRESH_EARLY_MS) return cached.accessToken;
    if (!inflight) inflight = fetchToken().finally(() => { inflight = null; });
    return (await inflight).accessToken;
  }

  async function request(method, pathname, { body, rawBody, headers = {}, idempotent = false, requestId = null, allow404 = false } = {}) {
    const token = await accessToken();
    const init = {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    };
    // Only the creates declare or recommend PayPal-Request-Id (see .pilot/facts-paypal.md).
    if (idempotent) init.headers['PayPal-Request-Id'] = randomUUID();
    // A money leg's id comes from the charge, so a retry or a double submit replays the same move (cover.js).
    if (requestId) init.headers['PayPal-Request-Id'] = requestId;
    if (rawBody !== undefined) init.body = rawBody;
    else if (body !== undefined) init.body = JSON.stringify(body);
    const { res, data, debugId, ms } = await send(`${baseUrl}${pathname}`, init);
    if (allow404 && res.status === 404) return { notFound: true, status: 404, debugId, ms };
    if (!res.ok) throw toPayPalError(res.status, data, debugId);
    return { status: res.status, data, debugId, ms };
  }

  return { request, accessToken, scope: () => cached?.scope ?? null };
}

export function createPayPal({ baseUrl, clientId, clientSecret, tokens, fetchImpl = fetch, timeoutMs = 10000 }) {
  if (baseUrl !== SANDBOX_BASE_URL) throw new Error(`PayPal base URL must be ${SANDBOX_BASE_URL}`);
  const { request, accessToken, scope } = createTransport({ baseUrl, clientId, clientSecret, fetchImpl, timeoutMs });

  function authorize(token, kind, id, ctx, binding) {
    if (!tokens || typeof tokens.consume !== 'function') throw new WriteNotAuthorized('no_token_store');
    tokens.consume(token, { kind, targetId: id, callId: ctx?.callId, ...(binding ? { binding } : {}) });
  }

  /** A money leg's amount from its token's exact binding, in PayPal's shape, or a refusal before any network call. */
  function moneyOf(ctx) {
    if (!MONEY_PATTERN.test(String(ctx?.amountValue))) throw new PayPalError({ status: 400, name: 'BAD_AMOUNT', message: 'Amount must have two decimals' });
    return { value: String(ctx.amountValue), currency_code: ctx.currency };
  }

  /** The move's own answer: its id, its status and the amount PayPal says it moved, so the line checks them before the next leg. */
  const moved = (res) => ({ id: str(res.data?.id), status: str(res.data?.status) ?? str(res.data?.state)?.toUpperCase() ?? null,
    amountValue: str(res.data?.amount?.value) ?? str(res.data?.amount?.total), debugId: res.debugId, ms: res.ms });

  /** One authorized draw on the sponsor's hold. final_capture false leaves the hold open for later months. No items, so no donation-item permission is needed. */
  async function captureSponsorHold(holdId, token, ctx) {
    authorize(token, 'cover_capture', holdId, ctx, moneyBinding(ctx?.amountValue, ctx?.currency));
    const amount = moneyOf(ctx);
    const res = await request('POST', `/v2/payments/authorizations/${safeId(holdId)}/capture`, {
      body: { amount, final_capture: false, note_to_payer: ctx.note }, requestId: ctx.requestId, headers: { Prefer: 'return=representation' } });
    return moved(res);
  }

  /** The refund of a capture, v2 first. Only a 404 falls back to v1's sale refund, since a 404 means v2 moved nothing. */
  async function refundById(id, ctx) {
    const amount = moneyOf(ctx);
    const headers = { Prefer: 'return=representation' };
    const v2 = await request('POST', `/v2/payments/captures/${safeId(id)}/refund`, { body: { amount, note_to_payer: ctx.note }, requestId: ctx.requestId, headers, allow404: true });
    if (!v2.notFound) return moved(v2);
    return moved(await request('POST', `/v1/payments/sale/${safeId(id)}/refund`, { body: { amount: { total: amount.value, currency: amount.currency_code } }, requestId: ctx.requestId }));
  }

  async function read(pathname) {
    const res = await request('GET', pathname, { allow404: true });
    if (res.notFound) return { notFound: true, debugId: res.debugId, ms: res.ms };
    return { data: res.data, debugId: res.debugId, ms: res.ms };
  }

  async function subscriptionWrite(action, kind, id, token, ctx) {
    authorize(token, kind, id, ctx);
    const reason = REASONS[kind].slice(0, REASON_MAX);
    const res = await request('POST', `/v1/billing/subscriptions/${safeId(id)}/${action}`, { body: { reason } });
    return { debugId: res.debugId, ms: res.ms };
  }

  async function createDraftInvoice({ recipientEmail, amountValue, currency, orgName }) {
    if (typeof recipientEmail !== 'string' || !recipientEmail.includes('@')) throw new PayPalError({ status: 400, name: 'BAD_RECIPIENT', message: 'No email on file' });
    if (!MONEY_PATTERN.test(String(amountValue))) throw new PayPalError({ status: 400, name: 'BAD_AMOUNT', message: 'Amount must have two decimals' });
    const body = {
      detail: { currency_code: currency, note: `Thank you for your gift to ${orgName}.` },
      invoicer: { business_name: orgName },
      primary_recipients: [{ billing_info: { email_address: recipientEmail } }],
      items: [{ name: 'One-time gift', quantity: '1', unit_amount: { currency_code: currency, value: String(amountValue) }, unit_of_measure: 'AMOUNT' }],
    };
    const res = await request('POST', '/v2/invoicing/invoices', { body, idempotent: true, headers: { Prefer: 'return=representation' } });
    const id = str(res.data?.id) ?? idFromHref(res.data?.href);
    if (!id) throw new PayPalError({ status: res.status, name: 'NO_INVOICE_ID', message: 'PayPal did not return an invoice id', debugId: res.debugId });
    return { id, data: res.data, debugId: res.debugId, ms: res.ms };
  }

  async function verifyWebhookSignature({ headers, rawBody, webhookId }) {
    const picked = pickVerifyHeaders(headers);
    if (!picked) return { verified: false, verifyStatus: 'MISSING_HEADERS' };
    if (!webhookId) return { verified: false, verifyStatus: 'NO_WEBHOOK_ID' };
    const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
    if (raw.length === 0) return { verified: false, verifyStatus: 'EMPTY_BODY' };
    try {
      const res = await request('POST', '/v1/notifications/verify-webhook-signature', { rawBody: buildVerifyBody(picked, webhookId, raw) });
      const status = str(res.data?.verification_status) ?? 'UNKNOWN';
      return { verified: status === 'SUCCESS', verifyStatus: status, debugId: res.debugId };
    } catch (error) {
      if (!(error instanceof PayPalError)) throw error;
      return { verified: false, verifyStatus: `ERROR_${error.name}`, debugId: error.debugId };
    }
  }

  return {
    mode: 'sandbox',
    warmUp: async () => { await accessToken(); return true; },
    tokenScope: scope,
    getSubscription: (id) => read(`/v1/billing/subscriptions/${safeId(id)}`),
    getPlan: (id) => read(`/v1/billing/plans/${safeId(id)}`),
    getInvoice: (id) => read(`/v2/invoicing/invoices/${safeId(id)}`),
    // Read only, the one call the charge check makes. Covered Month's money legs are the token-gated calls below (PICK.md).
    getSubscriptionCharges: async (id, window) => read(`/v1/billing/subscriptions/${safeId(id)}/transactions?${new URLSearchParams(chargeWindow(window))}`),
    getSponsorHold: (id) => read(`/v2/payments/authorizations/${safeId(id)}`),
    getCapture: (id) => read(`/v2/payments/captures/${safeId(id)}`),
    captureSponsorHold,
    refundCharge: async (transactionId, token, ctx) => {
      authorize(token, 'cover_refund', transactionId, ctx, moneyBinding(ctx?.amountValue, ctx?.currency));
      return refundById(transactionId, ctx);
    },
    // Gives the sponsor's capture back when the donor's refund failed. Its token is bound to the hold, and the capture must be this yes's own.
    unwindSponsorCapture: async (holdId, token, ctx) => {
      authorize(token, 'cover_unwind', holdId, ctx, moneyBinding(ctx?.amountValue, ctx?.currency));
      return refundById(ctx.captureId, ctx);
    },
    createDraftInvoice,
    deleteDraftInvoice: async (id) => {
      const res = await request('DELETE', `/v2/invoicing/invoices/${safeId(id)}`);
      return { debugId: res.debugId, ms: res.ms };
    },
    suspendSubscription: (id, token, ctx) => subscriptionWrite('suspend', 'suspend', id, token, ctx),
    activateSubscription: (id, token, ctx) => subscriptionWrite('activate', 'activate', id, token, ctx),
    cancelSubscription: (id, token, ctx) => subscriptionWrite('cancel', 'cancel', id, token, ctx),
    sendInvoice: async (id, token, ctx) => {
      authorize(token, 'send_invoice', id, ctx);
      const res = await request('POST', `/v2/invoicing/invoices/${safeId(id)}/send`, { body: { send_to_recipient: true, send_to_invoicer: true } });
      return { debugId: res.debugId, ms: res.ms, status: res.status };
    },
    verifyWebhookSignature,
    ...createSetupMethods(request),
  };
}

function createSetupMethods(request) {
  const representation = { Prefer: 'return=representation' };
  return {
    // The sponsor's one consent, in the browser. scripts/seed-sponsor-hold.js runs these, never a call. No items, since items.category DONATION can be refused.
    createSponsorOrder: async ({ amountValue, currency, description, brandName, returnUrl, cancelUrl }) => {
      const body = {
        intent: 'AUTHORIZE',
        purchase_units: [{ amount: { currency_code: currency, value: amountValue }, description }],
        application_context: { brand_name: brandName, shipping_preference: 'NO_SHIPPING', user_action: 'CONTINUE', return_url: returnUrl, cancel_url: cancelUrl },
      };
      const res = await request('POST', '/v2/checkout/orders', { body, idempotent: true, headers: representation });
      const links = Array.isArray(res.data?.links) ? res.data.links : [];
      return { id: str(res.data?.id), status: str(res.data?.status), approveUrl: str(links.find((link) => link?.rel === 'approve' || link?.rel === 'payer-action')?.href), debugId: res.debugId, ms: res.ms };
    },
    authorizeSponsorOrder: async (orderId) => {
      const res = await request('POST', `/v2/checkout/orders/${safeId(orderId)}/authorize`, { body: {}, idempotent: true, headers: representation });
      const units = Array.isArray(res.data?.purchase_units) ? res.data.purchase_units : [];
      const auths = Array.isArray(units[0]?.payments?.authorizations) ? units[0].payments.authorizations : [];
      return { holdId: str(auths[0]?.id), status: str(auths[0]?.status), expirationTime: str(auths[0]?.expiration_time), debugId: res.debugId, ms: res.ms };
    },
    createProduct: async ({ name, description }) => {
      const body = { name, type: 'SERVICE', category: 'NONPROFIT', description };
      const res = await request('POST', '/v1/catalogs/products', { body, idempotent: true, headers: representation });
      return { id: str(res.data?.id), data: res.data, debugId: res.debugId, ms: res.ms };
    },
    createPlan: async ({ productId, name, priceValue, currency }) => {
      const body = {
        product_id: productId,
        name,
        billing_cycles: [{
          frequency: { interval_unit: 'MONTH', interval_count: 1 },
          tenure_type: 'REGULAR',
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: { fixed_price: { value: priceValue, currency_code: currency } },
        }],
        payment_preferences: { auto_bill_outstanding: true },
      };
      const res = await request('POST', '/v1/billing/plans', { body, idempotent: true, headers: representation });
      return { id: str(res.data?.id), status: str(res.data?.status), data: res.data, debugId: res.debugId, ms: res.ms };
    },
    createSubscription: async ({ planId, returnUrl, cancelUrl, brandName }) => {
      const body = {
        plan_id: planId,
        application_context: { brand_name: brandName, shipping_preference: 'NO_SHIPPING', user_action: 'SUBSCRIBE_NOW', return_url: returnUrl, cancel_url: cancelUrl },
      };
      const res = await request('POST', '/v1/billing/subscriptions', { body, idempotent: true });
      const links = Array.isArray(res.data?.links) ? res.data.links : [];
      const approveUrl = str(links.find((link) => link?.rel === 'approve')?.href);
      return { id: str(res.data?.id), status: str(res.data?.status), approveUrl, debugId: res.debugId, ms: res.ms };
    },
    listWebhooks: async () => {
      const res = await request('GET', '/v1/notifications/webhooks');
      return { webhooks: Array.isArray(res.data?.webhooks) ? res.data.webhooks : [], debugId: res.debugId, ms: res.ms };
    },
    createWebhook: async ({ url, eventTypes }) => {
      const body = { url, event_types: eventTypes.map((name) => ({ name })) };
      const res = await request('POST', '/v1/notifications/webhooks', { body });
      return { id: str(res.data?.id), data: res.data, debugId: res.debugId, ms: res.ms };
    },
    listWebhookEvents: async ({ eventType, startTime, pageSize = 50 }) => {
      const query = new URLSearchParams({ page_size: String(pageSize), event_type: eventType, start_time: startTime });
      const res = await request('GET', `/v1/notifications/webhooks-events?${query}`);
      return { events: Array.isArray(res.data?.events) ? res.data.events : [], debugId: res.debugId, ms: res.ms };
    },
    resendWebhookEvent: async (eventId, webhookIds) => {
      const res = await request('POST', `/v1/notifications/webhooks-events/${safeId(eventId)}/resend`, { body: { webhook_ids: webhookIds } });
      return { status: res.status, debugId: res.debugId, ms: res.ms };
    },
  };
}
