import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { connectDatabase } from '../src/database.js';
import { configureRuntimeServices } from '../src/runtime-services.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceFiles = ['docs/AI-EVAL.md', 'test/fixtures/agent-eval.json', 'src/agent.js', 'src/ai-gateway.js', 'src/ai-budget.js'];
const mutations = new Set(['stop_gift', 'cancel_now', 'pause_gift', 'resume_gift', 'one_time_gift', 'other_email', 'hardship_cover']);
const report = { startedAt: new Date().toISOString(), scope: 'Synthetic composed-agent evaluation. No PayPal or independent supplier calls.', sourceHashes: Object.fromEntries(sourceFiles.map((name) => [name, createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')])), cases: [], completed: false };
let database;
let exitCode = 0;
try {
  if (process.argv.slice(2).length !== 1 || process.argv[2] !== '--run') throw Error('EXPLICIT_RUN_REQUIRED');
  if (!process.env.DATABASE_URL) throw Error('AI_DATABASE_REQUIRED');
  const config = loadConfig({ ...process.env, PAYPAL_MODE: 'mock', ROUTER_MODE: 'anthropic', LEDGER_PATH: '.pilot/ai-evaluation-unwritten.jsonl' });
  database = await connectDatabase(process.env.DATABASE_URL);
  const runtime = await configureRuntimeServices({ config, database, env: { ...process.env, PROCUREMENT_SUPPLIER_MODE: 'mock' } });
  const providerCalls = { anthropic: 0, jev: 0 };
  for (const provider of ['anthropic', 'jev']) {
    const original = runtime.aiGateway[provider];
    runtime.aiGateway[provider] = (...args) => { providerCalls[provider] += 1; return original(...args); };
  }
  report.allocationBefore = await runtime.aiGateway.status();
  const data = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/agent-eval.json'), 'utf8'));
  for (const [kind, cases] of [['routing', data.routing], ['consent', data.consent]]) {
    for (const item of cases) {
      const before = { ...providerCalls };
      const result = await runtime.agent.route({ text: item.text, state: { verified: true, ...(kind === 'consent' ? { pendingKind: item.pendingKind } : {}) } });
      report.cases.push({ id: item.id, kind, expected: kind === 'consent' ? 'unclear' : item.intent, result, providerCalls: { anthropic: providerCalls.anthropic - before.anthropic, jev: providerCalls.jev - before.jev } });
      if (result.error) throw Error('AI_EVALUATION_INTERRUPTED');
    }
  }
  report.allocationAfter = await runtime.aiGateway.status();
  const routing = report.cases.filter((item) => item.kind === 'routing');
  const latencies = routing.map((item) => item.result.latencyMs).sort((a, b) => a - b);
  const correct = routing.filter((item) => item.expected === item.result.intent).length;
  report.metrics = { routingCases: routing.length, correct, accuracy: correct / routing.length,
    wrongMutationRoutes: routing.filter((item) => item.expected !== item.result.intent && mutations.has(item.result.intent)).length,
    consentCases: data.consent.length, consentCasesUnclear: report.cases.filter((item) => item.kind === 'consent' && item.result.intent === 'unclear').length,
    consentProviderRequests: report.cases.filter((item) => item.kind === 'consent').reduce((sum, item) => sum + item.providerCalls.anthropic + item.providerCalls.jev, 0),
    medianRoutingMs: latencies[Math.floor(latencies.length / 2)], p95RoutingMs: latencies[Math.ceil(latencies.length * 0.95) - 1],
    providerPaths: Object.fromEntries([...new Set(routing.map((item) => item.result.model))].map((model) => [model, routing.filter((item) => item.result.model === model).length])) };
  report.pass = report.metrics.accuracy >= 0.9 && report.metrics.wrongMutationRoutes === 0 && report.metrics.consentCasesUnclear === data.consent.length && report.metrics.consentProviderRequests === 0 && report.metrics.medianRoutingMs < 4000;
  report.completed = true;
  if (!report.pass) exitCode = 1;
} catch (error) {
  report.error = ['EXPLICIT_RUN_REQUIRED', 'AI_DATABASE_REQUIRED', 'AI_EVALUATION_INTERRUPTED', 'AI_PREPAID_CONFIRMATION_REQUIRED'].includes(error?.message) ? error.message : 'AI_EVALUATION_CONFIGURATION_OR_PROVIDER_FAILURE';
  report.pass = false;
  exitCode = 1;
} finally {
  await database?.pool.end();
  report.finishedAt = new Date().toISOString();
  if (process.argv[2] === '--run') {
    const directory = path.join(root, '.pilot/ai-evaluation');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const output = path.join(directory, report.startedAt.replaceAll(':', '-') + '.json');
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify({ completed: report.completed, pass: report.pass, error: report.error ?? null, metrics: report.metrics ?? null, output }) + '\n');
  } else process.stderr.write('Usage: configure private API/database settings, then node scripts/agent-eval.js --run. No request was made.\n');
  process.exitCode = exitCode;
}
