# Strict desk review, November 5, 2026

Three independent internal desk assessments of the accepted sandbox release scored **68, 68 and 67 out of 90: median 68/90**. They incorporated the parent agent's observed hosted results. These are subjective internal judgments, not official PayPal or Claude test results, and the reviewers did not conduct independent live user studies. An earlier provisional assessment of 65 and conditional projection of 69–73 are superseded by these actual final assessments; the projection was not a measured result.

This was a new desk assessment, not a rerun of the [frozen protocol](AI-EVAL.md#strict-project-judging). The historical panel's 60, 57 and 60 scores remain unchanged in the [November 4 review](STRICT-REVIEW-2026-11-04.md). The [current acceptance report](FUNCTIONAL-ACCEPTANCE-2026-11-05.md) is the source for release status.

| Criterion | Reviewer 1 | Reviewer 2 | Reviewer 3 |
| --- | ---: | ---: | ---: |
| Stage One likelihood | 9 | 9 | 8 |
| Technological implementation | 9 | 9 | 9 |
| Design | 7 | 7 | 7 |
| Potential impact | 5 | 5 | 5 |
| Innovation | 7 | 7 | 7 |
| Presentation | 6 | 6 | 6 |
| Feasibility | 8 | 8 | 8 |
| PayPal prize fit | 9 | 9 | 9 |
| Personal fit | 8 | 8 | 8 |
| Total | 68 | 68 | 67 |

The third reviewer deducted one further Stage One point because current eligibility and submission compliance were not independently verified. No reviewer established an official judging outcome.

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
| Negotiation evidence is harder to inspect than settlement | Approved checkouts already retain quotes, comparison, review and timeline through `quoteEvidence`. The complete structured decision trace is less inspectable; unapproved sessions remain in memory. | Retain and display initial offers, exact model counteroffers and rationales, supplier responses and rejection reasons alongside the existing durable accepted evidence. Distinguish model suggestions from accepted commercial terms. |
| Reviewer flags are not yet a clear user decision aid | “Closer review” can appear as unexplained model disagreement. | Add stable reviewer reason codes tied to quote evidence, with a concise explanation and deterministic constraint results. Keep review advisory and preserve exact consent authority. |
| Competing donor and purchasing stories | Two broad products can make the core contribution difficult to remember. | Lead with donor relief and present purchasing as the extension of the same nonprofit funds, consent and recovery system. Use the [three-minute script](JUDGE-DEMO-2026-11-05.md). |
| Current recording and voice evidence | The accepted build is hosted, but a code suite and script do not substitute for a current recorded demonstration or observed microphone journey. | Record one continuous, understandable sequence on the deployed build with a matching evidence fallback. Mark replayed or recorded evidence clearly. |

The negotiation-history and reviewer-reason items are proposed improvements, not claims that this pass implemented them. A new independent comparison, target-user study and current recording have not been produced by this review. More payment attempts or real-money processing would not substitute for that evidence.

The case for 72 remains plausible with excellent presentation and demonstrated usability, but is not established by this release. An 80 claim remains unsupported without stronger proof of usefulness, differentiation and repeated execution. More payment integrations or real-money processing would not supply that evidence.
