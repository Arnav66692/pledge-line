import pg from 'pg';
import { createPostgresStore } from './storage/postgres-ledger.js';

export function protectDatabasePool(pool, report = (message) => process.stderr.write(message + '\n')) {
  // pg removes the failed idle client. An unhandled pool error would otherwise terminate the entire web server.
  pool.on('error', () => report('Database connection interrupted. Unconfirmed operations require reconciliation.'));
  return pool;
}

export function databaseOptions(raw) {
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.pathname.slice(1)) throw new Error('DATABASE_CONFIGURATION_INVALID');
  if ([...url.searchParams.keys()].some((key) => ['host', 'hostaddr', 'port', 'user', 'password', 'database', 'ssl'].includes(key.toLowerCase()))) throw new Error('DATABASE_CONFIGURATION_INVALID');
  // Hosted database traffic must verify the server certificate. Do not allow a URL to silently disable TLS.
  url.searchParams.delete('ssl');
  url.searchParams.set('sslmode', 'verify-full');
  return { connectionString: url.toString(), max: 5, connectionTimeoutMillis: 10000, query_timeout: 20000, idleTimeoutMillis: 30000 };
}

export function verifyDatabaseSettings(raw, row, transport, { requireTls = true } = {}) {
  const normalized = databaseOptions(raw);
  const neon = new URL(normalized.connectionString).hostname.endsWith('.neon.tech');
  if ((requireTls || neon) && (transport?.encrypted !== true || transport?.authorized !== true)) throw new Error('TLS_REQUIRED');
  if (row?.synchronous_commit !== 'on' || (row?.fsync !== 'on' && !neon)) throw new Error('DURABILITY_REQUIRED');
  // Neon computes do not own durable disks. Commits use remote safekeeper quorum, not compute-local fsync.
  // https://neon.com/docs/introduction/architecture-overview
  return { tls: transport?.encrypted === true && transport?.authorized === true,
    backendTls: row?.tls === true, fsync: row?.fsync, synchronousCommit: row?.synchronous_commit,
    durabilityModel: neon ? 'neon-wal-quorum' : 'postgres-fsync' };
}

export async function inspectDatabaseClient(client, raw, options) {
  const result = await client.query("SELECT current_setting('server_version') AS version, (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls, current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS synchronous_commit");
  const row = result.rows[0];
  const stream = client.connection.stream;
  return { connected: true, serverVersion: row?.version, ...verifyDatabaseSettings(raw, row, stream, options) };
}

export async function connectDatabase(raw) {
  const pool = protectDatabasePool(new pg.Pool(databaseOptions(raw)));
  try {
    const client = await pool.connect();
    try { await inspectDatabaseClient(client, raw); } finally { client.release(); }
    const store = createPostgresStore({ pool });
    await store.checkSchema();
    return { pool, store };
  } catch {
    await pool.end();
    throw new Error('DATABASE_STARTUP_FAILED. Verify the connection and apply the explicit migration before starting.');
  }
}
