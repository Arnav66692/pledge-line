import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deterministicGoalDraft } from './goal-intake-eval.js';
import { canonicalZone, strictIsoInstant } from '../src/goal-grounding.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCOPE = 'pledge-line-functional-20261105';
const LIMITS = Object.freeze({ anthropic: 3_000_000_000, jev: 100_000_000 });
const FIELDS = ['quantity', 'budgetCents', 'currency', 'deadline', 'allowSplit'];
const ASSUMPTIONS = ['currency_usd', 'single_supplier_default'];
export const CATEGORIES = Object.freeze(['explicit_controls', 'context_discourse', 'clarification', 'timezone_negation_goods']);
const CLARIFICATIONS = Object.freeze({ quantity: /\b(?:quantity|count|how many|number of|units?)\b/i,
  budget: /\b(?:budget|cap|maximum|limit|total cost|total amount|how much|spend)\b/i,
  delivery_date: /\b(?:date|day|when|deadline|deliver(?:y|ed|ing)?)\b/i,
  delivery_time: /\b(?:time|hour|when|clock|deadline)\b/i,
  currency: /\b(?:currency|USD|US dollars?|EUR|euros?|dollars?)\b/i,
  time_zone: /\b(?:zone|offset|occurrence|first|second|earlier|later|clock change)\b/i,
  split_policy: /\b(?:split|supplier|one order|single order)\b/i,
  specification: /\b(?:goods|items|material|print|artwork|specification|quality|shirt)\b/i,
  source_evidence: /\b(?:restate|source|evidence|confirm|quantity|budget|delivery)\b/i });
const AUTHORITY = /^(?:approved?|approval|payments?|paypalOrderId|orderId|sessionId|sessionSecret|quoteId|capture[ds]?|checkout|autoQuote|autoPay)$/i;
const META_KEYS = ['reference', 'sourceEvidence', 'missingFields'];
const BASE_KEYS = ['ready', 'rfq', 'clarification', 'assumptions', 'requiresReview', 'authorizesPayment', 'model'];
const EVIDENCE_KEYS = ['quantity', 'budget', 'specification', 'delivery', 'split'];
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const text = (value, min, max) => typeof value === 'string' && value.trim().length >= min && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code) => { throw Error(code); };

function validDeadline(value, now) {
  if (typeof value !== 'string') return false;
  const instant = strictIsoInstant(value);
  return Boolean(instant && Date.parse(instant) > now && Date.parse(instant) - now <= 366 * 86400000);
}

export function validateConversationFixture(fixture, { fullSuite = true } = {}) {
  if (!plain(fixture) || fixture.version !== 1 || !text(fixture.disclosure, 8, 1000) || !Array.isArray(fixture.cases) ||
    !integer(fixture.cases.length, 1, 24) || fullSuite && fixture.cases.length !== 24) fail('CONVERSATION_FIXTURE_INVALID');
  const ids = new Set(), categoryCounts = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
  for (const item of fixture.cases) {
    if (!plain(item) || !/^C-\d{2}$/.test(item.id ?? '') || ids.has(item.id) || !CATEGORIES.includes(item.category) ||
      !text(item.family, 1, 80) || !integer(item.now, 0, 8640000000000000) || !text(item.timeZone, 1, 80) || !canonicalZone(item.timeZone) ||
      !Array.isArray(item.turns) || !integer(item.turns.length, 1, 3) ||
      item.turns.reduce((sum, turn) => sum + (typeof turn?.goal === 'string' ? turn.goal.length : 4001), 0) > 3000) fail('CONVERSATION_FIXTURE_INVALID');
    ids.add(item.id); categoryCounts[item.category] += 1;
    for (const turn of item.turns) {
      const expected = turn?.expected;
      if (!text(turn?.goal, 1, 1000) || !plain(expected) || typeof expected.ready !== 'boolean') fail('CONVERSATION_FIXTURE_INVALID');
      if (!expected.ready) {
        if (!Array.isArray(expected.clarificationFor) || !integer(expected.clarificationFor.length, 1, 9) ||
          new Set(expected.clarificationFor).size !== expected.clarificationFor.length || expected.clarificationFor.some((key) => !Object.hasOwn(CLARIFICATIONS, key))) fail('CONVERSATION_FIXTURE_INVALID');
        continue;
      }
      const rfq = expected.rfq, facts = expected.requiredSpecificationFacts, forbidden = expected.forbiddenSpecificationFragments;
      if (!exactKeys(rfq, FIELDS) || !integer(rfq.quantity, 1, 500) || !integer(rfq.budgetCents, 100, 10000000) || rfq.currency !== 'USD' ||
        !validDeadline(rfq.deadline, item.now) || typeof rfq.allowSplit !== 'boolean' || !Array.isArray(expected.assumptions) ||
        expected.assumptions.length > 2 || new Set(expected.assumptions).size !== expected.assumptions.length || expected.assumptions.some((code) => !ASSUMPTIONS.includes(code)) ||
        !Array.isArray(facts) || !integer(facts.length, 1, 12) || new Set(facts.map((fact) => fact?.id)).size !== facts.length ||
        facts.some((fact) => !exactKeys(fact, ['id', 'anyOf']) || !/^[a-z0-9_]{1,60}$/.test(fact.id) || !Array.isArray(fact.anyOf) ||
          !integer(fact.anyOf.length, 1, 4) || fact.anyOf.some((fragment) => !text(fragment, 1, 100))) ||
        !Array.isArray(forbidden) || forbidden.length > 8 || forbidden.some((fragment) => !text(fragment, 1, 100))) fail('CONVERSATION_FIXTURE_INVALID');
    }
  }
  if (fullSuite && Object.values(categoryCounts).some((count) => count !== 6)) fail('CONVERSATION_FIXTURE_BALANCE_INVALID');
  return fixture;
}

