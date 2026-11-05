import pg from 'pg';
import { databaseOptions, inspectDatabaseClient, protectDatabasePool } from '../src/database.js';
import { createCheckoutStore } from '../src/checkout-store.js';

const args = new Set(process.argv.slice(2));
if ([...args].some((value) => value !== '--migrate') || !process.env.DATABASE_URL) {
  process.stderr.write('Usage: DATABASE_URL configured privately, node scripts/checkout-check.js [--migrate]\n');
  process.exitCode = 1;
} else {
  let pool;
  try {
    pool = protectDatabasePool(new pg.Pool(databaseOptions(process.env.DATABASE_URL)));
    const client = await pool.connect();
    try { process.stdout.write(JSON.stringify(await inspectDatabaseClient(client, process.env.DATABASE_URL)) + '\n'); }
    finally { client.release(); }
    const store = createCheckoutStore({ pool });
    if (args.has('--migrate')) process.stdout.write(JSON.stringify({ migration: await store.migrate() }) + '\n');
    process.stdout.write(JSON.stringify({ checkoutSchema: await store.checkSchema() }) + '\n');
  } catch {
    process.stderr.write('CHECKOUT_DATABASE_CHECK_FAILED. No credentials or database error details are printed.\n');
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
