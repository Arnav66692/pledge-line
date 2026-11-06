# Five-criterion sandbox hackathon assessment protocol

The user supplied the Devpost judging excerpt on November 5, 2026. Its five criteria are **Technological Implementation**, **Design**, **Potential Impact**, **Innovation/Idea**, and **Presentation**. [The requirements record](HACKATHON-REQUIREMENTS-2026-11-05.md) identifies the source and the limits of independent verification. The supplied page gives no numeric scale or weights. Earlier nine-category desk/model assessments remain historical internal opinions and are not relabeled or overwritten.

This protocol uses five equally weighted internal scores from 1 through 10, in half-point steps, for a total out of 50. Code may additionally report the linear comparison `total * 1.8` out of 90. Neither scale nor equal weighting is prescribed by the page. No desired score, prior subjective numerical grade or passing threshold is supplied to the assessor. This is not an official result or a guarantee of winning.

## Rubric and scope

- **Technological Implementation:** skillful, meaningful PayPal and AI use and a working, non-trivial implementation.
- **Design:** a complete, coherent product experience.
- **Potential Impact:** a credible, specific problem and audience addressed by the demonstrated mechanism.
- **Innovation/Idea:** creativity, novelty and differentiation.
- **Presentation:** a clear video showing the project functioning end to end, explaining the problem, audience and reason to care.

Sandbox processing is the required prototype setting. Missing live payments, live credentials, production SLAs or legal merchant onboarding are not invented hackathon requirements. Actual security, correctness, reliability and meaningful integrations still affect the relevant criterion. Independent customer studies strengthen impact evidence but are not a mandatory gate. Do not manufacture customers, savings, supplier participation, adoption or benefits from automated-test totals.

Submission compliance remains a separate factual checklist in the evidence packet and requirements record: working sandbox prototype; meaningful PayPal/AI use; functional hosted demo or complete local setup; public repository/source/assets/run instructions and visible license; identified models/services; functioning-product video under three minutes; public video/link status; asset permissions; full-rule/eligibility/deadline verification. An unknown or pending item must stay unknown or pending. These facts do not create extra scoring categories.

## Fixed evidence and three planned contexts

The private runner is `.acceptance/official-judge-run.mjs`. It uses one factual packet at `.acceptance/official-judge-evidence.json`, without previous subjective grades or desired outcomes. Include relevant positive and negative acceptance/evaluation evidence, deployment version, truthful supplier-lab limitations and submission status.

`.acceptance/official-judge-images.json` must contain exactly three `{ "file": "project-relative.jpg", "label": "bounded caption" }` entries. The runner reads those exact JPEG bytes and embeds base64 image blocks; it does not fetch URLs, use image caches or claim to watch a linked video. Each image is at most 24 KiB; the total is at most 48 KiB. Captions are at most 200 characters. The visual gateway validates JPEG metadata, dimensions and its own media restrictions before reserving money. The runner additionally checks file extension, JPEG signature and byte bounds.

Optional `--provenance path/to/manifest.json` has exactly three entries `{ "file": "same-final.jpg", "sourceFile": "native.png", "transformation": "bounded description" }`. Final and native paths must stay inside the project, use no symlink components and have the allowed extension and image signature. Native sources may be JPEG or PNG, at most 8 MiB each. Their actual hashes/bytes and declared transformation are retained. A declaration is recorded provenance, not proof that the transformation was independently verified.

The three planned requests use identical system text, tool schema, factual evidence and image bytes. Each has a fresh single user message, with no earlier reviewer answer or score in its context. The fixed model is Sonnet 5.5 through the existing guarded `anthropicVisualReview` method, with a 30-second timeout and at most 2,048 output tokens. These are three samples of one model version, not an independent human panel. The model sees three keyframes plus text/transcript, not the full video, motion, audio or live browser. Report that limit when interpreting Design or Presentation.

Each response must submit the five exact criterion names, valid half-point scores, reasons of 1–500 characters, and exactly three distinct remaining deductions of 1–350 characters. Code computes totals, medians and ranges; no model-provided total is trusted. Preserve every planned outcome, including malformed responses, failures and unrun calls. Report missing samples instead of presenting a partial median as a completed panel.

## Freeze, archive and credit preflight

No actual freeze or model call occurs during development/self-tests. After review and final acceptance evidence, the operator freezes the exact request, evidence/list/image hashes, optional native provenance, recursive `src/*.js`, runner, this protocol and the requirements record. Exact bytes for every hashed file are archived privately. Added/removed/changed runtime files, changed evidence/images/request or changed archive bytes cause refusal before the next call.

```sh
node --max-old-space-size=96 .acceptance/official-judge-run.mjs --freeze \
  --manifest .acceptance/official-judge-v1.manifest.json \
  --archive .acceptance/official-judge-v1-source-snapshot \
  --provenance .acceptance/official-judge-image-provenance.json
```

Omit `--provenance` only when none is available. Freeze/archive/report paths are exclusive; earlier files are never overwritten. Private files use mode 600 and archive directories mode 700.

Preflight reconstructs the gateway's exact JSON body, including its fixed model, `thinking: {type: 'between_tools'}` and `output_config: {effort: 'low'}`. The body must be at most 96 KiB. The conservative input bound is `wireBytes * 4 + 8192 + imageCount * 8192`; reservation is `inputBound * 2000 + max_tokens * 10000` USD nanodollars, capped at $1 per request. These numbers match the hashed gateway source and are not an estimate of actual billed tokens. Record the three-call worst case and whether the current remaining allocation covers it. Before every call, require no pending requests, an active scope and enough current Anthropic remaining allocation for that one conservative reservation. Jev must also retain a positive allocation because the existing circuit stops both providers at either exhaustion. Shared use can prevent later planned calls; do not add funds, reset, switch scope or retry to hide that outcome.

Actual calls use only the existing `pledge-line-functional-20261105` allocation: $3 Anthropic and $0.10 Jev, explicit API keys, and the existing prepaid-only attestation. No scope initialization/reset, schema migration, stop clearing, subscription credentials, alternate provider or retry is available. Existing provider billing failures, durable stops and unresolved reservations stay effective. This harness invokes no supplier, quote, approval, PayPal or financial-action method.

```sh
node --max-old-space-size=96 --env-file=.database.env --env-file=.ai.env \
  --env-file=.acceptance.env .acceptance/official-judge-run.mjs --run \
  --manifest .acceptance/official-judge-v1.manifest.json \
  --output .acceptance/official-judge-v1.jsonl
```

The exclusive output file is opened before database/provider work. Each request-start barrier and each outcome is fully written and fsynced before proceeding. Raw validated tool assessments are retained privately. Malformed provider captures are bounded and sensitive-pattern-redacted, with a hash of the original serialized response; no raw provider error message, API key or environment file is printed. A gateway/accounting/preflight failure stops subsequent calls, which remain explicit `not_run` records. A malformed settled response is retained as its planned outcome, with no retry; subsequent preplanned fresh contexts may still run if the guard remains active.

Before/after counters are shared-scope allocation observations, not exact own-request charges or verified provider-credit balances. Preserve unknown accounting as unknown. Do not infer that unrelated applications cannot spend the provider's balance. Do not tune prompts/labels after seeing scores or discard unfavorable samples. Any changed evidence or implementation requires a separately identified freeze, preserving all previous results.
