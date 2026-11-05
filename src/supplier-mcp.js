// Authenticated operator-registered quote transport. Suppliers never report or authorize payments here.
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';

export const SUPPLIER_PROTOCOL_VERSION = '2025-06-18';
const MAX_BYTES = 65536;
const MAX_CENTS = 100000000;
const TOOLS = Object.freeze(['request_quote', 'negotiate_quote', 'get_quote']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const clone = (value) => structuredClone(value);
const QUOTE_FIELDS = new Set(['quoteId', 'supplierId', 'payeeId', 'specificationHash', 'currency', 'minQuantity', 'maxQuantity',
  'unitPriceCents', 'setupCents', 'shippingCents', 'taxBps', 'deliveryAt', 'expiresAt', 'quantity', 'goodsCents', 'taxCents', 'totalCents']);

export class SupplierProtocolError extends Error {
  constructor(code = 'SUPPLIER_UNAVAILABLE') { super(code); this.name = 'SupplierProtocolError'; this.code = code; }
}
const fail = (code) => { throw new SupplierProtocolError(code); };

export function supplierQuoteCosts(quote, quantity) {
  const goodsCents = quote.unitPriceCents * quantity;
  const taxCents = Math.round((goodsCents + quote.setupCents) * quote.taxBps / 10000);
  const totalCents = goodsCents + quote.setupCents + quote.shippingCents + taxCents;
  if (![goodsCents, taxCents, totalCents].every((n) => integer(n, 0, MAX_CENTS))) fail('SUPPLIER_QUOTE_INVALID');
  return { quantity, goodsCents, taxCents, totalCents };
}

export function normalizeSupplierRequest(raw, now = Date.now()) {
  const specification = typeof raw?.specification === 'string' ? raw.specification.trim() : '';
  if (!object(raw) || !integer(raw.quantity, 1, 500) || !integer(raw.budgetCents, 1, MAX_CENTS) || raw.currency !== 'USD' ||
      specification.length < 8 || specification.length > 1000 || typeof raw.deadline !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw.deadline) || !Number.isFinite(Date.parse(raw.deadline)) || Date.parse(raw.deadline) <= now) fail('SUPPLIER_REQUEST_INVALID');
  return { specification, quantity: raw.quantity, budgetCents: raw.budgetCents, currency: 'USD',
    deadline: new Date(raw.deadline).toISOString(), allowSplit: raw.allowSplit !== false };
}

export function validateSupplierQuote(raw, supplier, { request = null, now = Date.now() } = {}) {
  if (!object(raw) || Object.keys(raw).some((key) => !QUOTE_FIELDS.has(key))) fail('SUPPLIER_QUOTE_INVALID');
  if (raw.supplierId !== supplier.id || raw.payeeId !== supplier.payeeId) fail('SUPPLIER_IDENTITY_MISMATCH');
  if (typeof raw.quoteId !== 'string' || !/^[A-Za-z0-9-]{1,120}$/.test(raw.quoteId) || raw.currency !== 'USD' ||
      typeof raw.specificationHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.specificationHash) ||
      !integer(raw.minQuantity, 1, 500) || !integer(raw.maxQuantity, raw.minQuantity, 500) ||
      !integer(raw.unitPriceCents, 1, MAX_CENTS) || !integer(raw.setupCents, 0, MAX_CENTS) ||
      !integer(raw.shippingCents, 0, MAX_CENTS) || !integer(raw.taxBps, 0, 5000)) fail('SUPPLIER_QUOTE_INVALID');
  const expiry = typeof raw.expiresAt === 'string' ? Date.parse(raw.expiresAt) : NaN;
  const delivery = typeof raw.deliveryAt === 'string' ? Date.parse(raw.deliveryAt) : NaN;
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 86400000 || !Number.isFinite(delivery) || delivery < now) fail('SUPPLIER_QUOTE_EXPIRED');
  if (request && (raw.specificationHash !== hash(request.specification) || raw.maxQuantity > request.quantity || delivery > Date.parse(request.deadline))) fail('SUPPLIER_REQUEST_MISMATCH');
  const result = Object.fromEntries(['quoteId', 'supplierId', 'payeeId', 'specificationHash', 'currency', 'minQuantity', 'maxQuantity',
    'unitPriceCents', 'setupCents', 'shippingCents', 'taxBps'].map((key) => [key, raw[key]]));
  result.deliveryAt = new Date(delivery).toISOString(); result.expiresAt = new Date(expiry).toISOString();
  const costs = supplierQuoteCosts(result, result.maxQuantity);
  for (const key of Object.keys(costs)) if (raw[key] !== undefined && raw[key] !== costs[key]) fail('SUPPLIER_COST_MISMATCH');
  return { ...result, ...costs };
}

