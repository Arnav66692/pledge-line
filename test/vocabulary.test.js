import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as say from '../src/say.js';
import { NUMBER_WORDS, ORDINAL_WORDS } from '../src/numbers.js';
import { TEMPLATE_WORDS, TEMPLATE_SENTENCES } from '../src/template-words.js';
import { TEMPLATE_RENDERS, NOT_TEMPLATES, buildVocabulary, buildSentences, vocabularySource } from '../src/vocabulary.js';

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
