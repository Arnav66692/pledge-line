import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runAiSmoke } from '../scripts/ai-smoke.js';

function fixture({ stopped = false } = {}) {
  const calls = [];
  const records = [];
  const budget = {
    async status() { return { stopped, accounts: {}, providerBalanceVerified: false }; },
    async reserve(input) { records.push(input); return { ...input, allowed: !stopped, stopped }; },
    async checkDispatch() { return { allowed: !stopped, stopped }; },
    async settle(input) { records.push(input); return { settled: true, stopped }; },
    async trip() { stopped = true; },
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ model: 'claude-haiku-5-5', usage: { input_tokens: 18, output_tokens: 2 }, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { budget, fetchImpl, calls, records };
}

test('smoke invokes one capped Haiku request and never claims a verified credit pool or prepaid setting', async () => {
  const f = fixture();
  const report = await runAiSmoke({ budget: f.budget, anthropicApiKey: 'test-api-key', jevApiKey: 'test-jev-key', fetchImpl: f.fetchImpl });
  assert.equal(f.calls.length, 1);
  assert.equal(report.pass, true);
  assert.equal(report.model, 'claude-haiku-5-5');
  assert.equal(report.estimatedChargeUsd, (18 * 100 + 2 * 500) / 1e9);
  assert.ok(report.conservativeReservationUsd < 0.01);
  assert.equal(report.authorizedMaximumUsd, 0.01);
  assert.equal(report.apiKeyOnly, true);
  assert.equal(report.subscriptionSessionUsed, false);
  assert.equal(report.providerBalanceVerified, false);
  assert.equal(report.fundingSourceVerified, false);
  assert.equal(report.prepaidOnlyAttested, false);
  assert.equal(JSON.stringify(report).includes('test-api-key'), false);
  assert.equal(JSON.stringify(report).includes('test-jev-key'), false);
});

test('both explicit keys and an unstopped shared budget are required before a paid probe', async () => {
  for (const settings of [{ anthropicApiKey: '', jevApiKey: 'test-jev-key' }, { anthropicApiKey: 'test-api-key', jevApiKey: '' }]) {
    const f = fixture();
    await assert.rejects(runAiSmoke({ budget: f.budget, fetchImpl: f.fetchImpl, ...settings }), /AI_API_KEYS_REQUIRED/);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture({ stopped: true });
  await assert.rejects(runAiSmoke({ budget: f.budget, anthropicApiKey: 'test-api-key', jevApiKey: 'test-jev-key', fetchImpl: f.fetchImpl }), /AI_STOPPED/);
  assert.equal(f.calls.length, 0);
});

test('the smoke CLI without explicit run cannot contact services or reveal environment credentials', () => {
  const result = spawnSync(process.execPath, ['scripts/ai-smoke.js'], { cwd: new URL('../', import.meta.url), encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: 'synthetic-secret-do-not-print', DATABASE_URL: 'postgres://secret-user:secret-pass@invalid.local/db' } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--run/);
  assert.equal((result.stdout + result.stderr).includes('synthetic-secret-do-not-print'), false);
  assert.equal((result.stdout + result.stderr).includes('secret-pass'), false);
});
