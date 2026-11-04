// Spoken templates. Every amount, date, invoice suffix and status word comes from a
// PayPal snapshot and is declared as a fact with its source path (I3).
import { NUMBER_WORDS, ORDINAL_WORDS, tokenize, runValue, ordinalValue } from './numbers.js';
import { isRefundedStatus } from './cover.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'twentieth', 'thirtieth'];
// The last four are PayPal's words for a charge, so a reply can only say a charge was refunded when a read says so.
export const STATUS_WORDS = ['active', 'suspended', 'cancelled', 'canceled', 'paused', 'sent', 'paid', 'unpaid', 'draft', 'approved',
  'completed', 'refunded', 'declined', 'pending'];
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
const STAFF_CHECK = 'Staff will check on it.';
const STAFF_HOURS = 'Staff can help during open hours.';

const fact = (kind, value, source) => ({ kind, value, source });

/** The sentences of a text, each ending at a period, question mark or exclamation mark, spaces collapsed. */
export const sentencesOf = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().split(/(?<=[.?!]) /).filter(Boolean);

// A claim ties a sentence to what it says PayPal or the line did, such as "Done." to an ok write in that turn.
// A claim is not spoken as its value, so it names its sentence, and check.js proves it against the call's own
// events up to the reply (R4-1). Each sentence of a part gets each of the part's claims.
const part = (text, facts = [], claims = []) => ({ text, facts, claims: sentencesOf(text).flatMap((sentence) => claims.map((claim) => ({ claim, sentence }))) });
const claim = (text, name) => part(text, [], [name]);

