import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFaultDrill } from '../src/fault-drill.js';

test('a staged refusal fires once for each concurrent call, not once for the process', async () => {
  const consumed = [];
  const tokens = { consume: (token, detail) => consumed.push({ token, ...detail }) };
  const paypal = { mode: 'mock', suspendSubscription: async () => ({ ok: true }) };
  const staged = applyFaultDrill(paypal, 'suspend-refused', tokens);
  const attempts = await Promise.allSettled([
    staged.suspendSubscription('gift', 'first', { callId: 'call-a' }),
    staged.suspendSubscription('gift', 'second', { callId: 'call-b' }),
  ]);
  assert.deepEqual(attempts.map((a) => [a.status, a.reason?.status]), [['rejected', 422], ['rejected', 422]]);
  assert.deepEqual(consumed.map((item) => item.callId).sort(), ['call-a', 'call-b']);
  assert.deepEqual(await staged.suspendSubscription('gift', 'third', { callId: 'call-a' }), { ok: true });
  assert.deepEqual(await staged.suspendSubscription('gift', 'outside', {}), { ok: true });
});

test('interleaved subscription reads count separately for each staged call', async () => {
  let changes = 0;
  const paypal = {
    mode: 'mock',
    getSubscription: async () => ({ ok: true }),
    mockSetSubscriptionStatus: () => { changes += 1; },
  };
  const staged = applyFaultDrill(paypal, 'gift-changed', {});
  await staged.getSubscription('gift', { callId: 'call-a' });
  await staged.getSubscription('gift', { callId: 'call-b' });
  assert.equal(changes, 0);
  await staged.getSubscription('gift', { callId: 'call-a' });
  await staged.getSubscription('gift', { callId: 'call-b' });
  assert.equal(changes, 2);
  await staged.getSubscription('gift', { callId: 'call-a' });
  assert.equal(changes, 2);
});
