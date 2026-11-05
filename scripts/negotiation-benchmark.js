import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createProcurementService } from '../src/procurement.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCOPE = 'pledge-line-functional-20261105';
const LIMITS = { anthropic: 3_000_000_000, jev: 100_000_000 };
const DAY = 86_400_000;
const REVIEW_CHECKS = new Set(['BUDGET', 'QUANTITY', 'SPLIT_POLICY', 'QUOTE_BINDING', 'COST_TOTAL', 'DEADLINE', 'QUOTE_FRESHNESS', 'CURRENCY', 'SPECIFICATION']);
const REVIEW_REASONS = new Set(['EVIDENCE_INCOMPLETE', 'BUDGET_EXCEEDED', 'QUANTITY_MISMATCH', 'SPLIT_NOT_ALLOWED', 'QUOTE_BINDING_MISMATCH',
  'COST_MISMATCH', 'DEADLINE_MISSED', 'QUOTE_EXPIRED_OR_CHANGED', 'CURRENCY_MISMATCH', 'SPECIFICATION_MISMATCH', 'JEV_LOW_CONFIDENCE', 'JEV_REVIEW_REQUESTED']);
const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const fail = (code) => { throw new Error(code); };
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

export function sourceHashes(root = ROOT) {
  const files = ['scripts/negotiation-benchmark.js'];
  function collect(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) collect(name);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(name);
    }
  }
  collect('src');
  return Object.fromEntries(files.sort().map((name) => [name, hash(fs.readFileSync(path.join(root, name), 'utf8'))]));
}

/** Synthetic test construction, never a claim about real suppliers or target-user performance. */
export function makeBenchmarkFixture(seed = randomBytes(32).toString('hex')) {
  if (typeof seed !== 'string' || !/^[a-f0-9]{64}$/.test(seed)) fail('BENCHMARK_SEED_INVALID');
  let cursor = 0;
  const pick = (min, max) => min + (Number.parseInt(hash(`${seed}:${cursor++}`).slice(0, 8), 16) % (max - min + 1));
  const epoch = '2026-11-05T20:00:00.000Z';
  const cases = [];
  for (let index = 0; index < 6; index += 1) {
    const quantity = pick(24, 72);
    const suppliers = Array.from({ length: 3 }, (_, vendor) => {
      const floor = pick(220, 700);
      return { id: `supplier-${vendor + 1}`, capacity: index === 0 ? Math.ceil(quantity * 0.65) : quantity,
        minQuantity: index === 4 ? pick(2, 8) : 1, initialUnitCents: floor + pick(25, 140), floorUnitCents: floor,
        setupCents: pick(0, 1400), shippingCents: pick(300, 1900), taxBps: pick(0, 1000),
        deliveryDays: index === 1 && vendor !== 2 ? 6 : pick(1, 3),
        changedPayee: index === 3 && vendor === 0, expired: index === 5 && vendor === 1 };
    });
    cases.push({ id: `N-${String(index + 1).padStart(2, '0')}`, epoch,
      request: { quantity, budgetCents: index === 2 ? 500 : quantity * 900 + 9000, currency: 'USD',
        specification: `Identical cotton event shirts, one print, design ${pick(100, 999)}.`,
        deadline: new Date(Date.parse(epoch) + (index === 1 ? 2 : 5) * DAY).toISOString(), allowSplit: index !== 4 },
      suppliers });
  }
  return { version: 1, construction: 'Locally generated synthetic supplier policies; not external or target-user evidence.', cases };
}

