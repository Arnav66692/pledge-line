import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deterministicGoalDraft } from '../scripts/goal-intake-eval.js';
import { CATEGORIES, checkConversationDraft, conversationSourceHashes, pairedSignTest, runConversationEval,
  validateConversationFixture, verifyConversationFreeze, wilsonInterval, privateResponseCapture,
  observeSyntheticGateway, openPrivateTrace } from '../scripts/conversation-goal-eval.js';

const now = Date.parse('2026-11-05T20:00:00Z'), timeZone = 'America/Los_Angeles';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const goal = 'Buy 60 white cotton shirts with one navy print under USD 800. Deliver 2026-11-13T17:00:00-08:00. Use one supplier.';
const input = (value = goal, priorGoals = []) => ({ goal: value, priorGoals, now, timeZone });
function expected() {
  return { ready: true, rfq: { quantity: 60, budgetCents: 80000, currency: 'USD', deadline: '2026-11-14T01:00:00.000Z', allowSplit: false }, assumptions: [],
    requiredSpecificationFacts: [{ id: 'goods_shirts', anyOf: ['shirts', 'tees'] }, { id: 'material_cotton', anyOf: ['cotton'] },
      { id: 'color_white', anyOf: ['white'] }, { id: 'print_navy', anyOf: ['navy print'] }], forbiddenSpecificationFragments: ['polyester'] };
}
function task(id = 'C-01', category = 'explicit_controls') {
  return { id, category, family: 'public_component_fixture', now, timeZone, turns: [{ goal, expected: expected() }] };
}
function fixture(tasks = [task()]) { return { version: 1, disclosure: 'Public artificial component-test inputs, never held-out or customer evidence.', cases: tasks }; }
function balanced() { return fixture(CATEGORIES.flatMap((category, group) => Array.from({ length: 6 }, (_, index) => task(`C-${String(group * 6 + index + 1).padStart(2, '0')}`, category)))); }
const draft = (context = input()) => deterministicGoalDraft(context);

function syntheticProviderResponse() {
  return { id: 'msg_synthetic_identifier', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'tool_use', stop_sequence: null,
    usage: { input_tokens: 123, output_tokens: 45, cache_read_input_tokens: 0 },
    content: [{ type: 'tool_use', id: 'tool_synthetic_identifier', name: 'draft_procurement_brief', input: {
      ready: true, quantity: 60, budgetCents: 80000, specification: 'White cotton shirts with one navy print.', allowSplit: false,
    } }] };
}

test('private observation captures tool inputs and verified metadata before returning the unchanged response', async () => {
  const response = syntheticProviderResponse(), before = structuredClone(response), events = [], request = { system: 'request-only-private-marker', messages: [] };
  const wrapped = observeSyntheticGateway({ async anthropic(body) { assert.equal(body, request); events.push('provider'); return response; }, async jev() { throw Error('Must not call'); } },
    { persist(frame) { events.push('persist'); assert.equal(frame.metadata.model, response.model); assert.deepEqual(JSON.parse(JSON.stringify(frame.metadata.usage)), response.usage);
      assert.equal(frame.requestIdSha256, hash(response.id)); assert.equal(frame.toolDrafts[0].toolCallIdSha256, hash(response.content[0].id));
      assert.equal(frame.toolDrafts[0].input.quantity, 60); assert.equal(frame.responseIndex, 1); assert.equal(frame.captureTruncated, false);
      assert.doesNotMatch(JSON.stringify(frame), /request-only-private-marker|msg_synthetic_identifier|tool_synthetic_identifier/); } });
  assert.equal(await wrapped.anthropic(request), response); events.push('consumer');
  assert.deepEqual(events, ['provider', 'persist', 'consumer']);
  assert.deepEqual(response, before, 'Observation must not rewrite data the production agent validates.');
});

