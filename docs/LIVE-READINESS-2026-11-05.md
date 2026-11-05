# Real-money readiness, November 5, 2026

The product can be adapted to real PayPal payments. This release cannot process them. Configuration and both payment clients refuse live hosts. Keep that boundary intact throughout the hackathon work.

PayPal's current production guide requires a verified account, live credentials and production registration. A platform or marketplace must obtain the applicable live approval and onboard its sellers. Sandbox credentials, objects and the project's single controlled merchant do not establish those permissions. Sources checked November 5: [production guide](https://developer.paypal.com/api/rest/production/), [platforms overview](https://developer.paypal.com/platforms/overview).

## Existing foundation

Exact-plan approval, separate buyer approval, committed attempt identities, authoritative confirmation, duplicate webhook verification, PostgreSQL persistence, read-only reconciliation and stable signed receipts have sandbox evidence. Those mechanisms are useful foundations for live processing, but are not certification of live readiness.

## Required before a live release

| Area | Current sandbox | Live release requirement |
| --- | --- | --- |
| Merchant ownership | Fictional pantry and an owned test merchant | A named legal organization and its verified PayPal merchant account, with an accountable operator. A hosting/database provider cannot supply this ownership. |
| Donor identity | Shared PIN and fixed test subscription | Donor-specific authentication and authoritative subscription ownership. Bind every call, action and receipt to the authenticated organization and donor. |
| Sponsor authority | One configured test authorization | Explicit sponsor mandate and limits for beneficiary, amount, currency, duration and permitted use. Record and enforce that authority separately from possession of an authorization ID. |
| Supplier participation | Controlled lab processes and one merchant | Authorized independent suppliers, correct merchant identities, commercial terms, inventory and delivery/refund policy. Obtain applicable PayPal platform permissions. |
| Credentials and environment | Hard-coded sandbox guard | A separately reviewed live adapter, separate credentials, webhook registration, deployment, database namespace and a default-off launch control. Do not weaken the sandbox adapter. |
| Financial operations | Controlled accepted examples | Verify partial settlement, refunds, capture fees, disputes, out-of-order events, crashes after dispatch and known/unknown recovery for the intended account permissions. |
| Operations | One free Render service and Neon runtime role | Establish service availability, incident ownership, monitoring, credential rotation and tested database backup restoration. |
| Acceptance | Sandbox-only test funds | After all requirements pass, obtain separate explicit authorization for a bounded low-value live transaction and verify settlement and refund in the actual merchant account. |

The user has authorized sandbox testing only. No live account was created or changed, no live credentials were requested, and no real PayPal payment is authorized by this report.

The AI gateway separately uses explicit API keys and durable shared spending controls. It cannot read either provider's exact account balance through the configured keys. A local allocation limit or a reported billing/credit failure stops both providers. This is distinct from production payment authorization.
