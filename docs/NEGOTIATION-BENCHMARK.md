# Negotiation comparison protocol

This harness compares three approaches under the same synthetic supplier policies, fees, stock, deadline and complete-quantity solver:

1. Initial quotes, without a price reduction. This measures the effect of negotiation; it is not the strongest baseline.
2. The app's current deterministic negotiation, with no model counteroffer. In this controlled lab, a supplier returns its configured floor when no counteroffer is supplied.
3. The actual main agent's bounded counteroffers, complete-plan price guard and advisory reviewer, when explicitly enabled through the existing durable API gateway.

All arms use identical supplier policies and a cap of two negotiation calls per supplier. The guarded strategy checks the default-policy response, then makes at most one model-counteroffer call per supplier. A supplier omitted from model offers reuses its checked default response. The deterministic strategy currently needs only one negotiation call per usable supplier. The initial-price arm still passes through the service's adapter but keeps its response at the initial price. Actual per-supplier and total call counts remain visible; this is not an identical-one-round comparison. The price guard compares complete feasible portfolios and retains the cheaper validated one, preferring the baseline on a tie. Suppliers cannot be allocated twice through alternative quotes.

The model receives no preferred supplier policy or extra stock. Equal guarded prices demonstrate protection against model overpayment, not AI-specific savings. All suppliers here are local software, with no network MCP calls, independent businesses, actual orders, approvals or PayPal payments. The harness never calls `approve`, and its settlement methods refuse all calls.

## Preserved first result

The [first frozen result](results/negotiation-benchmark-2026-11-05.json) is unchanged: the unguarded model matched feasibility but cost $39.05 more than the deterministic negotiator across five comparable orders, with four losses and one tie. It saved $120.89 against initial quotes; that was not AI-specific value. This negative finding motivated the complete-plan guard. It must not be overwritten or relabeled as a guarded result. Version 2 uses a fresh frozen suite after source review; a rerun on exposed version 1 inputs is only a regression check.

## Freeze before running

After implementation and review finish, generate six new cases and their source/fixture manifest. Archive the exact bytes of every hashed runtime source file and the harness before inference; hashes alone do not make an uncommitted implementation reconstructable. Keep the exact fixture private from implementation workers until the run. Source and fixture hashes must still match before a model request can occur.

```sh
node scripts/negotiation-benchmark.js --freeze \
  --fixture .acceptance/negotiation-heldout-v2.json \
  --manifest .acceptance/negotiation-heldout-v2.manifest.json

node scripts/negotiation-benchmark.js --run-offline \
  --fixture .acceptance/negotiation-heldout-v2.json \
  --manifest .acceptance/negotiation-heldout-v2.manifest.json \
  --output .acceptance/negotiation-offline-v2.json
```

The generator varies split capacity, shipping/setup/tax, urgent delivery, insufficient budget, a changed payee and an expired quote. Exact prices and quantities come from a fresh private seed. These are locally constructed synthetic cases, not an externally held-out benchmark or observed target-user evidence. Once the cases or results are exposed, later runs on the same cases are regression checks, not fresh evaluation. Do not change cases after seeing failures or regenerate them until a favorable score appears.

An explicit model run requires the already authorized API-credit configuration. No funding scope is initialized, reset or migrated. The scope must remain `pledge-line-functional-20261105` with the existing $3 Anthropic/$0.10 Jev limits and operator funding attestation. Original stopped scopes remain untouched.

```sh
node --max-old-space-size=128 --env-file=.database.env --env-file=.ai.env \
  --env-file=.acceptance.env scripts/negotiation-benchmark.js --run-model \
  --fixture .acceptance/negotiation-heldout-v2.json \
  --manifest .acceptance/negotiation-heldout-v2.manifest.json \
  --output .acceptance/negotiation-model-v2.json
```

Run only during an exclusive inference window: shared-budget counter differences include any concurrent app inference, so concurrent use invalidates API-cost attribution. There are at most six cases and at most one planner/reviewer pair per case. Existing gateway reservations, fixed provider hosts, explicit API keys and the shared latched spending stop apply. No fallback, automatic provider retry, subscription route or PayPal client is used. A stopped or ambiguous model request interrupts later model cases, which remain in the report as unrun failures. Initial/deterministic cases are still reported.

## Read the report fairly

For every case and arm, report complete feasible quantity, total all-in cents, independently checked constraint violations, elapsed latency, supplier call counts, payment call count and API spending-counter differences. Report all failed and unrun cases. Mean latency names its measured-case denominator so skipped requests do not lower it. The guard records baseline, candidate and selected complete-plan totals, its selected source and avoided overpayment when both plans exist. Compare these with the separate deterministic arm rather than claiming the model beats that baseline.

Version 2 retains allowlisted reviewer reason codes and all nine independent code-check statuses. It distinguishes a confidence-only warning on passing checks from an observed constraint mismatch. Arbitrary messages and reviewer evidence are not copied into public reports. The same frozen review timestamp is used in Jev's supplied state and code checks. These observations make uncertainty inspectable; they do not measure human judgment quality or turn advisory output into payment authority.

The strong supplier-floor baseline determines feasibility only when it completes or returns no feasible quote. If it errors, the expected-feasibility comparison is unknown. The checker independently recomputes monetary totals and compares supplier identity/payee, quote fees, stock/minimums, specification, currency, split policy, expiry and delivery with the fixture policy. A private per-arm record retains each exact issued quote. Selected quote identities and all commercial fields must match that record; missing evidence is unverified, and substituting a cheaper price under an initial quote ID fails. Issued quote objects are not copied into public metrics.

This measures one narrow laboratory capability. It does not establish voice understanding, donor usability, user benefit, independent supplier fulfillment, production readiness or a hackathon score. Publish the frozen manifest and every outcome, including results where the deterministic negotiator is cheaper. Keep new holdouts separate from examples used while implementing the harness.
