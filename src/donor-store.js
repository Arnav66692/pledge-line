import { createHash, randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9-]{1,128}$/;
const AMOUNT = /^(?:0|[1-9]\d{0,6})\.\d{2}$/;
const KINDS = new Set(['create_draft', 'delete_draft', 'suspend', 'activate', 'cancel', 'send_invoice', 'refund_request', 'cover_capture', 'cover_refund', 'cover_unwind']);
const TARGET_READS = new Set(['delete_draft', 'suspend', 'activate', 'cancel', 'send_invoice', 'refund_request', 'cover_refund']);
const CREDENTIAL_KEYS = ['sessionsecret', 'sessionhash', 'sessionsecrethash', 'receiptsecret', 'pin', 'pilotpin', 'clientkey', 'ip', 'ipaddress',
  'token', 'tokens', 'accesstoken', 'refreshtoken', 'apikey', 'anthropicapikey', 'jevapikey', 'typesafeapikey', 'geminiapikey',
  'authorization', 'password', 'clientsecret', 'paypalclientsecret', 'databaseurl', 'connectionstring', 'queue', 'proto', 'prototype', 'constructor'];
const PRIVATE_KEYS = new Set([...CREDENTIAL_KEYS, 'tokenid', 'tokenids']);
const EVENT_PRIVATE_KEYS = new Set(CREDENTIAL_KEYS);
const MAX_CALL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SQL_TIMEOUTS = "SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='5s'";
const LEASE_TIMEOUTS = "SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='3s'; SET LOCAL idle_in_transaction_session_timeout='150s'";
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export class DonorStoreError extends Error {
  constructor(code = 'DONOR_STORE_UNAVAILABLE') { super(code); this.name = 'DonorStoreError'; this.code = code; }
}
const fail = (code) => { throw new DonorStoreError(code); };
function text(value, maximum = 240) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f]/.test(value)) fail('DONOR_INPUT_INVALID');
  return value;
}
function uuid(value) { if (!UUID.test(value ?? '')) fail('DONOR_INPUT_INVALID'); return value; }
function time(value) {
  const result = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isSafeInteger(result) || result < 0) fail('DONOR_INPUT_INVALID');
  return result;
}
function authorityFree(value, forbidden = PRIVATE_KEYS) {
  if (!value || typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.every((item) => authorityFree(item, forbidden));
  return Object.entries(value).every(([key, item]) => !forbidden.has(key.toLowerCase().replace(/[_-]/g, '')) && authorityFree(item, forbidden));
}
function json(value, { maxBytes = 96 * 1024, privateFree = false, nonempty = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('DONOR_INPUT_INVALID');
  let encoded, decoded;
  try {
    encoded = JSON.stringify(value, (_key, item) => {
      if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof item) || item instanceof Promise || (typeof item === 'number' && !Number.isFinite(item))) throw Error();
      return item;
    });
    decoded = JSON.parse(encoded);
  } catch { fail('DONOR_INPUT_INVALID'); }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || Buffer.byteLength(encoded) > maxBytes ||
    (nonempty && Object.keys(decoded).length === 0) || (privateFree && !authorityFree(decoded))) fail('DONOR_INPUT_INVALID');
  return { encoded, decoded };
}
function snapshot(value, id) {
  const parsed = json(value, { privateFree: true });
  if ((parsed.decoded.id != null && parsed.decoded.id !== id) || (parsed.decoded.callId != null && parsed.decoded.callId !== id)) fail('DONOR_INPUT_INVALID');
  return parsed.encoded;
}
function signalValid(signal) { if (signal !== undefined && !(signal instanceof AbortSignal)) fail('DONOR_INPUT_INVALID'); }
function aborted(signal) { if (signal?.aborted) fail('DONOR_LEASE_ABORTED'); }

