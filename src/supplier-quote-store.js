import { createHash } from 'node:crypto';
import { validateSupplierQuote } from './supplier-mcp.js';

const MAX_ACTIVE = 2000;
const HASH = /^[a-f0-9]{64}$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export class SupplierQuoteStoreError extends Error {
  constructor(code = 'SUPPLIER_QUOTE_STORAGE_UNAVAILABLE') { super(code); this.name = 'SupplierQuoteStoreError'; this.code = code; }
}
const fail = (code) => { throw new SupplierQuoteStoreError(code); };
const supplier = (value) => { if (typeof value !== 'string' || !/^[a-z0-9-]{1,48}$/.test(value)) fail('SUPPLIER_QUOTE_RECORD_INVALID'); };
const quoteKey = (value) => { if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,120}$/.test(value)) fail('SUPPLIER_QUOTE_RECORD_INVALID'); };

const SCHEMA = `
CREATE TABLE pledge_supplier_quotes (
 supplier_id text NOT NULL CHECK (supplier_id ~ '^[a-z0-9-]{1,48}$'),
 quote_id text NOT NULL CHECK (quote_id ~ '^[A-Za-z0-9-]{1,120}$'),
 payee_id text NOT NULL CHECK (payee_id ~ '^[A-Z0-9]{8,40}$'),
 request_binding text NOT NULL CHECK (request_binding ~ '^[a-f0-9]{64}$'),
 specification_hash text NOT NULL CHECK (specification_hash ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz NOT NULL,
 record jsonb NOT NULL CHECK (jsonb_typeof(record)='object' AND octet_length(record::text)<=16000),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (supplier_id,quote_id),
 CHECK ((record->>'requestBinding') IS NOT DISTINCT FROM request_binding AND
        (record->'quote'->>'supplierId') IS NOT DISTINCT FROM supplier_id AND
        (record->'quote'->>'quoteId') IS NOT DISTINCT FROM quote_id AND
        (record->'quote'->>'payeeId') IS NOT DISTINCT FROM payee_id AND
        (record->'quote'->>'specificationHash') IS NOT DISTINCT FROM specification_hash AND
        (record->'quote'->>'expiresAt') IS NOT NULL AND
        (record->'quote'->>'expiresAt')::timestamptz=expires_at)
);
CREATE INDEX pledge_supplier_quotes_active ON pledge_supplier_quotes (supplier_id,expires_at);
CREATE FUNCTION pledge_supplier_quote_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Supplier quote records are immutable' USING ERRCODE='23000';
END $$;
CREATE TRIGGER pledge_supplier_quote_guard BEFORE UPDATE OR DELETE OR TRUNCATE ON pledge_supplier_quotes
 FOR EACH STATEMENT EXECUTE FUNCTION pledge_supplier_quote_immutable();
CREATE TRIGGER pledge_supplier_quote_migration_guard BEFORE UPDATE OR DELETE OR TRUNCATE ON pledge_supplier_quote_migrations
 FOR EACH STATEMENT EXECUTE FUNCTION pledge_supplier_quote_immutable();
REVOKE ALL ON pledge_supplier_quotes,pledge_supplier_quote_migrations FROM PUBLIC;
`;
export const SUPPLIER_QUOTE_SCHEMA_VERSION = 1;
export const SUPPLIER_QUOTE_SCHEMA_CHECKSUM = createHash('sha256').update(SCHEMA).digest('hex');

