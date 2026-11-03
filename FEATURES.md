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

The call state that `calls.start`, `calls.turn`, `calls.get` and `calls.end` return carries `receipts`, built with the configured `ORG_NAME` and `DEMO_SUBSCRIPTION_ID`. The page draws them under "What the line said". Each proven sentence gets a chip naming the PayPal read time in PT to the second and the facts it read, as in "From PayPal at 5:42:07 pm, $25.00, suspended", and one per claim in plain words, as in "PayPal accepted the change", with what backs it on hover, as in "PayPal accepted a change on this reply." from `web/claim-words.js`. Every claim check.js knows has a plain label and a plain hover, and a claim without one would show check.js's own meaning. Plain sentences get no chip, and a blocked one says "This didn't check out" with the grader's reasons. When a change's read-back shows the gift paused or active again, the gift card says what changed, as in "Paused on this call. It was active before.", with PayPal's read time to the second. The card calls SUSPENDED "Paused" and says once that suspended is PayPal's word for a pause, since the line speaks PayPal's word. The status word sits on a tint in the new status's color and pops once, which stays still under reduced motion.

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

## Unseen look

Added Nov 2 on the `feat/unseen-look` branch. The donor page and the staff view now follow unseen.co's design language. Only the look changed. `app.js`, `staff.js`, every element id, the server routes and the policy are the same, so the pilot grades the same page.

- Copied from unseen. Root size `clamp(14px, 1vw, 38px)` with rem everywhere, a 2rem frame, a fixed see-through header, a lowercase logo set half in sans and half in serif, nav links with a letter roll, white pills whose fill rises on `cubic-bezier(0.87, 0, 0.13, 1)`, discs in the corners, a menu disc that opens a 41rem `#f1edeb` panel, a cursor ring on fine pointers, and a 100vh hero with a caps line over a two-line headline, serif italic over sans, in `#353535`.
- The room behind the page is one raw WebGL2 canvas in `web/scene.js`, with no library. Since Nov 3 (`feat/unseen-room`) it is Arnav's own Blender room from his portfolio build, modelled and light-baked from code by `build_room.py --variant left`, copied unchanged into `web/room/` (a 190 KB glTF binary and two WebP light maps, 254 KB in all, with their sha256 in `web/room/README.md`). A small loader in `scene.js` reads the glb's JSON and binary chunks, and the shader re-colours the white and crimson bake by its brightness into pink plaster, lilac shade and a peach sun patch, with a faint plaster mottle. The water is a planar mirror: each frame the room is drawn flipped about the water into a half-size texture, and the water samples it through slow ripples that stretch into streaks near the camera. A peach and lilac dusk with three ranges of hills shows through the arcade on the left. The pearl floats past the end of the headline's first line, specks drift in the air, and the camera wanders like a hand-held shot, turns about 3 degrees toward the pointer and walks in over 4.6 s on entry. A pointer flow field, grain, a vignette and a slight RGB split finish it. Dark mode is the same room at dusk with a dimmed pearl. The bottom of the picture settles toward a plain tone so the small note and the year stay readable over the water.
- Legibility is checked, not assumed. A headless GPU run reads the canvas behind every hero text element (caps line, both headline lines, the note, the logo, the nav and the year) at eight moments of the wander and at the centre and four corners of the pointer's look, in light and dark, at 1440x900, 1280x800 and 390x844. Every element held 4.5 to 1 for body text and 3 to 1 for large type against its single worst pixel, grain included. Portrait screens keep a wider, lower view with the arches out of frame, so no bright opening ever sits behind the headline. `test/scene.test.js` checks that every shader smoothstep runs low to high and every pow base cannot go below 0, since Metal turns both into black squares.
- During a call the list of what the line said scrolls to the newest reply. The rule now sits on the summary a little above the list, and the list's top fades out, so an older line stopping part way up dissolves before the rule instead of being cut by it.
- Changed from unseen. Unseen's faces are paid, so Instrument Serif and Geist stand in, self-hosted under the SIL Open Font License with their sha256 in `web/fonts/README.md`. Unseen's rock and world link are left out. The hero's pill is "Start a call" and opens the call workspace instead of a project list. The room dims while a call is open so the receipts stay easy to read. Unseen has no dark mode, so dark mode here is the same room at dusk. The staff view is a dark unseen case page. Focus rings stay, since unseen drops them.
- The room pauses when the tab is hidden, draws one still frame under reduced motion, and falls back to a painted still in CSS when WebGL2 is missing, the context is lost, or the room's files fail to load. It draws its first frame before the canvas shows, so a slow first frame never flashes black, and it holds 60 fps at full quality on this Mac. The menu closes on Esc, keeps focus inside while open and sets `aria-expanded`.
- Sound is off by default. The line speaks its replies out loud and the pilot times the gap after each one, so a background bed must never talk over a donor or the line, or add noise to that timing. When a viewer turns it on, it plays on the hero only and fades to silent within a quarter second once a call starts.

## The donor's receipt

