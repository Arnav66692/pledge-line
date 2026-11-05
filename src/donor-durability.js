import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, timingSafeEqual } from 'node:crypto';
import { PayPalError, WriteNotAuthorized, toSnapshot } from './paypal.js';
import { sameMoney } from './cover.js';

const DAY_MS = 86400000;
const PROVIDER_ID = /^[A-Za-z0-9-]{1,128}$/;
const SUBSCRIPTION_STATUS = Object.freeze({ suspend: 'SUSPENDED', activate: 'ACTIVE', cancel: 'CANCELLED' });
const SENT_INVOICE = new Set(['SENT', 'UNPAID', 'PAID', 'PARTIALLY_PAID', 'PAYMENT_PENDING', 'MARKED_AS_PAID', 'REFUNDED', 'PARTIALLY_REFUNDED']);
const unresolved = (action) => action && ['claimed', 'responded', 'unknown'].includes(action.state);
const clone = (value) => structuredClone(value);

export class DonorDurabilityError extends Error {
  constructor(code = 'DONOR_DURABILITY_UNAVAILABLE') {
    super(code); this.name = 'DonorDurabilityError'; this.code = code; this.status = 503;
    this.durableRefused = true;
  }
}
const refuse = (code) => { throw new DonorDurabilityError(code); };
const signalCheck = (signal) => { if (signal?.aborted) refuse('DONOR_LEASE_ABORTED'); };

function minimalResult(value) {
  if (!value || typeof value !== 'object') return {};
  const result = {};
  if (typeof value.id === 'string' && PROVIDER_ID.test(value.id)) result.id = value.id;
  if ((typeof value.status === 'string' && value.status.length <= 50) || (Number.isInteger(value.status) && value.status >= 100 && value.status < 600)) result.status = value.status;
  if (typeof value.amountValue === 'string' && /^\d{1,7}\.\d{2}$/.test(value.amountValue)) result.amountValue = value.amountValue;
  if (typeof value.debugId === 'string' && value.debugId.length <= 128) result.debugId = value.debugId;
  if (Number.isFinite(value.ms) && value.ms >= 0) result.ms = value.ms;
  return result;
}

function identity(call, info) {
  const chargeId = call.proposalBaseline?.charge?.transaction_id;
  const common = { callId: call.id, pendingId: info.pending?.id ?? null, kind: info.kind, targetId: info.targetId,
    amountValue: info.fields?.amountValue ?? null, currency: info.fields?.currency ?? null };
  if (info.kind === 'cover_capture') {
    if (!PROVIDER_ID.test(chargeId ?? '')) refuse('DONOR_APPROVAL_BINDING_REQUIRED');
    return { ...common, operationKey: `cover:${chargeId}:capture`, resourceKey: `cover:${chargeId}` };
  }
  if (info.kind === 'cover_refund') return { ...common, operationKey: `cover:${info.targetId}:refund`, resourceKey: `cover:${info.targetId}` };
  if (info.kind === 'cover_unwind') {
    if (!PROVIDER_ID.test(info.fields?.captureId ?? '')) refuse('DONOR_APPROVAL_BINDING_REQUIRED');
    return { ...common, operationKey: `cover:${chargeId}:unwind`, resourceKey: `cover:${chargeId}` };
  }
  if (info.kind === 'create_draft') return { ...common, operationKey: `draft:${call.id}:${info.turn}`, resourceKey: `draft:${call.id}` };
  if (info.kind === 'delete_draft') return { ...common, operationKey: `delete:${info.targetId}`, resourceKey: `invoice:${info.targetId}` };
  if (info.kind === 'send_invoice') return { ...common, operationKey: `send:${info.targetId}`, resourceKey: `invoice:${info.targetId}` };
  if (info.kind === 'refund_request') return { ...common, operationKey: `refund-request:${chargeId ?? info.pending?.id}`, resourceKey: `refund-request:${chargeId ?? info.targetId}` };
  if (!SUBSCRIPTION_STATUS[info.kind] || !info.pending?.id) refuse('DONOR_ACTION_KIND_INVALID');
  return { ...common, operationKey: `pending:${info.pending.id}:${info.kind}`, resourceKey: `subscription:${info.targetId}` };
}

