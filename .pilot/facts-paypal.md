# PayPal facts for the Pledge Line pilot

Checked on Sun Nov 1, 2026 (PT) for the paypal.js, paypal-mock.js and seed-sandbox.js sections of SPEC.md. No PayPal call was made, because no credentials exist yet. Every claim below comes from a PayPal OpenAPI file or a developer.paypal.com page read on Nov 1. Nothing here was tested against the live sandbox.

Status words. **Verified** means a PayPal spec or doc page states it. **Likely** means PayPal's docs point that way without saying it outright. **Unverified** means I could not confirm it, and it is listed again under Open questions.

## Sources

| Short name | What it is |
|---|---|
| GH-SUB | GitHub `paypal/paypal-rest-api-specifications`, branch main, `openapi/billing_subscriptions_v1.json`, info.version 1.8 |
| GH-PROD | same repo, `openapi/catalogs_products_v1.json`, version 1.0 |
| GH-INV | same repo, `openapi/invoicing_v2.json`, version 2.6 |
| GH-WH | same repo, `openapi/notifications_webhooks_v1.json`, version 1.11 |
| DS-SUB | `https://developer.paypal.com/api/subscriptions/v1/schema.json`, version 1.11 |
| DS-INV | `https://developer.paypal.com/api/invoicing/v2/schema.json`, version 2.12 |
| DS-WH | `https://developer.paypal.com/api/webhooks/v1/schema.json`, version 1.11 |
| DS-PROD | `https://developer.paypal.com/api/catalog-products/v1/schema.json`, version 1.0 |
| Docs | developer.paypal.com pages, read as Markdown by adding `.md` to the path given in each row |

PayPal's API reference pages call the docs-site schema files (DS) the authoritative source, and they are newer than GitHub. The two sets agree on every field below except where a row says otherwise. Copies of every downloaded file sit in the session scratchpad, `/private/tmp/claude-501/-Users-arnavsingh-Desktop-Business/c8275403-5b6a-4709-9a39-c243ab3d901f/scratchpad`, which is temporary.

## Corrections to SPEC.md

1. **Invoice item amount.** `unit_amount` is a money object, not a string. Send `{"currency_code": "USD", "value": "50.00"}`, and send `quantity` as the string `"1"`. `unit_of_measure: "AMOUNT"` is optional and shows only the amount on the invoice. Leave out `detail.invoice_date`, because a future issue date makes send schedule the invoice instead of sending it. Leave out `invoicer.email_address`, because when present it must exactly match the sandbox business account or create fails with USER_NOT_FOUND. Sources GH-INV and DS-INV `item`, the invoices.send description, Docs `/invoicing/troubleshooting`.
2. **Error parsing.** The token endpoint returns Identity errors shaped `{"error": "invalid_client", "error_description": "..."}`, not `{name, message}`. Map `error` to name and `error_description` to message. Take the debug id from the `Paypal-Debug-Id` response header first, then `debug_id` in the body, then `debugId`, which some sandbox negative-test samples use. Never parse a body on 204. Sources Docs `/api/rest/responses`, `/subscriptions/test-go-live`, `/platforms/integration-checklist`.
3. **Mock invoice errors are a guess.** PayPal documents no 422 for deleting a non-draft invoice, since the delete operation lists only 400, 403, 404 and 500. For sending an already-sent invoice the docs disagree. The send description says resending has no effect, the sandbox test table lists CANT_SEND_ALREADY_SENT_INVOICE, and the Invoicing errors page lists 409 CONFLICT for an invoice already sent. The mock can keep 422, but call.js must treat any non-2xx from send or delete as a failure, follow it with a fresh GET, and never branch on 422 for invoices. Sources GH-INV and DS-INV invoices.delete and invoices.send, Docs `/invoicing/test-go-live`, `/invoicing/errors`.
4. **Status after send can be UNPAID.** The mock assumes SENT. PayPal's lifecycle page says an invoice sent to the customer's email through the invoicing UI reads SENT and one shared by link or QR code reads UNPAID, while the Invoicing quick start says the status becomes UNPAID after an API send. Treat UNPAID like SENT in call.js, say.js and the mock. Add `unpaid` to the I3 status-word list and to extractSpokenFacts, and match whole words so `unpaid` is never counted as `paid`. Sources Docs `/invoicing/lifecycle`, `/api/invoicing`.
5. **Shape of INVOICING.INVOICE.PAID.** PayPal's Invoicing webhooks page shows the invoice id at `resource.id` next to `resource.status`, but no PayPal source confirms the live v2 shape. Read the invoice id from `resource.id` when it starts with `INV2-`, else from `resource.invoice.id`, and have mockPay emit the flat documented shape. Event ids look like `WH-3F562076HD293871E-75F399086E414290U`, with hyphens, although the spec pattern for the resend path parameter is `^[a-zA-Z0-9]+$`. Never validate event ids with that pattern. Sources Docs `/api/invoicing/webhooks`, `/api/rest/webhooks/rest`, GH-WH `event_id` parameter.
6. **Finding and resending the event.** `GET /v1/notifications/webhooks-events` cannot filter by invoice. Query with `event_type=INVOICING.INVOICE.PAID`, a `start_time`, and a `page_size` above the default of 10, then match the invoice id inside each event's `resource`. Post the resend with body `{"webhook_ids": ["<PAYPAL_WEBHOOK_ID>"]}` and expect 202. A notification PayPal is still retrying (pending) is not resent. Sources GH-WH and DS-WH webhooks-events.list and webhooks-events.resend.
7. **Registering the webhook twice.** A URL that already has a webhook fails with WEBHOOK_URL_ALREADY_EXISTS, and one app holds at most ten webhooks (WEBHOOK_NUMBER_LIMIT_EXCEEDED). `seed --webhook` should call listWebhooks first and reuse the id of a matching URL. The webhook must belong to the same REST app whose client id creates the invoices, because PayPal sends events only to webhooks of the app that did the work. Sources DS-WH `x-errors`, Docs `/api/rest/webhooks`, `/invoicing/troubleshooting`.
8. **How Arnav pays the Script 5 invoice.** The sandbox never emails anyone outside the sandbox. Each message lands on the Notifications page of the sandbox account it was sent to. The direct way to pay is to open `detail.metadata.recipient_view_url` from the invoice GET while logged in to the sandbox as the personal account. SPEC never says where Arnav sees that URL. Show it in the record card or print it from pilot:dry, and never speak it. Sources Docs `/sandbox-testing/calls`, GH-INV `metadata.recipient_view_url`.

