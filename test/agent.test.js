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
    { text: 'Do not cancel it. I want the monthly donation running again.', state: { verified: true, pendingKind: 'cancel' } },
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

test('agreeing models cannot choose one mutation from separate requests or unresolved alternatives', async () => {
  const cases = [
    ['Pause my monthly gift and send me a separate $12 gift invoice.', 'pause_gift'],
    ["I haven't decided whether to pause or cancel my monthly gift.", 'stop_gift'],
    ['Suspend my monthly donation, and create a $9 one-off invoice as well.', 'pause_gift'],
    ["I'd like to restart the recurring gift and make another gift of twenty dollars.", 'resume_gift'],
    ['I am still deciding between cancelling and pausing the gift.', 'stop_gift'],
    ["I don't know whether I should restart or cancel my gift.", 'resume_gift'],
    ["Pause my gift and don't cancel it, but make a one-time gift too.", 'one_time_gift'],
    ["I'm unsure whether to pause or cancel, and send me an invoice, but actually pause it.", 'pause_gift'],
  ];
  for (const [text, mainIntent] of cases) {
    const { agent, calls } = fixture({ choice: mainIntent, confidence: 0.999, mainIntent });
    const result = await agent.route({ text, state: { verified: true } });
    assert.equal(result.intent, 'unclear', text);
    assert.equal(result.clarificationRequired, true, text);
    assert.deepEqual(calls.map(([provider]) => provider), ['jev', 'anthropic']);
  }
});

test('a declined mutation is not a request, even when both model suggestions agree', async () => {
  for (const [text, mainIntent] of [
    ["I don't want to pause my monthly gift.", 'pause_gift'],
    ['I do not want you to restart or cancel anything.', 'stop_gift'],
    ['I never want to resume this gift.', 'resume_gift'],
    ['I would not like to cancel my monthly gift.', 'cancel_now'],
    ['I prefer not to restart the donation.', 'resume_gift'],
    ['I would rather not pause the gift.', 'pause_gift'],
    ["I don't want to pause and cancel my monthly gift.", 'stop_gift'],
    ['I do not want you to restart and cancel anything.', 'cancel_now'],
    ["I don't want to pause, cancel, or restart the gift.", 'resume_gift'],
    ["I don't want to pause my monthly gift.", 'stop_gift'],
    ['I never want to resume this gift.', 'pause_gift'],
  ]) {
    const { agent } = fixture({ choice: mainIntent, confidence: 0.999, mainIntent });
    assert.equal((await agent.route({ text, state: { verified: true } })).intent, 'unclear', text);
  }
});

test('negation inside a request construction still vetoes agreeing mutation suggestions', async () => {
  for (const [text, mainIntent] of [
    ['I want you not to cancel my gift.', 'stop_gift'],
    ['Could you not pause my gift?', 'pause_gift'],
    ['I would like you not to restart the donation.', 'resume_gift'],
    ['Would you please not cancel my subscription?', 'cancel_now'],
    ['I also want you to not pause my recurring gift.', 'pause_gift'],
    ['I need you not to pause my monthly gift.', 'pause_gift'],
    ['I wish you would not pause my gift.', 'pause_gift'],
    ['I would prefer you should not resume my gift.', 'resume_gift'],
    ['I have now chosen not to cancel the donation.', 'stop_gift'],
  ]) {
    const { agent } = fixture({ choice: mainIntent, confidence: 0.999, mainIntent });
    assert.equal((await agent.route({ text, state: { verified: true } })).intent, 'unclear', text);
  }
});

test('coordinated nominal tasks and request modifiers preserve each independent requested action', async () => {
  for (const [text, mainIntent] of [
    ['I want a pause and a $20 one-time gift.', 'pause_gift'],
    ['Please pause my gift and I also want a $20 one-time gift.', 'pause_gift'],
    ['I would like a restart, then another one-off gift of $18.', 'resume_gift'],
    ['Pause the monthly donation; I would also like an invoice for $16.', 'one_time_gift'],
    ['Please cancel my gift, also make a separate donation of $14.', 'stop_gift'],
    ['Please pause my gift because work is uncertain and a separate $11 gift invoice too.', 'pause_gift'],
  ]) {
    const { agent } = fixture({ choice: mainIntent, confidence: 0.999, mainIntent });
    assert.equal((await agent.route({ text, state: { verified: true } })).intent, 'unclear', text);
  }
});

