# pledge-proof

A support bot for PayPal subscriptions can say a gift is paused, or that a change went through, when PayPal never confirmed it. pledge-proof checks each fact in a reply against the PayPal reads and writes for that turn, and reports which facts have a read or write behind them.

pledge-proof checks facts against PayPal reads. It does not judge tone or intent, and it has no measured accuracy.

**Status:** version 0.1.0, not published to npm. Copy this folder or depend on it by path. It has no dependencies and needs Node 20 or later.

## How it works

You pass three lists.

- `sentences`: one item per sentence the bot said, in order. Each item has the `turn` it was said in, its `text`, and the `facts` the sentence states.
- `reads`: what the provider returned for each read. Each has a `turn`, the time `at`, the `object` it came from (`{ type, id }`), and `values`.
- `writes`: each change request with its `turn`, `action`, `subject` and `ok` (true when PayPal confirmed it).

A fact is one of five kinds.

| kind | example value | backed when |
| --- | --- | --- |
| `status` | `suspended` | the latest read of the subject in this turn or the one before has that status |
| `amount` | `25.00` with `currency: 'USD'` | the latest such read has the same amount to the cent and currency |
| `date` | `2026-12-01` | the latest such read has the same date |
| `reference` | `I-GIFT0001` | the latest such read has the same reference |
| `action` | `suspend` | an ok write with that action and subject came in the same turn |

Every fact needs a `subject`, the id of the object it is about. A read of a different object never backs it.

Each sentence gets one verdict.

- `backed`: it declares facts, and every one is backed.
- `unbacked`: it declares a fact that is not backed.
- `no-claim`: it declares no facts.

```js
import { verify, receipt } from 'pledge-proof';

verify({ sentences, reads, writes });
// [{ turn: 2, text: 'I paused it.', verdict: 'backed' }, ...]

receipt({ sentences, reads, writes });
// The same order, with each fact's backing read or write and the reason for any unbacked fact.
```

## Receipts

`receipt` returns one object per sentence, in order.

```js
{
  turn: 2,
  text: 'Your gift is paused.',
  verdict: 'backed',
  facts: [
    {
      kind: 'status',
      value: 'suspended',
      subject: 'I-GIFT0001',
      currency: null,
      backed: true,
      backing: { source: 'read', turn: 2, at: '2026-11-07T17:03:00Z', reference: 'I-GIFT0001' },
      reason: null,
    },
  ],
}
```

`backing` is `null` and `reason` says why when a fact is unbacked.

## PayPal adapter

```js
import { subscriptionRead, subscriptionWrite } from 'pledge-proof/paypal';
```

- `subscriptionRead(body, { turn, at, subscriptionId })` maps a `GET` on a subscription. It keeps the status (lowercased, so `ACTIVE` becomes `active`), the id, the plan id, the last payment amount and the date part of the next billing time. A `null` body gives a read with no values, so every fact about it is unbacked.
- `subscriptionWrite(action, { turn, at, subscriptionId, httpStatus, body })` maps a suspend, activate or cancel call. A 2xx answer is ok. Any other answer is not ok, and PayPal's error name and debug id are kept.

The adapter takes the status and body you already have. It makes no network calls. The field names it reads are listed in a comment at the top of `src/paypal.js`. They come from PayPal's public Subscriptions v1 documentation and were not checked against a live response. The plan price is not read, so the amount is the last payment amount.

## Example

The support bot in `examples/support-bot/` answers "is my gift paused?" and "pause it" against an in-memory fake PayPal, then prints each reply with its receipt. Run it from this folder:

```sh
node examples/support-bot/index.js
```

Output:

```
turn 1  backed    "Your gift is active."
    status active -> read at 2026-11-07T17:01:00Z, reference I-GIFT0001
turn 2  backed    "I paused it."
    action suspend -> write at 2026-11-07T17:02:00Z, reference I-GIFT0001
turn 2  backed    "Your gift is paused."
    status suspended -> read at 2026-11-07T17:03:00Z, reference I-GIFT0001
```

The bot builds each sentence from the same value as its fact, so the text and the declared facts match. The status in turn 2 is backed by the read that came after the suspend write, not by the turn 1 read.

## What it does not do

- It does not judge tone, politeness or intent.
- It checks only the facts a bot declares. It does not read the reply text, so a fact the bot leaves out is not checked. Build each sentence from the same values as its facts so the two cannot drift apart.
- It checks only facts that have a read or write for the same subject, in the same turn or the one before. A fact with no read is unbacked. It is never assumed true.
- It takes the latest read in that window as the truth at that time. It does not check whether PayPal's data was right.
- A failed write is not ok. The library does not tell a refusal from an unclear answer, so check `httpStatus` if the difference matters to you.
- It has no measured accuracy, and this package makes no claim about how it compares with a plain agent.

## Tests

From the repository root:

```sh
node --test packages/pledge-proof/test/
```

Or from this folder, `npm test`. There are 27 tests. They cover a backed fact, an unbacked amount, a status said before its write succeeded, a completed action with no successful write, a question that states no fact, a read from a different subscription, and the adapter mapping for each status.

## License

MIT. See [LICENSE](LICENSE).
