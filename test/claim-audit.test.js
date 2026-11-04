import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractClaims, auditCall, totalsOf, writeHasYes, checkClaim, changesOf } from '../src/claim-audit.js';
import { blockVerdict } from '../src/claim-verdicts.js';
import { AUDIT_CALLS, EXTRA_CALLS, MISHEARING_CALLS, MISHEARING_BLOCK, runBaselineCall, runPledgeLineCall, ModelRateLimited } from '../src/claim-arms.js';
import { createScriptedModel } from '../src/claim-fake-model.js';
import { gateViewOf, gateMarkdown, GATE_NOTE, TEMPLATE_NOTE } from '../src/claim-gate.js';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { copyProject, tempLedgerPath } from './helpers.js';

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

// The 20 calls preregistered on Mon Nov 2, before the mishearing block was added.
const FIRST_20 = AUDIT_CALLS.filter((call) => call.block === undefined);

test('Pledge Line has no problem on any of the 20 audit calls', async () => {
  const ledgerPath = tempLedgerPath();
  const audits = [];
  for (const call of FIRST_20) audits.push(auditCall(await runPledgeLineCall(call, { ledgerPath })));
  const totals = totalsOf(audits);
  assert.equal(totals.calls, 20);
  assert.ok(totals.claims > 0 && totals.writes > 0, 'the audit saw claims and writes');
  assert.deepEqual([totals.unbacked.total, totals.writesWithoutYes, totals.neverShown], [0, 0, 0]);
  const transcript = await runPledgeLineCall(AUDIT_CALLS[0], { ledgerPath });
  assert.equal(transcript.turns[1].donor, '[PIN]', 'the PIN never lands in a transcript');
});

