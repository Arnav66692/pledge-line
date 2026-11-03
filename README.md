# Pledge Line

The after-hours donor line for small nonprofits.

A monthly donor opens the line in a browser and proves who she is with a PIN. When she asks to stop her gift, the line reads her amount from PayPal's own record and offers a pause. Only after her separate spoken yes does it call PayPal's suspend, and then it reads the new status back from a fresh PayPal read. A one-time gift becomes a PayPal draft invoice. The line reads the draft back from PayPal, sends it only on yes, and deletes it on no.

This is a pilot for the PayPal AI Hackathon. It runs against the PayPal sandbox only, so no real money moves.

## What is live and what is simulated

Live in the pilot, once the keys are in `.env`.

- PayPal sandbox REST calls for subscriptions, invoices and webhook checks. The code refuses any other PayPal address.
- An AI router reads what the caller means. For the pilot it's Google's Gemini on the free tier, or Claude Haiku 5.5 with `ROUTER_MODE=haiku`. It never decides a yes or a no, and it never touches PayPal. Below, Haiku means whichever router model is set.
- Speech in and out uses the browser's own speech tools. Chrome and Safari can listen. Firefox uses the typed box.

Simulated in mock mode.

- `PAYPAL_MODE=mock` swaps in a fake PayPal held in memory.
- `ROUTER_MODE=rules` swaps the AI router for offline keyword rules.
- Any run with either switch on prints `MOCK RUN, does not count` and never writes a pass.

The donor, Maria, and the nonprofit, Sunny Hollow Pantry, are fictional.

## Run it in mock mode

Node 22.12 or later. Nothing else to set up.

```
npm install
npm run dev
```

Open http://localhost:3000, press Start call, and type the PIN 2468 on the keypad. Mock calls go to `.pilot/mock-ledger.jsonl`, apart from the pilot ledger. The line refuses to start in mock or rules mode if `LEDGER_PATH` points at the pilot ledger.

The line allows 20 new calls an hour from one address. On your laptop every browser shares that, so if Start call says to try again later, wait or restart `npm start`, which clears it.

```
npm test
npm run pilot:dry -- --mock
```

The tests and the mock dry run need no network and no keys.

## Run it against the sandbox

Follow `SETUP.md` first. It covers the PayPal sandbox app, the free Gemini key, and Render.

```
cp .env.example .env        then fill in the values
npm run seed                creates the $25 monthly plan and a subscription to approve
npm run seed -- --check     should say ACTIVE after you approve it
npm run seed -- --webhook https://YOUR-RENDER-URL/webhooks/paypal
npm start
```

After Script 5 sends its invoice, the record card links to PayPal's payer page. Open it while logged in as the sandbox personal account and pay it.

## Safety rules, in plain words

- Nothing about the gift is read or changed before the PIN passes. Three wrong PINs lock the call.
- Pausing, restarting, cancelling and sending an invoice each need a yes said in its own turn, right after the line read the details back. A yes inside the request does not count, and neither does a yes the page sent before the details reached it. The line also keeps its own record of when each turn arrived, so a yes that reached it before it had finished the reply that asked, or less than a quarter second after, never counts, whatever the page claims. The line asks again.
- A yes only counts when every word in it is a plain yes, such as yes, okay, sure, please or go ahead, or the one action word for what is waiting, as in "yes, pause it". A question, a "later", a request to repeat or a new email is never a yes. Neither is a turn typed with characters outside plain English letters and punctuation, or a turn that carried the PIN. The line asks again.
- If the caller moves on to something else while a change is waiting, the line sets that change aside and says so. A later yes can't approve it.
- Each of those changes needs a one-time token that only the yes can create, and it expires after a minute.
- Every amount, date, invoice number and status the line speaks comes from a PayPal read earlier in the same call, of the gift's own subscription, its plan, or the call's own draft. The grader also checks that each of those facts is actually said, that every other word is one the line's own templates use, and that every sentence, with its facts as slots, is one the templates say. A sentence that says what PayPal or the line did, such as "Done." or "PayPal no longer shows it", is checked against what PayPal actually returned in that call.
- After a change, the line reads PayPal again and says what PayPal shows. It never claims a status PayPal did not return.
- Invoices only go to the email already on file with PayPal. A new email from the caller is refused, however it is said, as in "bob [at] gmail [dot] com", "bob @ gmail.com", "bob, at gmail, dot com", "gmail dotcom", "gmail point com", "gmail .com", "gmail. com" or "bob -at- gmail -dot- com". The looser forms, with commas or marks around the words, count only when the caller also says an email word or a mail domain such as gmail, so "pause it at the end of the period, me and my wife are away" is a pause, not an email.
- A one-time gift needs one clear amount. If the caller corrects it, as in "fifty dollars, I mean sixty, one time", or names two different numbers, as in "fifty and sixty dollars", the line asks for the amount again, whatever amount Haiku heard.
- The PIN never lands in the log, the browser, a reply or the Haiku router, whether it is typed, said digit by digit, said as numbers like "twenty four sixty eight", or typed as superscript, circled or full-width characters. Keys stay in `.env` and are never logged.
- The words said before an answer are one of four fixed phrases the line owns. Haiku only picks which one, so it can't put a number or a claim in the line's mouth.

