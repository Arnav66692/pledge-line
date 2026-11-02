// Spoken templates. Every amount, date, invoice suffix and status word comes from a
// PayPal snapshot and is declared as a fact with its source path (I3).
import { NUMBER_WORDS, ORDINAL_WORDS, tokenize, runValue, ordinalValue } from './numbers.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'twentieth', 'thirtieth'];
export const STATUS_WORDS = ['active', 'suspended', 'cancelled', 'canceled', 'paused', 'sent', 'paid', 'unpaid', 'draft', 'approved'];
const NUMBERISH = new Set([...ONES, ...TENS.filter(Boolean), ...ORDINALS, 'hundred', 'thousand', 'million', 'billion', 'dozen']);
const BLOCKED_WORDS = new Set([...NUMBERISH, ...MONTHS, ...WEEKDAYS, ...STATUS_WORDS]);
// Stricter than I3 asks: the empathy may not hint at an action or a result either.
const ACTION_ROOTS = ['cancel', 'paus', 'suspend', 'resum', 'restart', 'refund', 'charg', 'stopp'];
const RESULT_WORDS = new Set(['done', 'off', 'ended', 'inactive', 'handled', 'finished', 'complete', 'completed', 'grand', 'half', 'couple']);
const RESULT_PHRASES = ['all set', 'taken care'];
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;
const EMPATHY_MAX_WORDS = 12;
const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const MONTH_PATTERN = '(January|February|March|April|May|June|July|August|September|October|November|December)';
const ANYTHING_ELSE = 'What else can I help with?';
// Not "may", which is also a month, so no month name is ever one of the line's own words (check.js holds replies to them).
const UPDATE_LATER = 'It can take a minute to update.';
const YES_OR_NO = 'Please say yes or no.';

const fact = (kind, value, source) => ({ kind, value, source });
const part = (text, facts = []) => ({ text, facts });

export function combine(...parts) {
  const items = parts.filter(Boolean).map((p) => (typeof p === 'string' ? part(p) : p));
  return { text: items.map((p) => p.text).filter(Boolean).join(' '), facts: items.flatMap((p) => p.facts) };
}