## OAuth

| Claim | Source | Status |
|---|---|---|
| `POST https://api-m.sandbox.paypal.com/v1/oauth2/token` with HTTP Basic auth of `CLIENT_ID:CLIENT_SECRET` in Base64, header `Content-Type: application/x-www-form-urlencoded`, body `grant_type=client_credentials`. | Docs `/api/rest/authentication`, `/invoicing/troubleshooting` | Verified |
| The response has `scope`, `access_token`, `token_type` (`Bearer`), `app_id`, `expires_in` and `nonce`. `expires_in` is in seconds, and the sample shows 31668. | Docs `/api/rest/authentication` | Verified |
| Tokens last about 9 hours and there is no refresh token. PayPal's own Node sample refreshes 60 seconds before expiry, which matches SPEC. | Docs `/invoicing/core-concepts`, `/invoicing/troubleshooting` | Verified |
| Calls carry `Authorization: Bearer <access_token>`. | Docs `/api/rest/authentication` | Verified |
| Token errors use the Identity shape, for example 401 `{"error": "invalid_client", "error_description": "Client Authentication failed"}`. | Docs `/api/rest/responses` | Verified |
| Scopes the specs require. Products, plans and subscriptions need `https://uri.paypal.com/services/subscriptions`. Invoice create, send and delete need `https://uri.paypal.com/services/invoicing/invoices/readwrite`, and GET needs `.../invoices/read`. Webhook calls need `https://uri.paypal.com/services/applications/webhooks`, and verify also lists `.../applications/verify-webhook-signature`. | GH-SUB, GH-PROD, GH-INV, GH-WH `security` | Verified |
| The sample token scope string includes `services/invoicing`, `services/subscriptions` and `services/applications/webhooks`. | Docs `/api/rest/authentication` | Verified |

## Headers and errors

