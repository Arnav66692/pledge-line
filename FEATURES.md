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

## Is this charge real?

Added Tue Nov 3 on the `feat/core-move` branch, to merge only after the pilot is graded (after Wed Nov 4 at 9 pm PT). `PICK.md` says why this move won and what lost. `SPEC.md` has the contract.

A donor sees a PayPal charge she doesn't recognize and calls. After the PIN she says "I see a PayPal charge I don't recognize." The line reads the gift's charges from PayPal (`GET /v1/billing/subscriptions/{id}/transactions`) and says the latest one, as in "PayPal shows the latest charge for your monthly gift to Sunny Hollow Pantry was $25.00 on November 1, with the status completed. In your PayPal activity, it is the transaction ending in 0042." Then it offers to ask staff to look at a refund. It never tells her she needn't call her bank, since staff only look. A charge PayPal already shows as refunded or declined is read with no offer.

- Every amount, date, status and transaction ending is a fact proven against that one read, so the receipts show it as proven, from PayPal's charge record.
- The offer is a proposal like a pause. Only a clear yes in the next turn counts, the gate mints a one-time token, and `src/refund-desk.js` consumes it before it logs a `refund_request` for staff. Nothing is written to PayPal and nothing is refunded by the line.
- After the yes, the line reads the charges again and reads the same charge's amount, date and status back. If PayPal now lists a newer charge first, or the read fails, it names no amount and says it asked staff about the charge it read aloud.
- No charge in the last year, a half filled charge, a PayPal error, a no, and a locked call each have their own honest sentence, and none offers a refund it can't tie to a charge.
- The grader proves the new claims (`no_charge`, `charge_unread`, `wrote_refund_request`, `refund_matches_read`, `refund_request_failed`, `no_refund_request`), and fails a request that names another charge than the one read aloud. completed, refunded, declined and pending became status words, so "refunded" can only be said when PayPal's read says so.
- The staff view lists each refund request with its transaction and amount, and the donor page's event log says the request went to staff and nothing changed in PayPal.
- The claim audit (EVAL.md) now holds a date or amount to the charges PayPal lists for the gift too, for both arms. The change log there says why and keeps the one unbacked date the old rule counted on E6. It needs Arnav's yes before the real run.

## Covered Month

Added Tue Nov 3 on the `feat/money-move` branch, to merge only after the pilot is graded (after Wed Nov 4 at 9 pm PT). `PICK.md` says why. `SPEC.md` has the contract. It has run only against the mock.

Maria says "I lost my job, I can't do it this month." The line says it is sorry, reads her latest charge from PayPal, and offers to give that amount back with a sponsor's hardship fund paying the same amount to the nonprofit. It says the gift doesn't change and when the next one comes, then asks. On her yes:

1. It reads PayPal once more, the charge list, the charge by its own id and the hold. If anything changed since the offer, it moves nothing and says so.
2. It captures the amount from the sponsor's hold, with `final_capture: false`, so the hold stays open.
3. It refunds her charge for that exact amount.
4. It reads the charge, the capture, the hold, the charge list and the gift again, and says only what those reads show.

Sponsor first, since a refund can fail for want of funds and the capture is what pays for it.

- **The staff rule.** `src/config.js` holds it, up to $50, within 30 days, once a year by default. The line never says the numbers aloud, only why it can't help. A refund PayPal lists on the gift counts toward the year, and so does a cover in the ledger.
- **One yes, two moves, one token each.** The yes mints one token per move, each bound to its own kind, target and exact amount. Nothing the caller says can change the amount or where the money goes, and a yes with an amount or a card in it is not a yes.
- **When a move fails.** A capture PayPal refuses runs no refund, and the donor hears no money moved. A refund PayPal refuses sends the sponsor's money back and says so, unless a read shows the refund went through after all, as when an earlier answer was lost, and then staff get it and the sponsor's money stays. A lost answer on either move is never spoken as done, and a later call about that charge is told staff are looking at it.
- **A double submit.** Two copies of one yes run once, since the first closes the offer. Two calls about one charge can't both run. The PayPal-Request-Id comes from the charge, so a retry replays PayPal's answer, per Keepwell's spike. The sponsor's move also reads its capture before the refund, so a replayed answer for money since given back never counts.
- **The grader.** `check.js` proves every new sentence from that turn's writes and reads, and fails a move of another amount or target, a move the staff rule turns down, a refund with no capture before it, a return of the sponsor's money with no refused refund, or a move with no fresh read after it. Receipts show each move's read, as in "From PayPal at 1:34:52 pm, $25.00, refunded" beside "Refunded to you".
- **The fee.** It is not hidden. The "Covered month" card and the staff view say the nonprofit ends one fee short of a gift that stood, with PayPal's own number for the sponsor's payment. The brief's figures are $0.99 at the charity rate, and the mock's fee is $1.21.
- **The sponsor's id.** The donor's browser never gets the hold id. Staff see it.

