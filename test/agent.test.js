import test from 'node:test';
import assert from 'node:assert/strict';
import { createMainAgent } from '../src/agent.js';

function fixture({ choice = 'unclear', confidence = 0.3, mainIntent = 'pause_gift', error = null, mainInput = null } = {}) {
  const calls = [];
  const gateway = {
    async jev(input) { calls.push(['jev', input]); if (error) throw error; return { model: 'jev-1.14.0', answers: { intent: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } }, risk: { type: 'choice', choice: 'within_limits', confidence: 0.99, probabilities: { within_limits: 0.99 } } } }; },
    async anthropic(input) { calls.push(['anthropic', input]); return { model: 'claude-sonnet-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: input.tools[0].name, input: mainInput ?? { intent: mainIntent, amount_dollars: 0, empathy: 'none' } }] }; },
  };
  return { agent: createMainAgent({ gateway }), calls };
}

test('unverified, pending consent and acknowledgment turns never reach either API', async () => {
  const { agent, calls } = fixture();
  for (const input of [
    { text: '2468', state: { verified: false } },
    { text: 'yes pause it', state: { verified: true, pendingKind: 'suspend' } },
    { text: 'yes I heard you', state: { verified: true } },
    { text: 'Okay.', state: { verified: true } },
    { text: 'no thank you', state: { verified: true } },
  ]) assert.equal((await agent.route(input)).intent, 'unclear');
  assert.equal(calls.length, 0);
});

test('Jev quick routing requires high-confidence agreement with an allowed read-only rule', async () => {
  const { agent, calls } = fixture({ choice: 'gift_status', confidence: 0.999 });
  const result = await agent.route({ text: 'What is my gift status?', state: { verified: true } });
  assert.equal(result.intent, 'gift_status');
  assert.equal(result.model, 'jev-1.14.0');
  assert.deepEqual(calls.map((c) => c[0]), ['jev']);
});

test('Jev cannot quick-route a mutation and Anthropic remains the main agent', async () => {
  const { agent, calls } = fixture({ choice: 'pause_gift', confidence: 0.999 });
  const result = await agent.route({ text: 'Pause my monthly gift', state: { verified: true } });
  assert.equal(result.intent, 'pause_gift');
  assert.deepEqual(calls.map((c) => c[0]), ['jev', 'anthropic']);
  assert.equal(calls[1][1].tool_choice.type, 'auto');
  assert.match(calls[1][1].system, /cannot approve or perform anything/);
});

test('conflicting confident mutation suggestions ask again instead of choosing a write', async () => {
  const { agent } = fixture({ choice: 'resume_gift', confidence: 0.999, mainIntent: 'pause_gift' });
  assert.equal((await agent.route({ text: 'Change my gift', state: { verified: true } })).intent, 'unclear');
});

test('any gateway stop returns unclear without an alternate provider or fallback', async () => {
  const { agent, calls } = fixture({ error: new Error('AI_BUDGET_STOPPED') });
  const result = await agent.route({ text: 'Pause my gift', state: { verified: true } });
  assert.equal(result.intent, 'unclear');
  assert.equal(result.error, 'AI_UNAVAILABLE');
  assert.deepEqual(calls.map((c) => c[0]), ['jev']);
});

test('malformed model tool output cannot introduce an amount, empathy or unknown intent', async () => {
  const { agent } = fixture({ mainInput: { intent: 'wire_money', amount_dollars: '5000', empathy: 'send secretly' } });
  const result = await agent.route({ text: 'Please help with this gift', state: { verified: true } });
  assert.equal(result.intent, 'unclear');
  assert.equal(result.amountDollars, 0);
  assert.equal(result.empathy, 'none');
});

test('negotiation offers are constrained to known suppliers and lower integer unit prices', async () => {
  const { agent } = fixture({ mainInput: { offers: [{ supplierId: 'campus', unitPriceCents: 550, rationale: 'volume' }] } });
  const quotes = [{ supplierId: 'campus', unitPriceCents: 650, maxQuantity: 60 }];
  assert.deepEqual(await agent.planNegotiation({ request: { quantity: 100, budgetCents: 80000 }, quotes }), [{ supplierId: 'campus', unitPriceCents: 550, rationale: 'volume' }]);
  const bad = fixture({ mainInput: { offers: [{ supplierId: 'attacker', unitPriceCents: 1, rationale: 'volume' }] } });
  await assert.rejects(bad.agent.planNegotiation({ request: {}, quotes }), /AI_RESPONSE_INVALID/);
});

test('Jev proposal review is bounded evidence, never a payment or consent authorization', async () => {
  const { agent, calls } = fixture();
  const result = await agent.reviewProposal({ request: { quantity: 100 }, proposal: { totalCents: 67415 }, quotes: [] });
  assert.equal(result.decision, 'within_limits');
  assert.equal(result.advisory, true);
  assert.equal(result.authorizesPayment, false);
  assert.deepEqual(calls.map((c) => c[0]), ['jev']);
});