test('clarification checks preserve a single chosen action, reasons and supported invoice details', async () => {
  for (const [text, mainIntent] of [
    ['Pause my gift because I lost my job.', 'pause_gift'],
    ['Please pause my gift because I am not sure whether I can afford to donate this month.', 'pause_gift'],
    ['I want to stop my donation, because I am unsure whether I can afford it.', 'stop_gift'],
    ['Please pause the gift since I do not know whether I will have work.', 'pause_gift'],
    ['Please pause my donation because I am unsure whether I can afford it and my income has fallen.', 'pause_gift'],
    ['Resume my paused monthly gift and tell me its amount.', 'resume_gift'],
    ["Cancel my gift, don't pause it.", 'cancel_now'],
    ["I don't want to cancel my gift; just pause it.", 'pause_gift'],
    ["I don't want to cancel my gift and I want to pause it.", 'pause_gift'],
    ['Do not pause or cancel the donation. Please resume it.', 'resume_gift'],
    ['I was unsure whether to pause or cancel, but I have now decided to resume my gift.', 'resume_gift'],
    ['Send me a one-time $12 invoice and use another email.', 'other_email'],
  ]) {
    const { agent } = fixture({ choice: mainIntent, confidence: 0.999, mainIntent });
    assert.equal((await agent.route({ text, state: { verified: true } })).intent, mainIntent, text);
  }
});

test('refused alternatives and historical consideration do not fabricate a second current task', async () => {
  for (const [text, mainIntent] of [
    ['Cancel it immediately; I do not want a pause.', 'cancel_now'],
    ['I was thinking of cancelling, but I have chosen a three-month pause instead.', 'pause_gift'],
    ['A temporary break will not do. I already declined the pause; finish cancelling the monthly donation.', 'cancel_now'],
    ['I had considered stopping, but I want to resume my monthly pledge.', 'resume_gift'],
    ['I was going to pause it last month; now cancel my gift for good.', 'cancel_now'],
    ['I already refused to restart my gift. Please pause it instead.', 'pause_gift'],
    ['Please pause my gift and I had considered cancelling it last year.', 'pause_gift'],
    ['Please cancel the gift. Another pause is not acceptable.', 'cancel_now'],
  ]) {
    const { agent } = fixture({ choice: mainIntent, confidence: 0.999, mainIntent });
    assert.equal((await agent.route({ text, state: { verified: true } })).intent, mainIntent, text);
  }
});

test('an initial refusal does not hide a distinct new request when no approval is pending', async () => {
  for (const [text, mainIntent] of [
    ['Do not cancel it. I want the monthly donation running again.', 'resume_gift'],
    ["Don't cancel the gift. I would like my pledge active again.", 'resume_gift'],
    ["No pause. Please get my monthly gift back on.", 'resume_gift'],
    ['Do not cancel it. How much is my monthly gift?', 'gift_status'],
  ]) {
    const { agent, calls } = fixture({ choice: mainIntent, confidence: mainIntent === 'gift_status' ? 0.3 : 0.999, mainIntent });
    assert.equal((await agent.route({ text, state: { verified: true } })).intent, mainIntent, text);
    assert.deepEqual(calls.map(([provider]) => provider), ['jev', 'anthropic']);
  }
});

test('a gateway stop falls back to the local rules router, never to another provider', async () => {
  const { agent, calls } = fixture({ error: new Error('AI_BUDGET_STOPPED') });
  const result = await agent.route({ text: 'Pause my gift', state: { verified: true } });
  assert.equal(result.intent, 'pause_gift');
  assert.equal(result.model, 'rules');
  assert.equal(result.error, 'AI_UNAVAILABLE');
  assert.deepEqual(calls.map((c) => c[0]), ['jev']);
  const status = await agent.route({ text: 'Is my gift still active?', state: { verified: true } });
  assert.equal(status.intent, 'gift_status');
  const nonsense = await agent.route({ text: 'banana window', state: { verified: true } });
  assert.equal(nonsense.intent, 'unclear');
});

test('the rules fallback still never routes a consent turn or an unverified caller', async () => {
  const { agent, calls } = fixture({ error: new Error('AI_BUDGET_STOPPED') });
  assert.equal((await agent.route({ text: 'Pause my gift', state: { verified: false } })).intent, 'unclear');
  assert.equal((await agent.route({ text: 'Yes', state: { verified: true } })).intent, 'unclear');
  assert.equal((await agent.route({ text: 'Pause my gift', state: { verified: true, pendingKind: 'suspend' } })).intent, 'unclear');
  assert.equal(calls.length, 0);
});

