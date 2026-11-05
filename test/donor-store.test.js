import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createDonorStore, DONOR_SCHEMA_CHECKSUM, DONOR_RUNTIME_TABLES, DONOR_RUNTIME_SEQUENCES } from '../src/donor-store.js';

const clone = (value) => structuredClone(value);
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const at = '2026-11-05T08:00:00.000Z';
const future = '2026-11-06T08:00:00.000Z';
const secretHash = createHash('sha256').update('synthetic-call-secret').digest('hex');
const callInput = () => ({ id: randomUUID(), sessionSecretHash: secretHash, snapshot: { turn: 0, verified: false }, expiresAt: future });

// This models the adapter contract and commit ambiguity, not PostgreSQL's trigger engine.
function database() {
  let state = { migrations: [], calls: new Map(), actions: new Map(), events: new Map(), sequence: 0 };
  let tail = Promise.resolve();
  const seen = [], clients = [];
  const control = { failCommit: false, failQuery: null };
  const rows = (value) => ({ rows: clone(value) });
  function connect() {
    const client = new EventEmitter(); clients.push(client);
    let unlock, snapshot;
    client.release = () => { unlock?.(); unlock = null; };
    client.query = async (query, parameters) => {
      const sql = typeof query === 'string' ? query : query.text;
      const values = (typeof query === 'string' ? parameters : query.values) ?? [];
      seen.push({ sql, values: clone(values), queryTimeout: query.query_timeout });
      if (sql.startsWith('BEGIN')) {
        const previous = tail; tail = new Promise((resolve) => { unlock = resolve; }); await previous;
        snapshot = clone(state); return rows([]);
      }
      if (sql === 'COMMIT') {
        snapshot = null; unlock?.(); unlock = null;
        if (control.failCommit) { control.failCommit = false; throw new Error('private commit ambiguity'); }
        return rows([]);
      }
      if (sql === 'ROLLBACK') { if (snapshot) state = snapshot; snapshot = null; unlock?.(); unlock = null; return rows([]); }
      if (control.failQuery?.(sql)) throw new Error('private database details');
      if (/SELECT version,checksum/.test(sql)) return rows(state.migrations);
      if (/INSERT INTO pledge_donor_migrations/.test(sql)) { state.migrations.push({ version: values[0], checksum: values[1] }); return rows([]); }
      if (/SELECT nextval/.test(sql)) return rows(Array.from({ length: values[0] }, () => ({ seq: String(++state.sequence) })));
      if (/INSERT INTO pledge_donor_events/.test(sql)) {
        for (const event of JSON.parse(values[1])) if (!state.events.has(event.seq)) state.events.set(event.seq, { organization_id: values[0], event });
        return rows([]);
      }
      if (/SELECT incoming.seq/.test(sql)) return rows(JSON.parse(values[1]).map((event) => ({ seq: String(event.seq), matches: state.events.get(event.seq)?.organization_id === values[0] && same(state.events.get(event.seq)?.event, event) })));
      if (/SELECT event FROM pledge_donor_events/.test(sql)) return rows([...state.events.values()].filter((row) => row.organization_id === values[0] && row.event.seq > values[1] && (values[2] === null || row.event.callId === values[2])).sort((a, b) => a.event.seq - b.event.seq).slice(0, values[3]).map((row) => ({ event: row.event })));
      if (/INSERT INTO pledge_donor_calls/.test(sql)) {
        const key = `${values[0]}/${values[1]}`;
        if (state.calls.has(key)) throw Object.assign(new Error('duplicate'), { code: '23505' });
        const row = { organization_id: values[0], id: values[1], session_secret_hash: values[2], snapshot: JSON.parse(values[3]), revision: 0,
          expires_at: values[4], created_at: values[5], updated_at: values[5] };
        state.calls.set(key, row); return rows([row]);
      }
      if (/SELECT \* FROM pledge_donor_calls/.test(sql)) return rows(state.calls.has(`${values[0]}/${values[1]}`) ? [state.calls.get(`${values[0]}/${values[1]}`)] : []);
      if (/SELECT id FROM pledge_donor_calls/.test(sql)) return rows([...state.calls.values()].filter((row) => row.organization_id === values[0] && row.snapshot.ended === false &&
        (row.snapshot.lastActiveAt <= values[1] || row.snapshot.pending?.expiresAt <= values[2])).slice(0, values[3]).map(({ id }) => ({ id })));
      if (/UPDATE pledge_donor_calls/.test(sql)) {
        const row = state.calls.get(`${values[0]}/${values[1]}`);
        if (!row || row.revision !== values[2]) return rows([]);
        Object.assign(row, { snapshot: JSON.parse(values[3]), revision: row.revision + 1, expires_at: values[4], updated_at: values[5] }); return rows([row]);
      }
      if (/SELECT \* FROM pledge_donor_actions/.test(sql)) {
        const all = [...state.actions.values()].filter((row) => row.organization_id === values[0]);
        if (sql.includes('operation_key=$2')) return rows(all.filter((row) => row.operation_key === values[1]));
        if (sql.includes('resource_key=$2')) return rows(all.filter((row) => row.resource_key === values[1] && ['claimed', 'responded', 'unknown'].includes(row.state)).slice(0, 1));
        if (sql.includes('id=$2')) return rows(all.filter((row) => row.id === values[1]));
        return rows(all.filter((row) => ['claimed', 'responded', 'unknown'].includes(row.state) && (row.provider_id || ['suspend', 'activate', 'cancel', 'send_invoice', 'delete_draft', 'cover_refund', 'refund_request'].includes(row.kind) || row.binding.fields?.captureId))
          .filter((row) => !values[2] || row.call_id === values[2]).filter((row) => !values[3] || row.updated_at > values[3] || row.updated_at === values[3] && row.id > values[4])
          .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id)).slice(0, values[1]));
      }
      if (/INSERT INTO pledge_donor_actions/.test(sql)) {
        const [organization_id, id, operation_key, resource_key, call_id, pending_id, kind, target_id, amount_value, currency, binding, request_id, created_at] = values;
        const row = { organization_id, id, operation_key, resource_key, call_id, pending_id, kind, target_id, amount_value, currency, binding: JSON.parse(binding), request_id,
          state: 'claimed', attempt_count: 1, provider_id: null, result: null, evidence: null, created_at, updated_at: created_at };
        state.actions.set(id, row); return rows([row]);
      }
      if (/UPDATE pledge_donor_actions/.test(sql)) {
        const row = state.actions.get(values[1]);
        Object.assign(row, { state: values[2], provider_id: values[3], result: values[4] === null ? null : JSON.parse(values[4]), evidence: values[5] === null ? null : JSON.parse(values[5]), updated_at: values[6] });
        return rows([row]);
      }
      if (/^(SET |CREATE |\nCREATE |REVOKE |SELECT pg_advisory)/.test(sql)) return rows([]);
      throw new Error(`Unhandled fake query: ${sql.slice(0, 100)}`);
    };
    return client;
  }
  return { pool: { connect: async () => connect() }, seen, clients, control };
}
const storeFor = (f, organizationId = 'org-a') => createDonorStore({ pool: f.pool, organizationId, now: () => new Date(at) });
const actionInput = (callId, extra = {}) => ({ operationKey: `pending:${randomUUID()}:suspend`, resourceKey: 'subscription:TESTSUB001', callId, pendingId: randomUUID(), kind: 'suspend', targetId: 'TESTSUB001', binding: { approved: true, sourceStatus: 'ACTIVE' }, ...extra });

