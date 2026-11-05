import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createCheckoutStore, CHECKOUT_SCHEMA_CHECKSUM } from '../src/checkout-store.js';

const copy = (value) => structuredClone(value);
const hash = (value) => createHash('sha256').update(value).digest('hex');
function fixture(query) {
  const seen = []; let released = 0;
  const client = { query: async (sql, values) => { seen.push({ sql, values }); return query(sql, values); }, release: () => { released += 1; } };
  return { pool: { connect: async () => client }, seen, released: () => released };
}
function reservation() {
  return { organizationId: `checkout-test-${randomUUID()}`, id: randomUUID(), rfq: { quantity: 1, currency: 'USD' },
    proposal: { termsHash: 'a'.repeat(64), allocations: [{ supplierId: 'supplier', payeeId: 'MERCHANT00001', quantity: 1, totalCents: 100, currency: 'USD' }] },
    sessionSecretHash: hash('synthetic-browser-secret') };
}

test('checkout schema checks are read-only and require the exact explicit migration checksum', async () => {
  const f = fixture(async (sql) => sql.includes('SELECT version,checksum') ? { rows: [{ version: 1, checksum: CHECKOUT_SCHEMA_CHECKSUM }] } : { rows: [] });
  assert.deepEqual(await createCheckoutStore({ pool: f.pool }).checkSchema(), { version: 1, matches: true });
  assert.equal(f.seen[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.ok(!f.seen.some(({ sql }) => /CREATE|UPDATE|DELETE|INSERT/.test(sql)));
  const bad = fixture(async (sql) => sql.includes('SELECT version,checksum') ? { rows: [{ version: 1, checksum: 'tampered' }] } : { rows: [] });
  await assert.rejects(createCheckoutStore({ pool: bad.pool }).checkSchema(), (error) => error.code === 'CHECKOUT_SCHEMA_MISMATCH');
});

test('migration is explicit, idempotent and includes immutable claims, terminal outcomes and delete guards', async () => {
  const history = [];
  const f = fixture(async (sql, values) => {
    if (sql.includes('SELECT version,checksum')) return { rows: copy(history) };
    if (sql.startsWith('INSERT INTO pledge_checkout_migrations')) history.push({ version: values[0], checksum: values[1] });
    return { rows: [] };
  });
  const store = createCheckoutStore({ pool: f.pool });
  assert.deepEqual(await store.migrate(), { version: 1, applied: true });
  assert.deepEqual(await store.migrate(), { version: 1, applied: false });
  const ddl = f.seen.find(({ sql }) => sql.includes('CREATE TABLE pledge_checkout_workflows')).sql;
  assert.match(ddl, /captureRequestId/); assert.match(ddl, /Checkout identity or terminal outcome changed/);
  assert.match(ddl, /Checkout deletion is not an application operation/); assert.match(ddl, /Checkout capture is blocked/);
  assert.equal(f.seen.filter(({ sql }) => sql.includes('CREATE TABLE pledge_checkout_workflows')).length, 1);
});

test('checkout store validates identity and secret hashes before connecting', async () => {
  let called = false;
  const store = createCheckoutStore({ pool: { connect: async () => { called = true; throw Error('must not connect'); } } });
  const input = reservation();
  await assert.rejects(store.reserve({ ...input, sessionSecretHash: 'browser-plaintext-secret' }), /CHECKOUT_INPUT_INVALID/);
  await assert.rejects(store.reserve({ ...input, id: 'not-a-uuid' }), /CHECKOUT_INPUT_INVALID/);
  await assert.rejects(store.get({ organizationId: '', id: input.id }), /CHECKOUT_INPUT_INVALID/);
  assert.equal(called, false);
});

test('checkout check sanitizes a malformed credential-bearing URL before pool construction', () => {
  const secretMarker = 'synthetic-private-password-must-not-print';
  const result = spawnSync(process.execPath, ['scripts/checkout-check.js'], { cwd: new URL('..', import.meta.url),
    env: { ...process.env, DATABASE_URL: `postgres://user:${secretMarker}@[` }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CHECKOUT_DATABASE_CHECK_FAILED/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(secretMarker), false);
});

test('a create claim is never returned after commit ambiguity and private database errors are sanitized', async () => {
  const input = reservation(), legId = randomUUID();
  const row = { id: input.id, organization_id: input.organizationId, binding: { request: input.rfq, proposal: input.proposal }, session_secret_hash: input.sessionSecretHash,
    created_at: new Date(), updated_at: new Date(), blocked_reason: null,
    legs: [{ id: legId, allocation: input.proposal.allocations[0], createState: 'reserved', captureState: 'reserved', createRequestId: randomUUID() }] };
  const f = fixture(async (sql, values) => {
    if (sql === 'COMMIT') throw Error('private-secret-db-detail');
    if (sql.startsWith('SELECT * FROM pledge_checkout_workflows')) return { rows: [copy(row)] };
    if (sql.startsWith('UPDATE pledge_checkout_workflows')) return { rows: [{ ...row, legs: JSON.parse(values[2]) }] };
    return { rows: [] };
  });
  await assert.rejects(createCheckoutStore({ pool: f.pool }).claimCreate({ organizationId: input.organizationId, id: input.id, legId }),
    (error) => error.code === 'CHECKOUT_STORE_UNAVAILABLE' && !error.message.includes('private-secret'));
  assert.ok(f.seen.some(({ sql }) => sql === 'ROLLBACK')); assert.equal(f.released(), 1);
});

test('an unknown checkout leg blocks further claims without mutating storage', async () => {
  const input = reservation(), legId = randomUUID();
  const f = fixture(async (sql) => sql.startsWith('SELECT * FROM pledge_checkout_workflows') ? { rows: [{
    id: input.id, organization_id: input.organizationId, binding: { request: input.rfq, proposal: input.proposal }, session_secret_hash: input.sessionSecretHash,
    created_at: new Date(), updated_at: new Date(), blocked_reason: null,
    legs: [{ id: legId, createState: 'unknown', captureState: 'reserved' }],
  }] } : { rows: [] });
  assert.deepEqual(await createCheckoutStore({ pool: f.pool }).claimCreate({ organizationId: input.organizationId, id: input.id, legId }), { claimed: false });
  assert.ok(!f.seen.some(({ sql }) => sql.startsWith('UPDATE')));
});

test('confirmed capture replay accepts equivalent JSONB key order without overwriting evidence', async () => {
  const input = reservation(), legId = randomUUID();
  const row = { id: input.id, organization_id: input.organizationId, binding: { request: input.rfq, proposal: input.proposal }, session_secret_hash: input.sessionSecretHash,
    created_at: new Date(), updated_at: new Date(), blocked_reason: null,
    legs: [{ id: legId, captureState: 'confirmed', captureId: 'CAPTURE000001', captureEvidence: { amountCents: 100, status: 'COMPLETED' } }] };
  const f = fixture(async (sql) => sql.startsWith('SELECT * FROM pledge_checkout_workflows') ? { rows: [row] } : { rows: [] });
  const result = await createCheckoutStore({ pool: f.pool }).recordCapture({ ...input, legId, state: 'confirmed', captureId: 'CAPTURE000001', proof: { status: 'COMPLETED', amountCents: 100 } });
  assert.equal(result.legs[0].captureId, 'CAPTURE000001');
  assert.ok(!f.seen.some(({ sql }) => sql.startsWith('UPDATE')));
});

test('actual PostgreSQL preserves checkout creation/capture identities and unknown states across clients', { skip: !process.env.DATABASE_TEST_URL }, async () => {
  const { default: pg } = await import('pg');
  const { databaseOptions } = await import('../src/database.js');
  const pool = new pg.Pool(databaseOptions(process.env.DATABASE_TEST_URL));
  const store = createCheckoutStore({ pool }), input = reservation();
  try {
    await store.migrate(); assert.deepEqual(await store.checkSchema(), { version: 1, matches: true });
    const states = await Promise.all(Array.from({ length: 32 }, () => store.reserve(input)));
    assert.equal(new Set(states.map((state) => state.legs[0].createRequestId)).size, 1);
    const leg = states[0].legs[0];
    await assert.rejects(store.reserve({ ...input, sessionSecretHash: hash('different secret') }), /CHECKOUT_BINDING_CONFLICT/);
    const creates = await Promise.all(Array.from({ length: 32 }, () => store.claimCreate({ ...input, legId: leg.id })));
    assert.equal(creates.filter((result) => result.claimed).length, 1);
    const illegalReset = "UPDATE pledge_checkout_workflows SET legs=jsonb_set(jsonb_set(legs,'{0,createState}','\"reserved\"'::jsonb),'{0,createAttempts}','0'::jsonb) WHERE id=$1";
    await assert.rejects(pool.query(illegalReset, [input.id]), (error) => error.code === '23000');
    await store.markCreateUnknown({ ...input, legId: leg.id });
    assert.equal((await createCheckoutStore({ pool }).claimCreate({ ...input, legId: leg.id })).claimed, false);
    // Synthetic provider data validates the store, not PayPal or supplier participation.
    const orderId = `TEST${randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase()}`;
    await store.recordOrder({ ...input, legId: leg.id, orderId, approvalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
      orderStatus: 'APPROVED', proof: { synthetic: true, orderId } });
    const claims = await Promise.all(Array.from({ length: 32 }, () => store.claimCapture({ ...input, legId: leg.id })));
    assert.equal(claims.filter((result) => result.claimed).length, 1);
    await assert.rejects(pool.query("UPDATE pledge_checkout_workflows SET legs=jsonb_set(jsonb_set(jsonb_set(legs,'{0,captureState}','\"confirmed\"'::jsonb),'{0,captureId}','\"\"'::jsonb),'{0,captureEvidence}','{\"status\":\"COMPLETED\"}'::jsonb) WHERE id=$1", [input.id]), (error) => error.code === '23000');
    await store.recordCapture({ ...input, legId: leg.id, state: 'unknown', proof: { synthetic: true, interrupted: true } });
    const fresh = createCheckoutStore({ pool });
    assert.equal((await fresh.claimCapture({ ...input, legId: leg.id })).claimed, false);
    assert.equal((await fresh.get(input)).legs[0].captureRequestId, leg.captureRequestId);
    const captureId = `TEST${randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase()}`;
    await fresh.recordCapture({ ...input, legId: leg.id, state: 'confirmed', captureId, proof: { synthetic: true, captureId } });
    await assert.rejects(pool.query("UPDATE pledge_checkout_workflows SET legs=jsonb_set(legs,'{0,captureEvidence}','{\"changed\":true}'::jsonb) WHERE id=$1", [input.id]), (error) => error.code === '23000');
    await assert.rejects(pool.query("UPDATE pledge_checkout_workflows SET session_secret_hash=$2 WHERE id=$1", [input.id, hash('changed')]), (error) => error.code === '23000');
    await assert.rejects(pool.query('DELETE FROM pledge_checkout_workflows WHERE id=$1', [input.id]), (error) => error.code === '23000');
    const missing = await fresh.get({ organizationId: `other-${randomUUID()}`, id: input.id });
    assert.equal(missing, null);
  } finally { await pool.end(); }
});