| Claim | Source | Status |
|---|---|---|
| `PayPal-Request-Id` is declared only on create product, create plan and create subscription, where the server keeps keys for 72 hours. | GH-SUB, GH-PROD, DS-SUB, DS-PROD header parameters | Verified |
| The invoicing schemas declare no `PayPal-Request-Id`, but the Invoicing guides say to send one on create so a retry with the same id cannot make a duplicate invoice. | DS-INV, Docs `/invoicing/core-concepts`, `/invoicing/troubleshooting` | Verified |
| Suspend, activate, cancel, send, delete, webhook and verify calls declare no `PayPal-Request-Id`. PayPal says to check each API reference before relying on it. | GH-SUB, DS-SUB, GH-INV, DS-WH, Docs `/api/rest/reference/idempotency` | Verified |
| A repeated id returns the latest status of the first request. Leaving the header out makes PayPal treat each call as new. Two simultaneous calls with one id can fail the second. A UUID fits the 38 character limit. A fresh id on every POST, as SPEC has it, protects nothing unless a retry reuses the same id, and paypal.js never retries. | Docs `/api/rest/reference/idempotency` | Verified |
| `Prefer` (`return=minimal` by default, or `return=representation`) is declared on create product, plan and subscription. Minimal still returns `id`, `status` and `links`. | GH-SUB, DS-SUB, GH-PROD | Verified |
| The debug id response header is `Paypal-Debug-Id`, which PayPal asks integrators to store. Header names are case-insensitive, so `res.headers.get('paypal-debug-id')` works. | Docs `/platforms/integration-checklist` | Verified for the name. Unverified that every response, including 204s and the token call, carries it |
| REST errors look like `{"name", "message", "debug_id", "details": [{"field", "value", "location", "issue", "description"}], "links"}`. Webhook API errors can add `information_link`. | Docs `/api/rest/responses`, GH-SUB `error_422`, GH-WH `error-2` | Verified |
| Names by status. 400 INVALID_REQUEST, 401 AUTHENTICATION_FAILURE, 403 NOT_AUTHORIZED, 404 RESOURCE_NOT_FOUND, 409 RESOURCE_CONFLICT, 415 UNSUPPORTED_MEDIA_TYPE, 422 UNPROCESSABLE_ENTITY, 429 RATE_LIMIT_REACHED, 500 INTERNAL_SERVER_ERROR, 503 SERVICE_UNAVAILABLE. | Docs `/api/rest/responses` | Verified |
| Some sandbox negative-test samples show `debugId` in camel case and extra fields such as `localizedMessage`. | Docs `/subscriptions/test-go-live`, `/invoicing/test-go-live` | Verified |
| A JSON body needs `Content-Type: application/json`. DS-SUB marks that header required even on GETs, and PayPal's own GET examples send it. | DS-SUB header parameters, Docs `/api/rest/requests` | Verified |
| PayPal publishes no rate limit, may answer 429 RATE_LIMIT_REACHED to traffic that looks abusive, and asks callers to cache tokens and not poll. | Docs `/api/rest/reference/rate-limiting` | Verified |

## Products

| Claim | Source | Status |
|---|---|---|
| `POST /v1/catalogs/products`. Required `name` (1 to 127 chars) and `type` (`PHYSICAL`, `DIGITAL` or `SERVICE`, default PHYSICAL). Optional `description` (1 to 256), `category`, `image_url`, `home_url` and `id`. | GH-PROD, DS-PROD `product_request_POST` | Verified |
| Leave out `id`. PayPal then makes a `PROD-` id, and create plan only accepts a 22 character id matching `^PROD-[A-Z0-9]*$`. | GH-PROD `id`, GH-SUB `plan_request_POST.product_id` | Verified |
| `category` includes `NONPROFIT` and `CHARITY`. | GH-PROD `product_category` | Verified |
| Success is 201 Created with `id`, `name`, `description`, `create_time` and `links`. The spec also lists 200. | Docs `/subscriptions/integrate/v5`, GH-PROD | Verified |

```json
{"name": "Sunny Hollow Pantry monthly gift", "type": "SERVICE", "category": "NONPROFIT"}
```

## Plans

