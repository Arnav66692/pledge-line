import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDonorDurability, wrapDurableCalls, observeMockPayPal } from '../src/donor-durability.js';
import { createDurableLedger } from '../src/durable-ledger.js';
import { createCallService } from '../src/call.js';
import { createTokens, createGate } from '../src/gate.js';
import { createMockPayPal, MOCK_TRANSACTION_ID } from '../src/paypal-mock.js';
import { createRouter } from '../src/router.js';
import { createRefundDesk } from '../src/refund-desk.js';
import { loadConfig } from '../src/config.js';
import { PayPalError } from '../src/paypal.js';
import { makeClock } from './helpers.js';

const copy = (x) => structuredClone(x);
function memoryStore() {
  const records = new Map(), actions = new Map(), events = new Map(), leased = new Set(), trace = [];
  let sequence = 0;
  const unresolved = (a) => ['claimed', 'responded', 'unknown'].includes(a.state);
  const store = {
    records, actions, events, trace, failClaim: false, failResponse: false, loseLease: false,
    reserveEventSequences: async ({ count }) => Array.from({ length: count }, () => ++sequence),
    appendEvents: async ({ events: values }) => { for (const event of values) events.set(event.seq, copy(event)); return values.length; },
    listEvents: async ({ afterSeq = 0, limit = 10000 } = {}) => [...events.values()].filter((x) => x.seq > afterSeq).sort((a, b) => a.seq - b.seq).slice(0, limit).map(copy),
    createCall: async (value) => { const row = { ...copy(value), revision: 0 }; records.set(value.id, row); trace.push('call-created'); return copy(row); },
    loadCall: async ({ id }) => copy(records.get(id) ?? null),
    getAction: async ({ operationKey }) => copy([...actions.values()].find((action) => action.operationKey === operationKey) ?? null),
    listSweepCalls: async ({ activeBefore, expiryBefore, limit }) => [...records.values()].filter((r) => !r.snapshot.ended &&
      (r.snapshot.lastActiveAt <= activeBefore || r.snapshot.pending?.expiresAt <= expiryBefore)).slice(0, limit).map((r) => r.id),
    saveCall: async ({ id, snapshot, expectedRevision }) => {
      const row = records.get(id); assert.equal(row.revision, expectedRevision, 'snapshot revision must be current');
      row.snapshot = copy(snapshot); row.revision += 1; trace.push('snapshot'); return copy(row);
    },
    claimAction: async (value) => {
      assert.ok(records.has(value.callId));
      assert.ok([...events.values()].some((e) => e.callId === value.callId && (e.type === 'yes' || value.kind.includes('draft'))), 'audit must be committed before claim');
      if (store.failClaim) throw Error('synthetic failed claim');
      const same = [...actions.values()].find((a) => a.operationKey === value.operationKey);
      if (same) return { claimed: false, action: copy(same) };
      const conflict = [...actions.values()].find((a) => a.resourceKey === value.resourceKey && unresolved(a));
      if (conflict) return { claimed: false, blocked: true, action: copy(conflict) };
      const action = { ...copy(value), id: randomUUID(), requestId: randomUUID(), state: 'claimed', providerId: null, attemptCount: 1, updatedAt: '2026-11-03T18:00:00.000Z' };
      actions.set(action.id, action); trace.push(`claim:${action.kind}`); return { claimed: true, action: copy(action) };
    },
    recordActionResponse: async ({ id, providerId, result }) => { if (store.failResponse) throw Error('synthetic failed response commit'); const a = actions.get(id); Object.assign(a, { providerId, result: copy(result), state: a.state === 'unknown' ? 'unknown' : 'responded' }); trace.push(`response:${a.kind}`); return copy(a); },
    recordActionOutcome: async ({ id, state, evidence }) => { const a = actions.get(id); assert.ok(unresolved(a) || a.state === state); Object.assign(a, { state, evidence: copy(evidence) }); trace.push(`outcome:${a.kind}:${state}`); return copy(a); },
    listRecoverableActions: async ({ callId = null, after = null, limit = 30 } = {}) => [...actions.values()].filter((a) => unresolved(a) && (a.providerId || ['suspend', 'activate', 'cancel', 'cover_refund', 'send_invoice', 'delete_draft', 'refund_request'].includes(a.kind)))
      .filter((a) => !callId || a.callId === callId).filter((a) => !after || a.updatedAt > after.updatedAt || a.updatedAt === after.updatedAt && a.id > after.id)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id)).slice(0, limit).map(copy),
    withCallLease: async ({ id }, fn) => {
      if (leased.has(id)) return { acquired: false };
      leased.add(id); const controller = new AbortController(); store.abortLease = () => controller.abort();
      try { return { acquired: true, value: await fn(controller.signal) }; } finally { leased.delete(id); }
    },
  };
  return store;
}
async function stack({ store = memoryStore(), clock = makeClock(), modify = null, wrapOptions = {} } = {}) {
  const config = loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules' });
  const ledger = createDurableLedger({ store, now: clock.now }); await ledger.ready();
  const tokens = createTokens({ now: clock.now, ttlMs: config.limits.tokenTtlMs });
  const provider = createMockPayPal({ tokens, now: clock.now });
  let paypal = observeMockPayPal(provider); if (modify) paypal = modify(paypal, store);
  const durability = createDonorDurability({ store, ledger, now: clock.now });
  const gate = createGate({ ledger, tokens, now: clock.now, pendingTtlMs: config.limits.pendingTtlMs, durability });
  const raw = createCallService({ config, ledger, paypal, router: createRouter({ mode: 'rules' }), gate, now: clock.now,
    sleep: async () => {}, desk: createRefundDesk({ ledger, tokens }), durability });
  const calls = wrapDurableCalls({ calls: raw, store, ledger, durability, paypal, now: clock.now, ...wrapOptions });
  const answered = new Map();
  const say = async (id, text, source = 'typed') => { const result = await calls.turn(id, { text, source, answering: answered.get(id) ?? 0 }); answered.set(id, result.turn); return result; };
  return { store, ledger, config, tokens, paypal, durability, raw, calls, say, clock, answered };
}
const verify = async (s) => { const started = await s.calls.start(); await s.say(started.callId, s.config.pin, 'keypad'); return started; };
const pauseOffer = async (s, id) => s.say(id, 'Please pause my gift');

