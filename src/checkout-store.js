import { createHash, randomUUID } from 'node:crypto';
import { sandboxApprovalUrl } from './paypal-orders.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const PAYPAL_ID = /^[A-Z0-9]{8,40}$/;
const clone = (value) => structuredClone(value);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const sameJson = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export class CheckoutStoreError extends Error {
  constructor(code = 'CHECKOUT_STORE_UNAVAILABLE') { super(code); this.name = 'CheckoutStoreError'; this.code = code; }
}
const fail = (code) => { throw new CheckoutStoreError(code); };
const recoveryAbort = (signal) => { if (signal?.aborted) fail('CHECKOUT_RECOVERY_ABORTED'); };
const recoverySignalValid = (signal) => { if (signal !== undefined && !(signal instanceof AbortSignal)) fail('CHECKOUT_INPUT_INVALID'); };
const RECOVERY_TIMEOUTS = "SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='1s'; SET LOCAL idle_in_transaction_session_timeout='15s'";
const recoveryQuery = (client, text, values) => client.query({ text, values, query_timeout: 2500 });

/** Closing revokes this app's authority only. It cannot erase an uncertain or attempted payment. */
export function canCloseUnpaidCheckout(workflow, at) {
  if (!workflow || workflow.blockedReason || !Number.isSafeInteger(at) || at < 0 ||
    !Number.isFinite(Date.parse(workflow.proposal?.expiresAt)) || Date.parse(workflow.proposal.expiresAt) > at ||
    !Array.isArray(workflow.legs) || workflow.legs.length < 1 || workflow.legs.length > 5) return false;
  return workflow.legs.every((leg) => leg.captureState === 'reserved' && leg.captureAttempts === 0 &&
    leg.captureId == null && leg.captureEvidence == null &&
    ((leg.createState === 'reserved' && leg.createAttempts === 0 && leg.orderId == null && leg.approvalUrl == null && leg.createEvidence == null) ||
      (leg.createState === 'ready' && leg.createAttempts === 1 && PAYPAL_ID.test(leg.orderId ?? ''))));
}

