// Reads an amount out of a caller's own words, and decides in code whether it is clearly the gift. Every router's
// amount passes through here, the rules router's and a model's, so the model only routes and code decides (I6).
import { tokenize, numberRuns, runValue, isNumberWord, isWellFormedRun, NUMBER_WORDS } from './numbers.js';
import { asksForAmount } from './say.js';

const DOLLAR_WORDS = new Set(['dollar', 'dollars', 'bucks', 'usd']);
const CENT_WORDS = new Set(['cent', 'cents']);
const CENTS_PER_DOLLAR = 100;
// Numbers in fixed phrases that are never amounts, "one time", "two times" and "two tries left", are set aside.
const FIXED_NEXT = new Set(['time', 'times']);
const TRY_WORDS = new Set(['try', 'tries']);
// "fifty off", "one more time" and "2 gifts" are not amounts.
const NOT_AMOUNT_NEXT = new Set(['off', 'more', 'gift', 'gifts', 'donation', 'donations']);
// A run cut short by a fixed phrase never ends on these, so "a hundred and one time" keeps "a hundred".
const LOOSE_ENDS = new Set(['and', 'a']);
// A caller correcting a number mid-sentence, as in "fifty dollars, I mean sixty". The line asks rather than pick one.
const CORRECTIONS = [['i', 'mean'], ['no', 'wait'], ['wait'], ['actually'], ['sorry'], ['make', 'that'], ['or', 'rather'], ['scratch', 'that']];
// In rules mode a bare number is an amount only right after one of these, unless it answers the line's amount question.
const GIVE_WORDS = new Set(['give', 'donate']);
// Returned when the caller's words hold no single clear amount, so the line asks for one.
const NO_CLEAR_AMOUNT = 0;
// Words that name more than one amount, or correct one, so no amount is clear, whoever reads them (R3-1).
const CONFLICT = Object.freeze({ amount: NO_CLEAR_AMOUNT, conflict: true, why: 'two_numbers' });
const CORRECTED = Object.freeze({ amount: NO_CLEAR_AMOUNT, conflict: true, why: 'correction' });
const amountOf = (amount) => ({ amount, conflict: false });

const toDollars = (raw) => Math.round(Number(String(raw).replace(/,/g, '')) * 100) / 100;
const distinct = (values) => [...new Set(values)];

// A figure that is not part of a longer number, so "1,500" is never read as 500 and "0.001" never as 1.
const DIGIT_AMOUNT = String.raw`(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)(?![\d.,]*\d)`;
const SIGN_AMOUNT = new RegExp(String.raw`\$\s?${DIGIT_AMOUNT}`, 'g');
const NAMED_AMOUNT = new RegExp(String.raw`(?<![\w.,])${DIGIT_AMOUNT}\s*(dollars?|bucks|usd|cents?)\b`, 'g');

/** Amounts the caller marked as money, as {dollars, cents} lists. "fifty cents" and "50 cents" are cents. */
function markedAmounts(lower, tokens, runs) {
  const dollars = [...lower.matchAll(SIGN_AMOUNT)].map((m) => toDollars(m[1]));
  const cents = [];
  let unclear = false;
  for (const m of lower.matchAll(NAMED_AMOUNT)) (CENT_WORDS.has(m[2]) ? cents : dollars).push(toDollars(m[1]));
  for (const run of runs) {
    const unit = tokens[run.end + 1] ?? '';
    if (!DOLLAR_WORDS.has(unit) && !CENT_WORDS.has(unit)) continue;
    if (!isWellFormedRun(run.words)) unclear = true;
    (CENT_WORDS.has(unit) ? cents : dollars).push(runValue(run.words));
  }
  return { dollars: distinct(dollars), cents: distinct(cents), unclear };
}