| Claim | Source | Status |
|---|---|---|
| `POST /v1/billing/plans`. Required `product_id`, `name` (1 to 127), `billing_cycles` (1 to 12 items, at most one REGULAR and two TRIAL) and `payment_preferences`. Optional `status`, `description` (1 to 127), `taxes`, `quantity_supported`. | GH-SUB, DS-SUB `plan_request_POST` | Verified |
| Each cycle requires `frequency`, `tenure_type` and `sequence`. `interval_unit` is DAY, WEEK, MONTH or YEAR. `interval_count` defaults to 1 and is at most 12 for MONTH. `tenure_type` is REGULAR or TRIAL. `sequence` is 1 to 99. | GH-SUB `billing_cycle`, `frequency` | Verified |
| `total_cycles` defaults to 1, so send 0 on purpose. 0 makes the REGULAR cycle repeat until cancelled. | GH-SUB `billing_cycle.total_cycles` | Verified |
| The price lives in `pricing_scheme.fixed_price`, which requires `currency_code` (3 letters) and `value` (a string up to 32 chars). One currency per plan. | GH-SUB `pricing_scheme`, `money`, Docs `/subscriptions/integrate/v5` | Verified |
| Every `payment_preferences` field is optional. `auto_bill_outstanding` defaults to true, `setup_fee_failure_action` to CANCEL, `payment_failure_threshold` to 0. | GH-SUB `payment_preferences` | Verified |
| `status` defaults to ACTIVE, and only CREATED and ACTIVE are accepted as input. A plan created without `status` comes back ACTIVE, so no activate call is needed. | GH-SUB, DS-SUB `plan_request_POST.status`, Docs `/subscriptions/integrate/v5` sample response | Verified |
| Plan ids are 26 chars matching `^P-[A-Z0-9]*$`. | GH-SUB `plan.id` | Verified |
| `GET /v1/billing/plans/{id}` returns the price at `billing_cycles[i].pricing_scheme.fixed_price.value` and `.currency_code` for the cycle whose `tenure_type` is REGULAR. 404 is RESOURCE_NOT_FOUND. | GH-SUB `plan`, plans.create example | Verified |
| Money values are strings, and PayPal's own plan examples send and return `"10"` with no decimals. Normalize before comparing or speaking. | GH-SUB plans.create example, Docs `/subscriptions/integrate/v5` | Verified that they are strings. Unverified how the sandbox echoes `"25.00"` |

```json
{
  "product_id": "PROD-XXXXXXXXXXXXXXXXX",
  "name": "Sunny Hollow Pantry monthly gift",
  "billing_cycles": [
    {
      "frequency": {"interval_unit": "MONTH", "interval_count": 1},
      "tenure_type": "REGULAR",
      "sequence": 1,
      "total_cycles": 0,
      "pricing_scheme": {"fixed_price": {"value": "25.00", "currency_code": "USD"}}
    }
  ],
  "payment_preferences": {"auto_bill_outstanding": true}
}
```

## Subscriptions

| Claim | Source | Status |
|---|---|---|
| `POST /v1/billing/subscriptions`. Required `plan_id` (26 chars). Optional `start_time` (defaults to now), `quantity`, `subscriber`, `application_context`, `custom_id` (up to 127) and a `plan` override. | GH-SUB, DS-SUB `subscription_request_post` | Verified |
| `application_context` holds `brand_name` (1 to 127), `locale`, `shipping_preference` (GET_FROM_FILE by default, NO_SHIPPING, SET_PROVIDED_ADDRESS), `user_action` (SUBSCRIBE_NOW by default, or CONTINUE) and `payment_method`, and it requires `return_url` and `cancel_url` (URIs of 10 to 4000 chars). | GH-SUB `application_context` | Verified |
| SUBSCRIBE_NOW means PayPal activates the subscription once the buyer approves. CONTINUE means you activate it yourself. | GH-SUB `user_action` enum descriptions | Verified |
| DS-SUB 1.11 marks `application_context` deprecated but offers no replacement for the PayPal approval flow, since its `subscriber.payment_source` only holds `card`. GH-SUB 1.8 and PayPal's sandbox test samples still use it. | DS-SUB `subscription_request_post`, `payment_source`, Docs `/subscriptions/test-go-live` | Verified for the label. Likely still works |
| Create returns 201 (200 is also listed) with `status` APPROVAL_PENDING and `links`. One link has `rel` `approve` and `method` GET, with an href like `https://www.paypal.com/webapps/billing/subscriptions?ba_token=BA-...`. The others are `self` GET and `edit` PATCH. | GH-SUB subscriptions.create example | Verified |
| Statuses are APPROVAL_PENDING, APPROVED, ACTIVE, SUSPENDED, CANCELLED and EXPIRED. | GH-SUB, DS-SUB `subscription_status.status` | Verified |
| After a sandbox buyer approves with SUBSCRIBE_NOW, a GET should read ACTIVE, possibly after a short APPROVED step. | GH-SUB `user_action`, third-party API wrappers | Likely |
| Whether the first $25 is charged at approval. PayPal's examples point to a charge at sign-up when `start_time` is now. A delayed start charges regular payments from the chosen date, and the payment-failure example has a subscriber pay on January 1 and be billed on the 1st after that. Community answers disagree. | Docs `/subscriptions/delayed-start`, `/subscriptions/payment-failure-retry` | Unverified, watch it on Nov 3 |
| `GET /v1/billing/subscriptions/{id}` returns `id`, `status`, `status_update_time`, `plan_id`, `start_time`, `subscriber.email_address`, `subscriber.name.given_name`, `subscriber.payer_id` and `billing_info` with `next_billing_time`, `last_payment.amount`, `last_payment.time`, `outstanding_balance`, `cycle_executions` and `failed_payments_count`. 404 is RESOURCE_NOT_FOUND. | GH-SUB `subscription`, `subscriber`, `subscription_billing_info` | Verified |
| `billing_info` is filled only when the subscription is or was active. | GH-SUB `subscription.billing_info` | Verified |
| `GET ...?fields=plan` adds the plan to the subscription response, which could replace the separate plan GET. The only other value is `last_failed_payment`. | GH-SUB, DS-SUB subscriptions.get `fields` | Verified |
| Suspend is `POST /v1/billing/subscriptions/{id}/suspend` with `{"reason": "..."}`, and reason is required. Cancel is `.../cancel` with the same body, reason required. Activate is `.../activate` with the same body. Its reason is optional in the schema but described as required to reactivate, so always send it. | GH-SUB, DS-SUB `subscription_suspend_request`, `subscription_cancel_request`, `subscription_activate_request` | Verified |
| `reason` is 1 to 128 chars with pattern `^.*$`, so one line. A longer value gives 400 with issue INVALID_STRING_MAX_LENGTH. | GH-SUB `subscriptions.suspend-400`, `-activate-400`, `-cancel-400` | Verified |
| All three return 204 No Content with no body. | GH-SUB, DS-SUB | Verified |
| Suspend works only from ACTIVE, activate only from SUSPENDED, cancel from ACTIVE or SUSPENDED. | GH-SUB, DS-SUB `subscriptions.*-422` issue descriptions | Verified |
| A wrong transition returns HTTP 422 with `name` UNPROCESSABLE_ENTITY and `details[0].issue` SUBSCRIPTION_STATUS_INVALID. Activate can also return SUBSCRIPTION_CANNOT_BE_ACTIVATED, and all three can return USER_ACCOUNT_CLOSED. | same | Verified |
| A cancelled subscription cannot be activated again, and PayPal calls cancel a hard cancellation. If any run cancels the demo subscription, seed and approve a new one. | GH-SUB activate-422, Docs `/subscriptions/pause-or-resume` | Verified |
| A suspended subscription takes no payments until it is activated again. | Docs `/subscriptions/pause-or-resume` | Verified |

