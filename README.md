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
- Pausing, restarting, cancelling and sending an invoice each need a yes said in its own turn, right after the line read the details back. A yes inside the request does not count.
- A yes only counts when every word in it is a plain yes, such as yes, okay, sure, please or go ahead, or the one action word for what is waiting, as in "yes, pause it". A question, a "later", a request to repeat or a new email is never a yes.
- If the caller moves on to something else while a change is waiting, the line sets that change aside and says so. A later yes can't approve it.
- Each of those changes needs a one-time token that only the yes can create, and it expires after a minute.
- Every amount, date, invoice number and status the line speaks comes from a PayPal read earlier in the same call.
- After a change, the line reads PayPal again and says what PayPal shows. It never claims a status PayPal did not return.
- Invoices only go to the email already on file with PayPal. A new email from the caller is refused.
- The PIN never lands in the log, the browser, a reply or the Haiku router, whether it is typed, said digit by digit, or said as numbers like "twenty four sixty eight". Keys stay in `.env` and are never logged.
- The words said before an answer are one of four fixed phrases the line owns. Haiku only picks which one, so it can't put a number or a claim in the line's mouth.

## The pilot

The pass bar and how each test is graded live in `PILOT.md`. The bar was set before any code existed and does not change after results come in. `npm run pilot:check` grades the ledger and writes `PILOT-RESULTS.md`.

## Known gaps

- PILOT.md grades the latest call per script, and also asks for Scripts 2 and 3 again in Firefox. If the Firefox runs came last, they would replace the voice runs Test 1 needs. So pilot-check grades Scripts 1 to 10 from the latest calls outside Firefox, and grades the Firefox clause of Test 4 from the latest Firefox calls. Record this in the PILOT.md change log before the graded run if you agree.
- Some PayPal sandbox details are unconfirmed, such as whether a sent invoice reads SENT or UNPAID. The code accepts both. See `.pilot/facts-paypal.md`.
- Render's free service sleeps after 15 minutes, and waking wipes its event list. PayPal retries webhooks for 3 days, and `npm run pilot:check -- --render URL --resend` wakes the service, asks PayPal to send the paid event again, then checks Render's list for up to about two minutes.
- On Render, ten wrong PINs in an hour from one address stop PIN entry from that address for the rest of the hour, across all its calls. The line keys this, and its other limits, on the last address in `X-Forwarded-For`, which a caller can't set.

## License

MIT, copyright 2026 Arnav Singh. See `LICENSE`.