function literalOccurrences(value, fragment) {
  const target = value.toLowerCase(), needle = fragment.toLowerCase(), results = [];
  for (let index = target.indexOf(needle); index !== -1; index = target.indexOf(needle, index + Math.max(1, needle.length))) {
    if (/^[a-z0-9]/.test(needle) && /[a-z0-9]/.test(target[index - 1] ?? '') || /[a-z0-9]$/.test(needle) && /[a-z0-9]/.test(target[index + needle.length] ?? '')) continue;
    const before = target.slice(Math.max(0, index - 50), index).split(/[.!?;\n]/).at(-1);
    const negated = /\b(?:no|not|without|avoid|exclude|excluding|instead of|rather than)\s+(?:[a-z-]+\s+){0,3}$/.test(before);
    const historical = /\b(?:previous|previously|earlier|old|rejected|last year|last time|used to)\b/.test(before);
    results.push({ negated, historical });
  }
  return results;
}

function metadataCheck(draft, { goal, priorGoals, now, timeZone }) {
  const present = META_KEYS.some((key) => Object.hasOwn(draft, key));
  if (!present) return { valid: true, present: false, citationsValid: null };
  const referenceValid = exactKeys(draft.reference, ['now', 'timeZone']) && text(draft.reference.timeZone, 1, 80) && draft.reference.now === new Date(now).toISOString() &&
    canonicalZone(draft.reference.timeZone) === canonicalZone(timeZone);
  const missingValid = Array.isArray(draft.missingFields) && draft.missingFields.length <= 8 && new Set(draft.missingFields).size === draft.missingFields.length &&
    draft.missingFields.every((key) => Object.hasOwn(CLARIFICATIONS, key));
  const turns = [...priorGoals, goal].map((value) => value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]').trim());
  const evidenceValid = exactKeys(draft.sourceEvidence, EVIDENCE_KEYS) && EVIDENCE_KEYS.every((key) => {
    const quote = draft.sourceEvidence[key];
    if (typeof quote !== 'string' || quote.length > 500) return false;
    if (!quote) return true;
    const clauses = quote.split('\n');
    return clauses.length <= 4 && clauses.every((clause) => clause.trim() && turns.some((turn) => turn.includes(clause)));
  });
  const completeEvidence = !draft.ready || evidenceValid && ['quantity', 'budget', 'specification', 'delivery'].every((key) => draft.sourceEvidence[key].trim()) &&
    (draft.rfq?.allowSplit !== true || draft.sourceEvidence?.split?.trim());
  return { valid: Boolean(referenceValid && missingValid && evidenceValid && completeEvidence), present: true, citationsValid: evidenceValid };
}

