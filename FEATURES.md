# Receipts and "How do you know?"

Added Nov 2, 2026 on the `feat/receipts` branch. Other entries in this hackathon already turn a cancel into a PayPal suspend. What none does is prove each sentence the donor hears against PayPal's own record. These two features make that proof something the page can show, the donor can ask for out loud, and a grader can count.

## Receipts

`src/receipt.js` exports `buildReceipts(events, { orgName, subscriptionId, timeZone })`. It takes one call's ledger events, oldest first, as `ledger.byCall(id)` gives them, and returns one receipt for each thing the line said.

```
{ turn, seq, ts, sentences: [ { text, verdict, facts, claims, problems } ] }
```

- `text` is one sentence as the line spoke it.
- `facts` are the amounts, dates, invoice endings and statuses in that sentence. Each carries `proof`, the PayPal read it came from, with its `seq`, time, what was read, its id, PayPal's debug id and the status it showed. A limit from the config, such as the one dollar minimum, has no PayPal read, so its proof is null.
- `claims` are what the sentence says PayPal or the line did, such as "Done." for a change PayPal accepted. Each has the grader's own words for what it needs and whether the call's events back it.
- `verdict` is one of three.
  - `proven`, the sentence states a fact or carries a claim, and every one is backed.
  - `plain`, the sentence states no fact and carries no claim, such as "Please say yes or no."
  - `blocked`, the grader found a problem in that turn that touches this sentence. `problems` lists the grader's messages. When the receipt can't tie a sentence to its reads, it is blocked, never proven.

The receipts come from the same events and the same check.js code that `npm run pilot:check` grades with, so the page and the grader can't disagree. A test runs every call it builds through both and checks that a turn has a blocked sentence exactly when checkFacts reports a problem in it. Another test grades the same events with the check.js the pilot branch had at `0d5ad85` and with the new one, and every existing check returns the same result.

The call state that `calls.start`, `calls.turn`, `calls.get` and `calls.end` return carries `receipts`, built with the configured `ORG_NAME` and `DEMO_SUBSCRIPTION_ID`. The page does not draw them yet.

## The "How do you know?" intent

A donor can ask "How do you know?", "Are you sure?", "Says who?", "Prove it." or "How can I be sure that's right?". The router names this `how_do_you_know` in rules mode, in Gemini mode and in Haiku mode.

- Like every gift intent, it acts only after the PIN passes. Before that the line asks for the PIN, and a locked call reads nothing.
- After the PIN, the line reads the call's own subscription again with a fresh GET. It says "I just checked PayPal's record again." and then the sentence that reads the gift's amount and status from that fresh read.
- If the call made a draft invoice it has not deleted, the line reads that draft again and reads its number, amount and status aloud the same way.
- If PayPal returns no gift, the line says it couldn't find a monthly gift. If the draft is gone, it says it couldn't get a clear answer from PayPal.
- While a change waits for a yes, the line reads PayPal again and checks that what it read back still matches. If it does, it says the new sentence and the same read-back again, so a yes in the next turn still counts. If PayPal no longer shows what the read-back said, the line sets the change aside and says what PayPal shows now.

The new sentence carries the claim `gift_rechecked`, "a read of the call's own subscription in that turn that returned it". The grader proves it against the call's own events, so the line can't say it after an older read. The sentence is on the hand review in `src/vocabulary.js`, and `npm run vocabulary` added the new template list to `src/template-history.js` beside every older one.