Added Nov 3 on the `feat/proof-receipt` branch. Other entries already show a tamper check as a demo beat. This one is about the donor. When a call ends, she can keep a receipt of every sentence the line said to her, each with what backs it, and anyone can later check that nobody changed it.

- `RECEIPT_SIGNING_KEY` turns it on. It is 64 hex characters, a 32-byte Ed25519 key, and `config.js` refuses any other shape without echoing the value. Unset, the button is never shown, the page gets no secret, and `/receipt`, `/check`, `/receipt-key`, `/api/receipts/...` and the five receipt files are all 404s, like the staff view without `STAFF_KEY`.
- After the call ends, the donor page shows "Keep a receipt of this call". It opens `/receipt`, a plain printable page on the line's own tokens and fonts, which lists every sentence in order with the PayPal read time, amount and status behind each fact, the plain words for each claim from `web/claim-words.js`, and a note on each sentence that had nothing to check. It offers the receipt file to download, byte for byte as the line signed it, and a print button. Print drops the buttons and prints black on white.
- The page says plainly that Render's free disk is wiped on restart, so the downloaded file is the copy that lasts, and that the file is tamper-evident. An edit is detectable, not prevented. The copy never says tamper-proof.
- Only the page that started the call can fetch its receipt. `POST /api/calls` returns `receiptSecret`, 128 bits, an HMAC of the call id under a key derived from the signing key, so nothing is stored and one call's secret never opens another's. The donor page puts it in the link's fragment, which the browser never sends to a server, and the receipt page moves it to `sessionStorage` and takes it out of the address bar at once. `GET /api/receipts/:id` needs it in `x-receipt-secret`, compared in constant time on sha256 digests, after a limit of 30 requests a minute per address. A wrong or missing secret is a 401, whether or not the call exists, a call still going is a 409, and a call the ledger no longer has is a 404.
- The file holds no PIN or PIN digits, no full email (the line only ever says the masked one), no token or pending ids, no user agent and no raw snapshots. It is built from `buildReceipts` alone, with `receiptOptions(config)`, so it covers the call's own subscription, its plan and the call's own drafts, and each sentence is rebuilt from a short list of fields. Any email form with an @ is hidden, though the line never says one.
- `/check` takes a receipt file, by file picker or drop, posts its exact bytes, and says "Untouched, and signed by this line." or which sentence changed. `scripts/check-receipt.js FILE --key receipt-key.json` does the same offline with only the public key from `/receipt-key`. It exits 0 for untouched, 1 for changed and 2 for a wrong command.

### The receipt file, version 1

`src/receipt-file.js` builds the content and `src/receipt-seal.js` signs and checks it, with `node:crypto` alone. The file is UTF-8 JSON in one exact layout: a top line with everything but the sentences, one line per sentence, then `]}` and a newline.

```
{"about":"...","call":{...},"chain":{"count":17,"head":"<hex>","start":"<hex>"},"format":"pledge-line-receipt",
 "signature":{"alg":"Ed25519","keyId":"<16 hex>","value":"<128 hex>"},"version":1,"sentences":[
{"at":"<ISO>","claims":[...],"facts":[...],"link":"<hex>","n":1,"note":"...","problems":[],"sig":"<128 hex>","text":"...","turn":0,"verdict":"plain"},
...
]}
```

- `call` is `{id, org, script, startedAt, endedAt, endReason, timeZone, paypal, router, practice}`. Times are UTC ISO strings, as logged.
- Each sentence is `{n, turn, at, text, verdict, facts, claims, problems, note}` plus its `link` and `sig`. `text`, `verdict`, `facts` (with each `proof` of `{seq, ts, what, id, debugId, status}`), `claims` and `problems` are exactly what `buildReceipts` gives for that sentence. `note` is a plain sentence for a plain or blocked sentence, else null.
- Keys are sorted and there are no spaces, so a value always gives the same bytes. Numbers are whole numbers only.
- `sig` signs the sentence's content alone, `pledge-line-receipt/1 sentence\n` then its canonical JSON without `link` and `sig`. `chain.start` is the sha256 of `pledge-line-receipt/1 call\n` and the canonical `{about, call, format, version}`. Each `link` is sha256 of the previous link's bytes and the sha256 of the sentence's signed message, and `chain.head` is the last link. `signature.value` signs `pledge-line-receipt/1 seal\n` and the canonical `{count, head, start}`. `keyId` is the first 16 hex of the sha256 of the raw public key.

The check names what changed. A sentence whose words, facts or number changed fails its own signature, even if every link after it was redone. A sentence taken out, added, moved or copied in from another receipt breaks the chain or sits out of its signed order. A change at the top is named as the call details or the seal. Any byte the values don't cover, such as a space or a line ending, fails as a layout change. A test edits every byte of a short call's file, and 400 places of a long one three ways, and each edit fails and names the sentence it is in.

The CSP is the same string on every route, with receipts on or off. `check.js`, `receipt.js`, `say.js`, `vocabulary.js`, the template lists, `router.js` and `gate.js` are unchanged, the line says no new sentence, and grading a copy of the mock dry run's ledger with pilot's `check.js` and with this branch's gives the same output.