function expectedProof(action, event) {
  const snapshot = event.snapshot;
  if (event.type !== 'read' || event.error || event.seq <= action.binding.afterSeq) return false;
  const id = action.providerId ?? action.targetId;
  if (SUBSCRIPTION_STATUS[action.kind]) return event.what === 'subscription' && event.id === action.targetId && snapshot?.id === action.targetId && snapshot.status === SUBSCRIPTION_STATUS[action.kind];
  if (action.kind === 'send_invoice') return event.what === 'invoice' && event.id === action.targetId && snapshot?.id === action.targetId && SENT_INVOICE.has(snapshot.status);
  if (action.kind === 'delete_draft') return event.what === 'invoice' && event.id === action.targetId && event.notFound === true && snapshot === null;
  if (action.kind === 'create_draft') {
    const fields = action.binding.fields;
    return action.providerId && event.what === 'invoice' && event.id === id && snapshot?.id === id && snapshot.recipient_email === fields.recipientEmail &&
      sameMoney(snapshot.amount_value, fields.amountValue) && snapshot.amount_currency === fields.currency;
  }
  if (action.kind === 'cover_capture') return action.providerId && event.what === 'capture' && event.id === id && snapshot?.id === id && snapshot.status === 'COMPLETED' &&
    sameMoney(snapshot.amount_value, action.amountValue) && snapshot.amount_currency === action.currency;
  if (action.kind === 'cover_refund') return event.what === 'gift_charge' && event.id === action.targetId && snapshot?.id === action.targetId && snapshot.status === 'REFUNDED' &&
    sameMoney(snapshot.amount_value, action.amountValue) && snapshot.amount_currency === action.currency;
  if (action.kind === 'cover_unwind') return event.what === 'capture' && event.id === action.binding.fields.captureId && snapshot?.id === action.binding.fields.captureId && snapshot.status === 'REFUNDED' &&
    sameMoney(snapshot.amount_value, action.amountValue) && snapshot.amount_currency === action.currency;
  return false;
}

