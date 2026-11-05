import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createCheckoutStore, CHECKOUT_SCHEMA_CHECKSUM } from '../src/checkout-store.js';

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(query) {
  const seen = []; let releases = 0, connects = 0;
  const client = new EventEmitter();
  client.query = async (input, values) => {
    const sql = typeof input === 'string' ? input : input.text;
    const parameters = typeof input === 'string' ? values : input.values;
    seen.push({ sql, values: parameters, queryTimeout: input.query_timeout });
    return query(sql, parameters);
  };
  client.release = () => { releases += 1; };
  const pool = { connect: async () => { connects += 1; return client; } };
  return { client, pool, seen, releases: () => releases, connects: () => connects };
}

test('recovery candidates are organization-scoped ID-only keyset pages with bounded SQL', async () => {
  const f = fixture(async (sql) => sql.startsWith('SELECT id FROM') ? { rows: [1, 2, 3].map((n) => ({ id: id(n) })) } : { rows: [] });
  const signal = new AbortController().signal, store = createCheckoutStore({ pool: f.pool });
  assert.deepEqual(await store.listRecoveryCandidates({ organizationId: 'org-a', after: null, limit: 2, signal }), { ids: [id(1), id(2)], nextCursor: id(2) });
  const selected = f.seen.find(({ sql }) => sql.startsWith('SELECT id FROM'));
  assert.deepEqual(selected.values, ['org-a', null, 3]);
  assert.match(selected.sql, /organization_id=\$1/); assert.match(selected.sql, /id>\$2::uuid/);
  assert.match(selected.sql, /blocked_reason IS NULL/); assert.match(selected.sql, /orderId/);
  assert.match(selected.sql, /createState/); assert.match(selected.sql, /captureState/);
  assert.ok(!f.seen.some(({ sql }) => /FOR UPDATE|session_secret_hash|SELECT \*/.test(sql)));
  assert.ok(f.seen.some(({ sql }) => sql.includes("statement_timeout='2s'")));
  assert.ok(f.seen.every(({ queryTimeout }) => queryTimeout === 2500));
  await assert.rejects(store.listRecoveryCandidates({ organizationId: 'org-a', after: 'invalid', signal }), /CHECKOUT_INPUT_INVALID/);
  assert.equal(f.connects(), 1);
});

