# Supply desk and sandbox commerce

The Supply desk at `/procurement` compares complete, all-in supplier allocations under an exact specification, quantity, USD budget and delivery deadline. Code enforces those constraints and the buyer's exact approval. When enabled, Sonnet proposes bounded counteroffers and Jev reviews the proposal; neither model can change a payee, grant consent or authorize a payment.

The network path completed authenticated HTTP/MCP quotes and two buyer-approved PayPal sandbox orders/captures totaling $674.15 test funds using rules routing. Fresh provider reads match the amounts, merchant and durable identities, with one create and capture attempt per leg. The [three-process supplier lab](SUPPLIER-LAB.md) is controlled reference software; all endpoints share one owned sandbox merchant. Independent suppliers, stock, goods fulfillment and production merchant permissions remain unverified. Fresh blind-reviewed V4 passed its frozen routing gates with 29/30 routing, zero wrong mutations, ten pending-consent cases using zero provider calls, and median/p95 3,465/4,512 ms. Three earlier failed evaluations remain preserved. The first actual composed AI quote request failed and stopped both model providers; it is separate from completed payment acceptance. [AI-STATUS.md](AI-STATUS.md) records results and billing observations. No live payments are enabled, and the original pilot checkout and Render deployment are unchanged.

## Modes

| Setting | Quotes | Settlement |
| --- | --- | --- |
| `PROCUREMENT_SUPPLIER_MODE=mock` | Three simulated suppliers and staged recovery scenarios | Mock payments; original PostgreSQL journal when configured, otherwise memory |
| `PROCUREMENT_SUPPLIER_MODE=mcp-sandbox` | One to five authenticated, operator-registered MCP endpoints | Separate durable PayPal sandbox order, buyer approval and capture per vendor |

The page displays its configured mode, full quote costs, rejected offers, exact allocations, advisory review and settlement evidence. Its savings comparison runs the same complete-quantity solver on initial quotes; it is limited to those quotes and does not measure open-market savings.

## Guarded AI prerequisites

`ROUTER_MODE=anthropic` requires PostgreSQL, `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY` and an initialized AI allocation scope. Keep the keys and AI settings in ignored `.ai.env` with mode `600`. Legacy `haiku` startup is refused. Gemini is an explicit historical pilot option; the new agent never falls back to it, another provider or subscription/OAuth credentials.

Before setting `AI_PREPAID_ONLY_CONFIRMED=true`, confirm the intended organizations and API-credit funding. Check automatic credit purchase and invoicing settings where available. This is an operator attestation, not an automatic account or balance check. An API key cannot choose the credit pool. The observed $200 Anthropic grant comes from Ultra and is used before purchased credits, but API usage is separate from plan limits and is never charged to the Claude plan. The user confirmed Jev's $10 balance and authorized proceeding without further Console checks; its automatic-recharge settings remain independently unverified. The intended boundary is API-credit usage without subscription-session credentials or additional billing, not an assertion that the grant has no relationship to Ultra. [AI-STATUS.md](AI-STATUS.md) records the dated observations and process-scoped evaluation authorization.

The gateway calls only its fixed Anthropic and Typesafe API hosts using explicit API keys. Defaults are a $5 Anthropic and $0.25 Jev development allocation in PostgreSQL, not the providers' balances. It reserves a conservative maximum before each request and settles verified usage. An ambiguous request keeps the full reservation. Exhaustion, authentication/billing failure or unverified usage latches a shared stop for both providers, with no automatic retry or reset on restart. `/api/ai/status` and `scripts/ai-check.js` report local allocation/stop state; neither verifies billing or disables auto-reload.

## Operator supplier registry

Set `SUPPLIER_REGISTRY_PATH` to the private registry, normally ignored `.suppliers.json`. Requests from a browser cannot supply endpoints, credentials or merchant IDs. Every entry has an exact supplier ID/name, PayPal sandbox merchant ID, endpoint, host allowlist and the name of a dedicated token environment variable. `tokenEnv` must match `MCP_[A-Z0-9_]{1,68}TOKEN`; its value must contain at least 24 characters and must not reuse a model or database credential.

This is a structural example for one local controlled endpoint. Replace the synthetic merchant ID with the exact ID from the intended sandbox business account before use:

```json
[
  {
    "id": "sandbox-campus-print",
    "name": "Controlled sandbox print supplier",
    "payeeId": "SANDBOXMERCHANT123",
    "endpoint": "http://127.0.0.1:3160/mcp",
    "tokenEnv": "MCP_SUPPLIER_TOKEN",
    "allowedHosts": [],
    "allowLocal": true
  }
]
```