test('the scripted fake model has no problem on any of the 20 audit calls either', async () => {
  const audits = [];
  for (const call of FIRST_20) audits.push(auditCall(await runBaselineCall(call, { model: createScriptedModel() })));
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

// The mishearing block, add-on A6, preregistered in EVAL.md's change log on Tue Nov 3, 2026.
const evalLines = () => fs.readFileSync(new URL('../EVAL.md', import.meta.url), 'utf8').split('\n');
const blockRow = (call) => `| ${call.id} | ${call.startStatus} | ${call.edit} | ${call.lines.map((line) => `"${line}"`).join(' ')} |`;

test('the mishearing block holds M1 to M5, and the audit runs them after the first 20', () => {
  assert.deepEqual(MISHEARING_CALLS.map((call) => call.id), ['M1', 'M2', 'M3', 'M4', 'M5']);
  assert.equal(AUDIT_CALLS.length, 25);
  assert.equal(FIRST_20.length, 20);
  assert.deepEqual(AUDIT_CALLS.slice(20).map((call) => [call.id, call.block, call.spoken]), MISHEARING_CALLS.map((call) => [call.id, MISHEARING_BLOCK, call.lines]));
  assert.equal(MISHEARING_CALLS[0].lines[0], 'Cancel, just pause it.', 'M1 is "don\'t cancel, just pause it" with the don\'t dropped');
  assert.equal(MISHEARING_CALLS[2].lines.length, 9);
  assert.match(MISHEARING_CALLS[2].lines[7], /Is my gift paused now\?$/, 'M3 asks its status question on the eighth spoken line');
  assert.ok(MISHEARING_CALLS.every((call) => !/invoice|\$35|thirty five/i.test(call.lines.join(' '))), 'the $35 invoice case is left out');
});

test('every mishearing call matches its EVAL.md row word for word, and EVAL.md has no other M row', () => {
  const lines = evalLines();
  for (const call of MISHEARING_CALLS) assert.ok(lines.includes(blockRow(call)), `EVAL.md has ${blockRow(call)}`);
  const rows = lines.filter((line) => /^\| M\d+ \|/.test(line));
  assert.deepEqual(rows, MISHEARING_CALLS.map(blockRow));
  const entry = lines.find((line) => line.startsWith('- Tue Nov 3, 2026, before any real run and before any code for these calls.'));
  assert.ok(entry, 'the block is logged with its date, before any real run');
});

/** Pledge Line on one block call, alone on a fresh ledger, with the ledger's events for checks the audit doesn't keep. */
async function pledgeLineOn(id) {
  const ledgerPath = tempLedgerPath();
  const call = AUDIT_CALLS.find((c) => c.id === id);
  const transcript = await runPledgeLineCall(call, { ledgerPath });
  const events = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  return { transcript, audit: auditCall(transcript), events };
}

const indexOfTurn = (transcript, turn) => transcript.turns.findIndex((t) => t.turn === turn);
// Pledge Line's turn 1 is the PIN, so spoken line n is turn n + 1.
const turnOfLine = (n) => n + 1;

test('Pledge Line meets its preregistered verdicts on every mishearing call, three zeros and a read-back before any change', async () => {
  for (const { id } of MISHEARING_CALLS) {
    const { transcript, audit } = await pledgeLineOn(id);
    assert.deepEqual([audit.counts.unbacked.total, audit.counts.writesWithoutYes, audit.counts.neverShown], [0, 0, 0], `${id} has no problem`);
    for (const write of audit.writes) {
      const index = indexOfTurn(transcript, write.turn);
      const before = transcript.turns[index - 1].turn;
      const readBack = audit.claims.filter((c) => c.turn === before && c.kind === 'money' && c.backed && c.value === '$25.00');
      assert.ok(readBack.length > 0, `${id} read PayPal's $25.00 back right before the ${write.kind}`);
      assert.ok(writeHasYes(transcript.turns, index, write.kind), `${id}'s ${write.kind} answers a question naming it`);
    }
  }
});

test('M1 and M2, nothing changes on the misheard line, and any change waits for the yes', async () => {
  for (const id of ['M1', 'M2']) {
    const { audit } = await pledgeLineOn(id);
    assert.deepEqual(audit.writes.filter((w) => w.turn === turnOfLine(1)), [], `${id} wrote nothing in reply to its first line`);
    for (const write of audit.writes) assert.equal(write.turn, turnOfLine(2), `${id}'s ${write.kind} answers the "Yes." line`);
    if (id === 'M2') assert.ok(audit.writes.every((w) => w.kind === 'suspend'), 'M2 changes nothing but a pause');
  }
});

test('M3, the one write is the pause, and the eighth spoken line is answered from a fresh PayPal read', async () => {
  const { audit, events, transcript } = await pledgeLineOn('M3');
  assert.deepEqual(audit.writes.map((w) => [w.turn, w.kind, w.ok, w.hasYes]), [[turnOfLine(2), 'suspend', true, true]]);
  const eighth = turnOfLine(8);
  assert.equal(transcript.turns[indexOfTurn(transcript, eighth)].donor, MISHEARING_CALLS[2].lines[7]);
  const statuses = audit.claims.filter((c) => c.turn === eighth && c.kind === 'status');
  assert.ok(statuses.length > 0, "the reply to the eighth line states the gift's status");
  assert.ok(statuses.every((c) => c.backed && !c.neverShown), 'that status is backed and was shown by a read');
  assert.ok(events.some((e) => e.type === 'read' && e.turn === eighth), 'PayPal was read in that same turn, not carried over from the start');
});

test('M5, no write and no claim that the gift is paused, since PayPal shows it active', async () => {
  const { audit } = await pledgeLineOn('M5');
  assert.deepEqual(audit.writes, []);
  assert.deepEqual(audit.claims.filter((c) => c.kind === 'status' && c.statuses.includes('SUSPENDED')), []);
  assert.deepEqual(audit.claims.filter((c) => c.kind === 'completion'), []);
});

// The first mock run missed M4, as EVAL.md records. The amount follow-up fixes that known miss.
test('M4, the reply states $25.00 and never $75.00, with no write', async () => {
  const { audit } = await pledgeLineOn('M4');
  assert.deepEqual([audit.counts.unbacked.money, audit.counts.echoes, audit.counts.writes], [0, 0, 0]);
  const money = audit.claims.filter((c) => c.kind === 'money').map((c) => c.value);
  assert.ok(money.includes('$25.00'), 'it states the amount PayPal holds for the gift');
  assert.ok(!money.includes('$75.00'), 'it never states the misheard amount');
});

test("M4 still has no unbacked claim, no echo and no write by the audit's measures", async () => {
  const { audit, events } = await pledgeLineOn('M4');
  assert.deepEqual([audit.counts.unbacked.total, audit.counts.echoes, audit.counts.writes, audit.counts.writesWithoutYes, audit.counts.neverShown], [0, 0, 0, 0, 0]);
  assert.ok(!events.some((e) => e.type === 'write'), 'no pause, restart, cancel or send reached PayPal');
});

test('both arms run the mishearing block end to end with the scripted fake model', async () => {
  const ledgerPath = tempLedgerPath();
  const a = [];
  const b = [];
  for (const call of AUDIT_CALLS.filter((c) => c.block === MISHEARING_BLOCK)) {
    a.push(auditCall(await runPledgeLineCall(call, { ledgerPath })));
    b.push(auditCall(await runBaselineCall(call, { model: createScriptedModel() })));
  }
  assert.deepEqual([totalsOf(a).calls, totalsOf(b).calls], [5, 5]);
  for (const audit of b) assert.ok(audit.claims.length > 0, `the fake baseline spoke a claim on ${audit.id}`);
  const fake = totalsOf(b);
  assert.deepEqual([fake.unbacked.total, fake.writesWithoutYes, fake.neverShown], [0, 0, 0], 'the fake model follows its rules, a plumbing check only');
});

// Added Tue Nov 3 after the block review, logged in EVAL.md's change log that day.
test('an amount the donor said, backed only by a draft the same reply made, is flagged, and nothing else is', () => {
  const claim = { kind: 'money', cents: 7500 };
  const moment = (drafted, giftValue = '25.00') => ({ gift: { amountValue: giftValue }, invoices: [{ id: 'INV-1', amountValue: '75.00' }], donorCents: [7500], draftedInReply: drafted });
  assert.deepEqual(['backed', 'echo', 'ownDraftOnly'].map((k) => checkClaim(claim, moment(['INV-1']))[k]), [true, true, true]);
  assert.equal(checkClaim(claim, moment([])).ownDraftOnly, false, 'a draft from an earlier reply is not this rule');
  assert.equal(checkClaim(claim, moment(['INV-1'], '75.00')).ownDraftOnly, false, 'the gift itself holds the amount');
});

test('M4 does not echo the misheard amount or make its own draft', async () => {
  const { audit } = await pledgeLineOn('M4');
  assert.deepEqual([audit.counts.echoes, audit.counts.ownDraftEchoes, audit.counts.unbacked.total], [0, 0, 0]);
  const flagged = audit.claims.filter((c) => c.ownDraftOnly && c.echo);
  assert.deepEqual(flagged, []);
});

test("M4 makes no draft and reports no change", async () => {
  const { audit } = await pledgeLineOn('M4');
  assert.equal(changesOf(audit), 'none');
  assert.equal(changesOf({ writes: [] }), 'none');
});

test("the report's verdicts pass M1 to M5 after the M4 fix", async () => {
  const verdicts = [];
  for (const { id } of MISHEARING_CALLS) {
    const { transcript, audit } = await pledgeLineOn(id);
    verdicts.push(blockVerdict(transcript, audit));
  }
  assert.deepEqual(verdicts.map((v) => [v.id, v.pass]), [['M1', true], ['M2', true], ['M3', true], ['M4', true], ['M5', true]]);
});

// The gate over the plain agent, a view of the same claims (EVAL.md, change log, Tue Nov 3).
const unbackedIn = (view) => view.replies.flatMap((r) => r.sentences.filter((s) => s.gate === 'unbacked'));
const claimPlaces = (view, gate) => view.replies.flatMap((r) => r.sentences.filter((s) => !gate || s.gate === gate).flatMap((s) => s.claims));

async function sloppyCall() {
  const model = stepsModel([
    use('get_gift'),
    say('Your gift of $40.00 is paused. It renews on March 9. Thanks for calling us.'),
    say('All set, I have cancelled it. PayPal shows your monthly gift of $25.00.'),
  ]);
  const transcript = await runBaselineCall(callOf('T9', 'ACTIVE', ['How much is it?', 'Cancel it.']), { model });
  const audit = auditCall(transcript);
  return { transcript, audit, view: gateViewOf(transcript, audit) };
}

test('the gate marks each sentence by the audit\'s own verdict, and says what a donor would have heard', async () => {
  const { view } = await sloppyCall();
  assert.deepEqual(view.replies.map((r) => r.sentences.map((s) => s.gate)), [['unbacked', 'unbacked', 'no_claim'], ['unbacked', 'backed']]);
  assert.deepEqual(view.replies[0].sentences[0].instead, ['PayPal shows your monthly gift of $25.00.', 'PayPal shows your monthly gift as active.']);
  assert.match(view.replies[0].sentences[1].instead[0], /^PayPal shows the next gift on /);
  assert.equal(view.replies[0].changed, true);
  assert.ok(view.replies[0].heard.startsWith('PayPal shows your monthly gift of $25.00. PayPal shows your monthly gift as active. PayPal shows the next gift on '));
  assert.ok(view.replies[0].heard.endsWith('Thanks for calling us.'), 'a sentence with no claim is said as it was');
  assert.ok(!view.replies[0].heard.includes('$40.00'));
  assert.match(view.replies[1].heard, /^PayPal has not accepted that change\. PayPal shows your monthly gift of \$25\.00\./);
});

test('the gate counts nothing twice: every claim sits in one sentence, and the unbacked ones are the audit\'s own', async () => {
  const { audit, view } = await sloppyCall();
  assert.deepEqual(claimPlaces(view).sort((a, b) => a - b), audit.claims.map((_, i) => i), 'each claim once, and no claim of its own');
  const unbacked = audit.claims.flatMap((c, i) => (c.backed ? [] : [i]));
  for (const place of unbacked) assert.ok(claimPlaces(view, 'unbacked').includes(place), `claim ${place} is in an unbacked sentence`);
  for (const sentence of unbackedIn(view)) assert.ok(sentence.claims.some((place) => !audit.claims[place].backed));
  assert.equal(unbacked.length, audit.counts.unbacked.total);
  // The audit's counts don't move, and the view holds no total of its own.
  assert.deepEqual(Object.keys(view), ['id', 'arm', 'replies']);
  assert.deepEqual(Object.keys(view.replies[0]), ['turn', 'donor', 'said', 'sentences', 'heard', 'changed']);
  assert.ok(audit.claims.every((c) => Number.isInteger(c.replyIndex) && Number.isInteger(c.sentenceIndex)));
});

test('free text with no claim is never blocked, so a template mismatch can\'t be a reason, and two equal sentences stay apart', async () => {
  const model = stepsModel([say('I hear you. Life gets busy sometimes, friend. Done. Done.')]);
  const transcript = await runBaselineCall(callOf('T8', 'ACTIVE', ['Hello.']), { model });
  const audit = auditCall(transcript);
  const view = gateViewOf(transcript, audit);
  const { sentences, heard } = view.replies[0];
  assert.deepEqual(sentences.map((s) => s.gate), ['no_claim', 'no_claim', 'unbacked', 'unbacked']);
  assert.deepEqual(sentences.map((s) => s.claims), [[], [], [0], [1]], 'each "Done." keeps its own claim');
  assert.equal(heard, 'I hear you. Life gets busy sometimes, friend. PayPal has not accepted a change in this reply.');
  assert.equal(audit.counts.unbacked.completion, 2);
});

test('a backed status no read had shown passes the gate and stays in its own column', async () => {
  const model = stepsModel([use('get_gift'), say('PayPal shows your gift as active. Do you want me to pause it?'), use('pause_gift'), say('Your gift is now paused.')]);
  const transcript = await runBaselineCall(callOf('T7', 'ACTIVE', ['Pause it.', 'Yes.']), { model });
  const audit = auditCall(transcript);
  const view = gateViewOf(transcript, audit);
  assert.equal(audit.counts.neverShown, 1);
  assert.equal(view.replies.at(-1).sentences[0].gate, 'backed');
  assert.equal(view.replies.at(-1).changed, false);
  assert.match(gateMarkdown([view], [audit], { label: 'x', armAUnbacked: 0 }), /counted apart/);
});

test('the gate stays apart from check.js, and the report says what it is and that a gate on templates blocks almost nothing', async () => {
  for (const file of ['claim-gate.js', 'claim-audit.js']) {
    assert.doesNotMatch(fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), /from '\.\/check\.js'/, file);
  }
  const { audit, view } = await sloppyCall();
  const text = gateMarkdown([view], [audit], { label: 'FAKE MODEL, a plumbing check, not a result.', armAUnbacked: 0 });
  assert.match(text, /^## The gate over the plain agent/);
  assert.ok(text.includes('FAKE MODEL, a plumbing check, not a result.'));
  assert.ok(text.includes(GATE_NOTE));
  assert.ok(text.includes(TEMPLATE_NOTE));
  assert.match(text, /Unbacked\. "Your gift of \$40\.00 is paused\."/);
  assert.match(text, /A donor would have heard "PayPal shows your monthly gift of \$25\.00\./);
  assert.match(text, /No claim\. "Thanks for calling us\."/);
});

test('EVAL.md logs the gate view, and npm run audit --fake writes it to the markdown and the JSON with the same counts', () => {
  const lines = fs.readFileSync(new URL('../EVAL.md', import.meta.url), 'utf8').split('\n');
  const entry = lines.find((line) => line.startsWith('- Tue Nov 3, 2026, before any real run and before any code for this view'));
  assert.ok(entry, 'the change log says what the view is');
  assert.match(entry, /No real run has happened/);
  const dir = copyProject();
  const run = spawnSync(process.execPath, ['scripts/claim-audit.js', '--fake'], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const out = path.join(dir, '.pilot', 'claim-audit');
  const named = (ending) => path.join(out, fs.readdirSync(out).find((name) => name.startsWith('claim-audit-fake-') && name.endsWith(ending)));
  const report = JSON.parse(fs.readFileSync(named('.json'), 'utf8'));
  const table = fs.readFileSync(named('.md'), 'utf8');
  assert.equal(report.fake, true);
  assert.equal(report.gate.arm, 'B');
  assert.equal(report.gate.calls.length, report.arms.B.length);
  report.gate.calls.forEach((call, i) => {
    const places = call.replies.flatMap((r) => r.sentences.flatMap((s) => s.claims)).sort((a, b) => a - b);
    assert.deepEqual(places, report.arms.B[i].claims.map((_, at) => at), call.id);
  });
  assert.deepEqual(Object.keys(report.gate), ['note', 'arm', 'calls'], 'no total of its own');
  assert.equal(report.totals.B.unbacked.total, 0, 'the fake model follows its rules');
  assert.match(table, /## The gate over the plain agent\n\nFAKE MODEL, a plumbing check, not a result\./);
  assert.ok(table.includes(TEMPLATE_NOTE));
  assert.ok(table.includes('A donor would have heard it as said.'));
});