test('durable consent commits a claim before dispatch and confirms only with authoritative read', async () => {
  const s = await stack({ modify: (p, store) => ({ ...p, suspendSubscription: async (...args) => {
    assert.ok([...store.actions.values()].some((a) => a.kind === 'suspend' && a.state === 'claimed'));
    assert.ok([...store.events.values()].some((e) => e.type === 'yes'));
    assert.match(args[2].requestId, /^[0-9a-f-]{36}$/);
    store.trace.push('dispatch:suspend'); return p.suspendSubscription(...args);
  } }) });
  const { callId } = await verify(s); await pauseOffer(s, callId); await s.say(callId, 'yes');
  const action = [...s.store.actions.values()].find((a) => a.kind === 'suspend');
  assert.equal(action.state, 'confirmed'); assert.equal(action.attemptCount, 1);
  assert.ok(s.store.trace.indexOf('claim:suspend') < s.store.trace.indexOf('dispatch:suspend'));
  assert.equal((await s.calls.get(callId)).record.subscription.status, 'SUSPENDED');
});

test('restart restores hashed ownership, withdraws pending authority and requires PIN and a fresh proposal', async () => {
  const first = await stack(); const started = await verify(first); await pauseOffer(first, started.callId);
  const second = await stack({ store: first.store, clock: first.clock });
  assert.equal(await second.calls.authenticate(started.callId, started.sessionSecret), true);
  assert.equal(await second.calls.authenticate(started.callId, 'wrong'), false);
  const restored = await second.calls.get(started.callId);
  assert.equal(restored.verified, false); assert.equal(restored.pending, null); assert.equal(restored.restored, true);
  second.answered.set(started.callId, restored.turn); await second.say(started.callId, 'yes');
  assert.equal(first.store.actions.size, 0);
  await second.say(started.callId, second.config.pin, 'keypad'); await pauseOffer(second, started.callId); await second.say(started.callId, 'yes');
  assert.equal([...first.store.actions.values()].filter((a) => a.kind === 'suspend').length, 1);
  const encoded = JSON.stringify([...first.store.records.values()]); assert.ok(!encoded.includes(started.sessionSecret));
});

