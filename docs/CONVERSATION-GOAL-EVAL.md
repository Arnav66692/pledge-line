# Source-grounded conversation evaluation protocol

This compares language-task completion by the revised main agent and a strengthened deterministic explicit-field parser. It does not compare prices after an exact optimizer already has all supplier floors. Neither arm receives supplier tools, a checkout session, payment authority or a PayPal client.

## Construction before inference

The final suite has 24 independently authored **synthetic** tasks: six explicit controls, six contextual/discourse tasks, six clarification tasks, and six timezone/negation/goods tasks. A separate author receives this contract and supported product limits without implementation, baseline outputs or model outputs. After the offline diagnostic described below, the same author session prepared fresh wording and numeric instances while remaining blind to implementation and outcomes; its earlier authored wording remained available. Their wording and labels are retained without selecting tasks according to which approach wins. This is independent case authorship inside the development process, not independent customers or externally held-out language.

Later rounds reuse the same author session, retaining its earlier wording and schema/policy feedback. New wording does not renew a fully blind or external holdout. Each round must retain its source, original cases, primary outcomes and exposure caveat; any later aggregate-outcome or audit-feedback exposure must be stated. Newly authored cases after substantive changes remain separate from exposed regression cases and do not replace an unfavorable result.

Each task has one to three precommitted buyer turns, an explicit UTC reference timestamp and an IANA organization timezone. Every turn has a ready-or-clarify label. Later turns are delivered identically to both arms even if an arm answered incorrectly earlier. Replies are scripted in advance, rather than chosen after seeing a model question. The current and prior buyer turns are untrusted input; neither arm receives an invented assistant conversation or payment permission. Both approaches have the same three-turn maximum.

A ready label supplies the exact count, total USD cents, delivery instant, split policy, declared default assumptions, and every scored goods requirement. Equivalent ISO offsets represent the same instant. A clarification label names the missing or conflicting constraint. The author must label every turn, including the incomplete original request before a follow-up.

The product's fixed defaults apply to both arms: an unspecified budget currency defaults to **USD**, disclosed with `currency_usd`; unspecified split permission defaults to **false**, disclosed with `single_supplier_default`. Absence of a currency alone does not require a currency question. Unsupported or conflicting currencies can require clarification. These defaults do not identify whether an otherwise ambiguous bare number is a budget or a quantity. An independent post-run audit will document any label-policy mismatch separately; the frozen primary result, including the third round's reported 9/24 model task result, remains unchanged. Errata and diagnostic interpretations must remain separate from that primary result, with no edited-label rerun presented as fresh evaluation.

The JSON contract is:

```json
{
  "version": 1,
  "disclosure": "Independently authored synthetic tasks; no actual-user evidence.",
  "cases": [{
    "id": "C-01",
    "category": "explicit_controls",
    "family": "a short construction label",
    "now": 0,
    "timeZone": "America/Los_Angeles",
    "turns": [{
      "goal": "Buyer text, at most 1000 characters.",
      "expected": {
        "ready": true,
        "rfq": { "quantity": 1, "budgetCents": 100, "currency": "USD", "deadline": "a future ISO timestamp", "allowSplit": false },
        "assumptions": ["single_supplier_default"],
        "requiredSpecificationFacts": [{ "id": "a_fact_id", "anyOf": ["literal fact or preregistered synonym"] }],
        "forbiddenSpecificationFragments": []
      }
    }]
  }]
}
```

The four categories are `explicit_controls`, `context_discourse`, `clarification`, and `timezone_negation_goods`, exactly six each. A not-ready label replaces the ready fields with `{"ready":false,"clarificationFor":["quantity"]}`. Allowed clarification labels are quantity, budget, delivery_date, delivery_time, currency, time_zone, split_policy, specification and source_evidence. A task may use a different fixed reference date to put a daylight-saving transition in the future. Explicit contradictory or nonexistent calendar/time labels must not be treated as valid merely because JavaScript can normalize them.

The fixed harness requires unique task IDs matching `C-01` through two-digit `C-xx` syntax, one to three turns per task, and at most 1,000 characters per turn. Ready turns score one to twelve material goods facts, each with one to four alternatives of at most 100 characters. An author's different ID convention is corrected mechanically before inference in a separate retained artifact; it does not change task content or acceptance rules.

## Strong baseline