export function checkConversationDraft({ expected, input }, draft) {
  const malformedResult = (authorityViolation = false) => ({ correct: false, malformed: true, authorityViolation,
    appropriateClarification: false, exactFields: 0, scoredFields: expected.ready ? FIELDS.length : 0, wrongConfidentFields: expected.ready && draft?.ready === true ? FIELDS.length : 0,
    prematureReady: !expected.ready && draft?.ready === true, requiredFacts: expected.requiredSpecificationFacts?.length ?? 0,
    factsPresent: 0, missingFactIds: (expected.requiredSpecificationFacts ?? []).map((fact) => fact.id), forbiddenPositiveAttributes: 0, sourceEvidencePresent: false, sourceCitationsValid: null });
  const authorityViolation = !plain(draft) || draft.authorizesPayment !== false || draft.requiresReview !== true ||
    Object.keys(draft).some((key) => AUTHORITY.test(key)) || plain(draft.rfq) && Object.keys(draft.rfq).some((key) => AUTHORITY.test(key));
  if (!plain(draft) || typeof draft.ready !== 'boolean' || draft.requiresReview !== true || draft.authorizesPayment !== false ||
    !Array.isArray(draft.assumptions) || draft.assumptions.length > 2 || new Set(draft.assumptions).size !== draft.assumptions.length ||
    draft.assumptions.some((code) => !ASSUMPTIONS.includes(code)) || !text(draft.clarification, 0, 240) ||
    Object.keys(draft).some((key) => ![...BASE_KEYS, ...META_KEYS].includes(key)) || draft.ready && draft.clarification.trim() || !draft.ready && !draft.clarification.trim()) return malformedResult(authorityViolation);
  const metadata = metadataCheck(draft, input);
  if (!metadata.valid) return malformedResult(authorityViolation);
  if (!draft.ready) {
    const appropriate = !expected.ready && draft.rfq === null && draft.clarification.trim() && expected.clarificationFor.some((key) =>
      CLARIFICATIONS[key].test(draft.clarification) || draft.missingFields?.includes(key));
    return { ...malformedResult(authorityViolation), correct: Boolean(appropriate), malformed: draft.rfq !== null, appropriateClarification: Boolean(appropriate),
      sourceEvidencePresent: metadata.present, sourceCitationsValid: metadata.citationsValid };
  }
  const rfq = draft.rfq;
  const validRfq = exactKeys(rfq, [...FIELDS, 'specification']) && integer(rfq.quantity, 1, 500) && integer(rfq.budgetCents, 100, 10000000) &&
    rfq.currency === 'USD' && validDeadline(rfq.deadline, input.now) && typeof rfq.allowSplit === 'boolean' && text(rfq.specification, 8, 1000);
  if (!validRfq) return malformedResult(authorityViolation);
  const exactFields = expected.ready ? FIELDS.filter((key) => key === 'deadline'
    ? strictIsoInstant(rfq.deadline) === strictIsoInstant(expected.rfq.deadline) : rfq[key] === expected.rfq[key]).length : 0;
  const missingFactIds = (expected.requiredSpecificationFacts ?? []).filter((fact) => !fact.anyOf.some((fragment) => literalOccurrences(rfq.specification, fragment).some((occurrence) => !occurrence.negated && !occurrence.historical))).map((fact) => fact.id);
  const forbiddenPositiveAttributes = (expected.forbiddenSpecificationFragments ?? []).filter((fragment) => literalOccurrences(rfq.specification, fragment).some((occurrence) => !occurrence.negated && !occurrence.historical)).length;
  const assumptionsMatch = expected.ready && JSON.stringify([...draft.assumptions].sort()) === JSON.stringify([...expected.assumptions].sort());
  const correct = Boolean(expected.ready && exactFields === FIELDS.length && !missingFactIds.length && !forbiddenPositiveAttributes && assumptionsMatch && !authorityViolation);
  return { correct, malformed: false, authorityViolation, appropriateClarification: false, exactFields, scoredFields: expected.ready ? FIELDS.length : 0,
    wrongConfidentFields: expected.ready ? FIELDS.length - exactFields : 0, prematureReady: !expected.ready,
    requiredFacts: expected.requiredSpecificationFacts?.length ?? 0, factsPresent: (expected.requiredSpecificationFacts?.length ?? 0) - missingFactIds.length,
    missingFactIds, forbiddenPositiveAttributes, assumptionsMatch: Boolean(assumptionsMatch),
    sourceEvidencePresent: metadata.present, sourceCitationsValid: metadata.citationsValid };
}

