# What the AI evidence supports

The retained evaluations show a historical routing advantage on one synthetic set and continuing weaknesses in conversational purchase drafting. They do not establish general AI superiority, user benefit or AI-specific price savings. Routing classification and purchase drafting are different tasks; their results must stay separate.

## Historical routing comparison

The [retrospective V4 comparison](results/routing-v4-retrospective-baseline-2026-11-05.json) pairs the 30 previously frozen routing examples with their original observed composed-agent responses and a later local run of the unchanged, preexisting keyword router.

| Measure | Existing rules | Previously observed composed AI |
| --- | ---: | ---: |
| Exact intent classifications | 23/30 | 29/30 |
| Wrong mutation-route classifications | 5 | 0 |
| Pending-consent cases returning unclear | 10/10 | 10/10 |
| Provider requests during pending consent | 0 | 0 |

The paired routing outcomes were 23 correct in both arms, six correct only in the recorded composed AI, none correct only in rules, and one incorrect in both. These are proposed intent classifications, not executed payments. The pending-consent gate is shared deterministic code and does not demonstrate model value.

This supplementary analysis made zero new API calls. It reuses historical AI outputs, not a fresh run of the current implementation. The composed system includes Anthropic, Jev advice, deterministic guards and a rules-agreement path; the comparison does not isolate either model's causal contribution. The small developer-curated fixture's authors saw canonical definitions in the router module, and blindness to its keyword rules is not established. The retrospective comparison was planned after the historical result was known.

The executed rules modules match pre-run Git source. The original V4 manifest omitted two import dependencies: the number module matches pre-run Git, while the changed coverage module is import-only on this path. Full import-closure identity is not established. Current agent and gate sources differ from V4; this historical result is not current-version validation. V4 has no independent amount oracle, so amount agreement is not scored as correctness.

## Fresh conversational purchase drafting

The [fresh-eleven primary result](results/conversation-goal-2026-11-05-fresh11-primary.json) records a model loss, not a passing improvement gate:

| Measure | Explicit-field baseline | Model-backed draft |
| --- | ---: | ---: |
| Wholly correct tasks | 14/24 | 11/24 |
| Correct explicit controls | 5/6 | 5/6 |
| Correct turns | 25/36 | 23/36 |
| Wrong confident limit fields | 2 | 0 |
| Premature-ready turns | 2 | 0 |
| Authority violations | 0 | 0 |
| Malformed or unrun outputs | 0 | 0 |
| Mean observed latency | 8 ms | 5,256 ms |
| Provider calls | 0 | 36 |

All 36 precommitted model turns ran once without retry on source `836a074be084edf3bb8e744c81b21b60ebaea73c`. The author had no implementation or current-output access but read the complete protocol, including historical aggregate results through fresh-ten. An independent pre-inference audit approved the original fixture without changes, including all 93 required fact instances and calendar/time-zone labels. These are developer-synthetic cases, not independent users or an external holdout.

There were zero model-only task wins, three baseline-only wins and 21 ties. Both arms missed one explicit control. The model's absence of observed wrong confident limits does not compensate for its lower completion rate: the unchanged improvement gate failed. The descriptive paired sign-test p-value is 0.25; independence assumptions for these deliberately related synthetic families are not established. Runtime tests ran concurrently, so latency is descriptive rather than an isolated benchmark.

The shared Anthropic allocation counter increased by $0.408758 and Jev by $0. These are local allocation deltas, not verified provider balances or exclusively attributed account charges. This language evaluation made no supplier or PayPal payment calls. Subsequent repairs and any replay of these captured drafts are exposed regression work, not a replacement fresh result.

Earlier primary outcomes remain available: [fresh-nine](results/conversation-goal-2026-11-05-fresh9-primary.json) was 16/24 versus 9/24, with four versus two correct controls; [fresh-ten](results/conversation-goal-2026-11-05-fresh10-primary.json) tied at 16/24 with four controls in each arm. Both failed the full improvement gate. The [conversation protocol](CONVERSATION-GOAL-EVAL.md) explains task-level scoring, complete goods checks, gates, source freezes, historical failures and uncertainty limits.

## Product claims

The evidence supports a working guarded drafting and routing prototype with retained failures. It does not support a general claim that the current AI outperforms the strong baseline. Procurement's complete-plan price guard is deterministic; choosing a cheaper guarded plan than the model candidate is not AI-specific negotiation savings. No retained synthetic result establishes target-user adoption, staff time saved, donor retention, independent supplier fulfillment, live-money readiness or a competition score.