```json
{
  "plan_id": "P-XXXXXXXXXXXXXXXXXXXXXXXX",
  "application_context": {
    "brand_name": "Sunny Hollow Pantry",
    "shipping_preference": "NO_SHIPPING",
    "user_action": "SUBSCRIBE_NOW",
    "return_url": "https://<render-host>/",
    "cancel_url": "https://<render-host>/"
  }
}
```

## Invoicing v2

| Claim | Source | Status |
|---|---|---|
| `POST /v2/invoicing/invoices`. The only required field is `detail`, and `detail` requires only `currency_code`. The operation description says the body must include `items`. | GH-INV, DS-INV `invoice.required`, `detail.required`, invoices.create | Verified |
| `detail.note` is up to 4000 chars and appears on the invoice email. DS-INV sets a minimum of 1, so never send an empty note. | GH-INV, DS-INV `detail.note` | Verified |
| `invoicer.business_name` is up to 300 chars. `invoicer.email_address`, when present, must exactly match the business account behind the token, or create fails with USER_NOT_FOUND or INVALID_REQUEST. | GH-INV `business_name`, `invoicer_info`, Docs `/invoicing/troubleshooting` | Verified |
| `primary_recipients[0].billing_info.email_address` is 3 to 254 chars. Without it the invoice is payable but no email goes out, and send can fail with CANT_SEND_INVOICE_WITHOUT_EMAIL. | GH-INV `billing_info`, Docs `/invoicing/test-go-live` | Verified |
| Each item requires `name` (up to 200), `quantity` (a string up to 14 chars, pattern `^\d+(.\d{1,5})?$`) and `unit_amount` (money object with `currency_code` and `value`, two decimals at most). `unit_of_measure` is optional, QUANTITY, HOURS or AMOUNT. AMOUNT hides quantity and unit price on the invoice, and mixed values on one invoice use the first. | GH-INV, DS-INV `item`, `unit_of_measure` | Verified |
| `detail.invoice_number` is optional and up to 25 chars. Left out, PayPal uses the next number after the last one. A DS-INV example sent without a number comes back as `"0006"`. | DS-INV `invoice_detail.invoice_number` and invoices.create examples, Docs `/invoicing/object` | Verified |
| Invoice numbers are not always digits. Examples show `#123` and `INV-0001`. A deleted invoice's number can be reused. | DS-INV examples, Docs `/invoicing/object`, GH-INV invoices.delete | Verified |
| Create returns 201. The full invoice comes back only with `Prefer: return=representation`. Without it the body holds a link whose `href` contains the id, shaped `INV2-XXXX-XXXX-XXXX-XXXX`. Neither invoicing schema declares `Prefer` as a parameter, only the 201 description names it. | GH-INV, DS-INV 201 description, Docs `/api/invoicing` | Verified |
| The full invoice from create or GET has `id`, `status` DRAFT, `detail.invoice_number`, `detail.metadata.recipient_view_url`, `amount.value`, `amount.currency_code`, `due_amount`, `primary_recipients` and `links` (self, send, replace, delete, record-payment, qr-code). | DS-INV invoices.create and invoices.get examples | Verified |
| Invoice ids are `INV2-` followed by 19 capitals, digits and hyphens. | GH-INV `invoice_number.invoice_id` pattern, Docs `/invoicing/object` | Verified |
| `GET /v2/invoicing/invoices/{id}` returns 200 with the invoice. | GH-INV, DS-INV invoices.get | Verified |
| A draft is invisible to the payer, and nobody is notified until send. | Docs `/invoicing/lifecycle`, `/invoicing/core-concepts` | Verified |
| Send is `POST /v2/invoicing/invoices/{id}/send` with an optional body such as `{"send_to_recipient": true, "send_to_invoicer": true}`. `send_to_recipient` defaults to true and `send_to_invoicer` to false. `subject` and `note` in this body are ignored. | GH-INV, DS-INV `notification`, Docs `/api/invoicing` | Verified |
| Send returns 200 with one link object (`href`, `rel`, `method`) when the issue date is today or earlier. It returns 202 and schedules the invoice when the issue date is in the future. The 202 example has `rel` payer-view. | GH-INV, DS-INV invoices.send | Verified |
| After send the invoice cannot be deleted, only cancelled. | Docs `/api/invoicing`, GH-INV invoices.delete | Verified |
| The status right after an API send is SENT or UNPAID. The lifecycle page ties SENT to sending by email through the invoicing UI and UNPAID to link or QR sharing, and the API quick start says UNPAID. | Docs `/invoicing/lifecycle`, `/api/invoicing` | Docs conflict |
| Delete is `DELETE /v2/invoicing/invoices/{id}`, only for DRAFT or SCHEDULED, and returns 204 with no body. The sandbox test table shows a simulated success as 200, so accept any 2xx. | GH-INV, DS-INV invoices.delete, Docs `/invoicing/test-go-live` | Verified |
| The error for deleting a sent invoice is not documented. Delete lists only 400, 403, 404 and 500. | GH-INV, DS-INV invoices.delete | Unverified |
| After delete the invoice can no longer be shown. GET then returns 404 with `name` RESOURCE_NOT_FOUND in the DS-INV example and the sandbox sample, while the Invoicing errors page calls it NOT_FOUND. Key off the 404 status, not the name. | GH-INV invoices.delete, DS-INV invoices.get 404 example, Docs `/invoicing/test-go-live`, `/invoicing/errors` | Verified for 404. The name differs between pages |
| Sending an already-sent invoice is described as having no effect, simulated in sandbox as CANT_SEND_ALREADY_SENT_INVOICE, and listed on the errors page as 409 CONFLICT. | GH-INV invoices.send, Docs `/invoicing/test-go-live`, `/invoicing/errors` | Docs conflict |
| The 16 statuses are DRAFT, SENT, SCHEDULED, PAID, MARKED_AS_PAID, CANCELLED, REFUNDED, PARTIALLY_PAID, PARTIALLY_REFUNDED, MARKED_AS_REFUNDED, UNPAID, PAYMENT_PENDING, AUTO_CANCELLED, PAID_EXTERNAL, REFUNDED_EXTERNAL and SHARED. | GH-INV `invoice_status` | Verified |

