// Maps PayPal Subscriptions v1 responses onto the generic reads and writes that verify() and receipt() take.
// Nothing here calls PayPal. The caller passes in the HTTP status and parsed body it already has.
//
// Fields assumed from PayPal's public Subscriptions v1 documentation. None was checked against a live response here.
//   GET /v1/billing/subscriptions/{id} body:
//     id                                   the subscription id, used as the read's object id and reference
//     status                               ACTIVE, SUSPENDED, CANCELLED, and the other enum values lowercased
//     plan_id                              kept as a plain value on the read
//     billing_info.next_billing_time       ISO time, kept as its date for a "date" fact
//     billing_info.last_payment.amount     { value, currency_code }, kept as the read's amount
//   POST /v1/billing/subscriptions/{id}/suspend, /activate and /cancel:
//     a 2xx status (204 No Content on success) is an ok write
//     an error body carries name and debug_id
// Not mapped: subscriber details, plan pricing (a separate plan read), and failed payment counts.

const ACTIONS = Object.freeze({ suspend: 'suspend', activate: 'activate', cancel: 'cancel' });
const lower = (value) => String(value ?? '').trim().toLowerCase();

/**
 * A subscription read as a generic read. A null body, as when PayPal returned nothing, gives a read with no values,
 * so every fact about it is unbacked.
 */
export function subscriptionRead(body, { turn, at = null, subscriptionId }) {
  const values = {};
  if (body?.status) values.status = lower(body.status);
  if (body?.id) values.reference = String(body.id);
  if (body?.plan_id) values.plan_id = String(body.plan_id);
  const payment = body?.billing_info?.last_payment?.amount;
  if (payment) values.amount = { value: String(payment.value), currency: String(payment.currency_code) };
  const next = body?.billing_info?.next_billing_time;
  if (next) values.date = String(next).slice(0, 10);
  return { turn, at, object: { type: 'subscription', id: String(body?.id ?? subscriptionId) }, values };
}

/**
 * A subscription write as a generic write. PayPal's 2xx answers are ok. Anything else is not ok, and the error name
 * is kept. The write does not say whether a failure was a refusal or an unclear answer, so the caller can check httpStatus.
 */
export function subscriptionWrite(action, { turn, at = null, subscriptionId, httpStatus, body = null }) {
  if (!Object.hasOwn(ACTIONS, action)) throw new TypeError(`unknown PayPal subscription action "${action}"`);
  const ok = Number.isInteger(httpStatus) && httpStatus >= 200 && httpStatus < 300;
  return {
    turn,
    at,
    action: ACTIONS[action],
    subject: subscriptionId,
    reference: subscriptionId,
    ok,
    httpStatus,
    error: ok ? null : String(body?.name ?? 'UNKNOWN_ERROR'),
    debugId: body?.debug_id ?? null,
  };
}
