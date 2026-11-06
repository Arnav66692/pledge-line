# API connection and billing evidence, November 4, 2026

This is a chronological historical record. Its earlier outstanding-work and allocation statements describe their recorded versions. See [current AI evidence](AI-VALUE-EVIDENCE-2026-11-05.md), the [working demonstration](DEMO.md), and the [later completed guarded checkout](results/guarded-checkout-2026-11-05.json) for subsequent results. Earlier failures and spending stops remain retained.

The explicit Anthropic API key authenticated against the models endpoint and then passed one separately authorized, fixed Haiku 5.5 smoke request. The request was deliberately independent of the held-out composed-agent evaluation. No routing labels, negotiation prompts or evaluation thresholds were changed using its result.

| Observed field | Result at the time of the smoke |
| --- | --- |
| Model | `claude-haiku-5-5` |
| Input / output tokens | 22 / 5 |
| Estimated API charge | $0.0000047 |
| Conservative committed reservation | $0.004492 |
| Authorized ceiling for this request | $0.01 |
| Inference requests | 1, no retry |
| Authentication | Explicit API key; no subscription session, CLI credentials or OAuth fallback |
| Shared durable stop after this request | Not stopped |
| $200 provider balance / funding pool | Unverified at this point |
| Prepaid-only billing attestation | Still false |

The estimated charge uses the model's published small-request price and the API's returned token usage. It is not an account invoice or proof of which credit pool paid it. The API organization associated with the key controls funding. At the time of this smoke, the existing Jev key had authenticated through its models endpoint but had made no new inference through this integration.

`scripts/ai-smoke.js --run` is a narrow, explicit probe. It reserves through the same PostgreSQL budget as the application and cannot enable general inference or attest to billing settings. Do not rerun it merely to reproduce this already successful observation.

## Later signed-in Console check

The user authorized direct computer use of the existing Chrome billing tab. The inspected Console organization showed $0 purchased credits and a $200 promotional API grant labeled `API credit (Ultra)`, granted October 23 and expiring November 25, 2026, in UTC. A later screen showed $199.99 remaining. These are displayed balances, not an attribution of the difference to this project's smoke request.

The billing page showed no payment methods on file and no billing address. It exposed neither a Set up auto-reload nor a Manage auto-reload control. The Buy credits dialog offered a manual purchase and was closed without purchasing anything. No auto-reload configuration was shown and no setting was toggled. The page offered contacting sales to arrange monthly invoicing, rather than showing an active invoicing arrangement.

The grant is linked to Ultra for issuance. It is not an independent purchased-credit pool. Anthropic documents that these grants fund API usage separately from Claude, Claude Code and Cowork plan limits. API usage is never charged to the Claude plan. The grant is used before purchased credits and expires with its billing cycle. If no purchased credits, auto-reload or invoicing arrangement exists, requests stop when the available credit runs out. See [monthly API credit rules](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans) and [API billing guidance](https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage).

The user's authorized $200 API balance therefore has a plan-related origin, while application requests can still use only the API key and separate API credits. Requiring that this grant be unlinked from the plan would exclude the balance the user explicitly asked to use. The relevant boundary is API-credit funding without subscription-session credentials, plan-limit consumption, automatic credit purchases or invoiced overages. The Claude subscription was not changed, canceled or unlinked.

The user again reported a $10 Jev balance and explicitly instructed the project to proceed using that balance. Jev's current billing and automatic-recharge settings have not been independently inspected. The composed-agent evaluation is authorized using a process-scoped `AI_PREPAID_ONLY_CONFIRMED` attestation, based on the observed Anthropic account and the user's Jev confirmation. This is not an assertion that both billing consoles were inspected. [The pre-dispatch billing clarification](AI-EVAL-BILLING-2026-11-04.md) changes no frozen cases, prompts, metrics or acceptance thresholds.

## Actual composed-agent evaluations

Four separately frozen synthetic evaluations completed on November 4 Pacific. Each used 30 routing cases and 10 pending-consent cases. Fresh V4 passed all gates; the first three failures and all inputs/outputs remain preserved.