```json
{
  "detail": {
    "currency_code": "USD",
    "note": "Thank you for your gift to Sunny Hollow Pantry."
  },
  "invoicer": {"business_name": "Sunny Hollow Pantry"},
  "primary_recipients": [
    {"billing_info": {"email_address": "sb-xxxxx@personal.example.com"}}
  ],
  "items": [
    {
      "name": "One-time gift",
      "quantity": "1",
      "unit_amount": {"currency_code": "USD", "value": "50.00"},
      "unit_of_measure": "AMOUNT"
    }
  ]
}
```

## Webhooks

| Claim | Source | Status |
|---|---|---|
| Create is `POST /v1/notifications/webhooks` with `{"url": "https://...", "event_types": [{"name": "INVOICING.INVOICE.PAID"}]}`. `url` is up to 2048 chars, `event_types` up to 500, and `*` means all events. It returns 201 with the webhook, including `id`. | GH-WH, DS-WH webhooks.post | Verified |
| List is `GET /v1/notifications/webhooks`, returning `{"webhooks": [...]}`. `anchor_type` defaults to APPLICATION. | GH-WH webhooks.list, `WebhookList` | Verified |
| Create can fail with WEBHOOK_URL_ALREADY_EXISTS or WEBHOOK_NUMBER_LIMIT_EXCEEDED, at ten webhooks per app. | DS-WH `x-errors`, Docs `/api/rest/webhooks` | Verified |
| `INVOICING.INVOICE.PAID`, `BILLING.SUBSCRIPTION.SUSPENDED`, `BILLING.SUBSCRIPTION.ACTIVATED` and `BILLING.SUBSCRIPTION.CANCELLED` are all current event names. | Docs `/api/rest/webhooks/event-names`, `/subscriptions/webhooks`, `/api/invoicing/webhooks` | Verified |
| INVOICING.INVOICE.PAID fires when an invoice is paid, partially paid, or a payment is made and still pending. | Docs `/api/rest/webhooks/event-names` | Verified |
| Verify is `POST /v1/notifications/verify-webhook-signature` with seven required fields, `auth_algo`, `cert_url`, `transmission_id`, `transmission_sig`, `transmission_time`, `webhook_id` and `webhook_event`. | GH-WH, DS-WH `verify_webhook_signature` | Verified |
| The five headers are `PAYPAL-AUTH-ALGO`, `PAYPAL-CERT-URL`, `PAYPAL-TRANSMISSION-ID`, `PAYPAL-TRANSMISSION-SIG` and `PAYPAL-TRANSMISSION-TIME`. Node hands them over in lower case, such as `paypal-auth-algo`. `auth_algo` is typically `SHA256withRSA`. | GH-WH field descriptions, Docs `/api/rest/webhooks/rest`, `/api/invoicing/webhooks` | Verified |
| `webhook_id` is the id of the registered webhook, not the client id. | Docs `/invoicing/troubleshooting` | Verified |
| The response is 200 with `{"verification_status": "SUCCESS"}` or `"FAILURE"`, the only two values. | GH-WH `verify_webhook_signature_response` | Verified |
| The re-serialization gotcha. PayPal says the posted-back `webhook_event` must match what was received exactly, and that parsing then re-stringifying can fail verification. Its postback example pastes the raw event JSON in place. Yet PayPal's own Invoicing troubleshooting sample posts `webhook_event: JSON.parse(rawBody)`, a re-serialized object, and the Invoicing webhooks page's Node sample hashes `JSON.stringify(body)` with SHA-256, which does not match PayPal's CRC32 method. SPEC's body, built as a string around the raw bytes, follows the safe rule. | Docs `/api/rest/webhooks/rest`, `/invoicing/troubleshooting`, `/api/invoicing/webhooks` | Verified |
| Self-verification is the other method. The signed string is `transmission_id\|transmission_time\|webhook_id\|crc32`, where crc32 is the decimal CRC32 of the raw body. Check `paypal-transmission-sig` (Base64) with SHA-256 against the certificate at `paypal-cert-url`, downloaded once and cached. `node:zlib` has `crc32` on this Mac's Node v26.3.1, so this needs no package if postback misbehaves. | Docs `/api/rest/webhooks/rest`, local `node -e` check | Verified |
| List events is `GET /v1/notifications/webhooks-events` with `page_size` (default 10), `start_time`, `end_time`, `transaction_id` and `event_type`. It returns `{"events": [...], "count": n, "links": [...]}` and cannot filter by invoice. | GH-WH, DS-WH webhooks-events.list, `EventList` | Verified |
| Resend is `POST /v1/notifications/webhooks-events/{event_id}/resend` with an optional body `{"webhook_ids": ["..."]}`, returning 202 with the event. Pending notifications are not resent. | GH-WH, DS-WH webhooks-events.resend | Verified |
| `GET /v1/notifications/webhooks-events/{event_id}` shows one event in full. | GH-WH webhooks-events.get | Verified |
| Simulate is `POST /v1/notifications/simulate-event` with `webhook_id` or `url`, `event_type` and an optional `resource_version`, returning 202. | GH-WH `simulate_event` | Verified |