test('donor schema is explicit, checksummed and contains immutable identity and audit guards', async () => {
  const f = database(), store = storeFor(f);
  assert.equal(f.seen.length, 0);
  await assert.rejects(store.checkSchema(), /DONOR_SCHEMA_MISMATCH/);
  assert.ok(!f.seen.some(({ sql }) => /CREATE|INSERT|UPDATE/.test(sql)));
  assert.deepEqual(await store.migrate(), { version: 1, applied: true });
  assert.deepEqual(await store.migrate(), { version: 1, applied: false });
  assert.deepEqual(await store.checkSchema(), { version: 1, matches: true });
  const schema = f.seen.find(({ sql }) => sql.includes('CREATE TABLE pledge_donor_calls')).sql;
  for (const term of ['CREATE SEQUENCE pledge_donor_event_seq', 'CREATE UNIQUE INDEX pledge_donor_unresolved_resource', 'CREATE INDEX pledge_donor_actions_call', 'pledge_donor_event_safe(event)', 'Donor action binding is immutable', 'Donor records cannot be deleted', 'Donor audit events are immutable']) assert.ok(schema.includes(term));
  assert.ok(DONOR_RUNTIME_TABLES.includes('pledge_donor_events')); assert.deepEqual(DONOR_RUNTIME_SEQUENCES, ['pledge_donor_event_seq']);
  assert.match(DONOR_SCHEMA_CHECKSUM, /^[0-9a-f]{64}$/);
});

