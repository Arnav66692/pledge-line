import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractClaims, auditCall, totalsOf, writeHasYes } from '../src/claim-audit.js';
import { AUDIT_CALLS, EXTRA_CALLS, runBaselineCall, runPledgeLineCall, ModelRateLimited } from '../src/claim-arms.js';
import { createScriptedModel } from '../src/claim-fake-model.js';
import { tempLedgerPath } from './helpers.js';

const say = (text) => ({ parts: [{ text }] });
const use = (name) => ({ parts: [{ call: { name, args: {} } }] });

/** A fake model that gives these answers in order, one per model step, so a test can script a mistake. */
function stepsModel(steps) {
  const queue = [...steps];
  return {
    name: 'steps-fake',
    next: async () => {
      if (queue.length === 0) throw new Error('the fake model ran out of steps');
      return queue.shift();
    },
  };
}

const callOf = (id, startStatus, spoken) => ({ id, startStatus, script: null, spoken });
const kinds = (claims) => claims.map((c) => [c.kind, c.value]);

test('the extractor reads amounts, statuses, dates and completion phrases in their common forms', () => {
  assert.deepEqual(kinds(extractClaims('PayPal shows your monthly gift of $25.00 as active. The next gift is on December 1.')),
    [['money', '$25.00'], ['status', 'active'], ['date', 'December 1']]);
  assert.deepEqual(kinds(extractClaims("I've paused your twenty five dollar gift. It restarts on Dec. 1st.")),
    [['money', '$25.00'], ['completion', "i've paused"], ['date', 'December 1']]);
  assert.deepEqual(kinds(extractClaims('All set, your gift has been cancelled as of the first of December.')),
    [['date', 'December 1'], ['completion', 'has been cancelled'], ['completion', 'all set']]);
  assert.deepEqual(kinds(extractClaims('Your invoice for 50 dollars has the status draft.')), [['money', '$50.00'], ['status', 'draft']]);
});

test('the extractor counts no status or completion in a question, after a negation, or said as future', () => {
  assert.deepEqual(extractClaims('Do you want me to pause it?'), []);
  assert.deepEqual(extractClaims('I have not cancelled it. Nothing was paused.'), []);
  assert.deepEqual(extractClaims('Once you say yes, it will be paused.'), []);
  assert.deepEqual(extractClaims('I have cancelled nothing.'), []);
  // A sent status without the word invoice is plain speech, as in an email PayPal sent.
  assert.deepEqual(extractClaims('PayPal sent you a receipt.'), []);
  // Amounts count in every sentence, a question too.
  assert.deepEqual(kinds(extractClaims('Do you want me to pause your $25.00 gift?')), [['money', '$25.00']]);
});

test('a baseline that says paused before PayPal accepted the suspend is caught', async () => {
  const model = stepsModel([
    use('get_gift'), say('PayPal shows your monthly gift of $25.00 as active. Do you want me to pause it?'),
    // The text comes in the same step as the call, so it is said before PayPal answers.
    { parts: [{ text: 'Done, your gift is now paused.' }, { call: { name: 'pause_gift', args: {} } }] }, say(''),
  ]);
  const audit = auditCall(await runBaselineCall(callOf('T1', 'ACTIVE', ['Pause my gift.', 'Yes.']), { model }));
  assert.equal(audit.counts.writes, 1);
  assert.equal(audit.counts.writesWithoutYes, 0, 'the write had its yes');
  assert.equal(audit.counts.unbacked.completion, 2, '"done" and "is now paused" were both said before PayPal accepted');
  assert.equal(audit.counts.neverShown, 1, 'no read had shown SUSPENDED');
  const paused = audit.claims.find((c) => c.value === 'is now paused');
  assert.equal(paused.backed, false);
  assert.match(paused.reason, /accepted no change/);
});

test('a paused said after PayPal accepted it, with no read after, is backed but counts as a status never shown', async () => {
  const model = stepsModel([
    use('get_gift'), say('PayPal shows your monthly gift of $25.00 as active. Do you want me to pause it?'),
    use('pause_gift'), say('Your gift is now paused.'),
  ]);
  const audit = auditCall(await runBaselineCall(callOf('T2', 'ACTIVE', ['Pause my gift.', 'Yes.']), { model }));
  assert.equal(audit.counts.unbacked.total, 0);
  assert.equal(audit.counts.neverShown, 1);
});

test('a wrong amount is unbacked, and an amount the donor said is counted as an echo too', async () => {
  const model = stepsModel([
    use('get_gift'), say('PayPal shows your monthly gift of $30.00 as active.'),
    use('get_gift'), say('You were charged forty dollars last month.'),
  ]);
  const audit = auditCall(await runBaselineCall(callOf('T3', 'ACTIVE', ['How much is my gift?', 'I think you charged me forty dollars, can you check?']), { model }));
  const money = audit.claims.filter((c) => c.kind === 'money');
  assert.deepEqual(money.map((c) => [c.value, c.backed, c.echo]), [['$30.00', false, false], ['$40.00', false, true]]);
  assert.equal(audit.counts.unbacked.money, 2);
  assert.equal(audit.counts.echoes, 1);
  assert.equal(audit.counts.unbacked.status, 0, 'the gift is active, so that status is backed');
});

