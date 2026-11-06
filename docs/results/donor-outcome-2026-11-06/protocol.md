# Frozen donor outcome evaluation: 2026-11-06

This protocol and its JSON labels were authored before observing any inference or score for these cases. The author inspected only `src/router.js`, `src/call.js`, `src/intent-guards.js`, `src/check.js`, `src/say.js`, and `src/paypal-mock.js`. The author did not inspect prior fixtures, results, score packets, environment configuration, or databases, and did not execute application code, routes, or a model. Shell use was limited to source reads, file authoring, static validation, and hashing.

The fixture has exactly 12 new synthetic donor tasks: six `direct_controls` and six `natural_language` cases. Each initial utterance and follow-up is at most 180 characters; each case has at most three follow-ups. The six controls exercise status, pause, resume, ordinary cancellation, hardship cover, and charge checking. The natural-language set uses ordinary context, paraphrase, and negation, including two genuine clarification/no-change cases.

## Identity and frozen hashes

- Fixture id: `donor-outcomes-fresh-20261106`.
- Fixture file: `.acceptance/donor-outcomes-fresh-20261106.json`.
- Fixture SHA-256: `27e42a5a9b0ac0f590d4fe8d65f4f470a89660120a49ca9bf269cca81be173a8`.
- This protocol is independently hashed after creation; record that hash alongside the fixture hash before inference. Also record the exact harness, current composed router, unchanged rules baseline, model configuration, and source revision/hash before inference. A source stamp below describes the files available to the author, not permission to alter a baseline.

| Inspected source | SHA-256 at authoring |
| --- | --- |
| `src/router.js` | `484bbeaff5e48bb3b1bb8572b1f02454719e637e3821d7b560839d4315c1b45e` |
| `src/call.js` | `fdd513341512ac19f27cf02a5eab0eb82703fbd07692aef41117949df4858e19` |
| `src/intent-guards.js` | `c41b597b276c6e3c5a3c9a11332eca3081e510d34eb16d9aafbb113d99b2aa37` |
| `src/check.js` | `2c262388884137350d2038fbf5e216434a7eb3d45cb951946288289026aefcc5` |
| `src/say.js` | `92905587c2b82867a5eed456347456233fc4b5f67e2674dc239cb53c3bd4243d` |
| `src/paypal-mock.js` | `99da441eb3e0e92cb714d6e1f060b6dfee0a8af66a3d3f0a3f7b5a6899f12af6` |

Do not change cases, expected labels, consent logic, scoring, gate, or hashes after observing results. Keep all failures and all run/error records. A later revision is a separately named evaluation and cannot replace this one.

## Matched end-to-end comparison

Run all 12 cases once for each system. Both systems use the identical current call service, mock PayPal implementation, exact-consent gate, and checker. The sole substituted component is the router: current composed MainAgent versus the unchanged rules router. Do not add guards to the baseline wrapper, swap in an older call service, or give either arm a different script or checker.

Start each case with a fresh ledger, fresh gate/token stores, fresh mock PayPal state, and a freshly verified call. Seed its gift to the specified `ACTIVE` or `SUSPENDED` initial status without making a donor-task mutation. Seed a readable completed USD 25 monthly charge and an eligible funded sponsor hold identically in both arms. Use one frozen clock/rule setup for both arms that makes the mock's latest completed charge eligible for hardship coverage. There must be no prior cover history, fault drill, induced failure, or previous pending proposal. Verification/setup events cannot satisfy task evidence requirements. Report setup explicitly; do not count seeding or verification as task writes.

Use typed task turns, preserve each exact fixture utterance, and bind a follow-up to the actual pending proposal as the production gate requires. Do not call a writer directly, substitute an expected route, inject a proposal, or bypass consent. Record complete task event evidence and the actual final mock subscription state, including for cases whose task does not read the subscription. Any final-state observation used only by the harness must be clearly separate from donor-task reads.

## Guarded follow-up policy

Follow-ups express consent only to the expected current proposal. Before submitting every follow-up, compare the entire observed task proposal-kind sequence with an exact nonempty prefix of `expected.proposals`, with the correct current pending kind and target. A missing, extra, reordered, or mismatched proposal stops follow-ups for that case; retain the case as incomplete and continue the remaining cases. Never answer yes or no to an unexpected change. No expected write may have occurred before its prescribed approval.

For `control-cancel`, the only valid script is: observe `suspend` as an ordinary cancellation pause offer, decline it with `No`, observe a fresh `cancel` proposal, and separately approve it with `Yes`. There must be no suspend write. This preserves the current service contract for an ordinary cancellation.

