# Fresh donor-routing comparison

The current composed agent classified **11 of 12** new synthetic donor requests correctly, versus **6 of 12** for the unchanged keyword router. Its **registered gate failed** because one wrong mutation classification remained. All four separate pending-consent guard cases returned unclear with **zero attempted provider requests**. No payment or donor call was executed by this evaluation.

An independent test-design agent authored six direct controls and six ordinary context, negation and paraphrase cases without reading previous fixtures or results. The exact fixture and gate were frozen before inference. Independence here means another agent task in the same system, not external donors, researchers or a random sample of calls. The fixture SHA-256 is `0b0b1ef6568ec7e1d4c292c61dfe998a63928f1543b6e1e0021daee66e464a82`.

The gate required at least 11/12 correct, strictly more correct than rules, zero wrong mutation routes, and four pending-consent results with zero provider attempts. All 16 cases ran once, with zero errors and zero unrun cases. The agent made 12 Anthropic and 12 Jev gateway request attempts. The rules router made none. The AI path took seconds per request, while rules ran locally. These costs and latency matter even where semantic classification improves.

The six direct controls were correct in both arms. Five context/paraphrase cases were correct only in the AI arm. Both arms missed the final case below. No case was correct only in the rules arm. This small, purposive set does not establish population accuracy, a statistically secure general advantage, independent user benefit or retention improvement.

## The failure and the separate repair

The caller said, “I don't want a pause; please cancel my monthly gift now.” The expected classification was `cancel_now`. The AI returned `stop_gift`; rules returned `pause_gift`. Both were wrong under the frozen label. The AI's ordinary cancellation label could cause the call service to offer a pause after the donor had already rejected that option.

The repair is in call policy, not the evaluation labels or model output. When the router suggests ordinary cancellation, the call service checks for exactly one affirmative stop request and an explicit refusal of a pause, without unresolved alternatives. It then proposes cancellation directly. It still reads the subscription and requires a separate exact yes before writing. Merely refusing a pause, asking a read-only question, choosing another action or remaining undecided cannot select this exception.

Five regression tests cover the refusal variants, separate consent, unchanged ordinary-cancellation behavior and negative cases. These are exposed-case repair tests. They do not turn the recorded 11/12 into 12/12, erase the failed gate or establish a new fresh model result. No second paid run was performed.

## Evidence and allocation

[All case outcomes and summary](results/donor-route-fresh-2026-11-06.json) retain the original classifications, expected labels, errors, counts and allocation observations. Exact source and inputs are archived privately under the recorded hashes. The source at execution was `f2a31f8`, before the call-policy repair.

The original, still-active completion allocation remained $3 Anthropic and $0.10 Jev. The shared counters increased $0.053654 and $0.000297318 respectively. These are shared application counters, not exclusive provider invoices or verified credit balances. The remaining application allocation was $0.184162 Anthropic and $0.097626454 Jev, with no pending requests. No scope, prior stop, uncertain reservation, allocation, billing setting or payment permission was reset or increased.

Historical purchase-drafting, negotiation and routing failures remain in their original reports. Donor routing is a different task from extracting a complete purchase brief. This result must not be used to claim that the purchase-drafting gate passed or that AI negotiation produces a better price.
