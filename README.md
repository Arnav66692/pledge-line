# Pledge Line

The after-hours donor line for small nonprofits.

A monthly donor opens the line in a browser and passes a shared pilot PIN check. That check gates the fictional demo account; it does not establish a real donor's identity. When she asks to stop her gift, the line reads her amount from PayPal's own record and offers a pause. Only after her separate spoken yes does it call PayPal's suspend, and then it reads the new status back from a fresh PayPal read. A one-time gift becomes a PayPal draft invoice. The line reads the draft back from PayPal, sends it only on yes, and deletes it on no.

A donor who sees a PayPal charge she doesn't recognize can ask the line about it. It reads the gift's latest charge from PayPal and says the amount, the date, the status and the end of the PayPal transaction id. This unrecognized-charge path records a separate staff refund-review request after consent. It is distinct from eligible hardship relief, which completes the refund itself. A charge PayPal shows as refunded or declined gets no offer.

A donor who can't afford this month can say so. The line reads her last charge, checks the staff rule, and offers to give the month back with a sponsor's hardship fund paying the same amount to the nonprofit. On her yes it captures that amount from the sponsor's PayPal hold, refunds her charge, and reads both back from PayPal. The eligible relief flow completes both financial legs itself. The Supply desk also settles approved supplier orders. All these payments use sandbox funds.

This is a pilot for the PayPal AI Hackathon. It runs against the PayPal sandbox only, so no real money moves.

## What is live and what is simulated

The donor line supports the following capabilities with the required private configuration. The historical pilot uses `.env`; the new guarded agent has additional setup below.

- PayPal sandbox REST calls for subscriptions, a subscription's transaction list, invoices, webhook checks, and Covered Month's capture, refund and reads. The code refuses any other PayPal address.
- An AI router reads what the caller means. The integration's `ROUTER_MODE=anthropic` selects Claude Sonnet 5.5 with Jev 1.14 advisory routing/review through a PostgreSQL-backed spending gateway. Gemini remains an explicit historical pilot option; it is not an automatic fallback. Legacy `haiku` mode is refused by integration startup. Models never authorize a yes, an amount or a payment; code does.
- Speech in and out uses the browser's own speech tools. Chrome and Safari can listen. Firefox uses the typed box.

Simulated in mock mode.

- `PAYPAL_MODE=mock` swaps in a fake PayPal held in memory.
- `ROUTER_MODE=rules` swaps the AI router for offline keyword rules.
- Any run with either switch on prints `MOCK RUN, does not count` and never writes a pass.

The separate Supply desk at `/procurement` defaults to simulated suppliers and mock settlement. In the November 5 composed acceptance, Anthropic planning and Jev advisory review contacted three controlled MCP suppliers and produced a 100-shirt plan for $676.25 within an $800 budget. Exact-plan approval and separate buyer approvals completed two PayPal sandbox captures, with fresh order/capture reads matching stored amounts, merchant and identities. The app/private lab restarted between legs, and the original tab recovered the partial purchase. See the [current acceptance report](docs/FUNCTIONAL-ACCEPTANCE-2026-11-05.md); the earlier $674.15 rules-routing checkout remains historical evidence. All three lab endpoints use one owned sandbox merchant; they are project-controlled software, not independent businesses or fulfillment. No mode enables real money.

The donor and nonprofit are fictional. The guarded release uses the name Pledge Line Sandbox Pantry; older pilot records retain Sunny Hollow Pantry.

## Run it in mock mode

Node 22.12 or later. Nothing else to set up.

```
npm install
npm run dev
```

Open http://localhost:3000, press Start call, and type the PIN 2468 on the keypad. Without configured donor durability, mock calls go to `.pilot/mock-ledger.jsonl`, apart from the pilot ledger. If you copied the guarded `.env.example`, set `DONOR_DURABILITY_ENABLED=false` for this database-free mode. The line refuses to start in mock or rules mode if `LEDGER_PATH` points at the pilot ledger.

The line allows 20 new calls an hour from one address. On your laptop every browser shares that, so if Start call says to try again later, wait or restart the mock server with `npm run dev`, which clears it.

```
npm test
npm run pilot:dry -- --mock
```

