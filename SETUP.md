# Setup

The integration checkout adds guarded Sonnet/Jev inference, authenticated supplier MCP quotes and durable PayPal sandbox checkout. Neon PostgreSQL 17 is connected; journal migrations 1/2, AI schema 1 and checkout schema 1 are applied. Both API keys authenticate. Fresh blind-reviewed V4 passed all frozen routing gates: 29/30 routing, zero wrong mutations, all ten pending-consent cases with zero provider calls, median 3,465 ms. Actual V1–V3 failures remain preserved. The final code suite passed 648 of 655 tests, with zero failures and seven hosted-only skips. The controlled supplier lab completed two buyer-approved sandbox captures totaling $674.15 test funds using rules routing. A separate approved test verified corrected actual Anthropic planning, Jev advisory review and MCP quotes for $676.25, without approval or payment. Jev flagged closer review. Both the original and bounded test model allocations are stopped. All lab endpoints share one owned test merchant; independent suppliers and fulfillment remain unverified. No live money is enabled. [AI-STATUS.md](docs/AI-STATUS.md) records results and funding limits.

The numbered pilot sections below preserve the original setup instructions. Do not use them to redeploy Render, reseed the pilot or change its checkout while validating this integration.

## Current integration setup

Use Node 22.12 or later and `npm install`. Keep credentials in ignored private files with mode `600`: `.database.env` for the restricted runtime `DATABASE_URL`, `.database-admin.env` for administrator migrations, `.ai.env` for `ANTHROPIC_API_KEY`/`TYPESAFE_API_KEY` and AI settings, and `.suppliers.env` for dedicated supplier MCP tokens. Existing PayPal sandbox settings may remain in `.env`. Never put keys in command arguments, logs, tracked files or chat.

Before enabling guarded inference, confirm the intended organizations and API-credit funding. Check automatic credit purchase and invoicing settings where available. `AI_PREPAID_ONLY_CONFIRMED=true` records the operator's attestation, not an account or balance check. It may be supplied only to an explicitly authorized process instead of changing private persistent configuration. An API key cannot choose the credit pool. The observed $200 Anthropic grant comes from Ultra, but API usage is separate from the plan's limits and is never charged to the Claude plan. It is used before purchased credits. The user also confirmed Jev's $10 balance and authorized proceeding without further Console checks. Jev automatic-recharge settings remain independently unverified. Never substitute a subscription/OAuth token or treat operator confirmation as independent billing evidence. [AI-STATUS.md](docs/AI-STATUS.md) records the dated observations, authorization and separately authorized sub-cent key probe.

Check the existing schemas with the restricted runtime connection. These commands make no model inference or PayPal checkout request:

```sh
node --env-file=.database.env scripts/database-check.js --require-tls
node --env-file=.database.env --env-file=.ai.env scripts/ai-check.js
node --env-file=.database.env scripts/checkout-check.js
```

Schema changes require an explicit administrator action, not a server startup fallback. [The database guide](docs/DATABASE.md) lists the three migration commands and role grants. AI scope/allocation settings must match their initialized database values; defaults are a $5 Anthropic allocation and $0.25 Jev allocation, not provider balances. A stopped budget remains stopped across restarts.

The original scope remains stopped for `usage_unverified`, with its $0.05124 Anthropic reservation retained. Do not reset that stop or reuse its identity. The user approved one separate $0.10 Anthropic/$0.01 Jev test allocation, and that single corrected quote completed for $0.005544906 total with both usage records settled. The test scope was then stopped with `operator_stop`, with no pending request or general model reenablement. Its isolated server had payment writes and background recovery disabled. Read-only recovery and existing completed-payment reads on the main local app can continue without model calls. [AI-STATUS.md](docs/AI-STATUS.md) records the audit and limits.

After keys, billing attestation and schema checks are ready, choose one startup mode:

```sh
# Guarded AI; mock donor PayPal and mock suppliers. Inference consumes the configured allocation.
PAYPAL_MODE=mock ROUTER_MODE=anthropic node --env-file=.database.env --env-file=.ai.env src/server.js
# Guarded AI; PayPal sandbox settings and registered MCP suppliers. No checkout write until both gates pass.
PAYPAL_MODE=sandbox ROUTER_MODE=anthropic PROCUREMENT_SUPPLIER_MODE=mcp-sandbox node --env-file=.env --env-file=.database.env --env-file=.ai.env --env-file=.suppliers.env src/server.js
```

For offline development, `npm run dev` keeps rules and mock PayPal. Legacy `haiku` startup is refused; Gemini is available only as an explicit historical pilot configuration and is never a fallback from the new gateway. `npm start` reads `.env` alone, so use the explicit startup commands when loading the additional private files.

Open `/procurement` for the Supply desk. `/api/ai/status` reports local allocation/stop state; `/api/commerce-status` reports sandbox availability. Neither certifies provider balances, merchant permissions or live readiness. Supplier registration, the controlled reference server and the per-vendor buyer approval/capture flow are documented in [COMMERCE.md](docs/COMMERCE.md).

