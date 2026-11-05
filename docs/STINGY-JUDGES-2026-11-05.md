# Strict desk review, November 5, 2026

An independent reviewer assessed the implementation and available evidence at **65/90 before the final acceptance and deployment gates closed**. The same reviewer estimated **69–73/90 if those gates and a coherent demonstration were completed**. That range is a conditional judgment, not a new measured score or a guarantee. An 80/90 claim is unsupported without observed target-user results and evidence that the model adds value over a simpler negotiating baseline.

This is one desk review, not an official PayPal or Claude test, and not a fresh three-reviewer panel under the [frozen protocol](AI-EVAL.md#strict-project-judging). The historical panel's 60, 57 and 60 scores remain unchanged in the [November 4 review](STRICT-REVIEW-2026-11-04.md). Do not average a projection with those earlier scores or describe completed tests as automatic judging points. The [current acceptance report](FUNCTIONAL-ACCEPTANCE-2026-11-05.md) is the source for release status; this review is a dated assessment.

## What improved the case

- The app now has a composed Anthropic/Jev-to-PayPal sandbox purchase: 100 shirts, an $800 cap and $676.25 across two confirmed captures. Exact amounts, payee and identities match fresh reads and Neon, and the original tab recovered a process restart between legs.
- Covered Month completed the eligible donor's $25 refund after confirming a $25 sponsor capture. The main subscription stayed active. The action completes in the app rather than ending with staff assignment.
- PostgreSQL donor claims, immutable supplier quotes, signature-verified webhook persistence and restart-verified receipts provide reviewable evidence. They are materially stronger than a conversational demo that only says a payment happened.
- API-key requests use shared spending reservations and durable stops. Models provide proposals and advisory review; they cannot grant payment authority or reinterpret consent.

## What still costs points

| Pain point | Why a strict judge deducts | Highest-value improvement |
| --- | --- | --- |
| No observed target-user benefit | Technical success does not show whether a donor or nonprofit can use the product, or whether it saves time. | With separately authorized willing participants, observe nonprofit/donor tasks and report completion, errors, time and limitations. Record actual feedback without inventing testimonials. |
| Unproven model advantage | The initial-quote comparison is a solver comparison on controlled quotes, not evidence of AI-specific savings. | Freeze unseen briefs, supplier policies, budgets and a deterministic negotiation baseline. Compare feasible completion, total cost, constraint violations, latency and API cost, preserving all failures. Do not reuse exposed routing fixtures as a fresh benchmark. |
| Controlled commerce | Three project-controlled endpoints with one owned merchant do not establish independent suppliers, inventory or fulfillment. | State the lab boundary in the demo. Later validate an authorized independent supplier and its quote, stock, delivery and refund terms. |
| Negotiation evidence is harder to inspect than settlement | Durable payment records prove capture outcomes, but judges also need to understand which negotiation decisions caused the final plan. | Persist an ordered, sanitized negotiation history: initial offer, counteroffer, response, expiry, supplier identity and linkage to the final frozen quote. Distinguish model suggestions from accepted commercial terms. |
| Reviewer flags are not yet a clear user decision aid | “Closer review” can appear as unexplained model disagreement. | Add stable reviewer reason codes tied to quote evidence, with a concise explanation and deterministic constraint results. Keep review advisory and preserve exact consent authority. |
| Competing donor and purchasing stories | Two broad products can make the core contribution difficult to remember. | Lead with donor relief and present purchasing as the extension of the same nonprofit funds, consent and recovery system. Use the [three-minute script](JUDGE-DEMO-2026-11-05.md). |
| Demonstration and delivery evidence | A code suite does not substitute for an accessible build or an honest, reproducible demonstration. | Finish the release gates in the acceptance report, then record one continuous, understandable sequence with a matching evidence fallback. Mark replayed or recorded evidence clearly. |

The negotiation-history and reviewer-reason items are proposed improvements, not claims that this pass implemented them. A new independent comparison, target-user study and current recording have not been produced by this review. More payment attempts or real-money processing would not substitute for that evidence.

The case for 72 is plausible after accepted delivery and presentation, but remains a judgment call. Reaching 80 would require stronger proof of usefulness, differentiation and repeated execution, rather than another feature checklist.
