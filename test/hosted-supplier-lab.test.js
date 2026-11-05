import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { startHostedSupplierLab } from '../src/hosted-supplier-lab.js';
import { createMcpSuppliers } from '../src/supplier-mcp.js';
import { createSupplierProtocol } from '../src/supplier-protocol.js';

const START = Date.parse('2026-11-05T09:00:00Z');
const PAYEE = 'SANDBOXMERCH01';
const request = () => ({ specification: 'White cotton shirts with one navy screen print.', quantity: 100, budgetCents: 80000,
  currency: 'USD', deadline: new Date(START + 7 * 86400000).toISOString() });
function fakeStore() {
  const records = new Map(), calls = [];
  return { records, calls, async checkSchema() { calls.push('check'); },
    async loadActive({ supplierId }) { calls.push(`load:${supplierId}`); return new Map([...records.entries()].filter(([, r]) => r.quote.supplierId === supplierId).map(([id, r]) => [id, structuredClone(r)])); },
    async get({ supplierId, quoteId }) { calls.push(`get:${supplierId}`); const record = records.get(quoteId); return record?.quote.supplierId === supplierId ? structuredClone(record) : null; },
    async save({ supplierId, quoteId, record }) { calls.push(`save:${supplierId}`); records.set(quoteId, structuredClone(record)); } };
}
const options = (quoteStore) => ({ quoteStore, payeeId: PAYEE, ports: [0, 0, 0], now: () => new Date(START) });

test('hosted lab serves three authenticated private MCP suppliers and persists before exposing quotes', async (t) => {
  const store = fakeStore();
  const lab = await startHostedSupplierLab(options(store));
  t.after(() => lab.close());
  assert.deepEqual(store.calls.slice(0, 4), ['check', 'load:lab-campus', 'load:lab-club', 'load:lab-rush']);
  assert.equal(lab.registry.length, 3);
  assert.equal(new Set(lab.registry.map((r) => r.token)).size, 3);
  assert.ok(lab.registry.every((r) => r.endpoint.startsWith('http://127.0.0.1:') && r.allowLocal));
  assert.ok(lab.registry.every((r) => r.payeeId === PAYEE));
  const suppliers = createMcpSuppliers({ registry: lab.registry, now: () => new Date(START) });
  const quote = await suppliers[0].quote(request());
  assert.equal(store.records.has(quote.quoteId), true);
  assert.equal(quote.unitPriceCents, 650);
  assert.deepEqual(await suppliers[0].getQuote(quote.quoteId), quote);
  assert.equal(suppliers[0].settle, undefined);
  const unauthenticated = await fetch(lab.registry[0].endpoint, { method: 'POST', body: '{}' });
  assert.equal(unauthenticated.status, 401);
  const crossOrigin = await fetch(lab.registry[0].endpoint, { method: 'POST', headers: { authorization: `Bearer ${lab.registry[0].token}`, origin: 'https://untrusted.example' }, body: '{}' });
  assert.equal(crossOrigin.status, 403);
  assert.equal(lab.status().independentBusinessParticipation, false);
  assert.equal(lab.status().paymentAuthority, false);
  assert.equal(JSON.stringify(lab.status()).includes(lab.registry[0].token), false);
});

test('replacing listeners restores an unchanged quote from durable records with new private tokens', async () => {
  const store = fakeStore(), a = await startHostedSupplierLab(options(store));
  const firstRegistry = a.registry;
  const first = await createMcpSuppliers({ registry: firstRegistry, now: () => new Date(START) })[0].quote(request());
  await a.close();
  const b = await startHostedSupplierLab(options(store));
  try {
    assert.notEqual(b.registry[0].token, firstRegistry[0].token);
    const restored = await createMcpSuppliers({ registry: b.registry, now: () => new Date(START) })[0].getQuote(first.quoteId);
    assert.deepEqual(restored, first);
    assert.equal(store.records.size, 1, 'restart retrieval creates no replacement quote');
    await Promise.all([b.close(), b.close()]);
    assert.equal(b.status().running, false);
  } finally { await b.close(); }
});

