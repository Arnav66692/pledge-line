# PostgreSQL journal

`src/storage/postgres-ledger.js` is an asynchronous financial journal for an approved procurement operation and its settlement legs. It does not replace the synchronous donor-call JSONL ledger. Every persistence method must be awaited. Never return success, invoke a payment, or acknowledge a webhook before the relevant transaction commits. There is no memory fallback when PostgreSQL is unavailable.

The integration checkout is connected to Neon PostgreSQL 17. The original journal migrations 1 and 2, AI allocation schema 1 and sandbox checkout schema 1 are applied in separate migration histories. `src/server.js` opens the configured connection before listening, then `src/runtime-services.js` checks the additional stores required by the selected mode. A failed configured connection or schema check prevents startup. The original journal still supports mock procurement settlement and the verified PayPal webhook inbox; it does not replace the donor-call JSONL ledger.

Without `DATABASE_URL`, rules/mock procurement can use memory and webhooks retain local-ledger behavior. Guarded Anthropic mode and MCP sandbox checkout require the database. Unapproved quote sessions and mock supplier state remain in memory and their HTTP sessions expire after one hour. Approved sandbox checkout instead persists its proposal, quote evidence, session-key hash and per-vendor create/capture state; the original tab retains its key in `sessionStorage` and can resume that workflow after a server restart. Losing the key does not authorize a replacement purchase. There is no automatic reconciliation worker or live-money path.

| Store | Applied version | Purpose |
| --- | --- | --- |
| `pledge_store_migrations` | 1 and 2 | Original operation/leg journal and verified webhook inbox |
| `pledge_ai_migrations` | 1 | Project allocations, conservative request reservations and shared latched stop |
| `pledge_checkout_migrations` | 1 | Approved sandbox checkout bindings, session-key hashes and stable per-vendor order/capture identities |

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
node --env-file=.database.env --env-file=.ai.env scripts/ai-check.js
node --env-file=.database.env scripts/checkout-check.js
```

These commands report database/schema or local allocation status without model inference or PayPal checkout calls. They do not inspect provider account balances. Load `.ai.env` so scope/allocation overrides match the initialized budget. Connection checks require synchronous commits. Ordinary PostgreSQL also requires `fsync=on`. Neon compute nodes use remote WAL safekeeper quorum rather than local durable disks, so `fsync=off` is accepted only for a verified Neon hostname with verified transport and synchronous commits. A Neon proxy can make backend `pg_stat_ssl` report false; the client TLS stream must still be encrypted and authorized. See [Neon's architecture](https://neon.com/docs/introduction/architecture-overview).

Migrations are an explicit administrator action, never a startup fallback. Use a dedicated development database and the administrator connection:

```sh
node --env-file=.database-admin.env scripts/database-check.js --require-tls --migrate
node --env-file=.database-admin.env --env-file=.ai.env scripts/ai-check.js --migrate
node --env-file=.database-admin.env scripts/checkout-check.js --migrate
```

Applied migration SQL and checksums are immutable, including the separate AI and checkout version 1 schemas. Original journal version 2 validates existing rows before committing; incompatible rows cause the complete upgrade to roll back and require investigation rather than automatic repair. AI initialization also fixes the scope and allocations; mismatched later limits fail rather than silently replacing the budget. The runtime role cannot migrate. For rules/mock development with settings already in the environment, the basic database startup is:

```sh
node --env-file=.database.env src/server.js
```

For an offline donor line, prefix that command with `PAYPAL_MODE=mock ROUTER_MODE=rules`. For the new guarded agent, use `PAYPAL_MODE=mock ROUTER_MODE=anthropic node --env-file=.database.env --env-file=.ai.env src/server.js`. The optional network checkout additionally loads `.env` for PayPal sandbox settings and `.suppliers.env` for dedicated MCP tokens; [COMMERCE.md](COMMERCE.md) lists its prerequisites. `npm start` reads `.env` only. This local setup does not deploy to Render or alter the pilot checkout.

## AI allocation and checkout stores

`src/ai-budget.js` keeps the $5 Anthropic and $0.25 Jev default development allocations separately from provider account balances. `src/ai-gateway.js` reserves a conservative maximum before a fixed-host API-key request and settles only verified usage under the priced model contract. Ambiguous calls retain the full reservation. Exhaustion, billing/authentication failures and unverified usage stop both providers through the same durable scope. A restart does not reset the stop or authorize discarding an unresolved reservation. `AI_PREPAID_ONLY_CONFIRMED` is an operator attestation; the database cannot verify provider funding or disable provider auto-reload.

`src/checkout-store.js` freezes the approved RFQ/proposal and allocates stable per-vendor create/capture request IDs. Transactions claim each operation before a remote write, enforce legal transitions and preserve unknown results without a fresh attempt. Only the session-key hash is retained, not the browser's key. `src/sandbox-checkout.js` requires fresh bound quotes, buyer-approved PayPal orders and authoritative order/capture reads. These controls apply to PayPal sandbox only; they neither verify independent supplier participation nor migrate donor financial state.

## Acceptance tests

`DATABASE_TEST_URL` opts into hosted tests and must point to a disposable development database. Supply it through a private test environment file or process environment. `node --test test/postgres-ledger.test.js test/procurement-postgres.test.js` then exercises concurrent claims, prohibited SQL updates/deletes, committed/unknown outcomes and reconciliation using the same leg request IDs. The adapter test explicitly migrates and requires administrator privileges; do not run it with production or restricted runtime credentials. Tests retain synthetic rows under unique organization IDs. Without the variable, hosted cases are skipped; a skip is not an acceptance pass.

The hosted adapter and procurement recovery tests have passed against the connected Neon development database. They validate journal behavior with synthetic records and mock suppliers. They do not test live PayPal payments, supplier fulfillment, session restoration, backup restore or a production recovery worker.

## Least privilege and production boundary

Migrate with an owner account, then use a separate runtime role with SELECT, INSERT and UPDATE only on the exact required data tables and USAGE/SELECT on the original journal's identity sequence. Grant SELECT only on `pledge_store_migrations`, `pledge_ai_migrations` and `pledge_checkout_migrations` for startup checks. The connected development database has these restricted grants; runtime DELETE and migration-metadata UPDATE have been checked as unavailable. Never grant runtime TRUNCATE, DDL, role administration or migration writes. Do not use a blanket grant that exposes future tables.

Public table privileges are revoked by the migrations. Original journal insert triggers bind each reserved leg to the immutable approval and state/attempt constraints prevent replay. The AI store protects allocation/request bindings and a latched stop; checkout triggers preserve plan identities, legal transitions and terminal outcomes. A database owner can disable triggers, so these are not a defense against a malicious owner. Retention or schema maintenance requires an explicit reviewed operator migration rather than ordinary runtime deletion.

All methods scope queries by organization. The organization identity must come from authenticated server context. Passing an untrusted browser's organization ID does not provide tenant isolation. RLS and production role permissions still require deployment-specific validation. Donor-specific identity, subscription ownership, sponsor authority, durable donor-call handling, real provider reconciliation and restore tests remain required before live payments. The PayPal live-host guard remains in place.
