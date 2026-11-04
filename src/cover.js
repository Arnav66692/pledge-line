// Covered Month (PICK.md): the staff rule and the money checks, shared by the line and the grader so they can't disagree.
// Pure, with no PayPal call and no spoken words.

const DAY_MS = 86400000;
export const YEAR_MS = 365 * DAY_MS;
export const COVER_MONTH = 'cover_month';
// One yes runs these, each with its own one-time token bound to its own target and amount (I1).
export const LEG_CAPTURE = 'cover_capture';
export const LEG_REFUND = 'cover_refund';
export const LEG_UNWIND = 'cover_unwind';
export const COVER_LEGS = Object.freeze([LEG_CAPTURE, LEG_REFUND, LEG_UNWIND]);
// What a hold's authorization status must be for PayPal to take a capture from it.
const OPEN_HOLD = new Set(['CREATED', 'PARTIALLY_CAPTURED']);
export const REFUNDED_STATUSES = Object.freeze(['REFUNDED', 'PARTIALLY_REFUNDED']);
// What a money leg's own answer must say before the next leg runs. A replayed capture PayPal has refunded since never counts.
export const MOVED_STATUSES = Object.freeze(['COMPLETED', 'PENDING']);

export const toCents = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

export const sameMoney = (a, b) => toCents(a) !== null && toCents(a) === toCents(b);

/** What a money leg's token is bound to, beside its kind and target, so no other amount can use it. */
export const moneyBinding = (value, currency) => `${(toCents(value) ?? 0) / 100} ${currency}`;

export const isRefundedStatus = (status) => REFUNDED_STATUSES.includes(status);

/**
 * Why the staff rule turns this charge down, or null when it passes. rule holds maxDollars, windowDays and perYear.
 * Refunds the charge list shows count toward perYear, so PayPal's own record keeps the count across restarts.
 */
export function coverBlock(charge, { rule, nowMs, currency }) {
  if (isRefundedStatus(charge.status)) return 'used';
  if ((charge.refunded_count ?? 0) >= rule.perYear) return 'used';
  if (charge.status !== 'COMPLETED' || charge.amount_currency !== currency) return 'not_ready';
  const at = Date.parse(charge.time);
  if (Number.isNaN(at) || nowMs - at > rule.windowDays * DAY_MS) return 'too_old';
  const cents = toCents(charge.amount_value);
  if (cents === null || cents <= 0 || cents > Math.round(rule.maxDollars * 100)) return 'too_big';
  return null;
}

/**
 * True when PayPal's read of the sponsor's hold can cover this amount. PayPal's read gives the hold's whole amount, not
 * what is left of it, so a hold drawn down too far is caught by PayPal refusing the capture, which runs first.
 */
export function holdCovers(hold, { amountValue, currency, nowMs }) {
  if (!hold || !OPEN_HOLD.has(hold.status) || hold.amount_currency !== currency) return false;
  const cents = toCents(hold.amount_value);
  if (cents === null || cents < toCents(amountValue)) return false;
  const until = Date.parse(hold.expiration_time);
  return Number.isNaN(until) || nowMs < until;
}

// PayPal replays a request with the same PayPal-Request-Id instead of running it twice, so a retried or a double-submitted
// leg moves money once. The id comes from the charge, since one charge is covered at most once.
export const requestIds = Object.freeze({
  capture: (transactionId) => `cover-capture-${transactionId}`,
  refund: (transactionId) => `cover-refund-${transactionId}`,
  unwind: (captureId) => `cover-unwind-${captureId}`,
});