export function validateFixture(fixture) {
  if (!fixture || fixture.version !== 1 || !Array.isArray(fixture.cases) || fixture.cases.length < 1 || fixture.cases.length > 6) fail('BENCHMARK_FIXTURE_INVALID');
  const ids = new Set();
  for (const item of fixture.cases) {
    if (!/^N-\d{2}$/.test(item?.id ?? '') || ids.has(item.id) || !Number.isFinite(Date.parse(item.epoch)) ||
      !integer(item.request?.quantity, 1, 150) || !integer(item.request?.budgetCents, 1, 1_000_000) ||
      item.request.currency !== 'USD' || typeof item.request.specification !== 'string' || item.request.specification.length < 8 || item.request.specification.length > 1000 ||
      !Number.isFinite(Date.parse(item.request.deadline)) || Date.parse(item.request.deadline) <= Date.parse(item.epoch) ||
      typeof item.request.allowSplit !== 'boolean' || !Array.isArray(item.suppliers) || item.suppliers.length !== 3) fail('BENCHMARK_FIXTURE_INVALID');
    ids.add(item.id);
    const vendors = new Set();
    for (const supplier of item.suppliers) {
      if (!/^supplier-[1-3]$/.test(supplier?.id ?? '') || vendors.has(supplier.id) || !integer(supplier.capacity, 1, item.request.quantity) ||
        !integer(supplier.minQuantity, 1, supplier.capacity) || !integer(supplier.floorUnitCents, 1, 10000) ||
        !integer(supplier.initialUnitCents, supplier.floorUnitCents, 10000) || !integer(supplier.setupCents, 0, 10000) ||
        !integer(supplier.shippingCents, 0, 10000) || !integer(supplier.taxBps, 0, 5000) || !integer(supplier.deliveryDays, 1, 30) ||
        typeof supplier.changedPayee !== 'boolean' || typeof supplier.expired !== 'boolean') fail('BENCHMARK_FIXTURE_INVALID');
      vendors.add(supplier.id);
    }
  }
  return fixture;
}

export function verifyFreeze(fixtureText, manifest, hashes) {
  if (manifest?.version !== 1 || manifest.fixtureSha256 !== hash(fixtureText) ||
    JSON.stringify(Object.keys(manifest.sourceHashes ?? {}).sort()) !== JSON.stringify(Object.keys(hashes).sort()) ||
    Object.entries(hashes).some(([name, digest]) => manifest.sourceHashes[name] !== digest)) fail('BENCHMARK_FREEZE_MISMATCH');
}

function suppliersFor(item, arm, metrics, issuedQuotes) {
  return item.suppliers.map((policy) => {
    const quotes = new Map();
    let sequence = 0;
    const payeeId = `benchmark-payee-${policy.id}`;
    function quote(unitPriceCents) {
      const raw = { supplierId: policy.id, quoteId: `bench-${item.id}-${policy.id}-${sequence++}`, payeeId: policy.changedPayee ? 'unregistered-payee' : payeeId,
        specificationHash: hash(item.request.specification), currency: 'USD', minQuantity: policy.minQuantity,
        maxQuantity: policy.capacity, unitPriceCents, setupCents: policy.setupCents, shippingCents: policy.shippingCents, taxBps: policy.taxBps,
        deliveryAt: new Date(Date.parse(item.epoch) + policy.deliveryDays * DAY).toISOString(),
        expiresAt: new Date(Date.parse(item.epoch) + (policy.expired ? -1 : 900_000)).toISOString() };
      quotes.set(raw.quoteId, structuredClone(raw));
      // This separate per-arm record never crosses the public metrics/report boundary.
      issuedQuotes.set(raw.quoteId, Object.freeze(structuredClone(raw)));
      return raw;
    }
    return { id: policy.id, name: `${policy.id}, benchmark simulation`, payeeId, mode: 'simulated',
      async quote() { metrics.quoteCalls += 1; return quote(policy.initialUnitCents); },
      async negotiate({ counterOffer } = {}) {
        metrics.negotiationCalls += 1;
        metrics.negotiationsBySupplier[policy.id] = (metrics.negotiationsBySupplier[policy.id] ?? 0) + 1;
        if (metrics.negotiationsBySupplier[policy.id] > 2) fail('BENCHMARK_NEGOTIATION_ROUND_CAP');
        // Mirrors this project's controlled lab: without a counteroffer the supplier returns its configured floor.
        // All arms have the same two-call cap. The guarded strategy uses a default-policy and a model response;
        // the deterministic arm currently needs only one call. Actual counts stay visible in the report.
        const offered = counterOffer?.unitPriceCents;
        return quote(arm === 'initial_quotes' ? policy.initialUnitCents : offered === undefined ? policy.floorUnitCents : Math.max(policy.floorUnitCents, offered));
      },
      async getQuote(id) { return structuredClone(quotes.get(id) ?? null); },
      async settle() { metrics.paymentCalls += 1; fail('BENCHMARK_PAYMENT_FORBIDDEN'); },
      async getSettlement() { metrics.paymentCalls += 1; fail('BENCHMARK_PAYMENT_FORBIDDEN'); },
    };
  });
}