/** Every provider dispatch has a committed immutable claim and a durable returned-identity barrier. */
export function createDonorDurability({ store, ledger, now = () => new Date() } = {}) {
  if (!store || !ledger || typeof ledger.flush !== 'function') refuse('DONOR_DURABILITY_REQUIRED');
  const context = new AsyncLocalStorage();
  let service = null;
  const current = (id) => {
    const active = context.getStore();
    if (!active || active.id !== id || !service) refuse('DONOR_CALL_LEASE_REQUIRED');
    signalCheck(active.signal);
    return active;
  };
  async function persist(callId) {
    const active = current(callId);
    await ledger.flush();
    signalCheck(active.signal);
    const projected = service.snapshot(callId);
    const saved = await store.saveCall({ id: callId, snapshot: projected.snapshot, expectedRevision: active.revision });
    signalCheck(active.signal);
    active.revision = saved.revision;
    return saved;
  }
  async function confirmFromLedger(action) {
    if (!unresolved(action)) return action;
    const entries = ledger.byCall(action.callId);
    let evidence;
    if (action.kind === 'refund_request') {
      const chargeId = action.binding.source?.charge?.transaction_id;
      const requested = entries.find((event) => event.seq > action.binding.afterSeq && event.type === 'refund_request' &&
        event.subscriptionId === action.targetId && event.transactionId === chargeId);
      if (requested) evidence = { kind: 'durable_refund_request', seq: requested.seq, transactionId: chargeId };
    } else {
      const proof = entries.filter((event) => expectedProof(action, event)).at(-1);
      if (proof) evidence = { kind: 'authoritative_read', seq: proof.seq, what: proof.what, id: proof.id,
        snapshot: proof.snapshot, notFound: proof.notFound === true, debugId: proof.debugId ?? null };
    }
    if (!evidence) return action;
    await ledger.flush();
    return store.recordActionOutcome({ id: action.id, state: 'confirmed', evidence });
  }
  async function runAction(call, info, dispatch, staging) {
    const active = current(call.id);
    const audit = ledger.byCall(call.id);
    const lastRestored = audit.filter((event) => event.type === 'session_restored').at(-1)?.seq ?? 0;
    const cleanupRead = audit.filter((event) => event.type === 'read' && event.what === 'invoice' && event.id === info.targetId && !event.error).at(-1);
    const knownDraftCleanup = staging && info.kind === 'delete_draft' && call.openDraftId === info.targetId && call.uncertainDraftId !== info.targetId &&
      cleanupRead?.turn === info.turn && cleanupRead.seq > lastRestored && cleanupRead.snapshot?.id === info.targetId && cleanupRead.snapshot.status === 'DRAFT';
    if (((!call.verified || call.locked) && !knownDraftCleanup) || (call.ended && !staging)) refuse('DONOR_VERIFIED_CALL_REQUIRED');
    if (!staging) {
      const pending = info.pending;
      const yes = ledger.byCall(call.id).find((event) => event.type === 'yes' && event.pendingId === pending?.id && event.turn === info.turn);
      if (!pending || !yes || call.pending?.id !== pending.id || call.proposalBaseline?.pendingId !== pending.id) refuse('DONOR_APPROVAL_BINDING_REQUIRED');
    }
    const descriptor = identity(call, info);
    const afterSeq = ledger.byCall(call.id).at(-1)?.seq ?? 0;
    const pending = info.pending ? { id: info.pending.id, kind: info.pending.kind, targetId: info.pending.targetId,
      askedTurn: info.pending.askedTurn, createdAt: info.pending.createdAt, expiresAt: info.pending.expiresAt,
      legs: info.pending.legs ?? null } : null;
    const binding = { turn: info.turn, afterSeq, fields: clone(info.fields ?? {}), pending,
      source: clone(call.proposalBaseline ?? {}) };
    let claimed;
    try {
      await persist(call.id);
      signalCheck(active.signal);
      claimed = await store.claimAction({ ...descriptor, binding });
      signalCheck(active.signal);
      if (!claimed.claimed) refuse('DONOR_ACTION_ALREADY_ATTEMPTED');
    } catch (error) {
      call.pending = null; call.proposalBaseline = null; call.chargeAsked = null; call.coverAsked = null;
      if (error instanceof DonorDurabilityError) throw error;
      refuse('DONOR_ACTION_CLAIM_UNAVAILABLE');
    }
    let action = claimed.action, observedResult = null, observed = false, dispatched = false;
    const onResponse = async (result) => {
      observedResult = minimalResult(result);
      const providerId = observedResult.id ?? (['suspend', 'activate', 'cancel', 'send_invoice', 'delete_draft', 'refund_request'].includes(info.kind) ? info.targetId : null);
      // Even a late response can preserve its provider identity. Lease loss still forbids another dispatch.
      action = await store.recordActionResponse({ id: action.id, providerId, result: observedResult });
      observed = true;
      signalCheck(active.signal);
    };
    try {
      signalCheck(active.signal);
      dispatched = true;
      const result = await dispatch({ requestId: action.requestId, onResponse });
      if (!observed) await onResponse(result);
      signalCheck(active.signal);
      await confirmFromLedger(action);
      return result;
    } catch (cause) {
      const refusedByProvider = cause instanceof PayPalError && cause.status >= 400 && cause.status < 500;
      const localTokenRefusal = cause instanceof WriteNotAuthorized;
      try {
        await store.recordActionOutcome({ id: action.id, state: refusedByProvider || localTokenRefusal ? 'failed' : 'unknown',
          evidence: { kind: refusedByProvider ? 'provider_refusal' : localTokenRefusal ? 'local_token_refusal' : 'unverified_outcome',
            httpStatus: refusedByProvider ? cause.status : 0, errorName: typeof cause?.name === 'string' ? cause.name.slice(0, 80) : 'Error' } });
      } catch { /* The committed claim remains occupied when even outcome recording is uncertain. */ }
      if (!dispatched) refuse('DONOR_DISPATCH_REFUSED');
      if (cause instanceof PayPalError || cause instanceof WriteNotAuthorized) throw cause;
      const error = new PayPalError({ status: 0, name: 'DURABLE_OUTCOME_UNVERIFIED', message: 'The dispatched step could not be durably confirmed' });
      if (observedResult?.id) {
        error.resultId = observedResult.id;
        if (info.kind === 'cover_capture') error.captureId = observedResult.id;
      }
      throw error;
    }
  }
  async function reconcileCall(callId) {
    current(callId);
    const actions = await store.listRecoverableActions({ limit: 100, callId });
    for (const action of actions) {
      signalCheck(context.getStore().signal);
      await confirmFromLedger(action);
    }
  }
  async function recoverAction(action, paypal) {
    const active = current(action.callId);
    if (!unresolved(action)) return false;
    let what, id, getter;
    if (SUBSCRIPTION_STATUS[action.kind]) { what = 'subscription'; id = action.targetId; getter = 'getSubscription'; }
    else if (['send_invoice', 'delete_draft', 'create_draft'].includes(action.kind)) { what = 'invoice'; id = action.kind === 'create_draft' ? action.providerId : action.targetId; getter = 'getInvoice'; }
    else if (action.kind === 'cover_capture') { what = 'capture'; id = action.providerId; getter = 'getCapture'; }
    else if (action.kind === 'cover_refund') { what = 'gift_charge'; id = action.targetId; getter = 'getCapture'; }
    else if (action.kind === 'cover_unwind') { what = 'capture'; id = action.binding.fields.captureId; getter = 'getCapture'; }
    else return (await confirmFromLedger(action)).state === 'confirmed';
    if (!PROVIDER_ID.test(id ?? '') || typeof paypal?.[getter] !== 'function') return false;
    signalCheck(active.signal);
    const response = await paypal[getter](id, { signal: active.signal });
    signalCheck(active.signal);
    const snapshot = response.notFound ? null : toSnapshot(what, response.data);
    const event = ledger.append({ type: 'read', callId: action.callId, turn: action.binding.turn,
      what, id, status: snapshot?.status ?? null, snapshot, ...(response.notFound ? { notFound: true } : {}),
      debugId: response.debugId ?? null, ms: response.ms ?? 0, durableRecovery: true });
    await ledger.flush();
    const confirmed = await confirmFromLedger(action);
    service.applyDurableRead?.(action.callId, event);
    if (confirmed.state === 'confirmed') ledger.append({ type: 'donor_action_reconciled', callId: action.callId,
      turn: action.binding.turn, kind: action.kind, actionId: action.id });
    return confirmed.state === 'confirmed';
  }
  return {
    bindService: (calls) => { if (service && service !== calls) refuse('DONOR_SERVICE_ALREADY_BOUND'); service = calls; },
    withContext: (value, fn) => context.run(value, fn), persist, reconcileCall, recoverAction,
    runWrite: (call, info, dispatch) => runAction(call, info, dispatch, false),
    runStaging: (call, info, dispatch) => runAction(call, info, dispatch, true),
  };
}

