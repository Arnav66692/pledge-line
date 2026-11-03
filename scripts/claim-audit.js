// Runs the claim audit of EVAL.md over both arms and writes a markdown table and a JSON file under
// .pilot/claim-audit/ in the checkout it runs from. --fake uses the scripted fake model and needs no key.
// Without --fake it calls Gemini, which EVAL.md allows only after the pilot is graded and Arnav says go.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, PILOT_LEDGER } from '../src/config.js';
import { AUDIT_CALLS, MISHEARING_BLOCK, runPledgeLineCall, runBaselineCall, ModelRateLimited } from '../src/claim-arms.js';
import { createScriptedModel } from '../src/claim-fake-model.js';
import { auditCall, totalsOf, changesOf } from '../src/claim-audit.js';
import { blockVerdict } from '../src/claim-verdicts.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '.pilot', 'claim-audit');
const TIME_ZONE = 'America/Los_Angeles';
const FLAGS = new Set(['--fake']);
const USAGE = 'Usage: npm run audit -- --fake, or npm run audit for the real Gemini run once the pilot is graded.';
// The same spacing as scripts/pilot-dry-run.js, so the free tier's per-minute limit holds.
const GEMINI_GAP_MS = 4500;
const GEMINI_TIMEOUT_MS = 20000;
const GEMINI_MAX_TOKENS = 600;
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const FAKE_LABEL = 'FAKE MODEL, a plumbing check, not a result.';
// The code still calls the block "mishearing", but M2 is code switching and M3 a long-call question (EVAL.md, Tue Nov 3).
const BLOCK_NAME = 'speech and long-call block';
const BLOCK_NOTE = 'M1, M4 and M5 are mishearings, text edits written by hand. M2 is code switching and M3 is a grounding question late in a long call, so neither is a mishearing.';

const out = (line = '') => process.stdout.write(`${line}\n`);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function readFlags(argv) {
  for (const arg of argv) if (!FLAGS.has(arg)) throw new Error(`Unknown flag ${arg}. ${USAGE}`);
  return { fake: argv.includes('--fake') };
}

// The audit writes only inside .pilot/claim-audit/, so it runs from any checkout and never touches the pilot ledger.
function refuseOutsideOutDir(file) {
  const target = path.resolve(file);
  if (target === path.resolve(ROOT, PILOT_LEDGER) || path.dirname(target) !== OUT_DIR) {
    throw new Error(`The audit writes only inside ${OUT_DIR}, never ${PILOT_LEDGER}, so it refused ${target}.`);
  }
  return target;
}

/** Gemini parts for the neutral messages. A model turn goes back with its own raw parts, thought signatures kept. */
function geminiContents(messages) {
  return messages.map((m) => {
    if (m.role === 'donor') return { role: 'user', parts: [{ text: m.text }] };
    if (m.role === 'tools') return { role: 'user', parts: m.results.map((r) => ({ functionResponse: { name: r.name, response: r.result } })) };
    const parts = m.raw ?? m.parts.map((p) => (p.call ? { functionCall: { name: p.call.name, args: p.call.args ?? {} } } : { text: p.text }));
    return { role: 'model', parts };
  });
}

/** Gemini with function calling, spaced like the dry run. It stops on a 429 and never logs a body or the key. */
function createGeminiModel({ apiKey, model, fetchImpl = fetch }) {
  const url = `${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent`;
  let lastAt = 0;
  async function next({ system, tools, messages }) {
    const wait = lastAt + GEMINI_GAP_MS - Date.now();
    if (lastAt > 0 && wait > 0) await sleep(wait);
    lastAt = Date.now();
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: geminiContents(messages),
        tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description })) }],
        generationConfig: { maxOutputTokens: GEMINI_MAX_TOKENS },
      }),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });
    if (response.status === 429) throw new ModelRateLimited();
    if (!response.ok) throw new Error(`Gemini answered ${response.status}.`);
    const raw = (await response.json())?.candidates?.[0]?.content?.parts ?? [];
    const parts = raw.map((p) => (p.functionCall ? { call: { name: p.functionCall.name, args: p.functionCall.args ?? {} } }
      : typeof p.text === 'string' && !p.thought ? { text: p.text } : null)).filter(Boolean);
    return { parts, raw };
  }
  return { name: model, next };
}

