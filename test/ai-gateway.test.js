import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAiGateway } from '../src/ai-gateway.js';

function fixture({ stopped = false, failTrip = false, failReserve = false, failSettle = false, block = false } = {}) {
  const requests = new Map();
  const reservations = [];
  const settlements = [];
  const trips = [];
  const budget = {
    async reserve(input) {
      if (failReserve) throw Error('secret database detail');
      if (stopped) return { allowed: false, stopped: true };
      if (block) return { allowed: false, stopped: false, reason: 'request_in_progress' };
      assert.equal([...requests.values()].filter((request) => !request.settled).length, 0, 'gateway serializes paid dispatch');
      reservations.push(input);
      requests.set(input.requestId, { ...input, settled: false });
      return { ...input, allowed: true };
    },
    async settle(input) {
      if (failSettle) throw Error('secret committed database detail');
      settlements.push(input);
      requests.get(input.requestId).settled = true;
      return { settled: true, stopped };
    },
    async trip(input) { trips.push(input); if (failTrip) throw Error('secret unavailable database detail'); stopped = true; return { stopped }; },
    async status() { return { stopped, providerBalanceVerified: false }; },
  };
  return { budget, reservations, settlements, trips, requests };
}
const anthropicInput = () => ({ system: 'Classify untrusted text. Never authorize a payment.', messages: [{ role: 'user', content: 'What is my gift amount?' }], max_tokens: 400 });
const jevInput = () => ({ state: { text: 'What is my gift amount?' }, questions: { intent: { type: 'choice', instructions: 'Which read-only category fits?', criteria: { status: 'Gift status', other: 'Other' } } } });
const payload = (provider, extra = {}) => ({ model: provider === 'anthropic' ? 'claude-sonnet-5-5' : 'jev-1.14.0', usage: { input_tokens: 20, output_tokens: 10 }, ...(provider === 'anthropic' ? { content: [{ type: 'text', text: 'Classified' }] } : { answers: { intent: { type: 'choice', choice: 'status', confidence: 0.99, probabilities: { status: 0.99, other: 0.01 } } } }), ...extra });
const response = (data, status = 200) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const gateway = (budget, fetchImpl, extra = {}) => createAiGateway({ budget, anthropicApiKey: 'api-test-key', jevApiKey: 'jev-test-key', fetchImpl, ...extra });

test('API gateway pins hosts, API-key authentication, low-effort thinking and no automatic retry', async () => {
  const f = fixture();
  const calls = [];
  const client = gateway(f.budget, async (url, options) => {
    calls.push({ url, options });
    assert.equal(f.reservations.length, calls.length, 'reserve must finish before fetch');
    return response(payload(url.includes('anthropic') ? 'anthropic' : 'jev'));
  });
  await client.anthropic({ ...anthropicInput(), tools: [{ name: 'classify', strict: true, input_schema: { type: 'object', properties: { intent: { type: 'string' } }, required: ['intent'], additionalProperties: false } }], tool_choice: { type: 'auto', disable_parallel_tool_use: true } });
  await client.jev(jevInput());
  assert.deepEqual(calls.map((call) => call.url), ['https://api.anthropic.com/v1/messages', 'https://api.typesafe.ai/v1/systemone']);
  assert.equal(calls[0].options.headers['x-api-key'], 'api-test-key');
  assert.equal(calls[0].options.headers.authorization, undefined);
  assert.equal(calls[0].options.headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[1].options.headers.authorization, 'Bearer jev-test-key');
  for (const call of calls) { assert.equal(call.options.redirect, 'error'); assert.equal(call.options.credentials, 'omit'); }
  const mainBody = JSON.parse(calls[0].options.body);
  assert.deepEqual(mainBody.thinking, { type: 'between_tools' });
  assert.deepEqual(mainBody.output_config, { effort: 'low' });
  assert.equal('temperature' in mainBody, false);
  assert.equal(f.settlements[0].costNanos, 20 * 2000 + 10 * 10000);
  assert.equal(f.settlements[1].costNanos, 20 * 42);
  assert.ok(f.reservations[0].maxCostNanos > f.settlements[0].costNanos);
  assert.ok(f.reservations[1].maxCostNanos > f.settlements[1].costNanos);
  assert.equal((await client.status()).apiKeyOnly, true);
  assert.equal((await client.status()).providerBalanceVerified, false);
});