test('private observation redacts credentials, capabilities, database URIs, headers and opaque values', () => {
  const response = syntheticProviderResponse(), capability = 'q'.repeat(43);
  response.headers = { authorization: 'Bearer synthetic-header-secret' };
  response.content[0].input.apiKey = 'synthetic-api-key';
  response.content[0].input.sessionSecret = capability;
  response.content[0].input.headers = { 'x-call-secret': 'synthetic-call-secret' };
  response.content[0].input.note = `Bearer synthetic-bearer-secret postgres://reader:synthetic-password@db.invalid/store sk-ant-synthetic-key-12345 ${capability} buyer@example.test`;
  const frame = privateResponseCapture(response), serialized = JSON.stringify(frame);
  assert.equal(frame.toolDrafts[0].input.quantity, 60);
  assert.ok(frame.redactions >= 4);
  assert.doesNotMatch(serialized, /synthetic-header-secret|synthetic-api-key|synthetic-call-secret|synthetic-bearer-secret|synthetic-password|sk-ant-synthetic-key-12345|buyer@example|q{43}|"headers"/);
  assert.match(serialized, /redacted/);
});

test('private observation remains a valid bounded frame when provider diagnostics exceed the capture budget', () => {
  const response = syntheticProviderResponse(); response.content[0].input.largeExplanation = '詳細 '.repeat(15000);
  const frame = privateResponseCapture(response, { maximumBytes: 4096 });
  assert.equal(frame.captureTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= 4096);
  assert.equal(JSON.parse(JSON.stringify(frame)).kind, 'synthetic_provider_response');
  assert.equal(frame.requestIdSha256, hash(response.id));
  assert.throws(() => privateResponseCapture(response, { maximumBytes: 512 }), /TRACE_INVALID/);
});

test('observer persistence failure latches both wrapped dispatch methods without changing the funding gateway', async () => {
  let anthropicCalls = 0, jevCalls = 0, statusCalls = 0;
  const wrapped = observeSyntheticGateway({ async anthropic() { anthropicCalls += 1; return syntheticProviderResponse(); },
    async jev() { jevCalls += 1; return {}; }, async status() { statusCalls += 1; return { stopped: false }; } },
  { persist() { throw Error('synthetic-private-disk-detail'); } });
  await assert.rejects(wrapped.anthropic({}), /OBSERVER_FAILED/);
  await assert.rejects(wrapped.anthropic({}), /OBSERVER_STOPPED/);
  await assert.rejects(wrapped.jev({}), /OBSERVER_STOPPED/);
  assert.equal(anthropicCalls, 1); assert.equal(jevCalls, 0);
  assert.deepEqual(await wrapped.status(), { stopped: false }); assert.equal(statusCalls, 1);
});

test('a failed response capture preserves the failed turn and prevents all subsequent model dispatch', async () => {
  let calls = 0;
  const wrapped = observeSyntheticGateway({ async anthropic() { calls += 1; return syntheticProviderResponse(); }, async jev() { throw Error('Must not call'); } },
    { persist() { throw Error('synthetic-private-capture-failure'); } });
  const report = await runConversationEval({ fixture: fixture([task(), task('C-02', 'context_discourse')]), fullSuite: false,
    agent: { async interpretGoal(context) { await wrapped.anthropic({}); return draft(context); } } });
  assert.equal(calls, 1); assert.equal(report.completed, false);
  assert.equal(report.tasks[0].turns[0].arms.main_agent.status, 'error');
  assert.equal(report.tasks[1].turns[0].arms.main_agent.status, 'not_run');
  assert.equal(report.summary.main_agent.errorsOrNotRun, 2);
  assert.doesNotMatch(JSON.stringify(report), /synthetic-private-capture-failure/);
});