export function numberToWords(n) {
  if (!Number.isInteger(n) || n < 0 || n > 999999) return String(n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberToWords(n % 100)}` : ''}`;
  return `${numberToWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${numberToWords(n % 1000)}` : ''}`;
}

export function formatMoney(value, currency = 'USD') {
  const amount = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(amount) || typeof currency !== 'string') return null;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return null;
  }
}

export function formatDate(iso, timeZone = 'America/Los_Angeles') {
  if (typeof iso !== 'string') return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone }).format(date);
}

export function spokenStatus(status) {
  return typeof status === 'string' && status !== '' ? status.toLowerCase().replace(/_/g, ' ') : null;
}

export function last4(number) {
  return typeof number === 'string' && number !== '' ? number.slice(-4) : null;
}

const spellChar = (ch) => (/\d/.test(ch) ? DIGIT_WORDS[Number(ch)] : ch.toLowerCase());

/** "sb-maria@personal.example.com" becomes "s b at personal dot example dot com". No digits. */
export function maskEmail(email) {
  if (typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  const head = [...email.slice(0, at)].filter((ch) => /[a-z0-9]/i.test(ch)).slice(0, 2).map(spellChar).join(' ');
  const domain = email.slice(at + 1).toLowerCase().split('.').filter(Boolean)
    .map((label) => label.replace(/\d/g, (d) => ` ${DIGIT_WORDS[Number(d)]} `).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim())
    .join(' dot ');
  return `${head} at ${domain}`;
}

/** Derives the spoken value of a fact from a snapshot. check.js uses the same table. */
export const FACT_SOURCES = Object.freeze({
  'plan.price': (s) => formatMoney(s.price_value, s.price_currency ?? undefined),
  'subscription.status': (s) => spokenStatus(s.status),
  'subscription.next_billing_time': (s, timeZone) => formatDate(s.next_billing_time, timeZone),
  'invoice.amount': (s) => formatMoney(s.amount_value, s.amount_currency ?? undefined),
  'invoice.number_last4': (s) => last4(s.number),
  'invoice.status': (s) => spokenStatus(s.status),
  'invoice.recipient_email': (s) => maskEmail(s.recipient_email),
});

function derived(source, snapshot, kind, timeZone) {
  if (!snapshot) return null;
  const value = FACT_SOURCES[source](snapshot, timeZone);
  return value ? fact(kind, value, source) : null;
}

function giftPhrase(plan) {
  const money = derived('plan.price', plan, 'money');
  return money ? part(`your monthly gift of ${money.value}`, [money]) : part('your monthly gift');
}

function shows(sub, plan, lead = 'PayPal shows') {
  const gift = giftPhrase(plan);
  const status = derived('subscription.status', sub, 'status');
  const tail = status ? ` as ${status.value}` : '';
  return part(`${lead} ${gift.text}${tail}.`, [...gift.facts, ...(status ? [status] : [])]);
}

function invoicePhrase(inv) {
  const suffix = derived('invoice.number_last4', inv, 'number_suffix');
  const money = derived('invoice.amount', inv, 'money');
  const status = derived('invoice.status', inv, 'status');
  const bits = ['invoice'];
  if (suffix) bits.push(`ending in ${suffix.value}`);
  let text = bits.join(' ');
  if (money) text += `, for ${money.value},`;
  if (status) text += ` with the status ${status.value}`;
  return part(text.replace(/,$/, ''), [suffix, money, status].filter(Boolean));
}

export const greeting = (orgName) => part(`Thanks for calling the ${orgName} donor line. This is a PayPal sandbox demo, so no real money moves. To keep your gift safe, please enter your PIN on the keypad, or say its digits.`);
export const askPin = () => part('Please enter your PIN on the keypad, or say its digits.');
export const pinOk = () => part('Thanks, you are verified. I can read you your monthly gift, pause it, restart it, cancel it, or set up a one-time gift. What would you like to do?');
export const pinBad = (triesLeft) => part(`That PIN didn't match. You have ${numberToWords(triesLeft)} ${triesLeft === 1 ? 'try' : 'tries'} left.`);
export const pinLocked = () => part("That PIN didn't match too many times, so I've locked this call to keep your gift safe. Please call back later. Goodbye.");

export function giftStatus(sub, plan, { timeZone } = {}) {
  const base = shows(sub, plan);
  const date = sub?.status === 'ACTIVE' ? derived('subscription.next_billing_time', sub, 'date', timeZone) : null;
  const next = date ? part(`The next gift is on ${date.value}.`, [date]) : null;
  return combine(base, next, ANYTHING_ELSE);
}

// No "on hold" or "back on" here, since the facts check reads those as status claims (I3).
export const pauseOffer = (sub, plan) => combine(shows(sub, plan),
  'Before you stop it, I can pause it instead. Nothing more is taken during a pause, and you can restart it any time. Would you like me to pause it?', YES_OR_NO);
export const cancelConfirm = (sub, plan) => combine(shows(sub, plan),
  'Cancelling ends it for good, and it cannot be undone. Do you want me to cancel it?', YES_OR_NO);
export const resumeConfirm = (sub, plan) => combine(shows(sub, plan),
  'Restarting it means your monthly gift is taken again each month. Do you want me to restart it?', YES_OR_NO);
export const pauseConfirm = (sub, plan) => combine(shows(sub, plan),
  'Pausing it holds your monthly gift until you restart it. Do you want me to pause it?', YES_OR_NO);

const VERBS = Object.freeze({ suspend: 'pause', activate: 'restart', cancel: 'cancel', send_invoice: 'send' });
const EXPECTED = Object.freeze({ suspend: 'SUSPENDED', activate: 'ACTIVE', cancel: 'CANCELLED' });

export function nothingTo(kind, sub, plan) {
  const base = shows(sub, plan);
  return combine(part(base.text.replace(/\.$/, `, so there is nothing to ${VERBS[kind]} right now.`), base.facts), ANYTHING_ELSE);
}