## Sandbox behavior

| Claim | Source | Status |
|---|---|---|
| Sandbox email never leaves the sandbox. Each message goes to the Notifications page of the sandbox account it was sent to. | Docs `/sandbox-testing/calls` | Verified |
| PayPal makes one default personal and one default business sandbox account, and the default business account holds the API credentials. Personal emails look like `sb-...@personal.example.com`, business ones like `sb-...@business.example.com`. | Docs `/sandbox-testing/accounts` | Verified |
| PayPal sends events only to webhooks of the REST app that did the work. A webhook under another app gets no INVOICING.INVOICE.PAID for these invoices. | Docs `/api/rest/webhooks`, `/invoicing/troubleshooting` | Verified |
| A real sandbox payment of an invoice made by the app fires INVOICING.INVOICE.PAID to that app's webhook. PayPal's troubleshooting names only a wrong app, a slow listener and simulated events as reasons it would not arrive. | Docs `/invoicing/troubleshooting` | Likely |
| The listener must be HTTPS on port 443 and answer 2xx, within 30 seconds per the Invoicing webhooks page. Otherwise PayPal retries up to 25 times over 3 days, then marks the delivery Failed, which can be resent from the dashboard. A sleeping Render service can miss the first try and still get a retry. | Docs `/api/rest/webhooks/rest`, `/api/rest/webhooks`, `/api/invoicing/webhooks` | Verified |
| PayPal disables an endpoint after 100 or more failures in a row. | Docs `/api/invoicing/webhooks` | Verified |
| Delivery is at least once, the same event id can arrive more than once, and events can arrive out of order. | Docs `/api/invoicing/webhooks` | Verified |
| Simulator events belong to no app, never show in the dashboard, cannot be resent, and cannot pass verify-webhook-signature. They self-verify only with the webhook id string `WEBHOOK_ID`. Only real sandbox events can test SPEC's postback path. | Docs `/api/rest/webhooks/simulator`, `/api/rest/webhooks/rest`, `/invoicing/troubleshooting` | Verified |
| No Invoicing rule says the recipient must differ from the invoicer. CANNOT_PAY_SELF exists for payments where payer and payee are one account. The pilot already uses two accounts, the business as invoicer and the personal account as recipient, so keep it that way. | Docs `/api/rest/troubleshooting/rest_cannot_pay_self` | Unverified for invoicing |
| Whether a new sandbox app has Invoicing and Subscriptions turned on by default is not stated. A 403 NOT_AUTHORIZED or PERMISSION_DENIED would mean a missing scope. `seed --check` could print whether the token scope contains `services/invoicing` and `services/subscriptions`, without printing the token. | Docs `/api/rest/responses`, GH specs `security` | Unverified |

