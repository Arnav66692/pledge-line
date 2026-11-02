import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as say from '../src/say.js';
import { NUMBER_WORDS, ORDINAL_WORDS } from '../src/numbers.js';
import { TEMPLATE_WORDS, TEMPLATE_SENTENCES } from '../src/template-words.js';
import { TEMPLATE_RENDERS, NOT_TEMPLATES, buildVocabulary, buildSentences, vocabularySource } from '../src/vocabulary.js';
// Round 4's exports are read through the module objects, so on older code each new test fails by itself.
import * as words from '../src/template-words.js';
import * as vocabulary from '../src/vocabulary.js';
import * as check from '../src/check.js';
import { copyProject } from './helpers.js';

const history = async () => (await import('../src/template-history.js')).TEMPLATE_HISTORY;

test('the checked-in template words match a fresh build from say.js', () => {
  assert.deepEqual([...TEMPLATE_WORDS], buildVocabulary(), 'a template changed, so run npm run vocabulary and check in src/template-words.js');
  assert.match(vocabularySource(), /^\/\/ The words the line's own templates speak/);
});

test('every exported template in say.js is rendered for the vocabulary', () => {
  const exported = Object.keys(say);
  assert.deepEqual(exported.filter((name) => !Object.hasOwn(TEMPLATE_RENDERS, name) && !NOT_TEMPLATES.includes(name)), [], 'add a render for each new template');
  assert.deepEqual([...Object.keys(TEMPLATE_RENDERS), ...NOT_TEMPLATES].filter((name) => !exported.includes(name)), [], 'every name is a real export');
  for (const [name, render] of Object.entries(TEMPLATE_RENDERS)) {
    const parts = render();
    assert.ok(parts.length > 0 && parts.every((p) => typeof p.text === 'string'), name);
  }
});

test('the template words hold no status word, month, weekday or number word, so the allow-list never covers a fact', () => {
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const banned = new Set([...say.STATUS_WORDS, ...months, ...weekdays, ...NUMBER_WORDS, ...ORDINAL_WORDS.filter((word) => word !== 'first'), 'sunny', 'hollow', 'pantry']);
  assert.deepEqual(TEMPLATE_WORDS.filter((word) => banned.has(word)), []);
});

test('the checked-in template sentences match a fresh build from say.js, and no template says a brace (R3-6)', () => {
  assert.deepEqual([...TEMPLATE_SENTENCES], buildSentences(), 'a template changed, so run npm run vocabulary and check in src/template-words.js');
  assert.match(vocabularySource(), /export const TEMPLATE_SENTENCES = Object\.freeze\(\[/);
  for (const [name, render] of Object.entries(TEMPLATE_RENDERS)) {
    for (const p of render()) assert.doesNotMatch(p.text, say.SLOT_MARKS, name);
  }
  // A slot names the fact's source, so the gift's amount and a draft's amount are different slots.
  assert.ok(TEMPLATE_SENTENCES.includes('PayPal shows your monthly gift of {plan.price} as {subscription.status}.'));
  assert.ok(TEMPLATE_SENTENCES.includes('PayPal shows a one-time gift invoice {invoice.number_last4}, for {invoice.amount}, with the status {invoice.status}.'));
  assert.ok(!TEMPLATE_SENTENCES.some((s) => s.includes('monthly gift of {invoice.amount}')));
});

test('every template sentence has a claim the grader proves or a place on the reviewed claim-free list, slots or no slots (R4-1)', async () => {
  const list = vocabulary.buildList();
  assert.deepEqual(vocabulary.unreviewedSentences(list), [], 'give each new sentence a claim in say.js, or add it to CLAIM_FREE in src/vocabulary.js once it is read and found to claim nothing');
  assert.deepEqual(vocabulary.CLAIM_FREE.filter((sentence) => !list.sentences.includes(sentence)), [], 'every claim-free entry is a sentence the templates say');
  assert.deepEqual(vocabulary.CLAIM_FREE.filter((sentence) => Object.hasOwn(list.claims, sentence)), [], 'a claim-free sentence has no claim');
  assert.deepEqual(Object.keys(vocabulary.CLAIMED).filter((sentence) => !list.sentences.includes(sentence)), [], 'every claimed entry is a sentence the templates say');
  // A slot never exempts a sentence, the org slot included, since a sentence can say more than its facts (R4-1).
  assert.deepEqual(vocabulary.unreviewedSentences({ sentences: ['Thanks for calling the {org} donor line.', '{org} has taken care of it.', 'It will stop on {subscription.next_billing_time}.'], claims: {} }),
    ['{org} has taken care of it.', 'It will stop on {subscription.next_billing_time}.']);
  // Nor does a claim no one read: a sentence that took the claim of the part it was added to, or a sentence given another claim.
  assert.deepEqual(vocabulary.unreviewedSentences({ sentences: ['Done.', 'It will stop next month.'], claims: { 'Done.': ['wrote'], 'It will stop next month.': ['wrote'] } }), ['It will stop next month.']);
  assert.deepEqual(vocabulary.unreviewedSentences({ sentences: ['Done.'], claims: { 'Done.': ['gift_read'] } }), ['Done.']);
  // The slotted sentences that say more than their facts carry claims, and the review passed the ones that say only their slots.
  assert.deepEqual(words.TEMPLATE_CLAIMS['The next gift is on {subscription.next_billing_time}.'], ['gift_active']);
  assert.deepEqual(words.TEMPLATE_CLAIMS['PayPal shows your monthly gift of {plan.price} as {subscription.status}, so there is nothing to cancel right now.'], ['nothing_to=cancel']);
  assert.ok(vocabulary.CLAIM_FREE.includes('PayPal shows your monthly gift of {plan.price} as {subscription.status}.'));
  assert.ok(!list.sentences.some((sentence) => /nothing to send/.test(sentence)), 'call.js never says there is nothing to send');
  assert.deepEqual(Object.values(list.claims).flat().map((c) => c.split('=')[0]).filter((name) => !check.CLAIM_NAMES.includes(name)), [], 'the grader can prove every claim');
  for (const [name, render] of Object.entries(TEMPLATE_RENDERS)) {
    for (const p of render()) {
      for (const c of p.claims ?? []) assert.ok(say.sentencesOf(p.text).includes(c.sentence), `${name} ties ${c.claim} to one whole sentence of its reply, "${c.sentence}"`);
    }
  }
  // The sentences that said a PayPal result or a write outcome with nothing to prove it now carry claims.
  const claimed = [['Done.', 'wrote'], ["PayPal didn't accept that change.", 'write_failed'], ['PayPal will email it to the address on file.', 'wrote_send_invoice'],
    ['I asked PayPal to delete that invoice, but PayPal still shows it.', 'draft_kept'], ['OK, I deleted that invoice before it went out, and PayPal no longer shows it.', 'draft_deleted'],
    ["I couldn't find a monthly gift in PayPal for this line.", 'no_gift'], ["I can't find that invoice in PayPal now, so I can't confirm it went out.", 'invoice_unread'],
    ["OK, I won't change anything, so your monthly gift stays as it is.", 'unchanged']];
  for (const [sentence, claim] of claimed) assert.deepEqual(words.TEMPLATE_CLAIMS[sentence], [claim], sentence);
  // A sentence that states a result, added to giftStatus and built by npm run vocabulary alone, is caught.
  const dir = copyProject([['src/say.js', 'The next gift is on ${date.value}.`', 'The next gift is on ${date.value}. It will stop next month.`']]);
  const built = spawnSync(process.execPath, [path.join(dir, 'src', 'vocabulary.js')], { cwd: dir, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const copy = await import(pathToFileURL(path.join(dir, 'src', 'vocabulary.js')).href);
  const listed = await import(pathToFileURL(path.join(dir, 'src', 'template-words.js')).href);
  assert.ok(listed.TEMPLATE_SENTENCES.includes('It will stop next month.'), 'npm run vocabulary listed it');
  assert.deepEqual(copy.unreviewedSentences(), ['It will stop next month.']);
});

test('a result sentence with a fact slot, built by npm run vocabulary alone, is unreviewed, and its history entry says so for pilot-check (R4-1)', async () => {
  // cancelConfirm says the gift will stop on its next billing date, a fact proven against PayPal, in a sentence that lies.
  const dir = copyProject([['src/say.js', "export const cancelConfirm = (sub, plan) => combine(shows(sub, plan),",
    "export const cancelConfirm = (sub, plan) => combine(shows(sub, plan), (() => { const d = derived('subscription.next_billing_time', sub, 'date'); return d ? part(`It will stop on ${d.value}.`, [d]) : null; })(),"]]);
  const built = spawnSync(process.execPath, [path.join(dir, 'src', 'vocabulary.js')], { cwd: dir, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.stdout, /pilot-check refuses every call made with this list[^\n]*"It will stop on \{subscription\.next_billing_time\}\."/);
  const copy = await import(pathToFileURL(path.join(dir, 'src', 'vocabulary.js')).href);
  const listed = await import(pathToFileURL(path.join(dir, 'src', 'template-words.js')).href);
  const copyCheck = await import(pathToFileURL(path.join(dir, 'src', 'check.js')).href);
  assert.ok(listed.TEMPLATE_SENTENCES.includes('It will stop on {subscription.next_billing_time}.'), 'npm run vocabulary listed it');
  assert.deepEqual(copy.unreviewedSentences(), ['It will stop on {subscription.next_billing_time}.']);
  // The copy's history keeps the review with the list, so its grader refuses every call that logged it, npm test or not.
  const trouble = copyCheck.templateTrouble({ type: 'call_start', templates: listed.TEMPLATE_HASH });
  assert.deepEqual(trouble, { hash: listed.TEMPLATE_HASH, unknown: false, unreviewed: ['It will stop on {subscription.next_billing_time}.'] });
  assert.equal(check.templateTrouble({ type: 'call_start', templates: words.TEMPLATE_HASH }), null, 'the line as it is now has every sentence reviewed');
});

test('the checked-in claims and hash match a fresh build, and the history keeps every list under its hash (R4-2)', async () => {
  const list = vocabulary.buildList();
  assert.deepEqual({ ...words.TEMPLATE_CLAIMS }, list.claims, 'a template changed, so run npm run vocabulary and check in src/template-words.js');
  assert.equal(words.TEMPLATE_HASH, vocabulary.templateHash(list));
  const TEMPLATE_HISTORY = await history();
  const { reviewed, ...entry } = TEMPLATE_HISTORY[words.TEMPLATE_HASH];
  assert.deepEqual(entry, list, 'npm run vocabulary also writes src/template-history.js');
  assert.deepEqual(reviewed, vocabulary.reviewedOf(list), 'the entry keeps the claim-free sentences the review passed (R4-1)');
  // A later list joins the history after every earlier one, and building the same list again adds nothing.
  const later = { ...list, sentences: [...list.sentences, 'Is there anything else I can help with?'].sort() };
  const next = vocabulary.nextHistory(TEMPLATE_HISTORY, later);
  assert.deepEqual(Object.keys(next), [...Object.keys(TEMPLATE_HISTORY), vocabulary.templateHash(later)]);
  for (const hash of Object.keys(TEMPLATE_HISTORY)) assert.deepEqual(next[hash], TEMPLATE_HISTORY[hash]);
  assert.deepEqual(Object.keys(vocabulary.nextHistory(TEMPLATE_HISTORY, list)), Object.keys(TEMPLATE_HISTORY));
  // say.js changed with no npm run vocabulary: the fresh build no longer matches the checked-in list, so the drift tests fail.
  const dir = copyProject([['src/say.js', "const ANYTHING_ELSE = 'What else can I help with?';", "const ANYTHING_ELSE = 'Is there anything else I can help with?';"]]);
  const copy = await import(pathToFileURL(path.join(dir, 'src', 'vocabulary.js')).href);
  const checkedIn = await import(pathToFileURL(path.join(dir, 'src', 'template-words.js')).href);
  assert.notDeepEqual([...checkedIn.TEMPLATE_SENTENCES], copy.buildSentences());
  assert.notEqual(checkedIn.TEMPLATE_HASH, copy.templateHash(copy.buildList()));
});
