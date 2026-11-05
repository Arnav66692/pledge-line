import { createHash } from 'node:crypto';

export const AI_DEFAULT_LIMITS = Object.freeze({ anthropic: 5_000_000_000, jev: 250_000_000 });
const PROVIDERS = ['anthropic', 'jev'];
const MAX_NANOS = 1_000_000_000_000_000;
const REASONS = new Set(['allocation_exhausted', 'credit_exhausted', 'authentication_failed', 'usage_unverified', 'pricing_mismatch', 'operator_stop']);
export class AiBudgetError extends Error {
  constructor(code) { super(code); this.name = 'AiBudgetError'; this.code = code; }
}
const fail = (code) => { throw new AiBudgetError(code); };
const identifier = (value) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(value)) fail('AI_INVALID_INPUT');
  return value;
};
const nanos = (value, { positive = false } = {}) => {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > MAX_NANOS) fail('AI_INVALID_INPUT');
  return value;
};
const providerOf = (value) => { if (!PROVIDERS.includes(value)) fail('AI_INVALID_INPUT'); return value; };

// The allocation is a project spending ceiling, not a claim about either provider's live account balance.
const SCHEMA = `
CREATE TABLE pledge_ai_scopes (
 scope text PRIMARY KEY, stopped boolean NOT NULL DEFAULT false, stop_reason text,
 stop_provider text CHECK (stop_provider IN ('anthropic','jev')), stopped_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((stopped AND stop_reason IS NOT NULL AND stopped_at IS NOT NULL) OR
        (NOT stopped AND stop_reason IS NULL AND stop_provider IS NULL AND stopped_at IS NULL))
);
CREATE TABLE pledge_ai_accounts (
 scope text NOT NULL REFERENCES pledge_ai_scopes(scope), provider text NOT NULL CHECK (provider IN ('anthropic','jev')),
 allocation_nanos bigint NOT NULL CHECK (allocation_nanos BETWEEN 0 AND 1000000000000000),
 used_nanos bigint NOT NULL DEFAULT 0 CHECK (used_nanos BETWEEN 0 AND 1000000000000000),
 PRIMARY KEY (scope,provider)
);
CREATE TABLE pledge_ai_requests (
 scope text NOT NULL REFERENCES pledge_ai_scopes(scope), request_id text NOT NULL,
 provider text NOT NULL CHECK (provider IN ('anthropic','jev')),
 reservation_nanos bigint NOT NULL CHECK (reservation_nanos BETWEEN 1 AND 1000000000000000),
 state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','settled')),
 cost_nanos bigint CHECK (cost_nanos BETWEEN 0 AND 1000000000000000),
 created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz,
 PRIMARY KEY (scope,request_id), FOREIGN KEY(scope,provider) REFERENCES pledge_ai_accounts(scope,provider),
 CHECK ((state='reserved' AND cost_nanos IS NULL AND settled_at IS NULL) OR
        (state='settled' AND cost_nanos IS NOT NULL AND settled_at IS NOT NULL))
);
CREATE UNIQUE INDEX pledge_ai_one_inflight ON pledge_ai_requests(scope) WHERE state='reserved';
CREATE FUNCTION pledge_ai_protect_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.scope,NEW.created_at) IS DISTINCT FROM (OLD.scope,OLD.created_at) OR
    (OLD.stopped AND (NEW.stopped,NEW.stop_reason,NEW.stop_provider,NEW.stopped_at)
     IS DISTINCT FROM (OLD.stopped,OLD.stop_reason,OLD.stop_provider,OLD.stopped_at)) THEN
  RAISE EXCEPTION 'AI stop is latched' USING ERRCODE='23000';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER pledge_ai_scope_guard BEFORE UPDATE ON pledge_ai_scopes FOR EACH ROW EXECUTE FUNCTION pledge_ai_protect_scope();
CREATE FUNCTION pledge_ai_protect_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.scope,NEW.provider,NEW.allocation_nanos) IS DISTINCT FROM (OLD.scope,OLD.provider,OLD.allocation_nanos) THEN
  RAISE EXCEPTION 'AI allocation is immutable' USING ERRCODE='23000';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER pledge_ai_account_guard BEFORE UPDATE ON pledge_ai_accounts FOR EACH ROW EXECUTE FUNCTION pledge_ai_protect_account();
CREATE FUNCTION pledge_ai_protect_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.scope,NEW.request_id,NEW.provider,NEW.reservation_nanos,NEW.created_at)
    IS DISTINCT FROM (OLD.scope,OLD.request_id,OLD.provider,OLD.reservation_nanos,OLD.created_at) OR
    (OLD.state='settled' AND (NEW.state,NEW.cost_nanos,NEW.settled_at) IS DISTINCT FROM (OLD.state,OLD.cost_nanos,OLD.settled_at)) OR
    (NEW.state='reserved' AND OLD.state<>'reserved') THEN
  RAISE EXCEPTION 'AI request binding is immutable' USING ERRCODE='23000';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER pledge_ai_request_guard BEFORE UPDATE ON pledge_ai_requests FOR EACH ROW EXECUTE FUNCTION pledge_ai_protect_request();
CREATE FUNCTION pledge_ai_deny_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'AI spending records cannot be deleted or truncated' USING ERRCODE='23000';
END; $$;
CREATE TRIGGER pledge_ai_scope_no_delete BEFORE DELETE OR TRUNCATE ON pledge_ai_scopes FOR EACH STATEMENT EXECUTE FUNCTION pledge_ai_deny_delete();
CREATE TRIGGER pledge_ai_account_no_delete BEFORE DELETE OR TRUNCATE ON pledge_ai_accounts FOR EACH STATEMENT EXECUTE FUNCTION pledge_ai_deny_delete();
CREATE TRIGGER pledge_ai_request_no_delete BEFORE DELETE OR TRUNCATE ON pledge_ai_requests FOR EACH STATEMENT EXECUTE FUNCTION pledge_ai_deny_delete();
CREATE TRIGGER pledge_ai_migration_no_delete BEFORE DELETE OR TRUNCATE ON pledge_ai_migrations FOR EACH STATEMENT EXECUTE FUNCTION pledge_ai_deny_delete();
CREATE FUNCTION pledge_ai_deny_migration_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'AI migration metadata cannot be updated' USING ERRCODE='23000';
END; $$;
CREATE TRIGGER pledge_ai_migration_no_update BEFORE UPDATE ON pledge_ai_migrations FOR EACH STATEMENT EXECUTE FUNCTION pledge_ai_deny_migration_update();
REVOKE ALL ON pledge_ai_scopes,pledge_ai_accounts,pledge_ai_requests,pledge_ai_migrations FROM PUBLIC;
`;
const CHECKSUM = createHash('sha256').update(SCHEMA).digest('hex');