## Receipts and "How do you know?"

- The call state the line returns after every turn carries `receipts`, each sentence the line said with its verdict, proven, plain or blocked, the PayPal read behind each fact, and the claims it carries. They are built from the same ledger events and the same checks `npm run pilot:check` grades with. The page shows them under "What the line said", each proven sentence with a chip naming the PayPal read behind it and its time in PT.
- A donor who asks "How do you know?", "Are you sure?", "Says who?" or "Prove it." after the PIN hears the line read PayPal again. It says "I just checked PayPal's record again." and reads the gift's amount and status, and the call's draft when there is one, from those fresh reads. A change waiting for a yes stays open only while PayPal still shows what the line read back.
- `FEATURES.md` has the details.

## The morning after

Set `STAFF_KEY` to at least 16 characters and open `/staff`. A coordinator types the key and sees every call the line took, what the donor wanted, what PayPal changed and what PayPal shows now, with each call's sentences counted as proven, plain or blocked. Picking a call shows every sentence the line said beside the PayPal read behind each fact, with its time and debug id, and each claim with what the grader needed for it. The PIN, PIN turns, full emails, token ids and user agents never reach the page. With `STAFF_KEY` unset the view is off and every staff page is a 404. The table is AG Grid Community, served by the line itself, see `web/vendor/README.md`.

## The pilot

The pass bar and how each test is graded live in `PILOT.md`. The bar was set before any code existed and does not change after results come in. `npm run pilot:check` grades the ledger and writes `PILOT-RESULTS.md`.

## Known gaps

- After the Nov 2 review, pilot-check reads PILOT.md's checks more strictly than the change log says. Record these in the PILOT.md change log before the graded run if you agree. The bar itself is unchanged.
  - Scripts 1 to 10 come from the latest Chrome or Safari call of each, not any call outside Firefox, so an Edge run is recorded but never replaces a graded call. The Firefox clause still uses the latest Firefox calls of Scripts 2 and 3.
  - A call counts for a browser only when its user agent and the page's engine signals agree, so Chrome's iPhone device mode never counts as Safari. Reload the page after updating, since an old page sends no signals and its calls count as other.
  - A call that heard nothing after the PIN step is a mis-click and never replaces a real run. Test 3 needs all 10 scripts to pass every call check, behavior included, and no write without a yes in any call since `--since`.
  - In Test 4, finished by voice means the call passed its checks and ended with its own last line, the goodbye or the lock.
  - Test 1 also needs Script 3 to restart the same gift Script 2 paused, after it, and each script's proposal and write turns to read PayPal's amount and new status aloud.
  - Test 4 counts one gap per turn the line heard by voice, and a reply that never started playing counts as never.
  - Any graded event, or the paid webhook reaching Render, after Wed Nov 4, 2026, 9:00 pm PT fails every test. So grade before then, and run `--resend` early if Render lost the event.
  - The writes and safety checks, and a search for the PIN when `PILOT_PIN` is set, cover every call since `--since`, free calls and earlier tries included. A refused run replaces `PILOT-RESULTS.md` with a notice and moves the last real grade to `PILOT-RESULTS.previous.md`.