The parser is retained and strengthened before private cases are exposed. It handles common numeric and number-word quantities, explicit budget roles, quoted/reserved background amounts, final corrections, bounded prior turns, short time/count replies, ISO timestamps, dates/weekdays and explicit split policy. It refuses unresolved conflicts and unsupported currencies. Known bugs are fixed: impossible ISO calendar rollover, implicit selection of a daylight-saving fold, nonexistent local times, and positive split phrases inside negation. The baseline and main agent use the same independently coded IANA/calendar resolver. An explicit offset may select a repeated local clock time; the parser cannot manufacture one.

The baseline remains an explicit-field grammar, not an empty comparator or an LLM in disguise. It can ask rather than guess when it cannot resolve a statement. That is counted as a missed completion on a fully specified ready label. The structured answer key, not the baseline answer, determines the correct task outcome. Price, stock and hidden supplier information are not supplied to either approach in this language evaluation.

## Measurements and gates

- Correct turns and wholly correct tasks; a task is correct only if **every** labeled turn is correct. Errors and unrun turns remain in the denominator.
- Exact count, budget cents, currency, delivery instant and split policy, separately from complete goods fidelity.
- Every preregistered required goods fact and every forbidden positive attribute. Synonyms are fixed by the author before outputs. Local negation matching avoids calling a phrase such as “no polyester” a positive request for polyester. This is a bounded lexical test, not a complete semantic-equivalence proof.
- Appropriate clarification must address at least one preregistered missing/conflicting constraint through its text or bounded `missingFields`; unrelated nonempty text fails.
- Wrong confident fields on ready labels, premature-ready cases on clarification labels, malformed outputs, explicit authority violations and source-citation validity. A clarification label has no full numeric oracle, so premature readiness is reported without inventing five wrong numeric labels.
- Per-arm turns, model calls, latency, known shared-scope allocation deltas and unmeasured cost cases. Code execution costs are not charged API credits. Model deltas are not called exact account charges or provider balances.
- Paired task wins, losses and ties; Wilson 95% intervals for task accuracy; an exact two-sided paired sign-test over discordant tasks. Report small-sample uncertainty even when point accuracy is higher.

An improvement within this set requires more wholly correct tasks than the strengthened baseline, no explicit-control regression, all six explicit controls correct, zero wrong confident limit fields, zero premature-ready cases, zero authority violations, no malformed or unrun output, no forbidden positive goods attributes, and a complete run. The full-control and additional output checks were already enforced by the frozen harness in round four; this paragraph makes the earlier incomplete prose explicit without changing that decision rule or its retained failed result. Statistical evidence is reported separately; an advantage on 24 synthetic tasks is not automatically a general advantage or observed user benefit. A tie or model loss is retained. No score threshold or desired winner is sent to the agent.

Wilson intervals and the paired sign-test are descriptive calculations under independence and exchangeability assumptions. Those assumptions are not established for this small, deliberately balanced set of related synthetic families. The calculations are not population-confidence claims, and no significance threshold is used to select cases, rerun a result or declare production superiority.

## Freeze, archive and run

Implementation and baseline review precede private-case freeze. The harness hashes all recursive `src/*.js` files, both evaluation scripts, this protocol and exact fixture bytes. Freeze creates an exclusive source-byte archive and a new manifest; existing snapshots, fixtures, outputs and failures are never overwritten. Current source/file inventory, exact fixture and archived bytes must match before billable dispatch.

Before the first billable comparison, an earlier synthetic set exposed a common quantity-parser limitation in an offline run: unfamiliar descriptors between an explicit count and an item noun caused clarification. Its baseline completed 2/24 tasks and none of six explicit controls. That result and its frozen source remain retained; no model call was made against that set. Both production grounding and the comparator were then strengthened with bounded generic descriptors and numerical-role counterexamples using public regressions. A newly authored set, unseen by the implementation workers, is used for the subsequent comparison. The earlier set is diagnostic evidence, not fresh validation of the repaired version. A separate pre-inference schema audit also reduced nine overlong synonym lists to the existing four-alternative limit, preserving all original artifacts and documenting the narrower lexical coverage.

