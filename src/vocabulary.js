// Builds the words, the sentences and the claims the line's own templates speak, which check.js holds every reply to (I3).
// Run `npm run vocabulary` after changing a template in say.js, and check in src/template-words.js and src/template-history.js.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as say from './say.js';
import { LIMITS } from './config.js';

const ORG = 'Sunny Hollow Pantry';
const TIME_ZONE = 'America/Los_Angeles';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(HERE, 'template-words.js');
const HISTORY_FILE = path.join(HERE, 'template-history.js');
const LINE_MAX = 110;
// Hex characters of the template hash call_start logs. Enough to tell lists apart, short enough to read in a notice.
const HASH_LENGTH = 12;

// Fixtures for every branch, missing snapshots and missing fields included, so no fallback wording is left out.
const ACTIVE = { id: 'I-1', status: 'ACTIVE', plan_id: 'P-1', next_billing_time: '2026-12-01T10:00:00Z', subscriber_email: 'sb-maria@personal.example.com', subscriber_given_name: 'Maria' };
const SUBS = [ACTIVE, ...['SUSPENDED', 'CANCELLED', 'APPROVAL_PENDING', null].map((status) => ({ ...ACTIVE, status })), { ...ACTIVE, next_billing_time: null }, null];
const PLANS = [{ id: 'P-1', price_value: '25.00', price_currency: 'USD' }, { id: 'P-1', price_value: null, price_currency: 'USD' }, null];
const DRAFT = { id: 'INV2-1', status: 'DRAFT', number: '0001', amount_value: '50.00', amount_currency: 'USD', recipient_email: 'sb-maria@personal.example.com', recipient_view_url: null };
// Every mix of a missing number, amount, status and recipient, so each sentence the invoice templates can say is listed.
const INVOICES = [...['0001', null].flatMap((number) => ['50.00', null].flatMap((amount) => ['DRAFT', 'SENT', 'UNPAID', 'PAID', null]
  .flatMap((status) => [DRAFT.recipient_email, null].map((email) => ({ ...DRAFT, number, amount_value: amount, status, recipient_email: email }))))), null];