test('private trace files require private directories, exclusive0600 creation and bounded full writes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pledge-private-trace-'));
  try {
    const output = path.join(directory, 'response.jsonl'), trace = openPrivateTrace(output);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    trace.persist(privateResponseCapture(syntheticProviderResponse()));
    const original = fs.readFileSync(output, 'utf8');
    assert.equal(JSON.parse(original).kind, 'synthetic_provider_response');
    assert.throws(() => openPrivateTrace(output));
    assert.throws(() => trace.persist({ large: 'plain '.repeat(20000) }), /FRAME_TOO_LARGE/);
    assert.equal(fs.readFileSync(output, 'utf8'), original);
    trace.close(); trace.close();
    assert.throws(() => trace.persist({ kind: 'late' }), /TRACE_CLOSED/);
    const publicDirectory = path.join(directory, 'public'); fs.mkdirSync(publicDirectory); fs.chmodSync(publicDirectory, 0o755);
    assert.throws(() => openPrivateTrace(path.join(publicDirectory, 'unsafe.jsonl')), /PRIVATE_DIRECTORY_REQUIRED/);
    assert.equal(fs.existsSync(path.join(publicDirectory, 'unsafe.jsonl')), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('fixture validation fixes24 tasks/six per category and bounds every labeled turn', () => {
  const f = balanced();
  assert.equal(validateConversationFixture(f).cases.length, 24);
  assert.throws(() => validateConversationFixture(fixture()), /FIXTURE_INVALID/);
  f.cases[0].category = 'clarification';
  assert.throws(() => validateConversationFixture(f), /BALANCE_INVALID/);
  const bad = balanced(); bad.cases[0].turns[0].expected.rfq.deadline = '2027-02-30T12:00:00Z';
  assert.throws(() => validateConversationFixture(bad), /FIXTURE_INVALID/);
  const notReady = task(); notReady.turns[0].expected = { ready: false, clarificationFor: ['not_a_constraint'] };
  assert.throws(() => validateConversationFixture(fixture([notReady]), { fullSuite: false }), /FIXTURE_INVALID/);
});

test('complete drafts need every declared goods fact and reject an unwanted positive attribute', () => {
  const checked = { expected: expected(), input: input() }, value = draft();
  assert.equal(checkConversationDraft(checked, value).correct, true);
  value.rfq.specification = 'White shirts with one navy print.';
  assert.deepEqual(checkConversationDraft(checked, value).missingFactIds, ['material_cotton']);
  value.rfq.specification = 'White cotton shirts with one navy print, polyester blend.';
  assert.equal(checkConversationDraft(checked, value).forbiddenPositiveAttributes, 1);
  value.rfq.specification = 'White cotton shirts with one navy print, no polyester.';
  assert.equal(checkConversationDraft(checked, value).correct, true, 'A literal exclusion is not a positive request.');
});

test('removed attributes are local exclusions while retained or denied removals stay positive', () => {
  const checked = { expected: expected(), input: input() }, value = draft();
  for (const ending of ['omit polyester', 'remove the polyester', 'replace polyester with cotton', 'replace polyester fabric with cotton']) {
    value.rfq.specification = `White cotton shirts with one navy print; ${ending}.`;
    assert.equal(checkConversationDraft(checked, value).forbiddenPositiveAttributes, 0, ending);
  }
  for (const ending of ['do not omit polyester', "don't remove the polyester", 'don’t omit polyester', 'don’t replace polyester with cotton', 'do not remove the old polyester',
    'never replace polyester with cotton', 'replace cotton with polyester', 'replace cotton with polyester with a navy print', 'omit cotton then add polyester', 'polyester; omit polyester']) {
    value.rfq.specification = `White cotton shirts with one navy print; ${ending}.`;
    assert.equal(checkConversationDraft(checked, value).forbiddenPositiveAttributes, 1, ending);
  }
  value.rfq.specification = 'White cotton shirts with one navy print; omit cotton.';
  assert.equal(checkConversationDraft(checked, value).missingFactIds.includes('material_cotton'), false, 'The independent earlier positive occurrence is retained.');
  value.rfq.specification = 'White shirts with one navy print; omit cotton.';
  assert.equal(checkConversationDraft(checked, value).missingFactIds.includes('material_cotton'), true);
});

test('coordinated explicit exclusions remain required negative facts without requesting the contained attribute', () => {
  const checked = { expected: expected(), input: input() }, value = draft();
  checked.expected.requiredSpecificationFacts.push({ id: 'no_engraving', anyOf: ['no engraving'] });
  checked.expected.forbiddenSpecificationFragments.push('engraving');
  value.rfq.specification = 'White cotton shirts with one navy print; no handles and no engraving.';
  const result = checkConversationDraft(checked, value);
  assert.equal(result.correct, true);
  assert.equal(result.forbiddenPositiveAttributes, 0);
  value.rfq.specification = 'White cotton shirts with one navy print; not no engraving.';
  assert.ok(checkConversationDraft(checked, value).missingFactIds.includes('no_engraving'));
  value.rfq.specification = 'White cotton shirts with one navy print; not no handles and no engraving.';
  assert.ok(checkConversationDraft(checked, value).missingFactIds.includes('no_engraving'));
  value.rfq.specification = 'White cotton shirts with one navy print; no handles and engraving.';
  assert.ok(checkConversationDraft(checked, value).missingFactIds.includes('no_engraving'));
});

test('explicit suffix exclusions and ordinary negative contractions do not request forbidden materials', () => {
  const checked = { expected: expected(), input: input() }, value = draft();
  for (const ending of ['Polyester is not acceptable.', 'Polyester is forbidden.', 'Polyester isn’t allowed.', "Don't use polyester.", 'You mustn’t include polyester.']) {
    value.rfq.specification = `White cotton shirts with one navy print; ${ending}`;
    assert.equal(checkConversationDraft(checked, value).forbiddenPositiveAttributes, 0, ending);
  }
  for (const ending of ['Polyester is acceptable.', 'Polyester is not unacceptable.', 'Polyester is not required.', 'Polyester; polyester is not acceptable.']) {
    value.rfq.specification = `White cotton shirts with one navy print; ${ending}`;
    assert.equal(checkConversationDraft(checked, value).forbiddenPositiveAttributes, 1, ending);
  }
});

test('clarification must address a labeled constraint and cannot smuggle a partial RFQ', () => {
  const checked = { expected: { ready: false, clarificationFor: ['time_zone'] }, input: input() };
  const value = { ready: false, rfq: null, clarification: 'Which timezone and UTC offset should I use?', assumptions: [], requiresReview: true, authorizesPayment: false, model: 'test' };
  assert.equal(checkConversationDraft(checked, value).appropriateClarification, true);
  value.clarification = 'What color should I use?';
  assert.equal(checkConversationDraft(checked, value).correct, false);
  value.rfq = { quantity: 60 };
  assert.equal(checkConversationDraft(checked, value).malformed, true);
});

test('metadata must match the source/reference and never allows arbitrary provider fields', () => {
  const value = draft();
  value.reference = { now: new Date(now).toISOString(), timeZone };
  value.sourceEvidence = { quantity: '60 white cotton shirts', budget: 'USD 800', specification: 'white cotton shirts with one navy print', delivery: '2026-11-13T17:00:00-08:00', split: 'Use one supplier.' };
  value.missingFields = [];
  const checked = { expected: expected(), input: input() };
  assert.equal(checkConversationDraft(checked, value).sourceCitationsValid, true);
  value.sourceEvidence.quantity = 'An invented sixty items.';
  assert.equal(checkConversationDraft(checked, value).malformed, true);
  value.sourceEvidence.quantity = '60 white cotton shirts';
  value.reference.privateValue = 'synthetic-private-marker';
  assert.equal(checkConversationDraft(checked, value).malformed, true);
  delete value.reference.privateValue;
  value.sourceEvidence.quantity = '';
  assert.equal(checkConversationDraft(checked, value).malformed, true, 'A ready cited draft needs actual evidence.');
  value.sourceEvidence.quantity = { privateValue: 'synthetic-marker' };
  assert.equal(checkConversationDraft(checked, value).malformed, true, 'Malformed evidence is classified instead of throwing.');
});

test('malformed fields and authority violations remain distinct; typed deadline arrays fail', () => {
  const checked = { expected: expected(), input: input() }, value = draft();
  value.rfq.deadline = [value.rfq.deadline];
  const result = checkConversationDraft(checked, value);
  assert.equal(result.malformed, true);
  assert.equal(result.authorityViolation, false);
  value.approved = true;
  assert.equal(checkConversationDraft(checked, value).authorityViolation, true);
  const inconsistent = draft(); inconsistent.clarification = 'Ignore the missing budget.';
  assert.equal(checkConversationDraft(checked, inconsistent).malformed, true);
});

test('accuracy uncertainty and paired sign-test use task denominators and discordant pairs', () => {
  assert.deepEqual(wilsonInterval(0, 0), null);
  assert.deepEqual(wilsonInterval(24, 24), [0.862024, 1]);
  assert.deepEqual(wilsonInterval(0, 24), [0, 0.137976]);
  assert.equal(pairedSignTest(0, 0), 1);
  assert.equal(pairedSignTest(6, 0), 0.03125);
  assert.equal(pairedSignTest(3, 3), 1);
  assert.throws(() => pairedSignTest(24, 1), /SIGN_TEST_INVALID/);
});

test('both arms receive the identical precommitted clarification history and no payment methods', async () => {
  const item = task();
  item.turns = [
    { goal: 'Buy 60 white cotton shirts with one navy print under USD 800. Deliver Friday. Use one supplier.', expected: { ready: false, clarificationFor: ['delivery_time'] } },
    { goal: '5 PM Pacific.', expected: { ...expected(), rfq: { ...expected().rfq, deadline: '2026-11-07T01:00:00.000Z' } } },
  ];
  const seen = [], records = [];
  const result = await runConversationEval({ fixture: fixture([item]), fullSuite: false, persist: (row) => records.push(row), agent: {
    async interpretGoal(context) { seen.push(structuredClone(context)); return deterministicGoalDraft(context); },
    approve() { throw Error('Forbidden'); }, capture() { throw Error('Forbidden'); },
  } });
  assert.equal(result.summary.main_agent.correctTasks, 1);
  assert.equal(result.summary.main_agent.modelCalls, 2);
  assert.deepEqual(seen[1].priorGoals, [item.turns[0].goal]);
  assert.equal(seen[1].now, now); assert.equal(seen[1].timeZone, timeZone);
  assert.equal(records.filter((row) => row.kind === 'request_started').length, 2);
  assert.deepEqual(records.map((row) => row.kind), ['request_started', 'turn', 'request_started', 'turn', 'summary']);
  assert.equal(result.paired.ties, 1);
});

test('wrong earlier ready turn remains a task failure even when a later correction is right', async () => {
  const item = task(); item.turns.push({ goal: 'Keep every limit unchanged.', expected: expected() });
  let calls = 0;
  const result = await runConversationEval({ fixture: fixture([item]), fullSuite: false, agent: { async interpretGoal(context) {
    const value = draft(context); if (++calls === 1) value.rfq.budgetCents = 90000; return value;
  } } });
  assert.equal(result.summary.main_agent.correctTurns, 1);
  assert.equal(result.summary.main_agent.correctTasks, 0);
  assert.equal(result.summary.main_agent.wrongConfidentFields, 1);
  assert.equal(result.paired.baselineWins, 1);
  assert.equal(result.paired.improvementWithinThisSet, false);
});

test('failed dispatch preserves every later unrun turn and all numeric/goods denominators', async () => {
  const tasks = [task(), task('C-02', 'context_discourse')]; tasks[0].turns.push({ goal: 'Keep the same limits.', expected: expected() });
  let calls = 0;
  const result = await runConversationEval({ fixture: fixture(tasks), fullSuite: false, agent: { async interpretGoal() {
    calls += 1; throw Error('synthetic-private-failure-detail');
  } } });
  assert.equal(calls, 1);
  assert.equal(result.completed, false);
  assert.equal(result.summary.main_agent.modelCalls, 1);
  assert.equal(result.summary.main_agent.errorsOrNotRun, 3);
  assert.equal(result.summary.main_agent.scoredFields, 15);
  assert.equal(result.summary.main_agent.requiredFacts, 12);
  assert.equal(result.summary.main_agent.measuredLatencyTurns, 1);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-failure-detail/);
});

test('a failed pre-dispatch persistence barrier permits no model call', async () => {
  let calls = 0;
  const result = await runConversationEval({ fixture: fixture(), fullSuite: false,
    persist: (row) => { if (row.kind === 'request_started') throw Error('Synthetic disk refusal'); },
    agent: { async interpretGoal() { calls += 1; return draft(); } } });
  assert.equal(calls, 0);
  assert.equal(result.summary.main_agent.modelCalls, 0);
  assert.equal(result.completed, false);
});

test('raw malformed provider fields never enter bounded public output', async () => {
  const result = await runConversationEval({ fixture: fixture(), fullSuite: false, agent: { async interpretGoal() {
    const value = draft(); value.rfq.quantity = { privateValue: 'synthetic-private-marker' }; return value;
  } } });
  assert.equal(result.tasks[0].turns[0].arms.main_agent.output.rfq.quantity, null);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-marker/);
});

