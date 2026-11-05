// Reads only local allocation records. This does not query either provider or certify its account balance.
import pg from 'pg';
import { databaseOptions, inspectDatabaseClient, protectDatabasePool } from '../src/database.js';
import { AI_DEFAULT_LIMITS, createAiBudget } from '../src/ai-budget.js';

const args = new Set(process.argv.slice(2));
const fromDollars = (raw, fallback) => {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+(?:\.\d{1,9})?$/.test(raw)) throw Error('AI_CONFIGURATION_INVALID');
  const [whole, fraction = ''] = raw.split('.');
  const value = Number(BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0')));
  if (!Number.isSafeInteger(value)) throw Error('AI_CONFIGURATION_INVALID');
  return value;
};
let pool;
try {
  if ([...args].some((arg) => arg !== '--migrate')) throw Error('AI_CHECK_USAGE');
  if (!process.env.DATABASE_URL) throw Error('AI_DATABASE_REQUIRED');
  pool = protectDatabasePool(new pg.Pool({ ...databaseOptions(process.env.DATABASE_URL), max: 1 }));
  const client = await pool.connect();
  try { await inspectDatabaseClient(client, process.env.DATABASE_URL); } finally { client.release(); }
  const budget = createAiBudget({ pool, scope: process.env.AI_BUDGET_SCOPE || 'pledge-line', limits: {
    anthropic: fromDollars(process.env.AI_ANTHROPIC_LIMIT_USD, AI_DEFAULT_LIMITS.anthropic),
    jev: fromDollars(process.env.AI_JEV_LIMIT_USD, AI_DEFAULT_LIMITS.jev),
  } });
  if (args.has('--migrate')) process.stdout.write(JSON.stringify({ migration: await budget.migrate() }) + '\n');
  process.stdout.write(JSON.stringify({ schema: await budget.checkSchema(), allocation: await budget.status() }) + '\n');
  process.stdout.write('Project allocation only. Provider balance and auto-recharge must be verified with the provider. No AI request was made.\n');
} catch (error) {
  const safe = ['AI_CHECK_USAGE', 'AI_DATABASE_REQUIRED', 'AI_CONFIGURATION_INVALID', 'AI_SCHEMA_MISMATCH', 'AI_ALLOCATION_MISMATCH'].includes(error?.code ?? error?.message) ? error.code ?? error.message : 'AI_CHECK_FAILED';
  process.stderr.write(`${safe}. No credential or raw provider/database error is printed.\n`);
  process.exitCode = 1;
} finally { await pool?.end(); }