const SCHEMA = `
CREATE TABLE pledge_checkout_workflows (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL CHECK (length(organization_id) BETWEEN 1 AND 120),
  binding jsonb NOT NULL CHECK (jsonb_typeof(binding)='object'),
  session_secret_hash text NOT NULL CHECK (session_secret_hash ~ '^[0-9a-f]{64}$'),
  legs jsonb NOT NULL CHECK (jsonb_typeof(legs)='array' AND jsonb_array_length(legs) BETWEEN 1 AND 5),
  blocked_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pledge_checkout_org ON pledge_checkout_workflows (organization_id,id);
CREATE FUNCTION pledge_checkout_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE leg jsonb; previous jsonb; i integer;
BEGIN
  IF TG_OP='DELETE' OR TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'Checkout deletion is not an application operation' USING ERRCODE='23000'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
       NEW.binding IS DISTINCT FROM OLD.binding OR NEW.session_secret_hash IS DISTINCT FROM OLD.session_secret_hash OR
       NEW.created_at IS DISTINCT FROM OLD.created_at OR jsonb_array_length(NEW.legs)<>jsonb_array_length(OLD.legs) OR
       (OLD.blocked_reason IS NOT NULL AND NEW.blocked_reason IS DISTINCT FROM OLD.blocked_reason) THEN
      RAISE EXCEPTION 'Immutable checkout binding changed' USING ERRCODE='23000';
    END IF;
  END IF;
  IF jsonb_typeof(NEW.binding->'proposal'->'allocations') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.legs) IS DISTINCT FROM jsonb_array_length(NEW.binding->'proposal'->'allocations') THEN
    RAISE EXCEPTION 'Checkout legs differ from the approved allocation' USING ERRCODE='23000';
  END IF;
  FOR i IN 0..jsonb_array_length(NEW.legs)-1 LOOP
    leg := NEW.legs->i;
    IF (leg->'allocation' IS DISTINCT FROM NEW.binding->'proposal'->'allocations'->i OR
       NOT (leg->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') OR
       NOT (leg->>'createRequestId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') OR
       NOT (leg->>'captureRequestId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') OR
       leg->>'referenceId' IS DISTINCT FROM 'pl-'||(NEW.binding->'proposal'->>'termsHash')||'-'||(leg->>'id') OR
       (leg->>'createState') NOT IN ('reserved','claimed','ready','unknown') OR
       (leg->>'captureState') NOT IN ('reserved','claimed','confirmed','unknown') OR
       NOT ((leg->>'createState'='reserved' AND leg->>'createAttempts'='0') OR (leg->>'createState'<>'reserved' AND leg->>'createAttempts'='1')) OR
       NOT ((leg->>'captureState'='reserved' AND leg->>'captureAttempts'='0') OR (leg->>'captureState'<>'reserved' AND leg->>'captureAttempts'='1')) OR
       (leg->>'orderId' IS NOT NULL AND NOT (leg->>'orderId' ~ '^[A-Z0-9]{8,40}$')) OR
       (leg->>'captureId' IS NOT NULL AND NOT (leg->>'captureId' ~ '^[A-Z0-9]{8,40}$')) OR
       (leg->>'approvalUrl' IS NOT NULL AND leg->>'approvalUrl' IS DISTINCT FROM 'https://www.sandbox.paypal.com/checkoutnow?token='||(leg->>'orderId')) OR
       (leg->>'createState'='ready' AND (leg->>'orderId' IS NULL OR leg->>'approvalUrl' IS NULL)) OR
       (leg->>'captureState'<>'reserved' AND leg->>'createState'<>'ready') OR
       (leg->>'captureState'='confirmed' AND (leg->>'captureId' IS NULL OR jsonb_typeof(leg->'captureEvidence')<>'object' OR leg->'captureEvidence'='{}'::jsonb))) IS DISTINCT FROM FALSE THEN
      RAISE EXCEPTION 'Invalid checkout state' USING ERRCODE='23000';
    END IF;
    IF TG_OP='INSERT' THEN
      IF leg->>'createState'<>'reserved' OR leg->>'captureState'<>'reserved' OR leg->>'orderId' IS NOT NULL OR leg->>'captureId' IS NOT NULL THEN
        RAISE EXCEPTION 'New checkout must be unattempted' USING ERRCODE='23000';
      END IF;
    ELSE
      previous := OLD.legs->i;
      IF leg->>'id' IS DISTINCT FROM previous->>'id' OR leg->'allocation' IS DISTINCT FROM previous->'allocation' OR
         leg->>'createRequestId' IS DISTINCT FROM previous->>'createRequestId' OR leg->>'captureRequestId' IS DISTINCT FROM previous->>'captureRequestId' OR
         leg->>'referenceId' IS DISTINCT FROM previous->>'referenceId' OR
         (previous->>'orderId' IS NOT NULL AND leg->>'orderId' IS DISTINCT FROM previous->>'orderId') OR
         (previous->>'captureId' IS NOT NULL AND leg->>'captureId' IS DISTINCT FROM previous->>'captureId') OR
         (previous->>'createState'='ready' AND (leg->>'createState'<>'ready' OR leg->>'approvalUrl' IS DISTINCT FROM previous->>'approvalUrl')) OR
         (previous->>'createState'='reserved' AND leg->>'createState' NOT IN ('reserved','claimed')) OR
         (previous->>'createState'='claimed' AND leg->>'createState' NOT IN ('claimed','unknown','ready')) OR
         (previous->>'createState'='unknown' AND leg->>'createState' NOT IN ('unknown','ready')) OR
         (previous->>'captureState'='reserved' AND leg->>'captureState' NOT IN ('reserved','claimed')) OR
         (previous->>'captureState'='claimed' AND leg->>'captureState' NOT IN ('claimed','unknown','confirmed')) OR
         (previous->>'captureState'='unknown' AND leg->>'captureState' NOT IN ('unknown','confirmed')) OR
         (previous->>'captureState'='confirmed' AND (leg->>'captureState'<>'confirmed' OR leg->>'captureId' IS DISTINCT FROM previous->>'captureId' OR leg->'captureEvidence' IS DISTINCT FROM previous->'captureEvidence')) THEN
        RAISE EXCEPTION 'Checkout identity or terminal outcome changed' USING ERRCODE='23000';
      END IF;
      IF previous->>'createState'='reserved' AND leg->>'createState'='claimed' THEN
        IF NEW.blocked_reason IS NOT NULL OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(NEW.legs) WITH ORDINALITY AS part(value,position)
          WHERE (part.position<=i AND part.value->>'createState'<>'ready') OR
                (part.position<>i+1 AND part.value->>'createState' IN ('claimed','unknown')) OR
                part.value->>'captureState' IN ('claimed','unknown')
        ) THEN RAISE EXCEPTION 'Checkout creation is blocked' USING ERRCODE='23000'; END IF;
      END IF;
      IF previous->>'captureState'='reserved' AND leg->>'captureState'='claimed' THEN
        IF NEW.blocked_reason IS NOT NULL OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(NEW.legs) WITH ORDINALITY AS part(value,position)
          WHERE part.value->>'createState'<>'ready' OR
                (part.position<=i AND part.value->>'captureState'<>'confirmed') OR
                (part.position<>i+1 AND part.value->>'captureState' IN ('claimed','unknown'))
        ) THEN RAISE EXCEPTION 'Checkout capture is blocked' USING ERRCODE='23000'; END IF;
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER pledge_checkout_rows BEFORE INSERT OR UPDATE OR DELETE ON pledge_checkout_workflows FOR EACH ROW EXECUTE FUNCTION pledge_checkout_guard();
CREATE TRIGGER pledge_checkout_truncate BEFORE TRUNCATE ON pledge_checkout_workflows FOR EACH STATEMENT EXECUTE FUNCTION pledge_checkout_guard();
REVOKE ALL ON pledge_checkout_workflows FROM PUBLIC;
`;
export const CHECKOUT_SCHEMA_VERSION = 1;
export const CHECKOUT_SCHEMA_CHECKSUM = createHash('sha256').update(SCHEMA).digest('hex');