// This is an independent migration. Existing journal, AI and checkout schemas are unchanged.
const SCHEMA = `
CREATE SEQUENCE pledge_donor_event_seq AS bigint MINVALUE 1 MAXVALUE 9007199254740991;
CREATE FUNCTION pledge_donor_snapshot_safe(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item record; child jsonb;
BEGIN
 IF jsonb_typeof(value)='object' THEN
  FOR item IN SELECT * FROM jsonb_each(value) LOOP
   IF replace(replace(lower(item.key),'_',''),'-','')=ANY(ARRAY['sessionsecret','sessionhash','sessionsecrethash','receiptsecret','pin','pilotpin','clientkey','ip','ipaddress','tokens','token','tokenid','tokenids','accesstoken','refreshtoken','apikey','anthropicapikey','jevapikey','typesafeapikey','geminiapikey','authorization','password','clientsecret','paypalclientsecret','databaseurl','connectionstring','queue','proto','prototype','constructor']) OR NOT pledge_donor_snapshot_safe(item.value) THEN RETURN false; END IF;
  END LOOP;
 ELSIF jsonb_typeof(value)='array' THEN
  FOR child IN SELECT * FROM jsonb_array_elements(value) LOOP
   IF NOT pledge_donor_snapshot_safe(child) THEN RETURN false; END IF;
  END LOOP;
 END IF;
 RETURN true;
END $$;
CREATE FUNCTION pledge_donor_event_safe(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item record; child jsonb;
BEGIN
 IF jsonb_typeof(value)='object' THEN
  FOR item IN SELECT * FROM jsonb_each(value) LOOP
   IF replace(replace(lower(item.key),'_',''),'-','')=ANY(ARRAY['sessionsecret','sessionhash','sessionsecrethash','receiptsecret','pin','pilotpin','clientkey','ip','ipaddress','tokens','token','accesstoken','refreshtoken','apikey','anthropicapikey','jevapikey','typesafeapikey','geminiapikey','authorization','password','clientsecret','paypalclientsecret','databaseurl','connectionstring','queue','proto','prototype','constructor']) OR NOT pledge_donor_event_safe(item.value) THEN RETURN false; END IF;
  END LOOP;
 ELSIF jsonb_typeof(value)='array' THEN
  FOR child IN SELECT * FROM jsonb_array_elements(value) LOOP
   IF NOT pledge_donor_event_safe(child) THEN RETURN false; END IF;
  END LOOP;
 END IF;
 RETURN true;
END $$;
CREATE TABLE pledge_donor_calls (
 organization_id text NOT NULL CHECK(length(organization_id) BETWEEN 1 AND 120), id uuid NOT NULL,
 session_secret_hash text NOT NULL CHECK(session_secret_hash ~ '^[0-9a-f]{64}$'),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=131072 AND pledge_donor_snapshot_safe(snapshot)),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 days'),
 CHECK((snapshot->>'id' IS NULL OR snapshot->>'id'=id::text) AND (snapshot->>'callId' IS NULL OR snapshot->>'callId'=id::text)),
 PRIMARY KEY(organization_id,id)
);
CREATE TABLE pledge_donor_events (
 seq bigint PRIMARY KEY CHECK(seq BETWEEN 1 AND 9007199254740991), organization_id text NOT NULL CHECK(length(organization_id) BETWEEN 1 AND 120),
 call_id uuid, event_ts timestamptz NOT NULL, event jsonb NOT NULL,
 CHECK(jsonb_typeof(event)='object' AND octet_length(event::text)<=32768 AND event ?& ARRAY['seq','ts','type'] AND pledge_donor_event_safe(event)),
 CHECK(event->'seq'=to_jsonb(seq) AND jsonb_typeof(event->'type')='string' AND length(event->>'type') BETWEEN 1 AND 120),
 CHECK((event->>'callId') IS NOT DISTINCT FROM call_id::text),
 CHECK(jsonb_typeof(event->'ts')='string' AND (event->>'ts')::timestamptz=event_ts)
);
CREATE INDEX pledge_donor_events_call ON pledge_donor_events(organization_id,call_id,seq);
CREATE INDEX pledge_donor_events_org ON pledge_donor_events(organization_id,seq);
CREATE TABLE pledge_donor_actions (
 organization_id text NOT NULL, id uuid NOT NULL, operation_key text NOT NULL CHECK(length(operation_key) BETWEEN 1 AND 240),
 resource_key text NOT NULL CHECK(length(resource_key) BETWEEN 1 AND 240), call_id uuid NOT NULL, pending_id uuid,
 kind text NOT NULL CHECK(kind IN ('create_draft','delete_draft','suspend','activate','cancel','send_invoice','refund_request','cover_capture','cover_refund','cover_unwind')),
 target_id text NOT NULL CHECK(length(target_id) BETWEEN 1 AND 200), amount_value text, currency text,
 binding jsonb NOT NULL CHECK(jsonb_typeof(binding)='object' AND octet_length(binding::text)<=131072 AND pledge_donor_snapshot_safe(binding)),
 request_id uuid NOT NULL UNIQUE, state text NOT NULL DEFAULT 'claimed' CHECK(state IN ('claimed','responded','unknown','confirmed','failed')),
 attempt_count integer NOT NULL DEFAULT 1 CHECK(attempt_count=1),
 provider_id text CHECK(provider_id IS NULL OR provider_id ~ '^[A-Za-z0-9-]{1,128}$'),
 result jsonb CHECK(result IS NULL OR (jsonb_typeof(result)='object' AND octet_length(result::text)<=49152 AND pledge_donor_snapshot_safe(result))),
 evidence jsonb CHECK(evidence IS NULL OR (jsonb_typeof(evidence)='object' AND evidence<>'{}'::jsonb AND octet_length(evidence::text)<=49152 AND pledge_donor_snapshot_safe(evidence))),
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 CHECK((amount_value IS NULL AND currency IS NULL) OR (amount_value IS NOT NULL AND currency IS NOT NULL AND amount_value ~ '^(0|[1-9][0-9]{0,6})[.][0-9]{2}$' AND amount_value::numeric>0 AND currency ~ '^[A-Z]{3}$')),
 CHECK(state NOT IN ('confirmed','failed','unknown') OR evidence IS NOT NULL),
 CHECK(state<>'responded' OR result IS NOT NULL),
 CHECK(state<>'confirmed' OR provider_id IS NOT NULL OR kind IN ('delete_draft','suspend','activate','cancel','send_invoice','refund_request','cover_refund') OR (kind='cover_unwind' AND COALESCE(binding->'fields'->>'captureId' ~ '^[A-Za-z0-9-]{1,128}$',false))),
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,operation_key),
 FOREIGN KEY(organization_id,call_id) REFERENCES pledge_donor_calls(organization_id,id)
);
CREATE UNIQUE INDEX pledge_donor_unresolved_resource ON pledge_donor_actions(organization_id,resource_key) WHERE state IN ('claimed','responded','unknown');
CREATE INDEX pledge_donor_recovery ON pledge_donor_actions(organization_id,updated_at) WHERE state IN ('claimed','responded','unknown');
CREATE INDEX pledge_donor_actions_call ON pledge_donor_actions(organization_id,call_id);
CREATE FUNCTION pledge_donor_call_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.organization_id,NEW.id,NEW.session_secret_hash,NEW.created_at) IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.session_secret_hash,OLD.created_at) OR NEW.revision<>OLD.revision+1 THEN
  RAISE EXCEPTION 'Donor call identity or revision is immutable' USING ERRCODE='23000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pledge_donor_call_update BEFORE UPDATE ON pledge_donor_calls FOR EACH ROW EXECUTE FUNCTION pledge_donor_call_guard();
CREATE FUNCTION pledge_donor_action_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'claimed' OR NEW.attempt_count<>1 OR NEW.provider_id IS NOT NULL OR NEW.result IS NOT NULL OR NEW.evidence IS NOT NULL THEN
   RAISE EXCEPTION 'Donor action must begin as one committed claim' USING ERRCODE='23000';
  END IF;
 ELSE
  IF (NEW.organization_id,NEW.id,NEW.operation_key,NEW.resource_key,NEW.call_id,NEW.pending_id,NEW.kind,NEW.target_id,NEW.amount_value,NEW.currency,NEW.binding,NEW.request_id,NEW.attempt_count,NEW.created_at)
   IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.operation_key,OLD.resource_key,OLD.call_id,OLD.pending_id,OLD.kind,OLD.target_id,OLD.amount_value,OLD.currency,OLD.binding,OLD.request_id,OLD.attempt_count,OLD.created_at) THEN
   RAISE EXCEPTION 'Donor action binding is immutable' USING ERRCODE='23000';
  END IF;
  IF OLD.provider_id IS NOT NULL AND NEW.provider_id IS DISTINCT FROM OLD.provider_id THEN RAISE EXCEPTION 'Donor provider identity is immutable' USING ERRCODE='23000'; END IF;
  IF OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result THEN RAISE EXCEPTION 'Donor response is immutable' USING ERRCODE='23000'; END IF;
  IF OLD.state IN ('confirmed','failed') AND (NEW.state,NEW.provider_id,NEW.result,NEW.evidence) IS DISTINCT FROM (OLD.state,OLD.provider_id,OLD.result,OLD.evidence) THEN
   RAISE EXCEPTION 'Terminal donor action cannot be reopened' USING ERRCODE='23000';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
   (OLD.state='claimed' AND NEW.state IN ('responded','unknown','confirmed','failed')) OR
   (OLD.state='responded' AND NEW.state IN ('unknown','confirmed','failed')) OR
   (OLD.state='unknown' AND NEW.state IN ('confirmed','failed'))
  ) THEN RAISE EXCEPTION 'Donor action cannot be replayed' USING ERRCODE='23000'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pledge_donor_action_update BEFORE INSERT OR UPDATE ON pledge_donor_actions FOR EACH ROW EXECUTE FUNCTION pledge_donor_action_guard();
CREATE FUNCTION pledge_donor_deny_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Donor records cannot be deleted' USING ERRCODE='23000'; END $$;
CREATE FUNCTION pledge_donor_deny_audit_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Donor audit events are immutable' USING ERRCODE='23000'; END $$;
CREATE TRIGGER pledge_donor_calls_delete BEFORE DELETE ON pledge_donor_calls FOR EACH ROW EXECUTE FUNCTION pledge_donor_deny_delete();
CREATE TRIGGER pledge_donor_calls_truncate BEFORE TRUNCATE ON pledge_donor_calls FOR EACH STATEMENT EXECUTE FUNCTION pledge_donor_deny_delete();
CREATE TRIGGER pledge_donor_actions_delete BEFORE DELETE ON pledge_donor_actions FOR EACH ROW EXECUTE FUNCTION pledge_donor_deny_delete();
CREATE TRIGGER pledge_donor_actions_truncate BEFORE TRUNCATE ON pledge_donor_actions FOR EACH STATEMENT EXECUTE FUNCTION pledge_donor_deny_delete();
CREATE TRIGGER pledge_donor_events_change BEFORE UPDATE OR DELETE ON pledge_donor_events FOR EACH ROW EXECUTE FUNCTION pledge_donor_deny_audit_change();
CREATE TRIGGER pledge_donor_events_truncate BEFORE TRUNCATE ON pledge_donor_events FOR EACH STATEMENT EXECUTE FUNCTION pledge_donor_deny_audit_change();
CREATE TRIGGER pledge_donor_migration_change BEFORE UPDATE OR DELETE ON pledge_donor_migrations FOR EACH ROW EXECUTE FUNCTION pledge_donor_deny_audit_change();
CREATE TRIGGER pledge_donor_migration_truncate BEFORE TRUNCATE ON pledge_donor_migrations FOR EACH STATEMENT EXECUTE FUNCTION pledge_donor_deny_audit_change();
REVOKE ALL ON pledge_donor_calls,pledge_donor_events,pledge_donor_actions,pledge_donor_migrations FROM PUBLIC;
REVOKE ALL ON SEQUENCE pledge_donor_event_seq FROM PUBLIC;
`;
export const DONOR_SCHEMA_VERSION = 1;
export const DONOR_SCHEMA_CHECKSUM = createHash('sha256').update(SCHEMA).digest('hex');
export const DONOR_RUNTIME_TABLES = Object.freeze(['pledge_donor_calls', 'pledge_donor_events', 'pledge_donor_actions']);
export const DONOR_RUNTIME_SEQUENCES = Object.freeze(['pledge_donor_event_seq']);