/** "5 dollars and 50 cents" is 5.50, "fifty cents" is 0.50. Two different amounts are not one clear amount. */
function combineMarked({ dollars, cents, unclear }) {
  if (unclear || dollars.length > 1 || cents.length > 1) return CONFLICT;
  if (cents.length === 0) return amountOf(dollars[0]);
  const [c] = cents;
  if (dollars.length === 0) return amountOf(toDollars(c / CENTS_PER_DOLLAR));
  return Number.isInteger(c) && c < CENTS_PER_DOLLAR ? amountOf(toDollars(dollars[0] + c / CENTS_PER_DOLLAR)) : CONFLICT;
}

// One token per figure such as "1,500" or "12.50", per other digit run, and per word, in the order said.
const SAID_TOKEN = new RegExp(String.raw`(?<![\w.,])${DIGIT_AMOUNT}|(\d+)|([a-z]+)`, 'g');

function saidTokens(lower) {
  return [...lower.matchAll(SAID_TOKEN)].map((m) => {
    if (m[1] !== undefined) return { word: '', value: toDollars(m[1]), clean: true };
    if (m[2] !== undefined) return { word: '', value: Number(m[2]), clean: false };
    return { word: m[3] };
  });
}

/** True when the word at i is the number of a fixed phrase, "one time", "two times" or "two tries left". */
const inFixedPhrase = (words, i) => FIXED_NEXT.has(words[i + 1]) || (TRY_WORDS.has(words[i + 1]) && words[i + 2] === 'left');

/** A run of number words minus the one word a fixed phrase owns, so "sixty, one time" still says sixty (R3-1). */
function keptRun(words, run) {
  const kept = inFixedPhrase(words, run.end) ? run.words.slice(0, -1) : [...run.words];
  while (kept.length > 0 && LOOSE_ENDS.has(kept.at(-1))) kept.pop();
  if (kept.length === 0) return [];
  return [{ at: run.start, end: run.start + kept.length - 1, value: runValue(kept), clean: isWellFormedRun(kept) }];
}

/** Every number said, as {at, end, value, clean}: figures, other digit runs and runs of number words, minus fixed phrases. */
function numbersSaid(said) {
  const words = said.map((t) => t.word);
  const runs = numberRuns(words).flatMap((run) => keptRun(words, run));
  const figures = said.flatMap((t, i) => (t.word === '' && !inFixedPhrase(words, i) ? [{ at: i, end: i, value: t.value, clean: t.clean }] : []));
  return [...runs, ...figures].sort((a, b) => a.at - b.at);
}

/** "fifty dollars, I mean sixty": a correction with a number before it and another after it. */
function correctsItself(words, numbers) {
  return words.some((_, i) => CORRECTIONS.some((phrase) => phrase.every((word, k) => words[i + k] === word)
    && numbers.some((n) => n.end < i) && numbers.some((n) => n.at >= i + phrase.length)));
}

/** A number said with no currency, such as "twenty five" or "75". Two different numbers, or "twelve fifty", is unclear. */
function plainAmount(numbers, words, bareAfterGive) {
  const values = distinct(numbers.map((n) => n.value));
  if (values.length > 1 || !numbers.every((n) => n.clean)) return CONFLICT;
  if (values.length === 0 || numbers.some((n) => NOT_AMOUNT_NEXT.has(words[n.end + 1]))) return amountOf(NO_CLEAR_AMOUNT);
  if (bareAfterGive && !numbers.some((n) => GIVE_WORDS.has(words[n.at - 1]))) return amountOf(NO_CLEAR_AMOUNT);
  return amountOf(values[0]);
}

// "fifty point five" could mean cents or a slip, so the line asks for the amount again instead of guessing.
function saysPoint(tokens) {
  const numeric = (token) => typeof token === 'string' && (/^\d+$/.test(token) || isNumberWord(token));
  return tokens.some((token, i) => token === 'point' && numeric(tokens[i - 1]) && numeric(tokens[i + 1]));
}