test('invalid authority snapshots and malformed inputs are rejected before connecting', async () => {
  let connects = 0;
  const pool = { connect: async () => { connects += 1; throw new Error('must not connect'); } };
  assert.throws(() => createDonorStore(), /DONOR_DATABASE_REQUIRED/);
  assert.throws(() => createDonorStore({ pool, organizationId: 'bad\norg' }), /DONOR_INPUT_INVALID/);
  const store = createDonorStore({ pool });
  for (const snapshot of [{ pin: '123456' }, { nested: { sessionSecret: 'secret' } }, { tokens: {} }, { clientKey: 'address' }, JSON.parse('{"__proto__":{"value":true}}'), { pending: Promise.resolve() }]) {
    await assert.rejects(store.createCall({ ...callInput(), snapshot }), /DONOR_INPUT_INVALID/);
  }
  await assert.rejects(store.reserveEventSequences({ count: 0 }), /DONOR_INPUT_INVALID/);
  await assert.rejects(store.claimAction({ ...actionInput(randomUUID()), amountValue: '1.00' }), /DONOR_INPUT_INVALID/);
  await assert.rejects(store.recordActionResponse({ id: randomUUID(), result: { sessionSecret: 'private' } }), /DONOR_INPUT_INVALID/);
  await assert.rejects(store.recordActionOutcome({ id: randomUUID(), state: 'unknown', evidence: { tokenId: 'authority' } }), /DONOR_INPUT_INVALID/);
  assert.equal(connects, 0);
});

test('call snapshots preserve only the hashed credential and require the exact revision and organization', async () => {
  const f = database(), store = storeFor(f), input = callInput();
  const created = await store.createCall(input);
  assert.equal(created.sessionSecretHash, secretHash); assert.equal(created.revision, 0);
  assert.equal(await storeFor(f, 'org-b').loadCall({ id: input.id }), null);
  const updated = await store.saveCall({ id: input.id, expectedRevision: 0, snapshot: { turn: 1, verified: true } });
  assert.equal(updated.revision, 1); assert.deepEqual(updated.snapshot, { turn: 1, verified: true });
  await assert.rejects(store.saveCall({ id: input.id, expectedRevision: 0, snapshot: { turn: 9 } }), /DONOR_REVISION_CONFLICT/);
  assert.equal((await store.loadCall({ id: input.id })).snapshot.turn, 1);
});

test('event sequence reservations and exact idempotent batches preserve global sequence identities', async () => {
  const f = database(), store = storeFor(f), callId = randomUUID();
  assert.deepEqual(await store.reserveEventSequences({ count: 3 }), [1, 2, 3]);
  const events = [{ seq: 1, ts: at, type: 'call_start', callId }, { seq: 3, ts: at, type: 'said', callId, text: 'Synthetic reply' }];
  assert.equal(await store.appendEvents({ events }), 2);
  assert.equal(await store.appendEvents({ events: clone(events).reverse() }), 2);
  assert.deepEqual(await store.listEvents({ callId }), events);
  assert.deepEqual(await store.listEvents({ callId, afterSeq: 1, limit: 1 }), [events[1]]);
  await assert.rejects(store.appendEvents({ events: [{ ...events[0], type: 'changed' }] }), /DONOR_EVENT_CONFLICT/);
  await assert.rejects(storeFor(f, 'org-b').appendEvents({ events: [events[0]] }), /DONOR_EVENT_CONFLICT/);
  assert.deepEqual(await storeFor(f, 'org-b').listEvents({}), []);
});

test('structured credentials cannot enter durable events or action snapshots while audit token identities survive', async () => {
  let connects = 0;
  const guarded = createDonorStore({ pool: { connect: async () => { connects += 1; throw new Error('must not connect'); } } });
  const callId = randomUUID();
  for (const key of ['sessionSecret', 'PILOT_PIN', 'api-key', 'anthropicApiKey', 'jevApiKey', 'Authorization', 'password', 'clientSecret', 'access_token', 'refreshToken']) {
    const nested = { wrapper: { [key]: 'synthetic-private-value' } };
    await assert.rejects(guarded.appendEvents({ events: [{ seq: 1, ts: at, type: 'test', callId, ...nested }] }), /DONOR_INPUT_INVALID/);
    await assert.rejects(guarded.createCall({ ...callInput(), snapshot: nested }), /DONOR_INPUT_INVALID/);
    await assert.rejects(guarded.claimAction({ ...actionInput(callId), binding: nested }), /DONOR_INPUT_INVALID/);
  }
  assert.equal(connects, 0);
  const f = database(), store = storeFor(f);
  const event = { seq: 1, ts: at, type: 'yes_accepted', callId, tokenId: randomUUID(), tokenIds: [randomUUID()] };
  await store.appendEvents({ events: [event] });
  assert.deepEqual(await store.listEvents({ callId }), [event]);
});

