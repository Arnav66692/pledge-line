// The staff refund desk for the charge check (PICK.md). The line never refunds a charge or writes to PayPal for one.
// A yes only logs a refund_request for staff, and it needs the gate's one-time token like every other write (I1).
import { WriteNotAuthorized } from './paypal.js';

export const REFUND_REQUEST = 'refund_request';

/**
 * request(subscriptionId, token, ctx) consumes the token minted for this call's yes, then logs which charge the donor
 * wants staff to look at. ctx.charge is the charge snapshot the proposal read aloud, so the request names that charge
 * and no later one. The return shape matches a PayPal write's, so gate.execute logs it as one.
 */
export function createRefundDesk({ ledger, tokens }) {
  function request(subscriptionId, token, { callId, turn, charge } = {}) {
    if (!tokens || typeof tokens.consume !== 'function') throw new WriteNotAuthorized('no_token_store');
    tokens.consume(token, { kind: REFUND_REQUEST, targetId: subscriptionId, callId });
    if (!charge?.transaction_id) throw new WriteNotAuthorized('no_charge');
    const started = performance.now();
    ledger.append({
      type: REFUND_REQUEST, callId, turn, subscriptionId, transactionId: charge.transaction_id,
      amountValue: charge.amount_value ?? null, amountCurrency: charge.amount_currency ?? null, chargeTime: charge.time ?? null,
    });
    return { debugId: null, ms: Math.round(performance.now() - started) };
  }
  return { request };
}