test('malformed model tool output cannot introduce an amount, empathy or unknown intent', async () => {
  const { agent } = fixture({ mainInput: { intent: 'wire_money', amount_dollars: '5000', empathy: 'send secretly' } });
  const result = await agent.route({ text: 'Please help with this gift', state: { verified: true } });
  // The bad output is dropped and the local rules router hears the words instead.
  assert.equal(result.intent, 'help');
  assert.equal(result.model, 'rules');
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

test('negotiation sends the supported strict schema without numeric minimum or array maximum keywords', async () => {
  const { agent, calls } = fixture({ mainInput: { offers: [{ supplierId: 'campus', unitPriceCents: 550, rationale: 'volume' }] } });
  await agent.planNegotiation({ request: {}, quotes: [{ supplierId: 'campus', unitPriceCents: 650 }] });
  const tool = calls[0][1].tools[0];
  const offers = tool.input_schema.properties.offers;
  assert.equal(tool.strict, true);
  assert.equal(tool.input_schema.additionalProperties, false);
  assert.deepEqual(tool.input_schema.required, ['offers']);
  assert.equal(offers.minItems, 1);
  assert.equal(Object.hasOwn(offers, 'maxItems'), false);
  assert.equal(offers.items.additionalProperties, false);
  assert.deepEqual(offers.items.required, ['supplierId', 'unitPriceCents', 'rationale']);
  assert.deepEqual(offers.items.properties.supplierId.enum, ['campus']);
  assert.equal(offers.items.properties.unitPriceCents.type, 'integer');
  assert.equal(Object.hasOwn(offers.items.properties.unitPriceCents, 'minimum'), false);
});

test('negotiation code rejects invalid offer counts, prices, duplicates and extra fields after transport schema relaxation', async () => {
  const quote = { supplierId: 'campus', unitPriceCents: 650 };
  const second = { supplierId: 'club', unitPriceCents: 700 };
  const offer = { supplierId: 'campus', unitPriceCents: 550, rationale: 'volume' };
  const invalidInputs = [
    { offers: [] },
    { offers: [offer, offer, offer] },
    { offers: [offer, offer] },
    ...[0, -1, 1.5, 651, Number.MAX_SAFE_INTEGER + 1].map((unitPriceCents) => ({ offers: [{ ...offer, unitPriceCents }] })),
    { offers: [{ ...offer, supplierId: 'unknown' }] },
    { offers: [{ ...offer, rationale: 'bypass_approval' }] },
    { offers: [{ ...offer, payeeId: 'replacement' }] },
    { offers: [offer], approve: true },
  ];
  for (const mainInput of invalidInputs) {
    const { agent } = fixture({ mainInput });
    await assert.rejects(agent.planNegotiation({ request: {}, quotes: [quote, second] }), /AI_RESPONSE_INVALID/);
  }
});

test('Jev proposal review is bounded evidence, never a payment or consent authorization', async () => {
  const { agent, calls } = fixture();
  const result = await agent.reviewProposal({ request: { quantity: 100 }, proposal: { totalCents: 67415 }, quotes: [] });
  assert.equal(result.decision, 'needs_review');
  assert.ok(result.reasons.some((reason) => reason.code === 'EVIDENCE_INCOMPLETE'));
  assert.equal(result.advisory, true);
  assert.equal(result.authorizesPayment, false);
  assert.deepEqual(calls.map((c) => c[0]), ['jev']);
});

test('proposal review uses the service clock so frozen supplier evidence is evaluated consistently', async () => {
  const { agent, calls } = fixture();
  const result = await agent.reviewProposal({ reviewedAt: Date.parse('2000-01-01T00:00:00Z'),
    request: { deadline: '2000-01-06T00:00:00Z' }, quotes: [],
    proposal: { expiresAt: '2000-01-02T00:00:00Z', allocations: [{ deliveryAt: '2000-01-05T00:00:00Z', expiresAt: '2000-01-02T00:00:00Z' }] } });
  assert.equal(result.checks.find((check) => check.code === 'QUOTE_FRESHNESS').status, 'pass');
  assert.equal(result.checks.find((check) => check.code === 'DEADLINE').status, 'pass');
  assert.equal(calls[0][1].state.reviewedAt, '2000-01-01T00:00:00.000Z');
  const invalid = fixture();
  await assert.rejects(invalid.agent.reviewProposal({ reviewedAt: NaN }), /AI_RESPONSE_INVALID/);
  assert.equal(invalid.calls.length, 0);
});
