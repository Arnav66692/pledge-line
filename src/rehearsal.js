import { loadConfig, MOCK_SUBSCRIPTION_ID } from './config.js';
import { createMockPayPal, mockCharge, MOCK_TRANSACTION_ID } from './paypal-mock.js';
import { PayPalError } from './paypal.js';
import { createTokens, createGate } from './gate.js';
import { createRouter } from './router.js';
import { createCallService } from './call.js';
import { createRefundDesk } from './refund-desk.js';
import { gradeCall } from './check.js';
import { buildReceipts } from './receipt.js';

export const REHEARSAL_CASES = Object.freeze([
  { id: 'covered', title: 'Give this month back', description: 'A sponsor covers an eligible refund. The monthly gift stays active.' },
  { id: 'no_consent', title: 'A request is not consent', description: 'The donor asks for relief but has not agreed to the exact offer.' },
  { id: 'changed_charge', title: 'Change the charge after the offer', description: 'The amount changes before the donor says yes. The old approval cannot move it.' },
  { id: 'sponsor_declined', title: 'The sponsor payment is refused', description: 'The donor refund must not run before confirmed sponsor funding.' },
  { id: 'refund_lost', title: 'Lose the refund response', description: 'The refund completes, but its response is lost. A read of the same charge establishes the result.' },
  { id: 'refund_unknown', title: 'Leave the refund uncertain', description: 'Neither the response nor a fresh read establishes a refund. The line must leave it unresolved.' },
]);