/** Only migrate() performs DDL. Runtime needs SELECT/INSERT on quotes and SELECT on migration metadata. */
export function createSupplierQuoteStore({ pool, now = () => new Date() } = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof now !== 'function') fail('SUPPLIER_QUOTE_DATABASE_REQUIRED');
  const at = () => {
    const value = new Date(now()).getTime();
    if (!Number.isFinite(value)) fail('SUPPLIER_QUOTE_RECORD_INVALID');
    return value;
  };
  function recordFor({ supplierId, quoteId, record }, time = at()) {
    supplier(supplierId);
    quoteKey(quoteId);
    if (!object(record) ||
      Object.keys(record).length !== 2 || !object(record.quote) || !HASH.test(record.requestBinding ?? '') ||
      record.quote.quoteId !== quoteId || record.quote.supplierId !== supplierId ||
      !/^[A-Z0-9]{8,40}$/.test(record.quote.payeeId ?? '')) fail('SUPPLIER_QUOTE_RECORD_INVALID');
    try {
      const quote = validateSupplierQuote(record.quote, { id: supplierId, payeeId: record.quote.payeeId }, { now: time });
      const result = { quote, requestBinding: record.requestBinding };
      if (Buffer.byteLength(JSON.stringify(result)) > 16000) fail('SUPPLIER_QUOTE_RECORD_INVALID');
      return result;
    } catch { fail('SUPPLIER_QUOTE_RECORD_INVALID'); }
  }
  function rowRecord(row, time = at()) {
    const value = recordFor({ supplierId: row.supplier_id, quoteId: row.quote_id, record: row.record }, time);
    if (value.quote.payeeId !== row.payee_id || value.requestBinding !== row.request_binding ||
      value.quote.specificationHash !== row.specification_hash ||
      Date.parse(value.quote.expiresAt) !== new Date(row.expires_at).getTime()) fail('SUPPLIER_QUOTE_RECORD_INVALID');
    return value;
  }
  async function transaction(work, readonly = false) {
    let client;
    try {
      client = await pool.connect();
      await client.query(readonly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='5s'");
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try { await client?.query('ROLLBACK'); } catch { /* No quote is exposed after uncertain persistence. */ }
      if (error instanceof SupplierQuoteStoreError) throw error;
      throw new SupplierQuoteStoreError();
    } finally { client?.release(); }
  }
  async function migration(client, required = true) {
    const result = await client.query('SELECT version,checksum FROM pledge_supplier_quote_migrations ORDER BY version');
    if (result.rows.length > 1 || (required && result.rows.length !== 1) || result.rows.some((row) =>
      row.version !== SUPPLIER_QUOTE_SCHEMA_VERSION || row.checksum !== SUPPLIER_QUOTE_SCHEMA_CHECKSUM)) fail('SUPPLIER_QUOTE_SCHEMA_MISMATCH');
    return result.rows.length === 1;
  }
  return {
    async migrate() {
      return transaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('pledge-supplier-quote-schema'))");
        await client.query('CREATE TABLE IF NOT EXISTS pledge_supplier_quote_migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
        if (await migration(client, false)) return { version: SUPPLIER_QUOTE_SCHEMA_VERSION, applied: false };
        await client.query(SCHEMA);
        await client.query('INSERT INTO pledge_supplier_quote_migrations(version,checksum) VALUES($1,$2)', [SUPPLIER_QUOTE_SCHEMA_VERSION, SUPPLIER_QUOTE_SCHEMA_CHECKSUM]);
        return { version: SUPPLIER_QUOTE_SCHEMA_VERSION, applied: true };
      });
    },
    async checkSchema() {
      return transaction(async (client) => {
        await migration(client);
        return { version: SUPPLIER_QUOTE_SCHEMA_VERSION, checksum: SUPPLIER_QUOTE_SCHEMA_CHECKSUM };
      }, true);
    },
    async save(input) {
      const record = recordFor(input), { supplierId, quoteId } = input;
      return transaction(async (client) => {
        // Transaction pooling requires an xact lock, never a session-level advisory lock.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('pledge-supplier-quotes:'||$1,0))", [supplierId]);
        const prior = (await client.query('SELECT * FROM pledge_supplier_quotes WHERE supplier_id=$1 AND quote_id=$2', [supplierId, quoteId])).rows[0];
        if (prior) {
          if (!same(rowRecord(prior), record)) fail('SUPPLIER_QUOTE_CONFLICT');
          return { saved: true, existing: true };
        }
        const active = await client.query('SELECT count(*) AS count FROM pledge_supplier_quotes WHERE supplier_id=$1 AND expires_at>$2', [supplierId, new Date(at()).toISOString()]);
        const count = Number(active.rows[0]?.count);
        if (!Number.isSafeInteger(count) || count < 0) fail('SUPPLIER_QUOTE_STORAGE_UNAVAILABLE');
        if (count >= MAX_ACTIVE) fail('SUPPLIER_QUOTE_CAPACITY_REACHED');
        await client.query('INSERT INTO pledge_supplier_quotes(supplier_id,quote_id,payee_id,request_binding,specification_hash,expires_at,record) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
          [supplierId, quoteId, record.quote.payeeId, record.requestBinding, record.quote.specificationHash, record.quote.expiresAt, JSON.stringify(record)]);
        return { saved: true, existing: false };
      });
    },
    async loadActive({ supplierId } = {}) {
      supplier(supplierId);
      return transaction(async (client) => {
        const time = at();
        const result = await client.query('SELECT * FROM pledge_supplier_quotes WHERE supplier_id=$1 AND expires_at>$2 ORDER BY quote_id LIMIT 2001', [supplierId, new Date(time).toISOString()]);
        if (result.rows.length > MAX_ACTIVE) fail('SUPPLIER_QUOTE_CAPACITY_REACHED');
        return new Map(result.rows.map((row) => [row.quote_id, rowRecord(row, time)]));
      }, true);
    },
    async get({ supplierId, quoteId } = {}) {
      supplier(supplierId); quoteKey(quoteId);
      return transaction(async (client) => {
        const time = at();
        const result = await client.query('SELECT * FROM pledge_supplier_quotes WHERE supplier_id=$1 AND quote_id=$2 AND expires_at>$3',
          [supplierId, quoteId, new Date(time).toISOString()]);
        if (result.rows.length > 1) fail('SUPPLIER_QUOTE_RECORD_INVALID');
        const row = result.rows[0];
        if (!row) return null;
        if (row.supplier_id !== supplierId || row.quote_id !== quoteId) fail('SUPPLIER_QUOTE_RECORD_INVALID');
        return rowRecord(row, time);
      }, true);
    },
  };
}
