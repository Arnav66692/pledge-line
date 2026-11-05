import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectEvaluationProtocol, summarizeEvaluationCost, summarizeEvaluationMetrics, evaluationPasses } from '../scripts/agent-eval-protocol.js';
import { INTENTS } from '../src/router.js';

test('original, V2, V3 and V4 dispatch select only their fixed preregistered inputs', () => {
  const original = selectEvaluationProtocol(['--run']);
  assert.equal(original.version, 'v1');
  assert.equal(original.protocol, 'docs/AI-EVAL.md');
  assert.equal(original.fixture, 'test/fixtures/agent-eval.json');
  assert.deepEqual(original.sourceFiles, ['docs/AI-EVAL.md', 'test/fixtures/agent-eval.json', 'src/agent.js', 'src/ai-gateway.js', 'src/ai-budget.js']);
  const v2 = selectEvaluationProtocol(['--run-v2']);
  assert.equal(v2.version, 'v2');
  assert.equal(v2.protocol, 'docs/AI-EVAL-2026-11-04-V2.md');
  assert.equal(v2.fixture, 'test/fixtures/agent-eval-v2.json');
  for (const file of [v2.protocol, v2.fixture, 'docs/AI-EVAL-BILLING-2026-11-04.md', 'src/agent.js', 'src/ai-gateway.js', 'src/ai-budget.js', 'scripts/agent-eval.js', 'scripts/agent-eval-protocol.js']) assert(v2.sourceFiles.includes(file));
  assert(Object.isFrozen(v2));
  assert(Object.isFrozen(v2.sourceFiles));
  const v3 = selectEvaluationProtocol(['--run-v3']);
  assert.equal(v3.version, 'v3');
  assert.equal(v3.protocol, 'docs/AI-EVAL-2026-11-04-V3.md');
  assert.equal(v3.fixture, 'test/fixtures/agent-eval-v3.json');
  for (const file of [v3.protocol, v3.fixture, 'docs/AI-EVAL-BILLING-2026-11-04.md', 'src/agent.js', 'src/intent-guards.js', 'src/router.js', 'src/amount.js', 'src/say.js', 'src/config.js', 'src/ai-gateway.js', 'src/ai-budget.js', 'src/runtime-services.js', 'src/database.js', 'scripts/agent-eval.js', 'scripts/agent-eval-protocol.js', 'package.json', 'package-lock.json']) assert(v3.sourceFiles.includes(file));
  assert(Object.isFrozen(v3));
  assert(Object.isFrozen(v3.sourceFiles));
  for (const file of v3.sourceFiles) assert(fs.existsSync(new URL(`../${file}`, import.meta.url)), `${file} must exist before dispatch`);
  const v4 = selectEvaluationProtocol(['--run-v4']);
  assert.equal(v4.version, 'v4');
  assert.equal(v4.protocol, 'docs/AI-EVAL-2026-11-04-V4.md');
  assert.equal(v4.fixture, 'test/fixtures/agent-eval-v4.json');
  for (const file of [v4.protocol, v4.fixture, 'docs/AI-EVAL-BILLING-2026-11-04.md',
    'src/agent.js', 'src/intent-guards.js', 'src/router.js', 'src/amount.js', 'src/say.js', 'src/gate.js', 'src/config.js',
    'src/ai-gateway.js', 'src/ai-budget.js', 'src/runtime-services.js', 'src/database.js', 'src/storage/postgres-ledger.js',
    'src/checkout-store.js', 'src/paypal-orders.js', 'src/checkout-recovery.js', 'src/sandbox-checkout.js', 'src/server.js',
    'scripts/agent-eval.js', 'scripts/agent-eval-protocol.js', 'package.json', 'package-lock.json']) assert(v4.sourceFiles.includes(file));
  assert.equal(new Set(v4.sourceFiles).size, v4.sourceFiles.length);
  assert(Object.isFrozen(v4));
  assert(Object.isFrozen(v4.sourceFiles));
  for (const file of v4.sourceFiles) assert(fs.existsSync(new URL(`../${file}`, import.meta.url)), `${file} must exist before dispatch`);
});

