# PostgreSQL journal

`src/storage/postgres-ledger.js` is an asynchronous financial journal for an approved procurement operation and its settlement legs. It does not replace the synchronous donor-call JSONL ledger. Every persistence method must be awaited. Never return success, invoke a payment, or acknowledge a webhook before the relevant transaction commits. There is no memory fallback when PostgreSQL is unavailable.

The integration checkout is connected to Neon PostgreSQL 17 with migrations 1 and 2 applied. `src/server.js` opens the configured connection before listening and passes the journal to the mock procurement service and verified PayPal webhook inbox. When `DATABASE_URL` is absent, procurement uses memory and the webhook path retains its local ledger behavior. When it is present, a failed connection or schema check prevents startup, and storage failures do not authorize a new supplier attempt or acknowledge a verified webhook.

Procurement at `/procurement` uses simulated suppliers and mock payments only. The journal persists approved terms, leg request IDs, attempts and outcomes; quotes, mock suppliers, browser keys and HTTP sessions remain in memory. The API expires sessions after one hour and does not restore them from the journal after a refresh or restart. This is not durable donor-call handling or real-money readiness.

## API

Construct `createPostgresStore({ pool })` with a `pg.Pool` or compatible pool. The caller owns and closes the pool. Methods return promises.

- `migrate()` validates the ordered migration history and applies missing reviewed migrations under one transaction and advisory lock. Version 1 is the frozen initial schema; version 2 adds state/attempt consistency and terminal outcome immutability. Repeating applied migrations is safe. A different checksum, missing historical version or unknown version fails closed.
- `checkSchema()` reads migration versions and checksums without DDL and requires the complete current history (versions 1 and 2). Use this at server startup with the runtime connection. A database containing only version 1 requires an explicit operator migration before startup can succeed.
- `reserveOperation({ organizationId, operationKey, consent, legs })` atomically stores the exact consent object and normalized legs. Each leg has `kind`, `targetId`, integer `amountCents`, uppercase ISO currency, optional integer `quantity`, and optional `dependsOn`. Reusing a business key returns its stable identity only if the entire binding is equal. Changed terms fail. Per-leg request IDs are generated at reservation and persist across duplicate requests.
- `claimLeg({ organizationId, operationKey, kind })` returns `{ claimed: true, requestId, ...leg }` only after committing the initial attempt. Only this result permits a dispatcher to send that approved leg. False means do not send. An in-flight or unknown prior leg blocks further claims, including after process replacement. Dependencies must be confirmed. A failed or completed operation cannot be reopened.
- `recordLegOutcome({ organizationId, operationKey, kind, state, providerId, evidence })` records `confirmed`, `failed` or `unknown` after an attempt or reconciliation. Every outcome requires a nonempty JSON evidence object, and a confirmed outcome requires a nonempty provider ID. Database constraints also refuse confirmed records without both fields. Evidence must contain meaningful facts from the relevant provider read; the object checks do not authenticate or interpret those facts. Terminal outcomes cannot be overwritten. Unknown outcomes never authorize another initial attempt.
- `getOperation({ organizationId, operationKey })`, `listUnresolved({ organizationId })` retrieve only that organization's records in read-only REPEATABLE READ transactions, so parent and leg views share one snapshot. The latter lists up to 100 operations needing reconciliation. Application code must not treat an interrupted attempt as a new operation with another key.
- `acceptVerifiedWebhook({ organizationId, provider, eventId, rawBody, verified: true })` persists an already signature-verified raw delivery and its digest. It atomically deduplicates identical deliveries and refuses reused identities with different payloads. It does not verify PayPal signatures. Raw bodies can contain personal information and require a documented retention policy.
- `appendEvent({ organizationId, operationKey, type, event })` and `listEvents({ organizationId, operationKey })` retain sanitized audit events. PINs, tokens, keys and unredacted donor data must never be passed here. Event listing is bounded at 1,000 rows.

A transaction or commit error returns `STORE_UNAVAILABLE`, never a successful claim. The caller must reconcile by the same stable business and request IDs. Do not hold a database transaction open over a PayPal HTTP request.

## Setup and checks