export function wilsonInterval(correct, total) {
  if (!integer(total, 0, 10000) || !integer(correct, 0, total) || !total) return null;
  const z = 1.959963984540054, p = correct / total, denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const radius = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator;
  return [Math.max(0, center - radius), Math.min(1, center + radius)].map((value) => Math.round(value * 1e6) / 1e6);
}

export function pairedSignTest(wins, losses) {
  if (!integer(wins, 0, 24) || !integer(losses, 0, 24) || wins + losses > 24) fail('CONVERSATION_SIGN_TEST_INVALID');
  const n = wins + losses;
  if (!n) return 1;
  let probability = 2 ** -n, tail = probability;
  for (let k = 1; k <= Math.min(wins, losses); k += 1) { probability *= (n - k + 1) / k; tail += probability; }
  return Math.min(1, Math.round(2 * tail * 1e6) / 1e6);
}

function safeOutput(draft) {
  const rfq = draft?.rfq;
  return { ready: draft?.ready === true, rfq: draft?.ready === true && plain(rfq) ? {
    quantity: integer(rfq.quantity, 1, 500) ? rfq.quantity : null, budgetCents: integer(rfq.budgetCents, 100, 10000000) ? rfq.budgetCents : null,
    currency: rfq.currency === 'USD' ? 'USD' : 'unsupported', deadline: strictIsoInstant(rfq.deadline), allowSplit: typeof rfq.allowSplit === 'boolean' ? rfq.allowSplit : null } : null,
    missingFields: Array.isArray(draft?.missingFields) ? draft.missingFields.filter((key) => Object.hasOwn(CLARIFICATIONS, key)).slice(0, 8) : [] };
}

function allocationDelta(before, after) {
  if (!before || !after || before.scope !== SCOPE || after.scope !== SCOPE) return null;
  const result = {};
  for (const provider of ['anthropic', 'jev']) {
    const a = before.accounts?.[provider], b = after.accounts?.[provider];
    if (a?.allocationNanos !== LIMITS[provider] || b?.allocationNanos !== LIMITS[provider] || !integer(a.usedNanos, 0, Number.MAX_SAFE_INTEGER) ||
      !integer(b.usedNanos, a.usedNanos, Number.MAX_SAFE_INTEGER)) return null;
    result[provider] = b.usedNanos - a.usedNanos;
  }
  return result;
}

function scopeAvailable(status) {
  return status?.scope === SCOPE && status.stopped === false && Array.isArray(status.pendingRequests) && status.pendingRequests.length === 0 &&
    Object.entries(LIMITS).every(([provider, limit]) => status.accounts?.[provider]?.allocationNanos === limit);
}

