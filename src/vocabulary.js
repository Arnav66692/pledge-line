// Builds the words and the sentences the line's own templates speak, which check.js holds every reply to (I3).
// Run `npm run vocabulary` after changing a template in say.js, and check in src/template-words.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as say from './say.js';
import { LIMITS } from './config.js';

const ORG = 'Sunny Hollow Pantry';
const TIME_ZONE = 'America/Los_Angeles';
const OUT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'template-words.js');
const LINE_MAX = 110;

// Fixtures for every branch, missing snapshots and missing fields included, so no fallback wording is left out.
const ACTIVE = { id: 'I-1', status: 'ACTIVE', plan_id: 'P-1', next_billing_time: '2026-12-01T10:00:00Z', subscriber_email: 'sb-maria@personal.example.com', subscriber_given_name: 'Maria' };
const SUBS = [ACTIVE, ...['SUSPENDED', 'CANCELLED', 'APPROVAL_PENDING', null].map((status) => ({ ...ACTIVE, status })), { ...ACTIVE, next_billing_time: null }, null];
const PLANS = [{ id: 'P-1', price_value: '25.00', price_currency: 'USD' }, { id: 'P-1', price_value: null, price_currency: 'USD' }, null];
const DRAFT = { id: 'INV2-1', status: 'DRAFT', number: '0001', amount_value: '50.00', amount_currency: 'USD', recipient_email: 'sb-maria@personal.example.com', recipient_view_url: null };
// Every mix of a missing number, amount, status and recipient, so each sentence the invoice templates can say is listed.
const INVOICES = [...['0001', null].flatMap((number) => ['50.00', null].flatMap((amount) => ['DRAFT', 'SENT', 'UNPAID', 'PAID', null]
  .flatMap((status) => [DRAFT.recipient_email, null].map((email) => ({ ...DRAFT, number, amount_value: amount, status, recipient_email: email }))))), null];
const KINDS = ['suspend', 'activate', 'cancel', 'send_invoice'];
const OKS = [true, false];

const gift = (render) => SUBS.flatMap((sub) => PLANS.map((plan) => render(sub, plan)));
const plain = (text) => ({ text, facts: [] });

/** Every exported template in say.js, rendered with the fixtures above. The vocabulary test fails when one is missing. */
export const TEMPLATE_RENDERS = Object.freeze({
  greeting: () => [say.greeting(ORG)],
  askPin: () => [say.askPin()],
  pinOk: () => [say.pinOk()],
  pinBad: () => [say.pinBad(2), say.pinBad(1)],
  pinLocked: () => [say.pinLocked()],
  giftStatus: () => gift((sub, plan) => say.giftStatus(sub, plan, { timeZone: TIME_ZONE })),
  pauseOffer: () => gift(say.pauseOffer),
  cancelConfirm: () => gift(say.cancelConfirm),
  resumeConfirm: () => gift(say.resumeConfirm),
  pauseConfirm: () => gift(say.pauseConfirm),
  nothingTo: () => KINDS.flatMap((kind) => gift((sub, plan) => say.nothingTo(kind, sub, plan))),
  invoiceConfirm: () => INVOICES.map((inv) => say.invoiceConfirm(inv, ORG)),
  afterWrite: () => [
    ...KINDS.slice(0, 3).flatMap((kind) => OKS.flatMap((ok) => gift((sub, plan) => say.afterWrite(kind, sub, plan, { ok })))),
    ...OKS.flatMap((ok) => INVOICES.map((inv) => say.afterWrite('send_invoice', inv, null, { ok }))),
  ],
  noPause: () => [say.noPause()],
  declined: () => KINDS.map((kind) => say.declined(kind)),
  draftDeleted: () => [say.draftDeleted(true), say.draftDeleted(false)],
  otherEmail: () => [say.otherEmail()],
  help: () => [say.help()],
  repeat: () => [say.repeat(null), say.repeat(say.help())],
  goodbye: () => [say.goodbye()],
  unclear: () => [say.unclear()],
  notVerified: () => [say.notVerified()],
  noSubscription: () => [say.noSubscription()],
  noEmail: () => [say.noEmail()],
  limitsPhrase: () => [plain(say.limitsPhrase(LIMITS.invoiceMinDollars, LIMITS.invoiceMaxDollars))],
  amountOutOfRange: () => [say.amountOutOfRange(LIMITS.invoiceMinDollars, LIMITS.invoiceMaxDollars)],
  amountForFile: () => [say.amountForFile()],
  nothingPending: () => [say.nothingPending()],
  needYesOrNo: () => [say.needYesOrNo()],
  callEnded: () => [say.callEnded()],
  staffCallback: () => [say.staffCallback()],
  paypalProblem: () => [say.paypalProblem()],
  tooLong: () => [say.tooLong()],
  turnLimit: () => [say.turnLimit()],
  expiredNotice: () => [say.expiredNotice()],
  setAside: () => [say.setAside()],
  pinLimit: () => [say.pinLimit()],
  EMPATHY_PHRASES: () => Object.values(say.EMPATHY_PHRASES).map(plain),
  empathyPhrase: () => Object.keys(say.EMPATHY_PHRASES).map((key) => plain(say.filterEmpathy(say.empathyPhrase(key)))),
});