test('claim failure makes no provider attempt and cannot return a successful turn', async () => {
  let attempts = 0;
  const s = await stack({ modify: (p) => ({ ...p, suspendSubscription: (...args) => { attempts += 1; return p.suspendSubscription(...args); } }) });
  const { callId } = await verify(s); await pauseOffer(s, callId); s.store.failClaim = true;
  await assert.rejects(s.say(callId, 'yes'), /DONOR_ACTION_CLAIM_UNAVAILABLE/);
  assert.equal(attempts, 0); assert.ok(![...s.store.events.values()].some((e) => e.type === 'write'));
});

test('a lost subscription response blocks replacement and read-only recovery never repeats the financial write', async () => {
  let attempts = 0;
  const s = await stack({ modify: (p) => ({ ...p, suspendSubscription: async (...args) => { attempts += 1; await p.suspendSubscription(...args); throw new PayPalError({ status: 0, name: 'LOST_RESPONSE' }); } }) });
  const { callId } = await verify(s); await pauseOffer(s, callId); await s.say(callId, 'yes');
  const action = [...s.store.actions.values()][0];
  assert.equal(action.state, 'confirmed', 'fresh post-write status can confirm even after response loss');
  await s.calls.recover(); assert.equal(attempts, 1);
});

test('capture identity commits before later reads fail and recovery uses GET without another money leg', async () => {
  let captureAttempts = 0, failCaptureRead = true;
  const s = await stack({ modify: (p, store) => ({ ...p,
    captureSponsorHold: async (...args) => { captureAttempts += 1; return p.captureSponsorHold(...args); },
    getCapture: async (id) => {
      if (id !== MOCK_TRANSACTION_ID && failCaptureRead) {
        assert.ok([...store.actions.values()].some((a) => a.kind === 'cover_capture' && a.providerId === id));
        throw new PayPalError({ status: 0, name: 'SYNTHETIC_READ_LOSS' });
      }
      return p.getCapture(id);
    },
  }) });
  const { callId } = await verify(s); await s.say(callId, "I lost my job, I can't do it this month."); await s.say(callId, 'yes');
  const action = [...s.store.actions.values()].find((a) => a.kind === 'cover_capture');
  assert.equal(action.state, 'unknown'); assert.ok(action.providerId); assert.equal(captureAttempts, 1);
  failCaptureRead = false; await s.calls.recover();
  assert.equal([...s.store.actions.values()].find((a) => a.id === action.id).state, 'confirmed');
  assert.equal(captureAttempts, 1); assert.equal(s.paypal.mockMoney().refunded[MOCK_TRANSACTION_ID] ?? 0, 0, 'recovery never auto-advances a refund');
});

test('Covered Month succeeds as two separate committed actions and no second capture can be made for the charge', async () => {
  const s = await stack(); const { callId } = await verify(s);
  await s.say(callId, "I lost my job, I can't do it this month."); await s.say(callId, 'yes');
  assert.deepEqual([...s.store.actions.values()].map((a) => [a.kind, a.state]), [['cover_capture', 'confirmed'], ['cover_refund', 'confirmed']]);
  assert.equal(s.paypal.mockMoney().captures.length, 1);
  const other = await verify(s); await s.say(other.callId, "I lost my job, I can't do it this month."); await s.say(other.callId, 'yes');
  assert.equal(s.paypal.mockMoney().captures.length, 1);
});

test('a lost lease after a committed claim blocks dispatch and leaves the original claim occupied', async () => {
  const s = await stack(); const originalClaim = s.store.claimAction;
  s.store.claimAction = async (input) => { const result = await originalClaim(input); s.store.abortLease(); return result; };
  const { callId } = await verify(s); await pauseOffer(s, callId);
  await assert.rejects(s.say(callId, 'yes'), /DONOR_LEASE_ABORTED/);
  assert.equal([...s.store.actions.values()][0].state, 'claimed');
  assert.equal((await s.paypal.getSubscription(s.config.demoSubscriptionId)).data.status, 'ACTIVE');
});