export function invoiceConfirm(inv, orgName) {
  const phrase = invoicePhrase(inv);
  const email = derived('invoice.recipient_email', inv, 'email');
  const to = email ? part(`It would go to the email on file, ${email.value}.`, [email]) : part('It would go to the email on file.');
  return combine(part(`PayPal shows a one-time gift ${phrase.text}.`, phrase.facts), to,
    `The email comes from PayPal, shows ${orgName}, and has a link to pay. It never asks you to call a number. Should I send it?`, YES_OR_NO);
}

export function afterWrite(kind, snapshotAfter, plan, { ok = true } = {}) {
  if (kind === 'send_invoice') return afterSend(snapshotAfter, ok);
  if (!snapshotAfter) return combine("PayPal didn't return the gift just now, so I can't confirm the change. Staff will check on it.");
  const changed = snapshotAfter.status === EXPECTED[kind];
  if (!ok) return combine("PayPal didn't accept that change.", shows(snapshotAfter, plan, 'PayPal now shows'), ANYTHING_ELSE);
  if (!changed) return combine(`I asked PayPal to ${VERBS[kind]} it.`, shows(snapshotAfter, plan, 'PayPal now shows'), UPDATE_LATER, ANYTHING_ELSE);
  const tail = kind === 'suspend' ? 'You can restart it any time.' : null;
  return combine('Done.', shows(snapshotAfter, plan, 'PayPal now shows'), tail, ANYTHING_ELSE);
}

function afterSend(inv, ok) {
  if (!inv) return combine("I can't find that invoice in PayPal now, so I can't confirm it went out. Staff will check on it.");
  const phrase = invoicePhrase(inv);
  const now = part(`PayPal now shows ${phrase.text}.`, phrase.facts);
  if (!ok) return combine("PayPal didn't accept the send.", now, ANYTHING_ELSE);
  if (inv.status === 'DRAFT') return combine('I asked PayPal to send it.', now, UPDATE_LATER, ANYTHING_ELSE);
  return combine('Done.', now, 'PayPal will email it to the address on file.', ANYTHING_ELSE);
}

export const noPause = () => part('OK, no pause.');
export const declined = () => part(`OK, I won't change anything, so your monthly gift stays as it is. ${ANYTHING_ELSE}`);
export const draftDeleted = (notFound) => (notFound
  ? part(`OK, I deleted that invoice before it went out, and PayPal no longer shows it. ${ANYTHING_ELSE}`)
  : part('OK. I asked PayPal to delete that invoice, but PayPal still shows it. Staff will check on it.'));
export const otherEmail = () => part("For your safety, I can only send to the email already on file with PayPal, so I won't use a new email.");
export const help = () => part('I can read you your monthly gift, pause it, restart it, or cancel it. I can also set up a one-time gift as a PayPal invoice to the email on file, or ask staff to call you back.');
export const repeat = (lastText) => (lastText && lastText.text ? { text: lastText.text, facts: lastText.facts ?? [] } : unclear());
export const goodbye = () => part('Thanks for calling. Goodbye.');
export const unclear = () => part("Sorry, I didn't catch that. You can ask about your monthly gift, pause it, restart it, cancel it, or give a one-time gift.");
export const notVerified = () => part('I need your PIN first. Please enter it on the keypad.');
export const noSubscription = () => part("I couldn't find a monthly gift in PayPal for this line. Staff can help during open hours.");
export const noEmail = () => part("PayPal has no email on file for this gift, so I can't send an invoice. Staff can help during open hours.");
/** "from one dollar to five hundred dollars". check.js accepts the config facts only inside this phrase. */
export const limitsPhrase = (min, max) => `from ${numberToWords(min)} ${min === 1 ? 'dollar' : 'dollars'} to ${numberToWords(max)} dollars`;

const AMOUNT_QUESTION = 'How much would you like to give?';
const AMOUNT_FOR_FILE = 'If you would like to give a one-time gift to the email on file, tell me the amount.';

