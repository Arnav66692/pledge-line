// Faults staged once per call on the mock PayPal, so a person can see how the line recovers and film it. loadConfig
// refuses FAULT_DRILL unless PAYPAL_MODE is mock, and call_start logs the drill, so the page labels every such call.
import { PayPalError } from './paypal.js';

/** A suspend that takes its token, then fails the way the drill says, once per call. */
function failingSuspend(paypal, tokens, fail) {
  const fired = new Set();
  return async (id, token, ctx) => {
    const callId = ctx?.callId;
    // Outside an identified call, never silently consume another call's staged fault.
    if (!callId || fired.has(callId)) return paypal.suspendSubscription(id, token, ctx);
    // Mark before awaiting so concurrent requests from the same call cannot fire twice.
    fired.add(callId);
    return fail(id, token, ctx);
  };
}

const DRILLS = Object.freeze({
  // PayPal makes the change, then its answer never comes, as the line's 10 s timeout would see it.
  'suspend-timeout': (paypal, tokens) => ({
    suspendSubscription: failingSuspend(paypal, tokens, async (id, token, ctx) => {
      await paypal.suspendSubscription(id, token, ctx);
      throw new PayPalError({ status: 0, name: 'TIMEOUT', message: 'PayPal did not answer in time', debugId: null });
    }),
  }),
  'suspend-503': (paypal, tokens) => ({
    suspendSubscription: failingSuspend(paypal, tokens, async (id, token, ctx) => {
      tokens.consume(token, { kind: 'suspend', targetId: id, callId: ctx?.callId });
      throw new PayPalError({ status: 503, name: 'SERVICE_UNAVAILABLE', message: 'Service unavailable', debugId: 'mock-drill-503' });
    }),
  }),
  'suspend-refused': (paypal, tokens) => ({
    suspendSubscription: failingSuspend(paypal, tokens, async (id, token, ctx) => {
      tokens.consume(token, { kind: 'suspend', targetId: id, callId: ctx?.callId });
      throw new PayPalError({ status: 422, name: 'UNPROCESSABLE_ENTITY', message: 'The requested action could not be performed.', debugId: 'mock-drill-422' });
    }),
  }),
  // Someone else cancels the gift between the line's first read and its next one.
  'gift-changed': (paypal) => {
    const reads = new Map();
    return {
      getSubscription: async (id, ctx) => {
        const callId = ctx?.callId;
        const count = callId ? (reads.get(callId) ?? 0) + 1 : 0;
        if (callId) reads.set(callId, count);
        if (count === 2) paypal.mockSetSubscriptionStatus(id, 'CANCELLED');
        return paypal.getSubscription(id);
      },
    };
  },
});

/** The mock with the named drill staged on it, or the mock as it was when none is named. */
export function applyFaultDrill(paypal, name, tokens) {
  if (!name) return paypal;
  if (paypal.mode !== 'mock') throw new Error('A fault drill runs only on the mock PayPal.');
  return { ...paypal, ...DRILLS[name](paypal, tokens) };
}