test('unknown capture without a returned ID stays blocked through restart and recovery', async () => {
  let attempts = 0;
  const first = await stack({ modify: (p) => ({ ...p, captureSponsorHold: async () => { attempts += 1; throw new PayPalError({ status: 0, name: 'NO_RESPONSE' }); } }) });
  const { callId } = await verify(first); await first.say(callId, "I lost my job, I can't do it this month."); await first.say(callId, 'yes');
  const action = [...first.store.actions.values()][0]; assert.equal(action.kind, 'cover_capture'); assert.equal(action.providerId, null); assert.equal(action.state, 'unknown');
  const second = await stack({ store: first.store, clock: first.clock, modify: (p) => ({ ...p, captureSponsorHold: async () => { attempts += 1; throw Error('must not replay'); } }) });
  await second.calls.recover();
  const other = await verify(second); await second.say(other.callId, "I lost my job, I can't do it this month.");
  try { await second.say(other.callId, 'yes'); } catch (error) { assert.match(error.message, /DONOR_ACTION_ALREADY_ATTEMPTED/); }
  assert.equal(attempts, 1); assert.equal([...first.store.actions.values()][0].state, 'unknown');
});

test('late capture response preserves its ID after lease loss but cannot trigger a refund', async () => {
  const s = await stack({ modify: (p, store) => ({ ...p, captureSponsorHold: async (...args) => {
    const ctx = args[2];
    args[2] = { ...ctx, onResponse: async (result) => { store.abortLease(); await ctx.onResponse(result); } };
    return p.captureSponsorHold(...args);
  } }) });
  const { callId } = await verify(s); await s.say(callId, "I lost my job, I can't do it this month.");
  await assert.rejects(s.say(callId, 'yes'), /DONOR_LEASE_ABORTED/);
  const action = [...s.store.actions.values()][0];
  assert.equal(action.state, 'unknown'); assert.ok(action.providerId);
  assert.equal(s.paypal.mockMoney().refunded[MOCK_TRANSACTION_ID] ?? 0, 0);
});

test('read-only reconciliation can settle known outcomes after browser ownership expires', async () => {
  let failCaptureRead = true;
  const s = await stack({ modify: (p) => ({ ...p, getCapture: (id) => {
    if (id !== MOCK_TRANSACTION_ID && failCaptureRead) throw new PayPalError({ status: 0, name: 'READ_DELAY' });
    return p.getCapture(id);
  } }) });
  const started = await verify(s); await s.say(started.callId, "I lost my job, I can't do it this month."); await s.say(started.callId, 'yes');
  const action = [...s.store.actions.values()][0]; assert.equal(action.state, 'unknown');
  s.clock.advance(86400001); failCaptureRead = false;
  assert.equal(await s.calls.authenticate(started.callId, started.sessionSecret), false);
  assert.equal(await s.calls.recover(), 1); assert.equal(action.state, 'confirmed');
});

test('draft create, send and deletion are independently claimed and durable across denied consent', async () => {
  const s = await stack(); const { callId } = await verify(s);
  await s.say(callId, 'I want to give 10 dollars one time.');
  const draft = [...s.store.actions.values()].find((a) => a.kind === 'create_draft');
  assert.equal(draft.state, 'confirmed'); assert.ok(draft.providerId);
  await s.say(callId, 'no');
  assert.equal([...s.store.actions.values()].find((a) => a.kind === 'delete_draft').state, 'confirmed');
  await s.say(callId, 'I want to give 12 dollars one time.'); await s.say(callId, 'yes');
  assert.equal([...s.store.actions.values()].find((a) => a.kind === 'send_invoice').state, 'confirmed');
});