test('one committed action identity wins, resource contention blocks another action and unknown never replays', async () => {
  const f = database(), store = storeFor(f), call = await store.createCall(callInput()), input = actionInput(call.id);
  const attempts = await Promise.all(Array.from({ length: 12 }, () => store.claimAction(input)));
  assert.equal(attempts.filter((r) => r.claimed).length, 1);
  const action = attempts[0].action;
  assert.equal(new Set(attempts.map((r) => r.action.requestId)).size, 1); assert.equal(action.attemptCount, 1);
  const blocked = await store.claimAction(actionInput(call.id));
  assert.equal(blocked.claimed, false); assert.equal(blocked.blocked, true);
  await assert.rejects(store.claimAction({ ...input, targetId: 'CHANGED' }), /DONOR_ACTION_CONFLICT/);
  await store.recordActionOutcome({ id: action.id, state: 'unknown', evidence: { cause: 'synthetic_lost_response' } });
  const restarted = storeFor(f);
  assert.equal((await restarted.claimAction(input)).claimed, false);
  assert.equal((await restarted.getAction({ operationKey: input.operationKey })).state, 'unknown');
});

test('provider identity is persisted before confirmation and terminal proof cannot be changed', async () => {
  const f = database(), store = storeFor(f), call = await store.createCall(callInput());
  const input = actionInput(call.id, { kind: 'create_draft', resourceKey: `draft:${call.id}`, targetId: 'donor@example.test' });
  const { action } = await store.claimAction(input);
  await assert.rejects(store.recordActionOutcome({ id: action.id, state: 'confirmed', evidence: { status: 'DRAFT' } }), /DONOR_ACTION_CONFLICT/);
  const response = await store.recordActionResponse({ id: action.id, providerId: 'INV2-TEST0001', result: { id: 'INV2-TEST0001' } });
  assert.equal(response.providerId, 'INV2-TEST0001'); assert.equal(response.state, 'responded');
  await assert.rejects(store.recordActionResponse({ id: action.id, providerId: 'INV2-OTHER', result: { id: 'INV2-OTHER' } }), /DONOR_ACTION_CONFLICT/);
  const evidence = { id: 'INV2-TEST0001', status: 'DRAFT', authoritativeRead: true };
  await store.recordActionOutcome({ id: action.id, state: 'confirmed', evidence });
  assert.equal((await store.recordActionOutcome({ id: action.id, state: 'confirmed', evidence })).state, 'confirmed');
  await assert.rejects(store.recordActionOutcome({ id: action.id, state: 'unknown', evidence: { changed: true } }), /DONOR_ACTION_CONFLICT/);
  assert.equal((await store.claimAction(actionInput(call.id, { resourceKey: input.resourceKey }))).claimed, true, 'A terminal known action no longer occupies its resource.');
});

test('a late known identity can enrich uncertainty without reopening it or replacing a response', async () => {
  const f = database(), store = storeFor(f), call = await store.createCall(callInput());
  const input = actionInput(call.id, { kind: 'cover_capture', resourceKey: 'cover:TESTCHARGE001:capture', targetId: 'TESTHOLD001', amountValue: '25.00', currency: 'USD' });
  const { action } = await store.claimAction(input);
  await store.recordActionOutcome({ id: action.id, state: 'unknown', evidence: { cause: 'interrupted' } });
  const response = await store.recordActionResponse({ id: action.id, providerId: 'TESTCAPTURE001', result: { id: 'TESTCAPTURE001', status: 'COMPLETED' } });
  assert.equal(response.state, 'unknown'); assert.equal(response.providerId, 'TESTCAPTURE001');
  await assert.rejects(store.recordActionResponse({ id: action.id, providerId: 'TESTCAPTURE001', result: { id: 'TESTCAPTURE001', status: 'CHANGED' } }), /DONOR_ACTION_CONFLICT/);
  assert.equal((await store.claimAction(input)).claimed, false);
  assert.ok((await store.listRecoverableActions()).some((entry) => entry.id === action.id));
});

