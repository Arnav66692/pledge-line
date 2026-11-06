# Source-grounded conversation evaluation protocol

This compares language-task completion by the revised main agent and a strengthened deterministic explicit-field parser. It does not compare prices after an exact optimizer already has all supplier floors. Neither arm receives supplier tools, a checkout session, payment authority or a PayPal client.

## Construction before inference

The final suite has 24 independently authored **synthetic** tasks: six explicit controls, six contextual/discourse tasks, six clarification tasks, and six timezone/negation/goods tasks. A separate author receives this contract and supported product limits without implementation, baseline outputs or model outputs. After the offline diagnostic described below, the same author session prepared fresh wording and numeric instances while remaining blind to implementation and outcomes; its earlier authored wording remained available. Their wording and labels are retained without selecting tasks according to which approach wins. This is independent case authorship inside the development process, not independent customers or externally held-out language.

Each task has one to three precommitted buyer turns, an explicit UTC reference timestamp and an IANA organization timezone. Every turn has a ready-or-clarify label. Later turns are delivered identically to both arms even if an arm answered incorrectly earlier. Replies are scripted in advance, rather than chosen after seeing a model question. The current and prior buyer turns are untrusted input; neither arm receives an invented assistant conversation or payment permission. Both approaches have the same three-turn maximum.

A ready label supplies the exact count, total USD cents, delivery instant, split policy, declared default assumptions, and every scored goods requirement. Equivalent ISO offsets represent the same instant. A clarification label names the missing or conflicting constraint. The author must label every turn, including the incomplete original request before a follow-up.

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

An improvement within this set requires more wholly correct tasks than the strengthened baseline, no explicit-control regression, zero wrong confident limit fields, zero premature-ready cases, zero authority violations, and a complete run. Statistical evidence is reported separately; an advantage on 24 synthetic tasks is not automatically a general advantage or observed user benefit. A tie or model loss is retained. No score threshold or desired winner is sent to the agent.

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
  --output .acceptance/conversation-v3-model.jsonl
```

Actual calls require the user's existing API-credit authorization and the same `pledge-line-functional-20261105` allocation, capped at $3 Anthropic and $0.10 Jev. The harness checks schemas but never initializes or resets funding, migrates a database, clears a stop, changes models, tries subscription credentials or switches providers. There is at most one `interpretGoal` call per precommitted turn and no request retry. A model request failure stops subsequent model dispatch; failed and unrun turns stay recorded.

The output is exclusive JSONL. A full write and fsync persist each request-start barrier and each completed/error/unrun turn before another model call. The final summary includes all denominators. Partial interruption leaves the existing lines reviewable. Public records contain bounded numeric/date/boolean output and scored fact IDs, not raw provider bodies or arbitrary source evidence.

Shared scope means concurrent app inference can contaminate deltas. The harness does not claim it excluded outside traffic. No synthetic outcome establishes donor usability, retention, sponsor economics, independent supplier fulfillment, live-money readiness, official hackathon compliance or a guaranteed judging score. A later changed version needs new independently authored cases; exposed cases become regression fixtures.
