# Account setup for the Pledge Line pilot

Written Sun Nov 1, 2026, PT, by Claude, for Arnav to follow on Mon Nov 2. Claude can't create accounts, enter keys or pay, so every step below is yours. Paste secrets only into the project's `.env` file or into Render's own form. Never paste them into chat.

Each fact carries a label.

- **verified** means I read it today, Nov 1, on the official page in the Source column.
- **likely** means an official page that is older or less exact says it, or a recent third-party guide does.
- **unverified** means I could not confirm it. Check it on screen and tell Claude what you saw.

Order for Monday. PayPal first, then Anthropic, then the Render sign-up and the $50 credit. The Render deploy waits until Claude pushes the private repo and you give Render access to it.

Your `.env` file is `/Users/arnavsingh/Desktop/Business/pledge-line/.env`. Open it in your code editor, paste each value right after its `=` sign, and save. Git ignores it, so it never gets pushed.

The live Devpost page still shows the deadline as Nov 12, 2026, 12:00 pm PST, with 11 days left when I read it on Nov 1.

## 1. PayPal Developer, sandbox only

### Steps for Monday

1. Open https://developer.paypal.com/dashboard/ in Chrome.
2. Click **Log in to Dashboard** and sign in with your PayPal account. If you have none, use the sign-up option on that page to make a free personal account with your own email and phone.
3. Let the dashboard load. Your first sign-in creates one default sandbox Personal account and one default sandbox Business account.
4. Click **Apps & Credentials** in the left menu.
5. Set the environment toggle at the top to **Sandbox**. Never copy anything while it says Live.
6. Click **Create App**.
7. Type `pledge-line` as the app name.
8. Under **Type**, pick **Merchant**. Don't pick Platform.
9. If it asks for a sandbox account, pick the default Business account, the one whose email ends in business.example.com.
10. Click **Create App** to finish.
11. On the app's page, copy the **Client ID** shown at the top.
12. Reveal the secret with **Show** next to the secret key, then copy it.
13. Paste them into `.env` as `PAYPAL_CLIENT_ID=` and `PAYPAL_CLIENT_SECRET=`, then save.
14. Scroll down the app page to the feature list. PayPal's Oct 2026 docs call it **Sandbox App Settings**, and guides call it **Features**.
15. Make sure **Invoicing** and **Subscriptions** are both ticked. Tick any that aren't, then save if a save button appears.
16. Click **Testing Tools** in the left menu, then **Sandbox Accounts**. The direct link is https://developer.paypal.com/dashboard/accounts.
17. Find the default Personal account, the email ending in personal.example.com.
18. Click the **...** menu on that row, then **View/Edit Account**.
19. On the **Profile** tab, copy the email and the generated password into your password manager. They go only into the sandbox site, never into `.env` or chat.
20. Test that login at https://www.sandbox.paypal.com/signin, then log out.
21. Bookmark **Testing Tools**, then **Sandbox Notifications**. Sandbox emails, like the invoice email, land there instead of a real inbox.
22. Bookmark https://developer.paypal.com/dashboard/webhooks/sandbox. Pick the pledge-line app from the list to see its webhook events.

### Later, on Tue Nov 3, once the clock starts

1. When `npm run seed` prints the approve link, open it, sign in as the sandbox Personal account, and approve the subscription.
2. Run `npm run seed -- --check` and confirm it says ACTIVE.
3. After Script 5 sends the invoice, open the invoice's payer link. PayPal returns it as `recipient_view_url`, and the invoice email in Sandbox Notifications has it too.
4. Sign in there as the sandbox Personal account and pay the invoice.
5. If a sandbox call fails with 403 NOT_AUTHORIZED right after you tick a feature, restart the line or the script so it fetches a fresh PayPal token, then try again.

### What to know

