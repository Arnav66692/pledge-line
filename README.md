# Pledge Line

The after-hours donor line for small nonprofits.

A monthly donor opens the line in a browser and proves who she is with a PIN. When she asks to stop her gift, the line reads her amount from PayPal's own record and offers a pause. Only after her separate spoken yes does it call PayPal's suspend, and then it reads the new status back from a fresh PayPal read. A one-time gift becomes a PayPal draft invoice. The line reads the draft back from PayPal, sends it only on yes, and deletes it on no.

This is a pilot for the PayPal AI Hackathon. It runs against the PayPal sandbox only, so no real money moves.

## What is live and what is simulated

Live in the pilot, once the keys are in `.env`.

- PayPal sandbox REST calls for subscriptions, invoices and webhook checks. The code refuses any other PayPal address.
- Claude Haiku 5.5 reads what the caller means. It never decides a yes or a no, and it never touches PayPal.
- Speech in and out uses the browser's own speech tools. Chrome and Safari can listen. Firefox uses the typed box.

Simulated in mock mode.

- `PAYPAL_MODE=mock` swaps in a fake PayPal held in memory.
- `ROUTER_MODE=rules` swaps Haiku for offline keyword rules.
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

Follow `SETUP.md` first. It covers the PayPal sandbox app, the Anthropic key with a spend limit, and Render.

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
- Every amount, date, invoice number and status the line speaks comes from a PayPal read earlier in the same call, of the gift's own subscription, its plan, or the call's own draft. The grader also checks that each of those facts is actually said, that every other word is one the line's own templates use, and that every sentence, with its facts as slots, is one the templates say.
- After a change, the line reads PayPal again and says what PayPal shows. It never claims a status PayPal did not return.
- Invoices only go to the email already on file with PayPal. A new email from the caller is refused, however it is said, as in "bob [at] gmail [dot] com", "bob @ gmail.com", "bob, at gmail, dot com", "gmail dotcom", "gmail point com", "gmail .com" or "gmail. com".
- A one-time gift needs one clear amount. If the caller corrects it, as in "fifty dollars, I mean sixty, one time", or names two different numbers, as in "fifty and sixty dollars", the line asks for the amount again, whatever amount Haiku heard.
- The PIN never lands in the log, the browser, a reply or the Haiku router, whether it is typed, said digit by digit, said as numbers like "twenty four sixty eight", or typed as superscript, circled or full-width characters. Keys stay in `.env` and are never logged.
- The words said before an answer are one of four fixed phrases the line owns. Haiku only picks which one, so it can't put a number or a claim in the line's mouth.

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
- Still open after the fourth review.
  - With Haiku, a number the caller said once in passing, as in "I'm 75 and I want to make a one-time gift", is drafted if Haiku reads it as the amount. Only a correction or two different numbers makes the line ask whatever Haiku heard. The line reads PayPal's draft back, and nothing is sent without a separate yes.
  - A correction with no number after it, as in "fifty dollars, I mean double that", is not caught, and the $50.00 draft is read back for a yes or a no.
  - Some spoken email forms are still plain words, such as "gmail dot c o m", "gmail full stop com", an address spelled letter by letter, or "point me" for a .me ending. The draft still goes to the email on file.
- The page measures the gap, so a deliberately faked client could still post one false gap per turn. The line now takes only one gap per turn, only for a reply it finished, and the grader flags a gap shorter than the line's own time for that reply.
- The same holds for a yes. A deliberately faked client that waits a quarter second after a proposal could still send a yes for a proposal it never showed. The line refuses any sooner yes, and any yes that arrived before the proposal existed.
- In rules mode, used only in mock runs and tests, a bare number counts as an amount only right after give or donate, or as the answer to the line's own amount question. Haiku reads the amount in the pilot, unless the caller's words correct it or name two different numbers, and the line reads PayPal's draft back before any send.
- A PIN said by voice that starts with an "oh", as in "Oh, 2468", reads as a wrong PIN, since oh can mean zero. The scripts use the keypad, so type the PIN there.
- Some PayPal sandbox details are unconfirmed, such as whether a sent invoice reads SENT or UNPAID. The code accepts both. See `.pilot/facts-paypal.md`.
- Render's free service sleeps after 15 minutes, and waking wipes its event list. PayPal retries webhooks for 3 days, and `npm run pilot:check -- --render URL --resend` wakes the service, asks PayPal to send the paid event again, then checks Render's list for up to about two minutes.
- On Render, ten wrong PINs in an hour from one address stop PIN entry from that address for the rest of the hour, across all its calls. The line keys this, and its other limits, on the last address in `X-Forwarded-For`, which a caller can't set.

## License

MIT, copyright 2026 Arnav Singh. See `LICENSE`.
