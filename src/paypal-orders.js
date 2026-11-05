// Procurement uses explicit API credentials and the PayPal sandbox only.
const BASE = 'https://api-m.sandbox.paypal.com';
const ID = /^[A-Z0-9]{8,40}$/;
const REQUEST_ID = /^[a-zA-Z0-9-]{1,108}$/;
const MAX_RESPONSE_BYTES = 262144;

export class SandboxOrdersError extends Error {
  constructor(code = 'PAYPAL_SANDBOX_UNAVAILABLE', status = 0) {
    super(code);
    this.name = 'SandboxOrdersError';
    this.code = code;
    this.status = status;
  }
}

export function usdCents(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,6})\.\d{2}$/.test(value)) throw new SandboxOrdersError('PAYPAL_AMOUNT_INVALID');
  const cents = Number(value.replace('.', ''));
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new SandboxOrdersError('PAYPAL_AMOUNT_INVALID');
  return cents;
}

export function sandboxApprovalUrl(value, orderId) {
  try {
    if (typeof orderId !== 'string' || !ID.test(orderId)) throw new Error();
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'www.sandbox.paypal.com' || url.port || url.username || url.password ||
      url.pathname !== '/checkoutnow' || url.hash || url.searchParams.getAll('token').length !== 1 || url.searchParams.get('token') !== orderId) {
      throw new Error();
    }
    return `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`;
  } catch { throw new SandboxOrdersError('PAYPAL_APPROVAL_URL_INVALID'); }
}

function callbackUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new SandboxOrdersError('CHECKOUT_CALLBACK_INVALID'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.hash || value.length > 1800) {
    throw new SandboxOrdersError('CHECKOUT_CALLBACK_INVALID');
  }
  return url.toString();
}

function checkAbort(signal) {
  if (signal?.aborted) throw new SandboxOrdersError('PAYPAL_SANDBOX_ABORTED');
}
function checkResponseAbort(response, signal) {
  if (signal?.aborted) void response.body?.cancel().catch(() => {});
  checkAbort(signal);
}

async function jsonResponse(response, signal) {
  checkResponseAbort(response, signal);
  if (!response.body) throw new SandboxOrdersError('PAYPAL_RESPONSE_INVALID', response.status);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      checkAbort(signal);
      const { done, value } = await reader.read();
      checkAbort(signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new SandboxOrdersError('PAYPAL_RESPONSE_INVALID', response.status);
      }
      chunks.push(value);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch (error) {
    checkAbort(signal);
    if (error instanceof SandboxOrdersError) throw error;
    throw new SandboxOrdersError('PAYPAL_RESPONSE_INVALID', response.status);
  } finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
}

export function createSandboxOrders({ clientId, clientSecret, fetchImpl = globalThis.fetch, now = () => Date.now(),
  readOnly = false, timeoutMs = readOnly ? 3000 : 15000 } = {}) {
  if (![clientId, clientSecret].every((v) => typeof v === 'string' && v.trim() && v.length <= 512 && !/[\r\n]/.test(v))) {
    throw new SandboxOrdersError('PAYPAL_SANDBOX_CREDENTIALS_REQUIRED');
  }
  if (typeof readOnly !== 'boolean') throw new SandboxOrdersError('PAYPAL_READ_ONLY_INVALID');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > (readOnly ? 3000 : 60000)) throw new SandboxOrdersError('PAYPAL_TIMEOUT_INVALID');
  function requestSignal(signal) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new SandboxOrdersError('PAYPAL_SIGNAL_INVALID');
    checkAbort(signal);
    return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  }
  let token = null;
  let pendingToken = null;
  async function accessToken(signal) {
    checkAbort(signal);
    if (token && token.until > now()) return token.value;
    if (pendingToken) return pendingToken;
    pendingToken = (async () => {
      let response;
      const authSignal = requestSignal(signal);
      try {
        response = await fetchImpl(`${BASE}/v1/oauth2/token`, {
          method: 'POST', redirect: 'error', signal: authSignal,
          headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=client_credentials',
        });
      } catch { checkAbort(authSignal); throw new SandboxOrdersError(); }
      checkResponseAbort(response, authSignal);
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new SandboxOrdersError('PAYPAL_SANDBOX_AUTH_FAILED', response.status);
      }
      const data = await jsonResponse(response, authSignal);
      if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 4096 ||
        !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new SandboxOrdersError('PAYPAL_RESPONSE_INVALID');
      token = { value: data.access_token, until: now() + Math.max(0, data.expires_in * 1000 - 60000) };
      return token.value;
    })();
    try { return await pendingToken; } finally { pendingToken = null; }
  }
  async function request(path, method = 'GET', body, requestId, signal) {
    checkAbort(signal);
    const bearer = await accessToken(signal);
    const readSignal = requestSignal(signal);
    let response;
    try {
      response = await fetchImpl(`${BASE}${path}`, {
        method, redirect: 'error', signal: readSignal,
        headers: { Authorization: `Bearer ${bearer}`, 'content-type': 'application/json', Prefer: 'return=representation',
          ...(requestId ? { 'PayPal-Request-Id': requestId } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch { checkAbort(readSignal); throw new SandboxOrdersError(); }
    checkResponseAbort(response, readSignal);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new SandboxOrdersError('PAYPAL_SANDBOX_REQUEST_FAILED', response.status);
    }
    return jsonResponse(response, readSignal);
  }
  function id(value) {
    if (typeof value !== 'string' || !ID.test(value)) throw new SandboxOrdersError('PAYPAL_ID_INVALID');
    return value;
  }
  function requestIdentity(value) {
    if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw new SandboxOrdersError('PAYPAL_REQUEST_ID_REQUIRED');
    return value;
  }
  const reads = {
    mode: 'paypal-sandbox',
    getOrder: (orderId, { signal } = {}) => request(`/v2/checkout/orders/${id(orderId)}`, 'GET', undefined, undefined, signal),
    getCapture: (captureId, { signal } = {}) => request(`/v2/payments/captures/${id(captureId)}`, 'GET', undefined, undefined, signal),
  };
  if (readOnly) return Object.freeze(reads);
  return {
    ...reads,
    async createOrder({ requestId, payeeId, amountCents, currency, referenceId, returnUrl, cancelUrl }) {
      requestIdentity(requestId);
      id(payeeId);
      if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 100000000 || currency !== 'USD' ||
        typeof referenceId !== 'string' || !/^[A-Za-z0-9-]{1,127}$/.test(referenceId)) throw new SandboxOrdersError('PAYPAL_ORDER_BINDING_INVALID');
      const value = `${Math.floor(amountCents / 100)}.${String(amountCents % 100).padStart(2, '0')}`;
      return request('/v2/checkout/orders', 'POST', {
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: referenceId, custom_id: referenceId,
          amount: { currency_code: currency, value }, payee: { merchant_id: payeeId } }],
        payment_source: { paypal: { experience_context: { return_url: callbackUrl(returnUrl), cancel_url: callbackUrl(cancelUrl),
          user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' } } },
      }, requestId);
    },
    captureOrder: ({ id: orderId, requestId }) => request(`/v2/checkout/orders/${id(orderId)}/capture`, 'POST', {}, requestIdentity(requestId)),
  };
}