| Fact | Confidence | Source |
|---|---|---|
| The dashboard login is your normal PayPal login. The same login works on paypal.com and the Developer Dashboard. | likely | PayPal's getting-started-with-paypal-sandbox repo, linked from Devpost's resources page |
| Your first dashboard sign-in creates a default sandbox Personal account and a default sandbox Business account. Accounts marked Default can't be deleted. | verified | developer.paypal.com/tools/sandbox/accounts |
| The page names are **Apps & Credentials**, **Create App**, a **Default Application** under REST API apps, and **Testing Tools**, then **Sandbox Accounts**. | verified | developer.paypal.com/api/rest and developer.paypal.com/platforms/create-account, updated Oct 14, 2026 |
| Create App has a **Type** choice. Platform is for marketplaces paying sellers. Merchant is the plain seller app. | likely | developer.paypal.com/platforms/create-account and the Commerce Platform get-started page |
| The client ID and secret sit at the top of the app page. The secret is hidden until you click **Show**. | likely | developer.paypal.com/platforms/create-account for the position, AngellEYE guide of Aug 20, 2026 for **Show** |
| Features are chosen on the app page under Sandbox App Settings. | verified | developer.paypal.com/platforms/create-account |
| Whether Invoicing and Subscriptions are ticked by default on a new sandbox app. PayPal's docs don't say. | unverified | No official source found |
| A missing feature shows up later as a NOT_AUTHORIZED error, not at login. One vendor says a newly ticked feature can take hours to reach an app that already holds a token. | unverified | Frontegg and AnythingMCP connector guides, third-party |
| The Invoicing scope is https://uri.paypal.com/services/invoicing and the Subscriptions scope is https://uri.paypal.com/services/subscriptions. | verified | developer.paypal.com/apps-scopes-and-credentials |
| Sandbox Personal emails look like sb-something@personal.example.com. | verified | developer.paypal.com/tools/sandbox/accounts |
| The row menu, then **View/Edit Account**, shows the generated email and password. The AngellEYE guide puts them on the **Profile** tab. | likely | PayPal's sandbox repo and AngellEYE guide of Aug 20, 2026 |
| Sandbox emails never leave the sandbox. They go to the sandbox account's Notifications page. | verified | developer.paypal.com/sandbox-testing/calls |
| In the dashboard they show under **Testing Tools**, then **Sandbox Notifications**. | likely | AngellEYE guide of Aug 20, 2026 and a PayPal staff answer on the PayPal Community forum |
| The sandbox webhook events page is developer.paypal.com/dashboard/webhooks/sandbox. Pick the app, filter the last 30 days, and click **Resend** on any event. A green check means received, a yellow mark means pending. | verified | developer.paypal.com/api/rest/webhooks/events-dashboard |
| PayPal retries a webhook up to 25 times over 3 days until it gets a 2xx reply. An app can have up to 10 webhook URLs. | verified | developer.paypal.com/api/rest/webhooks |
| A webhook listener must be HTTPS on port 443. The webhook ID is needed to verify every message. Postback verification doesn't work for mock events. | verified | developer.paypal.com/api/rest/webhooks/rest |
| An invoice's `detail.metadata.recipient_view_url` is the payer view hosted on PayPal. | verified | PayPal Invoicing v2 schema.json |
| Only draft or scheduled invoices can be deleted. | verified | developer.paypal.com/api/invoicing/v2 summary |
| The sandbox API base is https://api-m.sandbox.paypal.com and the token endpoint is /v1/oauth2/token. | verified | developer.paypal.com/api/rest |
| Devpost says to use an existing PayPal account or a free one, and to ask in the PayPal Discord if sign-up fails. | verified | paypalaihackathon.devpost.com/details/faqs |
| A PayPal personal account needs you to be at least 18. | likely | PayPal user agreement text seen in search results, US page not opened |

## 2. Anthropic, Claude Console

### Steps for Monday