test('busy recovery lease never enters work and holds no row locks or session lock', async () => {
  const f = fixture(async (sql) => sql.includes('pg_try_advisory_xact_lock') ? { rows: [{ acquired: false }] } : { rows: [] });
  let called = false;
  const result = await createCheckoutStore({ pool: f.pool }).withRecoveryLease({ organizationId: 'org-a', signal: new AbortController().signal }, async () => { called = true; });
  assert.deepEqual(result, { acquired: false }); assert.equal(called, false); assert.equal(f.releases(), 1);
  assert.ok(f.seen.some(({ sql }) => sql.includes('idle_in_transaction_session_timeout')));
  assert.ok(!f.seen.some(({ sql }) => /FOR UPDATE|pg_try_advisory_lock\(/.test(sql)));
});

test('lease client loss aborts and drains work before rollback and release', async () => {
  const f = fixture(async (sql) => sql.includes('pg_try_advisory_xact_lock') ? { rows: [{ acquired: true }] } : { rows: [] });
  const store = createCheckoutStore({ pool: f.pool });
  let entered, drain, leaseSignal;
  const started = new Promise((resolve) => { entered = resolve; });
  const waiting = new Promise((resolve) => { drain = resolve; });
  const pending = store.withRecoveryLease({ organizationId: 'org-a', signal: new AbortController().signal }, async (signal) => { leaseSignal = signal; entered(); await waiting; });
  await started;
  assert.deepEqual(await store.withRecoveryLease({ organizationId: 'org-a', signal: new AbortController().signal }, () => assert.fail('overlap')), { acquired: false });
  assert.equal(f.connects(), 1, 'One dedicated lease connection per store.');
  f.client.emit('error', new Error('private-db-detail')); await tick();
  assert.equal(leaseSignal.aborted, true); assert.equal(f.releases(), 0);
  assert.ok(!f.seen.some(({ sql }) => sql === 'ROLLBACK'));
  drain(); await assert.rejects(pending, (error) => error.code === 'CHECKOUT_RECOVERY_ABORTED' && !error.message.includes('private'));
  assert.equal(f.releases(), 1); assert.ok(f.seen.some(({ sql }) => sql === 'ROLLBACK'));
});

test('recovery-only store abort stops further SQL without altering ordinary schema checks', async () => {
  const abort = new AbortController();
  const f = fixture(async (sql) => {
    if (sql.startsWith('SELECT *')) { abort.abort(); return { rows: [] }; }
    return sql.includes('SELECT version,checksum') ? { rows: [{ version: 1, checksum: CHECKOUT_SCHEMA_CHECKSUM }] } : { rows: [] };
  });
  const scoped = createCheckoutStore({ pool: f.pool, recoverySignal: abort.signal });
  await assert.rejects(scoped.get({ organizationId: 'org-a', id: id(1) }), /CHECKOUT_RECOVERY_ABORTED/);
  const reads = f.seen.length;
  await assert.rejects(scoped.get({ organizationId: 'org-a', id: id(1) }), /CHECKOUT_RECOVERY_ABORTED/);
  assert.equal(f.seen.length, reads);
  assert.deepEqual(await createCheckoutStore({ pool: f.pool }).checkSchema(), { version: 1, matches: true });
});

test('actual PostgreSQL recovery filtering and transaction lease contention', { skip: !process.env.CHECKOUT_RUNTIME_TEST_URL }, async () => {
  const { default: pg } = await import('pg');
  const { databaseOptions, protectDatabasePool } = await import('../src/database.js');
  const pool = protectDatabasePool(new pg.Pool(databaseOptions(process.env.CHECKOUT_RUNTIME_TEST_URL)));
  const store = createCheckoutStore({ pool }), organizationId = `recovery-test-${randomUUID()}`;
  const signal = new AbortController().signal;
  const input = (org = organizationId) => ({ organizationId: org, id: randomUUID(), rfq: { quantity: 1, currency: 'USD' },
    proposal: { termsHash: 'b'.repeat(64), allocations: [{ supplierId: 'supplier', payeeId: 'MERCHANT00001', quantity: 1, totalCents: 100, currency: 'USD' }] },
    sessionSecretHash: createHash('sha256').update('synthetic-session').digest('hex') });
  async function reserve(kind, org) {
    const value = input(org), workflow = await store.reserve(value), leg = workflow.legs[0];
    if (kind === 'untouched') return value.id;
    await store.claimCreate({ ...value, legId: leg.id });
    if (kind === 'lost-id') { await store.markCreateUnknown({ ...value, legId: leg.id }); return value.id; }
    const orderId = `TEST${randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase()}`;
    await store.recordOrder({ ...value, legId: leg.id, orderId, approvalUrl: kind === 'unknown-create' ? null : `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
      orderStatus: 'PAYER_ACTION_REQUIRED', state: kind === 'unknown-create' ? 'unknown' : 'ready', proof: { synthetic: true } });
    if (['unknown-capture', 'blocked', 'confirmed'].includes(kind)) {
      await store.claimCapture({ ...value, legId: leg.id });
      await store.recordCapture({ ...value, legId: leg.id, state: kind === 'confirmed' ? 'confirmed' : 'unknown',
        captureId: kind === 'confirmed' ? `TEST${randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase()}` : null, proof: { synthetic: true } });
    }
    if (kind === 'blocked') await store.block({ ...value, reason: 'provider_binding_changed' });
    return value.id;
  }
  try {
    await store.checkSchema();
    const expected = [await reserve('unknown-create'), await reserve('unknown-capture')].sort();
    for (const kind of ['untouched', 'lost-id', 'waiting-buyer', 'blocked', 'confirmed']) await reserve(kind);
    await reserve('unknown-capture', `other-${organizationId}`);
    const first = await store.listRecoveryCandidates({ organizationId, after: null, limit: 1, signal });
    assert.deepEqual(first, { ids: [expected[0]], nextCursor: expected[0] });
    assert.deepEqual(await store.listRecoveryCandidates({ organizationId, after: first.nextCursor, limit: 1, signal }), { ids: [expected[1]], nextCursor: null });
    let started, finish;
    const entered = new Promise((resolve) => { started = resolve; });
    const drained = new Promise((resolve) => { finish = resolve; });
    const leased = store.withRecoveryLease({ organizationId, signal }, async () => { started(); await drained; });
    await entered;
    try {
      assert.deepEqual(await createCheckoutStore({ pool }).withRecoveryLease({ organizationId, signal }, () => assert.fail('contended lease')), { acquired: false });
      assert.deepEqual(await store.listRecoveryCandidates({ organizationId, after: null, limit: 30, signal }), { ids: expected, nextCursor: null }, 'Lease holds no workflow row locks.');
    } finally { finish(); assert.deepEqual(await leased, { acquired: true }); }
    assert.deepEqual(await createCheckoutStore({ pool }).withRecoveryLease({ organizationId, signal }, async () => {}), { acquired: true });
  } finally { await pool.end(); }
});
