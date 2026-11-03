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

The call state that `calls.start`, `calls.turn`, `calls.get` and `calls.end` return carries `receipts`, built with the configured `ORG_NAME` and `DEMO_SUBSCRIPTION_ID`. The page draws them under "What the line said". Each proven sentence gets a chip naming the PayPal read time in PT to the second and the facts it read, as in "PayPal, read 5:42:07 pm, $25.00, suspended", and one per claim in plain words, as in "PayPal accepted the pause", with check.js's own meaning on hover. A claim with no plain label shows that meaning, as in "Checked, a no to a pause in that turn, and no ok write". Plain sentences get no chip, and a blocked one says "Not backed by PayPal" with the grader's reasons. When a change's read-back shows the gift suspended or active again, the gift card says what changed, as in "Changed during this call, Active to Suspended.", with PayPal's read time to the second. The status word sits on a tint in the new status's color and pops once, which stays still under reduced motion.

## The staff view, the morning after

Added Nov 2 on the `feat/staff-view` branch. A small nonprofit's coordinator opens `/staff` the next morning and sees every call from the night, what PayPal changed, and the receipt behind every sentence the line said.

- `STAFF_KEY` turns it on. It must be at least 16 characters with no spaces. Unset, `/staff`, `/api/staff/...`, `staff.js`, `staff.css` and `vendor/` are all 404s.
- `GET /api/staff/calls` and `GET /api/staff/calls/:id` need the key in `x-staff-key`. A wrong key is a 401, and both are limited to 60 a minute from one address, wrong keys included.
- The list has one row per call. The detail adds the receipts, built with `receiptOptions(config)`, the same options the call state uses and the same values pilot-check grades with, and the call's events.
- `src/staff.js` rebuilds each event from a short allowlist per type, so a field the ledger gains later never reaches the page by accident. Heard turns before `pin_ok` and keypad turns show as hidden, and a caller turn with an email in any form shows as hidden whole.
- The page is AG Grid Community 32.3.3 with a custom receipt cell and a Quartz theme on the donor page's own tokens. It keeps the key in `sessionStorage` only, renders data with `textContent`, and works by keyboard, at 1280 px and at 375 px.
- The policy stays self only. AG Grid's injected `<style>` elements and its row position attributes are refused, so the page links AG Grid's stylesheets itself and places rows through the style object. Quartz's icon font is served as a file, since a `data:` font is refused. `web/vendor/README.md` has the details and the sha256 of each file.

## The "How do you know?" intent

A donor can ask "How do you know?", "Are you sure?", "Says who?", "Prove it." or "How can I be sure that's right?". The router names this `how_do_you_know` in rules mode, in Gemini mode and in Haiku mode.

- Like every gift intent, it acts only after the PIN passes. Before that the line asks for the PIN, and a locked call reads nothing.
- After the PIN, the line reads the call's own subscription again with a fresh GET. It says "I just checked PayPal's record again." and then the sentence that reads the gift's amount and status from that fresh read.
- If the call made a draft invoice it has not deleted, the line reads that draft again and reads its number, amount and status aloud the same way.
- If PayPal returns no gift, the line says it couldn't find a monthly gift. If the draft is gone, it says it couldn't get a clear answer from PayPal.
- While a change waits for a yes, the line reads PayPal again and checks that what it read back still matches. If it does, it says the new sentence and the same read-back again, so a yes in the next turn still counts. If PayPal no longer shows what the read-back said, the line sets the change aside and says what PayPal shows now.

The new sentence carries the claim `gift_rechecked`, "a read of the call's own subscription in that turn that returned it". The grader proves it against the call's own events, so the line can't say it after an older read. The sentence is on the hand review in `src/vocabulary.js`, and `npm run vocabulary` added the new template list to `src/template-history.js` beside every older one.