// An isolated, disposable simulation. Never accepts runtime dependencies or reads process.env.
// It runs the production call/gate/checker modules, with a rules router and mock adapter only.
export async function runRehearsal(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some((key) => !['scenario', 'amountCents'].includes(key)) ||
    !REHEARSAL_CASES.some((item) => item.id === input.scenario) ||
    !Number.isSafeInteger(input.amountCents) || input.amountCents < 100 || input.amountCents > 5000) {
    throw Object.assign(new Error('Choose a rehearsal and a whole-cent amount from $1 to $50.'), { status: 400 });
  }
  let tick = Date.parse('2026-11-03T18:00:00Z');
  const now = () => new Date(tick);
  const config = loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules', PILOT_PIN: '482613', ORG_NAME: 'Sunny Hollow Pantry' });
  const events = [];
  const ledger = {
    append(event) { const full = structuredClone({ ...event, ts: now().toISOString(), seq: events.length + 1 }); events.push(full); return structuredClone(full); },
    byCall: (id) => structuredClone(events.filter((event) => event.callId === id)),
    byType: (type) => structuredClone(events.filter((event) => event.type === type)),
    all: () => structuredClone(events),
  };
  const tokens = createTokens({ now, ttlMs: config.limits.tokenTtlMs });
  const paypal = createMockPayPal({ tokens, now });
  const value = (input.amountCents / 100).toFixed(2);
  const charge = (amount = value) => mockCharge({ value: amount, time: '2026-11-01T10:00:00.000Z' });
  paypal.mockSetCharges(MOCK_SUBSCRIPTION_ID, [charge()]);
  const gate = createGate({ ledger, tokens, now, pendingTtlMs: config.limits.pendingTtlMs });
  const calls = createCallService({ config, ledger, paypal, router: createRouter({ mode: 'rules' }), gate, now,
    sleep: async () => {}, desk: createRefundDesk({ ledger, tokens }) });
  const { callId } = calls.start({ userAgent: 'isolated-relief-rehearsal' });
  let answering = 0;
  const transcript = [];
  async function turn(text, source = 'typed', include = true) {
    tick += 2000;
    const result = await calls.turn(callId, { text, source, answering });
    answering = result.turn;
    if (include) transcript.push({ donor: text, reply: result.reply, turn: result.turn });
    return result;
  }
  await turn(config.pin, 'keypad', false);
  let result = await turn("I lost my job, I can't do it this month.");
  const proposed = events.find((event) => event.type === 'proposed');
  if (!proposed || proposed.kind !== 'cover_month') throw new Error('Rehearsal could not establish its relief offer.');
  if (input.scenario === 'changed_charge') paypal.mockSetCharges(MOCK_SUBSCRIPTION_ID, [charge(((input.amountCents + 100) / 100).toFixed(2))]);
  if (input.scenario === 'sponsor_declined') paypal.captureSponsorHold = async () => {
    throw new PayPalError({ status: 422, name: 'MAX_CAPTURE_AMOUNT_EXCEEDED', message: 'Simulated refusal' });
  };
  if (input.scenario === 'refund_lost' || input.scenario === 'refund_unknown') {
    const refund = paypal.refundCharge;
    paypal.refundCharge = async (...args) => {
      if (input.scenario === 'refund_lost') await refund(...args);
      throw new PayPalError({ status: 0, name: 'TIMEOUT', message: 'Simulated lost response' });
    };
  }
  if (input.scenario !== 'no_consent') result = await turn('Yes.');
  const writes = events.filter((event) => event.type === 'write');
  const reads = events.filter((event) => event.type === 'read');
  const money = paypal.mockMoney();
  const grade = gradeCall(ledger.byCall(callId), null);
  const problems = [...grade.facts, ...grade.writes, ...grade.safety];
  const receipts = buildReceipts(ledger.byCall(callId), { orgName: config.orgName, subscriptionId: config.demoSubscriptionId });
  const capture = writes.find((event) => event.kind === 'cover_capture' && event.ok);
  const refund = writes.find((event) => event.kind === 'cover_refund');
  const checks = [
    { name: 'Sponsor confirmed before refund attempt', passed: !refund || Boolean(capture && capture.seq < refund.seq) },
    { name: 'Every financial attempt binds the offered amount', passed: writes.every((event) => event.amountValue === value && event.currency === 'USD') },
    { name: 'Fresh exact consent before financial attempts', passed: grade.writes.length === 0 },
    { name: 'Spoken claims agree with the event record', passed: grade.facts.length === 0 },
    { name: 'Core safety checks pass', passed: grade.safety.length === 0 },
  ];
  // Public output is rebuilt from fixed fields. No PIN, session secret, tokens, raw snapshots or real ledger.
  return {
    scenario: input.scenario, amountCents: input.amountCents, mode: 'simulation', router: 'rules', externalCalls: 0,
    virtualTime: true, productionPersistenceExercised: false, passed: checks.every((check) => check.passed) && problems.length === 0,
    outcome: result.state.record.cover?.outcome ?? (input.scenario === 'no_consent' ? 'awaiting_consent' : 'blocked'),
    giftStatus: result.state.record.subscription?.status ?? null,
    money: { sponsorCapturedCents: money.captures.filter((item) => item.status === 'COMPLETED').reduce((sum, item) => sum + Math.round(Number(item.amount.value) * 100), 0),
      donorRefundedCents: money.refunded[MOCK_TRANSACTION_ID] ?? 0, refundUnresolved: input.scenario === 'refund_unknown',
      sponsorFeeCents: money.captures.filter((item) => item.status === 'COMPLETED').reduce((sum, item) => sum + Math.round(Number(item.seller_receivable_breakdown?.paypal_fee?.value ?? 0) * 100), 0) },
    transcript, checks,
    timeline: events.filter((event) => ['proposed', 'yes', 'read', 'write', 'cover_month'].includes(event.type)).map((event) => ({
      seq: event.seq, turn: event.turn, type: event.type, kind: event.kind ?? event.what ?? null,
      status: event.status ?? null, ok: typeof event.ok === 'boolean' ? event.ok : null,
      amount: event.amountValue ?? null, outcome: event.outcome ?? null,
    })),
    sentences: receipts.flatMap((receipt) => receipt.sentences.map((sentence) => ({ text: sentence.text, verdict: sentence.verdict }))),
    readCount: reads.length, financialAttempts: writes.length,
  };
}
