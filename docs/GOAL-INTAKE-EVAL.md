# Goal interpretation evaluation protocol

This evaluates a language task, not price negotiation. Both approaches receive the same goal, explicit reference time and IANA time zone. Their only output is a draft RFQ that requires human review. No supplier, PayPal, approval, checkout or financial method is available to this harness.

## Baseline and labels

The deterministic baseline is implemented before freezing private instances. It handles explicit quantities, common number words, USD amounts, simple final corrections, ISO timestamps, calendar dates with times, tomorrow, named weekdays with an explicit clock time, and explicit split permission. It refuses unresolved ambiguity, unsupported currencies and missing delivery dates or times. Unspecified currency defaults to USD with the declared `currency_usd` assumption. Unspecified split permission defaults to one supplier with `single_supplier_default`. It is an explicit-field grammar, not an empty baseline or a model-generated answer key.

The twelve-case construction has six ready-to-draft families and six clarification families. Families are public and known during implementation. Fresh numeric instances are generated only after implementation and review, using a private random seed. This is a small synthetic evaluation, not externally held-out language, target-user validation or a universal language-understanding benchmark. The parser may tie or beat the model; report that outcome.

The readiness policy requires quantity, total USD budget, delivery date and delivery time. No hidden 17:00 default is accepted. A date-only request requires clarification. Labels separately record declared currency/split assumptions. Goals with unsupported currency or instructions to bypass approval do not acquire payment authority.

## Measurements

- Correct outcomes across all twelve cases.
- Complete correct drafts on ready labels, with exact quantity, budget cents, currency, delivery instant and split policy.
- Appropriate clarification on the six not-ready labels. Bounded synonym checks must mention at least one preregistered missing constraint (quantity, budget, delivery date/time or supported currency); unrelated nonempty text fails. This checks topic, not full conversational quality.
- Known wrong confident fields on ready labels, plus premature-ready cases on clarification labels. A clarification label does not provide a full field oracle, so the harness does not invent five incorrect-field labels for it.
- Malformed or authority-contract-violating outputs, latency, shared-scope API deltas, errors and unrun cases. Known API deltas and cases with unmeasured costs are reported separately; unknown costs are not labeled zero.

Equivalent ISO offsets represent the same delivery instant. Basic shirt/tee synonyms do not cause a merchandise-marker false failure. Description-fragment presence is only a minimal fidelity check. It does not prove that a paraphrase preserved every material, print or quality detail, or that it invented none. Such drafts still require user review. The harness does not establish automatic semantic fidelity or actual user benefit.

## Freeze and run

After code review, archive the bytes of every hashed runtime file and this script. Then freeze a fresh private fixture and manifest. Source hashing recursively includes all `src/*.js` files, so added helpers and changes are rejected, as are modified fixture bytes. Files are created exclusively rather than overwriting an exposed suite or report.

```sh
node scripts/goal-intake-eval.js --freeze \
  --fixture .acceptance/goal-intake-v1.json \
  --manifest .acceptance/goal-intake-v1.manifest.json

node scripts/goal-intake-eval.js --run-offline \
  --fixture .acceptance/goal-intake-v1.json \
  --manifest .acceptance/goal-intake-v1.manifest.json \
  --output .acceptance/goal-intake-offline-v1.json
```

Actual model execution is optional and requires explicit authorization to consume the existing API-credit allocation. It uses only the existing `pledge-line-functional-20261105` scope, with the already established $3 Anthropic and $0.10 Jev caps and prepaid-only attestation. It does not initialize/reset a scope, clear a stop, migrate a schema, call a subscription credential chain, choose an alternate provider or retry a failed model request.

```sh
node --max-old-space-size=128 --env-file=.database.env --env-file=.ai.env \
  --env-file=.acceptance.env scripts/goal-intake-eval.js --run-model \
  --fixture .acceptance/goal-intake-v1.json \
  --manifest .acceptance/goal-intake-v1.manifest.json \
  --output .acceptance/goal-intake-model-v1.json
```

There is at most one `interpretGoal` call per case. Model failure stops subsequent model calls; failed and unrun cases remain in the denominator. The output path is acquired before billable work. Scope exhaustion, unresolved usage and existing durable stops remain effective. Shared-scope counter changes are attributable to the evaluation only during an exclusive inference window. Concurrent use invalidates that cost attribution.

Do not adjust labels or prompts after seeing answers and call the same instances fresh evaluation. A changed version requires a separately dated, newly frozen instance set with the earlier outcomes preserved. Publish every outcome, including ties, regressions and failures. Numeric extraction success is not price savings, autonomy to pay, a real-money readiness assessment, a user study, an official hackathon score or a guarantee of any score threshold.