- After the third review on Nov 2, pilot-check reads PILOT.md's checks more strictly again. Record these in the PILOT.md change log too.
  - In Test 4, a browser's call also needs a voice turn after the PIN passed that the line acted on, so Script 8, which never verifies, never earns Chrome or Safari credit.
  - The facts check needs every declared amount, date, invoice ending and status to be said in the reply as whole words, and every other word to be one the line's own templates use, once the facts, the org name and the line's fixed phrases are set aside. The word list is `src/template-words.js`, and `npm run vocabulary` rebuilds it after a template changes. The org name it sets aside is the configured `ORG_NAME`, and a call that logged another name fails.
  - A fact counts only from the latest read of the gift's own subscription, that subscription's plan, or the call's own latest draft. Every subscription read and write in every call must target `DEMO_SUBSCRIPTION_ID`, and pilot-check refuses to grade when it isn't configured, in `.env` or in `.pilot/state.json` from `npm run seed`.
  - A yes whose turn arrived before the line finished the reply that asked, or reached the server sooner than `minAnswerMs` (250 ms) after it, fails the writes check.
  - Two gaps for one turn, or a gap shorter than the line's own time to make that reply, is a gap problem that fails Test 4, and neither gap of that turn counts toward the median.
  - The deadline is the earlier of Wed Nov 4, 9:00 pm PT and the end of the 6th logged hour, worked out from Start and End in PILOT.md's Hours log. Log your hours there before you grade, since pilot-check refuses a real grade when the log has no rows or a row it can't read. Graded calls with events outside every logged row are warnings, not fails. `--hours path` reads the log from another file.
  - Lateness counts what the caller and PayPal did, up to and including the reply to each call's last heard turn. The idle sweep's and the end beacon's own steps after that never make a run late. The paid webhook's arrival at Render still counts.
  - `--since` needs an ISO time with its offset, such as `2026-11-03T18:00-08:00`. Any run that stops without a fresh grade, on a bad flag or a config problem too, leaves the notice and moves the last real grade aside.
- After the fourth review on Nov 2, pilot-check reads PILOT.md's checks more strictly again. Record these in the PILOT.md change log too.
  - Graded calls come only from calls that started by the effective deadline. A call that started after it, such as a demo recorded later with a script picked, is listed as recorded after the deadline and never scored. A graded call that started before the deadline and ran past it still fails every test.
  - Script 1 needs a reply that read the amount and the status aloud from PayPal, so a PayPal blip that left the caller with no read-back fails it. Rerun it.
  - The facts check also needs every sentence, with the org name and its facts as slots named for their source, to be one the line's own templates say. The list is `TEMPLATE_SENTENCES` in `src/template-words.js`, and `npm run vocabulary` rebuilds it with the words.
  - Only rows on Tue Nov 3 and Wed Nov 4 count toward the 6 hours. A row on another day is a warning, and a log with no row on those days is refused.
  - A time with no am or pm is read only as a 24-hour time, so 5:00 or 8:30 is refused as unreadable. Write 5:00 pm or 17:00.
  - Each test in `PILOT-RESULTS.md` lists its clauses, met or missed, with the call each one used.
  - Flags are read strictly, as `--name value` or `--name=value`. An unknown flag, a stray value, a repeat, or a flag npm kept because the `--` was left out stops the run with the notice and the usage line.
  - pilot-check writes the no-grade notice first, before any flag, config or network step, so a run stopped by Ctrl-C or a timeout leaves the notice. Every fresh grade moves the earlier one to `PILOT-RESULTS.previous.md`, which holds one earlier grade only.
  - When Render shows the verified paid event, pilot-check saves its event id, invoice id and Render's receipt time in `.pilot/ledger.paid-webhook.json`, beside the ledger, and later runs for that invoice use it and ask Render and PayPal nothing. To check Render live again, move that file aside first.