test('an already-started replacement reads unchanged quotes issued by the prior instance after hydration', async () => {
  const store = fakeStore(), a = await startHostedSupplierLab(options(store)), b = await startHostedSupplierLab(options(store));
  try {
    const first = await createMcpSuppliers({ registry: a.registry, now: () => new Date(START) })[0].quote(request());
    const replacement = createMcpSuppliers({ registry: b.registry, now: () => new Date(START) })[0];
    assert.deepEqual(await replacement.getQuote(first.quoteId), first);
    assert.equal(store.calls.filter((call) => call === 'get:lab-campus').length, 1);
    assert.deepEqual(await replacement.getQuote(first.quoteId), first, 'validated records may be cached');
    assert.equal(store.calls.filter((call) => call === 'get:lab-campus').length, 1);
    const late = await createMcpSuppliers({ registry: a.registry, now: () => new Date(START) })[0].quote(request());
    await assert.rejects(replacement.negotiate({ request: { ...request(), quantity: 99 }, quote: late }), /SUPPLIER_TOOL_FAILED/);
    const negotiated = await replacement.negotiate({ request: request(), quote: late, counterOffer: { unitPriceCents: 600 } });
    assert.equal(negotiated.unitPriceCents, 600);
    assert.equal(store.records.size, 3, 'read-through itself creates no replacement quote');
  } finally { await a.close(); await b.close(); }
});

test('read-through refuses mismatched identities, malformed bindings, expired terms and storage failure', async () => {
  const originalStore = fakeStore(), originalLab = await startHostedSupplierLab(options(originalStore));
  let original;
  try { original = await createMcpSuppliers({ registry: originalLab.registry, now: () => new Date(START) })[0].quote(request()); }
  finally { await originalLab.close(); }
  for (const mutate of [
    (r) => { r.quote.quoteId = 'mcp-quote-substituted'; },
    (r) => { r.quote.supplierId = 'lab-rush'; },
    (r) => { r.quote.payeeId = 'OTHERPAYEE123'; },
    (r) => { r.requestBinding = 'not-a-request-binding'; },
    (r) => { r.quote.expiresAt = new Date(START - 1).toISOString(); },
    (r) => { r.quote.totalCents = 1; },
    (r) => { r.extra = true; },
    () => { throw new Error('private storage details'); },
  ]) {
    const store = fakeStore(), lab = await startHostedSupplierLab(options(store));
    store.get = async () => { const record = structuredClone(originalStore.records.get(original.quoteId)); mutate(record); return record; };
    try {
      const supplier = createMcpSuppliers({ registry: lab.registry, now: () => new Date(START) })[0];
      await assert.rejects(supplier.getQuote(original.quoteId), /SUPPLIER_TOOL_FAILED/);
      await assert.rejects(supplier.negotiate({ request: request(), quote: original }), /SUPPLIER_TOOL_FAILED/);
      assert.equal(store.records.size, 0, 'invalid or unavailable records must not authorize issuance');
    } finally { await lab.close(); }
  }
});