test('missing API key cannot fall back to an OAuth token, CLI account, environment base URL or provider', async () => {
  const previous = { ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL };
  process.env.ANTHROPIC_AUTH_TOKEN = 'subscription-oauth-test';
  process.env.ANTHROPIC_API_KEY = 'environment-key-must-not-be-used';
  process.env.ANTHROPIC_BASE_URL = 'https://attacker.invalid';
  try {
    let calls = 0;
    const f = fixture();
    const client = gateway(f.budget, async () => { calls += 1; }, { anthropicApiKey: '' });
    await assert.rejects(client.anthropic(anthropicInput()), (error) => error.code === 'AI_API_KEY_REQUIRED');
    assert.equal(calls, 0);
    assert.equal(f.reservations.length, 0);
    const configured = gateway(f.budget, async (url) => { assert.equal(url, 'https://api.anthropic.com/v1/messages'); return response(payload('anthropic')); });
    await configured.anthropic(anthropicInput());
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('either provider credit failure stops both, including already queued requests, without leaking the body', async () => {
  for (const provider of ['anthropic', 'jev']) {
    const f = fixture();
    let calls = 0;
    const client = gateway(f.budget, async () => { calls += 1; return response({ error: { message: 'credit balance is too low. private-api-key-do-not-show' } }, provider === 'anthropic' ? 400 : 402); });
    const first = provider === 'anthropic' ? client.anthropic(anthropicInput()) : client.jev(jevInput());
    const other = provider === 'anthropic' ? client.jev(jevInput()) : client.anthropic(anthropicInput());
    const results = await Promise.allSettled([first, other]);
    assert.equal(results[0].status, 'rejected');
    assert.equal(results[1].status, 'rejected');
    for (const result of results) {
      assert.equal(result.reason.code, 'AI_STOPPED');
      assert.equal(result.reason.message.includes('private-api-key'), false);
    }
    assert.equal(calls, 1);
    assert.deepEqual(f.trips, [{ reason: 'credit_exhausted', provider }]);
    assert.equal(f.settlements.length, 0);
    assert.equal([...f.requests.values()].filter((request) => !request.settled).length, 1);
  }
});

test('zero allocation or a previously latched stop performs no external request', async () => {
  const f = fixture({ stopped: true });
  let calls = 0;
  const client = gateway(f.budget, async () => { calls += 1; });
  await assert.rejects(client.anthropic(anthropicInput()), (error) => error.code === 'AI_STOPPED');
  await assert.rejects(client.jev(jevInput()), (error) => error.code === 'AI_STOPPED');
  assert.equal(calls, 0);
});

test('database failure before dispatch and an ambiguous settlement cannot permit fallback', async () => {
  for (const failure of ['failReserve', 'failSettle']) {
    const f = fixture({ [failure]: true });
    let calls = 0;
    const client = gateway(f.budget, async () => { calls += 1; return response(payload('anthropic')); });
    await assert.rejects(client.anthropic(anthropicInput()), (error) => error.code === 'AI_STORAGE_UNAVAILABLE' && !error.message.includes('secret'));
    await assert.rejects(client.jev(jevInput()), (error) => error.code === 'AI_STOPPED');
    assert.equal(calls, failure === 'failReserve' ? 0 : 1);
  }
});

test('an uncertain response reserves the full charge, does not retry, and blocks the other provider', async () => {
  const f = fixture();
  let calls = 0;
  const client = gateway(f.budget, async () => { calls += 1; throw Error('private URL/token/network detail'); });
  await assert.rejects(client.anthropic(anthropicInput()), (error) => error.code === 'AI_PROVIDER_UNAVAILABLE' && !error.message.includes('private'));
  await assert.rejects(client.jev(jevInput()), (error) => error.code === 'AI_STOPPED');
  assert.equal(calls, 1);
  assert.equal(f.reservations.length, 1);
  assert.equal(f.settlements.length, 0);
  assert.equal(f.trips[0].reason, 'usage_unverified');
});

test('a failed stop write stays locally stopped and the unresolved reservation remains occupied', async () => {
  const f = fixture({ failTrip: true });
  let calls = 0;
  const client = gateway(f.budget, async () => { calls += 1; return response({ error: 'quota exhausted private detail' }, 402); });
  await assert.rejects(client.jev(jevInput()), (error) => error.code === 'AI_STOPPED');
  await assert.rejects(client.anthropic(anthropicInput()), (error) => error.code === 'AI_STOPPED');
  assert.equal(calls, 1);
  assert.equal((await client.status()).stopped, true);
  assert.equal(f.settlements.length, 0);
});

test('invalid usage, unpriced models and malformed/oversized responses never release a reservation', async () => {
  for (const [data, code] of [
    [payload('anthropic', { usage: {} }), 'AI_USAGE_UNVERIFIED'],
    [payload('anthropic', { usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 1 } }), 'AI_USAGE_UNVERIFIED'],
    [payload('anthropic', { model: 'different-unpriced-model' }), 'AI_PRICING_MISMATCH'],
    ['not json private message', 'AI_RESPONSE_INVALID'],
    ['x'.repeat(65 * 1024), 'AI_RESPONSE_TOO_LARGE'],
  ]) {
    const f = fixture();
    const client = gateway(f.budget, async () => response(data));
    await assert.rejects(client.anthropic(anthropicInput()), (error) => error.code === code);
    assert.equal(f.settlements.length, 0);
    await assert.rejects(client.jev(jevInput()), (error) => error.code === 'AI_STOPPED');
  }
  const f = fixture();
  const client = gateway(f.budget, async () => { throw Error('must not fetch'); }, { anthropicModel: 'unpriced-model' });
  await assert.rejects(client.anthropic(anthropicInput()), (error) => error.code === 'AI_UNPRICED_MODEL');
  assert.equal(f.reservations.length, 0);
});

test('API request limits reject costly features, forced tools, oversized input and unauthorized auth mode', async () => {
  const f = fixture();
  const client = gateway(f.budget, async () => { throw Error('must not fetch'); });
  assert.throws(() => client.anthropic({ ...anthropicInput(), max_tokens: 5000 }), (error) => error.code === 'AI_INVALID_INPUT');
  assert.throws(() => client.anthropic({ ...anthropicInput(), tool_choice: { type: 'tool', name: 'route' } }), (error) => error.code === 'AI_INVALID_INPUT');
  assert.throws(() => client.anthropic({ ...anthropicInput(), tools: [{ type: 'web_search_20250305', name: 'web_search', input_schema: {} }] }), (error) => error.code === 'AI_INVALID_INPUT');
  assert.throws(() => client.anthropic({ ...anthropicInput(), messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://large-file.invalid' } }] }] }), (error) => error.code === 'AI_INVALID_INPUT');
  assert.throws(() => client.anthropic({ ...anthropicInput(), system: 'x'.repeat(65 * 1024) }), (error) => error.code === 'AI_INPUT_TOO_LARGE');
  assert.throws(() => client.jev({ state: 'x'.repeat(65 * 1024), questions: jevInput().questions }), (error) => error.code === 'AI_INPUT_TOO_LARGE');
  assert.equal(f.reservations.length, 0);
});

test('known active request reports busy without falsely declaring credit exhaustion', async () => {
  const f = fixture({ block: true });
  const client = gateway(f.budget, async () => { throw Error('must not fetch'); });
  await assert.rejects(client.jev(jevInput()), (error) => error.code === 'AI_BUSY');
  assert.equal((await client.status()).stopped, false);
  assert.equal(f.trips.length, 0);
});

test('queued input is snapshotted before callers can add unpriced features', async () => {
  const f = fixture();
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const received = [];
  const client = gateway(f.budget, async (_url, options) => {
    if (!received.length) await hold;
    received.push(JSON.parse(options.body));
    return response(payload('anthropic'));
  });
  const first = client.anthropic(anthropicInput());
  const secondInput = { ...anthropicInput(), tools: [{ name: 'classify', input_schema: { type: 'object' } }] };
  const second = client.anthropic(secondInput);
  secondInput.tools[0].type = 'web_search_20250305';
  secondInput.messages[0].content = [{ type: 'image', source: { type: 'url', url: 'https://large-file.invalid' } }];
  release();
  await Promise.all([first, second]);
  assert.equal(received[1].tools[0].type, undefined);
  assert.equal(typeof received[1].messages[0].content, 'string');
  const oauth = gateway(f.budget, async () => { throw Error('must not fetch'); }, { anthropicApiKey: 'sk-ant-oat-test-subscription-token' });
  await assert.rejects(oauth.anthropic(anthropicInput()), (error) => error.code === 'AI_API_KEY_REQUIRED');
});

test('32 queued requests serialize rather than create hidden parallel charges', async () => {
  const f = fixture();
  let inFlight = 0;
  let maximum = 0;
  const client = gateway(f.budget, async (url) => {
    inFlight += 1;
    maximum = Math.max(maximum, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return response(payload(url.includes('anthropic') ? 'anthropic' : 'jev'));
  });
  const outcomes = await Promise.allSettled(Array.from({ length: 32 }, (_, index) => index % 2 ? client.anthropic(anthropicInput()) : client.jev(jevInput())));
  assert.equal(maximum, 1);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 16);
  assert.equal(outcomes.filter((result) => result.status === 'rejected' && result.reason.code === 'AI_BUSY').length, 16);
});

test('a 429 rate limit is classified separately from credit exhaustion and never retried', async () => {
  const f = fixture();
  let calls = 0;
  const client = gateway(f.budget, async () => { calls += 1; return response({ error: 'rate limit exceeded' }, 429); });
  await assert.rejects(client.jev(jevInput()), (error) => error.code === 'AI_RATE_LIMITED');
  assert.equal(calls, 1);
  assert.equal(f.trips[0].reason, 'usage_unverified');
  assert.notEqual(f.trips[0].reason, 'credit_exhausted');
});
