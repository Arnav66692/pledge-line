import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckoutRecovery, CheckoutRecoveryError } from '../src/checkout-recovery.js';
import { createSandboxCheckout } from '../src/sandbox-checkout.js';

const id = (n) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

function clock() {
  let time = 0, sequence = 0;
  const tasks = new Map();
  return {
    now: () => time,
    setTimeoutFn(fn, delay) { const timer = ++sequence; tasks.set(timer, { fn, at: time + delay }); return timer; },
    clearTimeoutFn(timer) { tasks.delete(timer); },
    pending: () => tasks.size,
    async advance(ms) {
      time += ms;
      for (;;) {
        const due = [...tasks.entries()].filter(([, task]) => task.at <= time).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        tasks.delete(due[0]); due[1].fn(); await flush();
      }
      await flush();
    },
  };
}

function lease() {
  let held = false;
  return async ({ signal }, work) => {
    if (held) return { acquired: false };
    held = true;
    try { await work(signal); return { acquired: true }; }
    finally { held = false; }
  };
}

function fixture(options = {}) {
  const time = clock(), calls = [];
  const defaults = {
    enabled: true, ...time, intervalMs: 1_000, backoffBaseMs: 1_000,
    listCandidates: async () => ({ ids: [id(1)], nextCursor: null }),
    withLease: lease(),
    reconcileExisting: async ({ id: workflowId }) => { calls.push(workflowId); return { status: 'completed' }; },
  };
  return { time, calls, recovery: createCheckoutRecovery({ ...defaults, ...options }), defaults };
}

test('recovery is disabled by default and explicit construction never schedules or reads', async () => {
  const disabled = createCheckoutRecovery();
  assert.equal(disabled.status().enabled, false);
  assert.equal(disabled.status().running, false);
  assert.equal((await disabled.sweepOnce()).reason, 'disabled');
  disabled.start();
  await disabled.stop();
  const { recovery, time, calls } = fixture();
  assert.equal(time.pending(), 0);
  assert.deepEqual(calls, []);
  assert.equal(recovery.status().running, false);
});

test('invalid configuration and malformed candidate pages never reach reconciliation', async () => {
  assert.throws(() => createCheckoutRecovery({ enabled: true }), (error) => error instanceof CheckoutRecoveryError && error.code === 'CHECKOUT_RECOVERY_CONFIGURATION_INVALID');
  for (const options of [{ batchSize: 4 }, { sweepTimeoutMs: 10_001 }, { backoffCapacity: 101 }, { intervalMs: 0 }]) {
    assert.throws(() => fixture(options), (error) => error.code === 'CHECKOUT_RECOVERY_CONFIGURATION_INVALID');
  }
  for (const page of [{ ids: ['not-an-id'], nextCursor: null }, { ids: [id(1), id(1)], nextCursor: null }, { ids: [id(2), id(1)], nextCursor: null }]) {
    const { recovery, calls } = fixture({ listCandidates: async () => page });
    const result = await recovery.sweepOnce();
    assert.equal(result.failed, 1);
    assert.deepEqual(calls, []);
    assert.equal(recovery.status().lastError, 'CHECKOUT_RECOVERY_INVALID_CANDIDATES');
  }
});

test('timer failures stay sanitized and cannot leave automatic reads running', async () => {
  const rawError = 'private timer context';
  const brokenSchedule = fixture({ setTimeoutFn() { throw new Error(rawError); } });
  assert.equal(brokenSchedule.recovery.start().running, false);
  assert.equal((await brokenSchedule.recovery.sweepOnce()).reason, 'scheduling_failed');
  assert.deepEqual(brokenSchedule.calls, []);
  assert.equal(JSON.stringify(brokenSchedule.recovery.status()).includes(rawError), false);
  const failedClear = fixture({ clearTimeoutFn() { throw new Error(rawError); } });
  failedClear.recovery.start(); await failedClear.recovery.stop();
  await failedClear.time.advance(1_000);
  assert.deepEqual(failedClear.calls, []);
  assert.equal(failedClear.recovery.status().lastError, 'CHECKOUT_RECOVERY_SCHEDULING_FAILED');
});

