import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { connectDatabase } from '../src/database.js';
import { configureRuntimeServices } from '../src/runtime-services.js';
import { selectEvaluationProtocol, summarizeEvaluationCost, summarizeEvaluationMetrics, evaluationPasses } from './agent-eval-protocol.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const report = { startedAt: new Date().toISOString(), scope: 'Synthetic composed-agent evaluation. No PayPal or independent supplier calls.', sourceHashes: {}, cases: [], completed: false };
let database;
let runtime;
let evaluation;
let expectedCounts;
let exitCode = 0;
try {
  evaluation = selectEvaluationProtocol(process.argv.slice(2));
  report.evaluation = { version: evaluation.version, protocol: evaluation.protocol, fixture: evaluation.fixture };
  report.sourceHashes = Object.fromEntries(evaluation.sourceFiles.map((name) => [name, createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]));
  const data = JSON.parse(fs.readFileSync(path.join(root, evaluation.fixture), 'utf8'));
  expectedCounts = { routingCases: data.routing.length, consentCases: data.consent.length };
  if (!process.env.DATABASE_URL) throw Error('AI_DATABASE_REQUIRED');
  const config = loadConfig({ ...process.env, PAYPAL_MODE: 'mock', ROUTER_MODE: 'anthropic', LEDGER_PATH: '.pilot/ai-evaluation-unwritten.jsonl' });
  database = await connectDatabase(process.env.DATABASE_URL);
  runtime = await configureRuntimeServices({ config, database, env: { ...process.env, PROCUREMENT_SUPPLIER_MODE: 'mock' } });
  const providerCalls = { anthropic: 0, jev: 0 };
  for (const provider of ['anthropic', 'jev']) {
    const original = runtime.aiGateway[provider];
    runtime.aiGateway[provider] = (...args) => { providerCalls[provider] += 1; return original(...args); };
  }
  report.allocationBefore = await runtime.aiGateway.status();
  for (const [kind, cases] of [['routing', data.routing], ['consent', data.consent]]) {
    for (const item of cases) {
      const before = { ...providerCalls };
      const started = performance.now();
      let result;
      try {
        result = await runtime.agent.route({ text: item.text, state: { verified: true, ...(kind === 'consent' ? { pendingKind: item.pendingKind } : {}) } });
      } catch {
        result = { intent: 'unclear', amountDollars: 0, empathy: 'none', latencyMs: Math.round(performance.now() - started), model: 'unavailable', error: 'AI_EVALUATION_ROUTE_FAILURE' };
      }
      report.cases.push({ id: item.id, kind, expected: kind === 'consent' ? 'unclear' : item.intent, result, providerCalls: { anthropic: providerCalls.anthropic - before.anthropic, jev: providerCalls.jev - before.jev } });
      if (result.error) throw Error('AI_EVALUATION_INTERRUPTED');
    }
  }
  report.allocationAfter = await runtime.aiGateway.status();
  report.completed = true;
} catch (error) {
  report.error = ['EXPLICIT_RUN_REQUIRED', 'AI_DATABASE_REQUIRED', 'AI_EVALUATION_INTERRUPTED', 'AI_PREPAID_CONFIRMATION_REQUIRED'].includes(error?.message) ? error.message : 'AI_EVALUATION_CONFIGURATION_OR_PROVIDER_FAILURE';
  report.pass = false;
  exitCode = 1;
} finally {
  if (evaluation) {
    report.metrics = summarizeEvaluationMetrics(report.cases, expectedCounts);
    report.pass = evaluationPasses(report.metrics, report.completed) && !report.error;
    if (!report.pass) exitCode = 1;
  }
  if (runtime && report.allocationBefore && !report.allocationAfter) {
    try { report.allocationAfter = await runtime.aiGateway.status(); }
    catch { report.allocationStatusError = 'AI_ALLOCATION_STATUS_UNAVAILABLE'; }
  }
  if (report.allocationBefore && report.allocationAfter) report.cost = summarizeEvaluationCost(report.allocationBefore, report.allocationAfter);
  try { await database?.pool.end(); }
  catch {
    report.databaseCloseError = 'AI_DATABASE_CLOSE_FAILED';
    report.error ??= 'AI_DATABASE_CLOSE_FAILED';
    report.pass = false;
    exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  if (evaluation) {
    const directory = path.join(root, '.pilot/ai-evaluation');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const output = path.join(directory, report.startedAt.replaceAll(':', '-') + (evaluation.version === 'v1' ? '' : `-${evaluation.version}`) + '.json');
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify({ evaluation: report.evaluation, completed: report.completed, pass: report.pass, error: report.error ?? null, metrics: report.metrics ?? null, cost: report.cost ?? null, output }) + '\n');
  } else process.stderr.write('Usage: configure private API/database settings, then node scripts/agent-eval.js --run, --run-v2, --run-v3 or --run-v4. No request was made.\n');
  process.exitCode = exitCode;
}
