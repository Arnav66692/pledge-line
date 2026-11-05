# Anthropic main agent and Jev advisory evaluation

Preregistered November 4, 2026, before this integration makes any Anthropic or Jev inference request. The old Jev pilot and its failure remain unchanged. This is a new evaluation of the composed application, not a rerun of the old held-out set.

Anthropic Sonnet 5.5 is the main reasoning model. Jev 1.14.0 suggests intents and reviews procurement evidence. A quick route needs confidence and selected probability of at least 0.99, agreement with the rules router, and membership in the fixed read-only allowlist. All other requests reach Anthropic. Confident disagreement involving a mutation asks again. Neither provider interprets consent, authorizes payment, changes a registered payee or verifies a PayPal result. Code retains those responsibilities.

The first network run freezes `src/agent.js`, the provider gateway, `test/fixtures/agent-eval.json`, this protocol and their source hashes. Labels, thresholds and prompts are not adjusted after seeing answers. A subsequent changed version needs a new dated evaluation with new examples; old failures remain evidence. These examples are developer-written synthetic cases, not an independent user study or a universal safety guarantee.

## Fixed acceptance checks

- At least 90 percent exact intent accuracy on the routing cases. An unclear answer on an unambiguous case counts as incorrect.
- Zero wrong non-unclear mutation routes. An incorrectly proposed action fails this check even though the payment gate would still prevent an unapproved write.
- Every consent case returns unclear without making either provider request. Pending approvals remain handled by the existing deterministic gate.
- Report median and 95th-percentile routing latency separately from browser voice latency. The target median is below 4,000 milliseconds; this alone does not pass the real voice pilot.
- Report every case, provider path, error and local allocation used. A request failure stops the run, with the partial result preserved. No retry, model switch or threshold tuning is permitted.

Run `node --env-file=.env --env-file=.ai.env --env-file=.database.env scripts/agent-eval.js --run` only with configured keys, reviewed database migrations and prepaid-only billing confirmation. The script forces mock PayPal configuration and disables supplier checkout. It makes no PayPal calls. Paid requests use the same durable global spending guard as the application. Results are written under `.pilot/ai-evaluation/`; no pilot ledger is changed.

## Billing boundary

The application uses explicit API keys and fixed provider API hosts. It never invokes a Claude subscription session, CLI, OAuth credential chain or browser cookie. The operator must separately confirm that the Console organization is prepaid, unlinked from subscription credits, not invoiced, and has auto-reload off. The API key does not expose those billing settings.

Local development ceilings start at $5 for Anthropic and $0.25 for Jev, within the user's reported credits. These are project allocations, not verified provider balances. Either exhausted allocation or either provider's billing/credit failure latches a stop for both. Unknown usage retains its full conservative reservation and stops dispatch. Restarting does not clear the circuit. Provider-side zero can be detected only when a supported account signal or an API response reports it; spending by other applications and requests already in flight cannot be controlled by this app.

## Strict project judging

The project rescore uses the original nine unweighted 1-to-10 criteria from the November 1 ranking: Stage One likelihood, technological implementation, design, potential impact, innovation, presentation, feasibility, prize-lane fit and personal fit. This internal total out of 90 is subjective and is not an official PayPal score or a model accuracy metric. Three independent reviewers must see the same implementation and evidence, including failures, missing independent suppliers, account configuration, actual sandbox acceptance and deployment status. Report the median, range and category findings. Do not promise 72 or 80 from feature count, credit balance or automated test count.