test('a sweep reconciles at most three workflows serially and retains unvisited cursor entries', async () => {
  const listed = [id(1), id(2), id(3), id(4), id(5)], pages = [], reads = [];
  let active = 0, peak = 0;
  const { recovery } = fixture({
    listCandidates: async ({ after, limit }) => { pages.push({ after, limit }); return { ids: listed.filter((value) => !after || value > after), nextCursor: null }; },
    reconcileExisting: async ({ id: workflowId }) => { active += 1; peak = Math.max(peak, active); await Promise.resolve(); reads.push(workflowId); active -= 1; return { status: 'completed' }; },
  });
  const first = await recovery.sweepOnce();
  assert.equal(first.attempted, 3);
  assert.deepEqual(reads, listed.slice(0, 3));
  const second = await recovery.sweepOnce();
  assert.equal(second.attempted, 2);
  assert.deepEqual(reads, listed);
  assert.equal(pages[1].after, id(3));
  assert.equal(peak, 1);
  assert.equal(recovery.status().inFlight, false);
});

test('overlapping sweeps share one flight and competing controllers respect a shared lease', async () => {
  const sharedLease = lease();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const first = fixture({ withLease: sharedLease, reconcileExisting: async () => { await pending; return { status: 'completed' }; } });
  const second = fixture({ withLease: sharedLease });
  const active = first.recovery.sweepOnce();
  await flush();
  assert.equal(first.recovery.sweepOnce(), active);
  const busy = await second.recovery.sweepOnce();
  assert.equal(busy.acquired, false);
  assert.deepEqual(second.calls, []);
  release(); await active;
  assert.equal(first.recovery.status().counters.sweeps, 1);
  assert.equal(second.recovery.status().counters.leaseBusy, 1);
});

test('pending and failed reads back off without starving later candidates or exposing provider text', async () => {
  const rawError = 'private api-key and provider account details';
  const reads = [];
  const { recovery, time } = fixture({
    listCandidates: async () => ({ ids: [id(1), id(2)], nextCursor: null }),
    reconcileExisting: async ({ id: workflowId }) => { reads.push(workflowId); if (workflowId === id(1)) throw new Error(rawError); return { status: 'uncertain' }; },
  });
  const first = await recovery.sweepOnce();
  assert.equal(first.failed, 1); assert.equal(first.pending, 1);
  const immediate = await recovery.sweepOnce();
  assert.equal(immediate.attempted, 0); assert.equal(immediate.skipped, 2);
  await time.advance(1_000);
  await recovery.sweepOnce();
  assert.equal(reads.length, 4);
  const status = recovery.status();
  assert.equal(status.backoffEntries, 2);
  assert.equal(status.lastError, 'CHECKOUT_RECOVERY_RECONCILE_FAILED');
  assert.equal(JSON.stringify(status).includes(rawError), false);
  assert.equal(JSON.stringify(status).includes(id(1)), false);
});

test('backoff is bounded to five minutes and its map cannot grow beyond the configured cap', async () => {
  const attempts = [];
  const { recovery, time } = fixture({ backoffCapacity: 2,
    listCandidates: async () => ({ ids: [id(1), id(2), id(3)], nextCursor: null }),
    reconcileExisting: async ({ id: workflowId }) => { attempts.push(workflowId); return { status: 'uncertain' }; },
  });
  await recovery.sweepOnce();
  assert.equal(recovery.status().backoffEntries, 2);
  const atCapacity = await recovery.sweepOnce();
  assert.equal(atCapacity.attempted, 1);
  const single = fixture({ backoffBaseMs: 30_000, reconcileExisting: async () => ({ status: 'uncertain' }) });
  for (let i = 0; i < 7; i += 1) { await single.recovery.sweepOnce(); await single.time.advance(300_000); }
  await single.recovery.sweepOnce();
  await single.time.advance(299_999);
  assert.equal((await single.recovery.sweepOnce()).attempted, 0);
  await single.time.advance(1);
  assert.equal((await single.recovery.sweepOnce()).attempted, 1);
  assert.equal(time.pending(), 0);
});

test('keyset cursor advances over backoff entries instead of revisiting a poison first page forever', async () => {
  const readIds = [];
  const ids = [id(1), id(2), id(3), id(4)];
  const { recovery } = fixture({ scanLimit: 3,
    listCandidates: async ({ after, limit }) => { const page = ids.filter((value) => !after || value > after).slice(0, limit); return { ids: page, nextCursor: page.length === limit ? page.at(-1) : null }; },
    reconcileExisting: async ({ id: workflowId }) => { readIds.push(workflowId); return { status: 'uncertain' }; },
  });
  await recovery.sweepOnce();
  await recovery.sweepOnce();
  assert.deepEqual(readIds, ids);
  const skipped = await recovery.sweepOnce();
  assert.equal(skipped.skipped, 3);
  await recovery.sweepOnce();
  assert.deepEqual(readIds, ids);
});

