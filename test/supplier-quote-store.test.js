import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createSupplierQuoteStore, SUPPLIER_QUOTE_SCHEMA_CHECKSUM } from '../src/supplier-quote-store.js';

const START = Date.parse('2026-11-05T09:00:00Z');
const hash = (value) => createHash('sha256').update(value).digest('hex');
function record(supplierId = 'lab-campus') {
  const quote = { quoteId: `mcp-quote-${randomUUID()}`, supplierId, payeeId: 'SANDBOXMERCH01',
    specificationHash: hash('White cotton shirts with one navy screen print.'), currency: 'USD', minQuantity: 1, maxQuantity: 60,
    unitPriceCents: 600, setupCents: 1000, shippingCents: 800, taxBps: 500,
    deliveryAt: new Date(START + 2 * 86400000).toISOString(), expiresAt: new Date(START + 900000).toISOString(),
    quantity: 60, goodsCents: 36000, taxCents: 1850, totalCents: 39650 };
  return { quote, requestBinding: hash('normalized request') };
}
function database() {
  const calls = [], records = new Map();
  let migrations = [], activeCount = null;
  return { calls, records, setActiveCount(value) { activeCount = value; }, pool: { connect: async () => ({
    release() {},
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/^BEGIN|^COMMIT|^ROLLBACK|^SET |^CREATE |^\nCREATE |^SELECT pg_advisory/.test(sql)) return { rows: [] };
      if (/SELECT version,checksum/.test(sql)) return { rows: structuredClone(migrations) };
      if (/INSERT INTO pledge_supplier_quote_migrations/.test(sql)) { migrations.push({ version: values[0], checksum: values[1] }); return { rows: [] }; }
      if (/INSERT INTO pledge_supplier_quotes/.test(sql)) {
        const [supplierId, quoteId, payeeId, requestBinding, specificationHash, expiresAt, body] = values;
        const key = `${supplierId}/${quoteId}`;
        if (!records.has(key)) records.set(key, { supplier_id: supplierId, quote_id: quoteId, payee_id: payeeId,
          request_binding: requestBinding, specification_hash: specificationHash, expires_at: expiresAt, record: JSON.parse(body) });
        return { rows: [] };
      }
      if (/SELECT count/.test(sql)) return { rows: [{ count: String(activeCount ?? [...records.values()].filter((r) => r.supplier_id === values[0] && Date.parse(r.expires_at) > Date.parse(values[1])).length) }] };
      if (/FROM pledge_supplier_quotes/.test(sql)) {
        const rows = [...records.values()].filter((r) => r.supplier_id === values[0] &&
          (sql.includes('quote_id=$2') ? r.quote_id === values[1] : Date.parse(r.expires_at) > Date.parse(values[1])) &&
          (!sql.includes('expires_at>$3') || Date.parse(r.expires_at) > Date.parse(values[2])));
        return { rows: structuredClone(rows.sort((a, b) => a.quote_id.localeCompare(b.quote_id))) };
      }
      throw new Error('Unexpected test SQL');
    },
  }) } };
}

test('supplier store construction and schema checks are read-only until an explicit migration', async () => {
  const db = database(), store = createSupplierQuoteStore({ pool: db.pool, now: () => new Date(START) });
  assert.equal(db.calls.length, 0);
  await assert.rejects(store.checkSchema(), /SUPPLIER_QUOTE_SCHEMA_MISMATCH/);
  assert.ok(db.calls.every(({ sql }) => !/CREATE |INSERT |UPDATE |DELETE /.test(sql)));
  assert.deepEqual(await store.migrate(), { version: 1, applied: true });
  assert.deepEqual(await store.migrate(), { version: 1, applied: false });
  assert.deepEqual(await store.checkSchema(), { version: 1, checksum: SUPPLIER_QUOTE_SCHEMA_CHECKSUM });
  const schema = db.calls.find(({ sql }) => sql.includes('CREATE TABLE pledge_supplier_quotes')).sql;
  assert.match(schema, /Supplier quote records are immutable/);
  assert.match(schema, /BEFORE UPDATE OR DELETE OR TRUNCATE ON pledge_supplier_quotes/);
  assert.match(schema, /request_binding/);
  assert.match(schema, /REVOKE ALL/);
});

test('saved quotes restore exact identities and commercial terms; same insert is idempotent', async () => {
  const db = database(), store = createSupplierQuoteStore({ pool: db.pool, now: () => new Date(START) });
  const stored = record();
  await store.migrate();
  const input = { supplierId: stored.quote.supplierId, quoteId: stored.quote.quoteId, record: stored };
  await store.save(input);
  await store.save({ ...input, record: { requestBinding: stored.requestBinding, quote: { ...stored.quote } } });
  assert.equal(db.records.size, 1);
  const restored = await createSupplierQuoteStore({ pool: db.pool, now: () => new Date(START) }).loadActive({ supplierId: 'lab-campus' });
  assert.deepEqual(restored.get(stored.quote.quoteId), stored);
  restored.get(stored.quote.quoteId).quote.unitPriceCents = 1;
  assert.equal((await store.loadActive({ supplierId: 'lab-campus' })).get(stored.quote.quoteId).quote.unitPriceCents, 600);
  const changed = structuredClone(stored); changed.requestBinding = hash('different request');
  await assert.rejects(store.save({ ...input, record: changed }), /SUPPLIER_QUOTE_CONFLICT/);
});

