import test from 'node:test';
import assert from 'node:assert/strict';
import { runFeatureStorageCheck } from '../scripts/feature-storage-check.js';

const url = 'postgresql://synthetic:private-test-password@db.example.test/app';

function fixture() {
  const steps = [], output = [], errors = [];
  const client = { release() { steps.push('release'); } };
  const pool = { async connect() { steps.push('connect'); return client; }, async end() { steps.push('end'); } };
  const stores = Object.fromEntries(['donor', 'supplier'].map((name) => [name, {
    async migrate() { steps.push(`${name}:migrate`); return { version: 1, applied: true }; },
    async checkSchema() { steps.push(`${name}:check`); return { version: 1, matches: true }; },
  }]));
  const options = { args: [], env: { DATABASE_URL: url },
    write: (line) => output.push(line), writeError: (line) => errors.push(line),
    createPool: (raw) => { assert.equal(raw, url); steps.push('pool'); return pool; },
    inspect: async (actualClient, raw, settings) => {
      assert.equal(actualClient, client); assert.equal(raw, url); assert.equal(settings.requireTls, true);
      steps.push('inspect'); return { connected: true, tls: true, synchronousCommit: 'on' };
    },
    donorFactory: ({ pool: actual }) => { assert.equal(actual, pool); return stores.donor; },
    supplierFactory: ({ pool: actual }) => { assert.equal(actual, pool); return stores.supplier; },
  };
  return { steps, output, errors, pool, stores, options };
}

test('default storage check validates transport and both schemas without migrations', async () => {
  const f = fixture();
  assert.equal(await runFeatureStorageCheck(f.options), 0);
  assert.deepEqual(f.steps, ['pool', 'connect', 'inspect', 'release', 'donor:check', 'supplier:check', 'end']);
  assert.equal(f.errors.length, 0);
  assert.equal(f.output.join('').includes('private-test-password'), false);
  assert.match(f.output.join(''), /donorSchema/);
  assert.match(f.output.join(''), /supplierQuoteSchema/);
});

test('migration requires its exact explicit flag and still checks both resulting schemas', async () => {
  const f = fixture();
  assert.equal(await runFeatureStorageCheck({ ...f.options, args: ['--migrate', '--require-tls'] }), 0);
  assert.deepEqual(f.steps, ['pool', 'connect', 'inspect', 'release', 'donor:migrate', 'donor:check', 'supplier:migrate', 'supplier:check', 'end']);
  assert.match(f.output.join(''), /donorMigration/);
  assert.match(f.output.join(''), /supplierQuoteMigration/);
});

test('unknown flags, missing configuration and help never construct or connect a pool', async () => {
  for (const [args, env, expected] of [
    [['--migrate=true'], { DATABASE_URL: url }, 2],
    [['--password=private-test-password'], { DATABASE_URL: url }, 2],
    [[], {}, 1],
    [['--help', '--migrate'], { DATABASE_URL: url }, 0],
  ]) {
    const f = fixture();
    assert.equal(await runFeatureStorageCheck({ ...f.options, args, env }), expected);
    assert.deepEqual(f.steps, []);
    assert.equal([...f.errors, ...f.output].join('').includes('private-test-password'), false);
  }
});

test('failed TLS validation releases the client and pool without touching feature schemas', async () => {
  const f = fixture();
  assert.equal(await runFeatureStorageCheck({ ...f.options, args: ['--migrate'], inspect: async () => { throw new Error('TLS_REQUIRED'); } }), 1);
  assert.deepEqual(f.steps, ['pool', 'connect', 'release', 'end']);
  assert.match(f.errors.join(''), /^TLS_REQUIRED\./);
});

test('schema failure never causes a migration or leaks database error details', async () => {
  const f = fixture();
  f.stores.supplier.checkSchema = async () => { f.steps.push('supplier:check'); throw Object.assign(new Error(url), { code: 'SUPPLIER_QUOTE_SCHEMA_MISMATCH' }); };
  assert.equal(await runFeatureStorageCheck(f.options), 1);
  assert.deepEqual(f.steps, ['pool', 'connect', 'inspect', 'release', 'donor:check', 'supplier:check', 'end']);
  assert.match(f.errors.join(''), /^SUPPLIER_QUOTE_SCHEMA_MISMATCH\./);
  assert.equal([...f.errors, ...f.output].join('').includes(url), false);
});

test('pool cleanup failures produce a safe failure status instead of an uncaught credential-bearing error', async () => {
  const f = fixture();
  f.pool.end = async () => { f.steps.push('end'); throw new Error(url); };
  assert.equal(await runFeatureStorageCheck(f.options), 1);
  assert.equal(f.steps.at(-1), 'end');
  assert.match(f.errors.join(''), /FEATURE_STORAGE_CHECK_FAILED/);
  assert.equal([...f.errors, ...f.output].join('').includes(url), false);
});