| Version | Exact routing | Wrong mutation routes | Median / p95, ms | Anthropic / Jev cost | Outcome |
| --- | --- | --- | --- | --- | --- |
| Original V1 | 29/30 | 0 | 4,878 / 6,122 | $0.104846 / $0.00071526 | Failed median latency |
| [V2](AI-EVAL-2026-11-04-V2.md) | 28/30 | 2 | 3,372 / 4,114 | $0.115808 / $0.000718074 | Failed mutation safety |
| [V3](AI-EVAL-2026-11-04-V3.md) | 26/30 | 0 | 3,458 / 4,619 | $0.131506 / $0.000720006 | Failed accuracy |
| [V4](AI-EVAL-2026-11-04-V4.md) | 29/30 | 0 | 3,465 / 4,512 | $0.113278 / $0.000744114 | Passed all frozen gates |

Every run returned unclear on all 10 pending-consent cases with zero provider requests for those cases. V1 made 25 Anthropic and 29 Jev dispatches. Its single incorrect route was code-only unclear, so report model-label counts are not dispatch counts. V2 exposed compound and undecided requests being reduced to one mutation. V3's clarification-only guard prevented wrong mutations but over-clarified four clear requests. No exposed case was relabeled, removed or reused as fresh success evidence.

The original report is `.pilot/ai-evaluation/2026-11-05T05-27-03.380Z.json`; V2 and V3 are `2026-11-05T05-48-17.945Z-v2.json` and `2026-11-05T06-17-18.348Z-v3.json`. These ignored reports are also copied to the handoff evidence directory. Tests use synthetic conversations, with PayPal and supplier calls disabled; they do not measure voice latency or independent user outcomes.

Profiling after V1 found 26 sequential budget SQL calls per provider request. The reviewed optimization reduces that to 16, retaining durable reservation before dispatch, an exact committed-reservation/shared-stop check, and verified settlement afterward. Schema and checksum are unchanged. Actual hosted PostgreSQL budget checks passed 11 of 11. Later guard changes only veto mutation suggestions and cannot establish consent.

The [fresh V4 fixture](AI-EVAL-2026-11-04-V4.md) passed independent blind label review before freezing. Its single actual run passed all conjunctive gates: at least 90 percent routing accuracy (29/30, 96.7 percent), zero wrong mutation routes, ten pending-consent cases returning unclear with zero provider calls, and median below 4,000 ms. The sole miss, `V4-R08`, expected `pause_gift` and returned `unclear`; it was neither relabeled nor removed. Actual dispatches were 25 Anthropic and 30 Jev, while routing paths were 25 Sonnet and five Jev. Settled costs were $0.113278 and $0.000744114 respectively, with no retained reservation remainder.

The report is ignored `.pilot/ai-evaluation/2026-11-05T07-12-59.985Z-v4.json`, also copied to the handoff evidence directory. At dispatch, the frozen fixture and reviewed runtime-manifest hashes matched without discrepancies. A later plan-only schema fix changes `agent.js` outside the tested routing path. The exact V4 source preimage is preserved as `agent-v4-frozen-before-schema-fix.js` in the handoff evidence directory, SHA-256 `d728ca6a50861be2ad0f991942326e89fe7d4c3d57cd3dc787da66f9e8735536`. The prefix before `planNegotiation` and suffix from `reviewProposal` onward are byte-unchanged; routing and its prompts are unchanged. V4 remains evidence for its frozen evaluated routing version. It is a developer-curated synthetic held-out result, not an independent user study, voice result or general safety guarantee. Earlier failures remain evidence.

## Composed quote acceptance and retained spending stops

The first actual composed AI quote-only UI request failed before approval. Anthropic request `8b4e2852-0fcf-439d-8827-b5e37dc8f154` retained its full 51,240,000-nanodollar reservation ($0.05124), and the durable shared `usage_unverified` stop blocked both providers. No Jev proposal review or PayPal write followed. Recorded request-to-stop elapsed time was 712.384 ms, not the twelve-second request timeout. Failure screenshots, status, timing and the retained reservation remain in the handoff evidence directory.

