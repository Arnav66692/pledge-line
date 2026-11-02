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
- Pausing, restarting, cancelling and sending an invoice each need a yes said in its own turn, right after the line read the details back. A yes inside the request does not count, and neither does a yes the page sent before the details reached it.
- A yes only counts when every word in it is a plain yes, such as yes, okay, sure, please or go ahead, or the one action word for what is waiting, as in "yes, pause it". A question, a "later", a request to repeat or a new email is never a yes. Neither is a turn typed with characters outside plain English letters and punctuation, or a turn that carried the PIN. The line asks again.
- If the caller moves on to something else while a change is waiting, the line sets that change aside and says so. A later yes can't approve it.
- Each of those changes needs a one-time token that only the yes can create, and it expires after a minute.
- Every amount, date, invoice number and status the line speaks comes from a PayPal read earlier in the same call.
- After a change, the line reads PayPal again and says what PayPal shows. It never claims a status PayPal did not return.
- Invoices only go to the email already on file with PayPal. A new email from the caller is refused.
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
- A PIN said by voice that starts with an "oh", as in "Oh, 2468", reads as a wrong PIN, since oh can mean zero. The scripts use the keypad, so type the PIN there.
- Some PayPal sandbox details are unconfirmed, such as whether a sent invoice reads SENT or UNPAID. The code accepts both. See `.pilot/facts-paypal.md`.
- Render's free service sleeps after 15 minutes, and waking wipes its event list. PayPal retries webhooks for 3 days, and `npm run pilot:check -- --render URL --resend` wakes the service, asks PayPal to send the paid event again, then checks Render's list for up to about two minutes.
- On Render, ten wrong PINs in an hour from one address stop PIN entry from that address for the rest of the hour, across all its calls. The line keys this, and its other limits, on the last address in `X-Forwarded-For`, which a caller can't set.

## License

MIT, copyright 2026 Arnav Singh. See `LICENSE`.
