# PostgreSQL storage

Pledge Line uses separate PostgreSQL stores for the original procurement journal, AI spending, approved sandbox checkout, controlled supplier quotes and durable donor calls. `src/storage/postgres-ledger.js` remains the original operation/leg journal; donor persistence is implemented separately in `src/donor-store.js`, `src/durable-ledger.js` and `src/donor-durability.js`. Every asynchronous persistence method must be awaited. A provider write needs its committed claim, and an HTTP success or webhook acknowledgment needs the relevant persistence barrier. Configured storage failure never selects an in-memory replacement.

The integration checkout is connected to Neon PostgreSQL 17. The original journal migrations 1 and 2 and the four additional version 1 schemas have been explicitly applied in separate histories. `src/server.js` opens the configured connection before listening, then `src/runtime-services.js` checks the stores required by the selected flags. Missing tables, changed checksums or a failed connection prevent startup. Runtime startup performs no migration or DDL.

`ROUTER_MODE=anthropic`, `PROCUREMENT_SUPPLIER_MODE=mcp-sandbox` and `DONOR_DURABILITY_ENABLED=true` each require the database. `HOSTED_SUPPLIER_LAB_ENABLED=true` additionally requires network supplier mode and the quote schema. For database-free rules/mock development, turn donor durability off; this deliberately uses the legacy local donor JSONL ledger and in-memory mock procurement.

Unapproved quote sessions and mock procurement sessions remain in memory and expire after one hour. Approved sandbox checkout persists its proposal, quote evidence, session-key hash and per-vendor create/capture state. The original tab retains its bearer in `sessionStorage`; a return URL or a missing bearer never authorizes a replacement purchase. Optional checkout recovery reads known uncertain identities without creating or capturing orders. Durable donor recovery is separate and described below. No storage mode enables live payments.

| Store | Applied version | Purpose |
| --- | --- | --- |
| `pledge_store_migrations` | 1 and 2 | Original operation/leg journal and verified webhook inbox |
| `pledge_ai_migrations` | 1 | Project allocations, conservative request reservations and shared latched stop |
| `pledge_checkout_migrations` | 1 | Approved sandbox checkout bindings, session-key hashes and stable per-vendor order/capture identities |
| `pledge_supplier_quote_migrations` | 1 | Immutable quote identities, exact request/payee/specification bindings and expiry |
| `pledge_donor_migrations` | 1 | Hashed session authority, revisioned donor snapshots, append-only events and one-attempt provider actions |

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

A transaction or commit error returns `STORE_UNAVAILABLE`, never a successful claim. The caller must reconcile by the same stable business and request IDs. These financial journal transactions finish before a PayPal HTTP request. The separate donor service can hold a bounded transaction advisory lease while work runs; it holds no financial row lock over the network, and each action claim commits separately before dispatch.

## Setup and checks

Configure `DATABASE_URL` through a private environment file or deployment environment, never a tracked file or chat. `pg` is an installed dependency. The runtime uses a five-connection pool, bounded connection/query timeouts and sanitized idle-connection error handling. Connection options force `sslmode=verify-full`, reject host/identity query overrides, and verify the actual TLS stream before startup succeeds.

The local `.database.env` contains the restricted runtime connection; `.database-admin.env` contains the separate migration connection. Both are ignored files with mode `600`. Do not read them into logs, print them, stage them or paste their contents into chat. Check the runtime connection without changing schema:

```sh
node --env-file=.database.env scripts/database-check.js --require-tls
node --env-file=.database.env --env-file=.ai.env scripts/ai-check.js
node --env-file=.database.env scripts/checkout-check.js
node --env-file=.database.env scripts/feature-storage-check.js --require-tls
```

The first three commands check the original journal, AI and checkout stores. `feature-storage-check.js` checks both additional donor and supplier schemas with verified TLS and durability settings. Run these read-only checks with the restricted runtime role. No new schema is created by these checks or by application startup.

