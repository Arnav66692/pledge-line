# Billing clarification before the first composed-agent evaluation

November 4, 2026 Pacific. This addendum precedes the first run of the frozen composed-agent cases. It changes no examples, labels, prompts, confidence thresholds, acceptance gates or scoring rules in AI-EVAL.md.

The signed-in Anthropic Console shows a promotional API grant labeled API credit (Ultra), granted October 23 and expiring November 25 UTC, with approximately $200 remaining, $0 purchased credits, no payment methods and no configured auto-reload controls. No purchase, payment-method addition, subscription cancellation or unlinking was performed.

The prior instruction to use an organization unlinked from subscription credits was too restrictive for this specific, explicitly authorized balance. The grant originates from Ultra, but its API usage is separate from Claude, Claude Code and Cowork plan limits and is never charged to the Claude plan. It is eligible for the Messages API. The project uses explicit API keys only and no subscription session or OAuth credential chain. The user authorized this $200 API balance, not any new purchase.

Source: [Anthropic monthly API credit documentation](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans). The provider spends this grant before purchased credits. Without purchased credits, auto-reload or invoicing, API requests stop when credits run out.

The user reaffirmed a $10 Jev balance and explicitly directed the agent to trust that confirmation and proceed with the build instead of further Jev sign-in checks. Jev funding and auto-recharge have not been independently inspected. The evaluation uses a process-scoped operator credit-use attestation; it does not certify Jev's account settings. No billing setting at either provider is enabled by the application or this evaluation.

Both providers remain inside the same durable conservative allocations, $5 Anthropic and $0.25 Jev. A billing failure, exhausted allocation or unknown usage retains the existing shared stop behavior, with no automatic retry, new credentials or model fallback. Exact provider-balance monitoring for spending by other applications is not established. The initial run remains diagnostic and must preserve failures rather than tune against these examples.

The evaluation forces mock PayPal and disables supplier checkout. It cannot authorize a PayPal transaction or establish real-money readiness. Any later changed model/prompt version requires a new dated evaluation with fresh examples under the original protocol.
