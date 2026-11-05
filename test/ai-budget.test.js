import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AI_DEFAULT_LIMITS, AiBudgetError, createAiBudget } from '../src/ai-budget.js';

// Models a serialized database connection and transaction commit boundary, not PostgreSQL's SQL engine.
function database() {
  let data = { migrations: [], scopes: new Map(), accounts: new Map(), requests: new Map() };
  let tail = Promise.resolve();
  const calls = [];
  const control = { failCommit: false, failQuery: null };
  function connection() {
    let unlock;
    let snapshot;
    const releaseLock = () => { unlock?.(); unlock = null; };
    return {
      release: releaseLock,
      async query(sql, values = []) {
        calls.push({ sql, values });
        if (sql.startsWith('BEGIN')) {
          const prior = tail;
          tail = new Promise((resolve) => { unlock = resolve; });
          await prior;
          snapshot = structuredClone(data);
          return { rows: [] };
        }
        if (sql === 'COMMIT') {
          snapshot = null;
          releaseLock();
          if (control.failCommit) { control.failCommit = false; throw Error('private committed connection failure'); }
          return { rows: [] };
        }
        if (sql === 'ROLLBACK') { if (snapshot) data = snapshot; snapshot = null; releaseLock(); return { rows: [] }; }
        if (control.failQuery?.(sql)) throw Error('private database failure');
        const [scope, second, third, fourth] = values;
        const rows = (items) => ({ rows: structuredClone(items) });
        if (/SELECT s\.stopped,s\.stop_reason,s\.stop_provider/.test(sql)) {
          const current = data.scopes.get(scope);
          const request = data.requests.get(`${scope}/${second}`);
          return rows(current ? [{ ...current, ...(request ?? {}), stopped: current.stopped, stop_reason: current.stop_reason, stop_provider: current.stop_provider }] : []);
        }
        if (/SELECT version,checksum/.test(sql)) return rows(data.migrations);
        if (/INSERT INTO pledge_ai_migrations/.test(sql)) { data.migrations.push({ version: scope, checksum: second }); return rows([]); }
        if (/INSERT INTO pledge_ai_scopes/.test(sql)) { if (!data.scopes.has(scope)) data.scopes.set(scope, { scope, stopped: false, stop_reason: null, stop_provider: null }); return rows([]); }
        if (/SELECT \* FROM pledge_ai_scopes/.test(sql)) return rows(data.scopes.has(scope) ? [data.scopes.get(scope)] : []);
        if (/UPDATE pledge_ai_scopes/.test(sql)) { Object.assign(data.scopes.get(scope), { stopped: true, stop_reason: second, stop_provider: third }); return rows([]); }
        if (/INSERT INTO pledge_ai_accounts/.test(sql)) { const key = `${scope}/${second}`; if (!data.accounts.has(key)) data.accounts.set(key, { scope, provider: second, allocation_nanos: third, used_nanos: 0 }); return rows([]); }
        if (/SELECT \* FROM pledge_ai_accounts/.test(sql)) return rows([...data.accounts.values()].filter((row) => row.scope === scope).sort((a, b) => a.provider.localeCompare(b.provider)));
        if (/UPDATE pledge_ai_accounts/.test(sql)) { const row = data.accounts.get(`${scope}/${second}`); row.used_nanos = sql.includes('used_nanos=used_nanos+') ? row.used_nanos + third : third; return rows([]); }
        if (/SELECT \* FROM pledge_ai_requests/.test(sql)) return rows(data.requests.has(`${scope}/${second}`) ? [data.requests.get(`${scope}/${second}`)] : []);
        if (/SELECT request_id/.test(sql)) return rows([...data.requests.values()].filter((row) => row.scope === scope && row.state === 'reserved'));
        if (/INSERT INTO pledge_ai_requests/.test(sql)) {
          assert.ok(![...data.requests.values()].some((row) => row.scope === scope && row.state === 'reserved'), 'one in-flight request per scope');
          data.requests.set(`${scope}/${second}`, { scope, request_id: second, provider: third, reservation_nanos: fourth, state: 'reserved', cost_nanos: null }); return rows([]);
        }
        if (/UPDATE pledge_ai_requests/.test(sql)) { Object.assign(data.requests.get(`${scope}/${second}`), { state: 'settled', cost_nanos: third }); return rows([]); }
        if (/^(SET |CREATE |SELECT pg_advisory|\nCREATE TABLE)/.test(sql)) return rows([]);
        throw Error(`Unexpected test query ${sql.slice(0, 100)}`);
      },
    };
  }
  return { pool: { connect: async () => connection() }, calls, control };
}