function callView(row) {
  return row ? { id: row.id, sessionSecretHash: row.session_secret_hash, snapshot: structuredClone(row.snapshot), revision: Number(row.revision),
    expiresAt: new Date(row.expires_at).toISOString(), createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() } : null;
}
function actionView(row) {
  return row ? { id: row.id, operationKey: row.operation_key, resourceKey: row.resource_key, callId: row.call_id, pendingId: row.pending_id,
    kind: row.kind, targetId: row.target_id, amountValue: row.amount_value, currency: row.currency, binding: structuredClone(row.binding),
    requestId: row.request_id, state: row.state, attemptCount: row.attempt_count, providerId: row.provider_id,
    result: structuredClone(row.result), evidence: structuredClone(row.evidence), createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() } : null;
}
function actionBinding(input) {
  const kind = input?.kind;
  if (!KINDS.has(kind)) fail('DONOR_INPUT_INVALID');
  const targetId = text(input.targetId, 200);
  if (kind !== 'create_draft' && !ID.test(targetId)) fail('DONOR_INPUT_INVALID');
  const amountValue = input.amountValue ?? null, currency = input.currency ?? null;
  if ((amountValue === null) !== (currency === null) || (amountValue !== null && (!AMOUNT.test(amountValue) || Number(amountValue) <= 0 || !/^[A-Z]{3}$/.test(currency)))) fail('DONOR_INPUT_INVALID');
  return { operationKey: text(input.operationKey), resourceKey: text(input.resourceKey), callId: uuid(input.callId),
    pendingId: input.pendingId == null ? null : uuid(input.pendingId), kind, targetId, amountValue, currency,
    binding: json(input.binding, { privateFree: true }).decoded };
}
function existingBinding(row) {
  const { operationKey, resourceKey, callId, pendingId, kind, targetId, amountValue, currency, binding } = actionView(row);
  return { operationKey, resourceKey, callId, pendingId, kind, targetId, amountValue, currency, binding };
}
function knownTarget(row) { return !!row.provider_id || TARGET_READS.has(row.kind) || (row.kind === 'cover_unwind' && ID.test(row.binding?.fields?.captureId ?? '')); }

