// Private reference suppliers inside one server process. No real business, goods or payment capability.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createSupplierProtocol } from './supplier-protocol.js';
import { validateSupplierQuote } from './supplier-mcp.js';
import { createSupplierQuoteStore } from './supplier-quote-store.js';

const DEFINITIONS = Object.freeze([
  { id: 'lab-campus', name: 'Controlled Campus Print lab', capacity: 60, unitPriceCents: 650, floorUnitPriceCents: 600, setupCents: 1000, shippingCents: 800, taxBps: 500, leadDays: 2 },
  { id: 'lab-club', name: 'Controlled Club Threads lab', capacity: 40, unitPriceCents: 675, floorUnitPriceCents: 620, setupCents: 500, shippingCents: 1200, taxBps: 500, leadDays: 3 },
  { id: 'lab-rush', name: 'Controlled Rush Merch lab', capacity: 100, unitPriceCents: 850, floorUnitPriceCents: 780, setupCents: 1000, shippingCents: 2000, taxBps: 500, leadDays: 1 },
]);
const fail = (code) => { throw new Error(code); };
const PROVENANCE = 'Controlled sandbox supplier lab. One configured sandbox merchant. No independent business participation or goods fulfillment.';

/** Import/construction has no side effects. Only this explicit async start opens private listeners. */
export async function startHostedSupplierLab({ pool, payeeId, now = () => new Date(), ports = [3160, 3161, 3162],
  quoteStore, createServer = http.createServer, tokenFactory = () => randomBytes(32).toString('hex') } = {}) {
  if (!/^[A-Z0-9]{8,40}$/.test(payeeId ?? '') || ['LABCAMPUS0001', 'LABCLUB000001', 'LABRUSH000001'].includes(payeeId) ||
    typeof now !== 'function' || typeof createServer !== 'function' || typeof tokenFactory !== 'function' ||
    !Array.isArray(ports) || ports.length !== 3 || ports.some((port) => !Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) ||
    new Set(ports.filter((port) => port !== 0)).size !== ports.filter((port) => port !== 0).length) fail('HOSTED_SUPPLIER_LAB_CONFIGURATION_INVALID');
  let tokens;
  try { tokens = DEFINITIONS.map(() => tokenFactory()); }
  catch { fail('HOSTED_SUPPLIER_LAB_CONFIGURATION_INVALID'); }
  if (tokens.some((token) => typeof token !== 'string' || token.length < 24 || token.length > 4096 || /[\x00-\x20\x7f]/.test(token)) ||
    new Set(tokens).size !== 3) fail('HOSTED_SUPPLIER_LAB_CONFIGURATION_INVALID');
  const store = quoteStore ?? createSupplierQuoteStore({ pool, now });
  if (!store || ['checkSchema', 'loadActive', 'get', 'save'].some((key) => typeof store[key] !== 'function')) fail('HOSTED_SUPPLIER_LAB_CONFIGURATION_INVALID');
  const servers = [], operations = new Set();
  let running = false, closePromise, lastError = null;
  const close = () => {
    closePromise ??= (async () => {
      running = false;
      await Promise.all(servers.map((server) => new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      })));
      // Persistence handlers drain before the parent is permitted to close its database pool.
      await Promise.allSettled([...operations]);
    })();
    return closePromise;
  };
  try {
    await store.checkSchema();
    const protocols = [];
    for (const [index, definition] of DEFINITIONS.entries()) {
      const quotes = await store.loadActive({ supplierId: definition.id });
      if (!(quotes instanceof Map) || quotes.size > 2000) fail('HOSTED_SUPPLIER_LAB_START_FAILED');
      const time = new Date(now()).getTime();
      if (!Number.isFinite(time)) fail('HOSTED_SUPPLIER_LAB_START_FAILED');
      for (const [quoteId, record] of quotes) {
        if (quoteId !== record?.quote?.quoteId || !/^[a-f0-9]{64}$/.test(record?.requestBinding ?? '')) fail('HOSTED_SUPPLIER_LAB_START_FAILED');
        if (Number.isFinite(Date.parse(record.quote.expiresAt)) && Date.parse(record.quote.expiresAt) <= time) { quotes.delete(quoteId); continue; }
        validateSupplierQuote(record.quote, { id: definition.id, payeeId }, { now: time });
      }
      protocols.push(createSupplierProtocol({ ...definition, payeeId, token: tokens[index], now, quotes,
        loadQuote: ({ quoteId }) => store.get({ supplierId: definition.id, quoteId }),
        persist: ({ quoteId, record }) => store.save({ supplierId: definition.id, quoteId, record }) }));
    }
    const registry = [];
    for (const [index, protocol] of protocols.entries()) {
      const server = createServer((req, res) => {
        const operation = Promise.resolve().then(() => protocol.handle(req, res)).catch(() => {
          if (!res.headersSent && !res.destroyed) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"Supplier unavailable."}'); }
          else res.destroy();
        });
        operations.add(operation);
        void operation.finally(() => operations.delete(operation));
      });
      server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
      server.on('error', () => {
        lastError = 'HOSTED_SUPPLIER_LAB_RUNTIME_FAILED';
        if (running) void close().catch(() => { lastError = 'HOSTED_SUPPLIER_LAB_RUNTIME_FAILED'; });
      });
      servers.push(server);
      await new Promise((resolve, reject) => {
        const error = () => reject(new Error('HOSTED_SUPPLIER_LAB_START_FAILED'));
        server.once('error', error);
        server.listen(ports[index], '127.0.0.1', () => { server.off('error', error); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1') fail('HOSTED_SUPPLIER_LAB_START_FAILED');
      registry.push(Object.freeze({ id: DEFINITIONS[index].id, name: DEFINITIONS[index].name, payeeId,
        endpoint: `http://127.0.0.1:${address.port}/mcp`, token: tokens[index], allowedHosts: Object.freeze([]), allowLocal: true }));
    }
    running = true;
    return Object.freeze({ registry: Object.freeze(registry), close,
      status: () => ({ running, controlledSandbox: true, supplierCount: 3, independentBusinessParticipation: false,
        paymentAuthority: false, provenance: PROVENANCE, lastError }) });
  } catch {
    await close();
    fail('HOSTED_SUPPLIER_LAB_START_FAILED');
  }
}