Configure `DATABASE_URL` through a private environment file or deployment environment, never a tracked file or chat. `pg` is an installed dependency. The runtime uses a five-connection pool, bounded connection/query timeouts and sanitized idle-connection error handling. Connection options force `sslmode=verify-full`, reject host/identity query overrides, and verify the actual TLS stream before startup succeeds.

The local `.database.env` contains the restricted runtime connection; `.database-admin.env` contains the separate migration connection. Both are ignored files with mode `600`. Do not read them into logs, print them, stage them or paste their contents into chat. Check the runtime connection without changing schema:

```sh
node --env-file=.database.env scripts/database-check.js --require-tls
```

The check reports connection, TLS, durability settings and schema status without exposing the URL or raw database errors. It requires synchronous commits. Ordinary PostgreSQL also requires `fsync=on`. Neon compute nodes use remote WAL safekeeper quorum rather than local durable disks, so `fsync=off` is accepted only for a verified Neon hostname with verified transport and synchronous commits. A Neon proxy can make backend `pg_stat_ssl` report false; the client TLS stream must still be encrypted and authorized. See [Neon's architecture](https://neon.com/docs/introduction/architecture-overview).

Migrations are an explicit administrator action, never a startup fallback. Use a dedicated development database and the administrator connection:

```sh
node --env-file=.database-admin.env scripts/database-check.js --require-tls --migrate
```

Applied migration SQL and checksums are immutable. Version 2 validates existing rows before committing; incompatible rows cause the complete upgrade to roll back and require investigation rather than automatic repair. The runtime role cannot migrate. After checking the runtime connection, start the integration server with donor-line settings already in the environment:

```sh
node --env-file=.database.env src/server.js
```

For an offline donor line, prefix that command with `PAYPAL_MODE=mock ROUTER_MODE=rules`. To load existing sandbox/router settings as well, use `node --env-file=.env --env-file=.database.env src/server.js`. `npm start` reads `.env` only. This local setup does not deploy to Render or alter the pilot checkout.

## Acceptance tests

`DATABASE_TEST_URL` opts into hosted tests and must point to a disposable development database. Supply it through a private test environment file or process environment. `node --test test/postgres-ledger.test.js test/procurement-postgres.test.js` then exercises concurrent claims, prohibited SQL updates/deletes, committed/unknown outcomes and reconciliation using the same leg request IDs. The adapter test explicitly migrates and requires administrator privileges; do not run it with production or restricted runtime credentials. Tests retain synthetic rows under unique organization IDs. Without the variable, hosted cases are skipped; a skip is not an acceptance pass.

The hosted adapter and procurement recovery tests have passed against the connected Neon development database. They validate journal behavior with synthetic records and mock suppliers. They do not test live PayPal payments, supplier fulfillment, session restoration, backup restore or a production recovery worker.

## Least privilege and production boundary

Migrate with an owner account, then use a separate runtime role with only SELECT, INSERT and UPDATE on the `pledge_*` data tables and USAGE/SELECT on their identity sequence. Grant SELECT only on `pledge_store_migrations` for the startup checksum check. Never grant runtime DELETE, TRUNCATE, DDL, role administration or write access to migration metadata. Public table privileges are revoked by the migration. Insert triggers require every leg to exactly match an entry in the immutable approved binding and to start reserved with no attempt or outcome. State/attempt constraints require exactly one recorded attempt for every non-reserved leg. Binding and retry triggers protect ordinary updates, including same-state edits to a terminal provider ID or evidence. DELETE and TRUNCATE guards protect the journal and migration metadata even if those privileges are accidentally granted. A database owner can disable triggers, so this is not a defense against a malicious owner. Retention or schema maintenance requires an explicit reviewed operator migration rather than ordinary runtime deletion.

All methods scope queries by organization. The organization identity must come from authenticated server context. Passing an untrusted browser's organization ID does not provide tenant isolation. RLS and production role permissions still require deployment-specific validation. Donor-specific identity, subscription ownership, sponsor authority, durable donor-call handling, real provider reconciliation and restore tests remain required before live payments. The PayPal live-host guard remains in place.