1. Open https://platform.claude.com. The old console.anthropic.com address now redirects there.
2. Click **Continue with Google** or **Continue with email**, and sign up with your own email.
3. If it asks for a phone number, use your real mobile number. VoIP, Google Voice and landline numbers are refused.
4. Open the Billing page at https://platform.claude.com/settings/billing.
5. Click **Buy credits**. A July 2026 guide shows the button as **Purchase credits**.
6. Choose $10. If there is no $10 preset, pick **Other** and type 10. The presets seen in July were $5, $20 and $100.
7. Enter your card and billing address, check the total with tax, and confirm.
8. Leave auto-reload off.
9. On the same Billing page, find **Spend limits** and click **Set limit**, or **Adjust limit** if one is already set.
10. Enter 10 and save.
11. Open the API keys page at https://platform.claude.com/settings/keys.
12. Click **Create key**.
13. Name it `pledge-line`.
14. Set **Linked account** to yourself.
15. Pick the **Default** workspace, so the key is tied to one workspace.
16. For expiration, choose a custom length of 60 days, so it outlasts judging on Dec 15. If custom isn't offered, choose **Never** and delete the key after Dec 15.
17. Click the button that creates the key. Docs call it **Create key**, and a July guide shows **Add**.
18. Copy the key, which starts with `sk-ant-`. The Console shows it only once.
19. Paste it into `.env` as `ANTHROPIC_API_KEY=` and save.

### What to know

| Fact | Confidence | Source |
|---|---|---|
| The Console lives at platform.claude.com, and console.anthropic.com answers with a 301 redirect to it. | verified | Fetch of console.anthropic.com on Nov 1 |
| The sign-in page offers **Continue with Google**, **Continue with email** and **Continue with SSO**. Continuing means agreeing to Anthropic's Commercial Terms and Usage Policy. | verified | platform.claude.com sign-in page |
| API keys are at platform.claude.com/settings/keys. The **Create key** form asks for a name, an expiration, a **Linked account** and an optional workspace. The full key shows once. | verified | platform.claude.com/docs/en/get-api-key |
| A key that isn't tied to a workspace makes every API call fail with a 400 unless the call sends an `anthropic-workspace-id` header. A key tied to one workspace needs no header. | verified | platform.claude.com/docs/en/manage-claude/authentication |
| Expiration choices are 3 hours, 1 day, 7 days, 30 days, a custom length, or Never. An expired key returns 401 and can't be revived. | verified | platform.claude.com/docs/en/manage-claude/authentication |
| Every organization has a Default Workspace. You can't set a spend limit on the Default Workspace itself, so the org-wide limit on the Billing page is the backstop. | verified | platform.claude.com/docs/en/manage-claude/workspaces |
| Credits are bought on the Billing page with **Buy credits** and are usable right away. They expire one year after purchase and are non-refundable. | verified | support.claude.com article 8977456 |
| The smallest preset purchase is $5, with $20 and $100 presets and an Other amount. Tax is added at checkout in the guide's example. | likely | Classmethod guide of Jul 31, 2026, third-party |
| Your own spend limit is set on the Billing page under **Spend limits** with **Set limit** or **Adjust limit**. It can't exceed your tier's cap. When reached, calls return HTTP 400 until the limit is raised or the month turns. | verified | platform.claude.com/docs/en/api/rate-limits |
| New organizations may start in an Evaluation tier with lower limits that rise with use. Tier caps are $500 a month for Start. | verified | platform.claude.com/docs/en/api/rate-limits |
| Major credit cards are accepted. New users get a small amount of free credit, with no amount stated. | verified | platform.claude.com/docs/en/about-claude/pricing |
| The old free-credit help article, 8994925, now returns 404, so don't count on a free $5. | verified | Fetch on Nov 1 |
| All new Claude users verify a phone number, and it can't be skipped. Whether this applies to Console sign-up was not confirmed. | likely | support.claude.com article 8287232, Aug 17, 2026 |
| Claude Haiku 5.5 costs $0.10 per million input tokens and $0.50 per million output tokens for prompts up to 100,000 tokens. | verified | platform.claude.com/docs/en/about-claude/pricing |
| At those prices a short router call costs a small fraction of a cent, so $10 covers the pilot and judging with room left. | likely | Computed estimate, token counts per call assumed, not measured |
| Anthropic's Consumer Terms require you to be at least 18, or older where local law says so. The Commercial Terms, which govern API keys and the Console, state no age and say the service is not for consumer use. At 18 you meet both. | verified | anthropic.com/legal/consumer-terms, effective Oct 8, 2025, and anthropic.com/legal/commercial-terms, effective Jun 17, 2025 |

