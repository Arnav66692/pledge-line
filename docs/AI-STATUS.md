# API connection evidence — November 4, 2026

The explicit Anthropic API key authenticated against the models endpoint and then passed one separately authorized, fixed Haiku 5.5 smoke request. The request was deliberately independent of the held-out composed-agent evaluation. No routing labels, negotiation prompts or evaluation thresholds were changed using its result.

| Observed field | Result |
| --- | --- |
| Model | `claude-haiku-5-5` |
| Input / output tokens | 22 / 5 |
| Estimated API charge | $0.0000047 |
| Conservative committed reservation | $0.004492 |
| Authorized ceiling for this request | $0.01 |
| Inference requests | 1, no retry |
| Authentication | Explicit API key; no subscription session, CLI credentials or OAuth fallback |
| Shared durable stop after this request | Not stopped |
| $200 provider balance / funding pool | Unverified |
| Prepaid-only billing attestation | Still false |

The estimated charge uses the model's published small-request price and the API's returned token usage. It is not an account invoice or proof that the charge came from the reported $200 purchased credit pool. The API organization associated with the key controls funding, including any subscription-credit linkage, auto-reload or invoicing. Console verification remains required. The existing Jev key authenticated through its models endpoint; no new Jev inference has run through this integration.

`scripts/ai-smoke.js --run` is a narrow, explicit probe. It reserves through the same PostgreSQL budget as the application and cannot enable general inference or attest to billing settings. Do not rerun it merely to reproduce this already successful observation.

Sonnet 5.5 remains the main agent, and Jev remains a restricted reviewer/quick router. General paid runtime still requires verified funding and `AI_PREPAID_ONLY_CONFIRMED=true`. The local $5 / $0.25 allocations are project ceilings, not provider balances. Either allocation exhaustion or a provider billing failure latches the stop for both. A normal API key cannot provide a synchronous exact-zero signal for spending elsewhere, so exact account-balance enforcement cannot be claimed.

The [composed-agent evaluation](AI-EVAL.md), buyer-approved PayPal sandbox acceptance and current hosted voice demonstration remain separate checks. A valid key and this one short request do not establish a judging score, real-money readiness or a passing agent evaluation.