export async function runConversationEval({ fixture, agent = null, budgetStatus = null, persist = () => {}, verify = () => {}, clock = () => performance.now(), fullSuite = true } = {}) {
  validateConversationFixture(fixture, { fullSuite });
  const report = { version: 1, modelRun: Boolean(agent), completed: true, modelInterrupted: false, tasks: [] };
  for (const item of fixture.cases) {
    const task = { id: item.id, category: item.category, family: item.family, turns: [] };
    for (const [turnIndex, turn] of item.turns.entries()) {
      const input = { goal: turn.goal, priorGoals: item.turns.slice(0, turnIndex).map((entry) => entry.goal), now: item.now, timeZone: item.timeZone };
      const row = { kind: 'turn', taskId: item.id, category: item.category, turn: turnIndex + 1, expectedReady: turn.expected.ready, arms: {} };
      for (const arm of ['deterministic_explicit_fields', ...(agent ? ['main_agent'] : [])]) {
        if (arm === 'main_agent' && report.modelInterrupted) { row.arms[arm] = { status: 'not_run', error: 'MODEL_INTERRUPTED', latencyMs: null, apiAllocationDeltaNanos: null }; continue; }
        const began = clock(); let before = null, after = null, modelCallAttempted = false;
        try {
          if (arm === 'main_agent') {
            verify();
            if (budgetStatus) { before = await budgetStatus(); if (!scopeAvailable(before)) fail('CONVERSATION_SCOPE_UNAVAILABLE'); }
            persist({ kind: 'request_started', taskId: item.id, turn: turnIndex + 1, recordedAt: new Date().toISOString() });
            modelCallAttempted = true;
          }
          const draft = arm === 'main_agent' ? await agent.interpretGoal(input) : deterministicGoalDraft(input);
          if (arm === 'main_agent' && budgetStatus) after = await budgetStatus();
          row.arms[arm] = { status: 'completed', ...checkConversationDraft({ expected: turn.expected, input }, draft), output: safeOutput(draft),
            modelCallAttempted, latencyMs: Math.max(0, Math.round(clock() - began)), apiAllocationDeltaNanos: arm === 'main_agent' ? allocationDelta(before, after) : { anthropic: 0, jev: 0 } };
          if (after && !scopeAvailable(after)) { report.completed = false; report.modelInterrupted = true; }
        } catch {
          if (arm === 'main_agent' && budgetStatus) { try { after = await budgetStatus(); } catch { /* Preserve unavailable accounting as null. */ } }
          row.arms[arm] = { status: 'error', error: 'CONVERSATION_ARM_FAILED', modelCallAttempted, latencyMs: Math.max(0, Math.round(clock() - began)), apiAllocationDeltaNanos: allocationDelta(before, after) };
          report.completed = false;
          if (arm === 'main_agent') report.modelInterrupted = true;
        }
      }
      task.turns.push(row); persist(row);
    }
    report.tasks.push(task);
  }
  const arms = ['deterministic_explicit_fields', ...(agent ? ['main_agent'] : [])];
  report.summary = Object.fromEntries(arms.map((arm) => {
    const rows = report.tasks.flatMap((task) => task.turns.map((turn) => turn.arms[arm]));
    const correctTasks = report.tasks.filter((task) => task.turns.every((turn) => turn.arms[arm].correct)).length;
    return [arm, { tasks: report.tasks.length, correctTasks, taskAccuracyWilson95: wilsonInterval(correctTasks, report.tasks.length), turns: rows.length,
      correctTurns: rows.filter((row) => row.correct).length, appropriateClarifications: rows.filter((row) => row.appropriateClarification).length,
      exactFields: rows.reduce((sum, row) => sum + (row.exactFields ?? 0), 0),
      scoredFields: fixture.cases.flatMap((task) => task.turns).filter((turn) => turn.expected.ready).length * FIELDS.length,
      wrongConfidentFields: rows.reduce((sum, row) => sum + (row.wrongConfidentFields ?? 0), 0), prematureReadyTurns: rows.filter((row) => row.prematureReady).length,
      authorityViolations: rows.filter((row) => row.authorityViolation).length, malformedOutputs: rows.filter((row) => row.malformed).length,
      requiredFacts: fixture.cases.flatMap((task) => task.turns).reduce((sum, turn) => sum + (turn.expected.requiredSpecificationFacts?.length ?? 0), 0), factsPresent: rows.reduce((sum, row) => sum + (row.factsPresent ?? 0), 0),
      forbiddenPositiveAttributes: rows.reduce((sum, row) => sum + (row.forbiddenPositiveAttributes ?? 0), 0), errorsOrNotRun: rows.filter((row) => row.status !== 'completed').length,
      modelCalls: rows.filter((row) => row.modelCallAttempted).length,
      measuredLatencyTurns: rows.filter((row) => row.latencyMs !== null).length,
      meanLatencyMs: Math.round(rows.reduce((sum, row) => sum + (row.latencyMs ?? 0), 0) / Math.max(1, rows.filter((row) => row.latencyMs !== null).length)),
      knownSharedScopeDeltaNanos: Object.fromEntries(['anthropic', 'jev'].map((provider) => [provider, rows.reduce((sum, row) => sum + (row.apiAllocationDeltaNanos?.[provider] ?? 0), 0)])),
      unmeasuredCostTurns: rows.filter((row) => row.apiAllocationDeltaNanos === null).length,
      byCategory: Object.fromEntries(CATEGORIES.map((category) => {
        const tasks = report.tasks.filter((task) => task.category === category);
        return [category, { tasks: tasks.length, correct: tasks.filter((task) => task.turns.every((turn) => turn.arms[arm].correct)).length }];
      })) }];
  }));
  if (agent) {
    let wins = 0, losses = 0, ties = 0;
    for (const task of report.tasks) {
      const baseline = task.turns.every((turn) => turn.arms.deterministic_explicit_fields.correct), model = task.turns.every((turn) => turn.arms.main_agent.correct);
      if (model && !baseline) wins += 1; else if (baseline && !model) losses += 1; else ties += 1;
    }
    const m = report.summary.main_agent, b = report.summary.deterministic_explicit_fields;
    const controlsNoRegression = report.tasks.filter((task) => task.category === 'explicit_controls').every((task) => !task.turns.every((turn) => turn.arms.deterministic_explicit_fields.correct) || task.turns.every((turn) => turn.arms.main_agent.correct));
    const controlsAllCorrect = m.byCategory.explicit_controls.correct === m.byCategory.explicit_controls.tasks;
    report.paired = { modelWins: wins, baselineWins: losses, ties, signTestTwoSidedP: pairedSignTest(wins, losses), controlsNoRegression, controlsAllCorrect,
      improvementWithinThisSet: report.completed && m.correctTasks > b.correctTasks && controlsNoRegression && m.wrongConfidentFields === 0 &&
        controlsAllCorrect && m.prematureReadyTurns === 0 && m.authorityViolations === 0 && m.errorsOrNotRun === 0 && m.malformedOutputs === 0 && m.forbiddenPositiveAttributes === 0 };
  }
  persist({ kind: 'summary', completed: report.completed, modelRun: report.modelRun, summary: report.summary, paired: report.paired ?? null,
    costAttribution: 'Shared allocation deltas; concurrent outside app inference was not excluded. These are not verified provider balances or exclusive charges.',
    limitation: 'Small independently authored synthetic tasks. Lexical goods/source checks are not complete semantic fidelity, customer validation, economic benefit or a judging score.' });
  return report;
}