test('an ambiguous claim commit returns no permission while its committed identity remains occupied', async () => {
  const f = database(), store = storeFor(f), call = await store.createCall(callInput()), input = actionInput(call.id);
  f.control.failCommit = true;
  await assert.rejects(store.claimAction(input), /DONOR_STORE_UNAVAILABLE/);
  const known = await store.getAction({ operationKey: input.operationKey });
  assert.equal(known.state, 'claimed'); assert.equal(known.attemptCount, 1);
  assert.equal((await storeFor(f).claimAction(input)).claimed, false);
});

test('recovery discovery includes known read targets but excludes no-ID creations and terminal actions', async () => {
  const f = database(), store = storeFor(f), call = await store.createCall(callInput());
  const suspend = await store.claimAction(actionInput(call.id));
  const lostCreate = await store.claimAction(actionInput(call.id, { kind: 'create_draft', resourceKey: 'draft:lost' }));
  const knownCreate = await store.claimAction(actionInput(call.id, { kind: 'create_draft', resourceKey: 'draft:known' }));
  await store.recordActionResponse({ id: knownCreate.action.id, providerId: 'INV2-KNOWN', result: { id: 'INV2-KNOWN' } });
  const recoverable = await store.listRecoverableActions({ limit: 30 });
  assert.deepEqual(new Set(recoverable.map((r) => r.id)), new Set([suspend.action.id, knownCreate.action.id]));
  assert.ok(!recoverable.some((r) => r.id === lostCreate.action.id));
});

function leaseFixture() {
  const seen = [], clients = [];
  let releases = 0;
  return { seen, clients, releases: () => releases, pool: { connect: async () => {
    const client = new EventEmitter(); clients.push(client);
    client.query = async (query) => { const sql = typeof query === 'string' ? query : query.text; seen.push(sql); return { rows: sql.includes('pg_try_advisory_xact_lock') ? [{ acquired: true }] : [] }; };
    client.release = () => { releases += 1; };
    return client;
  } } };
}