The default tests and the mock dry run need no external services or keys. Hosted database tests are opt-in through `DATABASE_TEST_URL`, `DONOR_RUNTIME_TEST_URL` and `SUPPLIER_QUOTE_TEST_URL`; skipped hosted cases do not count as acceptance.

## The supply desk

Open `/procurement`, also linked as **Supply desk** in the navigation. Give the agent a specification, quantity, total USD budget and delivery deadline. By default it asks three simulated suppliers for quotes. With the guarded agent enabled, Sonnet suggests bounded counteroffers and Jev provides advisory review; code validates the replies and finds the cheapest complete allocation. Setup, shipping and tax count toward the budget, including when suppliers split the order. The page compares this plan with the same solver's allocation from initial quotes; those savings apply only to the supplied quote set.

Review the exact suppliers, payees, quantities, delivery terms and total before approving. Approval is bound to that plan and a separate random session key protects its API. Changed or expired quotes prevent a new settlement. An uncertain result blocks later supplier payments; reconciliation checks the same payment identity. Partial settlement stays visible and never implies an automatic refund or replacement purchase.

Mock recovery controls stage lost responses, pending payments, a supplier decline, a changed payee, expired quotes and missed delivery. In `PROCUREMENT_SUPPLIER_MODE=mcp-sandbox`, each allocated supplier has a separate PayPal order, buyer approval and capture. Unknown results retain their committed identities and block fresh attempts. The guarded hosted release enables `HOSTED_SUPPLIER_LAB_ENABLED=true`: three authenticated MCP listeners run privately on loopback ports 3160–3162 inside the same Node process, with immutable quotes stored in PostgreSQL. Only the main web port is public. All three controlled suppliers use one configured sandbox merchant; independent business participation and goods fulfillment have not been established. With the hosted lab disabled, an operator registry and dedicated MCP credentials can connect separately authorized endpoints. The [original supplier lab guide](docs/SUPPLIER-LAB.md) describes the separate-process development option.

An expired plan can be closed in the app only after fresh reads establish that it is unpaid and no capture was attempted. The permanent `closed_unpaid` latch revokes that plan's app authority; it does not cancel PayPal orders. New quotes and exact approval are required afterward. Optional [read-only recovery](docs/CHECKOUT-RECOVERY.md) checks known uncertain identities automatically, without creating or capturing orders or advancing another payment.

Sandbox order creation and capture require both `PAYPAL_SANDBOX_CHECKOUT_WRITES=true` and a clock at or after November 4, 2026, 9:00 pm PT (`2026-11-05T05:00:00Z`). The switch alone does not bypass the time gate. [Commerce setup](docs/COMMERCE.md) covers the registry and checkout protocol. The November 5 completion release is separately authorized for deployment after full-flow acceptance; historical pilot grades and failed attempts remain preserved.

## Guarded AI setup

The new agent requires explicit `ANTHROPIC_API_KEY` and `TYPESAFE_API_KEY` values in a private `.ai.env`, the runtime database connection, and `AI_PREPAID_ONLY_CONFIRMED=true`. That setting records the operator's confirmation of the intended API-credit funding, not an automatic account verification. Both keys authenticate. A signed-in Anthropic check found a $200 Ultra promotional API grant, $0 purchased credits and no saved payment method or auto-reload configuration shown. The grant is linked to Ultra for issuance but API usage is separate from the plan's usage limits and is never charged to the Claude plan. The user confirmed Jev's $10 balance and instructed work to proceed. Jev recharge settings remain independently unverified. The fresh blind-reviewed V4 evaluation passed: 29/30 routes, zero wrong mutations, all ten pending-consent cases with zero provider calls, median 3,465 ms. The three earlier failed evaluations remain preserved. This is synthetic held-out evidence, not a voice/user study or score guarantee. [Connection, billing and evaluation evidence](docs/AI-STATUS.md) records the results and limits.

The gateway uses fixed provider hosts and explicit API keys, without an SDK credential chain, subscription/OAuth login, automatic retry or alternate-provider fallback. PostgreSQL reserves a conservative request cost before dispatch. Defaults are $5 for Anthropic and $0.25 for Jev: development allocations, not verified provider balances. Exhaustion, authentication/billing failure or unverified usage latches a shared stop; ambiguous calls retain their full reservation and stop both providers. Restarting does not clear the durable stop.