Order creation and capture require both `PAYPAL_SANDBOX_CHECKOUT_WRITES=true` and November 4, 2026, 9:00 pm PT or later (`2026-11-05T05:00:00Z`). The controlled lab's default `LAB_MERCHANT_MODE=placeholder` blocks writes even when those conditions pass. Leave the switch false until authorized sandbox merchants are configured and an operator chooses a test. Crossing the time gate does not grant buyer approval or permission to use live money. Start and check the three controlled HTTP suppliers using [SUPPLIER-LAB.md](docs/SUPPLIER-LAB.md). Existing V1–V3 evaluations are preserved; do not rerun exposed fixtures as fresh quality evidence or infer a 72/90 or 80/90 judging result from tests.

Optional automatic reconciliation requires `CHECKOUT_RECOVERY_ENABLED=true` with `PROCUREMENT_SUPPLIER_MODE=mcp-sandbox` and PostgreSQL. It defaults off, starts only after HTTP listen, and reads known uncertain identities without creating/capturing orders or advancing payments. It scans at most 30 IDs and reconciles at most three workflows per ten-second bounded sweep under a transaction lease. [CHECKOUT-RECOVERY.md](docs/CHECKOUT-RECOVERY.md) covers lifecycle, aborts and limitations. This switch does not enable checkout writes.

## Historical pilot instructions

The following instructions describe the original Gemini/PayPal sandbox pilot. Some dashboard labels were taken from guides and marked "(check)". They are retained for that pilot, not as instructions to modify its current deployment.

## 1. PayPal sandbox app, about 15 minutes

1. Open https://developer.paypal.com/dashboard/ in Chrome.
2. Click Log in to Dashboard and sign in with your PayPal account, or sign up for a free personal account.
3. Let the dashboard load. This creates a default sandbox Personal account and a default sandbox Business account.
4. Click Apps & Credentials in the left menu.
5. Set the toggle at the top to Sandbox. Never copy anything while it says Live.
6. Click Create App, name it `pledge-line`, and pick the Merchant type, not Platform.
7. If it asks for a sandbox account, pick the default Business account, whose email ends in `business.example.com`. Then click Create App (check).
8. Copy the Client ID into `.env` as `PAYPAL_CLIENT_ID=`.
9. Click Show (check) next to the secret, and copy it into `.env` as `PAYPAL_CLIENT_SECRET=`.
10. Scroll down the app page to its feature list. Make sure Invoicing and Subscriptions are both ticked, and save if a save button appears.
11. Open https://developer.paypal.com/dashboard/accounts. Find the Personal account whose email ends in `personal.example.com`, then click the ... menu, then View/Edit Account.
12. Copy its email and password into your password manager, not into `.env`. You'll sign in with it to approve the test subscription and pay a test invoice.
13. Test that login at https://www.sandbox.paypal.com/signin, then log out.
14. Bookmark Testing Tools, then Sandbox Notifications. That's where sandbox emails show up, since they never reach a real inbox.

## 2. Gemini API key, free, about 5 minutes

The line uses Google's free Gemini tier to understand the caller, so this costs nothing and needs no card.

1. Open https://aistudio.google.com/apikey and sign in with your Google account.
2. If you already made a key, copy it. Otherwise click Create API key (check), and pick or create a project.
3. Paste it into `.env` as `GEMINI_API_KEY=`. Don't add billing or a card.
4. The pilot needs about 100 to 200 requests over two days. Google doesn't publish the free limits, so Claude checks your key's real limit before the clock starts.

Google may use free-tier prompts to improve its products. Every donor in the pilot is fake, so that's fine, but never use this key with real donor data.

## 3. Render account and the $50 credit, about 10 minutes

1. Open https://dashboard.render.com/register, click GitHub, and approve the sign-in as Arnav66692.
2. If Render asks for a card at any point, stop. Write down where it asked, and decide before adding one. PILOT.md records whether the credit works without a card.
3. Open https://credits-portal-mmdm.onrender.com/claim/paypal-ai-hackathon (linked from the hackathon's Render page). Click Continue with GitHub and check that GitHub asks only for profile or email access.
4. No one could see what that page does after sign-in. If it gives you a code, open the Render Dashboard, click Billing, scroll to Credit Balance, enter the code, and click Apply. Check that the balance shows $50.

## 4. Pick your PIN

In `.env`, set `PILOT_PIN=` to 4 to 6 digits you'll remember. Don't use 1111, 2222 or 3333, since Script 8 uses those as wrong PINs.

Optional. To read the night's calls and their receipts at `/staff`, set `STAFF_KEY=` in `.env`, and in Render, to a made-up key of at least 16 characters with no spaces, and type it on that page. Left empty, the staff view stays off.

Optional. To let a donor keep a signed receipt of each call, set `RECEIPT_SIGNING_KEY=` in `.env`, and in Render, to 64 hex characters. Make them with this, then paste the line it prints.

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep it secret, like a password, and keep the same one. A receipt signed with an old key no longer checks once the key changes. Left empty, the receipt button, `/receipt`, `/check` and `/receipt-key` stay off. Render's free disk is wiped on restart, so the file a donor downloads is the only copy that lasts.

