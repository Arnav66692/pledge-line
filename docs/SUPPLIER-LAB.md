# Controlled supplier lab

This lab runs three separate local Node HTTP processes, each with its own MCP
token, pricing, capacity, lead time, and persistent quote file. They implement the
supplier protocol through real HTTP requests. All three are operated by this
project. They are not independent businesses and cannot fulfill an order.

The default merchant IDs are **placeholders**, not PayPal merchant accounts.
Setup records `LAB_MERCHANT_MODE=placeholder` and
`PAYPAL_SANDBOX_CHECKOUT_WRITES=false`. The application also refuses PayPal
checkout writes while that placeholder mode is active. This lab does not prove a
successful PayPal checkout, independent supplier participation, or fulfillment.

## Start and verify

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

## Private configuration and persistence

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

## Add authorized sandbox merchant IDs later

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

## Focused regression check

```sh
node --test test/supplier-lab-setup.test.js
```

The tests use temporary private directories and available loopback ports. They
verify private file modes, preservation on rerun, refusal of unrelated or
changed registry files, archival during reconfiguration, two actual supplier
processes, the $674.15 allocation, and retrieval of the same stored quote after a
restart. They also check the lifecycle lock and peer cleanup on an unexpected
exit. They do not call an AI provider or PayPal.