/** How the caller's words name an amount, as {amount, conflict}. conflict means they name more than one or correct one. */
function readAmount(text, { needCurrency = false, bareAfterGive = false } = {}) {
  const lower = String(text ?? '').normalize('NFKC').toLowerCase();
  const tokens = tokenize(lower);
  if (saysPoint(tokens)) return CONFLICT;
  const said = saidTokens(lower);
  const words = said.map((t) => t.word);
  const numbers = numbersSaid(said);
  if (correctsItself(words, numbers)) return CORRECTED;
  const marked = markedAmounts(lower, tokens, numberRuns(tokens));
  if (marked.unclear || marked.dollars.length > 0 || marked.cents.length > 0) {
    // Every number said must belong to the one amount, so "fifty dollars and 60" is not fifty.
    const amount = new Set([...marked.dollars, ...marked.cents]);
    return numbers.every((n) => amount.has(n.value)) ? combineMarked(marked) : CONFLICT;
  }
  const plain = plainAmount(numbers, words, bareAfterGive);
  return needCurrency && !plain.conflict ? amountOf(NO_CLEAR_AMOUNT) : plain;
}

/**
 * Parses "fifty dollars", "$50", "25 dollars", "fifty cents" or "twenty five". Returns 0 when no single clear
 * amount is heard, so the line asks: a correction, two different numbers, or a number that is not well formed.
 * With needCurrency, a number counts only when it is said as money. With bareAfterGive, a bare number counts
 * only right after give or donate, as in "give 75".
 */
export const parseAmountDollars = (text, options) => readAmount(text, options).amount;

/**
 * True when the caller's words correct an amount or name two different numbers, once the fixed phrases are set
 * aside. Then the line asks for the amount, whatever amount the router heard. Words with no number at all are no
 * conflict, so an amount only Haiku can read still counts (R3-1).
 */
export const amountConflict = (text) => readAmount(text).conflict;

// ---- Is it clearly the gift? ----

const SAME_DOLLARS = (a, b) => Math.round(a * CENTS_PER_DOLLAR) === Math.round(b * CENTS_PER_DOLLAR);
const plainWords = (text) => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'").replace(/-/g, ' ').replace(/\s+/g, ' ').trim();

// An amount that leans on something else, as in "double that" or "the same as before". No number here can be the gift.
const RELATIVE = /\b(?:double|twice|triple|half|same|usual|more|less|as much|that much|what i gave|a couple|a few|a little|a bit)\b/;
// A correction with nothing after it, as in "fifty dollars, I mean double that" or "fifty dollars, scratch that".
const OPEN_ENDED = [['i', 'mean'], ['no', 'wait'], ['wait'], ['make', 'that'], ['or', 'rather'], ['scratch', 'that'], ['actually', 'no'], ['never', 'mind'], ['hold', 'on'], ['on', 'second', 'thought'], ['no']];
const HEDGES = new Set(['about', 'around', 'roughly', 'maybe', 'perhaps', 'approximately', 'say']);
const AGE_NEXT = new Set(['year', 'years', 'yrs', 'yo']);
const AGE_BEFORE = new Set(['im', 'age', 'aged', 'turned', 'turning']);
const AGE_FILLERS = new Set(['only', 'almost', 'nearly', 'about', 'over', 'just']);
const NUMBER_AHEAD = String.raw`(?:\$\s?\d|\b\d|\b(?:${NUMBER_WORDS.join('|')})\b)`;
const NEGATED = new RegExp(String.raw`\b(?:not|never|don't|dont|do not|didn't|didnt|can't|cant|cannot|won't|wont|wouldn't|wouldnt)\b[^.,;!?]*?${NUMBER_AHEAD}`);
const RECURRING = /\b(?:a|per|each|every)\s+(?:month|year|week)\b|\bmonthly\b/;
// Words that plainly change a draft's amount, as against "a little more time", so only these set a waiting draft aside.
const CHANGES_THE_AMOUNT = /\b(?:double|twice|triple|half)\b/;

/** The two readings of one turn that the clarity checks share. */
function saidIn(text) {
  const lower = String(text ?? '').normalize('NFKC').toLowerCase();
  const said = saidTokens(lower);
  const tokens = tokenize(lower);
  const marked = markedAmounts(lower, tokens, numberRuns(tokens));
  return { words: said.map((t) => t.word), numbers: numbersSaid(said), marked: marked.unclear || marked.dollars.length > 0 || marked.cents.length > 0 };
}

