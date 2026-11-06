# Official-page requirements and assessment correction

Source: [Build What's Next with PayPal and AI](https://paypalaihackathon.devpost.com/). The user supplied the page's requirements and judging text on November 5, 2026. The automated browser remained in a Cloudflare verification loop, so the excerpt, rather than a successful independent page fetch, is the source for this checklist. Full Official Rules, eligibility and submission deadline still need separate verification.

## Correct judging framework

The supplied page names five criteria:

1. Technological Implementation: skillful, meaningful PayPal and AI use and a working, non-trivial implementation.
2. Design: a complete, coherent product experience.
3. Potential Impact: a credible, specific problem and audience, addressed by what is demonstrated.
4. Innovation/Idea: creativity, novelty and differentiation.
5. Presentation: a clear video showing the project working end to end, with an understandable problem, audience and reason to care.

The page does not prescribe numeric weights or a 90-point scale. For internal evaluation, five equally weighted 1–10 assessments give a total out of 50. An optional linear conversion to 90 is `total / 50 * 90`; it is an internal comparison scale, not an official PayPal score. The user's 80/90 objective corresponds to approximately 44.45/50 under this convention. Evaluator prompts must not include that desired result or prior subjective scores.

The prior nine-part desk and Claude assessments included Stage One likelihood, feasibility, prize-lane fit and personal fit. They remain historical internal planning opinions. They are not an appropriate direct estimate of the official five-category result. In particular, sandbox-only processing is required by the supplied page; missing live merchant onboarding, live credentials, independent fulfillment or an SLA must not automatically be treated as hackathon eligibility failures. Demonstrated security, reliability and truthful scope still matter. No earlier score is being erased or relabeled as an official result.

For clarity, extracting just the five published category names from the historical tables gives the following. These are arithmetic mappings of prior opinions, not new assessments:

| Historical review | Original nine-category median | Median subtotal for the five published categories /50 |
| --- | ---: | ---: |
| [Accepted-release desk panel](STINGY-JUDGES-2026-11-05.md) | 68/90 | 34/50 |
| [First upgrade desk panel](STINGY-JUDGES-2026-11-05-UPGRADE1.md) | 68/90 | 37/50 |
| [Actual text-only Claude panel](STINGY-JUDGES-2026-11-05-FINAL-CLAUDE.md) | 58.5/90 | 34/50 |

The accepted-release and actual-Claude five-category subtotals were identical. The first-upgrade desk panel was more favorable on those categories, but also used a different reviewer method and evidence access. The change in the nine-category totals cannot establish a software regression. The next assessment uses the supplied official categories, the revised working build, actual UI images and its recorded workflow, with historical failures and current limitations retained.

## Submission checklist

| Requirement in the supplied page | Evidence / remaining work |
| --- | --- |
| Meaningful PayPal developer-platform use in the free sandbox | Actual Orders capture, subscription changes, sponsor capture/refund, invoice payment and verified webhook evidence are retained. Live hosts remain rejected. |
| Meaningful AI functionality | Anthropic is the main agent; Jev provides bounded quick routing and advisory review. Language grounding and conversational clarification are being strengthened and independently evaluated. |
| Working prototype with documentation | Existing hosted sandbox and local setup instructions work. New changes need their own final review, tests and hosted acceptance. |
| Functional demo, hosted or complete local setup | Hosted URL plus mock setup instructions are available. A static design alone is insufficient. |
| Public open-source repository with all source/assets/run instructions and visible top-level license | Current integration repository is private; MIT license and bundled font/vendor licenses exist. Prepare and audit a clean public-release snapshot before publication. Do not expose private history, keys, sign-in sessions or acceptance capabilities. |
| Identify models/services and their roles | Document Anthropic, Jev, PayPal sandbox, Neon and Render, including which decisions remain deterministic. |
| Demo video under three minutes, showing the app functioning on its target device | Existing 73-second historical-evidence narration is useful supporting material. Prepare an actual UI workflow recording for the required functioning-product demonstration. |
| Video publicly visible on YouTube and linked in submission | Public upload and submission link are not yet established. Prepare the final artifact before requesting publication approval. |
| No third-party trademarks, copyrighted material or music without permission | Preserve bundled licenses, use original narration and no unlicensed music. Review the actual final recording and release assets. |
| Comply with full Official Rules | The supplied excerpt does not establish all eligibility, deadline or submission-form conditions. |

The supplied awards include Best Use of Agentic Commerce, Best Use of PayPal + AI and overall awards. The product's main demo should remain one nonprofit coordinator's donor-relief workflow, with procurement presented as the staff extension. Do not manufacture users, retention uplift, supplier participation or AI savings to support the pitch.
