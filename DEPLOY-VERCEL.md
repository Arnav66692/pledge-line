# Pledge Line demo on Vercel

The Vercel copy is a public demo of the donor page. It runs with mock PayPal, the offline rules router and the mock PIN 2468. No PayPal key, no Gemini key and no real money ever reach it. It never counts toward the pilot.

Render and the graded pilot are untouched. Render still deploys branch `pilot` with `render.yaml`, and nothing on this branch changes that service, its env or its ledger. The demo is built from branch `feat/unseen-look` only, which holds the Vercel work from `feat/vercel-demo` and the baked room from `feat/unseen-room`.

## How it works

- `api/index.js` is the one Vercel function. It exports `{ fetch }`, the Web Request shape Vercel's Node runtime documents.
- `src/vercel.js` turns each Request into the Node request and response that `src/server.js` answers, and hands it to `createHandler(deps)`. The local server uses the same `createHandler`, so every route, the static files, the Content-Security-Policy and the rate limits are the local server's own.
- The deps are built once per instance, on the first request, and kept for every later request on that instance.
- `vercel.json` sends every path to the function with a catch-all `routes` entry. A plain `rewrites` entry would not do, since Vercel serves a matching file from the project root before rewrites run, without the page's security headers. It turns on Fluid compute, so one warm instance takes many requests and keeps its calls in memory. It sets `framework` to null, so there is no build step, and bundles `web/` into the function.
- Node is pinned by `engines` in `package.json`, `>=22.12 <25`. Vercel reads that and runs 24.x, the version the tests run on. vercel.json has no Node version field for the built-in runtime, and the old range `>=22.12` would have picked 26.x.

## Forced mock mode

When `VERCEL` is set, and Vercel always sets it, `loadConfig` does this.

