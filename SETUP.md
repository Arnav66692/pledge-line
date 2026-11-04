# Setup

These are the accounts and keys the pilot needs. Claude can't create accounts or handle keys, so you do these steps yourself. It takes about 45 minutes. Do sections 1 to 4 on Mon Nov 2, before the pilot clock starts.

**Keys go in one place only.** Claude already copied `.env.example` to a new file named `.env` in this folder, with every key empty. Paste every key into that file. Never paste a key into chat. `.env` is ignored by git, so it never gets pushed.

A few button labels below come from guides, not from the live pages, and are marked "(check)". If a screen doesn't match, stop and tell Claude what it says.

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
