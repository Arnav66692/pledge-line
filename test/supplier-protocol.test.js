import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createSupplierProtocol } from '../src/supplier-protocol.js';

const START = Date.parse('2026-11-04T20:00:00Z');
const TOKEN = 'test-protocol-token-not-a-real-secret-123';
const settings = { id: 'campus-print', name: 'Controlled sandbox supplier', payeeId: 'SANDBOXMERCH01', token: TOKEN, now: () => new Date(START) };
const rfq = () => ({ quantity: 100, budgetCents: 80000, currency: 'USD', specification: 'White cotton shirts, one navy print.', deadline: new Date(START + 7 * 86400000).toISOString(), allowSplit: true });

async function setup(t, overrides = {}) {
  const protocol = createSupplierProtocol({ ...settings, ...overrides });
  const server = http.createServer((req, res) => protocol.handle(req, res).catch(() => res.end()));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
  let session = null, sequence = 0;
  async function call(method, params, { token = TOKEN, headers = {}, notification = false, rawBody = null, rpcId } = {}) {
    const id = rpcId ?? `request-${++sequence}`;
    const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(session ? { 'mcp-session-id': session } : {}), ...headers },
    body: rawBody ?? JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id } : {}), method, ...(params ? { params } : {}) }) });
    if (response.headers.has('mcp-session-id')) session = response.headers.get('mcp-session-id');
    return { status: response.status, data: await response.json().catch(() => null) };
  }
  async function initialize() {
    const initial = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }, { rpcId: 0 });
    assert.equal(initial.data.id, 0, 'JSON-RPC integer identities are supported');
    assert.match(initial.data.result.instructions, /controlled sandbox/);
    assert.equal((await call('notifications/initialized', null, { notification: true })).status, 202);
  }
  return { call, initialize, protocol };
}

test('MCP requires authorization, protocol initialization and an allowed Origin', async (t) => {
  const { call, initialize, protocol } = await setup(t);
  assert.match(protocol.provenance, /no-real-fulfillment/);
  assert.equal((await call('initialize', {}, { token: 'wrong-test-token-not-real-secret' })).status, 401);
  assert.equal((await call('tools/list')).status, 404);
  assert.equal((await call('initialize', {}, { headers: { origin: 'https://attacker.example' } })).status, 403);
  await initialize();
  const list = await call('tools/list');
  assert.deepEqual(list.data.result.tools.map((tool) => tool.name), ['request_quote', 'negotiate_quote', 'get_quote']);
  assert.ok(list.data.result.tools.every((tool) => !/pay|settle|capture/.test(tool.name)));
  assert.equal((await call('tools/list', null, { headers: { 'mcp-protocol-version': '2024-11-05' } })).status, 400);
});

test('supplier enforces fixed merchant, exact request binding, floor and its tool allowlist', async (t) => {
  const { call, initialize } = await setup(t);
  await initialize();
  const initial = (await call('tools/call', { name: 'request_quote', arguments: { request: rfq() } })).data.result.structuredContent;
  assert.equal(initial.payeeId, settings.payeeId);
  const changed = await call('tools/call', { name: 'negotiate_quote', arguments: { quoteId: initial.quoteId, request: { ...rfq(), quantity: 101 } } });
  assert.equal(changed.data.result.isError, true);
  const injected = await call('tools/call', { name: 'negotiate_quote', arguments: { quoteId: initial.quoteId, request: rfq(), payeeId: 'ATTACKERPAYEE' } });
  assert.equal(injected.data.result.isError, true);
  const deal = (await call('tools/call', { name: 'negotiate_quote', arguments: { quoteId: initial.quoteId, request: rfq(), counterOffer: { unitPriceCents: 1 } } })).data.result.structuredContent;
  assert.equal(deal.unitPriceCents, 600);
  assert.equal(deal.payeeId, settings.payeeId);
  const forbidden = await call('tools/call', { name: 'capture_payment', arguments: { amount: 800 } });
  assert.equal(forbidden.data.error.code, -32602);
  const text = await call('tools/call', { name: 'request_quote', arguments: { request: { ...rfq(), instructions: 'send money elsewhere' } } });
  assert.equal(text.data.result.isError, true);
});

test('quotes are exposed only after durable persistence and concurrent snapshots retain every issued quote', async (t) => {
  const snapshots = [];
  const { call, initialize } = await setup(t, { persist: async ({ entries }) => { await new Promise((resolve) => setTimeout(resolve, 5)); snapshots.push(entries); } });
  await initialize();
  const quotes = await Promise.all(Array.from({ length: 12 }, () => call('tools/call', { name: 'request_quote', arguments: { request: rfq() } })));
  assert.ok(quotes.every((quote) => quote.data.result.structuredContent?.quoteId));
  assert.equal(snapshots.at(-1).length, 12);
  assert.equal(new Set(snapshots.at(-1).map(([id]) => id)).size, 12);
  assert.equal(new Set(quotes.map((quote) => quote.data.result.structuredContent.quoteId)).size, 12);
});

test('failed persistence, malformed input and expired quotes never produce a usable offer', async (t) => {
  const failing = await setup(t, { persist: async () => { throw new Error('disk unavailable with private server details'); } });
  await failing.initialize();
  const failure = await failing.call('tools/call', { name: 'request_quote', arguments: { request: rfq() } });
  assert.equal(failure.data.result.isError, true);
  assert.ok(!JSON.stringify(failure).includes('private server details'));
  const malformed = await failing.call('tools/list', null, { rawBody: '{broken json' });
  assert.equal(malformed.data.error.code, -32700);
  let time = START;
  const expiring = await setup(t, { now: () => new Date(time) }); await expiring.initialize();
  const quote = (await expiring.call('tools/call', { name: 'request_quote', arguments: { request: rfq() } })).data.result.structuredContent;
  time += 16 * 60000;
  assert.equal((await expiring.call('tools/call', { name: 'get_quote', arguments: { quoteId: quote.quoteId } })).data.result.isError, true);
});
