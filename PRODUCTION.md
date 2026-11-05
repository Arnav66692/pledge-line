# Production readiness

Pledge Line currently runs against the PayPal sandbox. Real-money processing is disabled in both configuration and the API client. This is an intentional boundary, not a deployment option to bypass.

## Verified locally

The implementation binds each approval to an exact proposed action, re-reads relevant records before execution, requires separate authorization for each call session, and reconciles uncertain responses without treating them as definitive refusals. Covered Month requires a fresh completed sponsor capture before refunding a donor. Uncertain invoice sends cannot be approved again or deleted as routine cleanup. Webhook signatures are checked before acknowledgment and accepted events are synced to the local ledger.

These controls do not establish production readiness. Consult the latest test results and the remaining gates below. Mock tests do not validate a live PayPal account or actual settlement.

## Requirements before enabling live payments

1. Provision a transactional database that survives process replacement. Persist financial operation keys, exact consent terms, organization and donor identity, targets, amounts, currencies, PayPal request IDs, attempts and confirmed or unknown outcomes. Enforce uniqueness and reservations in database transactions. A local JSONL file on Render's free filesystem is insufficient.
2. Add a restart reconciliation worker. Interrupted operations remain unknown until PayPal reads establish their result. Never repeat an uncertain operation with a fresh identity. Reconcile every Covered Month leg independently. A refund is compensation, not an atomic rollback.
3. Store verified webhook deliveries and deduplication state durably. Handle retries and out-of-order delivery idempotently. The local fsync in the demo does not protect against instance replacement.
4. Replace the shared demo PIN and fixed subscription with donor-specific verification and proof of subscription ownership. Enforce organization and staff authorization. A browser call-session secret protects that call's API; it does not prove a real donor's identity.
5. Establish sponsor authority and merchant permissions, including the permitted amount, currency, recipient, expiry and use count. A configured sponsor authorization ID alone is not a complete authorization policy.
6. Configure a verified merchant account, separate production credentials, HTTPS and a production webhook with the exact required permissions. Confirm any applicable platform and seller onboarding approvals with PayPal. Do not reuse sandbox credentials or objects.
7. Run concurrency, duplicate delivery, process-crash-after-write, reconciliation and restore tests against the actual transactional backend. Then perform a controlled, explicitly authorized low-value live acceptance test and verify settlement and refund behavior in the production account.

## Operation journal contract

The durable implementation should reserve an operation under a unique business key before the first remote write. Store the approved proposal, donor and organization, source reads, amount, currency and each authorized leg. Persist each attempt's stable PayPal request ID before sending it. Record the returned identifier and response, or an unknown outcome if interrupted. Read PayPal to reconcile unknown attempts, then advance only from a confirmed state. Reserve and transition operations transactionally so concurrent calls and restarted workers cannot both perform the same financial action.

No environment boolean can replace these requirements. Until they are implemented and validated, keep the sandbox host guard intact.

## PayPal references checked November 4, 2026

- [Move your app to production](https://developer.paypal.com/api/rest/production/) describes live credentials, a verified account, production endpoints and live settings.
- [Platforms and marketplaces overview](https://developer.paypal.com/platforms/overview) says sandbox integrations can be tested with a standard developer account and that platforms apply for live credentials and approval.
- [Multi-seller payments](https://developer.paypal.com/platforms/checkout/standard/customize/multiseller-payments) requires buyer approval, uses CAPTURE intent, and documents partial completion and timeout handling. It does not make an all-or-nothing purchase across independent suppliers.