```sh
node scripts/conversation-goal-eval.js --freeze \
  --fixture .acceptance/conversation-v3-authored.json \
  --manifest .acceptance/conversation-v3.manifest.json \
  --archive .acceptance/conversation-v3-source

node scripts/conversation-goal-eval.js --run-offline \
  --fixture .acceptance/conversation-v3-authored.json \
  --manifest .acceptance/conversation-v3.manifest.json \
  --output .acceptance/conversation-v3-offline.jsonl

node --max-old-space-size=96 --env-file=.database.env --env-file=.ai.env \
  --env-file=.acceptance.env scripts/conversation-goal-eval.js --run-model \
  --fixture .acceptance/conversation-v3-authored.json \
  --manifest .acceptance/conversation-v3.manifest.json \
  --output .acceptance/conversation-v3-model.jsonl \
  --private-trace .acceptance/conversation-v3-model.private.jsonl
```

Actual calls require the user's existing API-credit authorization and the same `pledge-line-functional-20261105` allocation, capped at $3 Anthropic and $0.10 Jev. The harness checks schemas but never initializes or resets funding, migrates a database, clears a stop, changes models, tries subscription credentials or switches providers. There is at most one `interpretGoal` call per precommitted turn and no request retry. A model request failure stops subsequent model dispatch; failed and unrun turns stay recorded.

The output is exclusive JSONL. A full write and fsync persist each request-start barrier and each completed/error/unrun turn before another model call. The final summary includes all denominators. Partial interruption leaves the existing lines reviewable. Public records contain bounded numeric/date/boolean output and scored fact IDs, not raw provider bodies or arbitrary source evidence.

For new synthetic runs, a harness-only wrapper observes the existing guarded Anthropic response after its usage was verified and settled, before returning it unchanged to the production agent. It records bounded tool draft inputs, safe model metadata and usage, and SHA-256 identifiers in a **separate private** JSONL stream. No request prompt, request headers or production application event stream is recorded. The optional `--private-trace` path defaults to `OUTPUT.private.jsonl`; its directory must deny group/other access and its file is created exclusively with mode0600. Every frame receives a full write and fsync before a later dispatch. Response indices follow the sequential request order.

Capture frames are at most64KiB. Credential/capability keys, known API-key/bearer/database-URI patterns, emails and long opaque values are redacted; headers are omitted. Oversized/deep diagnostics are explicitly marked truncated and retain a bounded valid-JSON preview rather than claiming a complete capture. This is defensive pattern redaction, not proof that arbitrary text contains no sensitive data. Raw frames remain private until reviewed and must not be copied wholesale into public metrics. The observer is installed only by this synthetic evaluation CLI; production server state and the production agent constructor are unchanged.

A private capture or persistence failure prevents the agent from consuming that response and locally stops both wrapped provider methods. The existing evaluator retains the failed turn and every later unrun model turn. It does not retry, clear a funding stop, change scope, or alter an already verified accounting entry. The bounded public scorer, labels, gates and weights remain unchanged by observability.

Shared scope means concurrent app inference can contaminate deltas. The harness does not claim it excluded outside traffic. No synthetic outcome establishes donor usability, retention, sponsor economics, independent supplier fulfillment, live-money readiness, official hackathon compliance or a guaranteed judging score. A later changed version needs new independently authored cases; exposed cases become regression fixtures.

### Retained final-seven failure and scorer erratum

The final-seven primary run remains unchanged: the model completed no wholly correct tasks out of24, the baseline completed2, and model dispatch stopped after15 calls because one otherwise successful API response contained contradictory split/default fields. One error and21 unrun turns remain in its denominators. A fixed item-noun catalog also rejected the six controls despite correct model quantities. These are software failures, not a provider-balance failure.

A separate post-inference audit confirmed one lexical scorer defect: the removed targets in an affirmative `replace OLD with NEW` or `omit OLD` directive were counted as positive goods attributes. The corrected scorer excludes only those local removed occurrences, handles explicit denials of removal, and still counts separate positive occurrences. It applies symmetrically to both arms. Labels, thresholds, authority checks, numeric checks and denominators are unchanged. The original primary result is never overwritten or replaced by an erratum score. Any later use of this exposed fixture is explicitly a known regression check, not fresh held-out validation.

A second independent audit confirmed that, in `no handles and no engraving`, the first exclusion incorrectly negated the complete required literal `no engraving`. The bounded classifier now treats the second explicit negative fact as its own assertion while still excluding the contained forbidden word `engraving`; direct denials of that negative fact still fail. Both original paid results remain unchanged. A later offline replay uses previously captured drafts and is labeled counterfactual normalization of known cases, with zero new provider calls; it is not a fresh inference or general-performance result.

