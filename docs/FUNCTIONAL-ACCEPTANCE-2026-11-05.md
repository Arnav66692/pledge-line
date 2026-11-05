# November 5 functional acceptance — in progress

The user authorized completion and a new sandbox release after full-flow testing. The original pilot checkout, historic grades, stopped AI scopes and unresolved reservations remain preserved. The existing Render service has not been changed or deployed in this completion pass. A private draft deployment configuration is prepared; its temporary local webhook ID must be replaced with the final Render webhook ID before upload.

## Completed evidence

- Main Anthropic agent and advisory Jev reviewer contacted three controlled MCP suppliers. A 100-shirt request within an $800 limit produced an exact $676.25 split plan. Jev flagged closer review; its output did not grant payment authority.
- The browser approved that exact plan and each PayPal sandbox order. Both captures were confirmed through fresh PayPal order/capture reads and Neon: $396.50 and $279.75, one create attempt and one capture attempt per leg. The entire app/private supplier lab restarted between legs, and the original browser session recovered the partial order before completing it. See [checkout proof](results/functional-acceptance-2026-11-05/checkout.json).
- A real sandbox donor subscription was paused and resumed after separate consent, with authoritative status reads and committed one-attempt actions. A $25 sponsor capture and the donor's $25 refund both completed; the subscription stayed ACTIVE. See [donor proof](results/functional-acceptance-2026-11-05/donor.json).
- The app created and sent a $50 sandbox invoice, with fresh provider reads and confirmed durable actions. The first draft attempt was refused with HTTP403 because the configured app lacked invoicing permission. No draft was created by that refusal. The correct sandbox app was identified from its visible client identity; Invoicing was enabled and saved. Fresh OAuth permission and read probes succeeded before a new invoice proposal/consent.
- The signed donor receipt survived a subsequent process restart and passed cryptographic verification using the same stable signing key. See [receipt proof](results/functional-acceptance-2026-11-05/receipt.json).
- Explicit reviewed supplier/donor migrations were applied to Neon. Restricted runtime privileges and actual hosted contention, immutability, credential rejection and quote recovery tests passed. Startup performs no migrations.
- Final serial suite: 732 total, 725 passed, 7 optional hosted cases skipped, 0 failed, including the webhook timestamp and operator CLI changes. Both changes also passed focused tests and independent JS/code review. An API-observed validation error showed webhook event queries require UTC whole seconds; subscription transaction timestamps were unchanged.

- The repeatable new-store CLI passed six focused tests, independent JS/code review, and an actual read-only Neon schema check. Setup commands are documented in the database guide.

## Remaining acceptance and deployment gates

- Complete the sent invoice's sandbox buyer checkout, confirm PAID by API, and persist an actual verified paid webhook before ACK. The browser step is currently waiting for the Mac to be unlocked. The PayPal button was still on its prerendered frame; no invoice payment has been claimed.
- Finish the browser keypad/typed/reload journey, a disposable-subscription cancellation, and final deployment smoke checks. Real microphone input has not been newly verified in this completion pass.
- Commit/review accepted source, configure only the restricted runtime URL and private API keys on the existing free Render service, deploy the tested release, and verify HTTPS/webhooks/restart behavior there.

## Scope and spending

All payment endpoints are PayPal sandbox. Suppliers are controlled lab processes with one owned sandbox merchant, without independent business participation or goods fulfillment. API use is key-only and shares the existing completion allocation of $3 Anthropic and $0.10 Jev across local acceptance and deployment; deployment must not reset that allocation or old latches. Provider balances are not exposed by the API key. No real PayPal money, payment-method changes, purchased infrastructure, outreach, or score uplift is claimed.

Only rebuildable HTTP/bytecode/package/installer caches were cleared. Installed applications, account sessions, project files and the active staged application update were preserved. The first webhook tunnel briefly targeted an occupied port; it was terminated after 27 seconds, with its log retained privately. The corrected reviewed ingress binds loopback port 43158, requires PayPal signature headers on POST /webhooks/paypal, and forwards to the fixed local service for signature verification. It returns only a status. Public root and unsigned webhook probes returned 404 and 400. No provider delivery has yet been claimed.