function realModel() {
  const config = loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'gemini', GEMINI_API_KEY: process.env.GEMINI_API_KEY, GEMINI_MODEL: process.env.GEMINI_MODEL }, { partial: true });
  if (!config.router.apiKey) throw new Error('GEMINI_API_KEY is not set, so the real run cannot start. Use --fake for a run with no key.');
  return createGeminiModel({ apiKey: config.router.apiKey, model: config.router.model });
}

function stampPT(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}${parts.second}-pt`;
}

const cell = (c) => `${c.unbacked.total} | ${c.writesWithoutYes} | ${c.neverShown}`;
const split = (u) => `${u.money} / ${u.status} / ${u.date} / ${u.completion}`;

function problemLines(audits) {
  const lines = [];
  for (const a of audits) {
    for (const c of a.claims.filter((x) => !x.backed || x.neverShown || (x.echo && x.ownDraftOnly))) {
      const why = [!c.backed ? `unbacked, ${c.reason}` : null, c.backed && c.ownDraftOnly ? 'backed only by a draft invoice this reply made' : null, c.neverShown ? 'a status PayPal never showed' : null, c.echo ? 'echoes the donor' : null].filter(Boolean).join(', ');
      lines.push(`- Arm ${a.arm}, ${a.id}, turn ${c.turn}, ${c.kind} "${c.said}", ${why}. Said in "${c.sentence}"`);
    }
    for (const w of a.writes.filter((x) => !x.hasYes)) {
      lines.push(`- Arm ${a.arm}, ${a.id}, turn ${w.turn}, ${w.kind} with no yes in the line before, PayPal ${w.ok ? 'accepted' : 'refused'} it. The line asked "${w.replyBefore ?? ''}" and the donor said "${w.donor ?? ''}"`);
    }
  }
  return lines;
}

const BLOCK_IDS = new Set(AUDIT_CALLS.filter((call) => call.block === MISHEARING_BLOCK).map((call) => call.id));
const inBlock = (audit) => BLOCK_IDS.has(audit.id);

/** The totals EVAL.md asks for, all calls, the first 20 on their own, and the mishearing block on its own. */
function partTotals(audits) {
  return { all: totalsOf(audits), first20: totalsOf(audits.filter((x) => !inBlock(x))), mishearing: totalsOf(audits.filter(inBlock)) };
}

// The measures don't score whether a line picked a pause or a cancel, so the block's accepted changes are named (EVAL.md).
function blockChanges(a, b) {
  return a.filter(inBlock).map((x) => `| ${x.id} | ${changesOf(x)} | ${changesOf(b.find((y) => y.id === x.id) ?? { writes: [] })} |`);
}

function verdictLines(verdicts) {
  const sentence = (text) => `${text[0].toUpperCase()}${text.slice(1)}.`;
  return verdicts.map((v) => `| ${v.id} | ${v.pass ? 'pass' : 'miss'} | ${v.misses.map(sentence).join(' ')} |`);
}

function markdown({ label, modelName, a, b, totals, verdicts }) {
  const rows = a.map((x, i) => `| ${x.id} | ${x.counts.claims} | ${cell(x.counts)} | ${b[i].counts.claims} | ${cell(b[i].counts)} |`);
  const total = (name, t) => `| ${name} | ${t.calls} | ${t.callsWithProblems} | ${t.claims} | ${t.unbacked.total} | ${split(t.unbacked)} | ${t.echoes} | ${t.ownDraftEchoes} | ${t.writes} | ${t.writesWithoutYes} | ${t.neverShown} |`;
  const parts = { A: partTotals(a), B: partTotals(b) };
  const problems = problemLines([...a, ...b]);
  const changes = blockChanges(a, b);
  const missed = verdicts.filter((v) => !v.pass).map((v) => v.id);
  const noProblem = missed.length ? `None in either arm by the measures. Pledge Line still missed its preregistered verdict on ${missed.join(', ')}, listed above.` : 'None in either arm.';
  return [
    '# Claim audit', '', label, '', `Arm A is Pledge Line with the rules router. Arm B is the free text baseline, model ${modelName}. Both run on the mock PayPal. EVAL.md says what each number means.`, '',
    '| Arm | Calls | Calls with a problem | Claims | Unbacked | Money / status / date / completion | Echoed amounts | Echoes backed only by its own draft | Writes | Writes with no yes | Status never shown |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    total('A, Pledge Line', totals.A), total('B, baseline', totals.B),
    total('A, first 20 calls', parts.A.first20), total('B, first 20 calls', parts.B.first20),
    total(`A, ${BLOCK_NAME}`, parts.A.mishearing), total(`B, ${BLOCK_NAME}`, parts.B.mishearing), '',
    'Echoed amounts counts an unbacked amount the donor said. The column after it, added Tue Nov 3, counts an amount the donor said that is backed only by a draft invoice the same arm made in that reply. Add the two for every echo.', '',
    ...(changes.length ? [`## ${BLOCK_NAME[0].toUpperCase()}${BLOCK_NAME.slice(1)}, M1 to M5`, '', BLOCK_NOTE, '',
      '### Changes PayPal accepted', '', 'The measures don\'t score whether a line picked a pause or a cancel, so each arm\'s accepted changes are named here, draft invoices included.', '',
      '| Call | A accepted | B accepted |', '|---|---|---|', ...changes, ''] : []),
    ...(verdicts.length ? ['### Pledge Line\'s preregistered verdicts', '', 'Written in EVAL.md before either arm ran on these calls. They set no bar, and a miss is reported here.', '',
      '| Call | Arm A | What missed |', '|---|---|---|', ...verdictLines(verdicts), ''] : []),
    '| Call | A claims | A unbacked | A writes with no yes | A status never shown | B claims | B unbacked | B writes with no yes | B status never shown |',
    '|---|---|---|---|---|---|---|---|---|', ...rows, '',
    '## Every problem', '', ...(problems.length ? problems : [noProblem]), '',
    'The baseline has no PIN step, so it starts verified and skips the keypad lines. That favors the baseline.', '',
  ].join('\n');
}

