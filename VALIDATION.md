# Integration validation, November 4, 2026

The integration branch combines the approved Covered Month and charge check, PayPal fault drill, mishearing evaluation cases, signed donor receipts and self-resolving donor flow. It also includes consent revalidation, cautious uncertain-payment handling, PIN redaction, call-session authentication and receipt privacy fixes. The November 4 addition is a simulated multi-vendor supply desk with a connected Neon PostgreSQL journal.

## Results

- Full automated suite, 464 tests: 462 passed, zero failed, two hosted-only cases skipped. Run with `npm test` without `DATABASE_TEST_URL`.
- Separate hosted run against the connected Neon PostgreSQL 17 development database: ten tests passed, zero failed or skipped. This exercises the actual journal with synthetic records and simulated suppliers, including 32 concurrent requests through the five-connection runtime-sized pool, immutable approved terms, one-attempt claims, unknown-outcome recovery, duplicate webhooks and prohibited SQL writes. A deliberately held row lock fails closed and the same operation can be retried after release.
- An earlier hosted stress run with 16 connections reached the journal lock timeout. Its failure is retained alongside the successful runtime-sized run. The current result does not establish capacity above the configured five-connection pool.
- Restricted runtime connection: certificate-verified TLS, synchronous commits, matching migrations 1 and 2. Runtime DELETE, schema creation and migration metadata modification privileges are absent. Neon reports compute-local `fsync=off`; its remote WAL quorum is the durability model. See [database details](docs/DATABASE.md).
- Mock pilot dry run, all ten scripts passed. This used mock PayPal and the rules router, with the mock ledger outside the pilot ledger.
- Grader comparisons for existing non-drill events are covered by the passing suite.
- Local Chromium typed flow, PIN verification, pause request, exact confirmation, fresh status read-back and goodbye completed against mock PayPal. This does not establish real browser microphone or speech behavior.
- Chromium supply-desk walkthrough against the actual Neon journal: 100 simulated shirts split 60/40 across two suppliers for $674.15 within an $800 budget. A lost mock payment response was reconciled using the original identity. A pending mock payment blocked later settlement and a new plan; explicit recheck confirmed it and continued the originally approved second leg. Desktop and 390-pixel mobile captures are retained; the mobile document has no horizontal overflow.
- The seven UI regression tests also passed in UTC, Los Angeles and Kolkata, including default-deadline boundaries and clock-change weeks.
- Independent targeted reviewers approved the financial uncertainty fixes, invoice replay prevention, call-session and receipt privacy, and the subsequent validation changes.

Earlier raw test output, mock transcript and a browser screenshot are retained in the workspace handoff under `handoff/results/codex-integration/`. Current local/hosted output, connection check and supply-desk browser evidence are under `handoff/results/neon-procurement-2026-11-04/`. These artifacts contain synthetic data only. Credential files are ignored and are not evidence artifacts.

## Not established by these results

This is not a passing real sandbox pilot grade, a real-model claim-audit result, production settlement validation or a deployment. Procurement has no real supplier/MCP or PayPal settlement connection. Its sessions remain in memory; the donor ledger and financial guards remain local. The hosted tests do not establish backup restore, quota behavior, cold-start latency or live-provider recovery. The pilot checkout and Render were kept unchanged. Complete the real pilot and the sandbox-specific acceptance checks in the handoff before release. Production payments remain disabled. See [production requirements](PRODUCTION.md).

The earlier donor integration suite passed 425 of 425 tests after fixes. Its initial combined run passed 414 of 425: failing fixtures expected older behavior, including approving changed records and describing uncertain captures as refusals. The fixes retained the stronger consent and uncertainty rules, updated fixtures to reach the intended post-write stage, and removed obsolete current vocabulary entries while preserving historical lists. Independent review found no safety checks weakened.