function loopback(address) { return address === '::1' || (net.isIP(address) === 4 && address.split('.')[0] === '127'); }
export function isPublicSupplierAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || address === '168.63.129.16');
  }
  // Only ordinary global unicast IPv6. Reject mapped, local, multicast, documentation and tunnel ranges.
  if (version !== 6) return false;
  const [head, tail] = address.toLowerCase().split('::');
  const first = head ? head.split(':') : [];
  const last = tail ? tail.split(':') : [];
  const parts = tail === undefined ? first : [...first, ...Array(8 - first.length - last.length).fill('0'), ...last];
  const [prefix, second] = parts.map((part) => Number.parseInt(part, 16));
  return prefix >= 0x2000 && prefix <= 0x3fff && prefix !== 0x2002 &&
    !(prefix === 0x2001 && (second < 0x0200 || second === 0x0db8));
}

export function validateSupplierEndpoint(raw, { allowedHosts = [], allowLocal = false } = {}) {
  let url;
  try { url = new URL(raw); } catch { fail('SUPPLIER_ENDPOINT_INVALID'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = hostname === 'localhost' || loopback(hostname);
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol) ||
      (!allowLocal && (local || (net.isIP(hostname) && !isPublicSupplierAddress(hostname)))) ||
      (url.protocol !== 'https:' && !(allowLocal && local)) ||
      (!local && !allowedHosts.map((host) => String(host).toLowerCase()).includes(hostname)) ||
      (local && !allowLocal)) fail('SUPPLIER_ENDPOINT_INVALID');
  return url;
}

function parseRpcBody(buffer, contentType, id) {
  let data;
  try {
    if (/^text\/event-stream(?:;|$)/i.test(contentType)) {
      const messages = buffer.toString('utf8').split(/\r?\n\r?\n/).map((part) => part.split(/\r?\n/)
        .filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')).filter(Boolean);
      const responses = messages.map((message) => JSON.parse(message)).filter((message) => message.id === id);
      if (responses.length !== 1) fail('SUPPLIER_RESPONSE_INVALID');
      [data] = responses;
    } else if (/^application\/json(?:;|$)/i.test(contentType)) data = JSON.parse(buffer.toString('utf8'));
    else fail('SUPPLIER_RESPONSE_INVALID');
  } catch { fail('SUPPLIER_RESPONSE_INVALID'); }
  if (!object(data) || data.jsonrpc !== '2.0' || data.id !== id || data.error || !object(data.result)) fail('SUPPLIER_RESPONSE_INVALID');
  return data.result;
}

// DNS is resolved and pinned for each HTTP request; TLS still verifies the original hostname.
async function pinnedTransport(url, options, { allowLocal, lookup = dns.lookup } = {}) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses, abortLookup;
  try {
    const aborted = new Promise((_, reject) => {
      abortLookup = () => reject(new SupplierProtocolError('SUPPLIER_UNAVAILABLE'));
      if (options.signal.aborted) abortLookup(); else options.signal.addEventListener('abort', abortLookup, { once: true });
    });
    const resolved = net.isIP(hostname) ? Promise.resolve([{ address: hostname, family: net.isIP(hostname) }])
      : lookup(hostname, { all: true, verbatim: true });
    addresses = await Promise.race([resolved, aborted]);
  }
  catch { fail('SUPPLIER_UNAVAILABLE'); }
  finally { if (abortLookup) options.signal.removeEventListener('abort', abortLookup); }
  const localEndpoint = hostname === 'localhost' || loopback(hostname);
  if (!Array.isArray(addresses) || !addresses.length || addresses.some((item) => !net.isIP(item.address) ||
      (localEndpoint ? !(allowLocal && loopback(item.address)) : !isPublicSupplierAddress(item.address)))) fail('SUPPLIER_ENDPOINT_BLOCKED');
  const selected = addresses[0];
  return await new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'POST', headers: options.headers, signal: options.signal,
      lookup: (_host, settings, callback) => settings?.all
        ? callback(null, [selected]) : callback(null, selected.address, selected.family),
      ...(url.protocol === 'https:' ? { servername: hostname, rejectUnauthorized: true } : {}),
    }, (response) => {
      const chunks = []; let size = 0;
      const sse = /^text\/event-stream(?:;|$)/i.test(response.headers['content-type'] ?? '');
      const rpcId = JSON.parse(options.body).id;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) { response.destroy(); reject(new SupplierProtocolError('SUPPLIER_RESPONSE_TOO_LARGE')); }
        else {
          chunks.push(chunk);
          if (sse && rpcId) {
            const text = Buffer.concat(chunks).toString('utf8').replace(/\r\n/g, '\n');
            const boundary = text.lastIndexOf('\n\n');
            if (boundary >= 0) {
              try {
                const complete = Buffer.from(text.slice(0, boundary + 2));
                parseRpcBody(complete, 'text/event-stream', rpcId);
                resolve({ status: response.statusCode, headers: response.headers, body: complete }); response.destroy();
              } catch { /* A partial stream may contain only notifications before the matching response. */ }
            }
          }
        }
      });
      response.on('error', () => reject(new SupplierProtocolError('SUPPLIER_UNAVAILABLE')));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', () => reject(new SupplierProtocolError('SUPPLIER_UNAVAILABLE')));
    request.end(options.body);
  });
}