test('AI budget requires PostgreSQL and rejects invalid bindings before connecting', async () => {
  assert.throws(() => createAiBudget(), (error) => error.code === 'AI_STORAGE_REQUIRED');
  let connected = 0;
  const pool = { connect: async () => { connected += 1; throw Error('must not connect'); } };
  assert.throws(() => createAiBudget({ pool, scope: 'bad\nscope' }), (error) => error.code === 'AI_INVALID_INPUT');
  assert.throws(() => createAiBudget({ pool, limits: { anthropic: -1, jev: 1 } }), (error) => error.code === 'AI_INVALID_INPUT');
  const budget = createAiBudget({ pool });
  await assert.rejects(budget.reserve({ provider: 'oauth', requestId: 'request', maxCostNanos: 1 }), (error) => error.code === 'AI_INVALID_INPUT');
  await assert.rejects(budget.reserve({ provider: 'jev', requestId: 'request', maxCostNanos: 0.1 }), (error) => error.code === 'AI_INVALID_INPUT');
  await assert.rejects(budget.checkDispatch({ provider: 'jev', requestId: 'bad\nrequest', maxCostNanos: 1 }), (error) => error.code === 'AI_INVALID_INPUT');
  await assert.rejects(budget.settle({ requestId: 'request', costNanos: -1 }), (error) => error.code === 'AI_INVALID_INPUT');
  assert.equal(connected, 0);
});

test('AI schema migration is explicit and an immutable checksum is checked read-only', async () => {
  const fixture = database();
  const budget = createAiBudget({ pool: fixture.pool });
  await assert.rejects(budget.checkSchema(), (error) => error.code === 'AI_SCHEMA_MISMATCH');
  assert.ok(!fixture.calls.some(({ sql }) => /CREATE |INSERT |UPDATE /.test(sql)));
  assert.deepEqual(await budget.migrate(), { version: 1, applied: true });
  assert.deepEqual(await budget.migrate(), { version: 1, applied: false });
  assert.deepEqual(await budget.checkSchema(), { version: 1, matches: true });
  const schema = fixture.calls.find(({ sql }) => sql.includes('CREATE TABLE pledge_ai_scopes')).sql;
  assert.match(schema, /CREATE UNIQUE INDEX pledge_ai_one_inflight/);
  assert.match(schema, /AI stop is latched/);
  assert.match(schema, /AI allocation is immutable/);
  assert.match(schema, /AI spending records cannot be deleted/);
  assert.match(schema, /BEFORE UPDATE ON pledge_ai_migrations FOR EACH STATEMENT/);
  assert.match(schema, /REVOKE ALL ON pledge_ai_scopes,pledge_ai_accounts,pledge_ai_requests,pledge_ai_migrations FROM PUBLIC/);
  const status = await budget.status();
  assert.equal(status.providerBalanceVerified, false);
  assert.equal(status.accounts.anthropic.allocationNanos, AI_DEFAULT_LIMITS.anthropic);
  assert.equal(status.accounts.jev.allocationNanos, AI_DEFAULT_LIMITS.jev);
});

