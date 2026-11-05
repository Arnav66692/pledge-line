# Controlled supplier lab

The lab offers two explicit modes. The current hosted release runs three private
HTTP/MCP listeners inside the web server's Node process, with immutable quotes in
PostgreSQL. The original development launcher runs three separate local Node
processes and keeps private quote files. Both use real authenticated HTTP
requests. All suppliers are controlled by this project; they are not independent
businesses and cannot fulfill an order.

The standalone launcher's default merchant IDs are **placeholders**, not PayPal
accounts. Its setup records `LAB_MERCHANT_MODE=placeholder` and disables PayPal
writes; the application refuses checkout writes while that mode is active. The
hosted lab instead requires one configured authorized sandbox merchant and
rejects the known placeholder IDs. A configured merchant ID alone does not prove
buyer approval, a successful capture or supplier fulfillment.

## Current hosted mode

Use this mode for the existing free Render service. It requires the restricted
runtime `DATABASE_URL`, the reviewed supplier quote schema, and explicit flags:

```dotenv
PAYPAL_MODE=sandbox
PROCUREMENT_SUPPLIER_MODE=mcp-sandbox
HOSTED_SUPPLIER_LAB_ENABLED=true
SUPPLIER_LAB_PAYEE_ID=YOUR_AUTHORIZED_SANDBOX_MERCHANT_ID
DONOR_DURABILITY_ENABLED=true
CHECKOUT_RECOVERY_ENABLED=true
PAYPAL_SANDBOX_CHECKOUT_WRITES=false
```

Replace the merchant placeholder with the actual sandbox account ID. This
project's accepted configuration uses one owned merchant, `VL6MYE4R2TBSJ`, for
all three controlled suppliers. The donor flag also requires its separate donor
schema; it is independent of supplier quote persistence. Apply schemas with the
administrator connection and verify exact runtime grants before startup; see
[DATABASE.md](DATABASE.md). The app checks schemas but never creates them.

After the ordinary PIN, donor/hold/webhook IDs, API-credit settings and credentials
are configured privately, start from the project directory:

```sh
node --env-file=.env --env-file=.database.env --env-file=.ai.env --env-file=.sandbox.env src/server.js
```

Load general `.env` first so empty template credential fields cannot override
the later private files. Hosted mode generates its own private registry and
fresh distinct supplier tokens; it needs neither `.suppliers.json` nor
`.suppliers.env`. Do not load the standalone launcher's placeholder settings into
this mode. Do not run that launcher at the same time, since both default to
ports 3160–3162.

The listeners bind only to `127.0.0.1`; the public web port must differ from the
three supplier ports. Render exposes only its main `PORT`, with `HOST=0.0.0.0`
for that web listener. No public supplier route, separate service, paid worker
or persistent Render filesystem is needed. Requests require their dedicated MCP
bearer and reject browser cross-origin access. Supplier interfaces provide
quotes and bounded counteroffers, with no payment methods or authority.

On startup, active quotes are loaded and checked against their supplier ID,
configured payee, exact terms and expiry. Each newly issued quote commits to
PostgreSQL before it is returned. A cache miss reads the exact durable quote,
including one issued by another running instance after startup. A restart
changes private MCP tokens but preserves valid quote identities. Changing the
configured payee while its old quotes remain active causes startup refusal;
do not edit or delete quote history to force it through. Expired records remain
durable evidence, but cannot authorize new settlement.

For an authorized checkout test, set `PAYPAL_SANDBOX_CHECKOUT_WRITES=true`; the
server's time gate, current quote checks, exact plan approval, separate buyer
approval and per-supplier capture checks still apply. `/api/commerce-status`
reports controlled-lab provenance and write availability without exposing its
tokens. The known-identity recovery worker performs reads only. Every PayPal
request remains sandbox-only.

The deterministic negotiation floor produces the $674.15 plan described below.
Anthropic can propose a different valid counteroffer: the corrected bounded
model test produced $676.25 because Club Threads accepted $6.25 rather than its
$6.20 floor. Jev flagged that plan for closer review. Neither one quote nor the
floor comparison proves market savings or model-specific improvement.

## Original separate-process mode: start and verify

Run from the integration project directory, using the installed Node version:

```sh
node scripts/setup-supplier-lab.js --setup
node scripts/setup-supplier-lab.js --start
```

Keep the second command running. It prints public endpoints and the launcher and
child process IDs. It starts only the lab's children; stopping the launcher with
Ctrl-C gracefully stops those children. In another terminal:

```sh
node scripts/setup-supplier-lab.js --check
```

The check requests and negotiates new quotes through authenticated MCP, then
uses the procurement allocator to select 60 shirts from Campus Print and 40
from Club Threads for **$674.15**, including setup, shipping, and tax. Rush Merch
provides a more expensive one-day option. The check creates local quote records;
it makes **zero AI requests and zero PayPal financial writes**. It does not
approve, capture, or fulfill an order. Its deterministic price target verifies
the protocol and allocation, not model intelligence or market competitiveness.