- After the fifth review on Nov 2, pilot-check reads PILOT.md's checks more strictly again in one place and more forgivingly in two. Record these in the PILOT.md change log too.
  - The facts check also proves every sentence that says what PayPal or the line did. "Done." needs an ok write in that turn, "PayPal didn't accept that change." a write PayPal refused, "OK, I deleted that invoice ... PayPal no longer shows it." a delete of the call's own draft and a 404 read of it after, "PayPal still shows it" a read after the delete that still finds it, "I couldn't find a monthly gift" a read of the gift in that turn that found nothing, and the "didn't change anything" sentences no ok write in that turn. Each such sentence carries a claim, listed in `TEMPLATE_CLAIMS` in `src/template-words.js`, and a sentence its call's events don't back fails the facts check. A repeat is checked against the reply it repeats.
  - Every call logs the hash of the template list it was spoken with, and is graded with that list from `src/template-history.js`. So a template you reword during the pilot, then `npm run vocabulary`, no longer fails the calls made before it. A call whose list the history lacks, as when you grade with code older than the calls, fails the facts check, and the grade is refused with a notice that names the hash only when that is all that keeps it from a PASS (see the sixth review below).
  - Every call also logs `DEMO_SUBSCRIPTION_ID`. When every graded call logged the same `ORG_NAME` and `DEMO_SUBSCRIPTION_ID` and `.env` now names others, as after a new `ORG_NAME` for a demo video or a new `npm run seed`, the calls are graded with the values they logged. A pass is then refused with a notice that names both, so set `.env` back and grade again. A fail is still written as a FAIL, with a note.
  - Every real grade, PASS or FAIL, is kept in `pilot-results/` under its own PT time, and nothing replaces, moves or deletes one. `PILOT-RESULTS.md` is still the latest grade or notice, and `PILOT-RESULTS.previous.md` the grade before it.
  - `npm run vocabulary` now also writes `src/template-history.js`, and the vocabulary test fails on a template sentence with no claim and no place on `CLAIM_FREE` in `src/vocabulary.js`, the short list of sentences read by hand and found to claim nothing, with fact slots or without. A reworded sentence that claims nothing goes on that list, and one that says a result gets a claim in `src/say.js`.
  - On the line, the loose email forms, with commas, "gmail. com", "gmail,com", "period com" or marks touching at or dot, count only when the turn also says an email word or a mail domain, and "period" only before com, net, org, edu, gov or io. "bob at acme, dot, org" with no email word is plain words, and the draft still goes to the email on file.
- After the sixth review on Nov 2, pilot-check reads PILOT.md's checks in these ways. Record these in the PILOT.md change log too.
  - A graded call whose template list can't vouch for its replies, a list `src/template-history.js` lacks or one with a sentence the review in `src/vocabulary.js` never passed, fails the facts check, naming the hash. The grade is refused with a notice, never a PASS, only when that is all that keeps the run from a PASS. Any other fail or safety stop is still written as a FAIL or a stop, with a note naming the lists. An Edge or other call, never scored, never causes a refusal, and its list is only noted.
  - The review covers every template sentence, slotted ones too, the `{org}` slot included. A sentence `npm run vocabulary` adds that no one has read, such as "It will stop on December 1.", fails the vocabulary test, and pilot-check refuses calls that said it until it is read and listed in `src/vocabulary.js` and `npm run vocabulary` runs again. Each list in the history keeps the sentences the review passed, so a skipped `npm test` can't let one through.
  - Each call logs the hash of what say.js really speaks, built when the line starts, not the checked-in one. If you edit say.js and forget `npm run vocabulary`, the line prints a WARNING at start. The calls made then can't be graded until `npm run vocabulary` has added their list and any reworded sentence is on the review, so the grade is refused, never failed, when nothing else is wrong, and they grade as usual after.
  - The writes and safety checks hold each call in the window to the `DEMO_SUBSCRIPTION_ID` it logged, and its invoices to that subscription's own email on file. So a free call or a Script 5 demo on a new `npm run seed` subscription, after the run, no longer fails the pilot, and a regrade with the new id in `.env` is refused, never failed. The graded calls must still all use the pilot's own subscription.
  - A real grade an older pilot-check moved to `PILOT-RESULTS.previous.md` is now kept in `pilot-results/` too, before anything replaces it.
  - On the line, a short ending after a period, co, us, me, info, biz, uk or ca, joins an address only right after a mail domain or another short ending, as in "gmail. co. uk" or "outlook. us", so "I'm at work. Me and my wife will email you" is a stop request, not an email.
  - A caller who reads back the masked email on file, as in "Is it going to s b at personal dot example dot com?", is asked again for a yes or no, not refused. A new email said that way is still refused.
  - A write PayPal answers with a 4xx is said as refused, "PayPal didn't accept that change." A timeout or a 5xx may have gone through, so the line reads PayPal again and says "PayPal didn't answer clearly, so I checked again." and what PayPal now shows. A send PayPal shows as sent is never deleted at the end of the call. The write event logs PayPal's answer code as `httpStatus`, 0 for a timeout.
