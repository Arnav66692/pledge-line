import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPayPal, buildVerifyBody } from '../src/paypal.js';
import { createMockPayPal } from '../src/paypal-mock.js';
import { createTokens } from '../src/gate.js';
import { createLedger } from '../src/ledger.js';
import { loadConfig, SANDBOX_BASE_URL } from '../src/config.js';
import { createServer, createWebhookHandler, resourceIdOf } from '../src/server.js';
import { createCallService } from '../src/call.js';
import { createGate } from '../src/gate.js';
import { createRouter } from '../src/router.js';
import { tempLedgerPath } from './helpers.js';

const HEADERS = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42',
  'paypal-transmission-id': '69cd13f0-d67a-11e5-baa3-778b53f4ae55',
  'paypal-transmission-sig': 'lmI95Jx3Y9nhR5SJWlHVIWpg4AgFk7n9bCHSRxbrd8A9zrhdu2rMyFrmz+Zjh3s3boXB07VXCXUZy/UFzUlnGJn0wDugt7FlSvdKeIJenLRemUxYCPVoEZzg9VFNqOa48gMkvF+XTpxBeUx/kWy6B5cp7GkT2+pOowfRK7OaynuxUoKW3JcMWw272VKjLTtTAShncla7tGF+55rxyt2KNZIIqxNMJ48RDZheGU5w1npu9dZHnPgTXB9iomeVRoD8O/jhRpnKsGrDschyNdkeh81BJJMH4Ctc6lnCCquoP/GzCzz33MMsNdid7vL/NIWaCsekQpW26FpWPi/tfj8nLA==',
  'paypal-transmission-time': '2016-02-18T20:01:35Z',
};
// Odd spacing, a tab, an escaped unicode sequence and raw multi-byte characters.
const RAW = Buffer.from('{ "id" :"WH-2WR32451HC0233532-67976317FL4543714",\n\t"event_type": "INVOICING.INVOICE.PAID" ,"summary":"Café 募金 \\u00e9 😀",   "resource": {"id":"INV2-AAAA-BBBB-CCCC-DDDD","status":"PAID" } }', 'utf8');

function fakeFetch(handlers) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    const handler = handlers.find((h) => url.endsWith(h.path));
    if (!handler) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify(handler.body), { status: handler.status ?? 200, headers: { 'Content-Type': 'application/json', 'paypal-debug-id': 'dbg-1' } });
  };
  return { fetchImpl, seen };
}

const tokenHandler = { path: '/v1/oauth2/token', body: { access_token: 'A21AA-test', token_type: 'Bearer', expires_in: 32400, scope: 'https://uri.paypal.com/services/invoicing' } };

test('the verify request embeds the raw webhook body byte for byte', async () => {
  const { fetchImpl, seen } = fakeFetch([tokenHandler, { path: '/v1/notifications/verify-webhook-signature', body: { verification_status: 'SUCCESS' } }]);
  const paypal = createPayPal({ baseUrl: SANDBOX_BASE_URL, clientId: 'id', clientSecret: 'secret', fetchImpl });
  const result = await paypal.verifyWebhookSignature({ headers: HEADERS, rawBody: RAW, webhookId: 'WH-REGISTERED-ID' });
  assert.deepEqual({ verified: result.verified, verifyStatus: result.verifyStatus }, { verified: true, verifyStatus: 'SUCCESS' });
  const verifyCall = seen.find((s) => s.url.endsWith('/verify-webhook-signature'));
  const sent = Buffer.from(verifyCall.init.body);
  const at = sent.indexOf(RAW);
  assert.ok(at > 0, 'raw bytes appear unchanged inside the request body');
  assert.equal(sent.subarray(at + RAW.length).toString('utf8'), '}');
  assert.deepEqual(sent, buildVerifyBody(HEADERS, 'WH-REGISTERED-ID', RAW));
  const parsed = JSON.parse(sent.toString('utf8'));
  assert.equal(parsed.webhook_id, 'WH-REGISTERED-ID');
  assert.equal(parsed.transmission_sig, HEADERS['paypal-transmission-sig']);
  assert.deepEqual(parsed.webhook_event, JSON.parse(RAW.toString('utf8')));
  assert.equal(verifyCall.init.headers.Authorization, 'Bearer A21AA-test');
  assert.equal('PayPal-Request-Id' in verifyCall.init.headers, false);
});

test('missing headers or a missing webhook id skip the network', async () => {
  const fetchImpl = async () => { throw new Error('the network must not be used'); };
  const paypal = createPayPal({ baseUrl: SANDBOX_BASE_URL, clientId: 'id', clientSecret: 'secret', fetchImpl });
  const { 'paypal-transmission-sig': dropped, ...partial } = HEADERS;
  assert.ok(dropped);
  assert.deepEqual(await paypal.verifyWebhookSignature({ headers: partial, rawBody: RAW, webhookId: 'WH-1' }), { verified: false, verifyStatus: 'MISSING_HEADERS' });
  assert.deepEqual(await paypal.verifyWebhookSignature({ headers: {}, rawBody: RAW, webhookId: 'WH-1' }), { verified: false, verifyStatus: 'MISSING_HEADERS' });
  assert.deepEqual(await paypal.verifyWebhookSignature({ headers: HEADERS, rawBody: RAW, webhookId: null }), { verified: false, verifyStatus: 'NO_WEBHOOK_ID' });
});

