const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHECKOUT_STATES = new Set(['awaiting_approval', 'no_feasible_quote', 'awaiting_checkout', 'awaiting_paypal_approval',
  'ready_to_capture', 'completed', 'partial', 'uncertain', 'failed', 'expired', 'closed_unpaid']);

export class CheckoutRecoveryError extends Error {
  constructor(code = 'CHECKOUT_RECOVERY_CONFIGURATION_INVALID') {
    super(code); this.name = 'CheckoutRecoveryError'; this.code = code;
  }
}
const fail = (code) => { throw new CheckoutRecoveryError(code); };
const whole = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

/** A scheduler for existing read-only reconciliation. No financial client or write capability is accepted. */
export function createCheckoutRecovery({ enabled = false, listCandidates, withLease, reconcileExisting,
  now = () => Date.now(), setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
  intervalMs = 30_000, batchSize = 3, scanLimit = 30, sweepTimeoutMs = 10_000,
  backoffBaseMs = 30_000, backoffMaxMs = 300_000, backoffCapacity = 100 } = {}) {
  if (typeof enabled !== 'boolean' || typeof now !== 'function' || typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function' ||
    !whole(intervalMs, 1_000, 300_000) || !whole(batchSize, 1, 3) || !whole(scanLimit, batchSize, 100) ||
    !whole(sweepTimeoutMs, 1, 10_000) || !whole(backoffBaseMs, 1_000, 300_000) ||
    !whole(backoffMaxMs, backoffBaseMs, 300_000) || !whole(backoffCapacity, 1, 100) ||
    (enabled && [listCandidates, withLease, reconcileExisting].some((callback) => typeof callback !== 'function'))) fail();

  const backoff = new Map();
  const counters = { sweeps: 0, leaseBusy: 0, scanned: 0, attempted: 0, reconciled: 0, pending: 0, failed: 0, skipped: 0, aborted: 0 };
  let running = false, stopped = false, generation = 0, cursor = null;
  let timer = null, active = null, activeAbort = null;
  let lastSweepAt = null, nextSweepAt = null, lastError = null;

  function timestamp() {
    let value;
    try { value = Number(now()); } catch { fail('CHECKOUT_RECOVERY_CLOCK_UNAVAILABLE'); }
    if (!Number.isFinite(value) || value < 0 || value > 8_640_000_000_000_000) fail('CHECKOUT_RECOVERY_CLOCK_UNAVAILABLE');
    return value;
  }
  function status() {
    return { enabled, running, inFlight: active !== null, lastSweepAt, nextSweepAt,
      backoffEntries: backoff.size, lastError, counters: { ...counters } };
  }
  function clearTimer(handle) {
    if (handle === null) return;
    try { clearTimeoutFn(handle); }
    catch { running = false; lastError = 'CHECKOUT_RECOVERY_SCHEDULING_FAILED'; }
  }
  function clearScheduled() {
    clearTimer(timer);
    timer = null; nextSweepAt = null;
  }
  function defer(workflowId) {
    const failures = Math.min((backoff.get(workflowId)?.failures ?? 0) + 1, 30);
    const delay = Math.min(backoffMaxMs, backoffBaseMs * 2 ** (failures - 1));
    backoff.delete(workflowId);
    backoff.set(workflowId, { failures, nextAt: timestamp() + delay });
    while (backoff.size > backoffCapacity) backoff.delete(backoff.keys().next().value);
  }
  function pageOf(page, after) {
    if (!page || typeof page !== 'object' || Array.isArray(page) || !Array.isArray(page.ids) || page.ids.length > scanLimit ||
      page.ids.some((value, index) => !UUID.test(value ?? '') || (index > 0 && value <= page.ids[index - 1]) || (after !== null && value <= after)) ||
      !(page.nextCursor === null || (UUID.test(page.nextCursor ?? '') && page.ids.length > 0 && page.nextCursor === page.ids.at(-1)))) {
      fail('CHECKOUT_RECOVERY_INVALID_CANDIDATES');
    }
    return { ids: [...page.ids], nextCursor: page.nextCursor };
  }

  async function performSweep(sweepSignal) {
    const result = { performed: true, acquired: false, scanned: 0, attempted: 0, reconciled: 0, pending: 0, failed: 0, skipped: 0, aborted: false };
    let workSignal = sweepSignal, entered = false;
    counters.sweeps += 1; lastError = null;
    try {
      lastSweepAt = new Date(timestamp()).toISOString();
      const lease = await withLease({ signal: sweepSignal }, async (leaseSignal = sweepSignal) => {
        if (entered) fail('CHECKOUT_RECOVERY_LEASE_INVALID');
        entered = true; result.acquired = true;
        workSignal = leaseSignal === sweepSignal ? sweepSignal : AbortSignal.any([sweepSignal, leaseSignal]);
        workSignal.throwIfAborted();
        const page = pageOf(await listCandidates({ after: cursor, limit: scanLimit, signal: workSignal }), cursor);
        workSignal.throwIfAborted();
        // Eviction from the bounded map must not erase an existing cooldown partway through this batch.
        const coolingBeforeSweep = new Map(backoff);
        let consumed = true;
        for (const workflowId of page.ids) {
          workSignal.throwIfAborted();
          if (result.attempted >= batchSize) { consumed = false; break; }
          cursor = workflowId; result.scanned += 1;
          if ((coolingBeforeSweep.get(workflowId)?.nextAt ?? -1) > timestamp()) { result.skipped += 1; continue; }
          result.attempted += 1;
          try {
            const state = await reconcileExisting({ id: workflowId, signal: workSignal });
            workSignal.throwIfAborted();
            if (!state || !CHECKOUT_STATES.has(state.status)) fail('CHECKOUT_RECOVERY_RESULT_INVALID');
            if (state.status === 'uncertain') { defer(workflowId); result.pending += 1; }
            else { backoff.delete(workflowId); result.reconciled += 1; }
          } catch {
            if (workSignal.aborted) throw workSignal.reason;
            defer(workflowId); result.failed += 1; lastError = 'CHECKOUT_RECOVERY_RECONCILE_FAILED';
          }
        }
        if (consumed) cursor = page.nextCursor;
      });
      workSignal.throwIfAborted();
      if (!lease || typeof lease.acquired !== 'boolean' || lease.acquired !== entered) fail('CHECKOUT_RECOVERY_LEASE_INVALID');
      if (!lease.acquired) { result.reason = 'lease_busy'; counters.leaseBusy += 1; }
    } catch (error) {
      if (sweepSignal.aborted || workSignal.aborted) result.aborted = true;
      else {
        result.failed += 1;
        lastError = error instanceof CheckoutRecoveryError && error.code === 'CHECKOUT_RECOVERY_INVALID_CANDIDATES'
          ? error.code : 'CHECKOUT_RECOVERY_SWEEP_FAILED';
      }
    }
    for (const key of ['scanned', 'attempted', 'reconciled', 'pending', 'failed', 'skipped']) counters[key] += result[key];
    if (result.aborted) counters.aborted += 1;
    return result;
  }

  function schedule(delay) {
    clearScheduled();
    const scheduledGeneration = generation;
    try {
      nextSweepAt = new Date(timestamp() + delay).toISOString();
      timer = setTimeoutFn(() => {
        timer = null; nextSweepAt = null;
        if (running && generation === scheduledGeneration) void sweepOnce();
      }, delay);
      timer?.unref?.();
    } catch {
      running = false; clearTimer(timer); timer = null; nextSweepAt = null; lastError = 'CHECKOUT_RECOVERY_SCHEDULING_FAILED';
    }
  }
  function sweepOnce() {
    if (!enabled || stopped) return Promise.resolve({ performed: false, reason: enabled ? 'stopped' : 'disabled' });
    if (active) return active;
    clearScheduled();
    const sweepGeneration = generation;
    const abort = new AbortController();
    activeAbort = abort;
    let deadline;
    try { deadline = setTimeoutFn(() => abort.abort(new CheckoutRecoveryError('CHECKOUT_RECOVERY_DEADLINE')), sweepTimeoutMs); }
    catch {
      running = false; activeAbort = null; lastError = 'CHECKOUT_RECOVERY_SCHEDULING_FAILED';
      return Promise.resolve({ performed: false, reason: 'scheduling_failed' });
    }
    const promise = performSweep(abort.signal).finally(() => {
      clearTimer(deadline);
      if (active === promise) { active = null; activeAbort = null; }
      if (running && generation === sweepGeneration) schedule(intervalMs);
    });
    active = promise;
    return promise;
  }
  function start() {
    if (!enabled || running) return status();
    if (stopped) cursor = null;
    running = true; stopped = false; generation += 1;
    const startedGeneration = generation;
    if (active) {
      const afterDrain = () => { if (running && generation === startedGeneration) schedule(0); };
      void active.then(afterDrain, afterDrain);
    } else schedule(0);
    return status();
  }
  async function stop() {
    running = false; stopped = true; generation += 1; clearScheduled();
    activeAbort?.abort(new CheckoutRecoveryError('CHECKOUT_RECOVERY_STOPPED'));
    if (active) await active;
    return status();
  }

  return { start, sweepOnce, stop, status };
}