/** Independent output checks, not a grading copy of the app's status label. */
export function checkProposal(item, proposal, issuedQuotes = null) {
  if (!proposal) return { complete: false, totalCents: null, violations: [] };
  const violations = [];
  const allocations = Array.isArray(proposal.allocations) ? proposal.allocations : [];
  const seen = new Set();
  let exactQuoteBindingsVerified = issuedQuotes instanceof Map && allocations.length > 0;
  let quantity = 0, total = 0;
  for (const leg of allocations) {
    const policy = item.suppliers.find((supplier) => supplier.id === leg?.supplierId);
    if (!policy || seen.has(leg.supplierId)) { exactQuoteBindingsVerified = false; violations.push('SUPPLIER_IDENTITY'); continue; }
    seen.add(leg.supplierId);
    if (![0, 1, 2].some((sequence) => leg.quoteId === `bench-${item.id}-${policy.id}-${sequence}`)) violations.push('QUOTE_IDENTITY');
    const issued = issuedQuotes instanceof Map ? issuedQuotes.get(leg.quoteId) : null;
    if (!issued) {
      exactQuoteBindingsVerified = false;
      violations.push('QUOTE_BINDING_UNVERIFIED');
    } else if (!['supplierId', 'quoteId', 'payeeId', 'unitPriceCents', 'setupCents', 'shippingCents', 'taxBps', 'currency', 'specificationHash', 'deliveryAt', 'expiresAt']
      .every((key) => issued[key] === leg[key]) || issued.minQuantity !== policy.minQuantity || issued.maxQuantity !== policy.capacity ||
      !integer(leg.quantity, issued.minQuantity, issued.maxQuantity) ||
      (leg.minQuantity !== undefined && leg.minQuantity !== issued.minQuantity) || (leg.maxQuantity !== undefined && leg.maxQuantity !== issued.maxQuantity)) {
      exactQuoteBindingsVerified = false;
      violations.push('QUOTE_BINDING_MISMATCH');
    }
    if (!integer(leg.quantity, policy.minQuantity, policy.capacity)) { violations.push('STOCK_OR_MINIMUM'); continue; }
    quantity += leg.quantity;
    if (policy.changedPayee || leg.payeeId !== `benchmark-payee-${policy.id}`) violations.push('PAYEE');
    if (leg.currency !== 'USD' || leg.specificationHash !== hash(item.request.specification)) violations.push('SPECIFICATION_OR_CURRENCY');
    if (!integer(leg.unitPriceCents, policy.floorUnitCents, policy.initialUnitCents) ||
      leg.setupCents !== policy.setupCents || leg.shippingCents !== policy.shippingCents || leg.taxBps !== policy.taxBps) violations.push('COMMERCIAL_TERMS');
    const expected = leg.unitPriceCents * leg.quantity + policy.setupCents + policy.shippingCents + Math.round((leg.unitPriceCents * leg.quantity + policy.setupCents) * policy.taxBps / 10000);
    if (!Number.isSafeInteger(expected) || leg.totalCents !== expected) violations.push('AMOUNT');
    total += expected;
    const expectedExpiry = Date.parse(item.epoch) + (policy.expired ? -1 : 900_000);
    if (policy.expired || Date.parse(leg.expiresAt) !== expectedExpiry) violations.push('EXPIRY');
    const expectedDelivery = Date.parse(item.epoch) + policy.deliveryDays * DAY;
    if (Date.parse(leg.deliveryAt) !== expectedDelivery || expectedDelivery > Date.parse(item.request.deadline)) violations.push('DEADLINE');
  }
  if (!item.request.allowSplit && allocations.length > 1) violations.push('SPLIT_NOT_ALLOWED');
  if (quantity !== item.request.quantity || proposal.quantity !== item.request.quantity) violations.push('INCOMPLETE_QUANTITY');
  if (total !== proposal.totalCents || total > item.request.budgetCents) violations.push('TOTAL_OR_BUDGET');
  return { complete: quantity === item.request.quantity && violations.length === 0, totalCents: total, exactQuoteBindingsVerified, violations: [...new Set(violations)] };
}

function allocationDelta(before, after) {
  if (!before || !after) return null;
  return Object.fromEntries(['anthropic', 'jev'].map((provider) => [provider, after.accounts[provider].usedNanos - before.accounts[provider].usedNanos]));
}

