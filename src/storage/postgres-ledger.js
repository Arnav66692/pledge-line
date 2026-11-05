// Async financial journal. No call returns permission to move money until its transaction commits.
// This deliberately does not mimic the synchronous JSONL ledger or silently fall back to memory.
import { createHash, randomUUID } from 'node:crypto';

export class PostgresStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PostgresStoreError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new PostgresStoreError(code, message); };
const text = (value, label, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) fail('INVALID_INPUT', `${label} must be a nonempty bounded string`);
  return value;
};
const json = (value, label, { nonempty = false } = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', `${label} must be a JSON object`);
  let encoded;
  try { encoded = JSON.stringify(value, (_key, item) => {
    if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof item) || (typeof item === 'number' && !Number.isFinite(item))) throw Error('Not JSON');
    return item;
  }); } catch { fail('INVALID_INPUT', `${label} must be serializable`); }
  if (!encoded || Buffer.byteLength(encoded) > 64 * 1024) fail('INVALID_INPUT', `${label} is too large`);
  const decoded = JSON.parse(encoded);
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) fail('INVALID_INPUT', `${label} must serialize to a JSON object`);
  if (nonempty && !Object.keys(decoded).length) fail('INVALID_INPUT', `${label} must contain provider evidence`);
  return encoded;
};
function scope(input) {
  return [text(input?.organizationId, 'organizationId'), text(input?.operationKey, 'operationKey')];
}
function legsOf(legs) {
  if (!Array.isArray(legs) || !legs.length || legs.length > 10) fail('INVALID_INPUT', 'legs must contain one to ten approved steps');
  const normalized = legs.map((leg) => {
    const kind = text(leg?.kind, 'leg kind', 80);
    const targetId = text(leg?.targetId, 'targetId');
    if (!Number.isSafeInteger(leg?.amountCents) || leg.amountCents <= 0) fail('INVALID_INPUT', 'amountCents must be a whole positive integer');
    if (!/^[A-Z]{3}$/.test(leg?.currency ?? '')) fail('INVALID_INPUT', 'currency must be three uppercase letters');
    if (leg.quantity != null && (!Number.isInteger(leg.quantity) || leg.quantity < 1 || leg.quantity > 1000000000)) fail('INVALID_INPUT', 'quantity must be a positive bounded integer');
    return { kind, targetId, amountCents: leg.amountCents, currency: leg.currency, quantity: leg.quantity ?? null, dependsOn: leg.dependsOn == null ? null : text(leg.dependsOn, 'dependency', 80) };
  }).sort((a, b) => a.kind.localeCompare(b.kind));
  const names = new Set(normalized.map((leg) => leg.kind));
  if (names.size !== normalized.length) fail('INVALID_INPUT', 'leg kinds must be unique');
  for (const leg of normalized) {
    const visited = new Set([leg.kind]);
    let dependency = leg.dependsOn;
    while (dependency) {
      if (!names.has(dependency) || visited.has(dependency)) fail('INVALID_INPUT', 'leg dependency must exist and cannot form a cycle');
      visited.add(dependency);
      dependency = normalized.find((candidate) => candidate.kind === dependency).dependsOn;
    }
  }
  return normalized;
}