## The phone line

Added Tue Nov 3 on the `feat/phone-line` branch, from `feat/money-move`, to merge only after the pilot is graded. A donor calls a real number and does the same things as in the browser, through the same call service, gate and grader. `TWILIO-SETUP.md` has the prices, the steps for Arnav and what can break a live call. It has only ever been run against a fake Twilio.

Each phone call is one call in `src/call.js`, logged with `channel: 'phone'`, `script: null` and Twilio's CallSid, so pilot-check never picks one to grade and its writes and safety sweeps still cover it. `src/phone.js` writes no words. Every `<Say>` holds the text the call service returned.

- **On or off.** `PHONE_ENABLED` and `TWILIO_AUTH_TOKEN` must both be set. Otherwise `/phone`, `/phone/voice`, `/phone/turn` and `/phone/status` are 404s.
- **The signature.** Every webhook, the status callback too, needs a good `X-Twilio-Signature`, or it is a 403 before any field is used. The check is HMAC-SHA1 in Node crypto over the URL and the sorted form fields, and a test holds it to Twilio's own worked example. The URL comes from `PUBLIC_BASE_URL` plus the raw path and query, since behind Render's proxy the request can't say what Twilio signed.
- **The first sentence.** "This is an automated line, not a person." It is on the reviewed claim-free list in `src/vocabulary.js`, and `npm run vocabulary` added a list and kept every older one. The browser's greeting is unchanged.
- **The PIN.** By keypad, or by spoken digits, through the same `pinTurn`, which masks both. A `Digits` value is a keypad turn and a `SpeechResult` is a voice turn.
- **A yes on the phone.** The gate is the same, and these map it to a spoken reply.
  - While a proposal waits, its `<Say>` comes before an empty `<Gather>`, not inside one. So the line isn't listening until the read-back has ended, and a yes said over it is never heard. Every other reply sits inside the `<Gather>`, so a caller can key the PIN over the greeting or cut off a reply that changes nothing. Twilio's page documents that a key press stops the speech, and doesn't confirm it for speech. Either way a yes can't reach a proposal that way.
  - The action URL names the turn that reply was, and Twilio signs it. It is the `answering` of I6, so a client can't change it.
  - `arrivedAfter` still holds, so a yes that arrives before the asking reply finished never counts.
  - The phone also sends `spokenFloorMs`, 150 ms per word of the reply, and a yes must arrive at least that long after the reply finished. It's a second check in case the first ever fails, kept low so it can't refuse a real answer. `check.js` fails a write whose yes came sooner.
  - A proposal's `speechTimeout` is 2 seconds, never `auto`, which stops at the first pause. So "yes... wait, no" reaches the gate whole, and it isn't a yes. Other replies use `auto`, and a PIN gets 3 seconds between digits.
  - A key press is never a yes, as in the browser, since `isClearYes` refuses the masked digits.
  - The line sends no speech `hints`, and a transcript with a confidence under 0.5 counts as not caught. A missing or zero score isn't judged, since Twilio says the score isn't always sent. The 0.5 is a guess.
- **Replays.** A signature has no timestamp, so each action URL also carries a random key for that call, held in memory. A signed webhook saved from before a restart gets the greeting and is never a turn, so it can't pass the PIN or reach a yes.
- **Retries.** Each turn runs once for a CallSid and turn number, however many copies Twilio posts or however they overlap, and each copy gets the same TwiML. One write, one PIN try.
- **A slow turn.** Twilio gives a webhook 15 seconds. A turn still running at 11 seconds answers with a two second `<Pause>` and a `<Redirect>` back for the same turn, in silence, until the reply is ready.
- **No input.** `calls.turn` takes `silent: true`. The turn is logged, it goes to neither the gate nor the router, and the line says what it said before, the waiting proposal again if it hasn't expired, so the yes after it still answers it. Before the PIN it asks for the PIN. Three in a row say goodbye and end the call, with reason `no_input`.
- **Hang-ups.** The status callback ends the call with reason `hangup`, once, which deletes an open draft and sets aside a proposal. A webhook posted with the call over never becomes a turn. A late one gets "This call has ended.".
- **A restart.** Calls live in memory, so a webhook for a CallSid the line doesn't know starts a new call at the greeting, and whatever it carried is dropped.
- **The caller's number.** It never reaches the ledger or the logs. The PIN guard and the hourly limits count a keyed hash of it, in memory only. Twenty new calls an hour from one number and 60 in all, past which the call gets a `<Reject>`, unanswered.
- **The fake.** `scripts/fake-twilio.js` posts signed webhooks the way Twilio does, signs against the public URL while posting to localhost as Render's proxy would, and plays each reply's words on a test clock. `npm run phone:fake` plays Script 2. `test/phone.test.js` has 35 tests, and one runs all 10 pilot scripts by phone and typed, and checks the same routes, writes and replies, with each script passing its checks.