## 3. Render

### 3a. Sign up, Monday

1. Open https://dashboard.render.com/register.
2. Click **GitHub** and approve the GitHub sign-in as Arnav66692.
3. Finish the hCaptcha check if it appears.
4. If Render asks for a card at any point, stop, write down where it asked, and decide before adding one.

### 3b. Claim the $50 entrant credit, Monday

1. Open the link from the Devpost Render page, https://credits-portal-mmdm.onrender.com/claim/paypal-ai-hackathon.
2. Check the page shows the Render logo, the heading **PayPal AI Hackathon** and the contact devrel+credits@render.com.
3. Click **Continue with GitHub** and sign in as Arnav66692.
4. Read the GitHub permission screen. It should ask only for profile or email access. If it asks for repository access, stop and tell Claude.
5. Follow what the portal shows next. I couldn't see past the GitHub sign-in, so this part is unverified.
6. If it gives you a promo code, go to https://dashboard.render.com and check you're in your own workspace.
7. Click **Billing** in the left pane.
8. Scroll to **Credit Balance**, paste the code into its field, and click **Apply**.
9. Check the credit balance now shows $50.
10. Write down whether any step asked for a card. PILOT.md records it.

### 3c. Free web service facts

| Fact | Confidence | Source |
|---|---|---|
| The Hobby workspace plan is $0 a month plus compute, for individuals. It allows up to 25 services, 5 GB of bandwidth a month and 500 build minutes a month. | verified | render.com/pricing, read in the browser |
| A free web service is $0 a month with 512 MB of RAM. The cheapest paid size, 0.5c-512mb, is $7 a month. | verified | render.com/pricing |
| A free web service spins down after 15 minutes with no inbound traffic, and waking takes about one minute. Browsers see a loading page meanwhile. | verified | render.com/docs/free |
| Each workspace gets 750 free instance hours per calendar month. When they run out, Render suspends all free web services until the next month. Hours don't roll over. | verified | render.com/docs/free |
| One service awake all month uses at most 744 hours, which fits under 750. | likely | Computed, 31 days times 24 hours |
| The free filesystem is ephemeral, so the ledger on Render is lost on redeploy, restart or spin-down. Render may restart a free service at any time. | verified | render.com/docs/free |
| The docs never say a card is needed to run free services. They say that without a payment method, going over the included bandwidth suspends free services instead of billing, and builds stop after the included minutes. | verified | render.com/docs/free |
| Render support and forum posts from 2023 to 2025 say Render sometimes asks for a card, including for Blueprints. A card check is a $1 charge that is refunded. | likely | Search results for community.render.com threads, and the FAQ on render.com/pricing |
| Whether a new account on Nov 2 gets asked for a card. | unverified | Not testable without an account |
| Credits belong to one workspace and can't move. Event codes often expire soon after the event. Credits don't change your plan, and any bill they don't cover goes to the card on file. | verified | render.com/docs/credits |
| Devpost's Render page says credits are taken from your balance, which is billed at the end of the month. It doesn't mention a card. | verified | paypalaihackathon.devpost.com/details/render, read in the browser because plain fetches got a 403 |
| A web service must listen on 0.0.0.0. Render sets `PORT` to 10000 by default. | verified | render.com/docs/web-services and render.com/docs/environment-variables |
| Render sets `RENDER_EXTERNAL_URL`, for example https://myapp.onrender.com, on every web service. It sets `NODE_ENV=production` at runtime only. | verified | render.com/docs/environment-variables |
| The service URL is on onrender.com and includes the service name, so expect https://pledge-line.onrender.com. If that name is taken, Render adds a random suffix, and the subdomain can't be changed later. | likely | render.com/docs/web-services for the name, Render staff forum answers for the suffix |
| A health check passes on any 2xx or 3xx reply within five seconds. After 60 seconds of failures Render restarts the instance. A deploy that never passes is canceled after 15 minutes. | verified | render.com/docs/health-checks |
| Whether a PayPal webhook sent to a sleeping free service waits for the wake-up or fails. PayPal's retries for 3 days cover it either way. | unverified | No source found |
| Whether Render's proxy adds the caller's address to the end of a caller-sent `X-Forwarded-For` or replaces the header. The line keys its rate limits and its wrong-PIN limit on the last entry, which a caller can't set in either case. If a shared proxy address turns out to be last, callers share one limit, which is stricter, not looser. | unverified | Not checked on Nov 1. Look at one request's header on Render to confirm |