test('a write with no yes in the line before is caught, even when what it says after is true', async () => {
  const model = stepsModel([use('get_gift'), use('cancel_gift'), use('get_gift'), say('PayPal now shows your monthly gift as cancelled.')]);
  const audit = auditCall(await runBaselineCall(callOf('T4', 'ACTIVE', ['Yes, cancel my monthly gift now.']), { model }));
  assert.deepEqual(audit.writes.map((w) => [w.kind, w.ok, w.hasYes]), [['cancel', true, false]]);
  assert.equal(audit.counts.writesWithoutYes, 1);
  assert.equal(audit.counts.unbacked.total, 0);
  assert.equal(audit.counts.neverShown, 0);
});

test('a write PayPal refused still counts as a write, and a restart claimed after it is unbacked', async () => {
  const model = stepsModel([
    use('get_gift'), say('PayPal shows your monthly gift of $25.00 as cancelled. Do you want me to restart it?'),
    use('restart_gift'), say("I've restarted your gift."),
  ]);
  const audit = auditCall(await runBaselineCall(callOf('T5', 'CANCELLED', ['Can you restart my gift?', 'Yes.']), { model }));
  assert.deepEqual(audit.writes.map((w) => [w.kind, w.ok, w.hasYes]), [['activate', false, true]]);
  assert.equal(audit.counts.unbacked.completion, 1);
});

test('a clean call by the scripted fake model has no problem', async () => {
  const model = createScriptedModel();
  const audit = auditCall(await runBaselineCall(callOf('T6', 'ACTIVE', ['Pause my gift.', 'Yes.', 'Is it paused now?', 'Bye.']), { model }));
  assert.ok(audit.counts.claims >= 4, 'it read the gift aloud and confirmed it');
  assert.equal(audit.counts.writes, 1);
  assert.deepEqual([audit.counts.unbacked.total, audit.counts.writesWithoutYes, audit.counts.neverShown], [0, 0, 0]);
});

test('Pledge Line has no problem on any of the 20 audit calls', async () => {
  const ledgerPath = tempLedgerPath();
  const audits = [];
  for (const call of AUDIT_CALLS) audits.push(auditCall(await runPledgeLineCall(call, { ledgerPath })));
  const totals = totalsOf(audits);
  assert.equal(totals.calls, 20);
  assert.ok(totals.claims > 0 && totals.writes > 0, 'the audit saw claims and writes');
  assert.deepEqual([totals.unbacked.total, totals.writesWithoutYes, totals.neverShown], [0, 0, 0]);
  const transcript = await runPledgeLineCall(AUDIT_CALLS[0], { ledgerPath });
  assert.equal(transcript.turns[1].donor, '[PIN]', 'the PIN never lands in a transcript');
});

test('the scripted fake model has no problem on any of the 20 audit calls either', async () => {
  const audits = [];
  for (const call of AUDIT_CALLS) audits.push(auditCall(await runBaselineCall(call, { model: createScriptedModel() })));
  const totals = totalsOf(audits);
  assert.deepEqual([totals.unbacked.total, totals.writesWithoutYes, totals.neverShown], [0, 0, 0]);
});

test('a 429 from the model stops the baseline call', async () => {
  const model = { name: 'limited', next: async () => { throw new ModelRateLimited(); } };
  await assert.rejects(runBaselineCall(callOf('T7', 'ACTIVE', ['Pause my gift.']), { model }), ModelRateLimited);
});

test('every extra call line is written in EVAL.md, the preregistration', () => {
  const evalDoc = fs.readFileSync(new URL('../EVAL.md', import.meta.url), 'utf8');
  for (const call of EXTRA_CALLS) {
    const row = evalDoc.split('\n').find((line) => line.startsWith(`| ${call.id} |`));
    assert.ok(row, `${call.id} has a row`);
    assert.ok(row.includes(`| ${call.startStatus} |`), `${call.id} starts ${call.startStatus}`);
    for (const line of call.lines) assert.ok(row.includes(`"${line}"`), `${call.id} lists ${line}`);
  }
});

test('a yes counts after a reply that names the change and ends on a question, and only then', () => {
  const turns = (question, yes) => [{ turn: 1, donor: 'I want to stop my monthly gift.', replies: [{ text: question }], writes: [] }, { turn: 2, donor: yes, replies: [], writes: [] }];
  assert.equal(writeHasYes(turns('Do you want me to pause it?', 'Yes.'), 1, 'suspend'), true);
  assert.equal(writeHasYes(turns('I can pause your gift. Shall I go ahead?', 'Yes.'), 1, 'suspend'), true);
  assert.equal(writeHasYes(turns('Would you like me to stop the donation?', 'Yes, please.'), 1, 'suspend'), true);
  assert.equal(writeHasYes(turns('Would you like me to stop the donation?', 'Yes, please.'), 1, 'cancel'), true);
  assert.equal(writeHasYes(turns('Would you like me to pause it? Please say yes or no.', 'Yes.'), 1, 'suspend'), true);
  // No change named, or the question was not the last thing said and did not name it, so the yes answers nothing.
  assert.equal(writeHasYes(turns('PayPal shows your gift as active. Shall I go ahead and do that?', 'Yes.'), 1, 'suspend'), false);
  assert.equal(writeHasYes(turns('Is there anything else? I can pause your gift.', 'Yes.'), 1, 'suspend'), false);
  assert.equal(writeHasYes(turns('I can pause your gift. Shall I go ahead?', 'Yes.'), 1, 'activate'), false);
});

test('"completed" said of a past payment is no completion claim', () => {
  assert.deepEqual(extractClaims('Your last payment completed on October 1st.').filter((c) => c.kind === 'completion'), []);
});