export function createAiBudget({ pool, scope = 'pledge-line', limits = AI_DEFAULT_LIMITS } = {}) {
  if (!pool || typeof pool.connect !== 'function') fail('AI_STORAGE_REQUIRED');
  identifier(scope);
  const allocations = Object.fromEntries(PROVIDERS.map((provider) => [provider, nanos(limits?.[provider])]));

  async function transaction(work, { readOnly = false } = {}) {
    let client;
    try {
      client = await pool.connect();
      // Fixed statements execute in order on the same connection, without three network round trips.
      await client.query(`${readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN'}; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'`);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client?.query('ROLLBACK'); } catch { /* Preserve fail-closed behavior if the connection is gone. */ }
      if (error instanceof AiBudgetError) throw error;
      throw new AiBudgetError('AI_STORAGE_UNAVAILABLE');
    } finally { client?.release(); }
  }
  async function scopeRow(client, lock = false) {
    const result = await client.query(`SELECT * FROM pledge_ai_scopes WHERE scope=$1${lock ? ' FOR UPDATE' : ''}`, [scope]);
    if (!result.rows[0]) fail('AI_NOT_INITIALIZED');
    return result.rows[0];
  }
  async function accounts(client) {
    const result = await client.query('SELECT * FROM pledge_ai_accounts WHERE scope=$1 ORDER BY provider', [scope]);
    if (result.rows.length !== 2 || PROVIDERS.some((provider) => !result.rows.some((row) => row.provider === provider && Number(row.allocation_nanos) === allocations[provider]))) fail('AI_ALLOCATION_MISMATCH');
    return result.rows;
  }
  async function stop(client, row, reason, provider) {
    if (!row.stopped) {
      await client.query('UPDATE pledge_ai_scopes SET stopped=true,stop_reason=$2,stop_provider=$3,stopped_at=now() WHERE scope=$1', [scope, reason, provider]);
      row = { ...row, stopped: true, stop_reason: reason, stop_provider: provider };
    }
    return row;
  }
  async function view(client, row = null, rows = null) {
    row ??= await scopeRow(client);
    rows ??= await accounts(client);
    const pending = await client.query("SELECT request_id,provider,reservation_nanos FROM pledge_ai_requests WHERE scope=$1 AND state='reserved' ORDER BY created_at", [scope]);
    return { scope, stopped: row.stopped, reason: row.stop_reason ?? null, provider: row.stop_provider ?? null,
      providerBalanceVerified: false, allocationUnit: 'USD nanodollars',
      accounts: Object.fromEntries(rows.map((account) => [account.provider, { allocationNanos: Number(account.allocation_nanos),
        usedNanos: Number(account.used_nanos), remainingNanos: Math.max(0, Number(account.allocation_nanos) - Number(account.used_nanos)) }])),
      pendingRequests: pending.rows.map((request) => ({ requestId: request.request_id, provider: request.provider, maxCostNanos: Number(request.reservation_nanos) })) };
  }
  async function migration(client, full = true) {
    const result = await client.query('SELECT version,checksum FROM pledge_ai_migrations ORDER BY version');
    if (result.rows.length > 1 || (full && result.rows.length !== 1) || result.rows.some((row) => row.version !== 1 || row.checksum !== CHECKSUM)) fail('AI_SCHEMA_MISMATCH');
    return result.rows.length === 1;
  }

  return {
    async migrate() {
      return transaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('pledge-ai-spending-schema'))");
        await client.query('CREATE TABLE IF NOT EXISTS pledge_ai_migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
        const applied = await migration(client, false);
        if (!applied) {
          await client.query(SCHEMA);
          await client.query('INSERT INTO pledge_ai_migrations(version,checksum) VALUES($1,$2)', [1, CHECKSUM]);
        }
        await client.query('INSERT INTO pledge_ai_scopes(scope) VALUES($1) ON CONFLICT DO NOTHING', [scope]);
        const row = await scopeRow(client, true);
        for (const provider of PROVIDERS) await client.query('INSERT INTO pledge_ai_accounts(scope,provider,allocation_nanos) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [scope, provider, allocations[provider]]);
        const rows = await accounts(client);
        const exhausted = rows.find((account) => Number(account.used_nanos) >= Number(account.allocation_nanos));
        if (exhausted) await stop(client, row, 'allocation_exhausted', exhausted.provider);
        return { version: 1, applied: !applied };
      });
    },
    async checkSchema() {
      return transaction(async (client) => {
        await migration(client);
        await scopeRow(client);
        await accounts(client);
        return { version: 1, matches: true };
      }, { readOnly: true });
    },
    async reserve({ provider, requestId, maxCostNanos } = {}) {
      providerOf(provider); identifier(requestId); nanos(maxCostNanos, { positive: true });
      return transaction(async (client) => {
        let row = await scopeRow(client, true);
        const rows = await accounts(client);
        const prior = await client.query('SELECT * FROM pledge_ai_requests WHERE scope=$1 AND request_id=$2', [scope, requestId]);
        if (prior.rows[0]) {
          if (prior.rows[0].provider !== provider || Number(prior.rows[0].reservation_nanos) !== maxCostNanos) fail('AI_REQUEST_CONFLICT');
          return { allowed: false, reason: 'request_already_reserved', requestId, stopped: row.stopped };
        }
        if (row.stopped) return { allowed: false, reason: row.stop_reason, stopped: true };
        // Reserved capacity may be released by the active request's verified usage. Busy is not exhausted credit.
        const pending = await client.query("SELECT request_id FROM pledge_ai_requests WHERE scope=$1 AND state='reserved'", [scope]);
        if (pending.rows.length) return { allowed: false, reason: 'request_in_progress', stopped: false };
        const exhausted = rows.find((account) => Number(account.used_nanos) >= Number(account.allocation_nanos));
        const account = rows.find((candidate) => candidate.provider === provider);
        if (exhausted || maxCostNanos > Number(account.allocation_nanos) - Number(account.used_nanos)) {
          row = await stop(client, row, 'allocation_exhausted', exhausted?.provider ?? provider);
          return { allowed: false, reason: row.stop_reason, stopped: true };
        }
        // A lost response or ambiguous COMMIT leaves this durable claim occupied. A new process cannot bypass it.
        await client.query('UPDATE pledge_ai_accounts SET used_nanos=used_nanos+$3 WHERE scope=$1 AND provider=$2', [scope, provider, maxCostNanos]);
        await client.query('INSERT INTO pledge_ai_requests(scope,request_id,provider,reservation_nanos) VALUES($1,$2,$3,$4)', [scope, requestId, provider, maxCostNanos]);
        return { allowed: true, requestId, provider, maxCostNanos };
      });
    },
    async checkDispatch({ provider, requestId, maxCostNanos } = {}) {
      providerOf(provider); identifier(requestId); nanos(maxCostNanos, { positive: true });
      let client;
      try {
        client = await pool.connect();
        // One statement has one authoritative snapshot. The reservation binding and scope stop are
        // immutable once changed, so this needs neither account hydration nor a read transaction.
        const result = await client.query(`SELECT s.stopped,s.stop_reason,s.stop_provider,
          r.request_id,r.provider,r.reservation_nanos,r.state
          FROM pledge_ai_scopes s LEFT JOIN pledge_ai_requests r ON r.scope=s.scope AND r.request_id=$2
          WHERE s.scope=$1`, [scope, requestId]);
        const row = result.rows[0];
        if (!row) fail('AI_NOT_INITIALIZED');
        if (row.stopped) return { allowed: false, stopped: true, reason: row.stop_reason };
        if (!row.request_id) fail('AI_REQUEST_NOT_FOUND');
        if (row.provider !== provider || Number(row.reservation_nanos) !== maxCostNanos) fail('AI_REQUEST_CONFLICT');
        if (row.state !== 'reserved') return { allowed: false, stopped: false, reason: 'request_not_reserved' };
        return { allowed: true, stopped: false, requestId, provider, maxCostNanos };
      } catch (error) {
        if (error instanceof AiBudgetError) throw error;
        throw new AiBudgetError('AI_STORAGE_UNAVAILABLE');
      } finally { client?.release(); }
    },
    async settle({ requestId, costNanos } = {}) {
      identifier(requestId); nanos(costNanos);
      return transaction(async (client) => {
        let row = await scopeRow(client, true);
        const rows = await accounts(client);
        const result = await client.query('SELECT * FROM pledge_ai_requests WHERE scope=$1 AND request_id=$2', [scope, requestId]);
        const request = result.rows[0];
        if (!request) fail('AI_REQUEST_NOT_FOUND');
        if (request.state === 'settled') {
          if (Number(request.cost_nanos) !== costNanos) fail('AI_REQUEST_CONFLICT');
          return { settled: true, requestId, costNanos, stopped: row.stopped };
        }
        const account = rows.find((candidate) => candidate.provider === request.provider);
        const used = Number(account.used_nanos) - Number(request.reservation_nanos) + costNanos;
        nanos(used);
        await client.query("UPDATE pledge_ai_requests SET state='settled',cost_nanos=$3,settled_at=now() WHERE scope=$1 AND request_id=$2", [scope, requestId, costNanos]);
        await client.query('UPDATE pledge_ai_accounts SET used_nanos=$3 WHERE scope=$1 AND provider=$2', [scope, request.provider, used]);
        if (costNanos > Number(request.reservation_nanos)) row = await stop(client, row, 'pricing_mismatch', request.provider);
        else if (used >= Number(account.allocation_nanos)) row = await stop(client, row, 'allocation_exhausted', request.provider);
        return { settled: true, requestId, costNanos, stopped: row.stopped };
      });
    },
    async trip({ reason = 'operator_stop', provider = null } = {}) {
      if (!REASONS.has(reason)) fail('AI_INVALID_INPUT');
      if (provider !== null) providerOf(provider);
      return transaction(async (client) => {
        const row = await scopeRow(client, true);
        await accounts(client);
        return view(client, await stop(client, row, reason, provider));
      });
    },
    async status() { return transaction((client) => view(client), { readOnly: true }); },
  };
}