### 3d. Deploy the Blueprint, after the repo is pushed and shared

1. Do section 4 first, so Render can see the private repo.
2. In the Render Dashboard, click **New** at the top right, then **Blueprint**.
3. Click **Connect** next to Arnav66692/pledge-line.
4. Name the Blueprint `pledge-line`.
5. Pick the branch Claude names when it pushes. The local branch today is `pilot`.
6. Leave **Blueprint Path** empty, so Render uses `render.yaml` at the repo root.
7. Check the change list shows one web service named pledge-line on the free plan.
8. Fill in the secret boxes. PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, ANTHROPIC_API_KEY and PILOT_PIN come from your `.env`.
9. Leave PUBLIC_BASE_URL, PAYPAL_WEBHOOK_ID and DEMO_SUBSCRIPTION_ID empty for now. If Render won't continue with an empty box, type `pending` in it.
10. Click **Deploy Blueprint**.
11. Open the new pledge-line service and copy its URL from the top of the page.
12. Open that URL with `/healthz` added. The first load after idle can take about a minute. It should show `ok` as true.
13. Click **Environment** in the service's left pane.
14. Set PUBLIC_BASE_URL to the URL you copied.
15. Choose **Save and deploy** from the save options.
16. On Nov 3, after `npm run seed -- --webhook https://YOUR-URL/webhooks/paypal` prints the webhook ID, put it in `.env` and in Render as PAYPAL_WEBHOOK_ID, then **Save and deploy**.
17. Do the same for DEMO_SUBSCRIPTION_ID once the seeded subscription is ACTIVE.

### 3e. Blueprint and env var facts

| Fact | Confidence | Source |
|---|---|---|
| The flow is **New**, then **Blueprint**, then **Connect** on the repo, a Blueprint name and branch, an optional **Blueprint Path**, a review of changes, then **Deploy Blueprint**. Render reads `render.yaml` at the repo root by default. | verified | render.com/docs/infrastructure-as-code |
| Render asks for `sync: false` values only during the first Blueprint creation. Later Blueprint updates ignore them, so later values go on the Environment page by hand. Preview environments don't get them. | verified | render.com/docs/blueprint-spec |
| Whether the first-creation form allows a `sync: false` box to stay empty. | unverified | No source found |
| On the Environment page, **+ Add Environment Variable** adds one and **Add from .env** imports many. Saving offers **Save, rebuild, and deploy**, **Save and deploy**, or **Save only**. | verified | render.com/docs/configure-environment-variables |
| Leaving out `plan` makes a new web service the paid 0.5c-512mb size, so `plan: free` must be written out. | verified | render.com/docs/blueprint-spec |
| `region` defaults to oregon and can't be changed later. The choices are oregon, ohio, virginia, frankfurt and singapore. | verified | render.com/docs/blueprint-spec and render.com/schema/render.yaml.json |
| With no `branch`, a service in the Blueprint's own repo uses the branch you picked for the Blueprint. | verified | render.com/docs/blueprint-spec |
| `autoDeployTrigger` takes commit, checksPass or off, and replaces the old `autoDeploy`. New services default to commit. | verified | render.com/docs/blueprint-spec |
| `runtime: node` replaces the old `env` field. `healthCheckPath` is for web services and starts with a slash. | verified | render.com/docs/blueprint-spec |
| Render publishes the Blueprint JSON schema at https://render.com/schema/render.yaml.json. The render.yaml in section 5 passes its keys, enums and env var shapes. | verified | Checked on Nov 1 with a small script against that schema |
| Signing up with GitHub logs you into an existing Render account that has the same primary email. | verified | render.com/docs/github |
| The sign-up page offers GitHub, GitLab, Bitbucket, Google, or email and password, and is protected by hCaptcha. | verified | dashboard.render.com/register, read in the browser |

