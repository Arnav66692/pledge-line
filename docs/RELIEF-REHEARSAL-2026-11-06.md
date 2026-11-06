# An inspectable donor-relief rehearsal

Open `/rehearsal` to run the donor-relief flow without credentials or external service calls. The visitor chooses a gift from $1 to $50 and one of six situations: successful coverage, no consent, a changed charge, refused sponsor funding, a lost refund response, or an unresolved refund.

Each request constructs fresh mock PayPal records, an in-memory ledger, one-time tokens and a rules router. It invokes the existing `createCallService`, consent gate, Covered Month execution, `gradeCall` and `buildReceipts`. It cannot accept production dependencies, credentials, free-form tasks or external URLs. The public POST endpoint has a separate 12-per-minute client-address limit and the existing body limit. No real donor calls or records are exposed or modified.

The result shows the actual simulated transcript, financial attempts, sponsor fees, fresh reads and sentence verdicts. An unresolved refund displays **Unresolved**, even though the simulator internally knows its seeded state. A lost response remains a failed response in the timeline when a later read establishes completion. The view does not convert either event into another refund attempt.

Five checks cover sponsor confirmation before a refund attempt, exact offered amounts, fresh consent, backed financial claims and core safety checks. These exercise the current code on six bounded scenarios. They are not a model-performance evaluation, a production persistence/restart test, a voice study, a provider outage or independent donor evidence. The simulated clock is fixed to November 3, 2026. The page links separately to the retained actual sandbox payment evidence and signed receipt.

Validation on November 6:

- All six scenarios passed, including two financial attempts and one refund for lost-response recovery, no writes after a changed charge or without consent, and no donor-refund attempt after sponsor refusal.
- Concurrent runs retained separate amounts, money records and consent. Invalid inputs and adapter/configuration injection were rejected.
- HTTP acceptance passed with production calls and PayPal replaced by throwing proxies. The real app ledger remained empty. GET returned 405 and the thirteenth request in the rate window returned 429.
- Full serial suite: 1,018 tests, 1,009 passed, nine optional integration skips, zero failures. This run did not enable hosted integration opt-ins.
- Desktop and 390-pixel browser checks showed the covered and unresolved states with no horizontal overflow. A review found a stale result after a subsequent failure. The fix clears the old result before dispatch and was independently approved.

The local raw suite log is `.acceptance/rehearsal-full-suite-20261106.log`. Historical scores and failed AI evaluations remain unchanged. This feature alone establishes no new judging score.

## Delivery refinements

The phone uses a native situation selector and brings the completed result into view. The conversation remains available in a disclosure, initially closed on phones. All six desktop radio choices and mobile options stay synchronized. Navigation and footer links have 44-pixel target heights. Old results clear before a subsequent request, including failed requests.

The receipt link now opens the correct evidence chapter on a cold `/demo#verify` load and on a known fragment change, without making a verification or payment request. Unknown initial fragments fall back to the first chapter. Two additional tests cover these behaviors. The current full suite records **1,025 tests, 1,016 passed, nine optional integration skips, zero failures**. A previous static-page assertion failed when the historical-only scope wording was updated, then passed with the current scope assertion and additional film integrity checks.

All six hosted rehearsal scenarios returned HTTP200 and passed their checks on the accepted runtime. Health and readiness returned HTTP200. Five hosted UI assets matched local source hashes. The first diagnostic probe returned no saved value and queried incorrect `/health` and `/ready` paths, which returned404. The corrected probe used `/healthz` and `/readyz`. No model or payment operation was performed by either probe.

The demo now leads with a [73-second recording](../web/demo-assets/relief-demo-20261106.mp4), [English captions](../web/demo-assets/relief-demo-20261106.vtt) and [provenance](../web/demo-assets/relief-demo-20261106-provenance.txt). This is one uninterrupted original-speed hosted browser sequence sampled at two frames per second, with original offline narration and persistent scope labels added. It shows four disposable relief scenarios, then checks a retained actual sandbox receipt and rejects an edited copy. It makes no new payment, PayPal query or model request. The movie fully decoded with no errors and its byte and caption hashes are checked by the suite. Original capture source was `bff1430`. An earlier private take stopped when the old receipt deep link hid its chapter, which led to the navigation repair. Failed takes remain private evidence and are not substituted into this recording.