function context({ organizationId, id }) {
  if (typeof organizationId !== 'string' || !organizationId || organizationId.length > 120 || !UUID.test(id ?? '')) fail('CHECKOUT_INPUT_INVALID');
}
function read(row) {
  if (!row) return null;
  return { id: row.id, organizationId: row.organization_id, request: clone(row.binding.request), proposal: clone(row.binding.proposal),
    sessionSecretHash: row.session_secret_hash, legs: clone(row.legs), blockedReason: row.blocked_reason,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
}
function evidence(value) {
  let encoded, normalized;
  try { encoded = JSON.stringify(value); normalized = JSON.parse(encoded); } catch { fail('CHECKOUT_EVIDENCE_INVALID'); }
  if (!object(normalized) || Object.keys(normalized).length === 0 || encoded.length > 10000) fail('CHECKOUT_EVIDENCE_INVALID');
  return normalized;
}

/** Only explicit migrate() performs DDL. Every claim returns after its transaction commits. */
export function createCheckoutStore({ pool, recoverySignal } = {}) {
  if (!pool || typeof pool.connect !== 'function') fail('CHECKOUT_DATABASE_REQUIRED');
  recoverySignalValid(recoverySignal);
  let leaseActive = false;
  async function transaction(fn, readonly = false, signal = recoverySignal) {
    let client, connectionFailed = false;
    const connectionError = () => { connectionFailed = true; };
    try {
      recoveryAbort(signal);
      client = await pool.connect();
      if (signal) client.on?.('error', connectionError);
      const scoped = { query: async (sql, values) => {
        recoveryAbort(signal);
        if (connectionFailed) fail('CHECKOUT_STORE_UNAVAILABLE');
        const result = signal ? await recoveryQuery(client, sql, values) : await client.query(sql, values);
        recoveryAbort(signal);
        if (connectionFailed) fail('CHECKOUT_STORE_UNAVAILABLE');
        return result;
      } };
      await scoped.query(readonly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      if (signal) await scoped.query(RECOVERY_TIMEOUTS);
      else if (!readonly) await scoped.query("SET LOCAL lock_timeout='5s'");
      const value = await fn(scoped);
      await scoped.query('COMMIT');
      return value;
    } catch (error) {
      try { if (client) await (signal ? recoveryQuery(client, 'ROLLBACK') : client.query('ROLLBACK')); }
      catch { if (signal) connectionFailed = true; /* A successful claim is never returned after ambiguity. */ }
      if (error instanceof CheckoutStoreError) throw error;
      throw new CheckoutStoreError();
    } finally { if (signal) client?.off?.('error', connectionError); client?.release(connectionFailed || undefined); }
  }
  async function getIn(client, input, locked = false) {
    const result = await client.query(`SELECT * FROM pledge_checkout_workflows WHERE organization_id=$1 AND id=$2${locked ? ' FOR UPDATE' : ''}`, [input.organizationId, input.id]);
    return result.rows[0] ?? null;
  }
  async function change(input, fn) {
    context(input);
    return transaction(async (client) => {
      const row = await getIn(client, input, true);
      if (!row) fail('CHECKOUT_NOT_FOUND');
      const result = fn(row);
      if (result?.write !== false) {
        const updated = await client.query('UPDATE pledge_checkout_workflows SET legs=$3::jsonb,blocked_reason=$4,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *',
          [input.organizationId, input.id, JSON.stringify(row.legs), row.blocked_reason]);
        return result?.claim ? { ...result.claim, workflow: read(updated.rows[0]) } : read(updated.rows[0]);
      }
      return result.claim ?? read(row);
    });
  }
  function find(row, legId) {
    if (!UUID.test(legId ?? '')) fail('CHECKOUT_INPUT_INVALID');
    const leg = row.legs.find((item) => item.id === legId);
    if (!leg) fail('CHECKOUT_LEG_NOT_FOUND');
    return leg;
  }
  return {
    async listRecoveryCandidates({ organizationId, after = null, limit = 30, signal } = {}) {
      context({ organizationId, id: after ?? '00000000-0000-0000-0000-000000000000' });
      recoverySignalValid(signal);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('CHECKOUT_INPUT_INVALID');
      const boundedSignal = signal ?? new AbortController().signal;
      return transaction(async (client) => {
        // ID-only discovery cannot return browser authority or binding/provider data.
        const result = await client.query(`SELECT id FROM pledge_checkout_workflows
          WHERE organization_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) AND blocked_reason IS NULL
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(legs) AS leg
            WHERE leg->>'orderId' ~ '^[A-Z0-9]{8,40}$'
            AND (leg->>'createState' IN ('claimed','unknown') OR leg->>'captureState' IN ('claimed','unknown')))
          ORDER BY id ASC LIMIT $3`, [organizationId, after, limit + 1]);
        const ids = result.rows.slice(0, limit).map((row) => row.id);
        return { ids, nextCursor: result.rows.length > limit ? ids.at(-1) : null };
      }, true, boundedSignal);
    },
    async withRecoveryLease({ organizationId, signal } = {}, work) {
      context({ organizationId, id: '00000000-0000-0000-0000-000000000000' });
      recoverySignalValid(signal);
      if (typeof work !== 'function') fail('CHECKOUT_INPUT_INVALID');
      recoveryAbort(signal);
      if (leaseActive) return { acquired: false };
      leaseActive = true;
      let client, connectionFailed = false;
      const leaseAbort = new AbortController();
      const leaseSignal = signal ? AbortSignal.any([signal, leaseAbort.signal]) : leaseAbort.signal;
      const connectionError = () => { connectionFailed = true; leaseAbort.abort(new CheckoutStoreError('CHECKOUT_RECOVERY_LEASE_LOST')); };
      const query = async (sql, values) => {
        recoveryAbort(leaseSignal);
        const result = await recoveryQuery(client, sql, values);
        recoveryAbort(leaseSignal);
        return result;
      };
      try {
        client = await pool.connect();
        client.on?.('error', connectionError);
        await query('BEGIN');
        await query(RECOVERY_TIMEOUTS);
        const key = createHash('sha256').update(`pledge-checkout-recovery:${organizationId}`).digest().readBigInt64BE().toString();
        const result = await query('SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired', [key]);
        if (result.rows[0]?.acquired !== true) {
          await query('ROLLBACK');
          return { acquired: false };
        }
        // Keep the dedicated transaction/lease until all work drains, even following cancellation.
        // It holds no workflow row locks; evidence writes use short, separate transactions.
        await work(leaseSignal);
        recoveryAbort(leaseSignal);
        await query('COMMIT');
        return { acquired: true };
      } catch (error) {
        try { if (client) await recoveryQuery(client, 'ROLLBACK'); } catch { connectionFailed = true; }
        if (leaseSignal.aborted) fail('CHECKOUT_RECOVERY_ABORTED');
        if (error instanceof CheckoutStoreError) throw error;
        fail('CHECKOUT_STORE_UNAVAILABLE');
      } finally {
        client?.off?.('error', connectionError);
        client?.release(connectionFailed || undefined);
        leaseActive = false;
      }
    },
    async migrate() {
      return transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(1618033988::bigint)');
        await client.query('CREATE TABLE IF NOT EXISTS pledge_checkout_migrations (version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
        const history = await client.query('SELECT version,checksum FROM pledge_checkout_migrations ORDER BY version FOR UPDATE');
        if (history.rows.length > 1 || (history.rows.length === 1 && (history.rows[0].version !== 1 || history.rows[0].checksum !== CHECKOUT_SCHEMA_CHECKSUM))) fail('CHECKOUT_SCHEMA_MISMATCH');
        if (history.rows.length === 0) {
          await client.query(SCHEMA);
          await client.query('INSERT INTO pledge_checkout_migrations (version,checksum) VALUES ($1,$2)', [1, CHECKOUT_SCHEMA_CHECKSUM]);
          await client.query('REVOKE ALL ON pledge_checkout_migrations FROM PUBLIC');
        }
        return { version: 1, applied: history.rows.length === 0 };
      });
    },
    async checkSchema() {
      return transaction(async (client) => {
        const result = await client.query('SELECT version,checksum FROM pledge_checkout_migrations ORDER BY version');
        if (result.rows.length !== 1 || result.rows[0].version !== 1 || result.rows[0].checksum !== CHECKOUT_SCHEMA_CHECKSUM) fail('CHECKOUT_SCHEMA_MISMATCH');
        return { version: 1, matches: true };
      }, true);
    },
    async reserve({ organizationId, id = randomUUID(), rfq, proposal, sessionSecretHash }) {
      context({ organizationId, id });
      if (!object(rfq) || !object(proposal) || !HASH.test(proposal.termsHash ?? '') || !HASH.test(sessionSecretHash ?? '') ||
        !Array.isArray(proposal.allocations) || proposal.allocations.length < 1 || proposal.allocations.length > 5) fail('CHECKOUT_INPUT_INVALID');
      const binding = { request: rfq, proposal };
      const encoded = JSON.stringify(binding);
      if (encoded.length > 100000) fail('CHECKOUT_INPUT_INVALID');
      const legs = proposal.allocations.map((allocation) => {
        const legId = randomUUID();
        return { id: legId, allocation: clone(allocation), referenceId: `pl-${proposal.termsHash}-${legId}`, createRequestId: randomUUID(), captureRequestId: randomUUID(),
          createState: 'reserved', createAttempts: 0, orderId: null, approvalUrl: null, orderStatus: null, createEvidence: null,
          captureState: 'reserved', captureAttempts: 0, captureId: null, captureEvidence: null };
      });
      return transaction(async (client) => {
        await client.query('INSERT INTO pledge_checkout_workflows (id,organization_id,binding,session_secret_hash,legs) VALUES ($1,$2,$3::jsonb,$4,$5::jsonb) ON CONFLICT (id) DO NOTHING',
          [id, organizationId, encoded, sessionSecretHash, JSON.stringify(legs)]);
        const row = await getIn(client, { organizationId, id }, true);
        if (!row) fail('CHECKOUT_BINDING_CONFLICT');
        const matching = await client.query('SELECT binding=$3::jsonb AND session_secret_hash=$4 AS matches FROM pledge_checkout_workflows WHERE organization_id=$1 AND id=$2', [organizationId, id, encoded, sessionSecretHash]);
        if (matching.rows[0]?.matches !== true) fail('CHECKOUT_BINDING_CONFLICT');
        return read(row);
      });
    },
    async get(input) { context(input); return transaction(async (client) => read(await getIn(client, input)), true); },
    async block({ organizationId, id, reason }) {
      if (!['quote_changed', 'provider_binding_changed', 'configuration_changed', 'unexpected_capture', 'order_voided'].includes(reason)) fail('CHECKOUT_INPUT_INVALID');
      return change({ organizationId, id }, (row) => { row.blocked_reason ??= reason; });
    },
    async closeExpiredUnpaid({ organizationId, id, at, orderChecks }) {
      if (!Number.isSafeInteger(at) || at < 0 || !Array.isArray(orderChecks) || orderChecks.length > 5) fail('CHECKOUT_INPUT_INVALID');
      return change({ organizationId, id }, (row) => {
        if (row.blocked_reason === 'closed_unpaid') return { write: false };
        if (!canCloseUnpaidCheckout({ proposal: row.binding.proposal, legs: row.legs, blockedReason: row.blocked_reason }, at) ||
          orderChecks.length !== row.legs.length) fail('CHECKOUT_CLOSE_UNPAID_BLOCKED');
        const checks = new Map();
        const fields = new Set(['legId', 'orderId', 'status', 'payeeId', 'amountCents', 'currency', 'referenceId', 'checkedAt', 'noPaymentEvidence']);
        for (const check of orderChecks) {
          if (!object(check) || Object.keys(check).some((key) => !fields.has(key)) || !UUID.test(check.legId ?? '') || checks.has(check.legId)) fail('CHECKOUT_CLOSE_UNPAID_BLOCKED');
          checks.set(check.legId, check);
        }
        for (const leg of row.legs) {
          const check = checks.get(leg.id), checkedAt = Date.parse(check?.checkedAt);
          if (!check || check.orderId !== leg.orderId || check.payeeId !== leg.allocation.payeeId || check.amountCents !== leg.allocation.totalCents ||
            check.currency !== leg.allocation.currency || check.referenceId !== leg.referenceId || check.noPaymentEvidence !== true ||
            !Number.isFinite(checkedAt) || checkedAt > at || at - checkedAt > 90_000 ||
            (leg.createState === 'reserved' ? check.status !== 'NOT_CREATED' : !['CREATED', 'PAYER_ACTION_REQUIRED', 'APPROVED'].includes(check.status))) fail('CHECKOUT_CLOSE_UNPAID_BLOCKED');
        }
        // The lock rechecks every claim after provider reads. A concurrent capture claim wins or closure wins,
        // never both. The existing SQL latch prevents any later claim or reopening without changing its schema.
        for (const leg of row.legs) leg.closedUnpaidEvidence = evidence({ ...checks.get(leg.id), closedAt: new Date(at).toISOString() });
        row.blocked_reason = 'closed_unpaid';
      });
    },
    async claimCreate(input) {
      return change(input, (row) => {
        const leg = find(row, input.legId), position = row.legs.indexOf(leg);
        if (row.blocked_reason || leg.createState !== 'reserved' || row.legs.some((item) => ['claimed', 'unknown'].includes(item.createState) || ['claimed', 'unknown'].includes(item.captureState)) ||
          row.legs.slice(0, position).some((item) => item.createState !== 'ready')) return { write: false, claim: { claimed: false } };
        leg.createState = 'claimed'; leg.createAttempts = 1;
        return { claim: { claimed: true, requestId: leg.createRequestId, leg: clone(leg) } };
      });
    },
    async markCreateUnknown(input) {
      return change(input, (row) => {
        const leg = find(row, input.legId);
        if (leg.createState === 'claimed') leg.createState = 'unknown';
        return { write: leg.createState === 'unknown' };
      });
    },
    async recordOrder({ organizationId, id, legId, orderId, approvalUrl, orderStatus, proof, state = 'ready' }) {
      if (!PAYPAL_ID.test(orderId ?? '') || !['ready', 'unknown'].includes(state) || typeof orderStatus !== 'string' || orderStatus.length > 40) fail('CHECKOUT_INPUT_INVALID');
      const safeUrl = approvalUrl == null ? null : sandboxApprovalUrl(approvalUrl, orderId);
      if (state === 'ready' && !safeUrl) fail('CHECKOUT_INPUT_INVALID');
      const safeProof = evidence(proof);
      return change({ organizationId, id }, (row) => {
        const leg = find(row, legId);
        if (!['claimed', 'unknown', 'ready'].includes(leg.createState) || (leg.orderId && leg.orderId !== orderId) ||
          (leg.createState === 'ready' && (state !== 'ready' || safeUrl !== leg.approvalUrl))) fail('CHECKOUT_STATE_CONFLICT');
        leg.createState = state; leg.orderId = orderId; leg.approvalUrl = safeUrl; leg.orderStatus = orderStatus; leg.createEvidence = safeProof;
      });
    },
    async claimCapture(input) {
      return change(input, (row) => {
        const leg = find(row, input.legId), position = row.legs.indexOf(leg);
        if (row.blocked_reason || leg.captureState !== 'reserved' || row.legs.some((item) => item.createState !== 'ready' || ['claimed', 'unknown'].includes(item.captureState)) ||
          row.legs.slice(0, position).some((item) => item.captureState !== 'confirmed')) return { write: false, claim: { claimed: false } };
        leg.captureState = 'claimed'; leg.captureAttempts = 1;
        return { claim: { claimed: true, requestId: leg.captureRequestId, leg: clone(leg) } };
      });
    },
    async recordCapture({ organizationId, id, legId, state, captureId = null, proof }) {
      if (!['confirmed', 'unknown'].includes(state) || (captureId !== null && !PAYPAL_ID.test(captureId)) || (state === 'confirmed' && !captureId)) fail('CHECKOUT_INPUT_INVALID');
      const safeProof = evidence(proof);
      return change({ organizationId, id }, (row) => {
        const leg = find(row, legId);
        if (leg.captureState === 'confirmed') {
          if (state !== 'confirmed' || captureId !== leg.captureId || !sameJson(safeProof, leg.captureEvidence)) fail('CHECKOUT_STATE_CONFLICT');
          return { write: false };
        }
        if (!['claimed', 'unknown'].includes(leg.captureState) || (leg.captureId && captureId && leg.captureId !== captureId)) fail('CHECKOUT_STATE_CONFLICT');
        leg.captureState = state; leg.captureId = captureId ?? leg.captureId; leg.captureEvidence = safeProof;
      });
    },
  };
}