test('stop aborts and drains a read, clears timers and prevents new reads until explicit restart', async () => {
  let started = 0, aborted = 0;
  const { recovery, time } = fixture({ reconcileExisting: async ({ signal }) => {
    started += 1;
    await new Promise((resolve, reject) => { signal.addEventListener('abort', () => { aborted += 1; reject(signal.reason); }, { once: true }); });
    return { status: 'completed' };
  } });
  recovery.start(); recovery.start();
  assert.equal(time.pending(), 1);
  await time.advance(0);
  assert.equal(started, 1);
  await recovery.stop(); await recovery.stop();
  assert.equal(aborted, 1);
  assert.equal(time.pending(), 0);
  assert.equal(recovery.status().running, false);
  assert.equal(recovery.status().inFlight, false);
  assert.equal((await recovery.sweepOnce()).reason, 'stopped');
  await time.advance(100_000);
  assert.equal(started, 1);
});

test('an explicit restart waits for the prior aborted read to drain before scheduling another', async () => {
  let finishCleanup, started = 0;
  const cleanup = new Promise((resolve) => { finishCleanup = resolve; });
  const { recovery, time } = fixture({ reconcileExisting: async ({ signal }) => {
    started += 1;
    if (started === 1) { await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); await cleanup; }
    return { status: 'completed' };
  } });
  recovery.start(); await time.advance(0);
  const stopping = recovery.stop(); recovery.start();
  await time.advance(0); assert.equal(started, 1);
  finishCleanup(); await stopping; await flush(); await time.advance(0);
  assert.equal(started, 2);
  await recovery.stop();
});

test('the sweep deadline aborts cooperative provider reads and no later workflow advances', async () => {
  const ids = [], { recovery, time } = fixture({
    listCandidates: async () => ({ ids: [id(1), id(2)], nextCursor: null }),
    reconcileExisting: async ({ id: workflowId, signal }) => { ids.push(workflowId); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); return { status: 'completed' }; },
  });
  const sweep = recovery.sweepOnce(); await flush();
  await time.advance(10_000); const result = await sweep;
  assert.equal(result.aborted, true);
  assert.deepEqual(ids, [id(1)]);
  assert.equal(time.pending(), 0);
});

test('lease loss aborts the same read signal without authorizing another provider operation', async () => {
  const lostLease = new AbortController();
  let providerSignal;
  const { recovery } = fixture({
    withLease: async ({ signal }, work) => { await work(lostLease.signal); return { acquired: true }; },
    reconcileExisting: async ({ signal }) => { providerSignal = signal; await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); return { status: 'completed' }; },
  });
  const sweep = recovery.sweepOnce(); await flush(); lostLease.abort();
  const result = await sweep;
  assert.equal(providerSignal.aborted, true);
  assert.equal(result.aborted, true);
});

