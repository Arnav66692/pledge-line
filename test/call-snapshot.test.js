import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStack, say } from './helpers.js';

test('private call projection excludes bearer, PIN, IP, consent-token store and process-only state', async () => {
  const stack = buildStack();
  const started = stack.calls.start({ clientKey: 'private-address' });
  await say(stack, started.callId, stack.config.pin, 'keypad');
  await say(stack, started.callId, 'Please pause my gift');
  const saved = stack.calls.snapshot(started.callId);
  const encoded = JSON.stringify(saved);
  assert.ok(!encoded.includes(started.sessionSecret));
  assert.ok(!encoded.includes('private-address'));
  assert.ok(!Object.keys(saved.snapshot).some((key) => ['sessionSecret', 'sessionHash', 'queue', 'clientKey', 'pin', 'lastFinishedAt'].includes(key)));
  assert.match(saved.sessionSecretHash, /^[0-9a-f]{64}$/);
  assert.equal(saved.snapshot.pending.kind, 'suspend');
});

test('restored call keeps original bearer authentication but withdraws old consent and requires PIN again', async () => {
  const stack = buildStack();
  const started = stack.calls.start();
  await say(stack, started.callId, stack.config.pin, 'keypad');
  await say(stack, started.callId, 'Please pause my gift');
  const saved = stack.calls.snapshot(started.callId);
  stack.calls.forget(started.callId);
  const restored = stack.calls.restore(saved);
  assert.equal(restored.verified, false);
  assert.equal(restored.pending, null);
  assert.equal(restored.restored, true);
  assert.equal(stack.calls.authenticate(started.callId, started.sessionSecret), true);
  assert.equal(stack.calls.authenticate(started.callId, 'wrong'), false);
  await say(stack, started.callId, 'yes');
  assert.equal(stack.ledger.byCall(started.callId).filter((event) => event.type === 'write').length, 0);
  assert.equal((await stack.paypal.getSubscription(stack.config.demoSubscriptionId)).data.status, 'ACTIVE');
});