/** Explicit migrations only. A successful financial claim is returned strictly after COMMIT. */
export function createDonorStore({ pool, organizationId = 'demo-organization', now = () => new Date(), leaseTimeoutMs = 60000 } = {}) {
  if (!pool || typeof pool.connect !== 'function') fail('DONOR_DATABASE_REQUIRED');
  text(organizationId, 120);
  if (typeof now !== 'function' || !Number.isSafeInteger(leaseTimeoutMs) || leaseTimeoutMs < 1 || leaseTimeoutMs > 120000) fail('DONOR_INPUT_INVALID');
  let activeLeases = 0;
  const timestamp = () => new Date(time(now())).toISOString();
  const query = (client, sql, values) => client.query({ text: sql, values, query_timeout: 6000 });
  async function transaction(work, readOnly = false) {
    let client, broken = false;
    const lost = () => { broken = true; };
    try {
      client = await pool.connect(); client.on?.('error', lost);
      await query(client, readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      await query(client, SQL_TIMEOUTS);
      const result = await work(client);
      if (broken) fail('DONOR_STORE_UNAVAILABLE');
      await query(client, 'COMMIT');
      if (broken) fail('DONOR_STORE_UNAVAILABLE');
      return result;
    } catch (error) {
      try { if (client) await query(client, 'ROLLBACK'); } catch { broken = true; }
      if (error instanceof DonorStoreError) throw error;
      fail('DONOR_STORE_UNAVAILABLE');
    } finally { client?.off?.('error', lost); client?.release(broken || undefined); }
  }
  async function actionById(client, id) {
    const row = (await query(client, 'SELECT * FROM pledge_donor_actions WHERE organization_id=$1 AND id=$2 FOR UPDATE', [organizationId, id])).rows[0];
    if (!row) fail('DONOR_ACTION_NOT_FOUND');
    return row;
  }
  async function updateAction(client, row, { state = row.state, providerId = row.provider_id, result = row.result, evidence = row.evidence } = {}) {
    const updated = await query(client, 'UPDATE pledge_donor_actions SET state=$3,provider_id=$4,result=$5::jsonb,evidence=$6::jsonb,updated_at=$7 WHERE organization_id=$1 AND id=$2 RETURNING *',
      [organizationId, row.id, state, providerId, result === null ? null : JSON.stringify(result), evidence === null ? null : JSON.stringify(evidence), timestamp()]);
    return actionView(updated.rows[0]);
  }
  return {
    async migrate() {
      return transaction(async (client) => {
        await query(client, 'SELECT pg_advisory_xact_lock(1934966301::bigint)');
        await query(client, 'CREATE TABLE IF NOT EXISTS pledge_donor_migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
        const history = (await query(client, 'SELECT version,checksum FROM pledge_donor_migrations ORDER BY version FOR UPDATE')).rows;
        if (history.length > 1 || (history.length === 1 && (history[0].version !== 1 || history[0].checksum !== DONOR_SCHEMA_CHECKSUM))) fail('DONOR_SCHEMA_MISMATCH');
        if (history.length === 0) {
          await query(client, SCHEMA);
          await query(client, 'INSERT INTO pledge_donor_migrations(version,checksum) VALUES($1,$2)', [1, DONOR_SCHEMA_CHECKSUM]);
        }
        return { version: 1, applied: history.length === 0 };
      });
    },
    async checkSchema() {
      return transaction(async (client) => {
        const rows = (await query(client, 'SELECT version,checksum FROM pledge_donor_migrations ORDER BY version')).rows;
        if (rows.length !== 1 || rows[0].version !== 1 || rows[0].checksum !== DONOR_SCHEMA_CHECKSUM) fail('DONOR_SCHEMA_MISMATCH');
        return { version: 1, matches: true };
      }, true);
    },
    async reserveEventSequences({ count } = {}) {
      if (!Number.isSafeInteger(count) || count < 1 || count > 1024) fail('DONOR_INPUT_INVALID');
      return transaction(async (client) => {
        const rows = (await query(client, "SELECT nextval('pledge_donor_event_seq') AS seq FROM generate_series(1,$1)", [count])).rows;
        const values = rows.map((row) => Number(row.seq)).sort((a, b) => a - b);
        if (values.length !== count || new Set(values).size !== count || values.some((value) => !Number.isSafeInteger(value) || value < 1)) fail('DONOR_STORE_UNAVAILABLE');
        return values;
      });
    },
    async appendEvents({ events } = {}) {
      if (!Array.isArray(events) || events.length > 1024) fail('DONOR_INPUT_INVALID');
      if (events.length === 0) return 0;
      const normalized = events.map((event) => {
        const value = json(event, { maxBytes: 24 * 1024 }).decoded;
        if (!authorityFree(value, EVENT_PRIVATE_KEYS)) fail('DONOR_INPUT_INVALID');
        if (!Number.isSafeInteger(value.seq) || value.seq < 1 || new Date(time(value.ts)).toISOString() !== value.ts) fail('DONOR_INPUT_INVALID');
        text(value.type, 120); if (value.callId != null) uuid(value.callId);
        return value;
      }).sort((a, b) => a.seq - b.seq);
      if (new Set(normalized.map((event) => event.seq)).size !== normalized.length || Buffer.byteLength(JSON.stringify(normalized)) > 4 * 1024 * 1024) fail('DONOR_INPUT_INVALID');
      const encoded = JSON.stringify(normalized);
      return transaction(async (client) => {
        await query(client, `INSERT INTO pledge_donor_events(seq,organization_id,call_id,event_ts,event)
          SELECT (item.value->>'seq')::bigint,$1,(item.value->>'callId')::uuid,(item.value->>'ts')::timestamptz,item.value
          FROM jsonb_array_elements($2::jsonb) AS item(value) ON CONFLICT(seq) DO NOTHING`, [organizationId, encoded]);
        const checked = (await query(client, `SELECT incoming.seq,e.organization_id=$1 AND e.event=incoming.event AS matches
          FROM (SELECT (item.value->>'seq')::bigint AS seq,item.value AS event FROM jsonb_array_elements($2::jsonb) AS item(value)) AS incoming
          LEFT JOIN pledge_donor_events e ON e.seq=incoming.seq`, [organizationId, encoded])).rows;
        if (checked.length !== normalized.length || checked.some((row) => row.matches !== true)) fail('DONOR_EVENT_CONFLICT');
        return normalized.length;
      });
    },
    async listEvents({ callId = null, afterSeq = 0, limit = 10000 } = {}) {
      if (callId !== null) uuid(callId);
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000) fail('DONOR_INPUT_INVALID');
      return transaction(async (client) => (await query(client, 'SELECT event FROM pledge_donor_events WHERE organization_id=$1 AND seq>$2 AND ($3::uuid IS NULL OR call_id=$3::uuid) ORDER BY seq LIMIT $4', [organizationId, afterSeq, callId, limit])).rows.map((row) => structuredClone(row.event)), true);
    },
    async createCall({ id, sessionSecretHash, snapshot: value, expiresAt } = {}) {
      uuid(id); if (!HASH.test(sessionSecretHash ?? '')) fail('DONOR_INPUT_INVALID');
      const encoded = snapshot(value, id), createdAt = timestamp(), expiry = time(expiresAt);
      if (expiry <= time(createdAt) || expiry - time(createdAt) > MAX_CALL_TTL_MS) fail('DONOR_INPUT_INVALID');
      return transaction(async (client) => {
        const rows = (await query(client, 'INSERT INTO pledge_donor_calls(organization_id,id,session_secret_hash,snapshot,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4::jsonb,$5,$6,$6) RETURNING *',
          [organizationId, id, sessionSecretHash, encoded, new Date(expiry).toISOString(), createdAt])).rows;
        return callView(rows[0]);
      });
    },
    async loadCall({ id } = {}) {
      uuid(id);
      return transaction(async (client) => callView((await query(client, 'SELECT * FROM pledge_donor_calls WHERE organization_id=$1 AND id=$2', [organizationId, id])).rows[0]), true);
    },
    async listSweepCalls({ activeBefore, expiryBefore, limit = 30 } = {}) {
      const idle = time(activeBefore), expiry = time(expiryBefore);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('DONOR_INPUT_INVALID');
      return transaction(async (client) => (await query(client, `SELECT id FROM pledge_donor_calls WHERE organization_id=$1
        AND snapshot->>'ended'='false'
        AND ((CASE WHEN jsonb_typeof(snapshot->'lastActiveAt')='number' THEN (snapshot->>'lastActiveAt')::numeric END)<=$2
          OR (CASE WHEN jsonb_typeof(snapshot->'pending'->'expiresAt')='number' THEN (snapshot->'pending'->>'expiresAt')::numeric END)<=$3)
        ORDER BY updated_at,id LIMIT $4`, [organizationId, idle, expiry, limit])).rows.map((row) => row.id), true);
    },
    async saveCall({ id, snapshot: value, expectedRevision, expiresAt } = {}) {
      uuid(id); const encoded = snapshot(value, id);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('DONOR_INPUT_INVALID');
      const expiry = expiresAt === undefined ? undefined : new Date(time(expiresAt)).toISOString();
      return transaction(async (client) => {
        const existing = (await query(client, 'SELECT * FROM pledge_donor_calls WHERE organization_id=$1 AND id=$2 FOR UPDATE', [organizationId, id])).rows[0];
        if (!existing) fail('DONOR_CALL_NOT_FOUND');
        if (Number(existing.revision) !== expectedRevision) fail('DONOR_REVISION_CONFLICT');
        const end = expiry ?? new Date(existing.expires_at).toISOString();
        if (time(end) <= time(existing.created_at) || time(end) - time(existing.created_at) > MAX_CALL_TTL_MS) fail('DONOR_INPUT_INVALID');
        const rows = (await query(client, 'UPDATE pledge_donor_calls SET snapshot=$4::jsonb,revision=revision+1,expires_at=$5,updated_at=$6 WHERE organization_id=$1 AND id=$2 AND revision=$3 RETURNING *',
          [organizationId, id, expectedRevision, encoded, end, timestamp()])).rows;
        if (!rows[0]) fail('DONOR_REVISION_CONFLICT');
        return callView(rows[0]);
      });
    },
    async claimAction(input) {
      const binding = actionBinding(input);
      return transaction(async (client) => {
        const lock = createHash('sha256').update(`donor-resource:${organizationId}:${binding.resourceKey}`).digest().readBigInt64BE().toString();
        await query(client, 'SELECT pg_advisory_xact_lock($1::bigint)', [lock]);
        const existing = (await query(client, 'SELECT * FROM pledge_donor_actions WHERE organization_id=$1 AND operation_key=$2 FOR UPDATE', [organizationId, binding.operationKey])).rows[0];
        if (existing) {
          if (!same(existingBinding(existing), binding)) fail('DONOR_ACTION_CONFLICT');
          return { claimed: false, action: actionView(existing) };
        }
        const busy = (await query(client, "SELECT * FROM pledge_donor_actions WHERE organization_id=$1 AND resource_key=$2 AND state IN ('claimed','responded','unknown') LIMIT 1 FOR UPDATE", [organizationId, binding.resourceKey])).rows[0];
        if (busy) return { claimed: false, blocked: true, action: actionView(busy) };
        const rows = (await query(client, `INSERT INTO pledge_donor_actions(organization_id,id,operation_key,resource_key,call_id,pending_id,kind,target_id,amount_value,currency,binding,request_id,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$13) RETURNING *`,
        [organizationId, randomUUID(), binding.operationKey, binding.resourceKey, binding.callId, binding.pendingId, binding.kind, binding.targetId, binding.amountValue, binding.currency, JSON.stringify(binding.binding), randomUUID(), timestamp()])).rows;
        return { claimed: true, action: actionView(rows[0]) };
      });
    },
    async getAction({ operationKey } = {}) {
      text(operationKey);
      return transaction(async (client) => actionView((await query(client, 'SELECT * FROM pledge_donor_actions WHERE organization_id=$1 AND operation_key=$2', [organizationId, operationKey])).rows[0]), true);
    },
    async recordActionResponse({ id, providerId = null, result } = {}) {
      uuid(id); if (providerId !== null && !ID.test(providerId)) fail('DONOR_INPUT_INVALID');
      const normalized = json(result, { maxBytes: 32 * 1024, privateFree: true }).decoded;
      return transaction(async (client) => {
        const row = await actionById(client, id);
        if ((row.provider_id && providerId && row.provider_id !== providerId) || (row.result !== null && !same(row.result, normalized))) fail('DONOR_ACTION_CONFLICT');
        const resolvedId = providerId ?? row.provider_id;
        if (['confirmed', 'failed'].includes(row.state)) {
          if (resolvedId !== row.provider_id || row.result === null) fail('DONOR_ACTION_CONFLICT');
          return actionView(row);
        }
        return updateAction(client, row, { state: row.state === 'claimed' ? 'responded' : row.state, providerId: resolvedId, result: normalized });
      });
    },
    async recordActionOutcome({ id, state, evidence } = {}) {
      uuid(id); if (!['confirmed', 'failed', 'unknown'].includes(state)) fail('DONOR_INPUT_INVALID');
      const normalized = json(evidence, { maxBytes: 32 * 1024, nonempty: true, privateFree: true }).decoded;
      return transaction(async (client) => {
        const row = await actionById(client, id);
        if (['confirmed', 'failed'].includes(row.state)) {
          if (state !== row.state || !same(row.evidence, normalized)) fail('DONOR_ACTION_CONFLICT');
          return actionView(row);
        }
        if (state === 'confirmed' && !knownTarget(row)) fail('DONOR_ACTION_CONFLICT');
        return updateAction(client, row, { state, evidence: normalized });
      });
    },
    async listRecoverableActions({ limit = 30, callId = null, after = null } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('DONOR_INPUT_INVALID');
      if (callId !== null) uuid(callId);
      if (after !== null) { uuid(after.id); time(after.updatedAt); }
      return transaction(async (client) => (await query(client, `SELECT * FROM pledge_donor_actions WHERE organization_id=$1
        AND state IN ('claimed','responded','unknown') AND (provider_id IS NOT NULL OR kind IN ('delete_draft','suspend','activate','cancel','send_invoice','refund_request','cover_refund')
        OR (kind='cover_unwind' AND binding->'fields'->>'captureId' ~ '^[A-Za-z0-9-]{1,128}$'))
        AND ($3::uuid IS NULL OR call_id=$3::uuid) AND ($4::timestamptz IS NULL OR (updated_at,id)>($4::timestamptz,$5::uuid))
        ORDER BY updated_at,id LIMIT $2`, [organizationId, limit, callId, after === null ? null : new Date(time(after.updatedAt)).toISOString(), after?.id ?? null])).rows.map(actionView), true);
    },
    async withCallLease({ id, signal } = {}, work) {
      uuid(id); signalValid(signal); if (typeof work !== 'function') fail('DONOR_INPUT_INVALID');
      aborted(signal); if (activeLeases >= 2) return { acquired: false };
      activeLeases += 1;
      let client, broken = false;
      const deadline = new AbortController();
      const leaseSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
      const timer = setTimeout(() => deadline.abort(), leaseTimeoutMs);
      const lost = () => { broken = true; deadline.abort(); };
      const leaseQuery = async (sql, values) => {
        aborted(leaseSignal);
        const result = await client.query({ text: sql, values, query_timeout: 3500 });
        aborted(leaseSignal); return result;
      };
      try {
        client = await pool.connect(); client.on?.('error', lost);
        await leaseQuery('BEGIN'); await leaseQuery(LEASE_TIMEOUTS);
        const key = createHash('sha256').update(`donor-call:${organizationId}:${id}`).digest().readBigInt64BE().toString();
        const rows = (await leaseQuery('SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired', [key])).rows;
        if (rows[0]?.acquired !== true) { await leaseQuery('ROLLBACK'); return { acquired: false }; }
        const value = await work(leaseSignal);
        aborted(leaseSignal); await leaseQuery('COMMIT');
        return { acquired: true, value };
      } catch (error) {
        try { if (client) await client.query({ text: 'ROLLBACK', query_timeout: 3500 }); } catch { broken = true; }
        if (leaseSignal.aborted) fail('DONOR_LEASE_ABORTED');
        if (error instanceof DonorStoreError) throw error;
        fail('DONOR_STORE_UNAVAILABLE');
      } finally { clearTimeout(timer); client?.off?.('error', lost); client?.release(broken || undefined); activeLeases -= 1; }
    },
  };
}