function checkoutFixture() {
  let originalCaptureDispatches = 0, readable = false, changedPayee = false, financialCapabilityAccesses = 0;
  const allocation = { supplierId: 'lab-one', supplierName: 'Controlled supplier lab', payeeId: 'MERCHANT0001',
    currency: 'USD', quantity: 1, totalCents: 100 };
  const workflow = { id: id(1), organizationId: 'recovery-test', blockedReason: null,
    request: { specification: 'Controlled test order', quantity: 1, currency: 'USD', budgetCents: 100, deadline: '2026-11-01T00:00:00Z' },
    proposal: { quantity: 1, totalCents: 100, currency: 'USD', expiresAt: '2026-10-31T00:00:00Z', allocations: [allocation] },
    legs: [{ id: id(101), allocation, createState: 'ready', createAttempts: 1, captureState: 'reserved', captureAttempts: 0,
      orderId: 'ORDER0001', captureId: null, orderStatus: 'APPROVED', approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER0001', referenceId: 'approved-reference' }] };
  const lostCreation = { id: id(2), orderId: null, captureState: 'reserved', createState: 'unknown' };
  const reads = [];
  const store = {
    get: async ({ id: workflowId }) => workflowId === workflow.id ? structuredClone(workflow) : null,
    recordOrder: async ({ orderId, orderStatus }) => { assert.equal(orderId, workflow.legs[0].orderId); workflow.legs[0].orderStatus = orderStatus; },
    recordCapture: async ({ state, captureId, proof }) => { assert.equal(state, 'confirmed'); workflow.legs[0].captureState = state; workflow.legs[0].captureId = captureId; workflow.legs[0].captureEvidence = structuredClone(proof); },
    block: async ({ reason }) => { workflow.blockedReason ??= reason; },
  };
  const paypal = {
    mode: 'paypal-sandbox',
    async getOrder(orderId) {
      reads.push(orderId);
      return { id: orderId, intent: 'CAPTURE', status: readable ? 'COMPLETED' : 'APPROVED', purchase_units: [{
        reference_id: 'approved-reference', custom_id: 'approved-reference', payee: { merchant_id: changedPayee ? 'CHANGED00001' : allocation.payeeId },
        amount: { currency_code: 'USD', value: '1.00' }, ...(readable ? { payments: { captures: [{ id: 'CAPTURE01', status: 'COMPLETED', amount: { currency_code: 'USD', value: '1.00' } }] } } : {}),
      }] };
    },
    async getCapture(captureId) { return { id: captureId, status: 'COMPLETED', amount: { currency_code: 'USD', value: '1.00' }, supplementary_data: { related_ids: { order_id: 'ORDER0001' } } }; },
  };
  for (const method of ['createOrder', 'captureOrder', 'refund']) Object.defineProperty(paypal, method, { get() { financialCapabilityAccesses += 1; throw new Error('Financial capability accessed'); } });
  const checkout = () => createSandboxCheckout({ store, paypal, getQuote: async () => { throw new Error('Expired quotes must not be replaced for a read'); },
    organizationId: 'recovery-test', now: () => new Date('2026-11-05T06:00:00Z'), checkoutOrigin: 'http://127.0.0.1:3000', allowSandboxWrites: false });
  const options = () => ({ enabled: true, withLease: lease(),
    listCandidates: async () => ({ ids: [workflow, lostCreation].filter((record) => record.legs
      ? record.legs.some((leg) => leg.orderId && ['claimed', 'unknown'].includes(leg.captureState))
      : record.orderId && ['claimed', 'unknown'].includes(record.createState)).map((record) => record.id), nextCursor: null }),
    reconcileExisting: ({ id: workflowId }) => checkout().reconcile({ id: workflowId }),
  });
  return { workflow, lostCreation, reads, options,
    originalCapture() { originalCaptureDispatches += 1; workflow.legs[0].captureState = 'unknown'; workflow.legs[0].captureAttempts = 1; },
    showCapture() { readable = true; }, changePayee() { changedPayee = true; },
    counts: () => ({ originalCaptureDispatches, financialCapabilityAccesses }),
  };
}

test('restart recovers actual reconciliation proof after quote expiry without another capture or unknown-create lookup', async () => {
  const provider = checkoutFixture(); provider.originalCapture();
  const options = provider.options();
  for (const method of ['paypal', 'prepare', 'capture', 'refund']) Object.defineProperty(options, method, { get() { throw new Error('Financial capability accessed'); } });
  const first = createCheckoutRecovery(options);
  assert.equal((await first.sweepOnce()).pending, 1); await first.stop();
  provider.showCapture();
  const restarted = createCheckoutRecovery(provider.options());
  assert.equal((await restarted.sweepOnce()).reconciled, 1); await restarted.stop();
  assert.equal(provider.workflow.legs[0].captureState, 'confirmed');
  assert.equal(provider.workflow.legs[0].captureEvidence.captureId, 'CAPTURE01');
  assert.equal(provider.lostCreation.createState, 'unknown');
  assert.deepEqual(provider.reads, ['ORDER0001', 'ORDER0001']);
  assert.deepEqual(provider.counts(), { originalCaptureDispatches: 1, financialCapabilityAccesses: 0 });
});

test('an authoritative binding mismatch retains the original uncertain capture and never accesses financial methods', async () => {
  const provider = checkoutFixture(); provider.originalCapture(); provider.changePayee(); provider.showCapture();
  const recovery = createCheckoutRecovery(provider.options());
  assert.equal((await recovery.sweepOnce()).pending, 1); await recovery.stop();
  assert.equal(provider.workflow.legs[0].captureState, 'unknown');
  assert.equal(provider.workflow.legs[0].captureId, null);
  assert.equal(provider.workflow.blockedReason, 'provider_binding_changed');
  assert.deepEqual(provider.counts(), { originalCaptureDispatches: 1, financialCapabilityAccesses: 0 });
});