test('restored known drafts can be explicitly ended without restoring financial authority', async () => {
  const first = await stack(); const started = await verify(first); await first.say(started.callId, 'I want to give 10 dollars one time.');
  // Keep the fake provider's remote object alive while replacing all call/consent state.
  const second = await stack({ store: first.store, clock: first.clock, modify: () => first.paypal });
  await second.calls.get(started.callId);
  assert.equal(second.raw.get(started.callId).verified, false);
  const ended = await second.calls.end(started.callId);
  assert.equal(ended.state.ended, true); assert.equal(ended.state.verified, false);
  assert.equal([...first.store.actions.values()].filter((a) => a.kind === 'delete_draft').length, 1);
  assert.equal([...first.store.actions.values()].filter((a) => ['send_invoice', 'cover_capture'].includes(a.kind)).length, 0);
});

test('a bounded durable sweep finds an idle call that was never hydrated after restart', async () => {
  const first = await stack(); const started = await verify(first); await first.say(started.callId, 'I want to give 10 dollars one time.');
  first.clock.advance(first.config.limits.callIdleMs + 1);
  const second = await stack({ store: first.store, clock: first.clock, modify: () => first.paypal });
  assert.equal(second.raw.ids().length, 0);
  assert.equal(await second.calls.sweep(), 1);
  assert.equal(first.store.records.get(started.callId).snapshot.ended, true);
  assert.equal([...first.store.actions.values()].filter((a) => a.kind === 'delete_draft').length, 1);
});

test('two-worker stale sweep discovery cannot restore or persist a freshly active verified proposal', async () => {
  for (const cached of [false, true]) {
    const first = await stack(), { callId } = await verify(first);
    const second = await stack({ store: first.store, clock: first.clock, modify: () => first.paypal });
    if (cached) {
      await second.calls.get(callId);
      await first.say(callId, first.config.pin, 'keypad');
    }
    first.clock.advance(first.config.limits.callIdleMs + 1);
    const lease = first.store.withCallLease, restore = second.raw.restore;
    let fresh, eventsAfterRefresh, restores = 0;
    second.raw.restore = (...args) => { restores += 1; return restore(...args); };
    first.store.withCallLease = async (input, work) => {
      assert.equal(input.id, callId);
      // Discovery has finished, but the second worker has not acquired its lease yet.
      // Refresh through the first worker now, so an eligibility read outside the lease would be stale.
      first.store.withCallLease = lease;
      const reply = await pauseOffer(first, callId);
      assert.equal(reply.state.verified, true); assert.ok(reply.state.pending);
      fresh = copy(first.store.records.get(callId)); eventsAfterRefresh = copy([...first.store.events.values()]);
      return lease(input, work);
    };
    assert.equal(await second.calls.sweep(), 0, `cached=${cached}`);
    assert.equal(restores, 0, 'The stale candidate must be skipped before hydration.');
    assert.deepEqual(first.store.records.get(callId), fresh, 'A maintenance no-op must not change revision, verification or pending consent.');
    assert.deepEqual([...first.store.events.values()], eventsAfterRefresh, 'A maintenance no-op must not append restore/withdrawal audit.');
    assert.equal(first.store.actions.size, 0);
    assert.equal((await first.calls.get(callId)).verified, true, 'The active worker must not be forced to restore by a no-op revision.');
  }
});

test('two-worker terminal recovery discovery does not hydrate, save or contact the provider', async () => {
  for (const state of ['confirmed', 'failed']) {
    const first = await stack(), { callId } = await verify(first);
    const action = { id: randomUUID(), operationKey: `pending:${randomUUID()}:suspend`, callId, kind: 'suspend', targetId: 'TESTSUB001',
      state: 'unknown', updatedAt: first.clock.now().toISOString(), binding: { afterSeq: 0, turn: 1 }, providerId: null };
    first.store.actions.set(action.id, action);
    let reads = 0, restores = 0;
    const second = await stack({ store: first.store, clock: first.clock, modify: (p) => ({ ...p,
      getSubscription: async (...args) => { reads += 1; return p.getSubscription(...args); },
    }) });
    const restore = second.raw.restore; second.raw.restore = (...args) => { restores += 1; return restore(...args); };
    const lease = first.store.withCallLease;
    first.store.withCallLease = async (input, work) => {
      assert.equal(input.id, callId); first.store.withCallLease = lease;
      await lease({ id: callId }, () => first.store.recordActionOutcome({ id: action.id, state, evidence: { kind: 'other_worker_terminal' } }));
      return lease(input, work);
    };
    const record = copy(first.store.records.get(callId)), events = copy([...first.store.events.values()]);
    assert.equal(await second.calls.recover(), 0, state);
    assert.equal(reads, 0); assert.equal(restores, 0);
    assert.deepEqual(first.store.records.get(callId), record);
    assert.deepEqual([...first.store.events.values()], events);
    assert.equal(first.store.actions.get(action.id).state, state);
    assert.equal((await first.calls.get(callId)).verified, true);
  }
});