Store the matching private token in ignored `.suppliers.env`, mode `600`, and load it only on the server. For multiple endpoints, use distinct dedicated token variables and matching server configurations. Public endpoints require HTTPS and an exact `allowedHosts` match. Local HTTP is permitted only for explicitly enabled loopback endpoints. DNS is checked and pinned for each request; private/reserved addresses, redirects and mismatched quote fields are refused. TLS still verifies the original public hostname.

The MCP client initializes protocol `2025-06-18`, lists tools and permits only `request_quote`, `negotiate_quote` and `get_quote`. Supplier tool responses are quote evidence, never payment evidence. The server independently validates specification hashes, merchant identity, prices, fees, currency, capacity, expiry and deadline.

## Controlled reference supplier

`scripts/supplier-server.js` serves the authenticated MCP reference endpoint. It does not represent a business or fulfill goods. Configure `MCP_SUPPLIER_TOKEN` and the matching `PAYPAL_SANDBOX_MERCHANT_ID` privately. Optional settings include `MCP_SUPPLIER_ID`, `MCP_SUPPLIER_NAME`, `MCP_SUPPLIER_HOST`, `MCP_SUPPLIER_PORT`, `MCP_SUPPLIER_CAPACITY`, `MCP_SUPPLIER_UNIT_CENTS`, `MCP_SUPPLIER_FLOOR_CENTS`, setup/shipping/tax and lead-time settings from the script.

```sh
node --env-file=.suppliers.env scripts/supplier-server.js
```

The default listener is `127.0.0.1:3160`, capacity is 60 units, and quotes live in memory unless `MCP_QUOTES_PATH` points to a private persistent file. With that option, the server saves and syncs a quote before returning it and reloads saved quotes on startup. Protect the file and its directory; a temporary filesystem does not survive replacement. For the single default endpoint, request at most its capacity or configure additional suppliers. Quote persistence does not reserve real inventory or establish a supplier contract.

## Database checks and startup

Neon PostgreSQL 17 is connected with verified TLS. The original journal schema 1/2, AI schema 1 and checkout schema 1 are explicitly migrated. Use the restricted connection in `.database.env` for checks and runtime; `.database-admin.env` is reserved for explicit migrations in [DATABASE.md](DATABASE.md). Startup never migrates or performs a paid model probe.

```sh
node --env-file=.database.env --env-file=.ai.env scripts/ai-check.js
node --env-file=.database.env scripts/checkout-check.js
# Guarded agent and mock suppliers/PayPal.
PAYPAL_MODE=mock ROUTER_MODE=anthropic node --env-file=.database.env --env-file=.ai.env src/server.js
# Guarded agent, isolated PayPal sandbox API credentials and registered MCP suppliers.
# The donor line stays mock; supplier checkout uses the separate sandbox Orders client.
PAYPAL_MODE=mock ROUTER_MODE=anthropic PROCUREMENT_SUPPLIER_MODE=mcp-sandbox node --env-file=.sandbox.env --env-file=.database.env --env-file=.ai.env --env-file=.suppliers.env src/server.js
```

Keep all secrets in the private files, never command arguments or logs. Set `PUBLIC_BASE_URL` to the intended checkout return origin; HTTPS is required except for local loopback development. `/api/commerce-status` reports the selected mode, write gate and supplier provenance. It does not verify a merchant's production permissions.

The ignored `.sandbox.env` contains only the existing sandbox app's client ID and secret, not a donor subscription ID, PIN or sponsor hold. Procurement uses new buyer-approved Orders and does not charge an existing subscription. The mock donor setting above isolates the original donor flow during procurement acceptance. API authentication alone does not validate registered supplier merchants or completed payments.

## Exact approval, buyer approval and capture

1. Request quotes and review the full allocation. Code checks the complete quantity and all fees, and binds the displayed specification, payees, amounts, currency, deadline and expiry to the approval fingerprint.
2. Approve that exact plan in the Supply desk. Sandbox mode durably stores the plan, quote evidence and session-key hash. The original tab saves its key in `sessionStorage` before continuing. Creating PayPal orders is a separate gated step, which may run immediately after approval only when writes are enabled.
3. Create one PayPal sandbox order per vendor using committed stable request IDs. The workflow rechecks the registered quote and verifies PayPal's returned order binding. The only accepted buyer approval link is the exact PayPal sandbox link for that order.
4. Approve each vendor in PayPal sandbox. The link opens in the same tab so its saved key can resume checkout on return. A return or cancellation URL is not payment evidence or API authority. Recheck the order; the server must read `APPROVED` from PayPal before offering capture.
5. Explicitly capture the next approved leg. Code rechecks the quote and order binding, commits its capture claim, and verifies fresh order and capture reads before marking it confirmed. Earlier captures must be confirmed before later legs advance.
6. Reconcile unknown results using the same stored identities. A lost create response with no readable order identity stays blocked; a new request ID cannot replace it. Partial settlement stays visible. There is no automatic refund, replacement purchase or atomic rollback across suppliers.

