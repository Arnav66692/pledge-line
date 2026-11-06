# Goal-drafting results, November 5, 2026

This page preserves the earlier single-turn V1/V2 evaluation and its deployment. The later [AI evidence review](AI-VALUE-EVIDENCE-2026-11-05.md) records the conversational results, including fresh-eleven's 11/24 model tasks versus 14/24 baseline tasks and the failed improvement gate. Its historical routing comparison is separate evidence, not a replacement for that loss.

The final model-backed draft path correctly handled all twelve new frozen synthetic cases, matching the deterministic explicit-field baseline. This establishes performance on these generated instances, not a model advantage, observed user benefit or general language fidelity. A draft remains editable and requires buyer review before any supplier request. The evaluation has no supplier, approval, checkout or payment methods.

## Preserved first run and correction

The [V1 report](results/goal-intake-2026-11-05-v1.json) records 11/12 correct model outcomes versus the baseline's 12/12. All 30 scored quantity, budget, currency, deadline and split fields were exact, and all six clarification cases were appropriate. Case G-03 omitted the required disclosure that an unspecified currency had defaulted to USD, so its otherwise correct draft failed the full contract. No wrong confident field, premature-ready case, authority violation, malformed result or request error was observed.

The server now adds the default-USD disclosure when a ready draft's goal does not explicitly name USD or US dollars, even if the model omits that assumption. The first result remains intact. New private instances were frozen after the correction and review; V2 is not a relabeled rerun on V1 inputs.

## Final frozen run

| Measurement | Model-backed draft | Explicit-field baseline |
| --- | ---: | ---: |
| Correct outcomes | 12/12 | 12/12 |
| Complete correct ready drafts | 6/6 | 6/6 |
| Appropriate clarifications | 6/6 | 6/6 |
| Exact scored fields | 30/30 | 30/30 |
| Wrong confident fields | 0 | 0 |
| Premature-ready cases | 0 | 0 |
| Authority violations | 0 | 0 |
| Malformed outputs or errors/unrun cases | 0 | 0 |
| Mean latency across twelve measured cases | 5,838 ms | 3 ms |
| Known shared-scope Anthropic counter delta | $0.079046 | $0 |
| Known shared-scope Jev counter delta | $0 | $0 |

The [V2 report](results/goal-intake-2026-11-05-v2.json) retains every outcome and source hash. Fifty-six runtime/harness source files were archived and verified unchanged after inference. Each case received at most one model request, using the existing guarded API-key allocation. No stop or funding scope was reset and no payment was attempted. Counter differences use the scope shared with the app; concurrent outside inference was not independently excluded, so the reported changes cannot be exclusively attributed to this evaluation.

## Browser and restart acceptance

The actual local browser drafted limits for 100 shirts within $800, with an explicit delivery deadline and split permission. The buyer reviewed the fields before explicitly requesting quotes from three controlled MCP suppliers. The complete-plan guard selected $674.15 instead of the model candidate's $676.25. Exact plan approval persisted while PayPal sandbox writes were disabled. After process replacement, the original browser session restored the exact request, proposal, negotiation trace and advisory review. Both supplier legs retained zero order-create/capture attempts and no provider identities; drafting another goal was blocked during the unfinished checkout. The [browser proof](results/goal-browser-2026-11-05.json) preserves this test separately from earlier completed sandbox payment acceptance.

The upgraded software from `9dccdcd89e9d99182ff364b37d7703201acff772` is deployed and passed hosted acceptance. The hosted browser drafted 100/$800 limits with the delivery deadline, split permission and visible USD-default notice. Only an explicit Find-plan action contacted the three controlled MCP suppliers. The guard selected $674.15 over the $676.25 candidate; all nine code checks passed, Jev's low-confidence reason was explained, and no approval or PayPal write followed. The [hosted proof](results/upgrade-hosted-2026-11-05.json) preserves the exact release, deployment, asset and browser observations. It includes an initial HTTP503 and timeout of unknown cause, followed by successful checks.

No new PayPal order or payment occurred in the upgrade. The earlier complete sandbox purchase remains separate evidence.

## Limits

The twelve instances come from known synthetic language families, with six ready and six clarification cases. They are not externally held-out language or target-user tasks. Exact fields and required description fragments do not prove that every paraphrase preserves all material product details or invents none. Clarification topic checks do not establish conversational quality. Both arms must still present the draft for buyer review.

The baseline tied the model and used less latency and no API credits on this set. These results do not establish AI-specific negotiation savings, real-money readiness, a voice study, user benefit or any hackathon score. The [preregistered protocol](GOAL-INTAKE-EVAL.md) describes the baseline, freeze, scoring and failure-retention rules.

The separate [final Claude assessment](STINGY-JUDGES-2026-11-05-FINAL-CLAUDE.md) scored the full deployed project 59, 58 and 58.5/90, median 58.5; the 80/90 target was not met. That fixed text-only review is distinct from this extraction evaluation and the earlier internal desk scores. It cannot establish official competition results or independent user benefit. The [final budget proof](results/upgrade-budget-final-2026-11-05.json) confirms the existing shared allocation remained active with no pending requests and no reset of the original stop; it does not expose provider balances.