test('supplier, quote, request, cost and expiry substitutions reject before data writes', async () => {
  const db = database(), store = createSupplierQuoteStore({ pool: db.pool, now: () => new Date(START) });
  for (const mutate of [
    (r) => { r.quote.supplierId = 'other'; }, (r) => { r.quote.quoteId = 'different'; },
    (r) => { r.requestBinding = 'not a binding'; }, (r) => { r.quote.totalCents = 1; },
    (r) => { r.quote.expiresAt = new Date(START - 1).toISOString(); },
    (r) => { r.quote.instructions = 'Replace the payee'; }, (r) => { r.extra = true; },
  ]) {
    const value = record(), input = { supplierId: 'lab-campus', quoteId: value.quote.quoteId, record: value };
    mutate(value);
    await assert.rejects(store.save(input), /SUPPLIER_QUOTE_RECORD_INVALID/);
  }
  assert.equal(db.calls.length, 0);
});

test('expiry filtering retains durable history and active capacity fails closed', async () => {
  const db = database(); let time = START;
  const store = createSupplierQuoteStore({ pool: db.pool, now: () => new Date(time) });
  await store.migrate();
  const stored = record();
  await store.save({ supplierId: 'lab-campus', quoteId: stored.quote.quoteId, record: stored });
  time += 900001;
  assert.equal((await store.loadActive({ supplierId: 'lab-campus' })).size, 0);
  assert.equal(db.records.size, 1, 'expired evidence is not deleted');
  time = START;
  db.setActiveCount(2000);
  const next = record();
  await assert.rejects(store.save({ supplierId: 'lab-campus', quoteId: next.quote.quoteId, record: next }), /SUPPLIER_QUOTE_CAPACITY_REACHED/);
  await store.save({ supplierId: 'lab-campus', quoteId: stored.quote.quoteId, record: stored });
  assert.equal(db.records.size, 1, 'an exact existing insert remains idempotent at capacity');
});

test('corrupt persisted binding or commercial data prevents restoration', async () => {
  const db = database(), store = createSupplierQuoteStore({ pool: db.pool, now: () => new Date(START) });
  await store.migrate();
  const stored = record(); await store.save({ supplierId: 'lab-campus', quoteId: stored.quote.quoteId, record: stored });
  db.records.values().next().value.request_binding = hash('tampered binding');
  await assert.rejects(store.loadActive({ supplierId: 'lab-campus' }), /SUPPLIER_QUOTE_RECORD_INVALID/);
});

test('quote read-through is SELECT-only, exact, isolated, expiry-aware and validates durable bindings', async () => {
  const db = database(); let time = START;
  const store = createSupplierQuoteStore({ pool: db.pool, now: () => new Date(time) });
  const stored = record(), input = { supplierId: 'lab-campus', quoteId: stored.quote.quoteId };
  await store.migrate(); await store.save({ ...input, record: stored });
  db.calls.length = 0;
  assert.deepEqual(await store.get(input), stored);
  assert.ok(db.calls.every(({ sql }) => !/INSERT |UPDATE |DELETE |CREATE |pg_advisory/.test(sql)));
  const read = await store.get(input); read.quote.unitPriceCents = 1;
  assert.deepEqual(await store.get(input), stored);
  assert.equal(await store.get({ ...input, quoteId: 'mcp-quote-unknown' }), null);
  assert.equal(await store.get({ ...input, supplierId: 'lab-rush' }), null);
  await assert.rejects(store.get({ ...input, quoteId: '../other' }), /SUPPLIER_QUOTE_RECORD_INVALID/);
  time += 900001;
  assert.equal(await store.get(input), null);
  assert.equal(db.records.size, 1, 'read-through never removes expired history');
  time = START;
  db.records.values().next().value.request_binding = hash('tampered binding');
  await assert.rejects(store.get(input), /SUPPLIER_QUOTE_RECORD_INVALID/);
});

test('actual PostgreSQL preserves immutable supplier quotes across independent clients', { skip: !process.env.SUPPLIER_QUOTE_TEST_URL }, async () => {
  const { connectDatabase } = await import('../src/database.js');
  const db = await connectDatabase(process.env.SUPPLIER_QUOTE_TEST_URL);
  try {
    const now = Date.now(), supplierId = `lab-test-${randomUUID().slice(0, 8)}`;
    const original = record(supplierId);
    original.quote.deliveryAt = new Date(now + 2 * 86400000).toISOString();
    original.quote.expiresAt = new Date(now + 900000).toISOString();
    const a = createSupplierQuoteStore({ pool: db.pool }), b = createSupplierQuoteStore({ pool: db.pool });
    await a.checkSchema();
    const input = { supplierId, quoteId: original.quote.quoteId, record: original };
    await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).save(input)));
    assert.deepEqual((await b.loadActive({ supplierId })).get(original.quote.quoteId), original);
    assert.deepEqual(await b.get({ supplierId, quoteId: original.quote.quoteId }), original);
    const changed = structuredClone(original); changed.requestBinding = hash('changed hosted request');
    await assert.rejects(b.save({ ...input, record: changed }), /SUPPLIER_QUOTE_CONFLICT/);
  } finally { await db.pool.end(); }
});