/** Exports of say.js that format, scan or filter, and speak no words of their own. */
export const NOT_TEMPLATES = Object.freeze(['combine', 'numberToWords', 'formatMoney', 'formatDate', 'spokenStatus', 'last4', 'maskEmail',
  'FACT_SOURCES', 'STATUS_WORDS', 'filterEmpathy', 'scanSpoken', 'extractSpokenFacts', 'saysPhrase', 'spokenForm', 'wordsOf', 'asksForAmount',
  'SLOT_MARKS', 'slotFacts', 'sentencesOf']);

const renderedParts = () => Object.values(TEMPLATE_RENDERS).flatMap((render) => render());

/**
 * Every word the templates speak once their declared facts, the org name and the allowed phrases are set aside,
 * and the scans have read out every fact, the same way check.js reads a reply.
 */
export function buildVocabulary() {
  const words = new Set();
  for (const p of renderedParts()) {
    const skip = [ORG, ...(p.facts ?? []).map(say.spokenForm)];
    for (const word of say.wordsOf(say.scanSpoken(p.text, { strict: true, skip }).rest)) words.add(word);
  }
  return [...words].sort();
}

/**
 * Every sentence the templates speak, with the org name and each declared fact as a slot named for its source,
 * the same way check.js reads a reply, so template words recombined into a new claim never pass (R3-6).
 */
export function buildSentences() {
  const sentences = new Set();
  for (const p of renderedParts()) {
    for (const sentence of say.sentencesOf(say.slotFacts(p.text, p.facts ?? [], ORG))) sentences.add(sentence);
  }
  return [...sentences].sort();
}

// Single quotes, as in the rest of the code, unless the text has an apostrophe.
const quoted = (text) => (text.includes("'") ? JSON.stringify(text) : `'${text}'`);

/** The words wrapped to short lines. */
function wordLines(words) {
  const lines = [];
  let line = '';
  for (const item of words.map((word) => `${quoted(word)},`)) {
    if (line && line.length + item.length + 1 > LINE_MAX) {
      lines.push(line);
      line = '';
    }
    line = line ? `${line} ${item}` : `  ${item}`;
  }
  if (line) lines.push(line);
  return lines;
}

/** The checked-in module, the words wrapped to short lines and one sentence a line. */
export function vocabularySource(words = buildVocabulary(), sentences = buildSentences()) {
  return [
    "// The words the line's own templates speak, once facts, the org name and the allowed phrases are set aside.",
    '// Generated from say.js by `npm run vocabulary`. Do not edit by hand, the vocabulary test fails on any drift.',
    'export const TEMPLATE_WORDS = Object.freeze([',
    ...wordLines(words),
    ']);',
    '',
    '// Each sentence the templates speak, with the org name and each fact as a slot named for its source.',
    'export const TEMPLATE_SENTENCES = Object.freeze([',
    ...sentences.map((sentence) => `  ${quoted(sentence)},`),
    ']);',
    '',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  fs.writeFileSync(OUT_FILE, vocabularySource());
  process.stdout.write(`Wrote ${OUT_FILE}.\n`);
}
