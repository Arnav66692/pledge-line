# Integration validation, November 4, 2026

The integration branch combines the approved Covered Month and charge check, PayPal fault drill, mishearing evaluation cases, signed donor receipts and self-resolving donor flow. It also includes consent revalidation, cautious uncertain-payment handling, PIN redaction, call-session authentication and receipt privacy fixes.

## Results

- Full automated suite, 425 passed, zero failed. Run with `TMPDIR=/private/tmp/pledge-test npm test`.
- Mock pilot dry run, all ten scripts passed. This used mock PayPal and the rules router, with the mock ledger outside the pilot ledger.
- Grader comparisons for existing non-drill events are covered by the passing suite.
- Local Chromium typed flow, PIN verification, pause request, exact confirmation, fresh status read-back and goodbye completed against mock PayPal. This does not establish real browser microphone or speech behavior.
- Independent targeted reviewers approved the financial uncertainty fixes, invoice replay prevention, call-session and receipt privacy, and the subsequent validation changes.

Raw test output, mock transcript and a browser screenshot are retained in the workspace handoff under `handoff/results/codex-integration/`. These artifacts contain synthetic data only.

## Not established by these results

This is not a passing real sandbox pilot grade, a real-model claim-audit result, production settlement validation or a deployment. The pilot checkout and Render were kept unchanged. Complete the real pilot and the sandbox-specific acceptance checks in the handoff before release. Production payments remain disabled. See [production requirements](PRODUCTION.md).

The initial combined suite passed 414 of 425 tests. The failing fixtures expected older behavior, including approving changed records and describing uncertain captures as refusals. The fixes retained the stronger consent and uncertainty rules, updated fixtures to reach the intended post-write stage, and removed obsolete current vocabulary entries while preserving historical lists. Independent review found no safety checks weakened.