/** The limits are config, not PayPal facts, so they are declared with a config source that check.js holds to the config. */
export function amountOutOfRange(min, max) {
  const facts = [fact('money', formatMoney(min), 'config.invoice_min_dollars'), fact('money', formatMoney(max), 'config.invoice_max_dollars')];
  return part(`I can set up a one-time gift ${limitsPhrase(min, max)}. ${AMOUNT_QUESTION}`, facts);
}
/** Said after a new email is refused, when the turn named no amount as money. */
export const amountForFile = () => part(AMOUNT_FOR_FILE);
/** True when the line's last reply asked for an amount, so a bare number in the next turn answers it. */
export const asksForAmount = (text) => typeof text === 'string' && (text.includes(AMOUNT_QUESTION) || text.includes(AMOUNT_FOR_FILE));
export const nothingPending = () => part("There's nothing waiting for a yes or no right now. What would you like to do?");
export const needYesOrNo = () => part('I need a clear yes or no before I change anything.');
export const callEnded = () => part('This call has ended. Please start a new call if you need anything else.');
export const staffCallback = () => part("OK, I've noted that you'd like a call. Staff will call you back during open hours.");
export const paypalProblem = () => part("Sorry, I couldn't get a clear answer from PayPal just now, so I didn't change anything. Please try again in a minute.");
export const tooLong = () => part('Sorry, that was a lot at once. Please say it in a shorter way.');
export const turnLimit = () => part('This call has reached its limit. Please start a new call. Goodbye.');
export const expiredNotice = () => part("That earlier request timed out, so I didn't change anything.");
export const setAside = () => part("I've set that earlier request aside, so nothing changed.");
export const pinLimit = () => part("There have been too many wrong PINs from here, so I can't check a PIN right now. Please try again later.");

/**
 * The router only picks one of these keys. The line never speaks words the model wrote (I3),
 * so a model steered by the caller cannot claim an action or say a number.
 */
export const EMPATHY_PHRASES = Object.freeze({ none: '', sorry: "I'm sorry to hear that.", understand: 'I understand.', thanks: 'Thank you.' });
export const empathyPhrase = (key) => (typeof key === 'string' && Object.hasOwn(EMPATHY_PHRASES, key) ? EMPATHY_PHRASES[key] : '');