const SCHEMA = `
CREATE TABLE pledge_operations (
 id uuid PRIMARY KEY, organization_id text NOT NULL, operation_key text NOT NULL,
 consent_binding jsonb NOT NULL, state text NOT NULL DEFAULT 'reserved'
 CHECK (state IN ('reserved','in_flight','unknown','confirmed','failed','partial')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (organization_id, operation_key)
);
CREATE TABLE pledge_operation_legs (
 operation_id uuid NOT NULL REFERENCES pledge_operations(id), kind text NOT NULL, target_id text NOT NULL,
 amount_cents bigint NOT NULL CHECK (amount_cents > 0), quantity integer CHECK (quantity > 0), currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 depends_on text, request_id uuid NOT NULL UNIQUE,
 state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','in_flight','unknown','confirmed','failed')),
 attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1),
 provider_id text, evidence jsonb CHECK (evidence IS NULL OR (jsonb_typeof(evidence)='object' AND evidence <> '{}'::jsonb)),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (state <> 'confirmed' OR (provider_id IS NOT NULL AND btrim(provider_id) <> '' AND evidence IS NOT NULL)),
 PRIMARY KEY (operation_id, kind),
 FOREIGN KEY (operation_id, depends_on) REFERENCES pledge_operation_legs(operation_id, kind) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE pledge_webhook_inbox (
 organization_id text NOT NULL, provider text NOT NULL, event_id text NOT NULL,
 body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
 raw_body bytea NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 processed_at timestamptz, PRIMARY KEY (organization_id, provider, event_id)
);
CREATE TABLE pledge_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, organization_id text NOT NULL,
 operation_key text, event_type text NOT NULL, event jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pledge_events_org_operation ON pledge_events (organization_id, operation_key, id);
CREATE INDEX pledge_operations_unresolved ON pledge_operations (organization_id, updated_at) WHERE state IN ('in_flight','unknown');
CREATE FUNCTION pledge_protect_operation_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id, NEW.organization_id, NEW.operation_key, NEW.consent_binding)
 IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.operation_key, OLD.consent_binding) THEN
 RAISE EXCEPTION 'approved binding is immutable' USING ERRCODE='23000';
 END IF;
 IF OLD.state IN ('confirmed','failed','partial') AND NEW.state IS DISTINCT FROM OLD.state THEN
 RAISE EXCEPTION 'terminal operation cannot be reopened' USING ERRCODE='23000';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER pledge_immutable_operation BEFORE UPDATE ON pledge_operations FOR EACH ROW EXECUTE FUNCTION pledge_protect_operation_binding();
CREATE FUNCTION pledge_validate_leg_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approved_legs jsonb;
BEGIN
 IF NEW.state <> 'reserved' OR NEW.attempt_count <> 0 OR NEW.provider_id IS NOT NULL OR NEW.evidence IS NOT NULL THEN
 RAISE EXCEPTION 'new leg must begin reserved without an attempt or outcome' USING ERRCODE='23000';
 END IF;
 SELECT consent_binding -> 'legs' INTO approved_legs FROM pledge_operations WHERE id=NEW.operation_id;
 IF approved_legs IS NULL OR jsonb_typeof(approved_legs) <> 'array' THEN
 RAISE EXCEPTION 'operation has no approved leg binding' USING ERRCODE='23000';
 END IF;
 IF NOT EXISTS (
 SELECT 1 FROM jsonb_array_elements(approved_legs) AS approved(leg)
 WHERE approved.leg = jsonb_build_object('kind',NEW.kind,'targetId',NEW.target_id,
 'amountCents',NEW.amount_cents,'quantity',NEW.quantity,'currency',NEW.currency,'dependsOn',NEW.depends_on)
 ) THEN
 RAISE EXCEPTION 'leg does not match approved binding' USING ERRCODE='23000';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER pledge_approved_leg_insert BEFORE INSERT ON pledge_operation_legs FOR EACH ROW EXECUTE FUNCTION pledge_validate_leg_insert();
CREATE FUNCTION pledge_protect_leg_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.operation_id,NEW.kind,NEW.target_id,NEW.amount_cents,NEW.quantity,NEW.currency,NEW.depends_on,NEW.request_id)
 IS DISTINCT FROM (OLD.operation_id,OLD.kind,OLD.target_id,OLD.amount_cents,OLD.quantity,OLD.currency,OLD.depends_on,OLD.request_id) THEN
 RAISE EXCEPTION 'approved leg binding is immutable' USING ERRCODE='23000';
 END IF;
 IF NEW.attempt_count < OLD.attempt_count OR (NEW.attempt_count IS DISTINCT FROM OLD.attempt_count AND NOT (OLD.state='reserved' AND NEW.state='in_flight' AND NEW.attempt_count=1)) THEN
 RAISE EXCEPTION 'attempt cannot be reset' USING ERRCODE='23000';
 END IF;
 IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
 (OLD.state='reserved' AND NEW.state='in_flight') OR
 (OLD.state='in_flight' AND NEW.state IN ('unknown','confirmed','failed')) OR
 (OLD.state='unknown' AND NEW.state IN ('confirmed','failed'))
 ) THEN
 RAISE EXCEPTION 'illegal leg state transition' USING ERRCODE='23000';
 END IF;
 IF OLD.state IN ('confirmed','failed') AND NEW.state IS DISTINCT FROM OLD.state THEN
 RAISE EXCEPTION 'terminal leg cannot be reopened' USING ERRCODE='23000';
 END IF;
 IF OLD.state IN ('in_flight','unknown') AND NEW.state='reserved' THEN
 RAISE EXCEPTION 'uncertain leg cannot be replayed' USING ERRCODE='23000';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER pledge_immutable_leg BEFORE UPDATE ON pledge_operation_legs FOR EACH ROW EXECUTE FUNCTION pledge_protect_leg_binding();
CREATE FUNCTION pledge_deny_journal_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'journal records cannot be deleted or truncated' USING ERRCODE='23000';
END; $$;
CREATE TRIGGER pledge_no_delete_operation BEFORE DELETE OR TRUNCATE ON pledge_operations FOR EACH STATEMENT EXECUTE FUNCTION pledge_deny_journal_delete();
CREATE TRIGGER pledge_no_delete_leg BEFORE DELETE OR TRUNCATE ON pledge_operation_legs FOR EACH STATEMENT EXECUTE FUNCTION pledge_deny_journal_delete();
CREATE TRIGGER pledge_no_delete_webhook BEFORE DELETE OR TRUNCATE ON pledge_webhook_inbox FOR EACH STATEMENT EXECUTE FUNCTION pledge_deny_journal_delete();
CREATE TRIGGER pledge_no_delete_event BEFORE DELETE OR TRUNCATE ON pledge_events FOR EACH STATEMENT EXECUTE FUNCTION pledge_deny_journal_delete();
CREATE TRIGGER pledge_no_delete_migration BEFORE DELETE OR TRUNCATE ON pledge_store_migrations FOR EACH STATEMENT EXECUTE FUNCTION pledge_deny_journal_delete();
REVOKE ALL ON pledge_operations, pledge_operation_legs, pledge_webhook_inbox, pledge_events FROM PUBLIC;
`;
const SCHEMA_HASH = createHash('sha256').update(SCHEMA).digest('hex');
// Version 1 is already deployed: never edit its SQL or checksum. Add reviewed upgrades here.
const OUTCOME_GUARDS_V2 = `
ALTER TABLE pledge_operation_legs ADD CONSTRAINT pledge_leg_state_attempt_consistency CHECK (
 (state='reserved' AND attempt_count=0 AND provider_id IS NULL AND evidence IS NULL)
 OR (state IN ('in_flight','unknown','confirmed','failed') AND attempt_count=1)
);
CREATE OR REPLACE FUNCTION pledge_protect_leg_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.operation_id,NEW.kind,NEW.target_id,NEW.amount_cents,NEW.quantity,NEW.currency,NEW.depends_on,NEW.request_id)
 IS DISTINCT FROM (OLD.operation_id,OLD.kind,OLD.target_id,OLD.amount_cents,OLD.quantity,OLD.currency,OLD.depends_on,OLD.request_id) THEN
 RAISE EXCEPTION 'approved leg binding is immutable' USING ERRCODE='23000';
 END IF;
 IF OLD.state IN ('confirmed','failed') AND (NEW.state,NEW.provider_id,NEW.evidence)
 IS DISTINCT FROM (OLD.state,OLD.provider_id,OLD.evidence) THEN
 RAISE EXCEPTION 'terminal leg outcome is immutable' USING ERRCODE='23000';
 END IF;
 IF NEW.attempt_count < OLD.attempt_count OR (NEW.attempt_count IS DISTINCT FROM OLD.attempt_count AND NOT (OLD.state='reserved' AND NEW.state='in_flight' AND NEW.attempt_count=1)) THEN
 RAISE EXCEPTION 'attempt cannot be reset' USING ERRCODE='23000';
 END IF;
 IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
 (OLD.state='reserved' AND NEW.state='in_flight') OR
 (OLD.state='in_flight' AND NEW.state IN ('unknown','confirmed','failed')) OR
 (OLD.state='unknown' AND NEW.state IN ('confirmed','failed'))
 ) THEN
 RAISE EXCEPTION 'illegal leg state transition' USING ERRCODE='23000';
 END IF;
 RETURN NEW;
END; $$;
`;
const MIGRATIONS = [
  { version: 1, sql: SCHEMA, checksum: SCHEMA_HASH },
  { version: 2, sql: OUTCOME_GUARDS_V2, checksum: createHash('sha256').update(OUTCOME_GUARDS_V2).digest('hex') },
];
const LATEST_VERSION = MIGRATIONS.at(-1).version;
function validMigrationPrefix(rows) {
  return rows.length <= MIGRATIONS.length && rows.every((row, index) =>
    row.version === MIGRATIONS[index].version && row.checksum === MIGRATIONS[index].checksum);
}