test('zero allocation in either provider latches a global stop that restart or migration cannot clear', async () => {
  for (const zero of ['anthropic', 'jev']) {
    const fixture = database();
    const limits = { anthropic: 100, jev: 100, [zero]: 0 };
    const budget = createAiBudget({ pool: fixture.pool, limits });
    await budget.migrate();
    for (const provider of ['anthropic', 'jev']) assert.equal((await budget.reserve({ provider, requestId: `${provider}-1`, maxCostNanos: 1 })).allowed, false);
    const restarted = createAiBudget({ pool: fixture.pool, limits });
    await restarted.migrate();
    assert.equal((await restarted.status()).stopped, true);
    assert.equal((await restarted.status()).provider, zero);
    const changed = createAiBudget({ pool: fixture.pool, limits: { anthropic: 1000, jev: 1000 } });
    await assert.rejects(changed.migrate(), (error) => error.code === 'AI_ALLOCATION_MISMATCH');
  }
});

test('32 simultaneous reservations yield one dispatch permission and never overspend', async () => {
  const fixture = database();
  const budget = createAiBudget({ pool: fixture.pool, limits: { anthropic: 100, jev: 100 } });
  await budget.migrate();
  const attempts = await Promise.all(Array.from({ length: 32 }, (_, index) => budget.reserve({ provider: index % 2 ? 'anthropic' : 'jev', requestId: `attempt-${index}`, maxCostNanos: 60 })));
  assert.equal(attempts.filter((result) => result.allowed).length, 1);
  assert.equal(attempts.filter((result) => result.reason === 'request_in_progress').length, 31);
  const status = await budget.status();
  assert.equal(status.pendingRequests.length, 1);
  assert.equal(status.accounts.anthropic.usedNanos + status.accounts.jev.usedNanos, 60);
  const reservation = attempts.find((result) => result.allowed);
  await budget.settle({ requestId: reservation.requestId, costNanos: 30 });
  assert.equal((await budget.status()).accounts[reservation.provider].usedNanos, 30);
});

test('unknown requests retain the full reservation and block the other provider across restart', async () => {
  const fixture = database();
  const limits = { anthropic: 100, jev: 100 };
  const first = createAiBudget({ pool: fixture.pool, limits });
  await first.migrate();
  assert.equal((await first.reserve({ provider: 'anthropic', requestId: 'lost-answer', maxCostNanos: 70 })).allowed, true);
  const second = createAiBudget({ pool: fixture.pool, limits });
  assert.equal((await second.reserve({ provider: 'jev', requestId: 'new-answer', maxCostNanos: 10 })).reason, 'request_in_progress');
  assert.equal((await second.status()).accounts.anthropic.usedNanos, 70);
  assert.equal((await second.reserve({ provider: 'anthropic', requestId: 'lost-answer', maxCostNanos: 70 })).reason, 'request_already_reserved');
  await assert.rejects(second.reserve({ provider: 'jev', requestId: 'lost-answer', maxCostNanos: 70 }), (error) => error.code === 'AI_REQUEST_CONFLICT');
});

test('dispatch check reads the exact durable reservation in one round trip and never permits a stale or changed claim', async () => {
  const fixture = database();
  const budget = createAiBudget({ pool: fixture.pool, limits: { anthropic: 100, jev: 100 } });
  await budget.migrate();
  let before = fixture.calls.length;
  await budget.reserve({ provider: 'anthropic', requestId: 'dispatch', maxCostNanos: 70 });
  assert.ok(fixture.calls.length - before <= 8, 'reservation preserves its commit with at most eight SQL round trips');
  before = fixture.calls.length;
  assert.deepEqual(await budget.checkDispatch({ provider: 'anthropic', requestId: 'dispatch', maxCostNanos: 70 }), { allowed: true, stopped: false, requestId: 'dispatch', provider: 'anthropic', maxCostNanos: 70 });
  assert.equal(fixture.calls.length - before, 1);
  await assert.rejects(budget.checkDispatch({ provider: 'jev', requestId: 'dispatch', maxCostNanos: 70 }), (error) => error.code === 'AI_REQUEST_CONFLICT');
  await assert.rejects(budget.checkDispatch({ provider: 'anthropic', requestId: 'dispatch', maxCostNanos: 69 }), (error) => error.code === 'AI_REQUEST_CONFLICT');
  await assert.rejects(budget.checkDispatch({ provider: 'anthropic', requestId: 'missing', maxCostNanos: 70 }), (error) => error.code === 'AI_REQUEST_NOT_FOUND');
  before = fixture.calls.length;
  await budget.settle({ requestId: 'dispatch', costNanos: 20 });
  assert.ok(fixture.calls.length - before <= 7, 'settlement preserves its commit with at most seven SQL round trips');
  assert.deepEqual(await budget.checkDispatch({ provider: 'anthropic', requestId: 'dispatch', maxCostNanos: 70 }), { allowed: false, stopped: false, reason: 'request_not_reserved' });
  assert.equal((await budget.status()).accounts.anthropic.usedNanos, 20);
});