const phraseAt = (words, i, phrase) => phrase.every((word, k) => words[i + k] === word);

function leavesItOpen(words, numbers) {
  return words.some((_, i) => OPEN_ENDED.some((phrase) => phraseAt(words, i, phrase) && numbers.some((n) => n.end < i) && !numbers.some((n) => n.at >= i + phrase.length)));
}

function saysAge(words, numbers) {
  return numbers.some((n) => {
    if (AGE_NEXT.has(words[n.end + 1])) return true;
    const i = AGE_FILLERS.has(words[n.at - 1]) ? n.at - 2 : n.at - 1;
    const before = words[i];
    return AGE_BEFORE.has(before) || ((before === 'am' || before === 'm') && words[i - 1] === 'i') || (before === 's' && ['he', 'she'].includes(words[i - 1]));
  });
}

function isHedged(words, numbers) {
  return numbers.some((n) => HEDGES.has(words[n.at - 1]) || (words[n.end + 1] === 'or' && words[n.end + 2] === 'so') || (words[n.end + 2] === 'or' && words[n.end + 3] === 'so'));
}

/** Why a number in these words can't be the gift, or null. Each of these asks, whatever any router heard. */
function whyNotTheGift(text, base, said) {
  const plain = plainWords(text);
  if (RELATIVE.test(plain)) return 'relative';
  if (base.conflict) return base.why;
  if (leavesItOpen(said.words, said.numbers)) return 'correction';
  if (saysAge(said.words, said.numbers)) return 'age';
  if (base.amount > 0 && NEGATED.test(plain)) return 'negated';
  if (base.amount > 0 && isHedged(said.words, said.numbers)) return 'hedged';
  if (base.amount > 0 && RECURRING.test(plain)) return 'recurring';
  return base.amount === 0 && said.numbers.length > 0 ? 'not_money' : null;
}

/**
 * The amount these words clearly give, as {amount, why, marked}. amount is 0 when none is clear, and why says what
 * kept it from counting, null when the words simply name no number. marked says the words name money. A bare number
 * counts only right after give or donate, or as the answer to the line's own amount question.
 */
export function readGift(text, { needCurrency = false, answersQuestion = false } = {}) {
  const base = readAmount(text, { needCurrency, bareAfterGive: !answersQuestion });
  const said = saidIn(text);
  const why = whyNotTheGift(text, base, said);
  return { amount: why ? NO_CLEAR_AMOUNT : base.amount, why, marked: said.marked };
}