const KINDS = ['suspend', 'activate', 'cancel', 'send_invoice'];
const GIFT_KINDS = KINDS.slice(0, 3);
// How a write can end: ok, refused by PayPal, or with no clear answer, a timeout or a 5xx (L2).
const OUTCOMES = [{ ok: true }, { ok: false }, { ok: false, unclear: true }];

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
  // call.js says "nothing to" only for the gift's own changes, so a send has no such sentence.
  nothingTo: () => GIFT_KINDS.flatMap((kind) => gift((sub, plan) => say.nothingTo(kind, sub, plan))),
  invoiceConfirm: () => INVOICES.map((inv) => say.invoiceConfirm(inv, ORG)),
  afterWrite: () => [
    ...GIFT_KINDS.flatMap((kind) => OUTCOMES.flatMap((outcome) => gift((sub, plan) => say.afterWrite(kind, sub, plan, outcome)))),
    ...OUTCOMES.flatMap((outcome) => INVOICES.map((inv) => say.afterWrite('send_invoice', inv, null, outcome))),
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

/**
 * Exports of say.js that format, scan or filter, and speak no words of their own, or speak only inside a template above,
 * as limitsPhrase does inside amountOutOfRange.
 */
export const NOT_TEMPLATES = Object.freeze(['combine', 'numberToWords', 'formatMoney', 'formatDate', 'spokenStatus', 'last4', 'maskEmail',
  'FACT_SOURCES', 'STATUS_WORDS', 'filterEmpathy', 'scanSpoken', 'extractSpokenFacts', 'saysPhrase', 'spokenForm', 'wordsOf', 'asksForAmount',
  'SLOT_MARKS', 'slotFacts', 'sentencesOf', 'limitsPhrase']);

/**
 * The template sentences that state no PayPal result and nothing the line did, each one read and passed by hand.
 * Every other template sentence needs a claim, and the vocabulary test fails on a sentence with none that is not
 * listed here, slots or no slots, so a new sentence that states a result can't get in through npm run vocabulary
 * alone (R4-1). Add a sentence here only when it claims nothing: a question, an offer, an instruction, the menu, or a
 * plain courtesy.
 */
const PLAIN_CLAIM_FREE = [
  'Before you stop it, I can pause it instead.',
  'Cancelling ends it for good, and it cannot be undone.',
  'Do you want me to cancel it?',
  'Do you want me to pause it?',
  'Do you want me to restart it?',
  'Goodbye.',
  'How much would you like to give?',
  'I can also set up a one-time gift as a PayPal invoice to the email on file, or ask staff to call you back.',
  'I can read you your monthly gift, pause it, restart it, cancel it, or set up a one-time gift.',
  'I can read you your monthly gift, pause it, restart it, or cancel it.',
  // Its limits are config facts, which check.js holds to the config.
  'I can set up a one-time gift from one dollar to five hundred dollars.',
  'I understand.',
  "I'm sorry to hear that.",
  'If you would like to give a one-time gift to the email on file, tell me the amount.',
  'It never asks you to call a number.',
  'Nothing more is taken during a pause, and you can restart it any time.',
  'OK.',
  'Pausing it holds your monthly gift until you restart it.',
  'Please call back later.',
  'Please enter it on the keypad.',
  'Please enter your PIN on the keypad, or say its digits.',
  'Please say it in a shorter way.',
  'Please say yes or no.',
  'Please start a new call if you need anything else.',
  'Please start a new call.',
  'Please try again in a minute.',
  'Please try again later.',
  'Restarting it means your monthly gift is taken again each month.',
  'Should I send it?',
  "Sorry, I didn't catch that.",
  'Sorry, that was a lot at once.',
  'Staff can help during open hours.',
  'Staff will check on it.',
  'Thank you.',
  'Thanks for calling.',
  'This is a PayPal sandbox demo, so no real money moves.',
  'To keep your gift safe, please enter your PIN on the keypad, or say its digits.',
  'What else can I help with?',
  'What would you like to do?',
  'Would you like me to pause it?',
  'You can ask about your monthly gift, pause it, restart it, cancel it, or give a one-time gift.',
];

/**
 * The sentences with slots that say only their slots, read and passed by hand the same way. The facts check proves
 * each fact slot against PayPal's latest read, and the org slot is the configured name. A slotted sentence that says
 * more, such as when a gift will stop or that there is nothing to change, carries a claim instead (R4-1).
 */
const SLOT_FRAMES = [
  // The safety check stops the pilot when a draft names any email but the one on file.
  'It would go to the email on file, {invoice.recipient_email}.',
  'PayPal now shows invoice with the status {invoice.status}.',
  'PayPal now shows invoice {invoice.number_last4} with the status {invoice.status}.',
  'PayPal now shows invoice {invoice.number_last4}, for {invoice.amount}, with the status {invoice.status}.',
  'PayPal now shows invoice {invoice.number_last4}, for {invoice.amount}.',
  'PayPal now shows invoice {invoice.number_last4}.',
  'PayPal now shows invoice, for {invoice.amount}, with the status {invoice.status}.',
  'PayPal now shows invoice, for {invoice.amount}.',
  'PayPal now shows your monthly gift as {subscription.status}.',
  'PayPal now shows your monthly gift of {plan.price} as {subscription.status}.',
  'PayPal now shows your monthly gift of {plan.price}.',
  'PayPal shows a one-time gift invoice with the status {invoice.status}.',
  'PayPal shows a one-time gift invoice {invoice.number_last4} with the status {invoice.status}.',
  'PayPal shows a one-time gift invoice {invoice.number_last4}, for {invoice.amount}, with the status {invoice.status}.',
  'PayPal shows a one-time gift invoice {invoice.number_last4}, for {invoice.amount}.',
  'PayPal shows a one-time gift invoice {invoice.number_last4}.',
  'PayPal shows a one-time gift invoice, for {invoice.amount}, with the status {invoice.status}.',
  'PayPal shows a one-time gift invoice, for {invoice.amount}.',
  'PayPal shows your monthly gift as {subscription.status}.',
  'PayPal shows your monthly gift of {plan.price} as {subscription.status}.',
  'PayPal shows your monthly gift of {plan.price}.',
  'Thanks for calling the {org} donor line.',
  'The email comes from PayPal, shows {org}, and has a link to pay.',
];

/** Every reviewed claim-free sentence, plain or slotted, in the order the template lists sort them. */
export const CLAIM_FREE = Object.freeze([...PLAIN_CLAIM_FREE, ...SLOT_FRAMES].sort());

/**
 * The template sentences that say what PayPal or the line did, each with the claims it was read and passed with,
 * which the grader proves against the call's own events. A sentence say.js gives other claims, as a sentence added
 * inside a claimed part gets that part's claims, is unreviewed until it is read and listed here or on CLAIM_FREE, so a
 * borrowed claim never vouches for a new result sentence (R4-1).
 */
export const CLAIMED = Object.freeze({
  'Done.': ['wrote'],
  "For your safety, I can only send to the email already on file with PayPal, so I won't use a new email.": ['email_refused'],
  'I asked PayPal to cancel it.': ['wrote_cancel'],
  'I asked PayPal to delete that invoice, but PayPal still shows it.': ['draft_kept'],
  'I asked PayPal to pause it.': ['wrote_suspend'],
  'I asked PayPal to restart it.': ['wrote_activate'],
  'I asked PayPal to send it.': ['wrote_send_invoice'],
  "I can't find that invoice in PayPal now, so I can't confirm it went out.": ['invoice_unread'],
  "I couldn't find a monthly gift in PayPal for this line.": ['no_gift'],
  'I need a clear yes or no before I change anything.': ['unchanged'],
  'I need your PIN first.': ['not_verified'],
  "I've set that earlier request aside, so nothing changed.": ['set_aside'],
  'It can take a minute to update.': ['wrote'],
  'It would go to the email on file.': ['invoice_read'],
  'OK, I deleted that invoice before it went out, and PayPal no longer shows it.': ['draft_deleted'],
  "OK, I won't change anything, so your monthly gift stays as it is.": ['unchanged'],
  "OK, I've noted that you'd like a call.": ['callback_noted'],
  'OK, no pause.': ['no_pause'],
  "PayPal didn't accept that change.": ['write_failed'],
  "PayPal didn't accept the send.": ['send_failed'],
  "PayPal didn't answer clearly, so I checked again.": ['write_unclear'],
  "PayPal didn't return the gift just now, so I can't confirm the change.": ['gift_unread'],
  "PayPal has no email on file for this gift, so I can't send an invoice.": ['no_email'],
  'PayPal now shows invoice.': ['invoice_read'],
  'PayPal now shows your monthly gift.': ['gift_read'],
  'PayPal shows a one-time gift invoice.': ['invoice_read'],
  'PayPal shows your monthly gift as {subscription.status}, so there is nothing to cancel right now.': ['nothing_to=cancel'],
  'PayPal shows your monthly gift as {subscription.status}, so there is nothing to pause right now.': ['nothing_to=suspend'],
  'PayPal shows your monthly gift as {subscription.status}, so there is nothing to restart right now.': ['nothing_to=activate'],
  'PayPal shows your monthly gift of {plan.price} as {subscription.status}, so there is nothing to cancel right now.': ['nothing_to=cancel'],
  'PayPal shows your monthly gift of {plan.price} as {subscription.status}, so there is nothing to pause right now.': ['nothing_to=suspend'],
  'PayPal shows your monthly gift of {plan.price} as {subscription.status}, so there is nothing to restart right now.': ['nothing_to=activate'],
  'PayPal shows your monthly gift of {plan.price}, so there is nothing to cancel right now.': ['nothing_to=cancel'],
  'PayPal shows your monthly gift of {plan.price}, so there is nothing to pause right now.': ['nothing_to=suspend'],
  'PayPal shows your monthly gift of {plan.price}, so there is nothing to restart right now.': ['nothing_to=activate'],
  'PayPal shows your monthly gift, so there is nothing to cancel right now.': ['gift_read', 'nothing_to=cancel'],
  'PayPal shows your monthly gift, so there is nothing to pause right now.': ['gift_read', 'nothing_to=suspend'],
  'PayPal shows your monthly gift, so there is nothing to restart right now.': ['gift_read', 'nothing_to=activate'],
  'PayPal shows your monthly gift.': ['gift_read'],
  'PayPal will email it to the address on file.': ['wrote_send_invoice'],
  "Sorry, I couldn't get a clear answer from PayPal just now, so I didn't change anything.": ['paypal_unclear'],
  'Staff will call you back during open hours.': ['callback_noted'],
  'Thanks, you are verified.': ['pin_ok'],
  "That PIN didn't match too many times, so I've locked this call to keep your gift safe.": ['pin_locked'],
  "That PIN didn't match.": ['pin_bad'],
  "That earlier request timed out, so I didn't change anything.": ['timed_out'],
  'The next gift is on {subscription.next_billing_time}.': ['gift_active'],
  "There have been too many wrong PINs from here, so I can't check a PIN right now.": ['pin_limit'],
  "There's nothing waiting for a yes or no right now.": ['nothing_pending'],
  'This call has ended.': ['call_ended'],
  'This call has reached its limit.': ['turn_limit'],
  'You can restart it any time.': ['wrote_suspend'],
  'You have one try left.': ['tries_left=1'],
  'You have two tries left.': ['tries_left=2'],
});

/** The review, every template sentence read by hand and the claims it carries, none for a claim-free one (R4-1). */
export const REVIEW = Object.freeze(Object.fromEntries([...CLAIM_FREE.map((sentence) => [sentence, []]), ...Object.entries(CLAIMED)]));

const renderedParts = () => Object.values(TEMPLATE_RENDERS).flatMap((render) => render());

/**
 * Every word the templates speak once their declared facts, the org name and the allowed phrases are set aside,
 * and the scans have read out every fact, the same way check.js reads a reply.
 */
export function buildVocabulary(parts = renderedParts()) {
  const words = new Set();
  for (const p of parts) {
    const skip = [ORG, ...(p.facts ?? []).map(say.spokenForm)];
    for (const word of say.wordsOf(say.scanSpoken(p.text, { strict: true, skip }).rest)) words.add(word);
  }
  return [...words].sort();
}

/**
 * Every sentence the templates speak, with the org name and each declared fact as a slot named for its source,
 * the same way check.js reads a reply, so template words recombined into a new claim never pass (R3-6).
 */
export function buildSentences(parts = renderedParts()) {
  const sentences = new Set();
  for (const p of parts) {
    for (const sentence of say.sentencesOf(say.slotFacts(p.text, p.facts ?? [], ORG))) sentences.add(sentence);
  }
  return [...sentences].sort();
}

/** The claims each sentence of one rendered part carries, keyed by the sentence with its slots. */
function partClaims(p) {
  const slotted = (text) => say.slotFacts(text, p.facts ?? [], ORG);
  const bySentence = new Map(say.sentencesOf(slotted(p.text)).map((sentence) => [sentence, new Set()]));
  for (const c of p.claims ?? []) bySentence.get(slotted(c.sentence))?.add(c.claim);
  return bySentence;
}

/**
 * The claims each sentence carries, for the sentences that carry any, so check.js holds a reply that says one of
 * them to its claim (R4-1). A sentence must carry the same claims in every template that says it.
 */
export function buildClaims(parts = renderedParts()) {
  const claims = new Map();
  for (const p of parts) {
    for (const [sentence, names] of partClaims(p)) {
      const list = [...names].sort();
      const seen = claims.get(sentence);
      if (seen && JSON.stringify(seen) !== JSON.stringify(list)) {
        throw new Error(`"${sentence}" carries the claims [${seen}] in one template and [${list}] in another. Give it the same claims everywhere.`);
      }
      claims.set(sentence, list);
    }
  }
  return Object.fromEntries([...claims].filter(([, list]) => list.length > 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The words, sentences and claims of the templates as they are now, the list call_start names by its hash. */
export function buildList() {
  const parts = renderedParts();
  return { words: buildVocabulary(parts), sentences: buildSentences(parts), claims: buildClaims(parts) };
}

const claimsIn = (list, sentence) => (Object.hasOwn(list.claims, sentence) ? list.claims[sentence] : []);
const sameNames = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/**
 * The sentences of a list the review passed with the claims the list gives them, which its history entry keeps,
 * so pilot-check can refuse a list with any other (R4-1).
 */
export const reviewedOf = (list, review = REVIEW) => list.sentences.filter((sentence) => Object.hasOwn(review, sentence) && sameNames(review[sentence], claimsIn(list, sentence)));

/**
 * The sentences of a list the review never passed with their claims. A slot never exempts one, the org slot
 * included, since a sentence can say more than its facts, as "It will stop on {subscription.next_billing_time}." would,
 * and neither does a claim say.js gave it that no one read (R4-1).
 */
export function unreviewedSentences(list = buildList(), reviewed = reviewedOf(list)) {
  return list.sentences.filter((sentence) => !reviewed.includes(sentence));
}

/** A short hash of the words, sentences and claims, which call_start logs so pilot-check holds each call to its own list (R4-2). */
export function templateHash({ words, sentences, claims }) {
  const canonical = JSON.stringify({ words, sentences, claims: Object.keys(claims).sort().map((sentence) => [sentence, claims[sentence]]) });
  return createHash('sha256').update(canonical).digest('hex').slice(0, HASH_LENGTH);
}

/** The hash of what say.js speaks right now, and its sentences the review has not passed, which call.js logs and the server warns about (R4-2). */
export function liveTemplates() {
  const list = buildList();
  return Object.freeze({ hash: templateHash(list), unreviewed: Object.freeze(unreviewedSentences(list)) });
}

/**
 * The history with the current list added under its hash. No list is ever taken out, so an old call can always be
 * graded (R4-2). Each entry keeps the sentences the review passed, which the hash leaves out. A sentence the review
 * passes now is added to every entry that gives it the same claims, so a list fixed by review grades again, and a
 * review is never taken back (R4-1).
 */
export function nextHistory(history, list, hash = templateHash(list), review = REVIEW) {
  for (const [key, entry] of Object.entries(history)) {
    if (templateHash(entry) !== key) throw new Error(`The template history holds another list under ${key}. Restore src/template-history.js from git.`);
  }
  const withReviews = (entry) => ({ words: entry.words, sentences: entry.sentences, claims: entry.claims,
    reviewed: [...new Set([...(entry.reviewed ?? []), ...reviewedOf(entry, review)])].sort() });
  const next = Object.fromEntries(Object.entries(history).map(([key, entry]) => [key, withReviews(entry)]));
  return Object.hasOwn(next, hash) ? next : { ...next, [hash]: withReviews(list) };
}

// Single quotes, as in the rest of the code, unless the text has an apostrophe.
const quoted = (text) => (text.includes("'") ? JSON.stringify(text) : `'${text}'`);

/** The words wrapped to short lines. */
function wordLines(words, indent = '  ') {
  const lines = [];
  let line = '';
  for (const item of words.map((word) => `${quoted(word)},`)) {
    if (line && line.length + item.length + 1 > LINE_MAX) {
      lines.push(line);
      line = '';
    }
    line = line ? `${line} ${item}` : `${indent}${item}`;
  }
  if (line) lines.push(line);
  return lines;
}

const claimLines = (claims, indent = '  ') => Object.entries(claims).map(([sentence, names]) => `${indent}${quoted(sentence)}: Object.freeze([${names.map(quoted).join(', ')}]),`);

/** The checked-in module, the words wrapped to short lines and one sentence a line. */
export function vocabularySource(list = buildList(), hash = templateHash(list)) {
  return [
    "// The words the line's own templates speak, once facts, the org name and the allowed phrases are set aside.",
    '// Generated from say.js by `npm run vocabulary`. Do not edit by hand, the vocabulary test fails on any drift.',
    'export const TEMPLATE_WORDS = Object.freeze([',
    ...wordLines(list.words),
    ']);',
    '',
    '// Each sentence the templates speak, with the org name and each fact as a slot named for its source.',
    'export const TEMPLATE_SENTENCES = Object.freeze([',
    ...list.sentences.map((sentence) => `  ${quoted(sentence)},`),
    ']);',
    '',
    '// The claim each of these sentences carries, which check.js proves against the call\'s own events (R4-1).',
    'export const TEMPLATE_CLAIMS = Object.freeze({',
    ...claimLines(list.claims),
    '});',
    '',
    '// The hash call_start logs, so pilot-check holds each call to the list it was spoken with (R4-2).',
    `export const TEMPLATE_HASH = ${quoted(hash)};`,
    '',
  ].join('\n');
}

/** The checked-in history, every list the line has been released with under its hash, oldest first. */
export function historySource(history) {
  const entries = Object.entries(history).flatMap(([hash, list]) => [
    `  ${quoted(hash)}: Object.freeze({`,
    '    words: Object.freeze([',
    ...wordLines(list.words, '      '),
    '    ]),',
    '    sentences: Object.freeze([',
    ...list.sentences.map((sentence) => `      ${quoted(sentence)},`),
    '    ]),',
    '    claims: Object.freeze({',
    ...claimLines(list.claims, '      '),
    '    }),',
    '    reviewed: Object.freeze([',
    ...(list.reviewed ?? []).map((sentence) => `      ${quoted(sentence)},`),
    '    ]),',
    '  }),',
  ]);
  return [
    '// Every template list the line has been released with, under the hash call_start logs (R4-2), and the claim-free',
    '// sentences of each that the review in src/vocabulary.js passed, so pilot-check refuses a list with any other (R4-1).',
    '// Generated by `npm run vocabulary`, which adds the current list and never takes one out. Do not edit by hand.',
    'export const TEMPLATE_HISTORY = Object.freeze({',
    ...entries,
    '});',
    '',
  ].join('\n');
}

/** The checked-in history, or none on the first build. */
async function readHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return {};
  const { TEMPLATE_HISTORY } = await import(pathToFileURL(HISTORY_FILE).href);
  return TEMPLATE_HISTORY;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const list = buildList();
  const hash = templateHash(list);
  const history = nextHistory(await readHistory(), list, hash);
  fs.writeFileSync(OUT_FILE, vocabularySource(list, hash));
  fs.writeFileSync(HISTORY_FILE, historySource(history));
  const unreviewed = unreviewedSentences(list);
  const warning = unreviewed.length ? ` The review in src/vocabulary.js never passed these sentences with the claims say.js gives them, so the vocabulary test fails, and pilot-check refuses every call made with this list, until each is read and listed on CLAIM_FREE when it claims nothing, or on CLAIMED with claims that cover what it says: ${unreviewed.map((s) => JSON.stringify(s)).join(', ')}.` : '';
  process.stdout.write(`Wrote ${OUT_FILE} and ${HISTORY_FILE}. The template list is ${hash}, one of ${Object.keys(history).length} in the history.${warning}\n`);
}