Historical acceptance: after the first composed quote failed and retained its $0.05124 reservation, one separately approved quote test verified the corrected Anthropic planner, Jev advisory review and three controlled MCP supplier endpoints. It produced a 100-shirt plan for $676.25 within an $800 budget. Jev flagged closer review, and that bounded test made no approval or PayPal payment. The model requests cost $0.005544906 in total, and that test allocation was stopped afterward. The original stop/reservation remain intact. V4 remains evidence for its frozen routing version. [Acceptance details](docs/AI-STATUS.md) preserve those outcomes.

The separately authorized completion scope is `pledge-line-functional-20261105`, capped at **$3.00 Anthropic and $0.10 Jev across local acceptance and deployment together**. Deployment must reuse that scope's remaining allocation and latched stop, never initialize a fresh budget to bypass it. The model-produced purchase, donor pause/resume and Covered Month flows, and receipt restart verification have passed. The latest suite has 730 passes, seven optional hosted skips and no failures. Browser keypad/typed/reload/restart, disposable cancellation and genuine signed paid-webhook checks passed. The tested release is live at [pledge-line.onrender.com](https://pledge-line.onrender.com); hosted donor, Anthropic/Jev/MCP, receipt and permanent webhook checks passed. Three additional hosted runtime tests passed separately. See the [current acceptance report](docs/FUNCTIONAL-ACCEPTANCE-2026-11-05.md) and [strict desk review](docs/STINGY-JUDGES-2026-11-05.md). A new microphone study, current recording and outside-user benefit are not claimed.

After configuration and explicit migrations, choose one local startup mode:

```sh
# Guarded AI with mock PayPal/suppliers; API inference still consumes the allocation.
PAYPAL_MODE=mock ROUTER_MODE=anthropic node --env-file=.database.env --env-file=.ai.env src/server.js
# Complete sandbox release, after selecting the hosted flags and payee in .env.
# Load credential files last so empty template fields cannot override their private values.
node --env-file=.env --env-file=.database.env --env-file=.ai.env --env-file=.sandbox.env src/server.js
```

For the second command, set `DONOR_DURABILITY_ENABLED=true`, `PROCUREMENT_SUPPLIER_MODE=mcp-sandbox`, `HOSTED_SUPPLIER_LAB_ENABLED=true`, the owned `SUPPLIER_LAB_PAYEE_ID`, and the required donor/hold/webhook IDs. Enable `PAYPAL_SANDBOX_CHECKOUT_WRITES=true` only for the authorized sandbox checkout run. The Blueprint already carries the hosted flags; private credentials and resource IDs still belong in Render's environment.

Keep keys in those ignored private files, never in command arguments or logs. Check `/api/ai/status` for local allocation/stop status and `/api/commerce-status` for sandbox availability. Neither endpoint proves provider credit balance or production readiness. The frozen [90-point evaluation](docs/AI-EVAL.md) defines the evidence needed; unit tests alone do not establish a score of 72 or 80.

## PostgreSQL storage

The integration checkout has a Neon PostgreSQL 17 database with verified TLS. The original journal migrations 1 and 2, AI budget schema 1, sandbox checkout schema 1, supplier quote schema 1 and donor schema 1 have been explicitly applied. With `DATABASE_URL` configured, the server persists procurement operations, verified PayPal webhook deliveries, approved network plans, quote evidence, session-key hashes and stable provider identities. Guarded AI spending uses its own durable allocation records. Startup checks the schemas required by the selected flags and does not fall back to memory if configured storage fails.

With `DONOR_DURABILITY_ENABLED=true`, donor calls and sanitized audit events use PostgreSQL. Every provider write first commits an immutable one-attempt claim, and returned provider identities persist before later confirmation. Uncertain writes remain occupied across restarts; recovery reads known identities without replaying financial writes. The original browser tab retains its session bearer in `sessionStorage`. Restored donor calls require the PIN again and fresh consent; pending approvals and write tokens are not restored. Durable idle cleanup also checks persisted calls that no browser has rehydrated.