test('a genuinely expired proposal discovered after restart still withdraws authority and requires PIN', async () => {
  const first = await stack(), { callId } = await verify(first); await pauseOffer(first, callId);
  const original = copy(first.store.records.get(callId)); assert.ok(original.snapshot.pending);
  first.clock.advance(first.config.limits.pendingTtlMs + 1);
  const second = await stack({ store: first.store, clock: first.clock, modify: () => first.paypal });
  await second.calls.sweep();
  const saved = first.store.records.get(callId);
  assert.ok(saved.revision > original.revision); assert.equal(saved.snapshot.verified, false); assert.equal(saved.snapshot.pending, null);
  assert.ok([...first.store.events.values()].some((event) => event.callId === callId && event.type === 'session_restored'));
  assert.ok([...first.store.events.values()].some((event) => event.callId === callId && event.type === 'withdrawn'));
  assert.equal(first.store.actions.size, 0);
});

test('100 older unresolved actions cannot starve confirmation or background recovery of a newer call', async () => {
  const s = await stack(); const started = await verify(s);
  for (let i = 0; i < 101; i += 1) {
    const id = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
    s.store.actions.set(id, { id, callId: randomUUID(), kind: 'suspend', targetId: 'MISSING', state: 'unknown', updatedAt: '2026-11-01T00:00:00.000Z', binding: { afterSeq: 0 } });
  }
  await pauseOffer(s, started.callId); await s.say(started.callId, 'yes');
  assert.equal([...s.store.actions.values()].find((a) => a.callId === started.callId).state, 'confirmed');
  let visits = new Set(); const recover = s.durability.recoverAction;
  // Discovery itself must advance even when each old call cannot be loaded.
  const list = s.store.listRecoverableActions;
  s.store.listRecoverableActions = async (input) => { const found = await list(input); if (!input.callId) for (const action of found) visits.add(action.id); return found; };
  for (let i = 0; i < 35; i += 1) { s.clock.advance(30001); await s.calls.recover(); }
  assert.equal(visits.size, 101); assert.equal(typeof recover, 'function');
});

test('locking a restored call still permits proven draft cleanup but cannot authorize a send', async () => {
  const first = await stack(); const started = await verify(first); await first.say(started.callId, 'I want to give 10 dollars one time.');
  const second = await stack({ store: first.store, clock: first.clock, modify: () => first.paypal });
  const restored = await second.calls.get(started.callId); second.answered.set(started.callId, restored.turn);
  for (let i = 0; i < 3; i += 1) await second.say(started.callId, '0000', 'keypad');
  assert.equal(second.raw.get(started.callId).locked, true);
  const ended = await second.calls.end(started.callId); assert.equal(ended.state.ended, true);
  assert.equal([...first.store.actions.values()].filter((a) => a.kind === 'delete_draft').length, 1);
  assert.equal([...first.store.actions.values()].filter((a) => a.kind === 'send_invoice').length, 0);
});