test('source/fixture inventory changes invalidate a frozen request', () => {
  const raw = JSON.stringify(balanced()), hashes = conversationSourceHashes();
  const manifest = { version: 1, fixtureSha256: hash(raw), sourceHashes: hashes };
  verifyConversationFreeze(raw, manifest, hashes);
  assert.throws(() => verifyConversationFreeze(raw + '\n', manifest, hashes), /FREEZE_MISMATCH/);
  assert.throws(() => verifyConversationFreeze(raw, manifest, { ...hashes, 'src/new-helper.js': 'new' }), /FREEZE_MISMATCH/);
});

test('CLI freeze archives exact source bytes exclusively and offline run needs no provider', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pledge-conversation-eval-'));
  try {
    const fixturePath = path.join(directory, 'fixture.json'), manifestPath = path.join(directory, 'manifest.json'), archive = path.join(directory, 'source'), output = path.join(directory, 'offline.jsonl');
    fs.writeFileSync(fixturePath, JSON.stringify(balanced()));
    const script = new URL('../scripts/conversation-goal-eval.js', import.meta.url).pathname;
    execFileSync(process.execPath, ['--max-old-space-size=96', script, '--freeze', '--fixture', fixturePath, '--manifest', manifestPath, '--archive', archive], { stdio: 'pipe' });
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    for (const [name, digest] of Object.entries(manifest.sourceHashes)) assert.equal(hash(fs.readFileSync(path.join(archive, name))), digest);
    assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(archive).mode & 0o777, 0o700);
    execFileSync(process.execPath, ['--max-old-space-size=96', script, '--run-offline', '--fixture', fixturePath, '--manifest', manifestPath, '--output', output], { stdio: 'pipe' });
    const rows = fs.readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows[0].modelRun, false);
    assert.equal(rows.at(-1).summary.deterministic_explicit_fields.correctTasks, 24);
    assert.throws(() => execFileSync(process.execPath, ['--max-old-space-size=96', script, '--run-offline', '--fixture', fixturePath, '--manifest', manifestPath, '--output', output], { stdio: 'pipe' }));
    const refused = path.join(directory, 'refused.jsonl');
    assert.throws(() => execFileSync(process.execPath, ['--max-old-space-size=96', script, '--run-model', '--fixture', fixturePath, '--manifest', manifestPath, '--output', refused],
      { env: { ...process.env, AI_PREPAID_ONLY_CONFIRMED: 'false', AI_BUDGET_SCOPE: 'not-authorized' }, stdio: 'pipe' }));
    assert.equal(fs.readFileSync(refused, 'utf8').trim().split('\n').map(JSON.parse).at(-1).kind, 'run_failed');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