test('dispatch check observes a peer stop and fails closed on storage failure without releasing the claim', async () => {
  const fixture = database();
  const budget = createAiBudget({ pool: fixture.pool });
  await budget.migrate();
  const claim = { provider: 'jev', requestId: 'peer-stop', maxCostNanos: 70 };
  await budget.reserve(claim);
  await budget.trip({ reason: 'credit_exhausted', provider: 'anthropic' });
  assert.deepEqual(await budget.checkDispatch(claim), { allowed: false, stopped: true, reason: 'credit_exhausted' });
  fixture.control.failQuery = (sql) => sql.includes('SELECT s.stopped,s.stop_reason,s.stop_provider');
  await assert.rejects(budget.checkDispatch(claim), (error) => error.code === 'AI_STORAGE_UNAVAILABLE' && !error.message.includes('private'));
  fixture.control.failQuery = null;
  const status = await budget.status();
  assert.equal(status.accounts.jev.usedNanos, 70);
  assert.equal(status.pendingRequests.length, 1);
});

test('settlements are idempotent, validate before refunding, and overrun truthfully stops both', async () => {
  const fixture = database();
  const budget = createAiBudget({ pool: fixture.pool, limits: { anthropic: 100, jev: 100 } });
  await budget.migrate();
  await budget.reserve({ provider: 'anthropic', requestId: 'one', maxCostNanos: 50 });
  await budget.settle({ requestId: 'one', costNanos: 20 });
  await budget.settle({ requestId: 'one', costNanos: 20 });
  await assert.rejects(budget.settle({ requestId: 'one', costNanos: 0 }), (error) => error.code === 'AI_REQUEST_CONFLICT');
  assert.equal((await budget.status()).accounts.anthropic.usedNanos, 20);
  await budget.reserve({ provider: 'jev', requestId: 'overrun', maxCostNanos: 20 });
  assert.equal((await budget.settle({ requestId: 'overrun', costNanos: 25 })).stopped, true);
  assert.equal((await budget.status()).accounts.jev.usedNanos, 25);
  assert.equal((await budget.status()).reason, 'pricing_mismatch');
  assert.equal((await budget.reserve({ provider: 'anthropic', requestId: 'after', maxCostNanos: 1 })).allowed, false);
});

test('allocation exhaustion and provider credit errors cannot be cleared by another reason', async () => {
  const fixture = database();
  const budget = createAiBudget({ pool: fixture.pool, limits: { anthropic: 100, jev: 100 } });
  await budget.migrate();
  const result = await budget.reserve({ provider: 'jev', requestId: 'too-large', maxCostNanos: 101 });
  assert.equal(result.allowed, false);
  assert.equal(result.stopped, true);
  await budget.trip({ reason: 'operator_stop' });
  assert.equal((await budget.status()).reason, 'allocation_exhausted');
  const anotherFixture = database();
  const other = createAiBudget({ pool: anotherFixture.pool });
  await other.migrate();
  await other.trip({ reason: 'credit_exhausted', provider: 'anthropic' });
  assert.equal((await other.status()).reason, 'credit_exhausted');
  assert.equal((await other.reserve({ provider: 'jev', requestId: 'other', maxCostNanos: 1 })).allowed, false);
});

