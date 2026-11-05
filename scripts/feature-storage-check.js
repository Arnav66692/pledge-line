// Operator-only. Schema checks are read-only unless --migrate is explicitly supplied.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { databaseOptions, inspectDatabaseClient, protectDatabasePool } from '../src/database.js';
import { createDonorStore } from '../src/donor-store.js';
import { createSupplierQuoteStore } from '../src/supplier-quote-store.js';

const USAGE = 'Usage: DATABASE_URL configured privately, node scripts/feature-storage-check.js [--migrate] [--require-tls]\n';
const SAFE_CODES = new Set(['TLS_REQUIRED', 'DURABILITY_REQUIRED', 'DATABASE_CONFIGURATION_INVALID',
  'DONOR_SCHEMA_MISMATCH', 'SUPPLIER_QUOTE_SCHEMA_MISMATCH']);
const defaultPool = (raw) => protectDatabasePool(new pg.Pool({ ...databaseOptions(raw), max: 1 }));

/** Injectable boundaries keep CLI checks testable without private configuration or a database. */
export async function runFeatureStorageCheck({ args = process.argv.slice(2), env = process.env,
  write = (line) => process.stdout.write(line), writeError = (line) => process.stderr.write(line),
  createPool = defaultPool, inspect = inspectDatabaseClient,
  donorFactory = createDonorStore, supplierFactory = createSupplierQuoteStore } = {}) {
  const flags = new Set(args);
  if ([...flags].some((flag) => !['--migrate', '--require-tls', '--help'].includes(flag))) {
    writeError(USAGE);
    return 2;
  }
  if (flags.has('--help')) { write(USAGE); return 0; }
  if (typeof env.DATABASE_URL !== 'string' || !env.DATABASE_URL.trim()) {
    writeError('DATABASE_URL is not configured. No database was contacted.\n');
    return 1;
  }
  let pool, exitCode = 0;
  const output = (value) => write(JSON.stringify(value) + '\n');
  try {
    pool = createPool(env.DATABASE_URL);
    const client = await pool.connect();
    try { output(await inspect(client, env.DATABASE_URL, { requireTls: true })); }
    finally { client.release(); }
    const donor = donorFactory({ pool });
    if (flags.has('--migrate')) output({ donorMigration: await donor.migrate() });
    output({ donorSchema: await donor.checkSchema() });
    const supplier = supplierFactory({ pool });
    if (flags.has('--migrate')) output({ supplierQuoteMigration: await supplier.migrate() });
    output({ supplierQuoteSchema: await supplier.checkSchema() });
  } catch (error) {
    const candidate = SAFE_CODES.has(error?.code) ? error.code : error?.message;
    const code = SAFE_CODES.has(candidate) ? candidate : 'FEATURE_STORAGE_CHECK_FAILED';
    writeError(`${code}. No credentials or database error details are printed.\n`);
    exitCode = 1;
  } finally {
    try { await pool?.end(); }
    catch {
      writeError('FEATURE_STORAGE_CHECK_FAILED. Database cleanup failed; no credentials or database error details are printed.\n');
      exitCode = 1;
    }
  }
  if (exitCode === 0) write('Feature storage checks complete. No PayPal or AI requests were made.\n');
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runFeatureStorageCheck();
}
