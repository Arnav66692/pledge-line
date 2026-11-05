import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresStore, PostgresStoreError } from '../src/storage/postgres-ledger.js';

function poolWith(clientQuery) {
  const seen = [];
  let released = 0;
  const client = { query: async (sql, values) => { seen.push({ sql, values }); return clientQuery(sql, values); }, release: () => { released += 1; } };
  return { pool: { connect: async () => client }, seen, released: () => released };
}

test('invalid financial bindings fail before acquiring a database connection', async () => {
  let connected = false;
  const store = createPostgresStore({ pool: { connect: async () => { connected = true; throw Error('must not connect'); } } });
  const base = { organizationId: 'org', operationKey: 'order-1', consent: { proposal: 'approved' }, legs: [{ kind: 'capture', targetId: 'merchant-1', amountCents: 1000, currency: 'USD' }] };
  await assert.rejects(store.reserveOperation({ ...base, legs: [{ ...base.legs[0], amountCents: 10.5 }] }), /whole positive integer/);
  await assert.rejects(store.reserveOperation({ ...base, legs: [{ ...base.legs[0], currency: 'usd' }] }), /currency/);
  await assert.rejects(store.reserveOperation({ ...base, legs: [base.legs[0], base.legs[0]] }), /unique/);
  await assert.rejects(store.reserveOperation({ ...base, legs: [{ ...base.legs[0], dependsOn: 'missing' }] }), /dependency/);
  await assert.rejects(store.reserveOperation({ ...base, consent: { toJSON: () => 'not an object' } }), /serialize to a JSON object/);
  const outcome = { organizationId: 'org', operationKey: 'order-1', kind: 'capture', state: 'confirmed', evidence: { status: 'COMPLETED' } };
  await assert.rejects(store.recordLegOutcome(outcome), /providerId/);
  await assert.rejects(store.recordLegOutcome({ ...outcome, providerId: '   ' }), /providerId/);
  await assert.rejects(store.recordLegOutcome({ ...outcome, providerId: 'capture-1', evidence: {} }), /provider evidence/);
  await assert.rejects(store.acceptVerifiedWebhook({ organizationId: 'org', provider: 'paypal', eventId: 'event-1', rawBody: Buffer.from('{}'), verified: false }), /verified/);
  assert.equal(connected, false);
});

test('a database failure rolls back and releases without returning an authorization', async () => {
  const fixture = poolWith(async (sql) => {
    if (/SELECT id, state FROM pledge_operations/.test(sql)) throw Error('private database detail');
    return { rows: [] };
  });
  const store = createPostgresStore({ pool: fixture.pool });
  await assert.rejects(store.claimLeg({ organizationId: 'org', operationKey: 'order-1', kind: 'capture' }), (error) => error instanceof PostgresStoreError && error.code === 'STORE_UNAVAILABLE' && !error.message.includes('private'));
  assert.ok(fixture.seen.some(({ sql }) => sql === 'ROLLBACK'));
  assert.ok(!fixture.seen.some(({ sql }) => sql === 'COMMIT'));
  assert.equal(fixture.released(), 1);
});

test('commit ambiguity never returns a successful claim', async () => {
  const fixture = poolWith(async (sql) => {
    if (sql === 'COMMIT') throw Error('connection lost after commit');
    if (/SELECT id, state FROM pledge_operations/.test(sql)) return { rows: [{ id: 'op', state: 'reserved' }] };
    if (/SELECT \* FROM pledge_operation_legs/.test(sql)) return { rows: [{ kind: 'capture', state: 'reserved', attempt_count: 0, request_id: 'request-1', depends_on: null, target_id: 'merchant', amount_cents: '1000', currency: 'USD' }] };
    if (/UPDATE pledge_operation_legs/.test(sql)) return { rows: [{ kind: 'capture', request_id: 'request-1', target_id: 'merchant', amount_cents: '1000', currency: 'USD' }] };
    return { rows: [] };
  });
  const store = createPostgresStore({ pool: fixture.pool });
  await assert.rejects(store.claimLeg({ organizationId: 'org', operationKey: 'order-1', kind: 'capture' }), (error) => error.code === 'STORE_UNAVAILABLE');
  assert.equal(fixture.released(), 1);
});