export function combine(...parts) {
  const items = parts.filter(Boolean).map((p) => (typeof p === 'string' ? part(p) : p));
  return { text: items.map((p) => p.text).filter(Boolean).join(' '), facts: items.flatMap((p) => p.facts), claims: items.flatMap((p) => p.claims ?? []) };
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
  // The latest charge on the gift, from GET /v1/billing/subscriptions/{id}/transactions.
  'charge.amount': (s) => formatMoney(s.amount_value, s.amount_currency ?? undefined),
  'charge.date': (s, timeZone) => formatDate(s.time, timeZone),
  'charge.status': (s) => spokenStatus(s.status),
  'charge.id_last4': (s) => last4(s.transaction_id),
  // Covered Month. The donor's charge by its own id, from GET /v2/payments/captures/{id}, and the sponsor's capture the same way.
  'gift_charge.amount': (s) => formatMoney(s.amount_value, s.amount_currency ?? undefined),
  'gift_charge.status': (s) => spokenStatus(s.status),
  'capture.status': (s) => spokenStatus(s.status),
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

// A sentence with no fact to prove it still says PayPal returned the gift or the draft, so it claims that read (R4-1).
const readClaims = (facts, name) => (facts.length > 0 ? [] : [name]);

function shows(sub, plan, lead = 'PayPal shows', end = '.', extra = []) {
  const gift = giftPhrase(plan);
  const status = derived('subscription.status', sub, 'status');
  const tail = status ? ` as ${status.value}` : '';
  const facts = [...gift.facts, ...(status ? [status] : [])];
  return part(`${lead} ${gift.text}${tail}${end}`, facts, [...readClaims(facts, 'gift_read'), ...extra]);
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
export const pinOk = () => combine(claim('Thanks, you are verified.', 'pin_ok'),
  'I can read you your monthly gift, pause it, restart it, cancel it, or set up a one-time gift. What would you like to do?');
export const pinBad = (triesLeft) => combine(claim("That PIN didn't match.", 'pin_bad'),
  claim(`You have ${numberToWords(triesLeft)} ${triesLeft === 1 ? 'try' : 'tries'} left.`, `tries_left=${triesLeft}`));
export const pinLocked = () => combine(claim("That PIN didn't match too many times, so I've locked this call to keep your gift safe.", 'pin_locked'),
  'Please call back later. Goodbye.');

export function giftStatus(sub, plan, { timeZone } = {}) {
  const base = shows(sub, plan);
  const date = sub?.status === 'ACTIVE' ? derived('subscription.next_billing_time', sub, 'date', timeZone) : null;
  // A next gift is only taken while the gift is active, so the sentence claims that, beside its date (R4-1).
  const next = date ? part(`The next gift is on ${date.value}.`, [date], ['gift_active']) : null;
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

// "Nothing to pause" says the gift's status rules the change out, so it claims that, and check.js proves it against the read (R4-1).
export function nothingTo(kind, sub, plan) {
  return combine(shows(sub, plan, 'PayPal shows', `, so there is nothing to ${VERBS[kind]} right now.`, [`nothing_to=${kind}`]), ANYTHING_ELSE);
}

/** The draft's number, amount and status as PayPal's latest read gives them. */
function invoiceShows(inv) {
  const phrase = invoicePhrase(inv);
  return part(`PayPal shows a one-time gift ${phrase.text}.`, phrase.facts, readClaims(phrase.facts, 'invoice_read'));
}

export function invoiceConfirm(inv, orgName) {
  const email = derived('invoice.recipient_email', inv, 'email');
  const to = email ? part(`It would go to the email on file, ${email.value}.`, [email]) : claim('It would go to the email on file.', 'invoice_read');
  return combine(invoiceShows(inv), to,
    `The email comes from PayPal, shows ${orgName}, and has a link to pay. It never asks you to call a number. Should I send it?`, YES_OR_NO);
}

// A write PayPal answered with no clear yes or no, a timeout or a 5xx, may have gone through, so the line read PayPal
// again and says what it shows, rather than say PayPal refused it (L2).
const UNCLEAR_ANSWER = "PayPal didn't answer clearly, so I checked again.";
const failedLead = (unclear, sentence, name) => (unclear ? claim(UNCLEAR_ANSWER, 'write_unclear') : claim(sentence, name));

// Each sentence that says how a write went claims it, so check.js proves it against that turn's write and reads (R4-1).
export function afterWrite(kind, snapshotAfter, plan, { ok = true, unclear = false } = {}) {
  if (kind === 'send_invoice') return afterSend(snapshotAfter, ok, unclear);
  if (!snapshotAfter) return combine(claim("PayPal didn't return the gift just now, so I can't confirm the change.", 'gift_unread'), STAFF_CHECK);
  const changed = snapshotAfter.status === EXPECTED[kind];
  const now = shows(snapshotAfter, plan, 'PayPal now shows');
  if (!ok) return combine(failedLead(unclear, "PayPal didn't accept that change.", 'write_failed'), now, ANYTHING_ELSE);
  if (!changed) return combine(claim(`I asked PayPal to ${VERBS[kind]} it.`, `wrote_${kind}`), now, claim(UPDATE_LATER, 'wrote'), ANYTHING_ELSE);
  const tail = kind === 'suspend' ? claim('You can restart it any time.', 'wrote_suspend') : null;
  return combine(claim('Done.', 'wrote'), now, tail, ANYTHING_ELSE);
}

function afterSend(inv, ok, unclear) {
  if (!inv) return combine(claim("I can't find that invoice in PayPal now, so I can't confirm it went out.", 'invoice_unread'), STAFF_CHECK);
  const phrase = invoicePhrase(inv);
  const now = part(`PayPal now shows ${phrase.text}.`, phrase.facts, readClaims(phrase.facts, 'invoice_read'));
  if (!ok) return combine(failedLead(unclear, "PayPal didn't accept the send.", 'send_failed'), now, ANYTHING_ELSE);
  if (inv.status === 'DRAFT') return combine(claim('I asked PayPal to send it.', 'wrote_send_invoice'), now, claim(UPDATE_LATER, 'wrote'), ANYTHING_ELSE);
  return combine(claim('Done.', 'wrote'), now, claim('PayPal will email it to the address on file.', 'wrote_send_invoice'), ANYTHING_ELSE);
}

export const noPause = () => claim('OK, no pause.', 'no_pause');
export const declined = () => combine(claim("OK, I won't change anything, so your monthly gift stays as it is.", 'unchanged'), ANYTHING_ELSE);
export const draftDeleted = (notFound) => (notFound
  ? combine(claim('OK, I deleted that invoice before it went out, and PayPal no longer shows it.', 'draft_deleted'), ANYTHING_ELSE)
  : combine('OK.', claim('I asked PayPal to delete that invoice, but PayPal still shows it.', 'draft_kept'), STAFF_CHECK));
export const otherEmail = () => claim("For your safety, I can only send to the email already on file with PayPal, so I won't use a new email.", 'email_refused');
export const help = () => part('I can read you your monthly gift, pause it, restart it, or cancel it. I can also set up a one-time gift as a PayPal invoice to the email on file, or ask staff to call you back. If you see a PayPal charge you don\'t recognize, I can tell you what it was. If you can\'t afford this month, I can see if a sponsor can cover it.');
// A repeat keeps the claims of the reply it repeats, and call.js logs which turn that was, so check.js proves them there.
export const repeat = (lastText) => (lastText && lastText.text ? { text: lastText.text, facts: lastText.facts ?? [], claims: lastText.claims ?? [] } : unclear());
export const goodbye = () => part('Thanks for calling. Goodbye.');
export const unclear = () => part("Sorry, I didn't catch that. You can ask about your monthly gift, pause it, restart it, cancel it, or give a one-time gift.");
export const notVerified = () => combine(claim('I need your PIN first.', 'not_verified'), 'Please enter it on the keypad.');
export const noSubscription = () => combine(claim("I couldn't find a monthly gift in PayPal for this line.", 'no_gift'), STAFF_HOURS);
export const noEmail = () => combine(claim("PayPal has no email on file for this gift, so I can't send an invoice.", 'no_email'), STAFF_HOURS);
/** "from one dollar to five hundred dollars". check.js accepts the config facts only inside this phrase. */
export const limitsPhrase = (min, max) => `from ${numberToWords(min)} ${min === 1 ? 'dollar' : 'dollars'} to ${numberToWords(max)} dollars`;

const AMOUNT_QUESTION = 'How much would you like to give?';
const AMOUNT_FOR_FILE = 'If you would like to give a one-time gift to the email on file, tell me the amount.';

/** The limits are config, not PayPal facts, so they are declared with a config source that check.js holds to the config. */
export function amountOutOfRange(min, max) {
  const facts = [fact('money', formatMoney(min), 'config.invoice_min_dollars'), fact('money', formatMoney(max), 'config.invoice_max_dollars')];
  return part(`I can set up a one-time gift ${limitsPhrase(min, max)}. ${AMOUNT_QUESTION}`, facts);
}
/** Said when the words name a number that isn't clearly the gift, as in "I'm 75" or "I mean double that". */
export const askAmount = () => part(AMOUNT_QUESTION);
/** Said after a new email is refused, when the turn named no amount as money. */
export const amountForFile = () => part(AMOUNT_FOR_FILE);
/** True when the line's last reply asked for an amount, so a bare number in the next turn answers it. */
export const asksForAmount = (text) => typeof text === 'string' && (text.includes(AMOUNT_QUESTION) || text.includes(AMOUNT_FOR_FILE));
export const nothingPending = () => combine(claim("There's nothing waiting for a yes or no right now.", 'nothing_pending'), 'What would you like to do?');
export const needYesOrNo = () => claim('I need a clear yes or no before I change anything.', 'unchanged');
export const callEnded = () => combine(claim('This call has ended.', 'call_ended'), 'Please start a new call if you need anything else.');
export const staffCallback = () => claim("OK, I've noted that you'd like a call. Staff will call you back during open hours.", 'callback_noted');
export const paypalProblem = () => combine(claim("Sorry, I couldn't get a clear answer from PayPal just now, so I didn't change anything.", 'paypal_unclear'),
  'Please try again in a minute.');
export const tooLong = () => part('Sorry, that was a lot at once. Please say it in a shorter way.');
export const turnLimit = () => combine(claim('This call has reached its limit.', 'turn_limit'), 'Please start a new call. Goodbye.');
export const expiredNotice = () => claim("That earlier request timed out, so I didn't change anything.", 'timed_out');
export const setAside = () => claim("I've set that earlier request aside, so nothing changed.", 'set_aside');
// The answer to "How do you know?". The line has just read the gift again, so the sentence claims a read in that turn,
// and the gift's amount and status, and the call's own draft when there is one, are read aloud from those fresh reads.
const RECHECKED = "I just checked PayPal's record again.";
export const rechecked = () => claim(RECHECKED, 'gift_rechecked');
/**
 * draftGone is a draft the call made that PayPal no longer returns, said with the line's not-found wording. close
 * false leaves the reply open, so call.js can speak a proposal still waiting for a yes after it.
 */
export function recheck(sub, plan, inv = null, { draftGone = false, close = true } = {}) {
  const end = draftGone ? paypalProblem() : close ? part(ANYTHING_ELSE) : null;
  return combine(rechecked(), shows(sub, plan), inv ? invoiceShows(inv) : null, end);
}
// ---- Is this charge real? (PICK.md) ----
// The line reads the gift's latest charge from PayPal and says what it was. Here a yes only asks staff to look at a refund,
// which call.js logs, so the donor has no reason to dispute the charge with their bank. Only Covered Month, below, moves money.

/** The latest charge's amount, date and status, all from one read, or null when one is missing. */
function latestCharge(charge, orgName, timeZone) {
  const money = derived('charge.amount', charge, 'money');
  const date = derived('charge.date', charge, 'date', timeZone);
  const status = derived('charge.status', charge, 'status');
  if (!money || !date || !status) return null;
  return part(`PayPal shows the latest charge for your monthly gift to ${orgName} was ${money.value} on ${date.value}, with the status ${status.value}.`, [money, date, status]);
}

/** The latest charge and its transaction suffix, all from one read, or null when one is missing. */
function chargeShows(charge, orgName, timeZone) {
  const latest = latestCharge(charge, orgName, timeZone);
  const suffix = derived('charge.id_last4', charge, 'number_suffix');
  if (!latest || !suffix) return null;
  return combine(latest, part(`In your PayPal activity, it is the transaction ending in ${suffix.value}.`, [suffix]));
}

/** True when chargeOffer can read this charge aloud in full, so call.js only offers a refund request for a charge it named. */
export const chargeReadable = (charge) => chargeShows(charge, 'org', undefined) !== null;

// The offer promises no outcome. Staff only look at a refund, so the line never tells a donor she needn't call her bank.
export const chargeOffer = (charge, orgName, { timeZone } = {}) => combine(chargeShows(charge, orgName, timeZone),
  "If you still don't recognize it, I can ask staff to look at a refund. Would you like me to ask staff?", YES_OR_NO);
// A charge PayPal shows as refunded or declined has no money to give back, so the line reads it and offers nothing.
export const NO_REFUND_STATUSES = Object.freeze(['REFUNDED', 'DECLINED']);
export const chargeNoOffer = (charge, orgName, { timeZone } = {}) => combine(chargeShows(charge, orgName, timeZone), ANYTHING_ELSE);
export const noCharge = () => combine(claim('PayPal shows no recent charge for your monthly gift.', 'no_charge'), STAFF_HOURS);
export const chargeUnread = () => combine(claim("PayPal didn't return a charge I can read clearly, so I won't guess.", 'charge_unread'), STAFF_HOURS);
export const noRefundRequest = () => combine(claim("OK, I won't ask staff for a refund.", 'no_refund_request'), ANYTHING_ELSE);

const FOLLOW_UP = 'Staff will follow up during open hours.';

/**
 * After the yes. same is true when PayPal's fresh read after the request still has the charge the request names, so
 * its amount, date and status are read back from that read. Otherwise the line names no fact it can't tie to the request.
 */
export function afterRefundRequest(charge, { ok = true, same = false, timeZone } = {}) {
  if (!ok) return combine(claim("I couldn't pass that request to staff just now, so nothing changed.", 'refund_request_failed'), STAFF_HOURS, ANYTHING_ELSE);
  const money = same ? derived('charge.amount', charge, 'money') : null;
  const date = same ? derived('charge.date', charge, 'date', timeZone) : null;
  const status = same ? derived('charge.status', charge, 'status') : null;
  if (!money || !date || !status) {
    return combine('OK.', claim("I've asked staff to look at a refund for the charge I read you.", 'wrote_refund_request'), claim(FOLLOW_UP, 'wrote_refund_request'), ANYTHING_ELSE);
  }
  return combine('OK.',
    part(`I've asked staff to look at a refund of ${money.value} for the charge on ${date.value}.`, [money, date], ['wrote_refund_request', 'refund_matches_read']),
    part(`PayPal now shows that charge as ${status.value}.`, [status], ['refund_matches_read']),
    claim(FOLLOW_UP, 'wrote_refund_request'), ANYTHING_ELSE);
}

// ---- Covered Month (PICK.md) ----
// A donor who can't afford this month gets her last charge back, and a sponsor's hold pays the same amount to the org.
// One spoken yes runs both moves, sponsor first, and every amount and status said after it comes from a fresh PayPal read.

const COVER_PAUSE = 'You can ask me to pause your monthly gift instead.';
const SORRY = "I'm sorry to hear that.";
/** Said first when the router picked no phrase, so a donor who just said she lost her job never hears a bare charge read. */
export const hardshipSorry = () => part(SORRY);

function nextGift(sub, timeZone) {
  const date = sub?.status === 'ACTIVE' ? derived('subscription.next_billing_time', sub, 'date', timeZone) : null;
  return date ? part(`The next gift is on ${date.value}.`, [date], ['gift_active']) : null;
}

/**
 * The offer. The charge's facts come from one read, and the gift stays as it is, so the line says when the next gift
 * comes (a refund never touches the subscription). The hold's amount is not spoken, and the line never says it covers this
 * charge, since PayPal's read gives its whole amount and not what is left. PayPal refuses a capture past what is left.
 */
// The amount is declared once, by the charge's own sentence, so a receipt lists it once. It slots in both sentences.
export function coverOffer(charge, sub, orgName, { timeZone } = {}) {
  const money = derived('charge.amount', charge, 'money');
  return combine(latestCharge(charge, orgName, timeZone),
    part(`I can give that ${money.value} back to you, and a sponsor's hardship fund would pay the same amount to ${orgName}.`),
    claim("PayPal shows the sponsor's hold is open.", 'hold_open'),
    'This does not change your monthly gift.', nextGift(sub, timeZone),
    'Should I give it back?', YES_OR_NO);
}

const COVER_TURNED_DOWN = Object.freeze({
  too_old: ["That charge is too old for the hardship fund, so I can't give it back here.", 'cover_too_old'],
  too_big: ["That charge is more than the hardship fund can cover, so I can't give it back here.", 'cover_too_big'],
  used: ["A charge on this gift was already given back in the last year, so the hardship fund can't cover another.", 'cover_used'],
  prior: ["Staff are already looking at this charge, so I won't move any money.", 'cover_prior'],
  no_hold: ["The sponsor's hardship fund isn't open in PayPal right now, so I can't cover this month.", 'cover_no_hold'],
});
const coverTail = () => combine(STAFF_HOURS, COVER_PAUSE, ANYTHING_ELSE);

/** Why the line offers nothing, with no limit said aloud. The rule's numbers are staff's, and no fact proves them to a donor. */
export const coverTurnedDown = (reason) => combine(claim(...COVER_TURNED_DOWN[reason]), coverTail());
/** A charge that can't be refunded yet or at all, read aloud so she knows which one the line looked at. */
export const coverNotReady = (charge, orgName, { timeZone } = {}) => combine(latestCharge(charge, orgName, timeZone), claim("That charge can't be given back right now.", 'cover_not_ready'), coverTail());
export const coverChanged = () => combine(claim("Something changed since I read that to you, so I didn't move any money.", 'cover_changed'), STAFF_HOURS, ANYTHING_ELSE);
export const coverCaptureFailed = () => combine(claim("PayPal didn't accept the sponsor's payment, so I didn't give the month back and no money moved.", 'cover_capture_failed'), STAFF_HOURS, ANYTHING_ELSE);
export const coverCaptureUnclear = () => combine(claim("PayPal didn't answer clearly about the sponsor's payment, so I didn't give the month back.", 'cover_capture_unclear'), STAFF_CHECK, ANYTHING_ELSE);
export const coverRefundUnclear = () => combine(claim("PayPal didn't answer clearly about the refund, so I can't say it went through.", 'cover_refund_unclear'), STAFF_CHECK, ANYTHING_ELSE);

/** The refund was refused after the sponsor paid. The sponsor's payment goes back, and the line says what PayPal shows for it. */
export function coverUnwound({ ok, capture, giftCharge } = {}) {
  if (!ok) return combine(claim("PayPal didn't accept the refund, and I couldn't return the sponsor's payment.", 'cover_unwind_failed'), STAFF_CHECK, ANYTHING_ELSE);
  const status = isRefundedStatus(capture?.status) ? derived('capture.status', capture, 'status') : null;
  return combine(part("PayPal didn't accept the refund, so I asked PayPal to return the sponsor's payment.", [], ['cover_refund_failed', 'wrote_cover_unwind']),
    status ? part(`PayPal now shows the sponsor's payment as ${status.value}.`, [status], ['cover_unwound']) : STAFF_CHECK,
    giftCharge?.status === 'COMPLETED' ? claim('Your charge stays as it was.', 'cover_charge_unchanged') : null, STAFF_HOURS, ANYTHING_ELSE);
}

/**
 * After both moves. Each sentence that says a move went through is backed by that move's own fresh read, and a read PayPal
 * hasn't updated or didn't return says only that the line asked. unclear is a refund PayPal gave no clear answer to,
 * which a fresh read then showed had gone through (L2).
 */
export function afterCover({ giftCharge, capture, sub, orgName, unclear = false, timeZone }) {
  const refunded = isRefundedStatus(giftCharge?.status);
  const money = refunded ? derived('gift_charge.amount', giftCharge, 'money') : null;
  const status = refunded ? derived('gift_charge.status', giftCharge, 'status') : null;
  const shownBack = money && status;
  const back = shownBack
    ? part(`PayPal now shows your charge of ${money.value} as ${status.value}.`, [money, status], ['wrote_cover_refund', 'cover_refund_read'])
    : combine(claim('I asked PayPal to give it back.', 'wrote_cover_refund'), claim(UPDATE_LATER, 'wrote'));
  const paid = derived('capture.status', capture, 'status');
  const sponsor = paid
    ? part(`PayPal shows the sponsor's payment of the same amount to ${orgName}, with the status ${paid.value}.`, [paid], ['wrote_cover_capture', 'cover_capture_read'])
    : claim("I asked PayPal to take the sponsor's payment.", 'wrote_cover_capture');
  const lead = unclear ? claim(UNCLEAR_ANSWER, 'write_unclear') : shownBack ? claim('Done.', 'wrote') : null;
  const gift = sub ? shows(sub, null, 'PayPal now shows') : null;
  return combine(lead, back, sponsor, gift, nextGift(sub, timeZone), 'If next month is hard too, you can ask me to pause it.', ANYTHING_ELSE);
}

export const pinLimit = () => combine(claim("There have been too many wrong PINs from here, so I can't check a PIN right now.", 'pin_limit'), 'Please try again later.');

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

