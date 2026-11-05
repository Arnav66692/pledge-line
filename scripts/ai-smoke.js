// One explicitly requested, sub-cent API probe. This does not attest to or change provider billing settings.
// The normal application still requires AI_PREPAID_ONLY_CONFIRMED; this narrow command never sets that flag.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { databaseOptions, inspectDatabaseClient, protectDatabasePool } from '../src/database.js';
import { AI_DEFAULT_LIMITS, createAiBudget } from '../src/ai-budget.js';
import { createAiGateway, AiGatewayError } from '../src/ai-gateway.js';

const fail = (code) => { throw new AiGatewayError(code); };
const keyConfigured = (value) => typeof value === 'string' && value.length > 0 && !/\s/.test(value);

export async function runAiSmoke({ budget, anthropicApiKey, jevApiKey, fetchImpl = globalThis.fetch, prepaidOnlyConfirmed = false } = {}) {
  if (!keyConfigured(anthropicApiKey) || !keyConfigured(jevApiKey)) fail('AI_API_KEYS_REQUIRED');
  const gateway = createAiGateway({ budget, anthropicApiKey, jevApiKey, fetchImpl });
  if ((await gateway.status()).stopped) fail('AI_STOPPED');
  const { response, accounting } = await gateway.anthropicSmoke();
  const state = await gateway.status();
  const text = Array.isArray(response.content) ? response.content.filter((block) => block?.type === 'text').map((block) => block.text).join('').trim() : '';
  return {
    pass: /^OK[.!]?$/.test(text), authenticated: true, model: response.model,
    inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens,
    estimatedChargeUsd: accounting.estimatedChargeNanos / 1_000_000_000,
    conservativeReservationUsd: accounting.reservedMaxNanos / 1_000_000_000,
    authorizedMaximumUsd: accounting.authorizedCapNanos / 1_000_000_000,
    pricingSource: accounting.pricingSource, inferenceRequests: 1,
    apiKeyOnly: true, subscriptionSessionUsed: false, sharedStop: state.stopped,
    prepaidOnlyAttested: prepaidOnlyConfirmed === true,
    providerBalanceVerified: false, fundingSourceVerified: false,
    fundingNote: 'Charged by the API organization associated with this key. A normal API key cannot verify the reported $200 credit pool, subscription-credit linkage, invoicing or auto-reload settings.',
  };
}

function allocation(raw, fallback, maximum) {
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || !/^\d{1,6}(?:\.\d{1,9})?$/.test(raw)) fail('AI_CONFIGURATION_INVALID');
  const [whole, fraction = ''] = raw.split('.');
  const result = Number(BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0')));
  if (!Number.isSafeInteger(result) || result > maximum) fail('AI_CONFIGURATION_INVALID');
  return result;
}

async function main() {
  if (process.argv.slice(2).length !== 1 || process.argv[2] !== '--run') {
    process.stderr.write('Usage: load private API/database settings, then node scripts/ai-smoke.js --run. No request was made.\n');
    process.exitCode = 2;
    return;
  }
  let pool;
  try {
    if (!process.env.DATABASE_URL) fail('AI_DATABASE_REQUIRED');
    if (!keyConfigured(process.env.ANTHROPIC_API_KEY) || !keyConfigured(process.env.TYPESAFE_API_KEY)) fail('AI_API_KEYS_REQUIRED');
    pool = protectDatabasePool(new pg.Pool({ ...databaseOptions(process.env.DATABASE_URL), max: 1 }));
    const client = await pool.connect();
    try { await inspectDatabaseClient(client, process.env.DATABASE_URL); } finally { client.release(); }
    const budget = createAiBudget({ pool, scope: process.env.AI_BUDGET_SCOPE || 'pledge-line', limits: {
      anthropic: allocation(process.env.AI_ANTHROPIC_LIMIT_USD, AI_DEFAULT_LIMITS.anthropic, 200_000_000_000),
      jev: allocation(process.env.AI_JEV_LIMIT_USD, AI_DEFAULT_LIMITS.jev, 10_000_000_000),
    } });
    await budget.checkSchema();
    const report = await runAiSmoke({ budget, anthropicApiKey: process.env.ANTHROPIC_API_KEY, jevApiKey: process.env.TYPESAFE_API_KEY,
      prepaidOnlyConfirmed: process.env.AI_PREPAID_ONLY_CONFIRMED === 'true' });
    process.stdout.write(JSON.stringify(report) + '\n');
    if (!report.pass) process.exitCode = 1;
  } catch (error) {
    const allowed = new Set(['AI_DATABASE_REQUIRED', 'AI_API_KEYS_REQUIRED', 'AI_API_KEY_REQUIRED', 'AI_CONFIGURATION_INVALID', 'AI_SCHEMA_MISMATCH', 'AI_ALLOCATION_MISMATCH', 'AI_NOT_INITIALIZED', 'AI_STOPPED', 'AI_BUSY', 'AI_REQUEST_BLOCKED', 'AI_STORAGE_UNAVAILABLE', 'AI_PROVIDER_UNAVAILABLE', 'AI_PROVIDER_FAILED', 'AI_RATE_LIMITED', 'AI_REQUEST_INTERRUPTED', 'AI_RESPONSE_INVALID', 'AI_RESPONSE_TOO_LARGE', 'AI_USAGE_UNVERIFIED', 'AI_PRICING_MISMATCH', 'AI_SMOKE_CAP_EXCEEDED']);
    const code = allowed.has(error?.code) ? error.code : 'AI_SMOKE_FAILED';
    process.stderr.write(JSON.stringify({ pass: false, error: code, retried: false, providerBalanceVerified: false, fundingSourceVerified: false }) + '\n');
    process.exitCode = 1;
  } finally { await pool?.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