## 5. Put the line on Render

The private repo `Arnav66692/pledge-line` is pushed, with the tested code on the `pilot` branch.

1. Open https://github.com/apps/render/installations/new and pick your account.
2. Choose Only select repositories, never All repositories. Select `pledge-line` and click Install.
3. If Render was already installed, open GitHub's Settings, then Applications, then Installed GitHub Apps, and click Configure next to Render. Add `pledge-line` under Only select repositories and save.
4. In the Render Dashboard, click New, then Blueprint, then Connect next to `pledge-line`.
5. Name it `pledge-line`, pick the branch `pilot`, and leave Blueprint Path empty.
6. Check that the change list shows one web service named `pledge-line` on the free plan.
7. Fill `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `GEMINI_API_KEY` and `PILOT_PIN` with the values from your `.env`.
8. Type `pending` in `PUBLIC_BASE_URL`, `PAYPAL_WEBHOOK_ID` and `DEMO_SUBSCRIPTION_ID`. You fill them in on pilot day.
9. Click Deploy Blueprint. When it's live, copy the service URL from the top of the service page.
10. Open that URL with `/healthz` added. Allow about a minute if it was asleep, and check it says ok.
11. Click Environment, set `PUBLIC_BASE_URL` to the service URL, and choose Save and deploy (check).

## 6. Pilot day, Tue Nov 3. The clock starts here

Start a row in the Hours log in PILOT.md with today's date and your start time, such as 6:00 pm. Write every time with am or pm, or pilot-check won't grade. Then, in this folder:

1. Run `npm run seed`. It prints an approve link. Open it, sign in as the sandbox Personal account, and approve the subscription.
2. Run `npm run seed -- --check` and confirm it says ACTIVE.
3. Run `npm run seed -- --webhook https://YOUR-RENDER-URL/webhooks/paypal`. Put the webhook id it prints into `.env` and into Render as `PAYPAL_WEBHOOK_ID`.
4. Put the subscription id from `.pilot/state.json` into Render as `DEMO_SUBSCRIPTION_ID`, then Save and deploy. pilot-check reads it from `.pilot/state.json`, so grade in this folder. Don't run `npm run seed` again after your first graded call. A new subscription means redoing every call.
5. Tell Claude to run the dry run. It runs all 10 scripts as typed text against the real sandbox and Gemini. This catches problems before you spend time on the voice runs, and it doesn't count for the bar.
6. Run `npm start` and open http://localhost:3000. If it prints a WARNING when it starts, stop and tell Claude before any call. Make the 10 scripted calls in PILOT.md, mostly in Chrome and at least one in Safari (turn Siri on first). Then do Scripts 2 and 3 in Firefox with the typed box.
   - In Safari, finish at least one script other than Script 8 by voice, since Script 8 never counts for a browser.
   - Answer each proposal after you hear it. Say a one-time amount once, as money.
   - If Script 1 says PayPal gave no clear answer, run it again.
   - If the line says "PayPal didn't answer clearly, so I checked again.", that call fails. Listen to the status it reads back. If the gift changed, put it back in a free call before you rerun the script.
   - Don't start a scripted call in the last minutes before the deadline, and use No script for demos.
   - Don't change the code, `ORG_NAME` or `.env` during the pilot. If something needs a change, tell Claude first, and restart `npm start` and reload every page after it.
7. After Script 5, open the invoice's payer link, which the line's record card shows. Sign in as the sandbox Personal account and pay it. The same invoice email also appears under Sandbox Notifications, but no real email is ever sent.
8. Fill in End for today's row in the Hours log.
9. Run `npm run pilot:check -- --render https://YOUR-RENDER-URL`, always with the `--` before the flags, soon after paying Script 5's invoice while Render still lists the event. It writes `PILOT-RESULTS.md` with PASS or FAIL for each test, and keeps every real grade in `pilot-results/`. Never delete files there.

If `PILOT-RESULTS.md` says no grade, it says why. Fix that and run it again.

The gate is the earlier of Wed Nov 4 at 9:00 pm PT and the end of your 6th logged hour. Finish every call and the payment before then, and grade before then too. If you run `npm run seed` again later for a demo, set `.env` back to the pilot's values before any regrade.

If a sandbox call returns 403 NOT_AUTHORIZED right after you tick a PayPal feature, restart the line so it gets a fresh PayPal token.

## Covered Month's sponsor hold

Only for filming the money move, and only after a sandbox spike. Seed it within 3 days of filming, since a hold lasts 29 days and PayPal advises capturing within 3.

1. `npm run seed:hold`, optionally with `-- --amount 100`. It prints a link.
2. Open the link and log in as a sandbox personal account for the sponsor, not the donor's. Approve it. That is the sponsor's one consent.
3. `npm run seed:hold -- --authorize` saves the hold in `.pilot/state.json`. On Render, set `SPONSOR_HOLD_ID` to the id it prints.
4. `npm run seed:hold -- --check` shows what PayPal has for it.