/** Only stable codes/statuses cross into a shareable report; no reviewer messages or arbitrary evidence. */
export function summarizeReview(review) {
  if (!review) return null;
  const rawChecks = Array.isArray(review.checks) ? review.checks : [];
  const checks = rawChecks.filter((check) => REVIEW_CHECKS.has(check?.code) && ['pass', 'fail', 'unverified'].includes(check.status))
    .slice(0, 9).map(({ code, status, reasonCode }) => ({ code, status, ...(REVIEW_REASONS.has(reasonCode) ? { reasonCode } : {}) }));
  const rawReasons = Array.isArray(review.reasons) ? review.reasons : [];
  const reasons = rawReasons.filter((reason) => REVIEW_REASONS.has(reason?.code) && ['code', 'reviewer'].includes(reason.source) &&
    (reason.check === undefined || REVIEW_CHECKS.has(reason.check))).slice(0, 12)
    .map(({ code, source, check }) => ({ code, source, ...(check !== undefined ? { check } : {}) }));
  const allNineCodeChecksPass = checks.length === 9 && new Set(checks.map((check) => check.code)).size === 9 && checks.every((check) => check.status === 'pass');
  return { decision: ['within_limits', 'needs_review'].includes(review.decision) ? review.decision : 'unverified',
    confidence: typeof review.confidence === 'number' && Number.isFinite(review.confidence) && review.confidence >= 0 && review.confidence <= 1 ? review.confidence : null,
    ...(review.reviewerDecision !== undefined ? { reviewerDecision: ['within_limits', 'needs_review'].includes(review.reviewerDecision) ? review.reviewerDecision : 'unverified' } : {}),
    checks, reasons, allNineCodeChecksPass,
    warningOnPassingCodeChecks: review.decision === 'needs_review' && allNineCodeChecksPass,
    onlyReviewerUncertaintyReasons: reasons.length > 0 && reasons.every((reason) => reason.source === 'reviewer' && ['JEV_LOW_CONFIDENCE', 'JEV_REVIEW_REQUESTED'].includes(reason.code)),
    omittedUnexpectedChecks: rawChecks.length - checks.length, omittedUnexpectedReasons: rawReasons.length - reasons.length };
}

function summarizePriceGuard(guard, proposal) {
  if (!guard || guard.version !== 1 || !['baseline', 'agent', 'hybrid', 'none'].includes(guard.selectedSource) || typeof guard.comparisonComplete !== 'boolean' ||
    !['baselineTotalCents', 'agentTotalCents', 'selectedTotalCents', 'avoidedCents'].every((key) => guard[key] === null || integer(guard[key], 0, 100_000_000))) return null;
  const result = Object.fromEntries(['version', 'baselineTotalCents', 'agentTotalCents', 'selectedTotalCents', 'selectedSource', 'comparisonComplete', 'avoidedCents'].map((key) => [key, guard[key]]));
  return { ...result,
    selectedMatchesProposal: proposal ? guard.selectedTotalCents === proposal.totalCents : guard.selectedTotalCents === null,
    selectedNoMoreExpensiveThanCheckedBaseline: guard.selectedTotalCents !== null && guard.baselineTotalCents !== null ? guard.selectedTotalCents <= guard.baselineTotalCents : null,
    avoidedCentsMatchesCandidates: guard.agentTotalCents !== null && guard.selectedTotalCents !== null
      ? guard.avoidedCents === Math.max(0, guard.agentTotalCents - guard.selectedTotalCents) : guard.avoidedCents === null };
}

