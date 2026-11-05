# Read-only checkout recovery controller

`src/checkout-recovery.js` schedules reconciliation of existing uncertain sandbox
workflows. It cannot create an order, approve a buyer, capture, refund, cancel an
order, replace an identity or advance a later payment. Construction is inert and
`enabled` defaults to false. Runtime construction is inert. Only the exact private
environment value `CHECKOUT_RECOVERY_ENABLED=true`, together with
`PROCUREMENT_SUPPLIER_MODE=mcp-sandbox` and configured PostgreSQL, creates the
controller. The server starts it after successful HTTP listen. Mock mode never
creates it, even with the switch set. No migration or provider probe occurs at
construction, and the switch does not enable checkout writes.

The controller has no PayPal client or financial-method option. It accepts these
narrow callbacks:

| Callback | Contract |
| --- | --- |
| `listCandidates({ after, limit, signal })` | Return `{ ids, nextCursor }`. IDs are unique, ascending canonical UUIDs, strictly after the supplied cursor. Return `nextCursor: null` at the end, or the last returned ID when another page remains. Return no workflow bindings or session hashes. |
| `withLease({ signal }, work)` | Acquire a transaction-level, organization-scoped advisory lease. Invoke `await work(leaseSignal)` exactly once only when acquired. Return `{ acquired: true }` after work drains and lease cleanup completes, or `{ acquired: false }` without invoking work when busy. |
| `reconcileExisting({ id, signal })` | Reuse the existing authoritative order/capture reconciliation and return its public checkout state. Propagate the signal through every read and OAuth request. Never expose financial methods to this callback. |

The store's candidate query filters by the fixed HTTP organization
`demo-organization`, requires `blocked_reason IS NULL`, and requires
a known order ID plus a claimed/unknown creation or capture attempt. Ordinary
untouched workflows waiting for buyer approval are not candidates. A lost creation
with no order ID remains uncertain and cannot be discovered or replayed by this
controller. All latched blocked workflows, including `closed_unpaid`, are excluded.
Closing a plan in the app is separate from provider cancellation.

The store uses `pg_try_advisory_xact_lock` on a dedicated held transaction, rather than a
session advisory lock on a transaction-pooled Neon connection. The lease must not
hold workflow row locks while provider reads run; existing reconciliation persists
through its own row-locked transactions. The key is an organization-derived signed
64-bit digest. One store holds at most one lease connection during provider work,
leaving four of the pool's five connections available. Connection errors abort
`leaseSignal`; the callback fully drains before rollback and connection release.
Duplicate reads following an unexpected lease loss remain read-only.

Recovery SQL has a two-second statement timeout, one-second lock timeout,
2.5-second client query timeout and fifteen-second idle-transaction timeout.
The existing pool connection timeout is ten seconds. Recovery's signal-scoped
store checks cancellation before and after every query, and exposes only loading,
blocking and authoritative order/capture evidence persistence to reconciliation.
The immutable schema and migration checksum are unchanged; no new grants or DDL
are required.

Recovery owns a separate `createSandboxOrders({ readOnly: true })` instance. Its
only operations are `getOrder` and `getCapture`; it has no creation, capture,
refund or cancellation capability. OAuth and reads use the fixed PayPal sandbox
host, forbid redirects, and have three-second request/body deadlines. The sweep
signal reaches OAuth, fetch and response-body reads. Stopping recovery cannot
cancel the payment client's OAuth cache or requests. A signal-bound wrapper calls
only the existing checkout `reconcile` operation with sandbox writes disabled and
no supplier-quote capability. It does not create replacement identities, retry a
financial operation or compensate an earlier payment.

## Bounds and lifecycle

The default sweep scans at most 30 IDs and reconciles at most three workflows
serially. It advances the cursor over cooling or failed entries and retains
unvisited entries when the three-read limit is reached. Failed or still-uncertain
results back off from 30 seconds to five minutes. The map holds at most 100 entries;
evicted entries can become eligible sooner but remain subject to the sweep limits.
Backoff state is local and resets on process replacement.

Each sweep has a ten-second abort deadline. `stop()` clears future scheduling,
aborts and drains the current operation, and prevents new reads until an explicit
restart. A restart waits for the old operation to drain before scheduling another
sweep. Callbacks must honor cancellation: the controller does not race an ignored
promise and release its lease while that work is still running. Read adapters need
their own bounded network/SQL timeouts and must check the signal before every
request, including when existing reconciliation catches an earlier read failure.
Both SIGTERM and SIGINT share one shutdown promise. HTTP and recovery drain before
the database pool closes. Failed HTTP listen never starts recovery.

`start()`, `sweepOnce()`, `stop()` and `status()` expose scheduling and aggregate
counters. Diagnostics contain constant error codes only, without workflow IDs,
session hashes, credentials or provider response text. A reconciled counter means
the callback returned a non-uncertain state; it does not independently certify a
payment. Only existing verified provider proof can do that.
The public commerce status contains these safe aggregate diagnostics, without
candidate IDs or private workflow bindings.

## Verification scope

The focused command is:

```sh
node --test --test-concurrency=1 test/checkout-recovery.test.js test/checkout-recovery-integration.test.js test/paypal-orders.test.js test/runtime-services.test.js test/recovery-server-lifecycle.test.js test/checkout-store.test.js
```

Fourteen controller tests cover disabled construction, bounded serial work, lease
competition, cursor fairness, capped backoff, private error handling, timer
failure, deadline/lease cancellation, stop/drain and restart. Integration-style
unit cases use the actual `createSandboxCheckout().reconcile` logic with a fake
provider and in-memory persisted record: an expired quote's unknown capture gains
matching authoritative proof after controller replacement, with exactly one
original simulated capture. A changed payee retains uncertainty and accesses no
financial method. A creation without an order ID is excluded by candidate policy.

Additional tests cover the read-only client capability, isolated OAuth caches,
OAuth/body cancellation, organization-scoped ID-only SQL, bounded SQL,
transaction-lease contention and loss/drain, startup-inert runtime wiring,
read-only authoritative proof recovery, cancellation through caught checkout
read failures, successful/failed listen and duplicate shutdown.

`CHECKOUT_RUNTIME_TEST_URL` opts the integration test into the already-migrated
PostgreSQL runtime role. It checks the existing schema, inserts unique-organization
synthetic workflows through the normal store, and verifies real UUID keyset
filtering and competing transaction leases across clients. It performs no DDL or
provider calls. The actual restricted-runtime PostgreSQL run passed five of five
cases, including keyset filtering and competing transaction leases. Independent
code and JavaScript reviews approved the controller and integration changes.
The final schema-reviewed combined suite passed 648 of 655 tests with zero failures and
seven hosted-only skips; separate actual hosted checks are listed in
[VALIDATION.md](../VALIDATION.md). The local integration now enables read-only
recovery against the controlled HTTP supplier lab. Both model providers are
stopped after a failed composed quote request retained its cost reservation;
read-only recovery does not depend on model dispatch or clear that stop. The
original completed workflow restored its exact order/capture IDs in the original
tab after restart. These checks do not establish recovery from an actual hosted
provider timeout, independent supplier participation or live-payment readiness.
