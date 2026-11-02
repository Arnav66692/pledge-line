// Runs the 10 pilot scripts as typed text through call.js in-process and grades each one.
// A dry run never counts toward the pilot bar. Use --mock for the fake PayPal and offline rules.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, assertReady, isMockConfig } from '../src/config.js';
import { buildDeps, templateWarnings } from '../src/server.js';
import { PILOT_SCRIPTS, scriptTurns } from '../src/pilot-scripts.js';
import { gradeCall } from '../src/check.js';

const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const lines = [];
const out = (line = '') => {
  lines.push(line);
  process.stdout.write(`${line}\n`);
};

function printGrade(grade) {
  const all = [...grade.facts, ...grade.writes, ...grade.safety, ...grade.behavior];
  out(grade.passed ? '    checks passed' : `    checks failed, ${all.length} ${all.length === 1 ? 'problem' : 'problems'}`);
  for (const v of all) out(`      ${v.check}, turn ${v.turn ?? 'none'}, ${v.message}`);
}

async function runOne(deps, script) {
  out(`  Script ${script.number}. ${script.title}`);
  const { callId, reply, turn: greetingTurn } = deps.calls.start({ script: script.number, userAgent: 'pilot-dry-run', dryRun: true });
  out(`    ${'line'.padEnd(14)} ${reply}`);
  // Each turn answers the reply before it, as the page says, so a yes counts only after its proposal was heard.
  let answering = greetingTurn;
  for (const turn of scriptTurns(script, deps.config.pin)) {
    const shown = turn.secret ? '#'.repeat(turn.text.length) : turn.text;
    out(`    ${`you, ${turn.source}`.padEnd(14)} ${shown}`);
    const result = await deps.calls.turn(callId, { text: turn.text, source: turn.source, answering });
    answering = result.turn;
    out(`    ${'line'.padEnd(14)} ${result.reply}`);
  }
  const grade = gradeCall(deps.ledger.byCall(callId), script);
  printGrade(grade);
  out('');
  return { script, callId, grade };
}

async function webhookStep(deps, invoiceId, isMock) {
  if (!invoiceId) {
    out('Script 5 made no invoice, so there is nothing to pay.');
    return false;
  }
  const read = deps.ledger.byType('read').filter((e) => e.id === invoiceId && e.snapshot).pop();
  out(`Script 5 invoice id ${invoiceId}`);
  if (!isMock) {
    out(`Payer page for the sandbox personal account, ${read?.snapshot?.recipient_view_url ?? 'not returned by PayPal'}`);
    out('Open it while logged in to the sandbox as the personal account, then pay it.');
    return true;
  }
  await deps.paypal.mockPay(invoiceId);
  const hit = deps.webhooks.recent().find((w) => w.eventType === 'INVOICING.INVOICE.PAID' && w.resourceId === invoiceId);
  out(`Mock payment sent. Webhook INVOICING.INVOICE.PAID for ${invoiceId}, verified ${hit?.verified === true}.`);
  return hit?.verified === true;
}

async function main() {
  const mock = args.includes('--mock');
  const env = mock ? { ...process.env, PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules' } : process.env;
  const config = loadConfig(env);
  if (!mock) assertReady(config, { need: ['paypal', 'router', 'pin', 'subscription'] });
  const isMock = isMockConfig(config);
  const label = isMock ? 'mock' : 'sandbox';
  const ledgerPath = flagValue('--ledger') ?? `.pilot/dry-run-${label}-ledger.jsonl`;
  const deps = buildDeps(config, { ledgerPath, log: { info: (l) => out(`    server ${l}`), error: (l) => out(`    server error ${l}`) } });
  if (isMock) out('MOCK RUN, does not count');
  for (const warning of templateWarnings()) out(warning);
  out(`Pledge Line dry run, does not count. PayPal ${config.paypal.mode}, router ${config.router.mode}. Ledger ${ledgerPath}`);
  out('');
  const results = [];
  for (const script of PILOT_SCRIPTS) results.push(await runOne(deps, script));
  const five = results.find((r) => r.script.number === 5);
  const invoiceId = deps.ledger.byCall(five.callId).find((e) => e.type === 'staging_write' && e.kind === 'create_draft' && e.ok)?.id ?? null;
  const webhookOk = await webhookStep(deps, invoiceId, isMock);
  const passed = results.filter((r) => r.grade.passed).length;
  out('');
  out(`${passed} of ${results.length} scripts passed the checks. This is a dry run, so it does not count.`);
  if (isMock) out('MOCK RUN, does not count');
  const transcript = path.join(path.dirname(ledgerPath), `dry-run-${label}.txt`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, `${lines.join('\n')}\n`);
  process.stdout.write(`Transcript saved to ${transcript}\n`);
  process.exitCode = passed === results.length && webhookOk ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