export async function runNegotiationBenchmark({ fixture, agent = null, budgetStatus = null, clock = () => performance.now() } = {}) {
  validateFixture(fixture);
  const report = { version: 2, scope: 'Synthetic offline suppliers. No PayPal, MCP network, approvals or payments.',
    negotiationProtocol: { sameSupplierPolicies: true, maximumCallsPerSupplierPerArm: 2,
      deterministicPolicy: 'One default-policy call per usable supplier.', mainAgentPolicy: 'One default-policy call, then at most one model-counteroffer call per usable supplier. Omitted model offers reuse the checked default response.' },
    modelRun: Boolean(agent), cases: [], completed: true, modelInterrupted: false };
  for (const item of fixture.cases) {
    const entry = { id: item.id, arms: {} };
    for (const arm of ['initial_quotes', 'deterministic_negotiation', ...(agent ? ['main_agent'] : [])]) {
      if (arm === 'main_agent' && report.modelInterrupted) {
        entry.arms[arm] = { status: 'not_run', error: 'MODEL_INTERRUPTED_BEFORE_CASE', complete: false, violations: [], totalCents: null, latencyMs: null, apiCostNanos: null };
        continue;
      }
      const metrics = { quoteCalls: 0, negotiationCalls: 0, negotiationsBySupplier: {}, paymentCalls: 0 };
      const issuedQuotes = new Map();
      const began = clock();
      let before, after;
      try {
        if (arm === 'main_agent' && budgetStatus) before = await budgetStatus();
        const service = createProcurementService({ suppliers: suppliersFor(item, arm, metrics, issuedQuotes), now: () => new Date(item.epoch), agent: arm === 'main_agent' ? agent : null });
        const state = await service.request(structuredClone(item.request));
        if (Object.values(metrics.negotiationsBySupplier).some((count) => count > 2)) fail('BENCHMARK_NEGOTIATION_ROUND_CAP');
        if (arm === 'main_agent' && budgetStatus) after = await budgetStatus();
        entry.arms[arm] = { status: state.status, ...checkProposal(item, state.proposal, issuedQuotes), latencyMs: Math.max(0, Math.round(clock() - began)),
          apiCostNanos: arm === 'main_agent' ? allocationDelta(before, after) : { anthropic: 0, jev: 0 },
          advisoryReview: summarizeReview(state.review), priceGuard: summarizePriceGuard(state.negotiationTrace?.priceGuard, state.proposal), ...metrics };
        if (after?.stopped || after?.pendingRequests?.length) { report.modelInterrupted = true; report.completed = false; }
      } catch {
        // Preserve every failed case without printing provider payloads, keys or configuration errors.
        if (arm === 'main_agent' && budgetStatus) { try { after = await budgetStatus(); } catch { /* Failure stays explicit. */ } }
        entry.arms[arm] = { status: 'error', error: 'BENCHMARK_ARM_FAILED', complete: false, totalCents: null, violations: [],
          latencyMs: Math.max(0, Math.round(clock() - began)), apiCostNanos: allocationDelta(before, after), ...metrics };
        report.completed = false;
        if (arm === 'main_agent') report.modelInterrupted = true;
      }
    }
    const strong = entry.arms.deterministic_negotiation;
    entry.expectedFeasibleBySupplierFloorBaseline = strong.complete ? true : strong.status === 'no_feasible_quote' ? false : null;
    const model = entry.arms.main_agent;
    if (model) entry.modelComparison = { correctFeasibility: entry.expectedFeasibleBySupplierFloorBaseline === null ? null : strong.complete ? model.complete : model.status === 'no_feasible_quote',
      modelMinusDeterministicCents: model.complete && strong.complete ? model.totalCents - strong.totalCents : null };
    report.cases.push(entry);
  }
  report.summary = Object.fromEntries(['initial_quotes', 'deterministic_negotiation', ...(agent ? ['main_agent'] : [])].map((arm) => {
    const rows = report.cases.map((entry) => entry.arms[arm]);
    return [arm, { cases: rows.length, completeOrders: rows.filter((row) => row.complete).length,
      noFeasibleOrders: rows.filter((row) => row.status === 'no_feasible_quote').length,
      errorsOrNotRun: rows.filter((row) => ['error', 'not_run'].includes(row.status)).length,
      constraintViolations: rows.reduce((sum, row) => sum + row.violations.length, 0),
      quoteCalls: rows.reduce((sum, row) => sum + (row.quoteCalls ?? 0), 0),
      negotiationCalls: rows.reduce((sum, row) => sum + (row.negotiationCalls ?? 0), 0),
      paymentCalls: rows.reduce((sum, row) => sum + (row.paymentCalls ?? 0), 0),
      priceGuardComparedCases: rows.filter((row) => row.priceGuard?.comparisonComplete).length,
      priceGuardAvoidedCents: rows.reduce((sum, row) => sum + (row.priceGuard?.avoidedCents ?? 0), 0),
      allNineCodeChecksPassCases: rows.filter((row) => row.advisoryReview?.allNineCodeChecksPass).length,
      warningsOnPassingCodeChecks: rows.filter((row) => row.advisoryReview?.warningOnPassingCodeChecks).length,
      measuredLatencyCases: rows.filter((row) => row.latencyMs !== null).length,
      meanLatencyMs: Math.round(rows.reduce((sum, row) => sum + (row.latencyMs ?? 0), 0) / Math.max(1, rows.filter((row) => row.latencyMs !== null).length)) }];
  }));
  return report;
}

function readJson(file) {
  if (fs.statSync(file).size > 128 * 1024) fail('BENCHMARK_FILE_TOO_LARGE');
  return fs.readFileSync(file, 'utf8');
}