test('ambiguous commit never returns permission and its durable reservation prevents a second dispatch', async () => {
  const fixture = database();
  const budget = createAiBudget({ pool: fixture.pool });
  await budget.migrate();
  fixture.control.failCommit = true;
  await assert.rejects(budget.reserve({ provider: 'anthropic', requestId: 'commit-lost', maxCostNanos: 100 }), (error) => error instanceof AiBudgetError && error.code === 'AI_STORAGE_UNAVAILABLE' && !error.message.includes('private'));
  const restarted = createAiBudget({ pool: fixture.pool });
  assert.equal((await restarted.reserve({ provider: 'jev', requestId: 'after-lost-commit', maxCostNanos: 10 })).reason, 'request_in_progress');
  assert.equal((await restarted.status()).pendingRequests[0].requestId, 'commit-lost');
});

const databaseUrl = process.env.AI_DATABASE_TEST_URL;
test('hosted PostgreSQL enforces atomic AI claims and latched stops across independent clients', { skip: !databaseUrl }, async () => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 10000 });
  pool.on('error', () => {});
  const scope = `ai-test-${randomUUID()}`;
  const limits = { anthropic: 1000, jev: 1000 };
  const budget = createAiBudget({ pool, scope, limits });
  try {
    await budget.migrate();
    await budget.checkSchema();
    await assert.rejects(pool.query("UPDATE pledge_ai_migrations SET checksum=repeat('a',64) WHERE version=1"), (error) => error.code === '23000');
    await assert.rejects(pool.query('UPDATE pledge_ai_migrations SET version=2 WHERE version=1'), (error) => error.code === '23000');
    await budget.checkSchema();
    const attempts = await Promise.all(Array.from({ length: 32 }, (_, index) => budget.reserve({ provider: index % 2 ? 'anthropic' : 'jev', requestId: `attempt-${index}`, maxCostNanos: 100 })));
    assert.equal(attempts.filter((attempt) => attempt.allowed).length, 1);
    const winner = attempts.find((attempt) => attempt.allowed);
    assert.equal((await budget.checkDispatch({ provider: winner.provider, requestId: winner.requestId, maxCostNanos: 100 })).allowed, true);
    assert.equal((await createAiBudget({ pool, scope, limits }).reserve({ provider: 'jev', requestId: 'restart', maxCostNanos: 1 })).reason, 'request_in_progress');
    await budget.settle({ requestId: winner.requestId, costNanos: 50 });
    assert.equal((await budget.checkDispatch({ provider: winner.provider, requestId: winner.requestId, maxCostNanos: 100 })).reason, 'request_not_reserved');
    await assert.rejects(pool.query('UPDATE pledge_ai_accounts SET allocation_nanos=10000 WHERE scope=$1', [scope]), (error) => error.code === '23000');
    await assert.rejects(pool.query("UPDATE pledge_ai_requests SET cost_nanos=0 WHERE scope=$1 AND request_id=$2", [scope, winner.requestId]), (error) => error.code === '23000');
    await budget.trip({ reason: 'credit_exhausted', provider: 'anthropic' });
    assert.equal((await budget.checkDispatch({ provider: winner.provider, requestId: winner.requestId, maxCostNanos: 100 })).stopped, true);
    await assert.rejects(pool.query('UPDATE pledge_ai_scopes SET stopped=false,stop_reason=NULL,stop_provider=NULL,stopped_at=NULL WHERE scope=$1', [scope]), (error) => error.code === '23000');
    await assert.rejects(pool.query('DELETE FROM pledge_ai_requests WHERE scope=$1', [scope]), (error) => error.code === '23000');
    assert.equal((await createAiBudget({ pool, scope, limits }).reserve({ provider: 'jev', requestId: 'after-stop', maxCostNanos: 1 })).allowed, false);
  } finally { await pool.end(); }
});
