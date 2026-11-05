import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayPal } from '../src/paypal.js';
import { SANDBOX_BASE_URL } from '../src/config.js';

function client() {
  const requests = [];
  const paypal = createPayPal({ baseUrl: SANDBOX_BASE_URL, clientId: 'synthetic-id', clientSecret: 'synthetic-secret',
    fetchImpl: async (url, init) => {
      requests.push({ url: new URL(url), method: init.method });
      if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'synthetic-access', expires_in: 3600 });
      return Response.json({ events: [{ id: 'SYNTHETIC-EVENT' }] });
    } });
  return { paypal, requests };
}

test('webhook event queries normalize ISO milliseconds and offsets to UTC whole seconds accepted by PayPal', async () => {
  const { paypal, requests } = client();
  for (const startTime of ['2026-11-05T09:20:00.000Z', '2026-11-05T09:20:00.789Z', '2026-11-05T01:20:00.000-08:00', '2026-11-05T09:20:00Z']) {
    const result = await paypal.listWebhookEvents({ eventType: 'INVOICING.INVOICE.PAID', startTime, pageSize: 25 });
    assert.deepEqual(result.events, [{ id: 'SYNTHETIC-EVENT' }]);
  }
  const queries = requests.filter(({ url }) => url.pathname === '/v1/notifications/webhooks-events');
  assert.equal(queries.length, 4);
  for (const { url, method } of queries) {
    assert.equal(method, 'GET');
    assert.equal(url.origin, SANDBOX_BASE_URL);
    assert.equal(url.searchParams.get('start_time'), '2026-11-05T09:20:00Z');
    assert.equal(url.searchParams.get('event_type'), 'INVOICING.INVOICE.PAID');
    assert.equal(url.searchParams.get('page_size'), '25');
  }
});

test('invalid webhook start timestamps are rejected locally before authentication or any network request', async () => {
  const { paypal, requests } = client();
  for (const startTime of [undefined, null, 0, '', 'not-a-date', '2026-11-05', '2026-11-05T09:20:00', '2026-02-30T09:20:00Z', '2026-11-05T24:20:00Z']) {
    await assert.rejects(paypal.listWebhookEvents({ eventType: 'INVOICING.INVOICE.PAID', startTime }), /INVALID_START_TIME/);
  }
  assert.equal(requests.length, 0);
});
