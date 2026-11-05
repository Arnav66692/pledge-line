# API connection and billing evidence, November 4, 2026

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

## Composed procurement acceptance: failed, shared stop retained

The first actual composed AI quote-only UI request failed before approval. Anthropic request `8b4e2852-0fcf-439d-8827-b5e37dc8f154` retained its full 51,240,000-nanodollar reservation ($0.05124), and the durable shared `usage_unverified` stop blocked both providers. No Jev proposal review or PayPal write followed. Recorded request-to-stop elapsed time was 712.384 ms, not the twelve-second request timeout. Failure screenshots, status, timing and the retained reservation remain in the handoff evidence directory.

Inspection of Anthropic's [strict structured-output schema constraints](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) and the installed SDK identified unsupported numerical `minimum` and array `maxItems` bounds in the planning tool's transport schema. The narrow correction removes only those unsupported transport bounds; all runtime validation of prices, offer counts and payment constraints remains. It passed 35 offline agent/procurement tests, independent code and JavaScript review, and the final schema-reviewed full suite: 655 total, 648 passed, zero failed, seven hosted-only skips (`tests-final-schema-reviewed-2026-11-05.txt`). This correction has not passed a new paid acceptance request.

The original stop and reservation remain intact. User approval is pending for one separate test allocation capped at $0.10 Anthropic/$0.01 Jev; the pending request does not authorize a model call. The original completed sandbox checkout used rules routing, so it does not establish a successful unified main-agent negotiation, Jev review and paid checkout. Its original tab did restore the exact completed order/capture IDs after process restart, while read-only recovery remained running. A later Console check showed $199.53 promotional credits, $0 purchased credits, no saved payment methods and no auto-reload configuration shown; that screen is a balance snapshot, not a settled invoice for the uncertain request.

## Application spending boundary

Sonnet 5.5 remains the main agent, and Jev remains a restricted reviewer/quick router. The local $5 / $0.25 allocations are project ceilings, not provider balances. Either allocation exhaustion or a provider billing failure latches the stop for both. Unknown usage retains its full conservative reservation. A normal API key cannot provide a synchronous exact-zero signal for spending elsewhere, and requests already in flight cannot be recalled, so exact account-balance enforcement cannot be claimed.

The controlled supplier lab separately completed two buyer-approved PayPal sandbox captures totaling $674.15 test funds, verified by fresh order/capture reads and durable attempt identities. This does not establish independent suppliers or fulfillment. Separate actual hosted checks are recorded in [VALIDATION.md](../VALIDATION.md). The local app is configured for Anthropic main reasoning, restricted Jev routing/review, controlled HTTP suppliers and PayPal sandbox, but both model providers remain stopped. Read-only recovery and completed-workflow restoration work independently of that stop. Composed AI quote acceptance and a current hosted voice demonstration remain outstanding. The latest [internal strict review](STRICT-REVIEW-2026-11-04.md) scored 60, 57 and 60, median 60/90. These are subjective assessments, not official results or guarantees of 72 or 80.