// Not "what I gave" or "as I gave", which lean on an old gift to name a new one.
const PAST_GIFT = /(?<!\b(?:what|as) i )\b(?:gave|donated|paid)\b|\bused to (?:give|donate|pay)\b/;
const OWN_ASK = /\b(?:do|did|does|am|have|has)\s+(?:i|we|she|he)\s+(?:still\s+|already\s+)?(?:give|giving|given|donate|donating|donated|pay|paying|paid)\b/;
const GIFT_IS = /\bmy\s+(?:\w+\s+){0,2}(?:gift|donation|pledge)\s+(?:is|was)\b/;
const GIVES_MONTHLY = /^(?:so\s+|well\s+)?i\s+(?:already\s+)?(?:give|donate|pay)\b.*(?:\b(?:a|per|each|every)\s+month\b|\bmonthly\b)/;
const OWN_GIFT = /\bmy\s+(?:\w+\s+){0,2}(?:gift|donation|pledge|subscription|payment)\b/;
const CAN_GIVE = /\b(?:can|could|may|would|should)\s+i\s+(?:please\s+|also\s+)?(?:give|donate|make)\b/;
const OPENS_QUESTION = /^(?:(?:so|and|um|uh|well|wait)\s+)*(?:is|isn't|isnt|was|wasn't|wasnt|am|are|aren't|arent|did|didn't|didnt|does|doesn't|doesnt|do|don't|dont|has|hasn't|hasnt|how much|how come|what|what's|whats|when|when's|whens|why|which)\b/;
const ENDS_ASKING = /(?:\?|\b(?:right|correct|isn't it|is it))\W*$/;
const WANTS_TO_GIVE = /\b(?:give|donate|one time|onetime|once|one off|extra gift|another gift|invoice)\b/;
// A past gift and a request to give again can share an utterance. Do not silently choose either interpretation.
const NEW_GIFT_REQUEST = /\b(?:(?:want|wish|plan) to|would like to|like to|'d like to|going to|(?:can|could|may) i|please|let me)\s+(?:also\s+|now\s+)?(?:give|donate|make\s+(?:(?:a|another|one)\s+)?(?:one\s+time\s+)?(?:gift|donation))\b/;

export function mixedGiftRequest(text) {
  const t = plainWords(text);
  return PAST_GIFT.test(t) && NEW_GIFT_REQUEST.test(t);
}

/**
 * True when the words are about the gift she already has, not a new one, as in "Is my gift still seventy five dollars
 * a month?" or "I gave fifty dollars last month". A number in them is not a gift, and PayPal's record answers them.
 */
export function aboutExistingGift(text) {
  const t = plainWords(text);
  if (PAST_GIFT.test(t) || OWN_ASK.test(t) || GIFT_IS.test(t) || GIVES_MONTHLY.test(t)) return true;
  const opens = OPENS_QUESTION.test(t);
  if ((opens || ENDS_ASKING.test(t)) && OWN_GIFT.test(t) && !CAN_GIVE.test(t)) return true;
  return opens && !WANTS_TO_GIVE.test(t);
}

/**
 * True when words that hold no clear amount should still get the amount question, not "I didn't catch that": they name
 * money, they answer the line's own amount question, or they correct a draft waiting for a yes, as in "I mean double that".
 */
export function opensGift(reading, text, state = {}) {
  if (!reading.why || reading.why === 'not_money') return false;
  return reading.marked || asksForAmount(state?.lastSaid) || (state?.pendingKind === 'send_invoice' && CHANGES_THE_AMOUNT.test(plainWords(text)));
}

/** A route with no clear amount, with why, and what the caller named when she named one. */
const unclearRoute = (routed, why, extra = {}) => ({ ...routed, intent: 'one_time_gift', amountDollars: NO_CLEAR_AMOUNT, amountUnclear: why, ...extra });

/**
 * Holds any router's answer to the caller's own words, the rules router's and a model's alike. A question about the
 * gift she has goes to its status. A one-time gift keeps an amount only when code reads the same clear amount from her
 * words, so a model's slip, or a number it read in passing, never makes a draft. The model's number is never used alone.
 */
export function settleGiftRoute(routed, text, state = {}) {
  if (mixedGiftRequest(text)) return { ...routed, intent: 'unclear', amountDollars: NO_CLEAR_AMOUNT, clarifyGift: true };
  const reading = readGift(text, { answersQuestion: asksForAmount(state?.lastSaid) });
  const named = parseAmountDollars(text);
  if (routed.intent === 'gift_status') return reading.marked && aboutExistingGift(text) ? { ...routed, amountUnclear: 'existing_gift', namedDollars: named } : routed;
  if (routed.intent === 'unclear') return opensGift(reading, text, state) && !aboutExistingGift(text) ? unclearRoute(routed, reading.why) : routed;
  if (routed.intent !== 'one_time_gift') return routed;
  if (aboutExistingGift(text)) return { ...routed, intent: 'gift_status', amountDollars: NO_CLEAR_AMOUNT, amountUnclear: 'existing_gift', namedDollars: named };
  if (reading.why) return unclearRoute(routed, reading.why);
  if (SAME_DOLLARS(reading.amount ?? 0, routed.amountDollars ?? 0)) return routed;
  return unclearRoute(routed, routed.amountDollars > 0 ? 'router_other_amount' : 'router_heard_none');
}