These commands report database/schema or local allocation status without model inference or PayPal checkout calls. They do not inspect provider account balances. Load `.ai.env` so scope/allocation overrides match the initialized budget. Connection checks require synchronous commits. Ordinary PostgreSQL also requires `fsync=on`. Neon compute nodes use remote WAL safekeeper quorum rather than local durable disks, so `fsync=off` is accepted only for a verified Neon hostname with verified transport and synchronous commits. A Neon proxy can make backend `pg_stat_ssl` report false; the client TLS stream must still be encrypted and authorized. See [Neon's architecture](https://neon.com/docs/introduction/architecture-overview).

Migrations are an explicit administrator action, never a startup fallback. Use a dedicated development database and the administrator connection:

```sh
node --env-file=.database-admin.env scripts/database-check.js --require-tls --migrate
node --env-file=.database-admin.env --env-file=.ai.env scripts/ai-check.js --migrate
node --env-file=.database-admin.env scripts/checkout-check.js --migrate
node --env-file=.database-admin.env scripts/feature-storage-check.js --require-tls --migrate
```

The additional-store CLI calls the reviewed `createDonorStore({ pool }).migrate()` and `createSupplierQuoteStore({ pool }).migrate()` methods only with `--migrate`, then checks both schemas and closes the pool. The initial completion migration used those same module methods directly. The CLI does not grant privileges. Grant the exact runtime privileges below, reconnect using the runtime role and run the read-only check before enabling the flags. No administrator URL belongs in the web service, browser, command arguments or logs.

Applied SQL and checksums are immutable across all five migration histories. Each store serializes explicit migration and rejects an unexpected history rather than rewriting it. Original journal version 2 validates existing rows before committing; incompatible rows roll the upgrade back. AI initialization fixes the scope and allocations; mismatched later limits fail rather than silently replacing the budget. The runtime role cannot migrate. For rules/mock development with settings already in the environment, the basic database startup is:

```sh
node --env-file=.database.env src/server.js
```

For an offline donor line, prefix that command with `PAYPAL_MODE=mock ROUTER_MODE=rules`; leave donor durability disabled if no database is wanted. For guarded AI, use `PAYPAL_MODE=mock ROUTER_MODE=anthropic node --env-file=.database.env --env-file=.ai.env src/server.js`. The complete sandbox release loads `.env` first, then `.database.env`, `.ai.env` and `.sandbox.env`, so empty template assignments cannot override private credentials. Select its durable donor and private hosted supplier flags in `.env`; see [the supplier guide](SUPPLIER-LAB.md) and [README deployment instructions](../README.md#deploy-the-sandbox-release-after-acceptance). External registry mode additionally loads its dedicated `.suppliers.env`. `npm start` loads `.env` only. These local commands do not deploy the service.

## AI allocation and checkout stores

`src/ai-budget.js` keeps the $5 Anthropic and $0.25 Jev default development allocations separately from provider account balances. `src/ai-gateway.js` reserves a conservative maximum before a fixed-host API-key request and settles only verified usage under the priced model contract. Ambiguous calls retain the full reservation. Exhaustion, billing/authentication failures and unverified usage stop both providers through the same durable scope. A restart does not reset the stop or authorize discarding an unresolved reservation. `AI_PREPAID_ONLY_CONFIRMED` is an operator attestation; the database cannot verify provider funding or disable provider auto-reload.

The separately authorized November 5 completion scope is `pledge-line-functional-20261105`, with limits of $3.00 Anthropic and $0.10 Jev across acceptance and deployment together. Reuse its remaining allocation and stop state on Render. Historical stopped scopes and the original $0.05124 unresolved reservation remain preserved; deploying or changing an environment file is not permission to clear them.

`src/checkout-store.js` freezes the approved RFQ/proposal and allocates stable per-vendor create/capture request IDs. Transactions claim each operation before a remote write, enforce legal transitions and preserve unknown results without a fresh attempt. Only the session-key hash is retained, not the browser's key. `src/sandbox-checkout.js` requires fresh bound quotes, buyer-approved PayPal orders and authoritative order/capture reads. These controls apply to PayPal sandbox only and do not establish independent supplier participation.

## Durable donor and supplier stores

`createDonorStore({ pool, organizationId })` stores session-secret hashes separately from authority-free snapshots. Call identity is immutable; saving a snapshot requires its exact current revision. Events use globally reserved sequence IDs and exact idempotent inserts. Structured credential fields are rejected in JavaScript and SQL; internal audit `tokenId`/`tokenIds` remain permitted in events, but raw PINs, API keys, passwords, bearer secrets and OAuth tokens do not.

Every dispatched provider operation, including draft creation/deletion, first commits an immutable one-attempt action with stable business/request identities and exact bindings. A returned provider ID persists before later read-back. Uncertain claims cannot be reset or replaced. Recovery uses fresh reads of known identities; a creation whose identity was lost stays blocked. Covered Month capture/refund/unwind retain separate action identities and evidence.

`createDurableLedger` keeps synchronous audit indexes with awaited PostgreSQL reserve/flush barriers. The HTTP wrapper acquires a per-call advisory lease, reloads the committed snapshot/events, performs the request and persists its result before success. At most two call leases run per process, preserving pool capacity for claims, audit writes and the AI gateway. Lease loss prevents another dispatch. Bounded idle discovery also finds persisted calls no browser has rehydrated; cleanup deletes only a known invoice freshly read as DRAFT, never an uncertain or sent invoice.

The original tab keeps its session bearer in `sessionStorage`. A restored donor call requires the PIN again and a fresh proposal/yes; pending approvals and write tokens are not restored. Receipt access needs its separate secret and the same stable signing key. PostgreSQL preserves the audit used by receipts and staff views across process restarts.

`createSupplierQuoteStore({ pool })` stores immutable quote IDs with the exact supplier, payee, request binding, specification hash, terms and expiry. Runtime `save()` is insert-only and exact duplicate insertion is idempotent. `loadActive()` hydrates up to 2,000 active quotes per supplier; `get()` is a SELECT-only read-through for a quote issued by another process after startup. Expired records remain as durable history and cannot authorize a new quote use. The private hosted lab persists each quote before exposing it and validates restored records against the configured sandbox merchant.

## Acceptance tests

`DATABASE_TEST_URL` opts into hosted tests and must point to a disposable development database. Supply it through a private test environment file or process environment. `node --test test/postgres-ledger.test.js test/procurement-postgres.test.js` then exercises concurrent claims, prohibited SQL updates/deletes, committed/unknown outcomes and reconciliation using the same leg request IDs. The adapter test explicitly migrates and requires administrator privileges; do not run it with production or restricted runtime credentials. Tests retain synthetic rows under unique organization IDs. Without the variable, hosted cases are skipped; a skip is not an acceptance pass.

`DONOR_RUNTIME_TEST_URL` and `SUPPLIER_QUOTE_TEST_URL` separately opt into the new store tests against an already-migrated disposable database using restricted runtime privileges. `node --test test/donor-store.test.js test/supplier-quote-store.test.js` exercises immutable identities, concurrent claims/leases, unknown-state preservation, structured credential rejection, recovery discovery and exact quote recovery across independent clients. Supply URLs through private environment files, never shell arguments. These tests retain uniquely scoped synthetic records and do not migrate.

The historical journal and mock procurement hosted checks remain preserved. The November 5 full suite, with the new donor/supplier Neon tests enabled, reported **725 passed, 7 skipped, 0 failed**. Skips remain unverified cases. This validates software and synthetic persistence behavior; the complete current PayPal sandbox, donor, webhook, browser and restart acceptance run is still in progress. No test establishes real supplier fulfillment or live-money readiness.

## Least privilege and production boundary

Migrate with the administrator account, then use a distinct non-owner runtime role. Existing original-journal, AI and checkout grants stay limited to their required tables and original identity sequence; migration metadata is SELECT-only. For the new stores, add only:

| Object | Runtime privileges |
| --- | --- |
| Schema `public` | `USAGE` |
| `pledge_donor_calls`, `pledge_donor_actions` | `SELECT, INSERT, UPDATE` |
| `pledge_donor_events` | `SELECT, INSERT` |
| `pledge_supplier_quotes` | `SELECT, INSERT` |
| `pledge_donor_migrations`, `pledge_supplier_quote_migrations` | `SELECT` |
| Sequence `pledge_donor_event_seq` | `USAGE` (`SELECT` is acceptable but not required) |

The donor snapshot/event check constraints call `pledge_donor_snapshot_safe(jsonb)` and `pledge_donor_event_safe(jsonb)`. Their default PUBLIC execution permits these checks; if that privilege is revoked, grant runtime execution explicitly on these two functions. Never grant sequence `UPDATE`/`setval`, table `DELETE`/`TRUNCATE`, schema `CREATE`, role administration, ownership or migration writes. Verify inherited memberships do not restore those powers. The connected runtime role's new table grants have been checked, including unavailable deletion/truncation. Avoid blanket grants on future tables.

Public table privileges are revoked by the migrations. Original journal insert triggers bind each reserved leg to the immutable approval and state/attempt constraints prevent replay. The AI store protects allocation/request bindings and a latched stop; checkout triggers preserve plan identities, legal transitions and terminal outcomes. A database owner can disable triggers, so these are not a defense against a malicious owner. Retention or schema maintenance requires an explicit reviewed operator migration rather than ordinary runtime deletion.

Donor and financial operation methods scope queries by the server's organization. Supplier quote records are scoped to the operator's supplier IDs and exact merchant bindings. The current HTTP service fixes the demo organization; an untrusted browser cannot nominate a tenant. This shared sandbox donor/PIN and controlled supplier lab are not production donor identity or supplier onboarding. RLS, retention/backup restoration, donor-specific ownership, sponsor authority and independent business access require separate production validation. The PayPal live-host guard remains in place.