/** Async HTTP-facing service. Default call service remains synchronous when this wrapper is absent. */
export function wrapDurableCalls({ calls, store, ledger, durability, paypal = null, now = () => new Date(), sessionTtlMs = DAY_MS } = {}) {
  if (!calls || !store || !ledger || !durability || !Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1000 || sessionTtlMs > 30 * DAY_MS) refuse('DONOR_DURABILITY_REQUIRED');
  durability.bindService(calls);
  const revisions = new Map();
  let lastRecoveryAt = 0, recoveryCursor = null, lastDiscoveryAt = 0;
  const expiresAt = () => new Date(now().getTime() + sessionTtlMs).toISOString();
  async function load(id, allowExpired = false) {
    const record = await store.loadCall({ id });
    if (!record || (!allowExpired && Date.parse(record.expiresAt) <= now().getTime())) refuse('DONOR_CALL_EXPIRED');
    if (!calls.has(id) || revisions.get(id) !== record.revision) {
      calls.restore(record);
      revisions.set(id, record.revision);
    }
    return record;
  }
  async function run(id, fn, { allowExpired = false } = {}) {
    const leased = await store.withCallLease({ id }, async (signal) => {
      await ledger.reload();
      await ledger.ensureCapacity();
      const record = await load(id, allowExpired);
      const active = { id, revision: record.revision, signal };
      return durability.withContext(active, async () => {
        try {
          signalCheck(signal);
          const result = await fn();
          signalCheck(signal);
          await durability.reconcileCall(id);
          await durability.persist(id);
          revisions.set(id, active.revision);
          return result;
        } catch (error) {
          // Future requests must hydrate the last committed snapshot, not unfinished in-memory changes.
          try { await ledger.flush(); } catch { /* No successful HTTP response follows. */ }
          calls.forget(id); revisions.delete(id);
          throw error;
        }
      });
    });
    if (!leased.acquired) refuse('DONOR_CALL_BUSY');
    return leased.value;
  }
  async function recover() {
    if (!paypal || now().getTime() - lastRecoveryAt < 30000) return 0;
    lastRecoveryAt = now().getTime();
    let candidates = await store.listRecoverableActions({ limit: 3, after: recoveryCursor });
    if (!candidates.length && recoveryCursor) {
      recoveryCursor = null;
      candidates = await store.listRecoverableActions({ limit: 3 });
    }
    if (!candidates.length) return 0;
    const last = candidates.at(-1);
    recoveryCursor = { id: last.id, updatedAt: last.updatedAt };
    let confirmed = 0;
    for (const action of candidates) {
      try { if (await run(action.callId, () => durability.recoverAction(action, paypal), { allowExpired: true })) confirmed += 1; }
      catch { /* The durable unresolved action retains its original identity and blocks replacement. */ }
    }
    return confirmed;
  }
  return {
    durable: true,
    async start(input) {
      await ledger.ensureCapacity();
      const started = calls.start(input);
      try {
        const projected = calls.snapshot(started.callId);
        const saved = await store.createCall({ ...projected, expiresAt: expiresAt() });
        await ledger.flush();
        revisions.set(started.callId, saved.revision);
        calls.markDurableReplyReady?.(started.callId);
        return started;
      } catch (error) { calls.forget(started.callId); throw error; }
    },
    async authenticate(id, given) {
      const record = await store.loadCall({ id });
      const actual = typeof given === 'string' ? given : '';
      const expected = record && Date.parse(record.expiresAt) > now().getTime() ? Buffer.from(record.sessionSecretHash, 'hex') : Buffer.alloc(32);
      const hashed = createHash('sha256').update(actual).digest();
      return actual.length > 0 && actual.length <= 200 && expected.length === 32 && timingSafeEqual(hashed, expected);
    },
    get: (id) => run(id, () => calls.get(id)),
    async turn(id, input, arrival) {
      const result = await run(id, () => calls.turn(id, input, arrival));
      calls.markDurableReplyReady?.(id);
      return result;
    },
    logGap: (id, input) => run(id, () => calls.logGap(id, input)),
    end: (id, reason) => run(id, () => calls.end(id, reason)),
    async sweep() {
      let count = 0;
      calls.pruneMemory?.();
      const candidates = new Set(calls.ids().filter((id) => !calls.needsSweep || calls.needsSweep(id)));
      if (store.listSweepCalls && calls.sweepBefore && now().getTime() - lastDiscoveryAt >= 30000) {
        lastDiscoveryAt = now().getTime();
        for (const id of await store.listSweepCalls({ activeBefore: calls.sweepBefore(), expiryBefore: now().getTime(), limit: 3 })) candidates.add(id);
      }
      for (const id of candidates) {
        try { count += await run(id, () => calls.sweepOne(id), { allowExpired: true }); } catch { /* Retain persisted call and action evidence. */ }
      }
      await recover();
      return count;
    },
    recover,
    flush: () => ledger.flush(),
    snapshot: (id) => calls.snapshot(id),
  };
}

/** The fake PayPal adapter has no transport callback; use the same barrier in durable mock acceptance. */
export function observeMockPayPal(paypal) {
  if (paypal?.mode !== 'mock') return paypal;
  const positions = { suspendSubscription: 2, activateSubscription: 2, cancelSubscription: 2, sendInvoice: 2,
    captureSponsorHold: 2, refundCharge: 2, unwindSponsorCapture: 2, createDraftInvoice: 1, deleteDraftInvoice: 1 };
  const result = { ...paypal };
  for (const [name, position] of Object.entries(positions)) {
    if (typeof paypal[name] !== 'function') continue;
    result[name] = async (...args) => {
      const response = await paypal[name](...args);
      const observer = args[position]?.onResponse;
      if (observer) await observer(response);
      return response;
    };
  }
  return result;
}
