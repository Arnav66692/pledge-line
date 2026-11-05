import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPayPal, WriteNotAuthorized } from '../src/paypal.js';
import { createTokens } from '../src/gate.js';
import { SANDBOX_BASE_URL } from '../src/config.js';
import { moneyBinding } from '../src/cover.js';

function stack() {
  const calls = [];
  const tokens = createTokens();
  const paypal = createPayPal({ baseUrl: SANDBOX_BASE_URL, clientId: 'test-id', clientSecret: 'test-secret', tokens,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'test-access', expires_in: 3600 });
      if (url.endsWith('/capture')) return Response.json({ id: 'CAPTURE1', status: 'COMPLETED', amount: { value: '25.00', currency_code: 'USD' } });
      if (url.endsWith('/v2/invoicing/invoices')) return Response.json({ id: 'INV2-TEST', status: 'DRAFT' });
      return new Response(null, { status: 204 });
    } });
  return { paypal, calls, tokens, mint: (kind, targetId) => tokens.mint({ callId: 'call-one', pendingId: 'pending-one', kind, targetId,
    ...(kind === 'cover_capture' ? { binding: moneyBinding('25.00', 'USD') } : {}) }) };
}

test('committed request identity and response persistence reach every donor write before return', async () => {
  const s = stack();
  const observed = [];
  const context = { callId: 'call-one', requestId: 'persisted-request-identity', onResponse: async (result) => { await Promise.resolve(); observed.push(result); } };
  await s.paypal.suspendSubscription('I-TEST', s.mint('suspend', 'I-TEST'), context);
  await s.paypal.sendInvoice('INV2-TEST', s.mint('send_invoice', 'INV2-TEST'), context);
  const draft = await s.paypal.createDraftInvoice({ recipientEmail: 'test@personal.example.com', amountValue: '25.00', currency: 'USD', orgName: 'Test' }, context);
  await s.paypal.deleteDraftInvoice(draft.id, context);
  await s.paypal.captureSponsorHold('HOLD1', s.mint('cover_capture', 'HOLD1'), { ...context, amountValue: '25.00', currency: 'USD' });
  assert.equal(observed.length, 5);
  assert.equal(observed.at(-1).id, 'CAPTURE1');
  assert.ok(s.calls.filter((call) => !call.url.endsWith('/v1/oauth2/token')).every((call) => call.init.headers['PayPal-Request-Id'] === context.requestId));
});

test('durable response barriers cannot bypass one-time consent or expose an unpersisted response', async () => {
  const s = stack();
  await assert.rejects(s.paypal.suspendSubscription('I-TEST', 'missing', { callId: 'call-one', requestId: 'known', onResponse: () => {} }), WriteNotAuthorized);
  assert.equal(s.calls.length, 0);
  const token = s.mint('suspend', 'I-TEST');
  await assert.rejects(s.paypal.suspendSubscription('I-TEST', token, { callId: 'call-one', requestId: 'known', onResponse: async () => { throw Error('response persistence failed'); } }), /response persistence failed/);
  await assert.rejects(s.paypal.suspendSubscription('I-TEST', token, { callId: 'call-one' }), /unknown_or_used/);
});

test('invalid committed request IDs are refused before an HTTP write', async () => {
  const s = stack();
  await assert.rejects(s.paypal.createDraftInvoice({ recipientEmail: 'test@personal.example.com', amountValue: '25.00', currency: 'USD', orgName: 'Test' }, { requestId: 'bad\nheader' }), /BAD_REQUEST_ID/);
  assert.equal(s.calls.filter((call) => !call.url.endsWith('/v1/oauth2/token')).length, 0);
});

test('invalid response observers are refused before token consumption or provider dispatch', async () => {
  const s = stack();
  const token = s.mint('suspend', 'I-TEST');
  await assert.rejects(s.paypal.suspendSubscription('I-TEST', token, { callId: 'call-one', onResponse: true }), /DONOR_RESPONSE_OBSERVER_INVALID/);
  await assert.rejects(s.paypal.createDraftInvoice({ recipientEmail: 'test@personal.example.com', amountValue: '25.00', currency: 'USD', orgName: 'Test' }, { onResponse: true }), /DONOR_RESPONSE_OBSERVER_INVALID/);
  await assert.rejects(s.paypal.deleteDraftInvoice('INV2-TEST', { onResponse: true }), /DONOR_RESPONSE_OBSERVER_INVALID/);
  assert.equal(s.calls.length, 0);
  await s.paypal.suspendSubscription('I-TEST', token, { callId: 'call-one' });
});
