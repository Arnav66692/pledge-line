const originalSources = Object.freeze(['docs/AI-EVAL.md', 'test/fixtures/agent-eval.json', 'src/agent.js', 'src/ai-gateway.js', 'src/ai-budget.js']);
const protocols = Object.freeze({
  '--run': Object.freeze({ version: 'v1', protocol: 'docs/AI-EVAL.md', fixture: 'test/fixtures/agent-eval.json', sourceFiles: originalSources }),
  '--run-v2': Object.freeze({ version: 'v2', protocol: 'docs/AI-EVAL-2026-11-04-V2.md', fixture: 'test/fixtures/agent-eval-v2.json', sourceFiles: Object.freeze([
    'docs/AI-EVAL-2026-11-04-V2.md', 'test/fixtures/agent-eval-v2.json', 'docs/AI-EVAL-BILLING-2026-11-04.md',
    'src/agent.js', 'src/router.js', 'src/config.js', 'src/ai-gateway.js', 'src/ai-budget.js',
    'scripts/agent-eval.js', 'scripts/agent-eval-protocol.js',
  ]) }),
  '--run-v3': Object.freeze({ version: 'v3', protocol: 'docs/AI-EVAL-2026-11-04-V3.md', fixture: 'test/fixtures/agent-eval-v3.json', sourceFiles: Object.freeze([
    'docs/AI-EVAL-2026-11-04-V3.md', 'test/fixtures/agent-eval-v3.json', 'docs/AI-EVAL-BILLING-2026-11-04.md',
    'src/agent.js', 'src/intent-guards.js', 'src/router.js', 'src/amount.js', 'src/say.js', 'src/config.js',
    'src/ai-gateway.js', 'src/ai-budget.js', 'src/runtime-services.js', 'src/database.js',
    'scripts/agent-eval.js', 'scripts/agent-eval-protocol.js', 'package.json', 'package-lock.json',
  ]) }),
  '--run-v4': Object.freeze({ version: 'v4', protocol: 'docs/AI-EVAL-2026-11-04-V4.md', fixture: 'test/fixtures/agent-eval-v4.json', sourceFiles: Object.freeze([
    'docs/AI-EVAL-2026-11-04-V4.md', 'test/fixtures/agent-eval-v4.json', 'docs/AI-EVAL-BILLING-2026-11-04.md',
    'src/agent.js', 'src/intent-guards.js', 'src/router.js', 'src/amount.js', 'src/say.js', 'src/gate.js', 'src/config.js',
    'src/ai-gateway.js', 'src/ai-budget.js', 'src/runtime-services.js', 'src/database.js', 'src/storage/postgres-ledger.js',
    'src/checkout-store.js', 'src/paypal-orders.js', 'src/checkout-recovery.js', 'src/sandbox-checkout.js', 'src/server.js',
    'scripts/agent-eval.js', 'scripts/agent-eval-protocol.js', 'package.json', 'package-lock.json',
  ]) }),
});

/** Select only a preregistered evaluation; reject overrides before any fixture, database or API access. */
export function selectEvaluationProtocol(args) {
  if (!Array.isArray(args) || args.length !== 1 || !Object.hasOwn(protocols, args[0])) throw new Error('EXPLICIT_RUN_REQUIRED');
  return protocols[args[0]];
}

const mutationIntents = new Set(['stop_gift', 'cancel_now', 'pause_gift', 'resume_gift', 'one_time_gift', 'other_email', 'hardship_cover']);

/** Summarize every observed case, including an interrupted request, against the full expected counts. */
export function summarizeEvaluationMetrics(cases, { routingCases: expectedRoutingCases = null, consentCases: expectedConsentCases = null } = {}) {
  const routing = cases.filter((item) => item.kind === 'routing');
  const consent = cases.filter((item) => item.kind === 'consent');
  const latencies = routing.map((item) => item.result?.latencyMs).filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const correct = routing.filter((item) => item.expected === item.result?.intent).length;
  const providerPaths = new Map();
  for (const item of routing) {
    const model = item.result?.model ?? 'unavailable';
    providerPaths.set(model, (providerPaths.get(model) ?? 0) + 1);
  }
  return { routingCases: routing.length, expectedRoutingCases, correct, accuracy: routing.length ? correct / routing.length : null,
    wrongMutationRoutes: routing.filter((item) => item.expected !== item.result?.intent && mutationIntents.has(item.result?.intent)).length,
    consentCases: expectedConsentCases, observedConsentCases: consent.length, expectedConsentCases,
    consentCasesUnclear: consent.filter((item) => item.result?.intent === 'unclear').length,
    consentProviderRequests: consent.reduce((sum, item) => sum + item.providerCalls.anthropic + item.providerCalls.jev, 0),
    observedCases: cases.length, expectedCases: expectedRoutingCases === null || expectedConsentCases === null ? null : expectedRoutingCases + expectedConsentCases,
    failedCases: cases.filter((item) => item.result?.error).length, routingLatencySamples: latencies.length,
    // Preserve the existing upper-middle median and nearest-rank p95 conventions for complete runs.
    medianRoutingMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
    p95RoutingMs: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null,
    providerPaths: Object.fromEntries(providerPaths) };
}

/** An observed subset can describe progress but can never satisfy the registered complete-run checks. */
export function evaluationPasses(metrics, completed) {
  return completed === true && metrics.routingCases === metrics.expectedRoutingCases && metrics.observedConsentCases === metrics.expectedConsentCases &&
    metrics.failedCases === 0 && metrics.accuracy >= 0.9 && metrics.wrongMutationRoutes === 0 &&
    metrics.consentCasesUnclear === metrics.expectedConsentCases && metrics.consentProviderRequests === 0 &&
    metrics.routingLatencySamples === metrics.routingCases && Number.isFinite(metrics.medianRoutingMs) && metrics.medianRoutingMs < 4000;
}

/** Local usage includes reservations; expose them separately from the change in settled usage. */
export function summarizeEvaluationCost(before, after) {
  const reservationNanos = (status, provider) => status.pendingRequests.filter((request) => request.provider === provider).reduce((sum, request) => sum + request.maxCostNanos, 0);
  return { currency: 'USD', providerBalanceVerified: false, providers: Object.fromEntries(['anthropic', 'jev'].map((provider) => {
    const beforePending = reservationNanos(before, provider);
    const afterPending = reservationNanos(after, provider);
    const beforeUsed = before.accounts[provider].usedNanos;
    const afterUsed = after.accounts[provider].usedNanos;
    return [provider, {
      localUsageDeltaUsd: (afterUsed - beforeUsed) / 1e9,
      settledUsageDeltaUsd: (afterUsed - afterPending - beforeUsed + beforePending) / 1e9,
      reservedBeforeUsd: beforePending / 1e9,
      reservedAfterUsd: afterPending / 1e9,
    }];
  })) };
}