test('PayPal error bodies are parsed in both shapes, and 204 bodies are never read', async () => {
  const { fetchImpl } = fakeFetch([{ path: '/v1/oauth2/token', status: 401, body: { error: 'invalid_client', error_description: 'Client Authentication failed' } }]);
  const paypal = createPayPal({ baseUrl: SANDBOX_BASE_URL, clientId: 'id', clientSecret: 'secret', fetchImpl });
  await assert.rejects(paypal.getSubscription('I-1'), (e) => e.status === 401 && e.name === 'invalid_client' && e.message === 'Client Authentication failed');
  const tokens = createTokens();
  const okFetch = async (url) => (url.endsWith('/v1/oauth2/token')
    ? new Response(JSON.stringify(tokenHandler.body), { status: 200 })
    : new Response(null, { status: 204, headers: { 'paypal-debug-id': 'dbg-204' } }));
  const client = createPayPal({ baseUrl: SANDBOX_BASE_URL, clientId: 'id', clientSecret: 'secret', tokens, fetchImpl: okFetch });
  const token = tokens.mint({ callId: 'c1', pendingId: 'p1', kind: 'suspend', targetId: 'I-1' });
  assert.deepEqual(Object.keys(await client.suspendSubscription('I-1', token, { callId: 'c1' })).sort(), ['debugId', 'ms']);
});

test('the invoice id is read from resource.id, else resource.invoice.id', () => {
  assert.equal(resourceIdOf({ resource: { id: 'INV2-AAAA-BBBB-CCCC-DDDD' } }), 'INV2-AAAA-BBBB-CCCC-DDDD');
  assert.equal(resourceIdOf({ resource: { id: 'WH-OTHER', invoice: { id: 'INV2-1111-2222-3333-4444' } } }), 'INV2-1111-2222-3333-4444');
  assert.equal(resourceIdOf({}), null);
});

async function webhookServer() {
  const config = loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules' });
  const ledger = createLedger({ path: tempLedgerPath() });
  const tokens = createTokens();
  const deliveries = [];
  const paypal = createMockPayPal({ tokens, onWebhook: (d) => { deliveries.push(d); } });
  const log = { info: () => {}, error: () => {} };
  const webhooks = createWebhookHandler({ paypal, ledger, webhookId: config.paypal.webhookId, log });
  const gate = createGate({ ledger, tokens });
  const calls = createCallService({ config, ledger, paypal, router: createRouter({ mode: 'rules' }), gate });
  const server = createServer({ config, ledger, paypal, calls, webhooks, log });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const draft = await paypal.createDraftInvoice({ recipientEmail: 'sb-maria@personal.example.com', amountValue: '50.00', currency: 'USD', orgName: 'Sunny Hollow Pantry' });
  const token = tokens.mint({ callId: 'c1', pendingId: 'p1', kind: 'send_invoice', targetId: draft.id });
  await paypal.sendInvoice(draft.id, token, { callId: 'c1' });
  await paypal.mockPay(draft.id);
  return { server, base, ledger, delivery: deliveries[0], invoiceId: draft.id };
}

const post = (base, rawBody, headers) => fetch(`${base}/webhooks/paypal`, { method: 'POST', body: rawBody, headers: { 'content-type': 'application/json', ...headers } });

async function waitFor(check) {
  for (let i = 0; i < 50; i += 1) {
    if (check()) return;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  throw new Error('timed out waiting');
}

test('the webhook endpoint answers 200 at once, verifies, and dedupes copies of one event', async () => {
  const { server, base, ledger, delivery, invoiceId } = await webhookServer();
  try {
    const { 'content-type': type, ...signed } = delivery.headers;
    assert.ok(type);
    const first = await post(base, delivery.rawBody, signed);
    assert.equal(first.status, 200);
    await waitFor(() => ledger.byType('webhook').length === 1);
    await post(base, delivery.rawBody, signed);
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    assert.equal(ledger.byType('webhook').length, 1, 'the verified copy is kept once');
    const event = JSON.parse(delivery.rawBody.toString('utf8'));
    const forged = Buffer.from(JSON.stringify({ ...event, id: 'WH-FORGED-1', resource: { ...event.resource, status: 'REFUNDED' } }));
    await post(base, forged, signed);
    await post(base, Buffer.from('not json'), signed);
    await waitFor(() => ledger.byType('webhook').length === 3);
    const list = (await (await fetch(`${base}/api/webhooks`)).json()).webhooks;
    const paid = list.find((w) => w.eventId === event.id);
    assert.equal(paid.verified, true);
    assert.equal(paid.resourceId, invoiceId);
    assert.equal(paid.eventType, 'INVOICING.INVOICE.PAID');
    assert.equal(list.find((w) => w.eventId === 'WH-FORGED-1').verified, false);
    assert.ok(list.some((w) => w.verifyStatus === 'BAD_BODY'));
    assert.equal(JSON.stringify(list).includes('transmission_sig'), false);
  } finally {
    server.close();
  }
});