function legView(leg) {
  return { kind: leg.kind, targetId: leg.target_id, amountCents: Number(leg.amount_cents), quantity: leg.quantity ?? null, currency: leg.currency,
    dependsOn: leg.depends_on, requestId: leg.request_id, state: leg.state, attemptCount: leg.attempt_count,
    providerId: leg.provider_id, evidence: leg.evidence };
}
async function operationView(client, operation) {
  if (!operation) return null;
  const result = await client.query('SELECT * FROM pledge_operation_legs WHERE operation_id = $1 ORDER BY kind', [operation.id]);
  return { id: operation.id, organizationId: operation.organization_id, operationKey: operation.operation_key,
    consent: operation.consent_binding.consent, state: operation.state, legs: result.rows.map(legView),
    createdAt: operation.created_at, updatedAt: operation.updated_at };
}

export function createPostgresStore({ pool }) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('createPostgresStore requires a pool with connect()');
  async function transaction(work, { readOnly = false } = {}) {
    let client;
    try {
      client = await pool.connect();
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '15s'");
      const result = await work(client);
      // A failed/ambiguous COMMIT never returns a successful reservation or claim.
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) { try { await client.query('ROLLBACK'); } catch { /* Preserve the failure; no success is returned. */ } }
      if (error instanceof PostgresStoreError) throw error;
      throw new PostgresStoreError('STORE_UNAVAILABLE', 'Database operation did not complete clearly. Reconcile before any payment retry.');
    } finally { client?.release(); }
  }
  async function migrate() {
    return transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(1732050807::bigint)');
      await client.query('CREATE TABLE IF NOT EXISTS pledge_store_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
      const existing = await client.query('SELECT version, checksum FROM pledge_store_migrations ORDER BY version FOR UPDATE');
      if (!validMigrationPrefix(existing.rows)) fail('SCHEMA_MISMATCH', 'Database schema requires an explicit reviewed migration.');
      for (const migration of MIGRATIONS.slice(existing.rows.length)) {
        await client.query(migration.sql);
        await client.query('INSERT INTO pledge_store_migrations (version, checksum) VALUES ($1, $2)', [migration.version, migration.checksum]);
      }
      return { version: LATEST_VERSION, applied: existing.rows.length < MIGRATIONS.length };
    });
  }
  async function checkSchema() {
    return transaction(async (client) => {
      let existing;
      try {
        existing = await client.query('SELECT version, checksum FROM pledge_store_migrations ORDER BY version');
      } catch (error) {
        if (error?.code === '42P01') fail('SCHEMA_MISMATCH', 'Database migration has not been applied.');
        throw error;
      }
      if (existing.rows.length !== MIGRATIONS.length || !validMigrationPrefix(existing.rows)) fail('SCHEMA_MISMATCH', 'Database schema does not match this application version.');
      return { version: LATEST_VERSION, matches: true };
    }, { readOnly: true });
  }
  async function reserveOperation(input) {
    const [org, key] = scope(input);
    const consent = JSON.parse(json(input.consent, 'consent'));
    const legs = legsOf(input.legs);
    const binding = JSON.stringify({ consent, legs });
    return transaction(async (client) => {
      await client.query('INSERT INTO pledge_operations (id, organization_id, operation_key, consent_binding) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (organization_id, operation_key) DO NOTHING', [randomUUID(), org, key, binding]);
      const found = await client.query('SELECT *, consent_binding = $3::jsonb AS matches FROM pledge_operations WHERE organization_id=$1 AND operation_key=$2 FOR UPDATE', [org, key, binding]);
      const op = found.rows[0];
      if (!op || !op.matches) fail('BINDING_CONFLICT', 'This operation key is already bound to different consent or payment terms.');
      for (const leg of legs) {
        await client.query('INSERT INTO pledge_operation_legs (operation_id,kind,target_id,amount_cents,quantity,currency,depends_on,request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (operation_id,kind) DO NOTHING', [op.id, leg.kind, leg.targetId, leg.amountCents, leg.quantity, leg.currency, leg.dependsOn, randomUUID()]);
      }
      return operationView(client, op);
    });
  }
  async function getOperation(input) {
    const [org, key] = scope(input);
    return transaction(async (client) => {
      const result = await client.query('SELECT * FROM pledge_operations WHERE organization_id=$1 AND operation_key=$2', [org, key]);
      return operationView(client, result.rows[0]);
    }, { readOnly: true });
  }
  async function claimLeg(input) {
    const [org, key] = scope(input);
    const kind = text(input.kind, 'kind', 80);
    return transaction(async (client) => {
      const parent = await client.query('SELECT id, state FROM pledge_operations WHERE organization_id=$1 AND operation_key=$2 FOR UPDATE', [org, key]);
      const op = parent.rows[0];
      if (!op) return { claimed: false, reason: 'not_found' };
      if (!['reserved', 'in_flight'].includes(op.state)) return { claimed: false, reason: op.state };
      const active = await client.query("SELECT kind FROM pledge_operation_legs WHERE operation_id=$1 AND state IN ('in_flight','unknown') LIMIT 1", [op.id]);
      if (active.rows.length) return { claimed: false, reason: 'prior_attempt_unconfirmed' };
      const found = await client.query('SELECT * FROM pledge_operation_legs WHERE operation_id=$1 AND kind=$2 FOR UPDATE', [op.id, kind]);
      const leg = found.rows[0];
      if (!leg || leg.state !== 'reserved' || leg.attempt_count !== 0) return { claimed: false, reason: leg?.state ?? 'not_found' };
      if (leg.depends_on) {
        const prior = await client.query('SELECT state FROM pledge_operation_legs WHERE operation_id=$1 AND kind=$2', [op.id, leg.depends_on]);
        if (prior.rows[0]?.state !== 'confirmed') return { claimed: false, reason: 'dependency_unconfirmed' };
      }
      const result = await client.query("UPDATE pledge_operation_legs SET state='in_flight',attempt_count=1,updated_at=now() WHERE operation_id=$1 AND kind=$2 AND state='reserved' AND attempt_count=0 RETURNING *", [op.id, kind]);
      if (!result.rows.length) return { claimed: false, reason: 'already_claimed' };
      await client.query("UPDATE pledge_operations SET state='in_flight',updated_at=now() WHERE id=$1", [op.id]);
      return { claimed: true, operationId: op.id, ...legView(result.rows[0]) };
    });
  }
  async function recordLegOutcome(input) {
    const [org, key] = scope(input);
    const kind = text(input.kind, 'kind', 80);
    if (!['confirmed', 'failed', 'unknown'].includes(input.state)) fail('INVALID_INPUT', 'outcome must be confirmed, failed or unknown');
    const evidence = json(input.evidence, 'evidence', { nonempty: true });
    const providerId = input.providerId == null && input.state !== 'confirmed' ? null : text(input.providerId, 'providerId');
    return transaction(async (client) => {
      const parent = await client.query('SELECT * FROM pledge_operations WHERE organization_id=$1 AND operation_key=$2 FOR UPDATE', [org, key]);
      const op = parent.rows[0];
      if (!op) fail('NOT_FOUND', 'Operation not found.');
      const found = await client.query('SELECT * FROM pledge_operation_legs WHERE operation_id=$1 AND kind=$2 FOR UPDATE', [op.id, kind]);
      const leg = found.rows[0];
      if (!leg) fail('NOT_FOUND', 'Operation leg not found.');
      if (['confirmed', 'failed'].includes(leg.state)) {
        if (leg.state !== input.state || leg.provider_id !== providerId) fail('OUTCOME_CONFLICT', 'A confirmed outcome cannot be overwritten.');
        return operationView(client, op);
      }
      if (!['in_flight', 'unknown'].includes(leg.state)) fail('INVALID_TRANSITION', 'A payment leg must be claimed before recording an outcome.');
      await client.query('UPDATE pledge_operation_legs SET state=$3,provider_id=COALESCE($4,provider_id),evidence=$5::jsonb,updated_at=now() WHERE operation_id=$1 AND kind=$2', [op.id, kind, input.state, providerId, evidence]);
      const states = await client.query('SELECT state FROM pledge_operation_legs WHERE operation_id=$1', [op.id]);
      const all = states.rows.map((row) => row.state);
      const state = all.includes('unknown') || all.includes('in_flight') ? 'unknown'
        : all.includes('failed') ? (all.includes('confirmed') ? 'partial' : 'failed')
          : all.every((value) => value === 'confirmed') ? 'confirmed' : 'in_flight';
      await client.query('UPDATE pledge_operations SET state=$2,updated_at=now() WHERE id=$1', [op.id, state]);
      const result = await client.query('SELECT * FROM pledge_operations WHERE id=$1', [op.id]);
      return operationView(client, result.rows[0]);
    });
  }
  async function listUnresolved({ organizationId }) {
    const org = text(organizationId, 'organizationId');
    return transaction(async (client) => {
      const result = await client.query("SELECT * FROM pledge_operations WHERE organization_id=$1 AND state IN ('in_flight','unknown') ORDER BY updated_at LIMIT 100", [org]);
      return Promise.all(result.rows.map((op) => operationView(client, op)));
    }, { readOnly: true });
  }
  async function acceptVerifiedWebhook(input) {
    const org = text(input.organizationId, 'organizationId');
    const provider = text(input.provider, 'provider', 80);
    const eventId = text(input.eventId, 'eventId');
    if (input.verified !== true) fail('INVALID_INPUT', 'A webhook must be signature verified before storage.');
    if (!Buffer.isBuffer(input.rawBody) || !input.rawBody.length || input.rawBody.length > 256 * 1024) fail('INVALID_INPUT', 'rawBody must be a nonempty buffer within the webhook limit');
    const digest = createHash('sha256').update(input.rawBody).digest('hex');
    return transaction(async (client) => {
      const inserted = await client.query('INSERT INTO pledge_webhook_inbox (organization_id,provider,event_id,body_sha256,raw_body) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING event_id', [org, provider, eventId, digest, input.rawBody]);
      const prior = await client.query('SELECT body_sha256 FROM pledge_webhook_inbox WHERE organization_id=$1 AND provider=$2 AND event_id=$3 FOR UPDATE', [org, provider, eventId]);
      if (prior.rows[0]?.body_sha256 !== digest) fail('WEBHOOK_CONFLICT', 'This event identity is already bound to another payload.');
      return { inserted: inserted.rows.length === 1, eventId, digest };
    });
  }
  async function appendEvent(input) {
    const org = text(input.organizationId, 'organizationId');
    const key = input.operationKey == null ? null : text(input.operationKey, 'operationKey');
    const type = text(input.type, 'event type', 80);
    const event = json(input.event, 'event');
    return transaction(async (client) => {
      const result = await client.query('INSERT INTO pledge_events (organization_id,operation_key,event_type,event) VALUES ($1,$2,$3,$4::jsonb) RETURNING id,created_at', [org, key, type, event]);
      return { id: result.rows[0].id, createdAt: result.rows[0].created_at };
    });
  }
  async function listEvents(input) {
    const [org, key] = scope(input);
    return transaction(async (client) => {
      const result = await client.query('SELECT id,event_type,event,created_at FROM pledge_events WHERE organization_id=$1 AND operation_key=$2 ORDER BY id LIMIT 1000', [org, key]);
      return result.rows.map((row) => ({ id: row.id, type: row.event_type, event: row.event, createdAt: row.created_at }));
    }, { readOnly: true });
  }
  return { migrate, checkSchema, reserveOperation, getOperation, claimLeg, recordLegOutcome, listUnresolved, acceptVerifiedWebhook, appendEvent, listEvents };
}
