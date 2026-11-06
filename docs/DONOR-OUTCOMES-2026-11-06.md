# Complete donor-task comparison

The current composed agent completed **12/12 scripted donor tasks**, versus **7/12** for the unchanged rules router, in one independently authored synthetic comparison. Both passed all six direct controls. The new outcome gate passed. This is a bounded result with mock payments, not a population accuracy, user-impact or pure LLM advantage claim.

The question differs from intent-label accuracy: can a caller reach the intended proposal, give appropriate separate consent, obtain the intended result and hear facts backed by the record? Both arms used the identical current call service, consent gate, checker and freshly seeded mock PayPal. Only the router component changed. The composed router includes Anthropic, Jev and deterministic guards. No new real or PayPal sandbox payment was made.

## Frozen method and results

An independent test-design agent wrote six direct controls and six context, paraphrase or negation tasks without seeing earlier fixtures or results. The fixture, protocol and helper were frozen before inference. Two common direct-control utterances exactly overlap the earlier November 6 routing set. The six natural-language utterances are not exact matches against that earlier twelve-case fixture, but broader historical fixtures were not exhaustively audited. These are new outcome tests, not twelve wholly unseen language examples. The fixture author's independence is within the same agent ecosystem, not an external human sample.

| Measure | Existing rules | Current composed agent |
| --- | ---: | ---: |
| Tasks run | 12 | 12 |
| Tasks complete | 7 | 12 |
| Direct controls complete | 6/6 | 6/6 |
| Context, paraphrase and negation tasks complete | 1/6 | 6/6 |
| Errors or unrun cases | 0 | 0 |
| Unapproved or wrongly executed changes | 0 | 0 |
| Fact, write or safety checker problems | 0 | 0 |

The precommitted gate required every task in both arms to run without errors, all six composed controls complete, at least eleven composed tasks complete, strictly more completions than rules, no unapproved or wrong executed changes, and no checker problems. Completion checks exact proposal and successful-write sequences, targets, final status and cover outcome, fresh task reads, spoken status/amount/date facts, and the actual mock money state. Clarification tasks must return unclear without a proposal or change.

The harness gives a follow-up only after the expected proposal prefix, current pending kind and target match. Covered Month also requires exact seeded $25 capture/refund terms. It withholds consent for unexpected proposals. Therefore zero wrong executed changes in both arms is conditional on that scripted review policy, not evidence that real donors always reject a wrong offer. Wrong proposals remain failed tasks in the denominator. A virtual clock and direct call-service invocation mean this is not HTTP-arrival timing, voice recognition or human usability validation.

## The cancellation label remains broad

For `natural-cancel-refuses-pause`, the model still returned `stop_gift`. The caller had explicitly rejected a pause. The current policy used that refusal to produce a fresh cancellation proposal, obtained the scripted separate yes, then cancelled the mock subscription. This task passes the frozen outcome oracle, which has no exact route-label requirement for action tasks.

It does **not** make that label `cancel_now`, repair the earlier classification score, or erase the earlier failed zero-wrong-mutation gate. [The earlier routing comparison](DONOR-ROUTING-2026-11-06.md) remains 11/12 versus 6/12 with its original failure. The purchase-drafting and negotiation failures also remain unchanged. Different questions have separate frozen rules and results.

## Evidence, audit and cost

[Fixture](results/donor-outcome-2026-11-06/fixture.json), [precommitted protocol](results/donor-outcome-2026-11-06/protocol.md), [freeze manifest](results/donor-outcome-2026-11-06/manifest.json), [harness source](results/donor-outcome-2026-11-06/harness-source.txt), [overlap audit](results/donor-outcome-2026-11-06/overlap-audit.json), [all outcomes](results/donor-outcome-2026-11-06/outcomes.jsonl), and [summary](results/donor-outcome-2026-11-06/summary.json) are retained. Private raw ledgers and exact frozen source remain archived. Source revision was `499d0ad`.

Two read-only audits verified all 64 frozen source/input hashes and all 24 ledger hashes. The independent fixture author also checked heard scripts, proposal sequences, all sixteen approved mock writes and their matching tokens, spoken source facts and financial outcomes. All three successful mock cover flows captured and refunded $25, with the subscription active. Neither audit made a new model or provider call.

There were eleven attempted requests to each model gateway. Some cases resolve through code-only guards. These counters record gateway invocations, not independently traced HTTP dispatches. The shared allocation counters increased **$0.052358 Anthropic and $0.000290598 Jev**, totaling **$0.052648598**. The original $3/$0.10 completion allocation remained active, with no pending requests and $0.131804/$0.097335856 remaining. These are application counters, not verified provider balances or exclusive invoices. No allocation, earlier spending stop, uncertain reservation or billing setting was reset or increased.

The result supports this composed system on these twelve tasks relative to this existing keyword baseline. It does not establish independent donor benefit, retention uplift, staff time saved, sponsor demand, broad language coverage, superior AI prices or live-money readiness. Model routing takes seconds while rules are local. Further generalization needs different independent evidence, not another run of these now-exposed cases.