Mock procurement sessions and unapproved quote sessions remain in memory. Approved sandbox checkouts can resume from PostgreSQL using the original tab's key; return URLs do not grant authority. Losing that key is not permission to start a replacement purchase. The optional checkout recovery worker reconciles existing known uncertain identities without creating or capturing orders. Turning donor durability off restores the legacy local JSONL behavior. None of these stores enables live payments.

The local `.database.env` holds the restricted runtime connection. Check it and start the integration server with:

```sh
node --env-file=.database.env scripts/database-check.js --require-tls
node --env-file=.database.env scripts/feature-storage-check.js --require-tls
node --env-file=.database.env src/server.js
```

`feature-storage-check.js` checks donor and supplier schemas without writes by default. Applying missing reviewed schemas requires its explicit `--migrate` flag and the separate administrator connection; runtime grants remain a separate operator action. The [database guide](docs/DATABASE.md#setup-and-checks) gives the complete checks and migration commands.

The basic startup command expects the donor-line configuration in the environment. For an offline donor line, prefix it with `PAYPAL_MODE=mock ROUTER_MODE=rules`. For guarded AI and optional MCP checkout, use the complete startup commands above so `.ai.env` and any supplier settings are loaded. `npm start` loads `.env` only; it does not automatically load the other private files.

`.database-admin.env` is reserved for explicit administrator migrations. Both local database files are ignored and should remain mode `600`; never commit or print them. The runtime role receives only the exact table and sequence privileges its stores need, with no deletion, schema changes or migration writes. See [the database guide](docs/DATABASE.md) for the original journal/AI/checkout details and [production requirements](PRODUCTION.md) for the separate live-payment boundary.

## Deploy the sandbox release after acceptance

Use the existing free Render web service and [render.yaml](render.yaml): `npm ci`, `node src/server.js`, and `/healthz`. Let Render supply `PORT`; set `HOST=0.0.0.0` and `PUBLIC_BASE_URL=https://pledge-line.onrender.com`. Keep the supplier ports private and preserve the configured sandbox merchant. No extra supplier service, paid instance or disk is required.

Configure these privately in Render: the restricted runtime `DATABASE_URL`, `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY`, sandbox `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `DEMO_SUBSCRIPTION_ID`, `SPONSOR_HOLD_ID`, `PILOT_PIN`, `STAFF_KEY`, and the existing stable `RECEIPT_SIGNING_KEY`. Never upload the administrator database URL. Preserve the signing key across releases so existing receipt links and signatures remain usable. Register the final HTTPS `/webhooks/paypal` URL for the same sandbox app.

Deploy only after the full local flow and restart tests pass. Then check hosted donor/session recovery, exact supplier checkout recovery, a verified PayPal webhook and receipt verification. `/healthz` alone does not establish those behaviors. Existing pilot grades stay historical; this release does not rerun or rewrite their deadline-bound score.

## The claim audit

`EVAL.md` is a preregistered check of how often a plain AI agent tells a donor something PayPal's record doesn't back, next to Pledge Line on the same 20 calls. It counts amounts, status words, dates and phrases such as "done" or "is now paused" that the mock PayPal doesn't back at the moment they are said, writes with no yes in the line before, and statuses no PayPal read had shown.

```
npm run audit -- --fake
```

`--fake` runs the baseline with a scripted fake model, so it needs no key and makes no network call. Its table checks the plumbing and is never a result. The table and a JSON file with every claim land in `.pilot/claim-audit/`. It runs from any checkout, writes only inside `.pilot/claim-audit/`, which git ignores, and refuses to write the pilot ledger. The real run, `npm run audit` with no flag, calls Gemini with `GEMINI_API_KEY`, spaces its requests like the dry run and stops on a 429. Per `EVAL.md` it waits until the pilot is graded and Arnav says go.

The report also has a view called the gate over the plain agent. For each reply the plain agent gave, it marks which sentences hold a claim the audit found unbacked, and says what a donor would have heard instead, from the record that claim was held to. It reads the same claims the tables count, so it is no new score. Pledge Line's own sentences are templates, so a gate on them blocks almost nothing, and the report says so. The scripted fake model follows its rules, so a `--fake` run marks nothing, and the tests script the mistakes.

## Historical sandbox pilot setup

`SETUP.md` preserves the original PayPal/Gemini pilot bootstrap below. Use the guarded startup and deployment instructions above for the separately authorized completion release; retain historical pilot seeds and grade artifacts. The current template selects `anthropic`, while the historical pilot explicitly selects `gemini`.

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
- Pausing, restarting, cancelling, sending an invoice and asking staff about a refund each need a yes said in its own turn, right after the line read the details back. A yes inside the request does not count, and neither does a yes the page sent before the details reached it. The line also keeps its own record of when each turn arrived, so a yes that reached it before it had finished the reply that asked, or less than a quarter second after, never counts, whatever the page claims. The line asks again.
- A yes only counts when every word in it is a plain yes, such as yes, okay, sure, please or go ahead, or the one action word for what is waiting, as in "yes, pause it". A question, a "later", a request to repeat or a new email is never a yes. Neither is a turn typed with characters outside plain English letters and punctuation, or a turn that carried the PIN. The line asks again.
- If the caller moves on to something else while a change is waiting, the line sets that change aside and says so. A later yes can't approve it.
- Each of those changes needs a one-time token that only the yes can create, and it expires after a minute.
- Every amount, date, invoice number and status the line speaks comes from a PayPal read earlier in the same call, of the gift's own subscription, its plan, or the call's own draft. The grader also checks that each of those facts is actually said, that every other word is one the line's own templates use, and that every sentence, with its facts as slots, is one the templates say. A sentence that says what PayPal or the line did, such as "Done." or "PayPal no longer shows it", is checked against what PayPal actually returned in that call.
- After a change, the line reads PayPal again and says what PayPal shows. It never claims a status PayPal did not return.
- Invoices only go to the email already on file with PayPal. A new email from the caller is refused, however it is said, as in "bob [at] gmail [dot] com", "bob @ gmail.com", "bob, at gmail, dot com", "gmail dotcom", "gmail point com", "gmail .com", "gmail. com" or "bob -at- gmail -dot- com". The looser forms, with commas or marks around the words, count only when the caller also says an email word or a mail domain such as gmail, so "pause it at the end of the period, me and my wife are away" is a pause, not an email.
- A one-time gift needs one clear amount, and code decides that, not the model. A number the caller gave as an age, a correction, a relative word such as "double that", two different numbers, or an amount the router picked that isn't in her words all get "How much would you like to give?", and nothing is created. A question about the gift she has, as in "Is my gift still seventy five dollars a month?", reads that gift from PayPal.
- The browser receives and sends the PIN for verification, including when it is spoken. The page hides typed input and interim speech, then shows the server-masked text; recognized PIN forms do not appear in the displayed transcript, log, reply or router. This masking covers digits, spoken number words and Unicode number forms the server recognizes. Keys stay in private environment files and are never logged.
- The words said before an answer are one of four fixed phrases the line owns. The router only picks which one, so it can't put a number or a claim in the line's mouth.

## Is this charge real?

After the PIN, try "I see a PayPal charge I don't recognize." In mock mode the fake PayPal holds one completed $25.00 charge on the 1st of the month, transaction ending in 0042. Say yes and the line logs a refund request for staff, reads PayPal again and reads the charge back. Nothing in PayPal changes. `PICK.md` says why this move was picked, `FEATURES.md` has the details and `SPEC.md` the contract.

## Covered Month

After the PIN, try "I lost my job, I can't do it this month." In mock mode the fake PayPal holds the same $25.00 charge and a sponsor's $200.00 hold. Say yes, and the page shows the refund and the sponsor's payment, each from its own PayPal read, under "Covered month". The gift itself doesn't change, so the line says when the next one comes.

- The staff rule is `COVER_MAX_DOLLARS`, `COVER_WINDOW_DAYS` and `COVER_PER_YEAR`, with defaults of $50, 30 days and once a year. `COVER_PER_YEAR=0` turns it off.
- In the sandbox, the sponsor consents once in the browser. `npm run seed:hold` makes the order and prints the link, then `npm run seed:hold -- --authorize` saves the hold. With no hold, the line says the fund isn't open and moves nothing. A hold lasts 29 days, so seed it within 3 days of filming.
- The page and the staff view both show the fee a refund leaves behind. PayPal keeps its fee on the refunded gift and takes one on the sponsor's payment, so the nonprofit ends one fee short of a gift that stood.
- With donor durability enabled, a committed claim blocks another Covered Month attempt for that charge across restarts. A returned provider identity is retained for read-only reconciliation; an unknown write without an identity stays blocked. The legacy local-ledger mode does not provide this cross-restart protection.
- `PICK.md` says why, `FEATURES.md` has the details and `SPEC.md` the contract.

## When something goes wrong in a call

The call state carries `recovery`, built on the server from the call's ledger events the same way receipts are. When something goes wrong and the line handles it, the page shows a short timeline under "PayPal's record": what the donor wanted, what went wrong, what the line did and what PayPal shows now, each with its time in PT and PayPal's reference when there is one. It covers a timeout or 5xx followed by a fresh read, a refusal, a record someone else changed, a failed PayPal step and an unclear amount. When nothing went wrong, nothing shows.

To see it, stage a fault on the mock. `FAULT_DRILL` is refused unless `PAYPAL_MODE` is mock, it fires at most once per call, and each such call is labeled a fault drill on the page. A mock call is labeled too.

```
FAULT_DRILL=suspend-timeout npm run dev
```

The drills are `suspend-timeout`, `suspend-503`, `suspend-refused` and `gift-changed`. After the PIN, say "Pause my gift.", then "Yes.". For `gift-changed`, say "Are you sure?" instead of yes. `FEATURES.md` has the details.

## Receipts and "How do you know?"

- The call state the line returns after every turn carries `receipts`, each sentence the line said with its verdict, proven, plain or blocked, the PayPal read behind each fact, and the claims it carries. They are built from the same ledger events and the same checks `npm run pilot:check` grades with. The page shows them under "What the line said", each proven sentence with a chip naming the PayPal read behind it and its time in PT.
- A donor who asks "How do you know?", "Are you sure?", "Says who?" or "Prove it." after the PIN hears the line read PayPal again. It says "I just checked PayPal's record again." and reads the gift's amount and status, and the call's draft when there is one, from those fresh reads. A change waiting for a yes stays open only while PayPal still shows what the line read back.
- `FEATURES.md` has the details.

## The morning after

Set `STAFF_KEY` to at least 16 characters and open `/staff`. A coordinator types the key and sees every call the line took, what the donor wanted, what PayPal changed and what PayPal shows now, with each call's sentences counted as proven, plain or blocked. Picking a call shows every sentence the line said beside the PayPal read behind each fact, with its time and debug id, and each claim with what the grader needed for it. The PIN, PIN turns, full emails, token ids and user agents never reach the page. With `STAFF_KEY` unset the view is off and every staff page is a 404. The table is AG Grid Community, served by the line itself, see `web/vendor/README.md`.

## A receipt the donor keeps

Set `RECEIPT_SIGNING_KEY` to 64 hex characters (`SETUP.md` shows how) and, when a call ends, the donor page offers "Keep a receipt of this call". It opens a printable page with every sentence the line said, in order, and what backs each one, and offers the receipt file to download. The line signs every sentence with Ed25519 and chains them with sha256, so the file is tamper-evident. Any edit can be detected, and the check says which sentence changed. It can't stop an edit. Drop a file on `/check`, or check it offline with only the public key from `/receipt-key`.

```
node scripts/check-receipt.js receipt.json --key receipt-key.json
```

Only the page that started a call gets that call's receipt secret. Call APIs require a separate random session bearer retained by the original tab in `sessionStorage`, regardless of whether receipts are enabled. A receipt link or file does not grant access to the call transcript or controls. The file uses a stable, pseudonymous receipt identifier instead of the call's live API ID, and holds no PIN, full email, token ids or user agent. A recipient can still read all of the receipt's contents, so share it only with people you trust. With donor durability and the same signing key, server receipts remain available after a restart; downloaded files also remain independently verifiable. With the key unset, the button and every receipt page are off, as 404s. `FEATURES.md` has the file's format.

## The pilot

The pass bar and how each test is graded live in `PILOT.md`. The bar was set before any code existed and does not change after results come in. `npm run pilot:check` grades the ledger and writes `PILOT-RESULTS.md`.

## Known gaps

The November 5 sandbox run confirmed the subscription transaction-list shape with a completed $25.00 charge. Covered Month then completed a $25.00 sponsor capture and a $25.00 donor refund, each through a confirmed one-attempt action and fresh provider reads; the subscription remained ACTIVE. See the [donor proof](docs/results/functional-acceptance-2026-11-05/donor.json) and [current functional acceptance report](docs/FUNCTIONAL-ACCEPTANCE-2026-11-05.md). This closes the earlier mock-only coverage gap; the complete release acceptance and deployment gates remain tracked in that report.

- A newly approved sandbox subscription may list no completed charge until its first bill, so a charge-check demo needs a gift that has billed once.
- The charge check reads only the latest charge, and a donor has to link the charge to this nonprofit before she calls.
- Refund confirmation uses a fresh `GET /v2/payments/captures/{id}` showing REFUNDED. This proof does not establish how every subscription transaction-list entry represents a refund.
- PayPal's read of a hold gives its whole amount, not what is left. A hold drawn down too far is caught when PayPal refuses the capture, which runs first, so the donor hears no money moved.

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
  - Some spoken email forms are still plain words, such as "gmail dot c o m", "gmail full stop com", an address spelled letter by letter, "point me" for a .me ending, "period co period uk", a domain split in two, as in "bob at g mail.com", or a loose form with no email word, as in "bob at acme, dot, org". The draft still goes to the email on file.
  - The strict email forms still count in plain speech, so "look at the polka dot dress" or "at this point net of fees" is read as an email, and so does "period. Net" beside an email word, as in "Email me at the end of the period. Net of fees I am fine." The line says it can only use the email on file and sends nothing, but a graded call that hears one fails its behavior check, so rerun it.
- A write PayPal applied but whose answer was lost still fails that call's behavior check, and the gift or invoice may have changed. Before you rerun the script, listen to what the line said PayPal now shows, and put the gift back first if it changed, for example restart it in a free call before rerunning Script 2.
- The page measures the gap, so a deliberately faked client could still post one false gap per turn. The line now takes only one gap per turn, only for a reply it finished, and the grader flags a gap shorter than the line's own time for that reply.
- The same holds for a yes. A deliberately faked client that waits a quarter second after a proposal could still send a yes for a proposal it never showed. The line refuses any sooner yes, and any yes that arrived before the proposal existed.
- Since `feat/self-resolving`, the line takes an amount only when code reads the same clear amount from the caller's words that the router returned, so a bare number counts only right after give or donate, or as the answer to the line's own amount question. Nothing in code reads "fifty quid", so that asks, even when a model heard $50. The line can't change a monthly amount, so "I want to give fifty dollars a month" asks and makes no draft.
- A PIN said by voice that starts with an "oh", as in "Oh, 2468", reads as a wrong PIN, since oh can mean zero. The scripts use the keypad, so type the PIN there.
- Some PayPal sandbox details are unconfirmed, such as whether a sent invoice reads SENT or UNPAID. The code accepts both. See `.pilot/facts-paypal.md`.
- Render's free service can sleep while idle. PayPal retries deliveries; the configured PostgreSQL stores preserve accepted webhook evidence and deduplication across process replacement. The historical `pilot:check --resend` command belongs to the old pilot and is not the new release acceptance test.
- Webhook delivery is acknowledged only after signature verification and persistence. With donor durability enabled, sanitized event evidence and the verified raw delivery journal both use PostgreSQL. With that flag disabled, the donor event cache retains legacy local-ledger limitations.
- On Render, ten wrong PINs in an hour from one address stop PIN entry from that address for the rest of the hour, across all its calls. The line keys this, and its other limits, on the last address in `X-Forwarded-For`, which a caller can't set.

## License

MIT, copyright 2026 Arnav Singh. See `LICENSE`.