export function conversationSourceHashes(root = ROOT) {
  const names = ['scripts/conversation-goal-eval.js', 'scripts/goal-intake-eval.js', 'docs/CONVERSATION-GOAL-EVAL.md'];
  const collect = (directory) => { for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const name = `${directory}/${entry.name}`; if (entry.isDirectory()) collect(name); else if (entry.isFile() && entry.name.endsWith('.js')) names.push(name);
  } };
  collect('src');
  return Object.fromEntries(names.sort().map((name) => [name, hash(fs.readFileSync(path.join(root, name)))]));
}

export function verifyConversationFreeze(fixtureText, manifest, hashes) {
  if (manifest?.version !== 1 || manifest.fixtureSha256 !== hash(fixtureText) ||
    JSON.stringify(manifest.sourceHashes) !== JSON.stringify(hashes)) fail('CONVERSATION_FREEZE_MISMATCH');
}

function boundedFile(file, limit = 512 * 1024) {
  if (fs.statSync(file).size > limit) fail('CONVERSATION_FILE_TOO_LARGE');
  return fs.readFileSync(file, 'utf8');
}

function verifyArchive(manifest) {
  if (!text(manifest.archive, 1, 4096)) fail('CONVERSATION_ARCHIVE_INVALID');
  for (const [name, digest] of Object.entries(manifest.sourceHashes)) if (hash(fs.readFileSync(path.join(manifest.archive, name))) !== digest) fail('CONVERSATION_ARCHIVE_MISMATCH');
}

