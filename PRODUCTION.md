# Production readiness

Pledge Line currently runs against the PayPal sandbox. Real-money processing is disabled in both configuration and the API client. This is an intentional boundary, not a deployment option to bypass.

## Implemented and checked in the integration checkout

The donor line binds each approval to an exact proposed action, re-reads relevant records before execution, requires separate authorization for each call session, and reconciles uncertain responses without treating them as definitive refusals. Covered Month requires a fresh completed sponsor capture before refunding a donor. Uncertain invoice sends cannot be approved again or deleted as routine cleanup.

A Neon PostgreSQL 17 database is connected with certificate-verified TLS and migrations 1 and 2 applied. The asynchronous journal stores exact approved procurement terms, immutable settlement legs, stable request IDs, attempts and outcomes. The procurement service awaits its reservation and claim before each simulated supplier side effect. When configured, the verified PayPal webhook inbox also commits raw deliveries and deduplication identities before acknowledgment. Startup checks the current schema without migrating and refuses a failed configured connection; it never silently falls back to memory.

Hosted adapter tests have exercised concurrent reservations/claims and prohibited updates, and a hosted procurement test has checked complete settlement, an unknown outcome, blocked later legs and reconciliation with the same request IDs. These use synthetic records and simulated supplier payments. They do not validate live PayPal settlement, disaster recovery or donor authorization.

The `/procurement` page remains a mock experiment: no PayPal payment, real supplier contract or goods order is created. HTTP sessions and mock suppliers remain in memory. The donor-call JSONL ledger, including Covered Month's financial state, remains local and is not replaced by this journal. The database addition does not update Render or the pilot checkout and does not establish production readiness.

## Requirements before enabling live payments

1. Extend the journal to the actual donor/PayPal write paths. Persist authorized organization and donor identity, stable business keys, exact consent and source reads, targets, amounts, currencies, PayPal request IDs and every financial leg. The current procurement journal does not protect donor actions across restarts; a local JSONL file on Render's free filesystem is insufficient.
2. Persist resumable sessions and add a restart reconciliation worker. Interrupted operations remain unknown until authoritative provider reads establish their result. Never repeat an uncertain operation with a fresh identity. Reconcile every Covered Month or supplier leg independently. A refund is compensation, not an atomic rollback.
3. Add durable webhook processing and reconciliation beyond storing the verified delivery. Handle retries and out-of-order events idempotently, connect events to the correct organization and operation, and test recovery after instance replacement. A durable inbox alone does not update or restore donor state.
4. Replace the shared demo PIN and fixed subscription with donor-specific verification and proof of subscription ownership. Enforce organization and staff authorization. A browser call-session secret protects that call's API; it does not prove a real donor's identity.
5. Establish sponsor authority and merchant permissions, including the permitted amount, currency, recipient, expiry and use count. A configured sponsor authorization ID alone is not a complete authorization policy.
6. Configure a verified merchant account, separate production credentials, HTTPS and a production webhook with the exact required permissions. Confirm any applicable platform and seller onboarding approvals with PayPal. Do not reuse sandbox credentials or objects.
7. For procurement, establish real supplier identities, contracts, quote authority, availability, delivery and refund terms, plus an approved payment integration. The current staged negotiation is not a live MCP integration, and mock settlement does not establish permission to pay multiple sellers or make partial payments. Bind buyer approval to the production plan and preserve unknown and partial outcomes.
8. Run concurrency, duplicate delivery, process-crash-after-write, reconciliation and restore tests for the integrated real provider paths against the transactional backend. Validate backups and runtime role permissions. Then perform a controlled, explicitly authorized low-value live acceptance test and verify settlement and refund behavior in the production account.

## Operation journal contract

The PostgreSQL adapter reserves an operation under a unique organization/business key, stores the exact consent binding and approved legs, and commits a stable request ID and one-attempt claim before dispatch. Unconfirmed attempts block later claims, and terminal outcomes and bindings are immutable. The mock procurement service uses this contract; the donor PayPal writes do not yet use it. [The database guide](docs/DATABASE.md) covers setup, explicit administrator migrations, restricted runtime credentials and the adapter API.

Production dispatch must supply authenticated organization and donor identity, preserve the same business and provider request IDs across restarts, reconcile unknown attempts from authoritative reads, and advance only from confirmed outcomes. The current shared demo organization and in-memory session lookup cannot provide that authority or recovery.

No environment boolean can replace these requirements. Until they are implemented and validated, keep the sandbox host guard intact.

## PayPal references checked November 4, 2026

- [Move your app to production](https://developer.paypal.com/api/rest/production/) describes live credentials, a verified account, production endpoints and live settings.
- [Platforms and marketplaces overview](https://developer.paypal.com/platforms/overview) says sandbox integrations can be tested with a standard developer account and that platforms apply for live credentials and approval.
- [Multi-seller payments](https://developer.paypal.com/platforms/checkout/standard/customize/multiseller-payments) requires buyer approval, uses CAPTURE intent, and documents partial completion and timeout handling. It does not make an all-or-nothing purchase across independent suppliers.