test('missing, combined, unknown and arbitrary-path arguments cannot select a paid dispatch', () => {
  const invalid = [[], ['--run-v5'], ['--run-v2', '--run'], ['--run-v3', '--run'], ['--run-v4', '--run'], ['--run-v2', '--fixture=/tmp/other.json'], ['--run-v3', '--fixture=/tmp/other.json'], ['--run-v4', '--fixture=/tmp/other.json'], ['--run', '--protocol=/tmp/other.md'], ['--run-v4', '--protocol=/tmp/other.md'], ['--run-v3=1'], ['--run-v4=1'], ['toString'], ['__proto__']];
  for (const args of invalid) assert.throws(() => selectEvaluationProtocol(args), /EXPLICIT_RUN_REQUIRED/);
  const script = fileURLToPath(new URL('../scripts/agent-eval.js', import.meta.url));
  for (const args of [[], ['--run-v2', '--fixture=/tmp/other.json'], ['--run-v3', '--fixture=/tmp/other.json'], ['--run-v4', '--fixture=/tmp/other.json'], ['--run-v4', '--protocol=/tmp/other.md'], ['--run-v5']]) {
    // No inherited private environment or env-file; argument rejection precedes even DATABASE_URL validation.
    const result = spawnSync(process.execPath, [script, ...args], { env: {}, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Usage:.*--run, --run-v2, --run-v3 or --run-v4\. No request was made\./);
  }
});

test('V4 fixture has 30 balanced canonical routing cases and 10 canonical pending-consent cases', () => {
  const bytes = fs.readFileSync(new URL('../test/fixtures/agent-eval-v4.json', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '66ba675a25b87feb42fce70c8d2dbb58cd2d9833579e9335043e4f8133dd2f74', 'blind-reviewed V4 fixture is frozen');
  const data = JSON.parse(bytes);
  assert.deepEqual(Object.keys(data).sort(), ['consent', 'routing']);
  assert.equal(data.routing.length, 30);
  assert.equal(data.consent.length, 10);
  const ids = new Set();
  // Canonical keys from router.js PENDING_LABELS, rather than action-name aliases.
  const pendingKinds = new Set(['suspend', 'activate', 'cancel', 'send_invoice', 'refund_request', 'cover_month']);
  for (const [kind, items] of Object.entries(data)) for (const item of items) {
    assert.deepEqual(Object.keys(item).sort(), kind === 'routing' ? ['id', 'intent', 'text'] : ['id', 'pendingKind', 'text']);
    assert.equal(typeof item.id, 'string');
    assert(!ids.has(item.id));
    ids.add(item.id);
    assert.equal(typeof item.text, 'string');
    assert(item.text.trim().length > 0 && item.text.length <= 500);
    if (kind === 'routing') assert(INTENTS.includes(item.intent));
    else assert(pendingKinds.has(item.pendingKind));
  }
  assert.deepEqual(new Set(data.routing.map((item) => item.intent)), new Set(INTENTS));
  assert.deepEqual(new Set(data.consent.map((item) => item.pendingKind)), pendingKinds);
  const counts = Object.fromEntries(INTENTS.map((intent) => [intent, data.routing.filter((item) => item.intent === intent).length]));
  assert.equal(counts.help, 1);
  assert.equal(counts.unclear, 3);
  for (const intent of INTENTS.filter((intent) => !['help', 'unclear'].includes(intent))) assert.equal(counts[intent], 2);
});

test('V3 fixture has 30 canonical routing cases and 10 canonical pending-consent cases', () => {
  const data = JSON.parse(fs.readFileSync(new URL('../test/fixtures/agent-eval-v3.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(data).sort(), ['consent', 'routing']);
  assert.equal(data.routing.length, 30);
  assert.equal(data.consent.length, 10);
  const ids = new Set();
  const pendingKinds = new Set(['suspend', 'activate', 'cancel', 'send_invoice', 'refund_request', 'cover_month']);
  for (const [kind, items] of Object.entries(data)) for (const item of items) {
    assert.deepEqual(Object.keys(item).sort(), kind === 'routing' ? ['id', 'intent', 'text'] : ['id', 'pendingKind', 'text']);
    assert.equal(typeof item.id, 'string');
    assert(!ids.has(item.id));
    ids.add(item.id);
    assert.equal(typeof item.text, 'string');
    assert(item.text.trim().length > 0 && item.text.length <= 500);
    if (kind === 'routing') assert(INTENTS.includes(item.intent));
    else assert(pendingKinds.has(item.pendingKind));
  }
  assert.deepEqual(new Set(data.routing.map((item) => item.intent)), new Set(INTENTS));
  assert.deepEqual(new Set(data.consent.map((item) => item.pendingKind)), pendingKinds);
});

test('V2 fixture has 30 canonical routing cases and 10 canonical pending-consent cases', () => {
  const data = JSON.parse(fs.readFileSync(new URL('../test/fixtures/agent-eval-v2.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(data).sort(), ['consent', 'routing']);
  assert.equal(data.routing.length, 30);
  assert.equal(data.consent.length, 10);
  const ids = new Set();
  const pendingKinds = new Set(['suspend', 'activate', 'cancel', 'send_invoice', 'refund_request', 'cover_month']);
  for (const [kind, items] of Object.entries(data)) for (const item of items) {
    assert.deepEqual(Object.keys(item).sort(), kind === 'routing' ? ['id', 'intent', 'text'] : ['id', 'pendingKind', 'text']);
    assert.equal(typeof item.id, 'string');
    assert(!ids.has(item.id));
    ids.add(item.id);
    assert.equal(typeof item.text, 'string');
    assert(item.text.trim().length > 0 && item.text.length <= 500);
    if (kind === 'routing') assert(INTENTS.includes(item.intent));
    else assert(pendingKinds.has(item.pendingKind));
  }
  assert.deepEqual(new Set(data.consent.map((item) => item.pendingKind)), pendingKinds);
});

test('cost report distinguishes settled usage from conservative unknown-usage reservations', () => {
  const before = { accounts: { anthropic: { usedNanos: 100000000 }, jev: { usedNanos: 2000000 } }, pendingRequests: [] };
  const after = { accounts: { anthropic: { usedNanos: 160000000 }, jev: { usedNanos: 2500000 } }, pendingRequests: [{ provider: 'anthropic', maxCostNanos: 50000000 }] };
  assert.deepEqual(summarizeEvaluationCost(before, after), { currency: 'USD', providerBalanceVerified: false, providers: {
    anthropic: { localUsageDeltaUsd: 0.06, settledUsageDeltaUsd: 0.01, reservedBeforeUsd: 0, reservedAfterUsd: 0.05 },
    jev: { localUsageDeltaUsd: 0.0005, settledUsageDeltaUsd: 0.0005, reservedBeforeUsd: 0, reservedAfterUsd: 0 },
  } });
});

const expectedCounts = { routingCases: 30, consentCases: 10 };
const routingCase = (id, latencyMs, extra = {}) => ({ id, kind: 'routing', expected: 'gift_status',
  result: { intent: 'gift_status', latencyMs, model: 'offline-main', ...extra }, providerCalls: { anthropic: 1, jev: 1 } });
const consentCase = (id, extra = {}) => ({ id, kind: 'consent', expected: 'unclear',
  result: { intent: 'unclear', latencyMs: 0, model: 'consent-gate', ...extra }, providerCalls: { anthropic: 0, jev: 0 } });
const completeCases = () => [...Array.from({ length: 30 }, (_, index) => routingCase(`R${index}`, (index + 1) * 10)),
  ...Array.from({ length: 10 }, (_, index) => consentCase(`C${index}`))];

test('interrupted routing retains the failed request latency and expected versus observed counts', () => {
  const cases = [routingCase('first', 250), routingCase('interrupted', 5100, { intent: 'unclear', error: 'APIConnectionTimeoutError' })];
  const metrics = summarizeEvaluationMetrics(cases, expectedCounts);
  assert.deepEqual(metrics, { routingCases: 2, expectedRoutingCases: 30, correct: 1, accuracy: 0.5, wrongMutationRoutes: 0,
    consentCases: 10, observedConsentCases: 0, expectedConsentCases: 10, consentCasesUnclear: 0, consentProviderRequests: 0,
    observedCases: 2, expectedCases: 40, failedCases: 1, routingLatencySamples: 2, medianRoutingMs: 5100, p95RoutingMs: 5100,
    providerPaths: { 'offline-main': 2 } });
  assert.equal(evaluationPasses(metrics, false), false);
  assert.equal(evaluationPasses(metrics, true), false);
});

test('interruption during consent preserves completed routing metrics without claiming all consent cases ran', () => {
  const cases = [...completeCases().filter((item) => item.kind === 'routing'), consentCase('first'),
    consentCase('interrupted', { error: 'unexpected-consent-error' })];
  const metrics = summarizeEvaluationMetrics(cases, expectedCounts);
  assert.equal(metrics.routingCases, 30);
  assert.equal(metrics.medianRoutingMs, 160);
  assert.equal(metrics.p95RoutingMs, 290);
  assert.equal(metrics.consentCases, 10);
  assert.equal(metrics.observedConsentCases, 2);
  assert.equal(metrics.observedCases, 32);
  assert.equal(metrics.expectedCases, 40);
  assert.equal(metrics.failedCases, 1);
  assert.equal(evaluationPasses(metrics, false), false);
});

test('an empty or perfect partial run never passes or invents latency measurements', () => {
  const empty = summarizeEvaluationMetrics([], expectedCounts);
  assert.equal(empty.accuracy, null);
  assert.equal(empty.medianRoutingMs, null);
  assert.equal(empty.p95RoutingMs, null);
  assert.equal(empty.routingLatencySamples, 0);
  assert.equal(empty.observedCases, 0);
  assert.equal(empty.expectedCases, 40);
  assert.equal(evaluationPasses(empty, false), false);
  const unknown = summarizeEvaluationMetrics([]);
  assert.equal(unknown.expectedRoutingCases, null);
  assert.equal(unknown.expectedConsentCases, null);
  assert.equal(unknown.expectedCases, null);
  const partial = summarizeEvaluationMetrics([routingCase('only', 10)], expectedCounts);
  assert.equal(partial.accuracy, 1);
  assert.equal(evaluationPasses(partial, false), false);
  assert.equal(evaluationPasses(partial, true), false);
});

test('complete-run acceptance retains the fixed accuracy, mutation, consent and latency checks', () => {
  const cases = completeCases();
  for (const item of cases.slice(0, 3)) item.result.intent = 'unclear';
  const passing = summarizeEvaluationMetrics(cases, expectedCounts);
  assert.equal(passing.correct, 27);
  assert.equal(passing.accuracy, 0.9);
  assert.equal(passing.medianRoutingMs, 160);
  assert.equal(passing.p95RoutingMs, 290);
  assert.equal(evaluationPasses(passing, true), true);
  assert.equal(evaluationPasses(passing, false), false);
  for (const change of [{ accuracy: 26 / 30 }, { wrongMutationRoutes: 1 }, { consentCasesUnclear: 9 },
    { consentProviderRequests: 1 }, { medianRoutingMs: 4000 }, { failedCases: 1 }, { routingLatencySamples: 29 }]) {
    assert.equal(evaluationPasses({ ...passing, ...change }, true), false);
  }
});

test('missing or invalid routing latencies remain explicit and prevent a complete pass', () => {
  const cases = completeCases();
  cases[0].result.latencyMs = undefined;
  cases[1].result.latencyMs = -1;
  const metrics = summarizeEvaluationMetrics(cases, expectedCounts);
  assert.equal(metrics.routingCases, 30);
  assert.equal(metrics.routingLatencySamples, 28);
  assert.equal(metrics.medianRoutingMs, 170);
  assert.equal(metrics.p95RoutingMs, 290);
  assert.equal(evaluationPasses(metrics, true), false);
});

test('provider-path aggregation retains prototype-named models as ordinary own keys', () => {
  const models = ['__proto__', 'constructor', 'toString', '__proto__'];
  const metrics = summarizeEvaluationMetrics(models.map((model, index) => routingCase(`R${index}`, 10, { model })), expectedCounts);
  assert.deepEqual(metrics.providerPaths, Object.fromEntries([['__proto__', 2], ['constructor', 1], ['toString', 1]]));
  for (const model of models) assert(Object.hasOwn(metrics.providerPaths, model));
  assert.equal(Object.getPrototypeOf(metrics.providerPaths), Object.prototype);
});

test('offline harness preserves partial metrics, failed case and cost on routing or teardown errors', () => {
  for (const { failure, teardownFails } of [{ failure: 'returned', teardownFails: false },
    { failure: 'thrown', teardownFails: false }, { failure: 'returned', teardownFails: true }]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pledge-eval-offline-'));
    try {
      // A separate temporary project prevents test reports from entering the real evaluation directory.
      for (const file of selectEvaluationProtocol(['--run-v4']).sourceFiles) {
        const target = path.join(directory, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, '');
      }
      for (const file of ['scripts/agent-eval.js', 'scripts/agent-eval-protocol.js']) {
        fs.copyFileSync(new URL(`../${file}`, import.meta.url), path.join(directory, file));
      }
      fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
      fs.writeFileSync(path.join(directory, 'test/fixtures/agent-eval-v4.json'), JSON.stringify({
        routing: ['first', 'interrupted', 'must-not-run'].map((id) => ({ id, text: id, intent: 'gift_status' })),
        consent: ['not-run-1', 'not-run-2'].map((id) => ({ id, text: 'yes', pendingKind: 'cancel' })),
      }));
      fs.writeFileSync(path.join(directory, 'src/config.js'), 'export const loadConfig = () => ({});\n');
      fs.writeFileSync(path.join(directory, 'src/database.js'), `export const connectDatabase = async () => ({ pool: { end: async () => {
        ${teardownFails ? 'throw new Error("offline-only close failure");' : ''}
      } } });\n`);
      fs.writeFileSync(path.join(directory, 'src/runtime-services.js'), `
        export async function configureRuntimeServices() {
          let calls = 0;
          const aiGateway = {
            anthropic: async () => {}, jev: async () => {},
            status: async () => ({ accounts: { anthropic: { usedNanos: calls ? 70000000 : 0 }, jev: { usedNanos: 0 } },
              pendingRequests: calls ? [{ provider: 'anthropic', maxCostNanos: 50000000 }] : [] }),
          };
          return { aiGateway, agent: { route: async () => {
            await aiGateway.jev(); await aiGateway.anthropic(); calls += 1;
            if (calls === 2 && ${JSON.stringify(failure)} === 'thrown') throw new Error('offline-only failure');
            return { intent: calls === 1 ? 'gift_status' : 'unclear', latencyMs: calls === 1 ? 250 : 5100,
              model: 'offline-main', ...(calls === 2 ? { error: 'APIConnectionTimeoutError' } : {}) };
          } } };
        }
      `);
      const result = spawnSync(process.execPath, [path.join(directory, 'scripts/agent-eval.js'), '--run-v4'], {
        env: { DATABASE_URL: 'offline-only' }, encoding: 'utf8', timeout: 10000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.equal(result.stderr, '');
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.completed, false);
      assert.equal(summary.pass, false);
      assert.equal(summary.error, 'AI_EVALUATION_INTERRUPTED');
      assert.equal(summary.metrics.routingCases, 2);
      assert.equal(summary.metrics.expectedRoutingCases, 3);
      assert.equal(summary.metrics.observedConsentCases, 0);
      assert.equal(summary.metrics.expectedConsentCases, 2);
      assert.equal(summary.metrics.observedCases, 2);
      assert.equal(summary.metrics.expectedCases, 5);
      assert.equal(summary.metrics.failedCases, 1);
      assert.equal(summary.metrics.routingLatencySamples, 2);
      assert(Number.isFinite(summary.metrics.medianRoutingMs));
      assert(Number.isFinite(summary.metrics.p95RoutingMs));
      if (failure === 'returned') assert.equal(summary.metrics.p95RoutingMs, 5100);
      assert.equal(summary.cost.providers.anthropic.localUsageDeltaUsd, 0.07);
      assert.equal(summary.cost.providers.anthropic.settledUsageDeltaUsd, 0.02);
      assert.equal(summary.cost.providers.anthropic.reservedAfterUsd, 0.05);
      assert.equal(fs.realpathSync(path.dirname(summary.output)), fs.realpathSync(path.join(directory, '.pilot/ai-evaluation')));
      assert(summary.output.endsWith('-v4.json'));
      const report = JSON.parse(fs.readFileSync(summary.output, 'utf8'));
      assert.equal(report.completed, false);
      assert.equal(report.pass, false);
      assert.equal(report.error, 'AI_EVALUATION_INTERRUPTED');
      assert.equal(report.databaseCloseError, teardownFails ? 'AI_DATABASE_CLOSE_FAILED' : undefined);
      assert.equal(report.cases.length, 2);
      assert.equal(report.cases[1].id, 'interrupted');
      assert.equal(report.cases[1].expected, 'gift_status');
      assert.equal(report.cases[1].result.intent, 'unclear');
      assert.equal(report.cases[1].result.error, failure === 'returned' ? 'APIConnectionTimeoutError' : 'AI_EVALUATION_ROUTE_FAILURE');
      assert.deepEqual(report.cases[1].providerCalls, { anthropic: 1, jev: 1 });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});