test('missing schema or changed merchant prevents listening; partial startup closes earlier listeners', async () => {
  const store = fakeStore(); store.checkSchema = async () => { throw Error('private storage details'); };
  await assert.rejects(startHostedSupplierLab(options(store)), /HOSTED_SUPPLIER_LAB_START_FAILED/);
  for (const payeeId of ['bad', 'LABCAMPUS0001', 'LABCLUB000001', 'LABRUSH000001']) {
    await assert.rejects(startHostedSupplierLab({ ...options(fakeStore()), payeeId }), /HOSTED_SUPPLIER_LAB_CONFIGURATION_INVALID/);
  }
  const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const occupied = server.address().port;
  const created = [];
  try {
    await assert.rejects(startHostedSupplierLab({ ...options(fakeStore()), ports: [0, occupied, 0],
      createServer: (handler) => { const s = http.createServer(handler); created.push(s); return s; } }), /HOSTED_SUPPLIER_LAB_START_FAILED/);
    assert.ok(created.every((s) => !s.listening));
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('expired in-memory records cannot permanently exhaust issuance capacity', async (t) => {
  const quotes = new Map();
  for (let i = 0; i < 2000; i += 1) quotes.set(`old-${i}`, { quote: { expiresAt: new Date(START - 1).toISOString() } });
  const token = 'test-only-rebuildable-supplier-token-12345';
  const protocol = createSupplierProtocol({ id: 'lab-campus', name: 'Controlled Campus', payeeId: PAYEE, token,
    quotes, now: () => new Date(START) });
  const server = http.createServer((req, res) => protocol.handle(req, res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const supplier = createMcpSuppliers({ registry: [{ id: 'lab-campus', name: 'Controlled Campus', payeeId: PAYEE,
    token, endpoint: `http://127.0.0.1:${server.address().port}/mcp`, allowLocal: true }], now: () => new Date(START) })[0];
  assert.ok(await supplier.quote(request()));
  assert.equal(quotes.size, 1);
});

test('restored quotes are validated against the configured merchant before any listener starts', async () => {
  const store = fakeStore(), hash = (v) => createHash('sha256').update(v).digest('hex');
  store.records.set('mcp-quote-restored', { requestBinding: hash('request'), quote: { quoteId: 'mcp-quote-restored',
    supplierId: 'lab-campus', payeeId: 'OTHERPAYEE123', specificationHash: hash(request().specification), currency: 'USD', minQuantity: 1, maxQuantity: 60,
    unitPriceCents: 600, setupCents: 1000, shippingCents: 800, taxBps: 500,
    deliveryAt: new Date(START + 86400000).toISOString(), expiresAt: new Date(START + 900000).toISOString() } });
  let listeners = 0;
  await assert.rejects(startHostedSupplierLab({ ...options(store), createServer: () => { listeners += 1; return http.createServer(); } }), /HOSTED_SUPPLIER_LAB_START_FAILED/);
  assert.equal(listeners, 0);
});

test('failed persistence exposes no quote, and close drains a pending persistence callback', async () => {
  const failed = fakeStore(); failed.save = async () => { throw Error('private database details'); };
  const a = await startHostedSupplierLab(options(failed));
  try {
    const supplier = createMcpSuppliers({ registry: a.registry, now: () => new Date(START) })[0];
    await assert.rejects(supplier.quote(request()), /SUPPLIER_TOOL_FAILED/);
    assert.equal(failed.records.size, 0);
  } finally { await a.close(); }
  const pending = fakeStore(), save = pending.save.bind(pending);
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const inPersistence = new Promise((resolve) => { started = resolve; });
  pending.save = async (input) => { started(); await gate; await save(input); };
  const b = await startHostedSupplierLab(options(pending));
  const requestDone = createMcpSuppliers({ registry: b.registry, now: () => new Date(START) })[0].quote(request()).catch(() => null);
  await inPersistence;
  let closed = false;
  const close = b.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false, 'database work must drain before the owner can close the pool');
  release();
  await close; await requestDone;
  assert.equal(pending.records.size, 1);
  assert.equal(b.status().running, false);
});

test('late listener errors close the lab and publish only a constant diagnostic', async () => {
  const servers = [], lab = await startHostedSupplierLab({ ...options(fakeStore()), createServer: (handler) => {
    const server = http.createServer(handler); servers.push(server); return server;
  } });
  servers[0].emit('error', Error('private listener details'));
  await lab.close();
  assert.equal(lab.status().running, false);
  assert.equal(lab.status().lastError, 'HOSTED_SUPPLIER_LAB_RUNTIME_FAILED');
  assert.equal(JSON.stringify(lab.status()).includes('private listener'), false);
  assert.ok(servers.every((server) => !server.listening));
});