| Controlled process | Endpoint | Capacity | Negotiated unit price | Lead time |
| --- | --- | ---: | ---: | ---: |
| Campus Print lab | `http://127.0.0.1:3160/mcp` | 60 | $6.00 | 2 days |
| Club Threads lab | `http://127.0.0.1:3161/mcp` | 40 | $6.20 | 3 days |
| Rush Merch lab | `http://127.0.0.1:3162/mcp` | 100 | $7.80 | 1 day |

## Separate-process private configuration and persistence

Setup creates ignored local files:

- `.suppliers.json`: operator registry containing endpoint, merchant ID, and
  `tokenEnv` references; no token values.
- `.suppliers.env`: random 256-bit MCP tokens and the disabled-payment settings.
  It is created with file mode `0600`.
- `.supplier-lab/`: mode `0700`; ownership manifest, process records, and one
  quote file per supplier. Quotes retain their IDs across process restarts until
  their ordinary expiration time.

The launcher loads those files directly. Supplier children receive only their
own token and supplier configuration; they do not inherit Anthropic, Jev,
database, or PayPal API credentials. Do not pass secrets in command arguments or
commit these files.

Re-running setup validates the ownership manifest and preserves existing tokens
and quote files. Existing unrelated files or changed configuration cause a
refusal instead of an overwrite. Inspect such a refusal before changing files.
The launcher refuses a second start while its recorded launcher is alive. It
does not kill processes based on saved PID values. A private exclusive lifecycle
lock serializes startup and merchant reconfiguration. If a process crashes
while holding that lock, inspect the launcher and its children before manually
archiving the stale `lifecycle.lock` file; the script never guesses that it is
safe to remove another process's lock. An unexpected supplier exit stops the
other children owned by that launcher.

For application integration, load `.suppliers.env` after the other local env
files. Its `PROCUREMENT_SUPPLIER_MODE=mcp-sandbox` and
`SUPPLIER_REGISTRY_PATH` select this registry. Keep its payment-disable settings
intact. The lab can run without loading any API or database environment file.

## Configure separate-process sandbox merchant IDs

An operator must obtain each sandbox business's actual PayPal merchant ID and
verify account access and permission. A placeholder or syntactically valid ID
does not establish that authority. Stop the launcher before reconfiguring.

Provide `LAB_CAMPUS_PAYPAL_MERCHANT_ID`, `LAB_CLUB_PAYPAL_MERCHANT_ID`, and
`LAB_RUSH_PAYPAL_MERCHANT_ID` through a private env file, then run:

```sh
node --env-file=/absolute/path/to/private-sandbox-merchant-settings.env scripts/setup-supplier-lab.js --configure-merchants
```

`PAYPAL_SANDBOX_MERCHANT_ID` may supply a shared fallback when all controlled
supplier processes intentionally use the same authorized sandbox merchant.
The command rejects known placeholders, archives the verified prior settings,
and retains quote history. It marks merchant configuration as `configured` but
still reports ownership as unverified and **keeps PayPal writes disabled**.
Previously issued quotes tied to a different merchant must not be reused.
PayPal checkout verification is a separate flow after authorized sandbox
accounts and application credentials are connected.

## Verification and preserved evidence

```sh
node --test test/supplier-lab-setup.test.js
node --test test/hosted-supplier-lab.test.js test/supplier-quote-store.test.js test/hosted-runtime.test.js
```

The original launcher tests use temporary private directories and available loopback ports. They
verify private file modes, preservation on rerun, refusal of unrelated or
changed registry files, archival during reconfiguration, two actual supplier
processes, the $674.15 allocation, and retrieval of the same stored quote after a
restart. They also check the lifecycle lock and peer cleanup on an unexpected
exit. Hosted lab tests additionally check authenticated private listeners,
fresh token generation, persistence before visibility, exact quote restoration,
read-through across already-running instances, expiry/capacity handling and
listener cleanup when startup fails. These local tests do not call an AI
provider or PayPal. `SUPPLIER_QUOTE_TEST_URL` separately enables the immutable
quote store's actual PostgreSQL test against an already-migrated disposable
database; supply it privately with runtime privileges. A skipped hosted test is
not an acceptance pass.

Historical controlled HTTP/MCP acceptance completed a rules-routed $674.15
buyer-approved PayPal sandbox purchase; the separate corrected bounded model
quote cost $0.005544906 in model credits and made no payment. Those records stay
separate. The November 5 complete AI purchase, donor, webhook and restart run is
still being accepted and must pass before deployment; this document does not
claim that the new full flow is complete. The current full regression suite,
including enabled donor/supplier Neon tests, reported 725 passed, 7 skipped and
0 failed. No lab result establishes independent supplier participation,
commercial fulfillment or real-money readiness.