After those repairs, the user explicitly approved an additional **$2 maximum** of existing API credits for a fresh comparison, continuous demonstration and three new assessments. That separate immutable validation allocation is split into $1.99 Anthropic and $0.01 Jev; it preserves the original allocations, permanent stops and reserved usage. The original default CLI remains tied to its original allocation. Reviewed private validation runners use the separately authorized allocation with the same scoring rules, fixed models, freeze checks and failure handling. No authorization to purchase credits, enable automatic recharge or use live PayPal is implied.

### Retained fresh-eight result and pre-inference coverage check

Fresh-eight completed all 36 precommitted model turns: 7/24 wholly correct model tasks versus 3/24 baseline tasks, with 3/6 versus 1/6 explicit controls. Its improvement gate failed. The primary source, fixture, outputs and result remain unchanged.

A post-inference audit found 15 missing plural alternatives across 12 tasks: the lexical oracle sometimes accepted only a singular item name although the buyer and model used its plural. It also identified suffix negations such as “polyester is not acceptable” being incorrectly counted as positive attributes. A separate diagnostic oracle adds only those plural alternatives; it is exposed, post-inference diagnostic evidence and cannot replace the primary result. The scorer now recognizes bounded strong suffix exclusions symmetrically for both arms, while “not required,” “not unacceptable,” and separate affirmative occurrences retain their prior meaning. No numeric, authority, completion or improvement gate changed.

Before any subsequent paid inference, an independent auditor checks intent, calendar/timezone resolution, numerical roles, goods facts and lexical coverage against buyer history. Every required fact must have at least one preregistered literal alternative occurring at word boundaries in that history. This coverage check detects oracle spelling gaps; it does not establish semantic completeness or user representativeness. Original authored files, pre-inference corrections, audit records and frozen bytes are retained. The fresh-nine author is a new session blind to implementation and outcomes, but receives this protocol and its historical aggregates; its tasks remain developer-authored synthetic evaluation, not an external holdout.

### Retained fresh-nine result

Fresh-nine completed all 36 precommitted calls on its frozen source: 16/24 wholly correct model tasks versus 9/24 baseline tasks, with 4/6 versus 2/6 controls. Model outputs had zero wrong confident limit fields, premature-ready turns, authority violations, malformed/unrun outputs or forbidden positive attributes. The full improvement gate still failed because the six controls were not all correct. Paired results were nine model wins, two baseline wins and thirteen ties; the descriptive two-sided sign-test p-value was 0.06543, with the independence limitations above. Mean observed latency was 5,193 ms versus 6 ms. A serial runtime test suite ran concurrently; these are observed timings, not isolated speed benchmarks.

The primary result and original fixture remain unchanged. Subsequent diagnosis identified count-role, purchased-pack, temperature, history/correction, explicit-policy and excluded-currency citation handling as software gaps. Repairs use exposed cases only as regression evidence. Any replay of their captured drafts is offline counterfactual normalization, not fresh model inference. A fresh-ten author read the earlier protocol, including historical outcomes through fresh-eight, before this fresh-nine result was appended. That author has no implementation or current-round output access. Its original case IDs and any objectively missing material fact coverage are corrected only before inference in a separately retained audit artifact, without changing cases according to either arm's performance.

### Retained fresh-ten result

Fresh-ten completed all 36 calls: 16/24 wholly correct tasks in each arm, four of six controls in each arm, and all 24 paired tasks tied. The model had zero wrong confident limit fields, premature-ready turns, authority violations, malformed/unrun outputs or forbidden positive attributes. The baseline had two wrong confident fields and one forbidden positive attribute. This is a safety difference within this set, not completion superiority; the unchanged full improvement gate failed. Mean observed latency was 5,123 ms versus 5 ms while runtime tests ran concurrently.

Before inference, the independent auditor retained the author's original file and created a separate corrected fixture: 24 mechanical task-ID remaps plus three missing kit-content quantity/container/per-kit facts. All original scalar/default/ready labels and original fact alternatives remained unchanged. Every original primary result and freeze is preserved. Subsequent code diagnosis and offline captured-draft replay remain exposed regression work, never replacement fresh results. Any later newly authored set stays developer-synthetic, with its actual protocol/outcome exposure disclosed and an independent label/calendar/literal-coverage audit completed before inference.