async function main(args) {
  const flags = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!['--freeze', '--run-offline', '--run-model', '--fixture', '--manifest', '--archive', '--output'].includes(name) || flags.has(name)) fail('CONVERSATION_USAGE');
    flags.set(name, ['--fixture', '--manifest', '--archive', '--output'].includes(name) ? args[++index] : true);
  }
  if (['--freeze', '--run-offline', '--run-model'].filter((name) => flags.has(name)).length !== 1 || typeof flags.get('--fixture') !== 'string' || typeof flags.get('--manifest') !== 'string') fail('CONVERSATION_USAGE');
  const fixtureText = boundedFile(flags.get('--fixture')), fixture = validateConversationFixture(JSON.parse(fixtureText)), hashes = conversationSourceHashes();
  if (flags.has('--freeze')) {
    if (typeof flags.get('--archive') !== 'string' || flags.has('--output')) fail('CONVERSATION_USAGE');
    const archive = path.resolve(flags.get('--archive'));
    fs.mkdirSync(archive, { mode: 0o700 });
    for (const name of Object.keys(hashes)) {
      const target = path.join(archive, name); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, fs.readFileSync(path.join(ROOT, name)), { flag: 'wx', mode: 0o600 });
    }
    const manifest = { version: 1, frozenAt: new Date().toISOString(), caseCount: fixture.cases.length,
      fixtureSha256: hash(fixtureText), sourceHashes: hashes, archive,
      disclosure: 'Independent developer case authorship; synthetic tasks, not actual customers. Source bytes archived before inference.' };
    verifyArchive(manifest);
    fs.writeFileSync(flags.get('--manifest'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify({ frozen: true, caseCount: manifest.caseCount, fixtureSha256: manifest.fixtureSha256, sourceFiles: Object.keys(hashes).length }) + '\n');
    return;
  }
  if (typeof flags.get('--output') !== 'string' || flags.has('--archive')) fail('CONVERSATION_USAGE');
  const manifest = JSON.parse(boundedFile(flags.get('--manifest')));
  verifyConversationFreeze(fixtureText, manifest, hashes); verifyArchive(manifest);
  if (manifest.caseCount !== fixture.cases.length) fail('CONVERSATION_FREEZE_MISMATCH');
  const fd = fs.openSync(flags.get('--output'), 'wx', 0o600);
  const persist = (row) => { fs.writeFileSync(fd, JSON.stringify({ ...row, recordedAt: new Date().toISOString() }) + '\n'); fs.fsyncSync(fd); };
  let database;
  try {
    persist({ kind: 'run_started', fixtureSha256: manifest.fixtureSha256, sourceHashes: hashes, modelRun: flags.has('--run-model') });
    let agent = null, budgetStatus = null;
    if (flags.has('--run-model')) {
      if (process.env.AI_PREPAID_ONLY_CONFIRMED !== 'true' || process.env.AI_BUDGET_SCOPE !== SCOPE ||
        !['3', '3.00'].includes(process.env.AI_ANTHROPIC_LIMIT_USD) || !['0.1', '0.10'].includes(process.env.AI_JEV_LIMIT_USD)) fail('CONVERSATION_EXISTING_SCOPE_REQUIRED');
      const [{ connectDatabase }, { createAiBudget }, { createAiGateway }, { createMainAgent }] = await Promise.all([
        import('../src/database.js'), import('../src/ai-budget.js'), import('../src/ai-gateway.js'), import('../src/agent.js')]);
      database = await connectDatabase(process.env.DATABASE_URL);
      const budget = createAiBudget({ pool: database.pool, scope: SCOPE, limits: LIMITS }); await budget.checkSchema();
      const gateway = createAiGateway({ budget, anthropicApiKey: process.env.ANTHROPIC_API_KEY, jevApiKey: process.env.TYPESAFE_API_KEY });
      agent = createMainAgent({ gateway }); budgetStatus = () => gateway.status();
      if (!scopeAvailable(await budgetStatus())) fail('CONVERSATION_EXISTING_SCOPE_UNAVAILABLE');
    }
    const report = await runConversationEval({ fixture, agent, budgetStatus, persist,
      verify: () => { verifyConversationFreeze(boundedFile(flags.get('--fixture')), manifest, conversationSourceHashes()); verifyArchive(manifest); } });
    process.stdout.write(JSON.stringify({ output: flags.get('--output'), completed: report.completed, summary: report.summary, paired: report.paired ?? null }) + '\n');
    if (!report.completed) process.exitCode = 1;
  } catch {
    persist({ kind: 'run_failed', error: 'CONVERSATION_CONFIGURATION_OR_PERSISTENCE_FAILED' }); process.exitCode = 1;
  } finally {
    try { await database?.pool.end(); } catch { persist({ kind: 'close_failed', error: 'CONVERSATION_DATABASE_CLOSE_FAILED' }); process.exitCode = 1; }
    fs.closeSync(fd);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(() => {
  process.stderr.write('Conversation evaluation refused or failed. Frozen inputs and the existing guarded scope remain required; no alternate funding route is used.\n'); process.exitCode = 1;
});
