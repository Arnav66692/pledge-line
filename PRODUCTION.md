# Production readiness

Pledge Line currently runs against the PayPal sandbox. Real-money processing is disabled in both configuration and the API client. This is an intentional boundary, not a deployment option to bypass.

## Implemented and checked in the integration checkout

The donor line binds each approval to an exact proposed action, re-reads relevant records before execution, requires separate authorization for each call session, and reconciles uncertain responses without treating them as definitive refusals. Covered Month requires a fresh completed sponsor capture before refunding a donor. Uncertain invoice sends cannot be approved again or deleted as routine cleanup.

A Neon PostgreSQL 17 database is connected with certificate-verified TLS. The original journal migrations 1 and 2, guarded AI schema 1 and sandbox checkout schema 1 have been explicitly applied. Restricted runtime grants cover the required data tables, with read-only migration metadata and no DELETE privilege. The original journal stores approved mock procurement legs and verified PayPal webhook deliveries; the separate checkout store persists approved network plans, quote evidence, session-key hashes and stable order/capture identities. Startup checks the required schemas without migrating and refuses configured storage errors.

Hosted adapter tests have exercised concurrent reservations/claims and prohibited updates, and a hosted procurement test has checked complete settlement, an unknown outcome, blocked later legs and reconciliation with the same request IDs. These use synthetic records and simulated supplier payments. They do not validate live PayPal settlement, disaster recovery or donor authorization.

The `/procurement` page defaults to mock suppliers and payments. Its optional network mode implements authenticated MCP quote calls and PayPal Orders sandbox create, buyer approval, capture and authoritative reads. The included supplier server is controlled reference software with optional quote persistence; independent business participation and fulfillment are unverified. Actual merchant IDs/endpoints, buyer approval and a completed PayPal order/capture acceptance run remain pending. Writes require both `PAYPAL_SANDBOX_CHECKOUT_WRITES=true` and a time at or after November 4, 2026, 9:00 pm PT (`2026-11-05T05:00:00Z`).

Approved sandbox checkout state survives process replacement, and the original tab can resume it using its `sessionStorage` key. Return URLs do not authorize a write. Unapproved and mock quote sessions remain in memory; no automatic recovery worker exists. The donor-call JSONL ledger, including Covered Month's financial state, remains local. The integration does not update Render or the pilot checkout and does not establish production readiness.

The new Sonnet/Jev agent uses fixed-host API-key requests with PostgreSQL cost reservations and a latched shared stop. Its default $5/$0.25 limits are development allocations, not measured provider balances. `AI_PREPAID_ONLY_CONFIRMED=true` records an operator assertion about funding and disabled auto-reload; the application does not verify those account settings. An API key cannot select a credit pool, and some provider organizations consume subscription credits before purchased credits. The Anthropic key and billing confirmation remain pending, so actual inference and the frozen [90-point evaluation](docs/AI-EVAL.md) have not run.

## Requirements before enabling live payments

1. Extend the journal to the actual donor/PayPal write paths. Persist authorized organization and donor identity, stable business keys, exact consent and source reads, targets, amounts, currencies, PayPal request IDs and every financial leg. The current procurement journal does not protect donor actions across restarts; a local JSONL file on Render's free filesystem is insufficient.
2. Extend durable sessions and restart reconciliation to every real financial path. Sandbox checkout already retains approved state and stable per-vendor identities, but no automatic worker restores interrupted donor operations or resolves a lost checkout key. Interrupted operations remain unknown until authoritative provider reads establish their result. Never replace an uncertain operation with a fresh identity. Reconcile every Covered Month or supplier leg independently. A refund is compensation, not an atomic rollback.
3. Add durable webhook processing and reconciliation beyond storing the verified delivery. Handle retries and out-of-order events idempotently, connect events to the correct organization and operation, and test recovery after instance replacement. A durable inbox alone does not update or restore donor state.
4. Replace the shared demo PIN and fixed subscription with donor-specific verification and proof of subscription ownership. Enforce organization and staff authorization. A browser call-session secret protects that call's API; it does not prove a real donor's identity.
5. Establish sponsor authority and merchant permissions, including the permitted amount, currency, recipient, expiry and use count. A configured sponsor authorization ID alone is not a complete authorization policy.
6. Configure a verified merchant account, separate production credentials, HTTPS and a production webhook with the exact required permissions. Confirm any applicable platform and seller onboarding approvals with PayPal. Do not reuse sandbox credentials or objects.
7. For procurement, verify independent supplier identities, contracts, quote authority, stock, delivery and refund terms, and applicable PayPal seller/platform permissions. Authenticated MCP transport and controlled reference endpoints do not establish real business participation. Complete the sandbox acceptance flow against exact registered merchant IDs before seeking production approval. Preserve separate buyer approvals and unknown or partial outcomes; independent supplier payments are not atomic.
8. Run concurrency, duplicate delivery, process-crash-after-write, reconciliation and restore tests for the integrated real provider paths against the transactional backend. Validate backups and runtime role permissions. Then perform a controlled, explicitly authorized low-value live acceptance test and verify settlement and refund behavior in the production account.

## Operation journal contract

The original PostgreSQL adapter reserves mock procurement operations under a unique organization/business key. The separate checkout store freezes the approved sandbox plan and per-vendor create/capture request IDs, commits claims before provider writes and blocks fresh attempts after an unknown result. Confirmed captures require authoritative PayPal order/capture reads. Neither store currently replaces the donor PayPal ledger. [The database guide](docs/DATABASE.md) covers explicit administrator migrations and restricted runtime credentials; [commerce setup](docs/COMMERCE.md) describes the sandbox workflow and missing acceptance evidence.

Production dispatch must supply authenticated organization and donor identity, preserve the same business and provider request IDs across restarts, reconcile unknown attempts from authoritative reads, and advance only from confirmed outcomes. The shared demo organization does not provide production tenant authority, and the local donor ledger does not provide cross-restart donor recovery.

No environment boolean can replace these requirements. Until they are implemented and validated, keep the sandbox host guard intact.

## PayPal references checked November 4, 2026

- [Move your app to production](https://developer.paypal.com/api/rest/production/) describes live credentials, a verified account, production endpoints and live settings.
- [Platforms and marketplaces overview](https://developer.paypal.com/platforms/overview) says sandbox integrations can be tested with a standard developer account and that platforms apply for live credentials and approval.
- [Multi-seller payments](https://developer.paypal.com/platforms/checkout/standard/customize/multiseller-payments) requires buyer approval, uses CAPTURE intent, and documents partial completion and timeout handling. It does not make an all-or-nothing purchase across independent suppliers.