test('restart cleanup refuses to delete a known invoice that PayPal now shows as sent', async () => {
  const first = await stack(); const started = await verify(first); await first.say(started.callId, 'I want to give 10 dollars one time.');
  const second = await stack({ store: first.store, clock: first.clock, modify: () => ({ ...first.paypal,
    getInvoice: async (id) => { const read = await first.paypal.getInvoice(id); return { ...read, data: { ...read.data, status: 'SENT' } }; },
    deleteDraftInvoice: async () => { assert.fail('sent invoice must not be deleted'); },
  }) });
  const ended = await second.calls.end(started.callId); assert.equal(ended.state.ended, true);
  assert.equal([...first.store.actions.values()].filter((a) => a.kind === 'delete_draft').length, 0);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('a browser gap waits behind the same call read and commits exactly once', async () => {
  const s = await stack(); const { callId } = await verify(s);
  const entered = deferred(), release = deferred(), get = s.raw.get;
  s.raw.get = async (id) => { entered.resolve(); await release.promise; return get(id); };
  const reading = s.calls.get(callId); await entered.promise;
  let settled = false;
  const gap = s.calls.logGap(callId, { turn: 1, gapMs: 80, source: 'typed', muted: true })
    .then((value) => { settled = true; return { value }; }, (error) => { settled = true; return { error }; });
  await new Promise((resolve) => setImmediate(resolve));
  const wasSettled = settled;
  release.resolve(); await reading;
  const result = await gap;
  assert.equal(wasSettled, false, 'local overlap waits rather than returning lease busy');
  assert.equal(result.error, undefined);
  assert.deepEqual(result.value, { ok: true });
  assert.equal(s.ledger.byCall(callId).filter((event) => event.type === 'gap').length, 1);
  assert.equal(s.store.actions.size, 0);
});

test('an operation whose queue wait expires is never dispatched after the holder drains', async () => {
  const s = await stack({ wrapOptions: { queueWaitMs: 10 } }); const { callId } = await verify(s);
  await pauseOffer(s, callId);
  const entered = deferred(), release = deferred(), get = s.raw.get, turn = s.raw.turn;
  s.raw.get = async (id) => { entered.resolve(); await release.promise; return get(id); };
  let turns = 0;
  s.raw.turn = (...args) => { turns += 1; return turn(...args); };
  const reading = s.calls.get(callId); await entered.promise;
  await assert.rejects(s.calls.turn(callId, { text: 'yes', source: 'typed', answering: 2 }), /DONOR_CALL_BUSY/);
  release.resolve(); await reading;
  await s.calls.get(callId);
  assert.equal(turns, 0, 'a timed-out yes must not execute later');
  assert.equal(s.store.actions.size, 0);
  assert.equal((await s.paypal.getSubscription(s.config.demoSubscriptionId)).data.status, 'ACTIVE');
});

test('the per-call queue bounds admitted work and releases its capacity after draining', async () => {
  const s = await stack({ wrapOptions: { maxPendingPerCall: 2 } }); const { callId } = await verify(s);
  const entered = deferred(), release = deferred(), get = s.raw.get;
  s.raw.get = async (id) => { entered.resolve(); await release.promise; return get(id); };
  const reading = s.calls.get(callId); await entered.promise;
  const gap = s.calls.logGap(callId, { turn: 1, gapMs: 80, source: 'typed', muted: true }).then((value) => ({ value }), (error) => ({ error }));
  await assert.rejects(s.calls.get(callId), /DONOR_CALL_BUSY/);
  release.resolve(); await reading;
  assert.deepEqual(await gap, { value: { ok: true } });
  assert.equal((await s.calls.get(callId)).verified, true);
});

test('a queued early yes retains its original arrival and cannot cross the durable reply barrier', async () => {
  const s = await stack(); const { callId } = await verify(s);
  const entered = deferred(), release = deferred(), save = s.store.saveCall;
  let delayed = false;
  s.store.saveCall = async (input) => {
    if (!delayed && input.snapshot.pending?.kind === 'suspend') {
      delayed = true; entered.resolve(); await release.promise;
    }
    return save(input);
  };
  const asking = pauseOffer(s, callId); await entered.promise;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const receivedAt = performance.now();
  const yes = s.calls.turn(callId, { text: 'yes', source: 'typed', answering: 2 }, { receivedAt })
    .then((value) => ({ value }), (error) => ({ error }));
  release.resolve(); await asking;
  const result = await yes;
  assert.equal(result.error, undefined, 'the overlap should wait without becoming valid approval');
  assert.equal(result.value.state.pending.kind, 'suspend');
  assert.equal(s.store.actions.size, 0);
  const heard = s.ledger.byCall(callId).find((event) => event.type === 'heard' && event.turn === 3);
  assert.ok(heard.afterReplyMs <= 0, 'arrival remains before the durable asking reply was ready');
});