async function main(args) {
  const flags = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!['--freeze', '--run-offline', '--run-model', '--fixture', '--manifest', '--output'].includes(name) || flags.has(name)) fail('BENCHMARK_USAGE');
    flags.set(name, ['--fixture', '--manifest', '--output'].includes(name) ? args[++index] : true);
  }
  if ([...['--freeze', '--run-offline', '--run-model']].filter((name) => flags.has(name)).length !== 1 ||
    !flags.get('--fixture') || !flags.get('--manifest')) fail('BENCHMARK_USAGE');
  const hashes = sourceHashes();
  if (flags.has('--freeze')) {
    const fixture = JSON.stringify(makeBenchmarkFixture(), null, 2) + '\n';
    const manifest = { version: 1, frozenAt: new Date().toISOString(), caseCount: 6, fixtureSha256: hash(fixture), sourceHashes: hashes,
      disclosure: 'Locally generated synthetic cases frozen before the model run. No claim of external or target-user validation.' };
    // Never overwrite an exposed suite or an existing manifest to manufacture a fresh run.
    fs.writeFileSync(flags.get('--fixture'), fixture, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(flags.get('--manifest'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify({ frozen: true, ...manifest }) + '\n');
    return;
  }
  if (!flags.get('--output')) fail('BENCHMARK_USAGE');
  const fixtureText = readJson(flags.get('--fixture'));
  const fixture = validateFixture(JSON.parse(fixtureText));
  const manifest = JSON.parse(readJson(flags.get('--manifest')));
  verifyFreeze(fixtureText, manifest, hashes);
  if (manifest.caseCount !== fixture.cases.length) fail('BENCHMARK_FREEZE_MISMATCH');
  // Acquire the report path before any billable work. An existing report never authorizes a repeat run.
  const output = fs.openSync(flags.get('--output'), 'wx', 0o600);
  let database, gateway, report = { version: 1, cases: [], completed: false, modelRun: flags.has('--run-model') };
  try {
    if (flags.has('--run-model')) {
      if (process.env.AI_PREPAID_ONLY_CONFIRMED !== 'true' || process.env.AI_BUDGET_SCOPE !== SCOPE ||
        !['3', '3.00'].includes(process.env.AI_ANTHROPIC_LIMIT_USD) || !['0.1', '0.10'].includes(process.env.AI_JEV_LIMIT_USD)) fail('BENCHMARK_EXISTING_SCOPE_REQUIRED');
      const [{ connectDatabase }, { createAiBudget }, { createAiGateway }, { createMainAgent }] = await Promise.all([
        import('../src/database.js'), import('../src/ai-budget.js'), import('../src/ai-gateway.js'), import('../src/agent.js')]);
      database = await connectDatabase(process.env.DATABASE_URL);
      const budget = createAiBudget({ pool: database.pool, scope: SCOPE, limits: LIMITS });
      await budget.checkSchema();
      gateway = createAiGateway({ budget, anthropicApiKey: process.env.ANTHROPIC_API_KEY, jevApiKey: process.env.TYPESAFE_API_KEY });
      const before = await gateway.status();
      if (before.stopped || before.pendingRequests.length) fail('BENCHMARK_EXISTING_SCOPE_STOPPED');
      report = await runNegotiationBenchmark({ fixture, agent: createMainAgent({ gateway }), budgetStatus: () => gateway.status() });
      report.allocationBefore = before;
      report.allocationAfter = await gateway.status();
    } else report = await runNegotiationBenchmark({ fixture });
  } catch {
    report.completed = false;
    report.error = 'BENCHMARK_CONFIGURATION_OR_ACCOUNTING_FAILED';
  } finally {
    try { await database?.pool.end(); } catch { report.completed = false; report.databaseCloseError = true; }
    Object.assign(report, { fixtureSha256: manifest.fixtureSha256, sourceHashes: hashes, finishedAt: new Date().toISOString(),
      costAttribution: 'Shared-scope counter differences. Attributable only during an exclusive inference window; concurrent app inference invalidates cost attribution.' });
    try { fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); } finally { fs.closeSync(output); }
    process.stdout.write(JSON.stringify({ output: flags.get('--output'), completed: report.completed, modelRun: report.modelRun, summary: report.summary ?? null, error: report.error ?? null }) + '\n');
    if (!report.completed) process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('Benchmark refused or failed. Check the frozen manifest, explicit mode, private paths and existing guarded scope. No alternate funding route is used.\n');
    process.exitCode = 1;
  });
}
