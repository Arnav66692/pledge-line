// Controlled sandbox supplier reference implementation. No real business, goods fulfillment or payment authority.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { SUPPLIER_PROTOCOL_VERSION, normalizeSupplierRequest, supplierQuoteCosts } from './supplier-mcp.js';

const MAX_BYTES = 65536;
const copy = (value) => structuredClone(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const REQUEST_SCHEMA = { type: 'object', properties: { specification: { type: 'string', minLength: 8, maxLength: 1000 },
  quantity: { type: 'integer', minimum: 1, maximum: 500 }, budgetCents: { type: 'integer', minimum: 1, maximum: 100000000 },
  currency: { const: 'USD' }, deadline: { type: 'string', format: 'date-time' }, allowSplit: { type: 'boolean' } },
required: ['specification', 'quantity', 'budgetCents', 'currency', 'deadline'], additionalProperties: false };
const TOOLS = Object.freeze([
  { name: 'request_quote', description: 'Quote a controlled sandbox order. No real goods or payment.', inputSchema: {
    type: 'object', properties: { request: REQUEST_SCHEMA }, required: ['request'], additionalProperties: false } },
  { name: 'negotiate_quote', description: 'Consider one lower unit-price counteroffer on an existing sandbox quote.', inputSchema: {
    type: 'object', properties: { request: REQUEST_SCHEMA, quoteId: { type: 'string' }, counterOffer: {
      type: 'object', properties: { unitPriceCents: { type: 'integer', minimum: 1 } }, required: ['unitPriceCents'], additionalProperties: false } },
    required: ['request', 'quoteId'], additionalProperties: false } },
  { name: 'get_quote', description: 'Read the unchanged sandbox quote. A quote is not payment evidence.', inputSchema: {
    type: 'object', properties: { quoteId: { type: 'string' } }, required: ['quoteId'], additionalProperties: false } },
]);

export function createSupplierProtocol({ id, name, payeeId, token, capacity = 60, unitPriceCents = 650, floorUnitPriceCents = 600,
  setupCents = 1000, shippingCents = 800, taxBps = 500, leadDays = 2, quoteTtlMs = 15 * 60000,
  now = () => new Date(), quotes = new Map(), persist = async () => {}, allowedOrigins = [] } = {}) {
  if (!/^[a-z0-9-]{1,48}$/.test(id ?? '') || typeof name !== 'string' || !name.trim() || name.length > 100 ||
      !/^[A-Za-z0-9]{8,64}$/.test(payeeId ?? '') || typeof token !== 'string' || token.length < 24 || token.length > 4096 || /[\x00-\x20\x7f]/.test(token) ||
      !integer(capacity, 1, 500) || !integer(unitPriceCents, 1, 100000000) || !integer(floorUnitPriceCents, 1, unitPriceCents) ||
      !integer(setupCents, 0, 100000000) || !integer(shippingCents, 0, 100000000) || !integer(taxBps, 0, 5000) ||
      !integer(leadDays, 0, 30) || !integer(quoteTtlMs, 60000, 86400000) || !(quotes instanceof Map) || !Array.isArray(allowedOrigins)) throw new Error('SUPPLIER_CONFIGURATION_INVALID');
  const authHash = hash(`Bearer ${token}`), sessions = new Map();
  let issuance = Promise.resolve();
  const at = () => new Date(now()).getTime();
  const validSession = (sessionId) => {
    const entry = sessions.get(sessionId);
    return Boolean(entry && entry.expiresAt > at() && entry.initialized);
  };
  function respond(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
    res.end(body === null ? undefined : JSON.stringify(body));
  }
  const result = (res, rpcId, value, headers) => respond(res, 200, { jsonrpc: '2.0', id: rpcId, result: value }, headers);
  const rpcError = (res, rpcId, code, message) => respond(res, 200, { jsonrpc: '2.0', id: rpcId ?? null, error: { code, message } });
  function toolResult(quote) {
    return { content: [{ type: 'text', text: 'Controlled sandbox supplier quote. No real fulfillment or payment.' }],
      structuredContent: copy(quote), isError: false };
  }
  async function issueNow(request, price) {
    if (quotes.size >= 2000) throw new Error('SUPPLIER_CAPACITY_REACHED');
    const time = at(), quote = { quoteId: `mcp-quote-${randomUUID()}`, supplierId: id, payeeId,
      specificationHash: hash(request.specification), currency: 'USD', minQuantity: 1, maxQuantity: Math.min(request.quantity, capacity),
      unitPriceCents: price, setupCents, shippingCents, taxBps,
      deliveryAt: new Date(time + leadDays * 86400000).toISOString(), expiresAt: new Date(time + quoteTtlMs).toISOString() };
    Object.assign(quote, supplierQuoteCosts(quote, quote.maxQuantity));
    const record = { quote, requestBinding: hash(JSON.stringify(request)) };
    // Await persistence before exposing a quote that another process may need to read.
    await persist({ quoteId: quote.quoteId, record: copy(record), entries: [...quotes.entries(), [quote.quoteId, copy(record)]] });
    quotes.set(quote.quoteId, record);
    return quote;
  }
  function issue(request, price) {
    const operation = issuance.then(() => issueNow(request, price));
    issuance = operation.catch(() => {});
    return operation;
  }
  const cleanArgs = (args, allowed) => object(args) && Object.keys(args).every((key) => allowed.includes(key));

  async function handle(req, res) {
    const rawAuth = req.headers.authorization;
    if (typeof rawAuth !== 'string' || rawAuth.length > 5000 || !timingSafeEqual(Buffer.from(hash(rawAuth)), Buffer.from(authHash))) return respond(res, 401, { error: 'Supplier authorization required.' });
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) return respond(res, 403, { error: 'Origin is not allowed.' });
    const pathname = (() => { try { return new URL(req.url, 'http://supplier.invalid').pathname; } catch { return ''; } })();
    if (pathname !== '/mcp') return respond(res, 404, { error: 'Not found.' });
    if (req.method !== 'POST') return respond(res, 405, { error: 'Only MCP POST is supported.' }, { allow: 'POST' });
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return respond(res, 415, { error: 'JSON is required.' });
    const accept = String(req.headers.accept ?? '');
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) return respond(res, 406, { error: 'MCP response types are required.' });
    let size = 0, body;
    try {
      const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BYTES) return respond(res, 413, { error: 'Request is too large.' }); chunks.push(chunk); }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return rpcError(res, null, -32700, 'Invalid JSON.'); }
    if (!object(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string' ||
        (body.id !== undefined && !((typeof body.id === 'string' && body.id.length <= 128) || Number.isSafeInteger(body.id)))) return rpcError(res, null, -32600, 'Invalid MCP request.');
    if (body.method === 'initialize') {
      for (const [sessionId, entry] of sessions) if (entry.expiresAt <= at()) sessions.delete(sessionId);
      if (body.id === undefined || sessions.size >= 200 || body.params?.protocolVersion !== SUPPLIER_PROTOCOL_VERSION) return rpcError(res, body.id, -32602, 'Unsupported initialization.');
      const sessionId = randomUUID(); sessions.set(sessionId, { initialized: false, expiresAt: at() + 3600000 });
      return result(res, body.id, { protocolVersion: SUPPLIER_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'pledge-line-controlled-sandbox-supplier', version: '1.0.0' },
        instructions: 'This endpoint is a controlled sandbox supplier. It does not represent a real business, fulfill goods or provide payment evidence.' }, { 'mcp-session-id': sessionId });
    }
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId !== 'string' || !sessions.has(sessionId) || sessions.get(sessionId).expiresAt <= at()) return respond(res, 404, { error: 'MCP session is unavailable.' });
    if (req.headers['mcp-protocol-version'] !== SUPPLIER_PROTOCOL_VERSION) return respond(res, 400, { error: 'Unsupported MCP version.' });
    if (body.method === 'notifications/initialized' && body.id === undefined) {
      sessions.get(sessionId).initialized = true; return respond(res, 202, null);
    }
    if (body.id === undefined || !validSession(sessionId)) return rpcError(res, body.id, -32600, 'Initialize the MCP session first.');
    if (body.method === 'tools/list') return result(res, body.id, { tools: TOOLS });
    if (body.method !== 'tools/call') return rpcError(res, body.id, -32601, 'Method is not supported.');
    const tool = body.params?.name, args = body.params?.arguments;
    try {
      if (tool === 'get_quote') {
        if (!cleanArgs(args, ['quoteId']) || typeof args.quoteId !== 'string' || !/^[A-Za-z0-9-]{1,120}$/.test(args.quoteId)) throw new Error('INVALID_ARGUMENTS');
        const stored = quotes.get(args.quoteId);
        if (!stored || Date.parse(stored.quote.expiresAt) <= at()) throw new Error('QUOTE_UNAVAILABLE');
        return result(res, body.id, toolResult(stored.quote));
      }
      if (tool !== 'request_quote' && tool !== 'negotiate_quote') return rpcError(res, body.id, -32602, 'Tool is not permitted.');
      if (!cleanArgs(args, tool === 'request_quote' ? ['request'] : ['request', 'quoteId', 'counterOffer'])) throw new Error('INVALID_ARGUMENTS');
      if (!cleanArgs(args.request, Object.keys(REQUEST_SCHEMA.properties))) throw new Error('INVALID_ARGUMENTS');
      const request = normalizeSupplierRequest(args.request, at());
      if (tool === 'request_quote') return result(res, body.id, toolResult(await issue(request, unitPriceCents)));
      const stored = quotes.get(args.quoteId);
      if (!stored || Date.parse(stored.quote.expiresAt) <= at() || stored.requestBinding !== hash(JSON.stringify(request))) throw new Error('QUOTE_UNAVAILABLE');
      const offer = args.counterOffer;
      if (offer !== undefined && (!cleanArgs(offer, ['unitPriceCents']) || !integer(offer.unitPriceCents, 1, stored.quote.unitPriceCents))) throw new Error('INVALID_ARGUMENTS');
      return result(res, body.id, toolResult(await issue(request, Math.max(floorUnitPriceCents, offer?.unitPriceCents ?? floorUnitPriceCents))));
    } catch {
      return result(res, body.id, { content: [{ type: 'text', text: 'The supplier could not issue or verify that sandbox quote.' }], isError: true });
    }
  }
  return Object.freeze({ handle, provenance: 'controlled-sandbox-supplier-no-real-fulfillment' });
}