test('unknown parent blocks another leg without writing', async () => {
  const fixture = poolWith(async (sql) => {
    if (/SELECT id, state FROM pledge_operations/.test(sql)) return { rows: [{ id: 'op', state: 'unknown' }] };
    return { rows: [] };
  });
  const result = await createPostgresStore({ pool: fixture.pool }).claimLeg({ organizationId: 'org', operationKey: 'order-1', kind: 'capture' });
  assert.deepEqual(result, { claimed: false, reason: 'unknown' });
  assert.ok(!fixture.seen.some(({ sql }) => /UPDATE pledge_operation_legs/.test(sql)));
});

test('startup schema check is read-only and refuses a version mismatch', async () => {
  const fixture = poolWith(async (sql) => sql.includes('SELECT version, checksum') ? { rows: [{ version: 2, checksum: 'different' }] } : { rows: [] });
  await assert.rejects(createPostgresStore({ pool: fixture.pool }).checkSchema(), (error) => error.code === 'SCHEMA_MISMATCH');
  assert.equal(fixture.seen[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.ok(!fixture.seen.some(({ sql }) => /CREATE|INSERT|UPDATE|DELETE/.test(sql)));
});

test('explicit migration upgrades the deployed v1 checksum without replaying v1 DDL', async () => {
  // This checksum is the already-applied v1 artifact, not a hash read from the current implementation.
  const migrations = [{ version: 1, checksum: '06d69244f29c073d94eb7ffcc9bc3f576237d49954c87b239eb51f0c5d115bb1' }];
  const fixture = poolWith(async (sql, values) => {
    if (sql.includes('SELECT version, checksum')) return { rows: migrations.map((row) => ({ ...row })) };
    if (sql.startsWith('INSERT INTO pledge_store_migrations')) migrations.push({ version: values[0], checksum: values[1] });
    return { rows: [] };
  });
  const store = createPostgresStore({ pool: fixture.pool });
  await assert.rejects(store.checkSchema(), (error) => error.code === 'SCHEMA_MISMATCH');
  assert.deepEqual(await store.migrate(), { version: 2, applied: true });
  assert.deepEqual(await store.checkSchema(), { version: 2, matches: true });
  assert.deepEqual(await store.migrate(), { version: 2, applied: false });
  assert.equal(migrations.length, 2);
  assert.ok(fixture.seen.some(({ sql }) => sql.includes('ADD CONSTRAINT pledge_leg_state_attempt_consistency')));
  assert.ok(!fixture.seen.some(({ sql }) => sql.includes('CREATE TABLE pledge_operations')));
  migrations[0].checksum = 'tampered';
  await assert.rejects(store.migrate(), (error) => error.code === 'SCHEMA_MISMATCH');
});

test('retrieval methods use a read-only repeatable snapshot', async () => {
  const fixture = poolWith(async () => ({ rows: [] }));
  const store = createPostgresStore({ pool: fixture.pool });
  assert.equal(await store.getOperation({ organizationId: 'org', operationKey: 'order-1' }), null);
  assert.deepEqual(await store.listUnresolved({ organizationId: 'org' }), []);
  assert.deepEqual(await store.listEvents({ organizationId: 'org', operationKey: 'order-1' }), []);
  assert.equal(fixture.seen.filter(({ sql }) => sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY').length, 3);
});

test('replaying a confirmed outcome retains the complete operation view', async () => {
  const fixture = poolWith(async (sql) => {
    if (/SELECT \* FROM pledge_operations/.test(sql)) return { rows: [{ id: 'op', organization_id: 'org', operation_key: 'order-1', consent_binding: { consent: { proposal: 'approved' } }, state: 'confirmed', created_at: 'created', updated_at: 'updated' }] };
    if (/SELECT \* FROM pledge_operation_legs/.test(sql)) return { rows: [{ kind: 'capture', state: 'confirmed', attempt_count: 1, request_id: 'request-1', provider_id: 'capture-1', evidence: { status: 'COMPLETED' }, depends_on: null, target_id: 'merchant', amount_cents: '1000', currency: 'USD' }] };
    return { rows: [] };
  });
  const result = await createPostgresStore({ pool: fixture.pool }).recordLegOutcome({ organizationId: 'org', operationKey: 'order-1', kind: 'capture', state: 'confirmed', providerId: 'capture-1', evidence: { status: 'COMPLETED' } });
  assert.deepEqual(result.consent, { proposal: 'approved' });
  assert.equal(result.createdAt, 'created');
  assert.equal(result.legs[0].providerId, 'capture-1');
  assert.ok(!fixture.seen.some(({ sql }) => /^UPDATE/.test(sql)));
});

const databaseUrl = process.env.DATABASE_TEST_URL;
test('actual PostgreSQL keeps reservations, consent and unknown outcomes across clients', { skip: !databaseUrl }, async () => {
  const { default: pg } = await import('pg');
  // Exercise 32 competing requests through the same bounded five-connection pool used by the web application.
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 10000 });
  const store = createPostgresStore({ pool });
  const org = `test-${randomUUID()}`;
  const input = { organizationId: org, operationKey: 'purchase', consent: { proposalHash: 'abc', approved: true }, legs: [{ kind: 'capture', targetId: 'merchant-1', amountCents: 2500, currency: 'USD' }] };
  try {
    await store.migrate();
    assert.deepEqual(await store.checkSchema(), { version: 2, matches: true });
    const reservations = await Promise.all(Array.from({ length: 32 }, () => store.reserveOperation(input)));
    assert.equal(new Set(reservations.map((op) => op.id)).size, 1);
    await assert.rejects(store.reserveOperation({ ...input, consent: { proposalHash: 'changed' } }), (error) => error.code === 'BINDING_CONFLICT');
    const operationId = reservations[0].id;
    const lock = await pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM pledge_operations WHERE id=$1 FOR UPDATE', [operationId]);
      await assert.rejects(store.reserveOperation(input), (error) => error.code === 'STORE_UNAVAILABLE', 'a lock timeout never returns a payment authorization');
    } finally { await lock.query('ROLLBACK'); lock.release(); }
    assert.equal((await store.reserveOperation(input)).id, operationId, 'retry after contention recovers the same operation identity');
    const insertLeg = 'INSERT INTO pledge_operation_legs (operation_id,kind,target_id,amount_cents,currency,request_id,state,attempt_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)';
    const approvedInsert = [operationId, 'capture', 'merchant-1', 2500, 'USD', randomUUID(), 'reserved', 0];
    await assert.rejects(pool.query(insertLeg, [operationId, 'unapproved', 'merchant-2', 2500, 'USD', randomUUID(), 'reserved', 0]), (error) => error.code === '23000');
    await assert.rejects(pool.query(insertLeg, [operationId, 'capture', 'merchant-1', 2600, 'USD', randomUUID(), 'reserved', 0]), (error) => error.code === '23000');
    await assert.rejects(pool.query(insertLeg, [...approvedInsert.slice(0, 6), 'in_flight', 1]), (error) => error.code === '23000');
    await assert.rejects(pool.query(insertLeg, [...approvedInsert.slice(0, 7), 1]), (error) => error.code === '23000');
    await assert.rejects(pool.query("UPDATE pledge_operation_legs SET state='in_flight' WHERE operation_id=$1 AND kind='capture'", [operationId]), (error) => error.code === '23514');
    const claims = await Promise.all(Array.from({ length: 32 }, () => store.claimLeg({ organizationId: org, operationKey: 'purchase', kind: 'capture' })));
    assert.equal(claims.filter((claim) => claim.claimed).length, 1);
    await assert.rejects(pool.query("UPDATE pledge_operation_legs SET state='confirmed',provider_id=NULL,evidence='{\"status\":\"COMPLETED\"}'::jsonb WHERE operation_id=$1 AND kind='capture'", [operationId]), (error) => error.code === '23514');
    await assert.rejects(pool.query("UPDATE pledge_operation_legs SET state='confirmed',provider_id='   ',evidence='{\"status\":\"COMPLETED\"}'::jsonb WHERE operation_id=$1 AND kind='capture'", [operationId]), (error) => error.code === '23514');
    await assert.rejects(pool.query("UPDATE pledge_operation_legs SET state='confirmed',provider_id='capture-1',evidence='{}'::jsonb WHERE operation_id=$1 AND kind='capture'", [operationId]), (error) => error.code === '23514');
    await assert.rejects(pool.query("UPDATE pledge_operation_legs SET state='confirmed',provider_id='capture-1',evidence='[]'::jsonb WHERE operation_id=$1 AND kind='capture'", [operationId]), (error) => error.code === '23514');
    await assert.rejects(pool.query("UPDATE pledge_operation_legs SET state='confirmed',provider_id='capture-1',evidence=NULL WHERE operation_id=$1 AND kind='capture'", [operationId]), (error) => error.code === '23514');
    await store.recordLegOutcome({ organizationId: org, operationKey: 'purchase', kind: 'capture', state: 'unknown', evidence: { reason: 'test interrupted write' } });
    const secondClient = createPostgresStore({ pool });
    assert.equal((await secondClient.claimLeg({ organizationId: org, operationKey: 'purchase', kind: 'capture' })).claimed, false);
    const events = await Promise.all(Array.from({ length: 32 }, () => store.acceptVerifiedWebhook({ organizationId: org, provider: 'paypal', eventId: 'event-1', rawBody: Buffer.from('{}'), verified: true })));
    assert.equal(events.filter((event) => event.inserted).length, 1);
    await assert.rejects(store.acceptVerifiedWebhook({ organizationId: org, provider: 'paypal', eventId: 'event-1', rawBody: Buffer.from('{"altered":true}'), verified: true }), (error) => error.code === 'WEBHOOK_CONFLICT');
    await store.appendEvent({ organizationId: org, operationKey: 'purchase', type: 'negative_test', event: { synthetic: true } });
    const deletes = [
      ['DELETE FROM pledge_operations WHERE id=$1', [operationId]],
      ['DELETE FROM pledge_operation_legs WHERE operation_id=$1', [operationId]],
      ['DELETE FROM pledge_webhook_inbox WHERE organization_id=$1', [org]],
      ['DELETE FROM pledge_events WHERE organization_id=$1', [org]],
      ['DELETE FROM pledge_store_migrations WHERE version=$1', [1]],
    ];
    for (const [sql, values] of deletes) await assert.rejects(pool.query(sql, values), (error) => error.code === '23000');
    assert.equal(await store.getOperation({ organizationId: 'other-org', operationKey: 'purchase' }), null);
    const reconciled = await store.recordLegOutcome({ organizationId: org, operationKey: 'purchase', kind: 'capture', state: 'confirmed', providerId: 'synthetic-capture-1', evidence: { status: 'COMPLETED', source: 'synthetic integration test' } });
    const replay = await secondClient.recordLegOutcome({ organizationId: org, operationKey: 'purchase', kind: 'capture', state: 'confirmed', providerId: 'synthetic-capture-1', evidence: { status: 'COMPLETED', source: 'synthetic integration test' } });
    assert.equal(reconciled.state, 'confirmed');
    assert.deepEqual(replay, reconciled);
    assert.equal((await store.reserveOperation(input)).legs[0].providerId, 'synthetic-capture-1');
    await assert.rejects(pool.query("UPDATE pledge_operation_legs SET provider_id='replacement' WHERE operation_id=$1 AND kind='capture'", [operationId]), (error) => error.code === '23000');
    await assert.rejects(pool.query("UPDATE pledge_operation_legs SET evidence='{\"status\":\"altered\"}'::jsonb WHERE operation_id=$1 AND kind='capture'", [operationId]), (error) => error.code === '23000');
    const declined = await store.reserveOperation({ ...input, operationKey: 'declined-purchase' });
    assert.equal((await store.claimLeg({ organizationId: org, operationKey: 'declined-purchase', kind: 'capture' })).claimed, true);
    await store.recordLegOutcome({ organizationId: org, operationKey: 'declined-purchase', kind: 'capture', state: 'failed', providerId: 'synthetic-decline-1', evidence: { status: 'DECLINED' } });
    await assert.rejects(pool.query("UPDATE pledge_operation_legs SET provider_id='replacement' WHERE operation_id=$1 AND kind='capture'", [declined.id]), (error) => error.code === '23000');
    await assert.rejects(pool.query("UPDATE pledge_operation_legs SET evidence='{\"status\":\"altered\"}'::jsonb WHERE operation_id=$1 AND kind='capture'", [declined.id]), (error) => error.code === '23000');
  } finally {
    await pool.end();
  }
});