- An unset `PAYPAL_MODE` means mock and an unset `ROUTER_MODE` means rules.
- It refuses `PAYPAL_MODE` other than mock and `ROUTER_MODE` other than rules.
- It refuses `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `GEMINI_API_KEY` and `ANTHROPIC_API_KEY` if any is set.
- It refuses a `PILOT_PIN` other than the mock PIN 2468.
- It puts the ledger at `/tmp/pledge-line/mock-ledger.jsonl` and refuses a `LEDGER_PATH` outside `/tmp`.
- It trusts the proxy, so each visitor's limits key on the right-most `X-Forwarded-For`. Vercel overwrites that header with the caller's address, so a visitor cannot pick their own.

The function checks again before it builds anything. If the config is not mock and rules, every request gets a 500 with the page's security headers, and no PayPal client is ever made. The log line says why.

`STAFF_KEY` stays optional. Unset, the staff page, its files and the staff API are all 404s.

## What ships

`.vercelignore` leaves out everything at the root except these.

```
api/index.js
package-lock.json
package.json
src/call.js
src/check.js
src/config.js
src/gate.js
src/ledger.js
src/numbers.js
src/paypal-mock.js
src/paypal.js
src/pilot-scripts.js
src/receipt.js
src/router.js
src/say.js
src/server.js
src/staff.js
src/template-history.js
src/template-words.js
src/vercel.js
src/vocabulary.js
vercel.json
web/app.js
web/chrome.css
web/chrome.js
web/favicon.svg
web/fonts/OFL-geist.txt
web/fonts/OFL-instrument-serif.txt
web/fonts/geist-latin-wght-normal.woff2
web/fonts/instrument-serif-latin-400-italic.woff2
web/fonts/instrument-serif-latin-400-normal.woff2
web/index.html
web/scene.js
web/room/rocks-light.webp
web/room/room-light.webp
web/room/room.glb
web/staff.css
web/staff.html
web/staff.js
web/style.css
web/vendor/LICENSE-ag-grid-community.txt
web/vendor/ag-grid-community.min.js
web/vendor/ag-grid-quartz-icons.woff2
web/vendor/ag-grid.css
web/vendor/ag-theme-quartz.css
```

Left out on purpose. `.env`, `.env.example`, `.claude`, `.pilot`, `.gstack`, `test/`, `scripts/` (the seed, the dry run, pilot-check and the claim audit, which call real APIs), every `.md` note, `render.yaml`, `.node-version`, and the source files the line never loads at run time, `src/claim-arms.js`, `src/claim-audit.js`, `src/claim-fake-model.js`, `src/hours-log.js` and `src/pilot-grade.js`. `src/paypal.js` ships only because `src/server.js` imports it. It is never called in mock mode.

## Deploy

Deploy from a clean export of the branch, never from the main checkout, which stays on `pilot` for the graded pilot. The export folder's name becomes the project name, so it is `pledge-line-demo`.

```
df -h ~
mkdir -p /private/tmp/pledge-line-demo-export/pledge-line-demo
git -C /Users/arnavsingh/Desktop/Business/pledge-line archive feat/unseen-look | tar -x -C /private/tmp/pledge-line-demo-export/pledge-line-demo
cd /private/tmp/pledge-line-demo-export/pledge-line-demo
npx vercel@64.5.0 deploy --prod --yes
```

`vercel@64.5.0` was published on Oct 16, 2026. The first run asks you to log in if the CLI has no credentials. The CLI uploads only what `.vercelignore` lets through, and Vercel runs `npm install` for the one dependency.

No env vars are needed. Vercel sets `VERCEL` itself. `ORG_NAME` is optional. Never set `PAYPAL_MODE` to anything but mock, `ROUTER_MODE` to anything but rules, any PayPal, Gemini or Anthropic key, or `PILOT_PIN`. The demo refuses to start if you do. Set `STAFF_KEY`, 16 or more plain characters, only if the staff view should be on.

Production `*.vercel.app` URLs are public under Vercel's default Standard Protection. Preview URLs ask for a Vercel login.

## Check it after the deploy

Use the URL the CLI prints.

```
curl -sI https://pledge-line-demo.vercel.app/
curl -sI https://pledge-line-demo.vercel.app/app.js
curl -sI https://pledge-line-demo.vercel.app/room/room.glb
curl -sI https://pledge-line-demo.vercel.app/room/README.md
curl -s https://pledge-line-demo.vercel.app/healthz
curl -sI https://pledge-line-demo.vercel.app/src/config.js
curl -sI https://pledge-line-demo.vercel.app/package.json
curl -sI https://pledge-line-demo.vercel.app/staff
```

- `/` is 200 text/html and `/app.js` is 200 text/javascript, each with the page's Content-Security-Policy.
- `/room/room.glb` is 200 model/gltf-binary with the Content-Security-Policy, and `/room/README.md` is a 404.
- `/healthz` says paypal mock and router rules.
- `/src/config.js`, `/package.json` and `/staff` are 404s that also carry the Content-Security-Policy. A 200 there means Vercel served a file from the root, and the `routes` entry is not working.

Then open the page with `?mute=1`, start Script 2, enter 2468 and say you want to stop the gift.

## What is lost on a cold start

The demo keeps nothing durable. A new instance starts empty.

- Calls in progress live in memory. A call whose next turn reaches a different or a new instance gets "That call was not found. Please start a new call." Fluid compute keeps one warm instance serving many requests, so this is rare at demo traffic, but it can happen on a cold start, a redeploy, a scale out to a second instance or after the instance sleeps.
- The mock PayPal subscription lives in memory, and every visitor on an instance shares it. After one visitor pauses the gift, the next hears it as suspended until someone restarts it. A cold start sets it back to active.
- The ledger at `/tmp/pledge-line/mock-ledger.jsonl` is per instance and goes when the instance does.
- Rate limits and the wrong PIN count per address reset.
- Idle calls are swept on the next request after 30 seconds, since a function has no timer between requests.

## Run it locally through the same handler

Plain node, no `vercel dev`. The runner plays Vercel's proxy and sets `X-Forwarded-For` to the caller's address.

```
VERCEL=1 LEDGER_PATH=/tmp/pledge-line-demo/ledger.jsonl PORT=3871 node scripts/vercel-local.js
```

Then open `http://127.0.0.1:3871/?mute=1`. `npm test` covers the handler in `test/vercel.test.js`.