HTTP reads and writes require `x-procurement-secret`, independent of the quote confirmation token. After approval, the durable workflow can resume through its original key even after process replacement. Losing that key, clearing tab storage or visiting only a return URL does not authorize a replacement purchase. The shared demo organization is not production tenant authentication.

An expired plan may be explicitly closed only after fresh exact-bound order reads establish unpaid status and the stored workflow has no capture attempts or unknown/in-flight writes. A permanent `closed_unpaid` latch prevents later creation/capture under its old authority. This closes the plan in the app, without claiming to cancel provider orders. New quotes and exact approval are required for another plan.

The optional [read-only recovery controller](CHECKOUT-RECOVERY.md), enabled by `CHECKOUT_RECOVERY_ENABLED=true`, scans known uncertain identities under a transaction advisory lease. It defaults off, scans at most 30 IDs and reconciles at most three workflows per ten-second bounded sweep. It cannot create, capture, refund, replace an unknown identity or automatically advance another payment. Missing creation IDs, lost browser keys and donor-state recovery remain outside its capability.

| Route | Purpose |
| --- | --- |
| `POST /api/procurement` | Request a plan and receive its new session key |
| `GET /api/procurement/:id` | Read the authorized current plan or durable checkout |
| `POST /api/procurement/:id/approve` | Approve exact terms; retain durable checkout in sandbox mode |
| `POST /api/procurement/:id/prepare` | Create still-unattempted sandbox orders when the write gate allows |
| `POST /api/procurement/:id/capture` | Explicitly capture the authorized next `legId` after PayPal buyer approval |
| `POST /api/procurement/:id/reconcile` | Read and reconcile the same identities; mock mode may continue still-valid original legs |
| `POST /api/procurement/:id/close-unpaid` | Permanently close an expired, authoritatively unpaid sandbox plan in the app |

## Write gate and acceptance evidence

PayPal order creation and capture require **both** `PAYPAL_SANDBOX_CHECKOUT_WRITES=true` and a clock at or after `2026-11-05T05:00:00Z` (November 4, 2026, 9:00 pm PT). The lab's `LAB_MERCHANT_MODE=placeholder` independently prohibits writes, including after that time. The approved plan can be retained and read without a checkout write. The time gate does not enable writes by itself, provide buyer approval or authorize production money. Keep the switch false until authorized sandbox merchant IDs are configured and an operator chooses the acceptance run.

The completed workflow is `ac017a40-1900-4c9b-9dc1-39a865e82760`, using sandbox merchant `VL6MYE4R2TBSJ`:

| Order | Capture | Test amount |
| --- | --- | --- |
| `4DL24076LW3255731` | `59C72659KK0134257` | $396.50 USD |
| `23341763JB5935315` | `61696644CK523954V` | $277.65 USD |

The sanitized read-only proof is `handoff/results/ai-commerce-2026-11-04/paypal-sandbox-completed-read-proof-2026-11-05.json` in the parent workspace. Earlier orders `4MC02219J6758725U` and `1LL96044P6101504F` expired before approval; fresh reads showed `PAYER_ACTION_REQUIRED` with no captures, and their app workflow was closed before new quotes. No uncertain payment was retried or replaced.

V1, V2 and V3 composed evaluations are preserved failures. Do not rerun their exposed cases as fresh quality evidence. V4's one frozen, blind-reviewed routing run passed all gates; its sole false unclear remains included. A later plan-only schema correction preserves that routing code and its original archived source. The final schema-reviewed suite passed 648 of 655 tests, with zero failures and seven hosted-only skips.

The first actual composed quote-only UI request failed before approval and retained a $0.05124 Anthropic reservation under the shared `usage_unverified` stop. No Jev review or PayPal write followed. A reviewed transport-schema compatibility fix passed 35 offline agent/procurement tests and the full suite, but a new paid acceptance request awaits user approval for one separate $0.10/$0.01 test allocation. The original stop and reservation remain intact. The local app's model calls remain stopped; read-only recovery runs independently, and the original completed workflow restored its exact payment IDs after restart. Unified AI-negotiation-to-checkout acceptance remains unestablished.

Remaining evidence includes the corrected composed quote flow, a current hosted voice/recorded demonstration, independent supplier participation, observed target-user benefit, and actual provider timeout/duplicate recovery. [AI-EVAL.md](AI-EVAL.md) preserves the evaluation contract. These synthetic and sandbox checks do not establish a 72/90 or 80/90 judging score, a hackathon win or live-payment readiness. [PRODUCTION.md](../PRODUCTION.md) lists the production gates.