async function runArms(model) {
  const ledgerPath = refuseOutsideOutDir(path.join(OUT_DIR, `arm-a-ledger-${stampPT()}.jsonl`));
  const a = [];
  const b = [];
  const verdicts = [];
  for (const call of AUDIT_CALLS) {
    const transcript = await runPledgeLineCall(call, { ledgerPath });
    const pledgeLine = auditCall(transcript, { timeZone: TIME_ZONE });
    try {
      b.push(auditCall(await runBaselineCall(call, { model, timeZone: TIME_ZONE }), { timeZone: TIME_ZONE }));
    } catch (error) {
      // A 429 stops the run. The calls before it are kept, and the report says where it stopped.
      if (error instanceof ModelRateLimited) return { a, b, verdicts, ledgerPath, stoppedAt: call.id };
      throw error;
    }
    a.push(pledgeLine);
    if (call.block === MISHEARING_BLOCK) verdicts.push(blockVerdict(transcript, pledgeLine));
    out(`  ${call.id.padEnd(4)} A ${cell(a.at(-1).counts)}   B ${cell(b.at(-1).counts)}`);
  }
  return { a, b, verdicts, ledgerPath, stoppedAt: null };
}

async function main() {
  const { fake } = readFlags(process.argv.slice(2));
  const model = fake ? createScriptedModel({ timeZone: TIME_ZONE }) : realModel();
  let label = fake ? FAKE_LABEL : `Real run, ${new Date().toISOString()}.`;
  out(label);
  out('Per call, unbacked | writes with no yes | status never shown');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { a, b, verdicts, ledgerPath, stoppedAt } = await runArms(model);
  if (stoppedAt) {
    label = `${label} Stopped at ${stoppedAt} on a 429, so this covers ${a.length} of ${AUDIT_CALLS.length} calls.`;
    process.exitCode = 1;
  }
  const totals = { A: totalsOf(a), B: totalsOf(b) };
  const parts = { A: partTotals(a), B: partTotals(b) };
  const base = path.join(OUT_DIR, `claim-audit-${fake ? 'fake' : 'real'}-${stampPT()}`);
  for (const file of [`${base}.md`, `${base}.json`]) refuseOutsideOutDir(file);
  const table = markdown({ label, modelName: model.name, a, b, totals, verdicts });
  fs.writeFileSync(`${base}.md`, table);
  fs.writeFileSync(`${base}.json`, `${JSON.stringify({ label, fake, stoppedAt, model: model.name, timeZone: TIME_ZONE, totals, parts, verdicts, arms: { A: a, B: b } }, null, 2)}\n`);
  out('');
  out(table);
  out(`Wrote ${base}.md and ${base}.json. Pledge Line's ledger for this run is ${ledgerPath}.`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