/** Returns the empathy text, or '' when it could carry a fact, an action or a result (I3). */
export function filterEmpathy(text) {
  if (typeof text !== 'string') return '';
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed === '' || trimmed.split(' ').length > EMPATHY_MAX_WORDS) return '';
  // Plain ASCII only, so digits, dashes and currency signs from other scripts never slip through.
  if (!PRINTABLE_ASCII.test(trimmed) || /[\d$;<>{}]/.test(trimmed)) return '';
  if (trimmed.includes('@') || /\bat\b.*\bdot\b/i.test(trimmed)) return '';
  const lower = trimmed.toLowerCase();
  const words = lower.match(/[a-z']+/g) ?? [];
  if (words.some((word) => BLOCKED_WORDS.has(word) || RESULT_WORDS.has(word))) return '';
  if (RESULT_PHRASES.some((phrase) => lower.includes(phrase))) return '';
  if (words.some((word) => ACTION_ROOTS.some((root) => word.startsWith(root)))) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

const longestFirst = (list) => [...list].sort((a, b) => b.length - a.length).join('|');
const NUMBER_WORD = `(?:${longestFirst(NUMBER_WORDS)})`;
const NUMBER_PHRASE = `(?:a\\s+)?${NUMBER_WORD}(?:[\\s-]+(?:and\\s+)?${NUMBER_WORD})*`;
const ORDINAL_PHRASE = `(?:(?:twenty|thirty)[\\s-]+)?(?:${longestFirst(ORDINAL_WORDS)})`;
const MONTH_WORD = `(${longestFirst(MONTHS)})`;
const capitalize = (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

function wordsAsMoney(m) {
  const amount = runValue(tokenize(m[1]));
  return formatMoney(/^cent/i.test(m[2]) ? amount / 100 : amount);
}

function wordsAsDay(phrase) {
  const words = tokenize(phrase);
  return ordinalValue(words) ?? runValue(words);
}

const STATUS_PATTERN = new RegExp(`\\b(${STATUS_WORDS.join('|')})\\b`, 'gi');
const SCANS = [
  { kind: 'money', regex: /\$\d[\d,]*(?:\.\d+)?/g, value: (m) => m[0] },
  { kind: 'date', regex: new RegExp(`\\b${MONTH_PATTERN}\\s+(\\d{1,2})\\b`, 'g'), value: (m) => `${m[1]} ${Number(m[2])}` },
  { kind: 'number_suffix', regex: /\bending in\s+([A-Za-z0-9#-]+)/gi, value: (m) => m[1] },
  // Amounts and dates said in words count too, such as "twenty five dollars" or "the first of December".
  { kind: 'money', regex: new RegExp(`\\b(${NUMBER_PHRASE})[\\s-]+(dollars?|bucks|cents?)\\b`, 'gi'), value: wordsAsMoney },
  { kind: 'date', regex: new RegExp(`\\b(?:the\\s+)?(${ORDINAL_PHRASE})\\s+of\\s+${MONTH_WORD}\\b`, 'gi'), value: (m) => `${capitalize(m[2])} ${wordsAsDay(m[1])}` },
  { kind: 'date', regex: new RegExp(`\\b${MONTH_WORD}\\s+(?:the\\s+)?(${ORDINAL_PHRASE}|${NUMBER_WORD}(?:[\\s-]+${NUMBER_WORD})?)\\b`, 'gi'), value: (m) => `${capitalize(m[1])} ${wordsAsDay(m[2])}` },
  { kind: 'status', regex: STATUS_PATTERN, value: (m) => m[1].toLowerCase() },
  // \p{Nd} catches digits from every script, such as full-width or Arabic-Indic ones.
  { kind: 'number', regex: /\p{Nd}+/gu, value: (m) => m[0] },
];

// The strict scans run over what the fact scans leave, and catch facts said in forms no template uses, such as
// "every thirty days", "on the fifteenth", "Dec first", "on Tuesday", "on hold" or "turned back on" (I3).
// The line's own phrases that carry no fact, "one-time" and "two tries left", are set aside first.
const ALLOWED_PHRASES = [/\bone[\s-]time\b/gi, new RegExp(`\\b${NUMBER_WORD}\\s+(?:tries|try)\\s+left\\b`, 'gi')];
const EXTRA_NUMBER_WORDS = ['million', 'billion', 'dozen', 'half', 'couple'];
const MONTH_ABBREVIATIONS = ['jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec'];
const DAY_WORDS = [...WEEKDAYS, 'today', 'tonight', 'tomorrow', 'yesterday', 'weekend'];
const STATUS_PHRASES = ['on hold', 'on pause', 'back on', 'turned on', 'turned off', 'off', 'stopped', 'inactive', 'restarted', 'resumed', 'reactivated'];
const LATER_ORDINALS = ORDINAL_WORDS.filter((word) => word !== 'first');
const DATE_LEAD = `(?:the|on|${longestFirst([...MONTHS, ...MONTH_ABBREVIATIONS])})`;
const STRICT_SCANS = [
  { kind: 'date', regex: new RegExp(`\\b(${longestFirst(LATER_ORDINALS)})\\b`, 'gi'), value: (m) => m[1].toLowerCase() },
  // "first" is a plain word too, as in "I need your PIN first", so it counts only where a date would put it.
  { kind: 'date', regex: new RegExp(`\\b${DATE_LEAD}\\.?\\s+first\\b|\\bfirst\\s+of\\b`, 'gi'), value: () => 'first' },
  { kind: 'date', regex: new RegExp(`\\b(${longestFirst(DAY_WORDS)})s?\\b`, 'gi'), value: (m) => m[1].toLowerCase() },
  { kind: 'number', regex: new RegExp(`\\b(${longestFirst([...NUMBER_WORDS, ...EXTRA_NUMBER_WORDS])})\\b`, 'gi'), value: (m) => m[1].toLowerCase() },
  // "This call has ended" is about the call, not the gift.
  { kind: 'status', regex: /(?<!\bcall\s+(?:has\s+)?)\bended\b/gi, value: () => 'ended' },
  { kind: 'status', regex: new RegExp(`\\b(${longestFirst(STATUS_PHRASES).replace(/ /g, '\\s+')})\\b`, 'gi'), value: (m) => m[1].toLowerCase().replace(/\s+/g, ' ') },
];

function runScans(text, scans, found) {
  let rest = text;
  for (const scan of scans) {
    for (const match of rest.matchAll(scan.regex)) found.push({ kind: scan.kind, value: scan.value(match) });
    rest = rest.replace(scan.regex, ' ');
  }
  return rest;
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A phrase counts only as whole words, so "active" is never found inside "inactive" and "December 1" never inside "December 15".
const wholePhrase = (phrase, flags) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(phrase)}(?![\\p{L}\\p{N}])`, flags);

/** True when the text says the phrase as whole words, in any case. */
export const saysPhrase = (text, phrase) => typeof phrase === 'string' && phrase.trim() !== '' && wholePhrase(phrase, 'iu').test(String(text ?? ''));

/** The words a declared fact is spoken as. A suffix is spoken as "ending in 0001". */
export const spokenForm = (f) => (f.kind === 'number_suffix' ? `ending in ${f.value}` : String(f.value ?? ''));

/**
 * Finds money, dates, "ending in" suffixes and status words, in digits or in words, and any other digit runs.
 * strict adds the scans above, which check.js and the ORG_NAME check use. skip lists spoken phrases, such as
 * facts already proven against a PayPal read or the org name, that are set aside as whole words before any scan.
 * rest is what is left once the skipped phrases, the allowed phrases and every scan's matches are set aside.
 */
export function scanSpoken(text, { strict = false, skip = [] } = {}) {
  const found = [];
  const start = skip.filter((phrase) => typeof phrase === 'string' && phrase.trim() !== '')
    .reduce((acc, phrase) => acc.replace(wholePhrase(phrase, 'giu'), ' '), String(text ?? ''));
  let rest = runScans(start, SCANS, found);
  if (strict) rest = runScans(ALLOWED_PHRASES.reduce((acc, pattern) => acc.replace(pattern, ' '), rest), STRICT_SCANS, found);
  return { found, rest };
}

export const extractSpokenFacts = (text, options) => scanSpoken(text, options).found;

const WORD = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu;

/** The lowercase words of a text, apostrophes kept, as the facts check compares them with the template words. */
export const wordsOf = (text) => String(text ?? '').toLowerCase().replace(/[‘’]/g, "'").match(WORD) ?? [];

/** Braces mark slots, so a reply that says one could pass for a template sentence. No template says one. */
export const SLOT_MARKS = /[{}]/;

/**
 * The text with the org name and each fact's spoken form, longest first, turned into slots such as {org} and
 * {plan.price}. A slot names the fact's source, so a sentence that puts the invoice amount where the gift's
 * amount goes never matches a template sentence (R3-6).
 */
export function slotFacts(text, facts = [], orgName = null) {
  let out = String(text ?? '');
  if (typeof orgName === 'string' && orgName.trim() !== '') out = out.replace(wholePhrase(orgName, 'giu'), '{org}');
  const named = facts.filter((f) => f && typeof f.source === 'string' && spokenForm(f).trim() !== '');
  for (const f of [...named].sort((a, b) => spokenForm(b).length - spokenForm(a).length)) {
    out = out.replace(wholePhrase(spokenForm(f), 'giu'), `{${f.source}}`);
  }
  return out;
}

/** The sentences of a text, each ending at a period, question mark or exclamation mark, spaces collapsed. */
export const sentencesOf = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().split(/(?<=[.?!]) /).filter(Boolean);