export function createMcpSupplier({ id, name, payeeId, endpoint, token, allowedHosts = [], allowLocal = false,
  timeoutMs = 5000, now = () => new Date(), transport = null, lookup = dns.lookup } = {}) {
  if (!/^[a-z0-9-]{1,48}$/.test(id ?? '') || typeof name !== 'string' || !name.trim() || name.length > 100 ||
      !/^[A-Za-z0-9]{8,64}$/.test(payeeId ?? '') || typeof token !== 'string' || token.length < 24 || token.length > 4096 ||
      /[\x00-\x20\x7f]/.test(token) || !Array.isArray(allowedHosts) || typeof allowLocal !== 'boolean' || !integer(timeoutMs, 100, 15000)) fail('SUPPLIER_CONFIGURATION_INVALID');
  const url = validateSupplierEndpoint(endpoint, { allowedHosts, allowLocal });
  let sessionId = null, initialized = null;
  const send = transport ?? ((target, options) => pinnedTransport(target, options, { allowLocal, lookup }));
  const at = () => new Date(now()).getTime();

  async function rpc(method, params, notification = false) {
    const id = notification ? undefined : randomUUID();
    const body = JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, ...(params ? { params } : {}) });
    if (Buffer.byteLength(body) > MAX_BYTES) fail('SUPPLIER_REQUEST_INVALID');
    let response, timer;
    const controller = new AbortController();
    try {
      const timedOut = new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new SupplierProtocolError('SUPPLIER_UNAVAILABLE'));
      }, timeoutMs); });
      response = await Promise.race([send(url, { body, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', 'mcp-protocol-version': SUPPLIER_PROTOCOL_VERSION,
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, signal: controller.signal }), timedOut]);
    } catch (cause) { if (cause instanceof SupplierProtocolError) throw cause; fail('SUPPLIER_UNAVAILABLE'); }
    finally { clearTimeout(timer); }
    if (response?.status === 404 && method === 'tools/call' && sessionId) fail('SUPPLIER_SESSION_EXPIRED');
    if (!response || response.status < 200 || response.status >= 300 || !Buffer.isBuffer(response.body) || response.body.length > MAX_BYTES) fail('SUPPLIER_UNAVAILABLE');
    const receivedId = response.headers?.['mcp-session-id'];
    if (receivedId !== undefined) {
      if (typeof receivedId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(receivedId) || (sessionId && receivedId !== sessionId)) fail('SUPPLIER_RESPONSE_INVALID');
      sessionId = receivedId;
    }
    if (notification) {
      if (![202, 204].includes(response.status) || response.body.length !== 0) fail('SUPPLIER_RESPONSE_INVALID');
      return;
    }
    return parseRpcBody(response.body, String(response.headers?.['content-type'] ?? ''), id);
  }

  async function connect() {
    if (!initialized) {
      const attempt = (async () => {
      const result = await rpc('initialize', { protocolVersion: SUPPLIER_PROTOCOL_VERSION, capabilities: {},
        clientInfo: { name: 'pledge-line-sandbox-supply-desk', version: '1.0.0' } });
      if (result.protocolVersion !== SUPPLIER_PROTOCOL_VERSION || !object(result.capabilities?.tools)) fail('SUPPLIER_PROTOCOL_UNSUPPORTED');
      await rpc('notifications/initialized', null, true);
      const list = await rpc('tools/list');
      if (!Array.isArray(list.tools) || !TOOLS.every((tool) => list.tools.some((entry) => entry?.name === tool))) fail('SUPPLIER_TOOLS_INVALID');
      })();
      initialized = attempt;
      attempt.catch(() => { if (initialized === attempt) { initialized = null; sessionId = null; } });
    }
    return initialized;
  }

  async function call(tool, args, request = null) {
    if (!TOOLS.includes(tool)) fail('SUPPLIER_TOOL_FORBIDDEN');
    await connect();
    const attemptedSession = sessionId;
    let result;
    try { result = await rpc('tools/call', { name: tool, arguments: args }); }
    catch (error) {
      if (error.code !== 'SUPPLIER_SESSION_EXPIRED') throw error;
      // A definite missing-session response did not execute the tool. Reconnect once, preserving the quote ID.
      // Payment creation and capture never pass through this quote-only transport.
      if (sessionId === attemptedSession) { initialized = null; sessionId = null; }
      await connect();
      result = await rpc('tools/call', { name: tool, arguments: args });
    }
    if (result.isError || !object(result.structuredContent)) fail('SUPPLIER_TOOL_FAILED');
    return validateSupplierQuote(result.structuredContent, { id, payeeId }, { request, now: at() });
  }

  return Object.freeze({ id, name: name.trim(), payeeId, mode: 'mcp-sandbox', provenance: 'operator-registered-sandbox-endpoint',
    async quote(raw) { const request = normalizeSupplierRequest(raw, at()); return call('request_quote', { request }, request); },
    async negotiate({ request: raw, quote, counterOffer } = {}) {
      const request = normalizeSupplierRequest(raw, at());
      const prior = validateSupplierQuote(quote, { id, payeeId }, { request, now: at() });
      const args = { request, quoteId: prior.quoteId };
      if (counterOffer !== undefined) {
        if (!object(counterOffer) || Object.keys(counterOffer).some((key) => key !== 'unitPriceCents') ||
            !integer(counterOffer.unitPriceCents, 1, prior.unitPriceCents)) fail('SUPPLIER_COUNTEROFFER_INVALID');
        args.counterOffer = clone(counterOffer);
      }
      return call('negotiate_quote', args, request);
    },
    async getQuote(quoteId) {
      if (typeof quoteId !== 'string' || !/^[A-Za-z0-9-]{1,120}$/.test(quoteId)) fail('SUPPLIER_QUOTE_INVALID');
      return call('get_quote', { quoteId });
    },
  });
}

export function createMcpSuppliers({ registry, ...options } = {}) {
  if (!Array.isArray(registry) || registry.length < 1 || registry.length > 5) fail('SUPPLIER_CONFIGURATION_INVALID');
  const suppliers = registry.map((entry) => createMcpSupplier({ ...options, ...entry }));
  if (new Set(suppliers.map((supplier) => supplier.id)).size !== suppliers.length) fail('SUPPLIER_CONFIGURATION_INVALID');
  return suppliers;
}