### 3f. Node version

| Fact | Confidence | Source |
|---|---|---|
| Render picks the version in this order. `NODE_VERSION` env var, then `.node-version` at the repo root, then `.nvmrc`, then `engines.node` in package.json. | verified | render.com/docs/node-version |
| It accepts exact versions, aliases like lts, and semver ranges, and warns that an open range like >=20 resolves to the newest release. | verified | render.com/docs/node-version |
| New services created on or after Oct 21, 2026 default to Node 24.22.1. | verified | render.com/docs/node-version |
| Render's docs don't list which versions it supports. | verified | render.com/docs/node-version |
| Node 26 became Active LTS on Oct 28, 2026, and its newest release is 26.13.0. Node 24 moved to Maintenance LTS on Oct 20, 2026, and is supported until Apr 30, 2028. | verified | nodejs.org/en/about/previous-releases and the nodejs/Release schedule.json |
| This Mac runs Node 26.3.1. | verified | `node -v` on Nov 1 |
| Pin `.node-version` to `24.22.1`. It is the newest LTS that Render's own docs name, it meets the spec's 22.12 floor, and it stays supported past judging. Whether Render installs 26.13.0 is unverified. | likely | Judgment from the rows above |

### 3g. Render Workflows, recorded only

| Fact | Confidence | Source |
|---|---|---|
| Render Workflows is an orchestration and execution engine for long-running, distributed tasks, written with a TypeScript or Python SDK. Each run can last up to 24 hours. | verified | render.com/docs/workflows and render.com/docs/workflows-limits |
| It became generally available on Sep 1, 2026. | verified | render.com/articles/render-workflows-vs-vercel-workflows, Oct 22, 2026, and render.com/blog/upcoming-changes-to-workflows-pricing, Aug 10, 2026 |
| Hobby workspaces can use it, with up to 16 CPU and 64 GB of new task compute per minute. | likely | render.com/pricing and the Aug 10, 2026 blog list Hobby limits for it |
| The default flex plan bills $0.20 per active CPU-hour and $0.05 per active GB-hour, up to $0.40 an hour. Fixed plans run $0.40 to $2.50 an hour. Task state is kept 30 days at $0.25 per GB a month. Billing is per second, with a tiny minimum charge on flex runs. | verified | render.com/docs/workflows-limits and render.com/pricing |
| No free allowance is stated. | verified | render.com/docs/workflows-limits |
| Whether Workflows runs on the $50 credit without a card. | unverified | No source found. PILOT.md records it |

## 4. GitHub to Render, one private repo

Claude creates and pushes the private repo Arnav66692/pledge-line first. These steps come after that.

1. Sign in to GitHub as Arnav66692.
2. Open https://github.com/apps/render/installations/new. The app is called Render, made by renderinc.
3. If GitHub shows an install page, pick your account Arnav66692.
4. Choose **Only select repositories**. Don't choose All repositories.
5. Open **Select repositories** and pick pledge-line.
6. Click **Install**.
7. If Render is already installed on your account, use the settings path instead. Click your profile picture, then **Settings**.
8. Under **Integrations**, click **Applications**, then **Installed GitHub Apps**.
9. Click **Configure** next to Render.
10. Under **Repository access**, choose **Only select repositories**, add pledge-line from **Select repositories**, and click **Save**.
11. Go back to Render, click **New**, then **Blueprint**, and check pledge-line shows a **Connect** button.
12. If it doesn't show, open Render's Account Settings, scroll to Account Security, and under Git Deployment Credentials use **Add credential** to connect GitHub.