- Still open after the sixth review.
  - With Haiku, a number the caller said once in passing, as in "I'm 75 and I want to make a one-time gift", is drafted if Haiku reads it as the amount. Only a correction or two different numbers makes the line ask whatever Haiku heard. The line reads PayPal's draft back, and nothing is sent without a separate yes.
  - A correction with no number after it, as in "fifty dollars, I mean double that", is not caught, and the $50.00 draft is read back for a yes or a no.
  - Some spoken email forms are still plain words, such as "gmail dot c o m", "gmail full stop com", an address spelled letter by letter, "point me" for a .me ending, "period co period uk", a domain split in two, as in "bob at g mail.com", or a loose form with no email word, as in "bob at acme, dot, org". The draft still goes to the email on file.
  - The strict email forms still count in plain speech, so "look at the polka dot dress" or "at this point net of fees" is read as an email, and so does "period. Net" beside an email word, as in "Email me at the end of the period. Net of fees I am fine." The line says it can only use the email on file and sends nothing, but a graded call that hears one fails its behavior check, so rerun it.
- A write PayPal applied but whose answer was lost still fails that call's behavior check, and the gift or invoice may have changed. Before you rerun the script, listen to what the line said PayPal now shows, and put the gift back first if it changed, for example restart it in a free call before rerunning Script 2.
- The page measures the gap, so a deliberately faked client could still post one false gap per turn. The line now takes only one gap per turn, only for a reply it finished, and the grader flags a gap shorter than the line's own time for that reply.
- The same holds for a yes. A deliberately faked client that waits a quarter second after a proposal could still send a yes for a proposal it never showed. The line refuses any sooner yes, and any yes that arrived before the proposal existed.
- In rules mode, used only in mock runs and tests, a bare number counts as an amount only right after give or donate, or as the answer to the line's own amount question. Haiku reads the amount in the pilot, unless the caller's words correct it or name two different numbers, and the line reads PayPal's draft back before any send.
- A PIN said by voice that starts with an "oh", as in "Oh, 2468", reads as a wrong PIN, since oh can mean zero. The scripts use the keypad, so type the PIN there.
- Some PayPal sandbox details are unconfirmed, such as whether a sent invoice reads SENT or UNPAID. The code accepts both. See `.pilot/facts-paypal.md`.
- Render's free service sleeps after 15 minutes, and waking wipes its event list. PayPal retries webhooks for 3 days, and `npm run pilot:check -- --render URL --resend` wakes the service, asks PayPal to send the paid event again, then checks Render's list for up to about two minutes.
- On Render, ten wrong PINs in an hour from one address stop PIN entry from that address for the rest of the hour, across all its calls. The line keys this, and its other limits, on the last address in `X-Forwarded-For`, which a caller can't set.

## License

MIT, copyright 2026 Arnav Singh. See `LICENSE`.