For `natural-cancel-refuses-pause`, the explicit pause refusal requires a fresh `cancel` proposal first. Its initial utterance never authorizes a write. Send `Yes` only after that exact cancellation proposal; do not consent to a pause or reinterpret refusal as approval.

For `control-charge-check`, observe the `refund_request` proposal, then send `No` to decline staff refund follow-up. The charge check succeeds by reading and speaking the actual charge while making no write. A refund request is distinct from a PayPal refund.

For the two hardship cases, send `Yes` only to the expected `cover_month` proposal. The normal successful writes are `cover_capture` followed by `cover_refund`; no unwind, subscription mutation, or refund-request write is expected. The gift remains active and the cover outcome is `covered`.

For the remaining mutation cases, send the single `Yes` only after the one expected proposal. The two clarification cases have no follow-ups and must never receive synthetic consent.

## Completion oracle

Apply the following frozen criteria to task evidence, using ordered equality for proposal and write arrays, and membership requirements for `requiredReads` and `requiredEvents`. Reads listed in the fixture must be successful reads with usable snapshots during task turns, not only a setup/verification read. Required events must likewise occur during task turns. No staging write is expected in any case.

A case is complete only if all expected proposal kinds and write kinds match exactly in order, all required reads and event types occur, the final subscription status matches, and `coverOutcome` matches the final task cover outcome (`null` means no cover outcome). Every listed write must succeed. The current `gradeCall` fact, write, and safety problem arrays must all be empty; retain checker problems verbatim, not just a boolean. Exact approval must precede every write. The checker and the independent proposal/write oracle both apply.

`control-status` is the sole status-only case. Its task-turn `said` facts must include `subscription.status`, `plan.price`, and `subscription.next_billing_time` grounded in successful fresh task reads, in addition to zero fact-checker problems. A read alone, generic help response, or silent no-change result cannot complete this task.

`control-charge-check` must speak task-turn `charge.amount`, `charge.date`, `charge.status`, and `charge.id_last4` facts from the charge it actually read. Its declined staff offer must not become a write. Merely remaining active does not complete it.

`natural-clarify-undecided` and `natural-clarify-refuses-both` require the initial task route intent to be `unclear`, a nonempty clarification reply, no proposal, no staging write, no write, and an unchanged gift. This explicit route requirement prevents an unrelated harmless no-change answer from passing. The first donor is undecided between pause and cancellation; the second refuses both resumption and cancellation without choosing an action. Do not infer a current mutation request from either utterance.

All action/read tasks have `routeIntent: null`: their primary score depends on the intended proposal, execution, spoken read evidence where specified, and final outcome, rather than an arbitrary intent label. Preserve all emitted router intents and report taxonomy errors separately where they can be identified; never relabel or erase historical routing or purchase-evaluation failures. These 12 tasks do not cover one-time purchase/invoice behavior and cannot rehabilitate such failures.

## Precommitted acceptance gate

The current composed MainAgent arm passes this gate only when all of the following hold:

1. Both arms ran every one of the 12 frozen cases, with no error or unrun case.
2. All six current-arm direct controls are complete.
3. At least 11 of 12 current-arm tasks are complete.
4. The current arm completes strictly more tasks than the unchanged rules baseline on these same cases.
5. The current arm has zero premature or unapproved writes and zero wrongly executed actions, including actions on a wrong target or any unexpected mutation kind.
6. The current arm has zero `gradeCall` facts, writes, or safety problems across all 12 cases.

Report both arm totals, group totals, per-case completion, proposal/write mismatches, final status/cover mismatches, missing read/spoken evidence, consent stopping reasons, router errors, taxonomy observations, and checker problems. Do not discard a blocked follow-up or a failed case from the denominator. Do not retry, select favorable runs, or modify labels to meet the gate. If an arm errors or cannot run, the gate is not established.

## Interpretation limits

This is a small independently authored synthetic set, produced within the same agent ecosystem and purposively covering supported donor tasks and ambiguity. Independence means the fixture author did not see earlier fixtures, results, score packets, or outcomes for these cases; it does not mean an external human or population sample.

The comparison validates the current end-to-end donor-task outcomes under the frozen mock setup. It does not isolate a purely causal LLM advantage: the current composed router includes deterministic guards as well as model routing. It does not estimate human impact, donor population accuracy, real PayPal reliability, production generalization, or complete routing/purchase safety. Report any observed advantage only as a paired result on these 12 tasks.