| Fact | Confidence | Source |
|---|---|---|
| The GitHub account Arnav66692 exists and is a user account named Arnav Singh. | verified | api.github.com/users/Arnav66692 |
| Render's docs point to github.com/apps/render/installations/new and its **Repository access** section to control which repos Render sees. | verified | render.com/docs/github |
| The GitHub App page is titled Render, by renderinc, with an **Install** button. | verified | github.com/apps/render, read in the browser |
| GitHub's install flow offers **All repositories** or **Only select repositories**, a **Select repositories** dropdown, and an **Install** button. | verified | docs.github.com, installing a GitHub App from a third party |
| To change it later, go to profile picture, **Settings**, **Applications**, **Installed GitHub Apps**, **Configure**, **Repository access**, then **Save**. | verified | docs.github.com, reviewing and modifying installed GitHub Apps |
| Render's Git connection also lives under Account Settings, Account Security, Git Deployment Credentials, **Add credential**. | verified | render.com/docs/github |

## 5. render.yaml for this project

```yaml
# Render Blueprint for the Pledge Line pilot. One free Node web service.
# Field reference, https://render.com/docs/blueprint-spec
# Values marked sync false are asked for once, when the Blueprint is first created.
# Change them later on the service's Environment page in the Render Dashboard.
services:
  - type: web
    name: pledge-line
    runtime: node
    plan: free
    region: oregon
    buildCommand: npm ci
    startCommand: node src/server.js
    healthCheckPath: /healthz
    autoDeployTrigger: commit
    envVars:
      - key: PAYPAL_MODE
        value: sandbox
      - key: ROUTER_MODE
        value: haiku
      - key: ORG_NAME
        value: Sunny Hollow Pantry
      - key: PAYPAL_CLIENT_ID
        sync: false
      - key: PAYPAL_CLIENT_SECRET
        sync: false
      - key: PAYPAL_WEBHOOK_ID
        sync: false
      - key: ANTHROPIC_API_KEY
        sync: false
      - key: PILOT_PIN
        sync: false
      - key: DEMO_SUBSCRIPTION_ID
        sync: false
      - key: PUBLIC_BASE_URL
        sync: false
```

Pair it with a `.node-version` file at the repo root that holds one line, `24.22.1`. Don't also set NODE_VERSION in Render, since the env var would win over the file.

## 6. Open questions

1. What the credit portal does after **Continue with GitHub**. It may show a code, email one, or apply the credit directly. I couldn't see past the sign-in.
2. Whether Render asks a new account for a card at sign-up, at credit redemption, on a free Blueprint deploy, or for Workflows. Render's docs don't require one for free services, but forum posts say it sometimes asks.
3. Whether a new PayPal sandbox app has Invoicing and Subscriptions ticked by default, and the exact feature labels.
4. Some labels I couldn't confirm. PayPal's **Show** on the secret, the final **Create App** button, the sandbox approve button, Render's GitHub permission screen, and Anthropic's save button for the spend limit.
5. For the builder. Render may not accept empty `sync: false` boxes, and PUBLIC_BASE_URL, PAYPAL_WEBHOOK_ID and DEMO_SUBSCRIPTION_ID can't be known at first deploy. config.js should still boot on Render when they are empty or `pending`, falling back to RENDER_EXTERNAL_URL for the base URL. Otherwise the first deploy fails its health check.
6. For the builder. If Arnav's key ends up not tied to a workspace, every Haiku call returns 400 unless router.js sends `anthropic-workspace-id`. The steps above tie it to Default to avoid that.
7. For the builder. `npm ci` fails without a committed package-lock.json, and `.node-version` must sit at the repo root.
8. Whether Render installs Node 26.13.0. I pinned 24.22.1 because Render documents it.
9. Whether a webhook to a sleeping free service waits for the wake-up or fails. PayPal retries for 3 days, and `npm run pilot:check -- --resend` exists as a backstop.
10. Anthropic's free-credit amount for new users. The old article is gone.
11. Whether the Console sign-up asks for a phone number. Anthropic's help says all new users verify one.
12. Your message said "Yes, push private", but this research step was told not to create or push any repo. I did neither. The repo creation and push are still for the main session.