## Unseen look

Added Nov 2 on the `feat/unseen-look` branch. The donor page and the staff view now follow unseen.co's design language. Only the look changed. `app.js`, `staff.js`, every element id, the server routes and the policy are the same, so the pilot grades the same page.

- Copied from unseen. Root size `clamp(14px, 1vw, 38px)` with rem everywhere, a 2rem frame, a fixed see-through header, a lowercase logo set half in sans and half in serif, nav links with a letter roll, white pills whose fill rises on `cubic-bezier(0.87, 0, 0.13, 1)`, discs in the corners, a menu disc that opens a 41rem `#f1edeb` panel, a cursor ring on fine pointers, and a 100vh hero with a caps line over a two-line headline, serif italic over sans, in `#353535`.
- The room behind the page is one raw WebGL2 canvas in `web/scene.js`, with no library. Since Nov 3 (`feat/unseen-room`) it is Arnav's own Blender room from his portfolio build, modelled and light-baked from code by `build_room.py --variant left`, copied unchanged into `web/room/` (a 190 KB glTF binary and two WebP light maps, 254 KB in all, with their sha256 in `web/room/README.md`). A small loader in `scene.js` reads the glb's JSON and binary chunks, and the shader re-colours the white and crimson bake by its brightness into pink plaster, lilac shade and a peach sun patch, with a faint plaster mottle. The water is a planar mirror: each frame the room is drawn flipped about the water into a half-size texture, and the water samples it through slow ripples that stretch into streaks near the camera. A peach and lilac dusk with three ranges of hills shows through the arcade on the left. The pearl floats past the end of the headline's first line, specks drift in the air, and the camera wanders like a hand-held shot, turns about 3 degrees toward the pointer and walks in over 4.6 s on entry. A pointer flow field, grain, a vignette and a slight RGB split finish it. Dark mode is the same room at dusk with a dimmed pearl. The bottom of the picture settles toward a plain tone so the small note and the year stay readable over the water.
- Legibility is checked, not assumed. A headless GPU run reads the canvas behind every hero text element (caps line, both headline lines, the note, the logo, the nav and the year) at eight moments of the wander and at the centre and four corners of the pointer's look, in light and dark, at 1440x900, 1280x800 and 390x844. Every element held 4.5 to 1 for body text and 3 to 1 for large type against its single worst pixel, grain included. Portrait screens keep a wider, lower view with the arches out of frame, so no bright opening ever sits behind the headline. `test/scene.test.js` checks that every shader smoothstep runs low to high and every pow base cannot go below 0, since Metal turns both into black squares.
- During a call the list of what the line said scrolls to the newest reply. The rule now sits on the summary a little above the list, and the list's top fades out, so an older line stopping part way up dissolves before the rule instead of being cut by it.
- Changed from unseen. Unseen's faces are paid, so Instrument Serif and Geist stand in, self-hosted under the SIL Open Font License with their sha256 in `web/fonts/README.md`. Unseen's rock and world link are left out. The hero's pill is "Start a call" and opens the call workspace instead of a project list. The room dims while a call is open so the receipts stay easy to read. Unseen has no dark mode, so dark mode here is the same room at dusk. The staff view is a dark unseen case page. Focus rings stay, since unseen drops them.
- The room pauses when the tab is hidden, draws one still frame under reduced motion, and falls back to a painted still in CSS when WebGL2 is missing, the context is lost, or the room's files fail to load. It draws its first frame before the canvas shows, so a slow first frame never flashes black, and it holds 60 fps at full quality on this Mac. The menu closes on Esc, keeps focus inside while open and sets `aria-expanded`.
- Sound is off by default. The line speaks its replies out loud and the pilot times the gap after each one, so a background bed must never talk over a donor or the line, or add noise to that timing. When a viewer turns it on, it plays on the hero only and fades to silent within a quarter second once a call starts.