## Notes for paypal-mock.js

- Real ids have fixed shapes. A plan id is `P-` plus 24 capitals or digits (26 chars), an invoice id is `INV2-` plus 19 chars such as `INV2-MOCK-0000-0000-0001`, and a subscription id looks like `I-BW452GLLEP1G`. SPEC's `P-MOCK0000001` and `INV2-MOCK-0001` would fail PayPal's patterns if any code ever checks them.
- `sb-maria@personal.example.com` matches the sandbox personal email format.
- Suspend, activate and cancel errors in the mock match PayPal (422, UNPROCESSABLE_ENTITY, SUBSCRIPTION_STATUS_INVALID). The invoice send and delete errors do not have a documented PayPal match, see correction 3.

## Open questions

- When the first $25 is charged after approval, and what `billing_info.last_payment` and `next_billing_time` show right after. Watch it on Nov 3.
- Whether a GET right after approval reads ACTIVE or APPROVED for a short while.
- The exact `resource` shape of a live INVOICING.INVOICE.PAID delivery for v2 invoices, `resource.id` or `resource.invoice.id`, and its `resource_version`.
- Whether an API send with `send_to_recipient: true` reads SENT or UNPAID in the sandbox.
- The HTTP status and error name for deleting a sent invoice and for sending an already-sent one.
- How the sandbox echoes money values, for example whether a plan sent as `"25.00"` comes back as `"25.00"`, `"25.0"` or `"25"`.
- Whether a new sandbox REST app's token carries the invoicing and subscriptions scopes without extra dashboard steps.
- Whether PayPal ignores `PayPal-Request-Id` on endpoints that do not declare it. The docs only say to check each API.
- Whether `Paypal-Debug-Id` comes back on every response, including 204s and the token call.
- Whether the deprecated `application_context` keeps working, since DS-SUB shows no replacement for the PayPal approval flow.
- Whether PayPal accepts an `http://localhost` return URL for local seeding. PayPal's own sample uses a plain `http://` URL on a public host.
- The Devpost hackathon forum returned 403, so it was not checked.