## 7. Sources, all read Nov 1, 2026

PayPal
- https://developer.paypal.com/api/rest/
- https://developer.paypal.com/platforms/create-account/, updated Oct 14, 2026
- https://developer.paypal.com/limited-release/commerce-platform/v2/get-started.md
- https://github.com/paypaldev/getting-started-with-paypal-sandbox, linked from the Devpost resources page
- https://developer.paypal.com/tools/sandbox/accounts/
- https://developer.paypal.com/sandbox-testing/accounts
- https://developer.paypal.com/sandbox-testing/calls
- https://developer.paypal.com/api/rest/webhooks/
- https://developer.paypal.com/api/rest/webhooks/rest/
- https://developer.paypal.com/api/rest/webhooks/events-dashboard/
- https://developer.paypal.com/apps-scopes-and-credentials
- https://developer.paypal.com/api/invoicing/v2/schema.json
- https://www.angelleye.com/?p=172026, third-party, Aug 20, 2026
- https://developers.frontegg.com/agen-for-work/connectors/marketplace/paypal, third-party
- https://www.paypal-community.com/t5/Sandbox-Environment/Email-confirmation/m-p/3185641, forum, via search
- https://paypalaihackathon.devpost.com/details/faqs

Anthropic
- https://platform.claude.com/, the sign-in page, and the console.anthropic.com redirect
- https://platform.claude.com/docs/en/get-api-key
- https://platform.claude.com/docs/en/manage-claude/authentication
- https://platform.claude.com/docs/en/manage-claude/workspaces
- https://platform.claude.com/docs/en/api/rate-limits
- https://platform.claude.com/docs/en/about-claude/pricing
- https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage
- https://support.claude.com/en/articles/8287232-verify-your-phone-number
- https://dev.classmethod.jp/en/articles/claude-console-buy-credit-create-api-key/, third-party, Jul 31, 2026
- https://www.anthropic.com/legal/consumer-terms
- https://www.anthropic.com/legal/commercial-terms

Render
- https://paypalaihackathon.devpost.com/details/render, read in the built-in browser
- https://credits-portal-mmdm.onrender.com/claim/paypal-ai-hackathon, read in the built-in browser, not signed in
- https://render.com/docs/credits
- https://render.com/docs/free
- https://render.com/pricing, read in the built-in browser
- https://render.com/docs/blueprint-spec, read in the built-in browser
- https://render.com/schema/render.yaml.json
- https://render.com/docs/infrastructure-as-code
- https://render.com/docs/configure-environment-variables
- https://render.com/docs/environment-variables
- https://render.com/docs/web-services
- https://render.com/docs/health-checks
- https://render.com/docs/node-version
- https://render.com/docs/github
- https://render.com/docs/your-first-deploy
- https://dashboard.render.com/register, read in the built-in browser
- https://render.com/docs/workflows
- https://render.com/docs/workflows-limits
- https://render.com/blog/upcoming-changes-to-workflows-pricing, Aug 10, 2026
- https://render.com/articles/render-workflows-vs-vercel-workflows, Oct 22, 2026
- https://community.render.com/t/can-i-change-my-existing-subdomain-onrender-com-to-a-new-one/9999, forum, via search
- https://nodejs.org/en/about/previous-releases
- https://raw.githubusercontent.com/nodejs/Release/main/schedule.json
- https://paypalaihackathon.devpost.com/, deadline, read in the built-in browser

GitHub
- https://github.com/apps/render
- https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party
- https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps
- https://api.github.com/users/Arnav66692
