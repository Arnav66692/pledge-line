// A support bot for one gift. It answers "is my gift paused?" and "pause it" from PayPal reads and writes,
// then prints each reply with its receipt. It runs in memory against a fake PayPal.
import { receipt } from 'pledge-proof';
import { subscriptionRead, subscriptionWrite } from 'pledge-proof/paypal';
import { FakePayPal } from './fake-paypal.js';

const GIFT = 'I-GIFT0001';
const paypal = new FakePayPal({
  [GIFT]: { id: GIFT, status: 'ACTIVE', plan_id: 'P-MONTHLY-25', billing_info: { next_billing_time: '2026-12-01T08:00:00Z', last_payment: { amount: { value: '25.00', currency_code: 'USD' } } } },
});
const STATUS_WORDS = { active: 'active', suspended: 'paused' };
const reads = [];
const writes = [];
const sentences = [];
let tick = 0;
const stamp = () => `2026-11-07T17:${String((tick += 1)).padStart(2, '0')}:00Z`;

async function readGift(turn) {
  const { body } = await paypal.get(GIFT);
  reads.push(subscriptionRead(body, { turn, at: stamp(), subscriptionId: GIFT }));
  return reads.at(-1).values.status;
}

// Turn 1: "is my gift paused?"
const before = await readGift(1);
sentences.push({ turn: 1, text: `Your gift is ${STATUS_WORDS[before]}.`, facts: [{ kind: 'status', value: before, subject: GIFT }] });

// Turn 2: "pause it"
const res = await paypal.suspend(GIFT);
writes.push(subscriptionWrite('suspend', { turn: 2, at: stamp(), subscriptionId: GIFT, httpStatus: res.httpStatus, body: res.body }));
const after = await readGift(2);
if (writes.at(-1).ok) sentences.push({ turn: 2, text: 'I paused it.', facts: [{ kind: 'action', value: 'suspend', subject: GIFT }] });
else sentences.push({ turn: 2, text: 'PayPal did not pause it.' });
sentences.push({ turn: 2, text: `Your gift is ${STATUS_WORDS[after]}.`, facts: [{ kind: 'status', value: after, subject: GIFT }] });

for (const r of receipt({ sentences, reads, writes })) {
  console.log(`turn ${r.turn}  ${r.verdict.padEnd(9)} "${r.text}"`);
  for (const f of r.facts) {
    const by = f.backing ? `${f.backing.source} at ${f.backing.at}, reference ${f.backing.reference}` : `not backed: ${f.reason}`;
    console.log(`    ${f.kind} ${f.value} -> ${by}`);
  }
}