test('call leases cap concurrency at two, hold no row locks and drain after lease loss', async () => {
  const f = leaseFixture(), store = storeFor(f);
  let entered = 0, finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const work = async (signal) => { entered += 1; await gate; assert.equal(signal.aborted, true); };
  const first = store.withCallLease({ id: randomUUID() }, work);
  const second = store.withCallLease({ id: randomUUID() }, work);
  while (entered < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await store.withCallLease({ id: randomUUID() }, () => assert.fail('third lease')), { acquired: false });
  f.clients.forEach((client) => client.emit('error', new Error('private failure')));
  assert.equal(f.releases(), 0);
  finish();
  const results = await Promise.allSettled([first, second]);
  assert.ok(results.every((r) => r.status === 'rejected' && r.reason.code === 'DONOR_LEASE_ABORTED'));
  assert.equal(f.releases(), 2);
  assert.ok(f.seen.every((sql) => !/FOR UPDATE|pg_try_advisory_lock\(/.test(sql)));
});

test('a call lease propagates deadline cancellation and releases only after work drains', async () => {
  const f = leaseFixture(), store = createDonorStore({ pool: f.pool, leaseTimeoutMs: 15 });
  let drained = false;
  await assert.rejects(store.withCallLease({ id: randomUUID() }, async (signal) => {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    assert.equal(f.releases(), 0); drained = true;
  }), /DONOR_LEASE_ABORTED/);
  assert.equal(drained, true); assert.equal(f.releases(), 1);
});

test('an externally aborted lease never checks out a connection or enters work', async () => {
  const f = leaseFixture(), store = storeFor(f), controller = new AbortController(); controller.abort();
  await assert.rejects(store.withCallLease({ id: randomUUID(), signal: controller.signal }, () => assert.fail('aborted work')), /DONOR_LEASE_ABORTED/);
  assert.equal(f.clients.length, 0);
});

test('actual PostgreSQL donor persistence, immutable actions and lease contention', { skip: !process.env.DONOR_RUNTIME_TEST_URL }, async () => {
  const { default: pg } = await import('pg');
  const { databaseOptions, protectDatabasePool } = await import('../src/database.js');
  const pool = protectDatabasePool(new pg.Pool(databaseOptions(process.env.DONOR_RUNTIME_TEST_URL)));
  const organizationId = `donor-test-${randomUUID()}`;
  const store = createDonorStore({ pool, organizationId });
  try {
    await store.checkSchema();
    const input = { ...callInput(), snapshot: { ended: false, lastActiveAt: Date.now() - 600001 }, expiresAt: new Date(Date.now() + 3600000).toISOString() };
    const call = await store.createCall(input), claim = actionInput(call.id);
    assert.deepEqual(await store.listSweepCalls({ activeBefore: Date.now() - 600000, expiryBefore: Date.now(), limit: 3 }), [call.id]);
    const attempts = await Promise.all([store.claimAction(claim), createDonorStore({ pool, organizationId }).claimAction(claim)]);
    assert.equal(attempts.filter((r) => r.claimed).length, 1);
    const action = attempts[0].action;
    const unknown = await store.recordActionOutcome({ id: action.id, state: 'unknown', evidence: { synthetic: true } });
    assert.equal((await store.claimAction(claim)).claimed, false);
    assert.deepEqual((await store.listRecoverableActions({ callId: call.id, limit: 1 })).map((entry) => entry.id), [action.id]);
    assert.deepEqual(await store.listRecoverableActions({ after: { id: action.id, updatedAt: unknown.updatedAt }, limit: 1 }), []);
    const seq = await store.reserveEventSequences({ count: 2 });
    const events = seq.map((value) => ({ seq: value, type: 'synthetic', ts: new Date().toISOString(), callId: call.id }));
    await store.appendEvents({ events }); await store.appendEvents({ events });
    assert.deepEqual(await store.listEvents({ callId: call.id }), events);
    const auditSeq = (await store.reserveEventSequences({ count: 2 }));
    const audit = { seq: auditSeq[0], type: 'yes', ts: new Date().toISOString(), callId: call.id, tokenId: randomUUID(), tokenIds: [randomUUID()] };
    await store.appendEvents({ events: [audit] });
    assert.deepEqual((await store.listEvents({ callId: call.id })).at(-1), audit);
    const privateEvent = { seq: auditSeq[1], type: 'synthetic', ts: new Date().toISOString(), callId: call.id, nested: { apiKey: 'synthetic-credential' } };
    await assert.rejects(pool.query('INSERT INTO pledge_donor_events(seq,organization_id,call_id,event_ts,event) VALUES($1,$2,$3,$4,$5::jsonb)',
      [privateEvent.seq, organizationId, call.id, privateEvent.ts, JSON.stringify(privateEvent)]));
    let entered, finish;
    const start = new Promise((resolve) => { entered = resolve; }), drain = new Promise((resolve) => { finish = resolve; });
    const lease = store.withCallLease({ id: call.id }, async () => { entered(); await drain; });
    await start;
    try { assert.deepEqual(await createDonorStore({ pool, organizationId }).withCallLease({ id: call.id }, () => assert.fail('duplicate lease')), { acquired: false }); }
    finally { finish(); await lease; }
    await assert.rejects(pool.query("UPDATE pledge_donor_actions SET attempt_count=0 WHERE organization_id=$1 AND id=$2", [organizationId, action.id]));
    await assert.rejects(pool.query("DELETE FROM pledge_donor_actions WHERE organization_id=$1", [organizationId]));
  } finally { await pool.end(); }
});

test('sweep discovery is bounded and organization scoped while recovery supports call filters and forward cursors', async () => {
  const f = database(), store = storeFor(f), call = await store.createCall({ ...callInput(), snapshot: { ended: false, lastActiveAt: 10 } });
  await storeFor(f, 'org-b').createCall({ ...callInput(), snapshot: { ended: false, lastActiveAt: 10 } });
  await store.createCall({ ...callInput(), snapshot: { ended: true, lastActiveAt: 10 } });
  const active = await store.createCall({ ...callInput(), snapshot: { ended: false, lastActiveAt: 100, pending: { expiresAt: 20 } } });
  assert.deepEqual(new Set(await store.listSweepCalls({ activeBefore: 10, expiryBefore: 20, limit: 3 })), new Set([call.id, active.id]));
  const a = (await store.claimAction(actionInput(call.id, { resourceKey: 'one' }))).action;
  const b = (await store.claimAction(actionInput(active.id, { resourceKey: 'two' }))).action;
  assert.deepEqual((await store.listRecoverableActions({ callId: active.id })).map((x) => x.id), [b.id]);
  const sorted = [a, b].sort((x, y) => x.id.localeCompare(y.id));
  const first = await store.listRecoverableActions({ limit: 1 }); assert.equal(first[0].id, sorted[0].id);
  assert.deepEqual((await store.listRecoverableActions({ after: { id: first[0].id, updatedAt: first[0].updatedAt }, limit: 1 })).map((x) => x.id), [sorted[1].id]);
});
