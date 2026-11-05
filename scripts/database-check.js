// Read-only by default. Migration is an explicit operator action, never a server-side fallback.
import { createPostgresStore } from '../src/storage/postgres-ledger.js';
import { databaseOptions, inspectDatabaseClient, protectDatabasePool } from '../src/database.js';

const args = new Set(process.argv.slice(2));
if ([...args].some((arg) => !['--migrate', '--require-tls'].includes(arg))) {
  process.stderr.write('Usage: node scripts/database-check.js [--migrate] [--require-tls]\n');
  process.exitCode = 2;
} else if (!process.env.DATABASE_URL) {
  process.stderr.write('DATABASE_URL is not configured. No database was contacted.\n');
  process.exitCode = 1;
} else {
  let pool;
  try {
    const { default: pg } = await import('pg');
    pool = protectDatabasePool(new pg.Pool({ ...databaseOptions(process.env.DATABASE_URL), max: 1 }));
    const client = await pool.connect();
    try {
      const settings = await inspectDatabaseClient(client, process.env.DATABASE_URL, { requireTls: args.has('--require-tls') });
      process.stdout.write(JSON.stringify(settings) + '\n');
    } finally { client.release(); }
    const store = createPostgresStore({ pool });
    if (args.has('--migrate')) {
      const result = await store.migrate();
      process.stdout.write(JSON.stringify({ migration: result }) + '\n');
    }
    process.stdout.write(JSON.stringify({ schema: await store.checkSchema() }) + '\n');
    process.stdout.write('Connection checks complete. This is not a real-money readiness certification.\n');
  } catch (error) {
    const safeCode = ['TLS_REQUIRED', 'DURABILITY_REQUIRED'].includes(error?.message) ? error.message : error?.code === 'SCHEMA_MISMATCH' ? 'SCHEMA_MISMATCH' : 'DATABASE_CHECK_FAILED';
    process.stderr.write(`${safeCode}. No credentials or database error details are printed.\n`);
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