Inspection of Anthropic's [strict structured-output schema constraints](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) and the installed SDK identified unsupported numerical `minimum` and array `maxItems` bounds in the planning tool's transport schema. The narrow correction removes only those unsupported transport bounds; all runtime validation of prices, offer counts and payment constraints remains. It passed 35 offline agent/procurement tests, independent code and JavaScript review, and the final code suite: 655 total, 648 passed, zero failed, seven hosted-only skips (`tests-final-schema-reviewed-2026-11-05.txt`). Its later bounded actual quote test is recorded below.

The user explicitly approved one corrected quote test under separate ceilings of $0.10 Anthropic/$0.01 Jev. At about 11:53 pm Pacific on November 4, a fresh scope, `pledge-line-quote-schema-20261105-bounded`, ran on isolated localhost port 3163 with payment writes and background recovery disabled. Its initialization used restricted INSERTs, no DDL and no mutation of the original scope. Exactly one Find-plan submission called the actual Anthropic planner and Jev advisory reviewer against three authenticated, project-controlled MCP supplier endpoints.

The plan contained 100 shirts for $676.25 within the $800 budget: 60 from Controlled Campus Print lab for $396.50 and 40 from Controlled Club Threads lab for $279.75. The initial-quote baseline was $728.75, a $52.50 difference for this quote set only. This does not demonstrate AI-specific or general savings. Jev flagged the plan for closer review. That advisory result grants no approval and is not proof that a constraint was violated; its underlying confidence was not captured. No approval checkbox or approval request was submitted, no checkout workflow was created and no PayPal payment occurred. All supplier endpoints remain controlled software sharing one owned sandbox merchant, without independent participation or fulfillment.

Exactly one request per provider settled: Anthropic $0.005436 and Jev $0.000108906, total $0.005544906, less than one cent and below the approved combined $0.11 ceiling. No test reservation remained pending. The test scope was then latched with `operator_stop`. Fresh database checks verified the original `pledge-line` stop and full $0.05124 uncertain reservation were unchanged. General model use is not reenabled. Sanitized proof is `approved-composed-quote-result-2026-11-05.json`, with matching PNG/TXT in the parent workspace's `handoff/results/ai-commerce-2026-11-04/`. The test used unchanged application source `bdfd660`; it did not require new application-code tests.

The earlier completed $674.15 sandbox checkout used rules routing and remains separate evidence, so a successful unified model-produced purchase is still unestablished. Its original tab restored the exact completed order/capture IDs after process restart with read-only recovery running. That is saved restoration evidence, not a claim that a live tab remains available. A prior Console check showed $199.53 promotional credits, $0 purchased credits, no saved payment methods and no auto-reload configuration shown; that screen is a balance snapshot, not a settled invoice for the uncertain request or this later bounded test.

## Application spending boundary

Sonnet 5.5 remains the main agent, and Jev remains a restricted reviewer/quick router. The local $5 / $0.25 allocations are project ceilings, not provider balances. Either allocation exhaustion or a provider billing failure latches the stop for both. Unknown usage retains its full conservative reservation. A normal API key cannot provide a synchronous exact-zero signal for spending elsewhere, and requests already in flight cannot be recalled, so exact account-balance enforcement cannot be claimed.

The controlled supplier lab separately completed two buyer-approved PayPal sandbox captures totaling $674.15 test funds, verified by fresh order/capture reads and durable attempt identities. This does not establish independent suppliers or fulfillment. Separate actual hosted checks are recorded in [VALIDATION.md](../VALIDATION.md). Both the original model scope and the separate corrected-quote scope remain stopped. All owned local app and supplier-lab preview services were stopped after the test because disk space fell below the heavy-work threshold. Read-only recovery and completed-workflow restoration do not require model calls when services are restarted. Unified model-produced purchase acceptance and a current hosted voice demonstration remain outstanding. The latest [internal strict review](STRICT-REVIEW-2026-11-04.md), performed before the successful corrected quote, scored 60, 57 and 60, median 60/90. No new panel or automatic score increase is claimed. These are subjective assessments, not official results or guarantees of 72 or 80.
