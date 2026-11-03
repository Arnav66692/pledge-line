// Pure grading over ledger events, shared by the dry run, pilot-check and the tests.
import { scanSpoken, extractSpokenFacts, saysPhrase, spokenForm, wordsOf, slotFacts, sentencesOf, SLOT_MARKS, FACT_SOURCES, formatMoney, limitsPhrase } from './say.js';
import { isClearYes } from './gate.js';
import { LIMITS } from './config.js';
import { TEMPLATE_WORDS, TEMPLATE_SENTENCES, TEMPLATE_CLAIMS, TEMPLATE_HASH } from './template-words.js';
import { TEMPLATE_HISTORY } from './template-history.js';
import { unreviewedSentences } from './vocabulary.js';
import { drillOf } from './drill.js';

const DEFAULT_TIME_ZONE = 'America/Los_Angeles';
const SOURCE_WHAT = Object.freeze({
  'plan.price': 'plan',
  'subscription.status': 'subscription',
  'subscription.next_billing_time': 'subscription',
  'invoice.amount': 'invoice',
  'invoice.number_last4': 'invoice',
  'invoice.status': 'invoice',
  'invoice.recipient_email': 'invoice',
});
// The line's own limits, spoken when it asks for an amount. They are config, not PayPal facts, so they must match the config.
const CONFIG_FACTS = Object.freeze({
  'config.invoice_min_dollars': () => formatMoney(LIMITS.invoiceMinDollars),
  'config.invoice_max_dollars': () => formatMoney(LIMITS.invoiceMaxDollars),
});
const WRITE_READS = Object.freeze({ suspend: 'subscription', activate: 'subscription', cancel: 'subscription', send_invoice: 'invoice' });
// What each proposal must read aloud, and the status each write's read-back must speak (PILOT.md Tests 1 and 2).
const GIFT_FACTS = ['plan.price', 'subscription.status'];
const PROPOSAL_FACTS = Object.freeze({ suspend: GIFT_FACTS, activate: GIFT_FACTS, cancel: GIFT_FACTS, send_invoice: ['invoice.amount', 'invoice.number_last4'] });
const WRITE_STATUS = Object.freeze({
  suspend: { source: 'subscription.status', values: ['suspended'] },
  activate: { source: 'subscription.status', values: ['active'] },
  cancel: { source: 'subscription.status', values: ['cancelled'] },
  send_invoice: { source: 'invoice.status', values: ['sent', 'unpaid'] },
});
// Events that close a proposal. A yes after one of them answers nothing (I1).
const CLOSED_BY = Object.freeze({ expired: 'already timed out', withdrawn: 'already been set aside', no: 'already been declined' });
const SAFETY_REASONS = ['other_email', 'locked'];
const GATED_TYPES = new Set(['read', 'write', 'staging_write']);
const SUBSCRIPTION_KINDS = new Set(['suspend', 'activate', 'cancel']);
// Whose read a fact may come from (R3-7).
const OWN = Object.freeze({ subscription: "this call's own subscription", plan: "that subscription's plan", invoice: "this call's own draft" });
// A template list as the facts check reads it, words and sentences as sets.
const asTemplates = (hash, list) => Object.freeze({ hash, words: new Set(list.words), sentences: new Set(list.sentences), claims: list.claims });
const CURRENT_TEMPLATES = asTemplates(TEMPLATE_HASH, { words: TEMPLATE_WORDS, sentences: TEMPLATE_SENTENCES, claims: TEMPLATE_CLAIMS });
const historyLists = new WeakMap();

const bySeq = (a, b) => (a.seq ?? 0) - (b.seq ?? 0);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const violation = (event, check, message) => ({ callId: event.callId ?? null, turn: event.turn ?? null, check, message });

export function groupByCall(events) {
  const groups = new Map();
  for (const event of [...events].sort(bySeq)) {
    if (!event.callId) continue;
    if (!groups.has(event.callId)) groups.set(event.callId, []);
    groups.get(event.callId).push(event);
  }
  return groups;
}

function isCovered(found, facts) {
  if (found.kind === 'number') return false;
  if (found.kind === 'status') return facts.some((f) => f.kind === 'status' && String(f.value).split(' ').includes(found.value));
  return facts.some((f) => f.kind === found.kind && f.value === found.value);
}

const LIMITS_PHRASE = limitsPhrase(LIMITS.invoiceMinDollars, LIMITS.invoiceMaxDollars);

/** The one subscription a call works on: the configured one when given, else the first one it read or proposed a change to. */
export function callSubscription(list, subscriptionId = null) {
  if (subscriptionId) return subscriptionId;
  const first = list.find((e) => (e.type === 'read' && e.what === 'subscription') || ((e.type === 'proposed' || e.type === 'write') && SUBSCRIPTION_KINDS.has(e.kind)));
  if (!first) return null;
  return first.type === 'read' ? first.id : first.targetId;
}

/**
 * The id a write is read back from. A fault drill's suspend goes to PayPal's test id and is read back from the call's
 * own gift (A12). Every other write, in every other call, is read back from its own target, as before.
 */
function readTargetOf(write, list, subId) {
  const drill = drillOf(list.find((e) => e.type === 'call_start'));
  const drilled = Boolean(drill) && Boolean(subId) && write.kind === drill.kind && write.targetId === drill.writeId;
  return drilled ? subId : write.targetId;
}

/** The reads a fact may come from: the latest of the call's own subscription, of that subscription's plan, and of the call's latest draft. */
function ownReads(reads, subId, draftId) {
  const subscription = reads.get(`subscription ${subId}`) ?? null;
  const planId = subscription?.snapshot?.plan_id ?? null;
  return { subscription, plan: planId ? reads.get(`plan ${planId}`) ?? null : null, invoice: draftId ? reads.get(`invoice ${draftId}`) ?? null : null };
}

/** Why a declared fact is wrong, or null when it matches its PayPal read or, inside the line's amount question, the config. */
function declaredProblem(f, said, latest, timeZone) {
  const config = CONFIG_FACTS[f.source];
  if (config && !String(said.text ?? '').includes(LIMITS_PHRASE)) return `fact "${f.value}" (${f.source}) is only for the line's own amount limits`;
  if (config) return config() === f.value ? null : `said "${f.value}" for ${f.source}, the config gives "${config()}"`;
  const derive = FACT_SOURCES[f.source];
  if (!derive) return `fact "${f.value}" names an unknown source ${f.source}`;
  const what = SOURCE_WHAT[f.source];
  const read = latest[what];
  if (!read?.snapshot) return `fact "${f.value}" (${f.source}) has no earlier PayPal read of ${OWN[what]} in this call`;
  const expected = derive(read.snapshot, timeZone);
  return expected === f.value ? null : `said "${f.value}" for ${f.source}, PayPal's latest read gives "${expected}"`;
}

/** A declared fact must be said, as whole words or in words the scans read, such as "twenty five dollars" for $25.00. */
function unspokenProblem(f, text, heard) {
  if (heard.some((x) => x.kind === f.kind && x.value === f.value) || saysPhrase(text, spokenForm(f))) return null;
  return `declared ${f.kind} "${f.value}" (${f.source}), but the reply never says it`;
}

function checkSaid(said, latest, ctx) {
  const { timeZone, orgName, templates } = ctx;
  const problems = [];
  const text = String(said.text ?? '');
  const facts = Array.isArray(said.facts) ? said.facts : [];
  const org = orgName ? [orgName] : [];
  const heard = extractSpokenFacts(text, { strict: true, skip: org });
  const proven = [];
  for (const f of facts) {
    const problem = declaredProblem(f, said, latest, timeZone) ?? unspokenProblem(f, text, heard);
    if (problem) problems.push(violation(said, 'facts', problem));
    else proven.push(f);
  }
  // Proven facts and the org name are set aside as whole words, then everything the scans find must be declared.
  const { found, rest } = scanSpoken(text, { strict: true, skip: [...org, ...proven.map(spokenForm)] });
  for (const x of found) {
    if (!isCovered(x, facts)) problems.push(violation(said, 'facts', `spoke ${x.kind} "${x.value}" that no PayPal read covers`));
  }
  // What is left must be the line's own template words, so a fact said in a form no scan knows still fails.
  for (const word of new Set(wordsOf(rest))) {
    if (!templates.words.has(word)) problems.push(violation(said, 'facts', `said "${word}", a word the line's own templates never use`));
  }
  return [...problems, ...sentenceProblems(said, text, proven, ctx), ...claimProblems(said, text, proven, ctx)];
}

/**
 * Each sentence, with the org name and the proven facts as slots, must be a sentence the templates say, so template
 * words recombined into a new claim, such as "The next gift is this month" or "PayPal no longer shows ...", fail (R3-6).
 */
function sentenceProblems(said, text, proven, { orgName, templates }) {
  if (SLOT_MARKS.test(text)) return [violation(said, 'facts', 'said a brace, which no template says')];
  const unknown = sentencesOf(slotFacts(text, proven, orgName)).filter((sentence) => !templates.sentences.has(sentence));
  return [...new Set(unknown)].map((sentence) => violation(said, 'facts', `said "${sentence}", a sentence the line's own templates never say`));
}

// ---- Claims: what a sentence says PayPal or the line did, proved against the call's own events up to the reply (R4-1) ----

const inTurn = (scope, pred) => scope.turn.some(pred);
const okWrite = (scope, kind = null) => inTurn(scope, (e) => e.type === 'write' && e.ok && (kind === null || e.kind === kind));
const refusedFor = (scope, reason) => inTurn(scope, (e) => e.type === 'refused' && e.reason === reason);
const SEND_KINDS = new Set(['send_invoice']);
const CLOSES_PROPOSAL = new Set(['no', 'expired', 'withdrawn', 'yes']);
// What PayPal shows once each write has gone through, and the statuses each gift change can act on, as call.js has them.
const CHANGED = Object.freeze({ suspend: (s) => s.status === 'SUSPENDED', activate: (s) => s.status === 'ACTIVE', cancel: (s) => s.status === 'CANCELLED',
  send_invoice: (s) => s.status !== 'DRAFT' });
const ACTS_ON = Object.freeze({ suspend: ['ACTIVE'], activate: ['SUSPENDED'], cancel: ['ACTIVE', 'SUSPENDED'] });
const isClientError = (status) => Number.isInteger(status) && status >= 400 && status < 500;

/** The latest read of a write's target after the write, in the turn, the call's own gift for a drill's suspend. */
function readAfter(scope, write) {
  const target = scope.readTarget(write);
  return scope.turn.filter((e) => e.seq > write.seq && e.type === 'read' && e.what === WRITE_READS[write.kind] && e.id === target).at(-1) ?? null;
}

/**
 * The turn's failed write that PayPal refused: answered with a 4xx, or followed by a read that does not show the
 * change. A timeout or a 5xx after which PayPal shows the change was applied, its answer lost, never a refusal (L2).
 */
function refusedWrite(scope, kinds) {
  const write = scope.turn.filter((e) => e.type === 'write' && !e.ok && kinds.has(e.kind)).at(-1);
  if (!write) return false;
  if (isClientError(write.httpStatus)) return true;
  const read = readAfter(scope, write);
  return Boolean(read?.snapshot) && !CHANGED[write.kind](read.snapshot);
}

/** A write in the turn that PayPal gave no clear answer to, a timeout or a 5xx, and a read of its target after it (L2). */
function unansweredWrite(scope) {
  const write = scope.turn.filter((e) => e.type === 'write' && !e.ok && !isClientError(e.httpStatus)).at(-1);
  return Boolean(write) && Boolean(readAfter(scope, write));
}

/** The latest read of the call's own gift shows a status that the change can't act on, so there is nothing to change (R4-1). */
const nothingToDo = (scope, kind) => Boolean(scope.gift?.snapshot) && Object.hasOwn(ACTS_ON, kind) && !ACTS_ON[kind].includes(scope.gift.snapshot.status);

/** The latest read of a write's target after the write, in the turn, has no snapshot, as when PayPal returned nothing. */
function unreadAfterWrite(scope, what, kinds) {
  const write = scope.turn.filter((e) => e.type === 'write' && kinds.has(e.kind)).at(-1);
  if (!write) return false;
  const target = scope.readTarget(write);
  const read = scope.turn.filter((e) => e.seq > write.seq && e.type === 'read' && e.what === what && e.id === target).at(-1);
  return Boolean(read) && !read.snapshot;
}

/** The turn's delete of a draft this call made, and the latest read of that draft after it. */
function deletedDraft(scope) {
  const del = scope.turn.filter((e) => e.type === 'staging_write' && e.kind === 'delete_draft' && scope.made.has(e.id)).at(-1);
  if (!del) return null;
  return { del, read: scope.turn.filter((e) => e.seq > del.seq && e.type === 'read' && e.what === 'invoice' && e.id === del.id).at(-1) ?? null };
}

/** A PayPal step in the turn that gave the line no clear answer: a read with no snapshot, a failed draft step, or a draft it made and deleted. */
function unclearStep(scope) {
  const deleted = new Set(scope.turn.filter((e) => e.type === 'staging_write' && e.kind === 'delete_draft').map((e) => e.id));
  return inTurn(scope, (e) => (e.type === 'read' && !e.snapshot) || (e.type === 'staging_write' && !e.ok)
    || (e.type === 'staging_write' && e.kind === 'create_draft' && e.ok && deleted.has(e.id)));
}

/** A proposal no no, expiry, set-aside or yes closed before the reply. */
function openProposal(scope) {
  const closed = new Set(scope.before.filter((e) => CLOSES_PROPOSAL.has(e.type)).map((e) => e.pendingId));
  return scope.before.some((e) => e.type === 'proposed' && !closed.has(e.pendingId));
}

/** An expiry since the line last said it timed out, or since the call began. */
function newExpiry(scope) {
  const told = scope.before.filter((e) => e.type === 'said' && (Array.isArray(e.claims) ? e.claims : []).some((c) => c?.claim === 'timed_out')).at(-1);
  return scope.before.some((e) => e.type === 'expired' && (!told || e.seq > told.seq));
}

const pinBads = (scope) => scope.before.filter((e) => e.type === 'pin_bad').length;
const giftInTurn = (scope) => Boolean(scope.gift) && scope.gift.turn === scope.said.turn;

/** Each claim, the events that back it, and what to call those events in a problem. */
const CLAIMS = Object.freeze({
  pin_ok: ['a PIN that passed in that turn', (s) => inTurn(s, (e) => e.type === 'pin_ok')],
  pin_bad: ['a wrong PIN in that turn', (s) => inTurn(s, (e) => e.type === 'pin_bad')],
  tries_left: ['a wrong PIN in that turn that left that many tries', (s, n) => inTurn(s, (e) => e.type === 'pin_bad') && LIMITS.pinTries - pinBads(s) === Number(n)],
  pin_locked: ['a lock in that turn', (s) => inTurn(s, (e) => e.type === 'pin_locked')],
  pin_limit: ['a pin_limit refusal in that turn', (s) => refusedFor(s, 'pin_limit')],
  not_verified: ['no PIN that passed before it', (s) => !s.before.some((e) => e.type === 'pin_ok')],
  wrote: ['an ok write in that turn', (s) => okWrite(s)],
  wrote_suspend: ['an ok suspend in that turn', (s) => okWrite(s, 'suspend')],
  wrote_activate: ['an ok activate in that turn', (s) => okWrite(s, 'activate')],
  wrote_cancel: ['an ok cancel in that turn', (s) => okWrite(s, 'cancel')],
  wrote_send_invoice: ['an ok send in that turn', (s) => okWrite(s, 'send_invoice')],
  write_failed: ['a subscription write PayPal refused in that turn, with a 4xx or a read after it that does not show the change', (s) => refusedWrite(s, SUBSCRIPTION_KINDS)],
  send_failed: ['a send PayPal refused in that turn, with a 4xx or a read after it that does not show the change', (s) => refusedWrite(s, SEND_KINDS)],
  write_unclear: ['a write in that turn that PayPal gave no clear answer to, and a read of its target after it', (s) => unansweredWrite(s)],
  gift_unread: ['a subscription write in that turn whose latest read after it found nothing', (s) => unreadAfterWrite(s, 'subscription', SUBSCRIPTION_KINDS)],
  invoice_unread: ['a send in that turn whose latest read after it found nothing', (s) => unreadAfterWrite(s, 'invoice', SEND_KINDS)],
  draft_deleted: ["a delete of this call's own draft in that turn, a read after it that PayPal answered with 404, and no send of it",
    (s) => { const d = deletedDraft(s); return Boolean(d?.read?.notFound) && !s.before.some((e) => e.type === 'write' && e.ok && e.kind === 'send_invoice' && e.targetId === d.del.id); }],
  draft_kept: ["a delete of this call's own draft in that turn, and a read after it that still finds the draft", (s) => Boolean(deletedDraft(s)?.read?.snapshot)],
  no_gift: ["a read of the call's own subscription in that turn that found nothing", (s) => giftInTurn(s) && !s.gift.snapshot],
  no_email: ["a read of the call's own subscription in that turn with no email on file", (s) => giftInTurn(s) && Boolean(s.gift.snapshot) && !s.gift.snapshot.subscriber_email],
  paypal_unclear: ['a PayPal step in that turn that failed, found nothing, or made a draft it deleted, and no ok write', (s) => unclearStep(s) && !okWrite(s)],
  unchanged: ['no ok write in that turn', (s) => !okWrite(s)],
  no_pause: ['a no to a pause in that turn, and no ok write',
    (s) => !okWrite(s) && inTurn(s, (e) => e.type === 'no' && s.before.some((p) => p.type === 'proposed' && p.pendingId === e.pendingId && p.kind === 'suspend'))],
  email_refused: ['an other_email refusal in that turn', (s) => refusedFor(s, 'other_email')],
  set_aside: ['a proposal set aside in that turn, and no ok write', (s) => inTurn(s, (e) => e.type === 'withdrawn') && !okWrite(s)],
  callback_noted: ['a staff callback logged in that turn', (s) => inTurn(s, (e) => e.type === 'staff_callback')],
  turn_limit: ['a turn_limit refusal in that turn', (s) => refusedFor(s, 'turn_limit')],
  timed_out: ['a proposal that timed out since the line last said so, and no ok write in that turn', (s) => newExpiry(s) && !okWrite(s)],
  nothing_pending: ['no proposal still open', (s) => !openProposal(s)],
  call_ended: ['a call_end before it', (s) => s.before.some((e) => e.type === 'call_end')],
  gift_read: ["a read of the call's own subscription that returned it", (s) => Boolean(s.gift?.snapshot)],
  gift_active: ["a read of the call's own subscription that shows it active", (s) => s.gift?.snapshot?.status === 'ACTIVE'],
  nothing_to: ["a read of the call's own subscription whose status that change can't act on", (s, kind) => nothingToDo(s, kind)],
  invoice_read: ["a read of this call's own draft that returned it", (s) => Boolean(s.draft?.snapshot)],
  // "I just checked PayPal's record again." says the line read the gift afresh, so it needs a read in that very turn.
  gift_rechecked: ["a read of the call's own subscription in that turn that returned it", (s) => giftInTurn(s) && Boolean(s.gift.snapshot)],
});

/** The claims the grader can prove. A template claim the grader does not know fails the vocabulary test (R4-1). */
export const CLAIM_NAMES = Object.freeze(Object.keys(CLAIMS));

/** What each claim means, in the grader's own words, so a receipt shows the donor what a sentence claims. */
export const CLAIM_MEANINGS = Object.freeze(Object.fromEntries(Object.entries(CLAIMS).map(([name, [meaning]]) => [name, meaning])));

/** Which read each fact source comes from, plan, subscription or invoice. A config source has none. */
export const FACT_READS = SOURCE_WHAT;

/** The call's events before a reply, those of its turn, the drafts it made, and its latest reads of its own subscription and draft. */
function claimScope(list, said, subId) {
  const before = list.filter((e) => e.seq < said.seq);
  const drafts = before.filter((e) => e.type === 'staging_write' && e.kind === 'create_draft' && e.ok).map((e) => e.id);
  const latest = (what, id) => (id ? before.filter((e) => e.type === 'read' && e.what === what && e.id === id).at(-1) ?? null : null);
  return { said, before, turn: before.filter((e) => e.turn === said.turn), made: new Set(drafts), gift: latest('subscription', subId), draft: latest('invoice', drafts.at(-1)),
    readTarget: (write) => readTargetOf(write, list, subId) };
}

/** The reply a repeat repeats: the latest earlier reply of the turn it names, whose words it ends with. */
function repeatedReply(said, list) {
  const original = list.filter((e) => e.type === 'said' && e.turn === said.repeats && e.seq < said.seq).at(-1);
  const words = typeof original?.text === 'string' ? original.text : '';
  return words !== '' && String(said.text ?? '').endsWith(words) ? original : null;
}

const sameClaim = (a, b) => a?.claim === b.claim && a?.sentence === b.sentence;
// Own keys only, so a reply that says "toString" never reads a claim off Object.prototype.
const claimsOf = (templates, sentence) => (Object.hasOwn(templates.claims, sentence) ? templates.claims[sentence] : []);

/** Why a declared claim is not backed, or null. A repeat proves a claim the repeated reply made at that reply. */
function unbackedClaim(c, said, original, ctx) {
  const [name, value] = c.claim.split('=');
  const check = Object.hasOwn(CLAIMS, name) ? CLAIMS[name] : null;
  if (!check) return `claimed ${c.claim} for "${c.sentence}", a claim the grader does not know`;
  const at = original && (original.claims ?? []).some((o) => sameClaim(o, c)) ? original : said;
  if (check[1](claimScope(ctx.list, at, ctx.subId), value)) return null;
  return `said "${c.sentence}", which claims ${check[0]}, but the call's events up to ${at === said ? 'that reply' : `the reply of turn ${at.turn} it repeats`} don't show it`;
}

/**
 * A sentence the templates tie to a claim must declare it, and each declared claim must be its sentence's own, in
 * the reply, and backed by the call's events up to the reply. A claim is not spoken as its value, so it is tied to
 * its sentence rather than to the whole-word rule for facts (R4-1).
 */
function claimProblems(said, text, proven, ctx) {
  const slot = (sentence) => slotFacts(sentence, proven, ctx.orgName);
  const sentences = new Set(sentencesOf(slot(text)));
  const declared = (Array.isArray(said.claims) ? said.claims : []).filter((c) => typeof c?.claim === 'string' && typeof c?.sentence === 'string');
  const problems = [];
  for (const sentence of sentences) {
    for (const name of claimsOf(ctx.templates, sentence)) {
      if (!declared.some((c) => c.claim === name && slot(c.sentence) === sentence)) problems.push(violation(said, 'facts', `said "${sentence}" without its claim ${name}`));
    }
  }
  const original = Number.isInteger(said.repeats) ? repeatedReply(said, ctx.list) : null;
  if (Number.isInteger(said.repeats) && !original) problems.push(violation(said, 'facts', `the reply says it repeats turn ${said.repeats}, but it does not end with that turn's reply`));
  for (const c of declared) {
    const sentence = slot(c.sentence);
    const why = !sentences.has(sentence) ? `claimed ${c.claim} for "${c.sentence}", a sentence the reply never says`
      : !claimsOf(ctx.templates, sentence).includes(c.claim) ? `claimed ${c.claim} for "${sentence}", which the line's own templates never tie to it`
        : unbackedClaim(c, said, original, ctx);
    if (why) problems.push(violation(said, 'facts', why));
  }
  return problems;
}

/**
 * Why a call's template list can't vouch for its replies, or null when it can: the history has no list under the hash
 * its call_start names (R4-2), or the list has a sentence the review never passed with its claims, as when say.js
 * gained one and npm run vocabulary ran with no npm test (R4-1). A call that names no hash is held to the current list
 * and its review. pilot-check fails such a call, and refuses the grade when this is all that keeps it from a PASS (G1).
 */
export function templateTrouble(start, history = TEMPLATE_HISTORY) {
  const named = Boolean(start) && Object.hasOwn(start, 'templates');
  const hash = named ? start.templates : TEMPLATE_HASH;
  if (typeof hash !== 'string' || !Object.hasOwn(history, hash)) return named ? { hash: String(hash), unknown: true, unreviewed: [] } : null;
  const entry = history[hash];
  const unreviewed = unreviewedSentences(entry, Array.isArray(entry.reviewed) ? entry.reviewed : []);
  return unreviewed.length > 0 ? { hash, unknown: false, unreviewed } : null;
}

/** The violation for a call whose template list can't vouch for its replies, naming the hash and what is wrong. */
function troubleViolation(start, trouble) {
  const why = trouble.unknown ? 'which the template history does not have'
    : `whose sentences ${trouble.unreviewed.map((sentence) => JSON.stringify(sentence)).join(', ')} the review in src/vocabulary.js never passed with their claims`;
  return violation(start, 'facts', `the call logged the template list ${trouble.hash}, ${why}, so its replies can't be checked`);
}

/**
 * The template list a call was spoken with: the one its call_start names by hash, or the current one when it names
 * none. null when the history has no list under that hash, so pilot-check refuses the grade rather than fail the call (R4-2).
 */
export function templatesFor(start, history = TEMPLATE_HISTORY) {
  if (!start || !Object.hasOwn(start, 'templates')) return CURRENT_TEMPLATES;
  const hash = start.templates;
  if (typeof hash !== 'string' || !Object.hasOwn(history, hash)) return null;
  if (history === TEMPLATE_HISTORY && hash === TEMPLATE_HASH) return CURRENT_TEMPLATES;
  if (!historyLists.has(history)) historyLists.set(history, new Map());
  const cache = historyLists.get(history);
  if (!cache.has(hash)) cache.set(hash, asTemplates(hash, history[hash]));
  return cache.get(hash);
}

/**
 * I3: every spoken amount, date, suffix and status word matches the latest earlier PayPal read of the call's own
 * subscription, its plan or the call's own draft, every declared fact is said, every other word is a template word,
 * and every claim is backed, all held to the template list the call was spoken with. orgName and subscriptionId
 * come from the config in pilot-check, else from the call's own call_start and reads. A call whose list can't vouch
 * for its replies has that one violation (R4-1, R4-2).
 */
export function checkFacts(events, { orgName = null, subscriptionId = null, history = TEMPLATE_HISTORY, lenientTemplates = false } = {}) {
  const problems = [];
  for (const list of groupByCall(events).values()) {
    const start = list.find((e) => e.type === 'call_start');
    // lenientTemplates sets the trouble aside, so pilot-check can tell a refusal from a fail (G1). A list the history
    // lacks can't be checked at all, and a list with unreviewed sentences is still checked as far as it goes.
    const trouble = templateTrouble(start, history);
    if (trouble && !lenientTemplates) problems.push(troubleViolation(start, trouble));
    const templates = templatesFor(start, history);
    if (!templates) continue;
    const subId = callSubscription(list, subscriptionId);
    const ctx = { timeZone: start?.timeZone ?? DEFAULT_TIME_ZONE, orgName: orgName ?? start?.orgName ?? null, templates, list, subId };
    const reads = new Map();
    let draftId = null;
    for (const event of list) {
      if (event.type === 'read') reads.set(`${event.what} ${event.id}`, event);
      if (event.type === 'staging_write' && event.kind === 'create_draft' && event.ok) draftId = event.id;
      if (event.type === 'said') problems.push(...checkSaid(event, ownReads(reads, subId, draftId), ctx));
    }
  }
  return problems;
}

// ---- The same checks, one reply at a time, for the receipts the page shows. checkFacts never calls these. ----

/**
 * The reads a fact in this reply may come from, as checkFacts sees them at that reply: the latest earlier read of the
 * call's own subscription, of that subscription's plan, and of the call's latest draft (R3-7).
 */
export function readsBehind(list, said, { subscriptionId = null } = {}) {
  const sorted = [...list].sort(bySeq);
  const subId = callSubscription(sorted, subscriptionId);
  const reads = new Map();
  let draftId = null;
  for (const event of sorted.filter((e) => e.seq < said.seq)) {
    if (event.type === 'read') reads.set(`${event.what} ${event.id}`, event);
    if (event.type === 'staging_write' && event.kind === 'create_draft' && event.ok) draftId = event.id;
  }
  return ownReads(reads, subId, draftId);
}

/** Why a declared fact does not match its PayPal read or the config, or null when it does, in checkFacts' own words. */
export const factProblem = (f, said, latest, timeZone = DEFAULT_TIME_ZONE) => declaredProblem(f, said, latest, timeZone);

/** True when the call's events back the claim at this reply, or at the reply it repeats, as checkFacts proves it. */
export function claimBacked(list, said, c, { subscriptionId = null } = {}) {
  const sorted = [...list].sort(bySeq);
  const original = Number.isInteger(said.repeats) ? repeatedReply(said, sorted) : null;
  return unbackedClaim(c, said, original, { list: sorted, subId: callSubscription(sorted, subscriptionId) }) === null;
}

const hasToken = (event) => typeof event.tokenId === 'string' && event.tokenId !== '';

/** The caller's own words in the yes turn must be a clear yes, said right after the line asked (I1, I6). */
function checkYesTurn(write, yes, proposed, list) {
  const heard = list.find((e) => e.type === 'heard' && e.turn === write.turn);
  if (!heard) return [violation(write, 'writes', `no heard event for the turn that ran ${write.kind}`)];
  const problems = [];
  if (!(heard.turn >= proposed.turn + 1)) problems.push(violation(write, 'writes', `the yes for ${write.kind} came in the same turn as the proposal`));
  // isClearYes also refuses a # from the PIN mask, so a masked turn never grades as a yes.
  if (heard.text !== yes.text || !isClearYes(heard.text, write.kind)) problems.push(violation(write, 'writes', `the words heard in the yes turn are not a clear yes for ${write.kind}`));
  // The line logs the reply each turn's client says it was answering (I6). A yes must answer the reply that asked.
  if (Object.hasOwn(heard, 'answering') && heard.answering !== yes.turn - 1) {
    problems.push(violation(write, 'writes', `the yes for ${write.kind} left its client before the proposal reached it`));
  }
  // The line also logs the last reply it had finished when the turn arrived, which no client can forge (I1).
  if (Object.hasOwn(heard, 'arrivedAfter') && heard.arrivedAfter !== yes.turn - 1) {
    problems.push(violation(write, 'writes', `the yes for ${write.kind} arrived before the line had finished the reply that asked`));
  }
  // Over HTTP it logs how long after that reply the turn reached it, too soon for a person to have heard it.
  if (Number.isFinite(heard.afterReplyMs) && !(heard.afterReplyMs >= LIMITS.minAnswerMs)) {
    problems.push(violation(write, 'writes', `the yes for ${write.kind} reached the line ${heard.afterReplyMs} ms after the reply that asked, sooner than a person can answer`));
  }
  const asked = list.some((e) => e.type === 'said' && e.turn === yes.turn - 1 && e.seq < yes.seq
    && typeof e.text === 'string' && typeof proposed.readBack === 'string' && e.text.includes(proposed.readBack));
  if (!asked) problems.push(violation(write, 'writes', `the yes for ${write.kind} did not answer a proposal spoken in the turn before it`));
  return problems;
}

/** I1: the proposal was still open when the yes came, and the token was still alive when the write used it. */
function checkTimely(write, yes, proposed, list) {
  const problems = [];
  const closed = list.find((e) => Object.hasOwn(CLOSED_BY, e.type) && e.pendingId === yes.pendingId && e.seq < yes.seq);
  if (closed) problems.push(violation(write, 'writes', `${write.kind} ran on a proposal that had ${CLOSED_BY[closed.type]}`));
  const yesAt = Date.parse(yes.ts);
  if (yesAt - Date.parse(proposed.ts) >= LIMITS.pendingTtlMs) problems.push(violation(write, 'writes', `the yes for ${write.kind} came after its proposal timed out`));
  // The token is used before the PayPal call, so the write's own time is taken off.
  const usedAt = Date.parse(write.ts) - (Number.isFinite(write.ms) ? write.ms : 0);
  if (usedAt - yesAt >= LIMITS.tokenTtlMs) problems.push(violation(write, 'writes', `${write.kind} ran after its one-time token timed out`));
  return problems;
}

const lastBefore = (list, seq, pred) => list.filter((e) => e.seq < seq && pred(e)).at(-1) ?? null;

/** The proposal was read back from its own target, and an invoice send targets a draft this call made. */
function checkTarget(write, proposed, list, readId) {
  const problems = [];
  const read = lastBefore(list, proposed.seq, (e) => e.type === 'read' && e.what === WRITE_READS[write.kind]);
  if (!read || read.id !== readId) problems.push(violation(write, 'writes', `the ${write.kind} proposal was not read back from ${write.targetId}`));
  const made = list.some((e) => e.type === 'staging_write' && e.kind === 'create_draft' && e.ok && e.id === write.targetId && e.seq < proposed.seq);
  if (write.kind === 'send_invoice' && !made) problems.push(violation(write, 'writes', `the invoice sent, ${write.targetId}, is not a draft this call made`));
  return problems;
}

function checkOneWrite(write, list, subId) {
  const readId = readTargetOf(write, list, subId);
  if (!hasToken(write)) return [violation(write, 'writes', `${write.kind} ran without a one-time token`)];
  const yes = list.find((e) => e.type === 'yes' && e.tokenId === write.tokenId && e.seq < write.seq);
  if (!yes) return [violation(write, 'writes', `${write.kind} ran without an earlier yes carrying its token`)];
  const problems = [];
  if (yes.turn !== write.turn) problems.push(violation(write, 'writes', `${write.kind} ran in turn ${write.turn}, its yes came in turn ${yes.turn}`));
  const proposed = list.find((e) => e.type === 'proposed' && e.pendingId === yes.pendingId && e.seq < yes.seq);
  if (!proposed) return [...problems, violation(write, 'writes', `${write.kind} has a yes with no matching proposal`)];
  if (proposed.kind !== write.kind || proposed.targetId !== write.targetId) problems.push(violation(write, 'writes', `${write.kind} does not match what was proposed`));
  const spoken = list.some((e) => e.type === 'said' && e.turn === proposed.turn && e.seq > proposed.seq && e.seq < yes.seq);
  if (!spoken) problems.push(violation(write, 'writes', `the ${write.kind} proposal was never spoken before the yes`));
  problems.push(...checkYesTurn(write, yes, proposed, list), ...checkTimely(write, yes, proposed, list), ...checkTarget(write, proposed, list, readId));
  const readBack = list.some((e) => e.type === 'read' && e.what === WRITE_READS[write.kind] && e.id === readId && e.turn === write.turn && e.seq > write.seq);
  if (!readBack) problems.push(violation(write, 'writes', `no fresh PayPal read of ${readId} after ${write.kind}`));
  return problems;
}

/** Every subscription read, proposal and write in a call targets one subscription, the configured one when given (R3-7). */
function checkOneSubscription(list, subscriptionId) {
  const subId = callSubscription(list, subscriptionId);
  // A fault drill's suspend proposal and write go to PayPal's test id and stand for the call's own gift (A12).
  const targetOf = (e) => {
    if (e.type === 'read' && e.what === 'subscription') return e.id;
    return (e.type === 'proposed' || e.type === 'write') && SUBSCRIPTION_KINDS.has(e.kind) ? readTargetOf(e, list, subId) : undefined;
  };
  // sweep holds a later call to the id it logged, which may not be the pilot's, so the message names the id only (C1).
  const own = subscriptionId ? `${subId}, the subscription this call is held to` : `${subId}, the subscription this call works on`;
  const step = (e) => (e.type === 'read' ? 'a read' : `a ${e.kind} ${e.type === 'write' ? 'write' : 'proposal'}`);
  return list.filter((e) => targetOf(e) !== undefined && targetOf(e) !== subId)
    .map((e) => violation(e, 'writes', `${step(e)} of ${targetOf(e)}, not of ${own}`));
}

/**
 * I1, I4 and I6: writes need a same-turn yes after a spoken proposal, nothing happens before pin_ok or after the
 * call ends, and every subscription step targets one subscription, subscriptionId when the config gives it.
 */
export function checkWrites(events, { subscriptionId = null } = {}) {
  const problems = [];
  for (const list of groupByCall(events).values()) {
    problems.push(...checkOneSubscription(list, subscriptionId));
    const pinOk = list.find((e) => e.type === 'pin_ok');
    const ended = list.find((e) => e.type === 'call_end');
    for (const event of list) {
      if (!GATED_TYPES.has(event.type)) continue;
      if (!pinOk || event.seq < pinOk.seq) problems.push(violation(event, 'writes', `${event.type} happened before the PIN passed`));
      if (ended && event.seq > ended.seq) problems.push(violation(event, 'writes', `${event.type} happened after the call ended`));
    }
    const tokens = new Set();
    const subId = callSubscription(list, subscriptionId);
    for (const write of list.filter((e) => e.type === 'write')) {
      if (tokens.has(write.tokenId)) problems.push(violation(write, 'writes', 'a token was used twice'));
      tokens.add(write.tokenId);
      problems.push(...checkOneWrite(write, list, subId));
    }
  }
  return problems;
}

/**
 * Safety stops: no invoice to an email other than the one on file with the call's own subscription, an offered or
 * sent invoice shows its recipient, and a locked call reads and writes nothing.
 */
export function checkSafety(events, { subscriptionId = null } = {}) {
  const problems = [];
  for (const list of groupByCall(events).values()) {
    const subId = callSubscription(list, subscriptionId);
    const locked = list.find((e) => e.type === 'pin_locked');
    const offered = new Set(list.filter((e) => (e.type === 'proposed' || e.type === 'write') && e.kind === 'send_invoice').map((e) => e.targetId));
    let emailOnFile = null;
    for (const event of list) {
      if (locked && event.seq > locked.seq && (GATED_TYPES.has(event.type) || event.type === 'route')) {
        problems.push(violation(event, 'safety', `${event.type} happened after the call was locked`));
      }
      if (event.type !== 'read' || !event.snapshot) continue;
      if (event.what === 'subscription' && event.id === subId) emailOnFile = event.snapshot.subscriber_email;
      const to = event.what === 'invoice' ? event.snapshot.recipient_email : null;
      if (to && (!emailOnFile || to.toLowerCase() !== String(emailOnFile).toLowerCase())) {
        problems.push(violation(event, 'safety', 'an invoice was addressed to an email other than the one on file'));
      }
      // I5 can only be shown when PayPal's read names the recipient.
      if (event.what === 'invoice' && !to && offered.has(event.id)) {
        problems.push(violation(event, 'safety', `invoice ${event.id} was offered or sent, but PayPal's read shows no recipient`));
      }
    }
  }
  return problems;
}

function lastRead(list, what) {
  const reads = list.filter((e) => e.type === 'read' && e.what === what && (e.snapshot || e.notFound));
  return reads[reads.length - 1] ?? null;
}

function checkStatuses(list, expect, start) {
  const problems = [];
  const subReads = list.filter((e) => e.type === 'read' && e.what === 'subscription' && e.snapshot);
  const final = subReads[subReads.length - 1]?.snapshot?.status ?? null;
  if (expect.finalStatus && final !== expect.finalStatus) problems.push(violation(start, 'behavior', `final subscription status ${final}, expected ${expect.finalStatus}`));
  if (expect.unchanged && (subReads.length === 0 || subReads[0].snapshot.status !== final)) problems.push(violation(start, 'behavior', 'the subscription status changed or was never read'));
  if (expect.noReads && list.some((e) => e.type === 'read')) problems.push(violation(start, 'behavior', 'this call read PayPal but should read nothing'));
  if (expect.invoiceFinal) {
    const inv = lastRead(list, 'invoice');
    const got = inv ? (inv.notFound ? 'NOT_FOUND' : inv.snapshot.status) : null;
    const allowed = [].concat(expect.invoiceFinal);
    if (!allowed.includes(got)) problems.push(violation(start, 'behavior', `final invoice read ${got}, expected ${allowed.join(' or ')}`));
  }
  return problems;
}

const factsSaidIn = (list, turn) => list.filter((e) => e.type === 'said' && e.turn === turn).flatMap((e) => (Array.isArray(e.facts) ? e.facts : []));

/**
 * Each proposal reads its amount and status, or the invoice's amount and number, aloud, each write's reply reads the
 * new status back, and a script whose purpose is a read-back, Script 1, has a reply that reads its facts aloud (G1).
 */
function checkReadBacks(list, expect, start) {
  const problems = [];
  const aloud = expect.readsAloud ?? [];
  const readAloud = list.some((e) => e.type === 'said' && aloud.every((source) => (Array.isArray(e.facts) ? e.facts : []).some((f) => f.source === source)));
  if (aloud.length > 0 && !readAloud) problems.push(violation(start, 'behavior', `no reply read ${aloud.join(' and ')} aloud from PayPal`));
  for (const p of list.filter((e) => e.type === 'proposed')) {
    const facts = factsSaidIn(list, p.turn);
    for (const source of PROPOSAL_FACTS[p.kind] ?? []) {
      if (!facts.some((f) => f.source === source)) problems.push(violation(p, 'behavior', `the ${p.kind} proposal did not read ${source} aloud from PayPal`));
    }
  }
  for (const w of list.filter((e) => e.type === 'write' && e.ok && Object.hasOwn(WRITE_STATUS, e.kind))) {
    const want = WRITE_STATUS[w.kind];
    const readBack = factsSaidIn(list, w.turn).some((f) => f.source === want.source && want.values.includes(f.value));
    if (!readBack) problems.push(violation(w, 'behavior', `after ${w.kind}, the line did not read ${want.values.join(' or ')} back from PayPal`));
  }
  return problems;
}

/** Draft steps tie together: each delete is of a draft this call made, each draft ends sent or deleted (I2), and the final read is of the last draft. */
function checkDrafts(list, expect, start) {
  const problems = [];
  const ids = (pred, key = 'id') => list.filter(pred).map((e) => e[key]);
  const created = ids((e) => e.type === 'staging_write' && e.kind === 'create_draft' && e.ok);
  const deleted = ids((e) => e.type === 'staging_write' && e.kind === 'delete_draft' && e.ok);
  const sent = ids((e) => e.type === 'write' && e.kind === 'send_invoice' && e.ok, 'targetId');
  for (const id of deleted.filter((d) => !created.includes(d))) problems.push(violation(start, 'behavior', `deleted ${id}, which is not a draft this call made`));
  for (const id of created.filter((c) => !deleted.includes(c) && !sent.includes(c))) problems.push(violation(start, 'behavior', `draft ${id} was neither sent nor deleted`));
  const last = expect.invoiceFinal ? lastRead(list, 'invoice') : null;
  if (last && created.length > 0 && last.id !== created.at(-1)) problems.push(violation(start, 'behavior', `the final invoice read is of ${last.id}, not of the draft ${created.at(-1)}`));
  return problems;
}

/** Behavior: the call's writes, draft steps, refusals, read-backs and final statuses match the script. */
export function checkScript(events, script) {
  const list = [...events].sort(bySeq);
  const start = list.find((e) => e.type === 'call_start') ?? {};
  const expect = script.expect;
  const problems = [];
  const kinds = (type) => list.filter((e) => e.type === type).map((e) => e.kind);
  if (!same(kinds('write'), expect.writes)) problems.push(violation(start, 'behavior', `writes ${JSON.stringify(kinds('write'))}, expected ${JSON.stringify(expect.writes)}`));
  if (!same(kinds('staging_write'), expect.staging)) problems.push(violation(start, 'behavior', `draft steps ${JSON.stringify(kinds('staging_write'))}, expected ${JSON.stringify(expect.staging)}`));
  if (expect.proposals && !same(kinds('proposed'), expect.proposals)) problems.push(violation(start, 'behavior', `proposals ${JSON.stringify(kinds('proposed'))}, expected ${JSON.stringify(expect.proposals)}`));
  for (const failed of list.filter((e) => (e.type === 'write' || e.type === 'staging_write') && !e.ok)) {
    problems.push(violation(failed, 'behavior', `${failed.kind} failed with ${failed.error ?? 'an error'}`));
  }
  const reasons = list.filter((e) => e.type === 'refused').map((e) => e.reason);
  for (const reason of expect.refusals ?? []) {
    if (!reasons.includes(reason)) problems.push(violation(start, 'behavior', `expected a ${reason} refusal`));
  }
  for (const reason of SAFETY_REASONS) {
    if (reasons.includes(reason) && !(expect.refusals ?? []).includes(reason)) problems.push(violation(start, 'behavior', `unexpected ${reason} refusal`));
  }
  return [...problems, ...checkStatuses(list, expect, start), ...checkReadBacks(list, expect, start), ...checkDrafts(list, expect, start)];
}

/**
 * Median gap of unmuted turns. A reply that never started playing, because it was talked over or failed,
 * counts as never, since its gap is at least as long as it was measured and maybe endless (PILOT.md Test 4).
 */
export function medianGap(events, { sources = ['voice'] } = {}) {
  const gaps = events
    .filter((e) => e.type === 'gap' && sources.includes(e.source) && !e.muted && Number.isFinite(e.gapMs))
    .map((e) => (e.played === false ? Infinity : e.gapMs))
    .sort((a, b) => a - b);
  if (gaps.length === 0) return null;
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid] : Math.round((gaps[mid - 1] + gaps[mid]) / 2);
}

const turnKey = (e) => `${e.callId} ${e.turn}`;

function gapsByTurn(events) {
  const byTurn = new Map();
  for (const e of [...events].sort(bySeq)) {
    if (e.type === 'gap') byTurn.set(turnKey(e), [...(byTurn.get(turnKey(e)) ?? []), e]);
  }
  return byTurn;
}

/** The gaps Test 4 counts: the one gap of a turn the line heard from that same source. A turn with two gaps counts neither. */
export function countedGaps(events) {
  const heardFrom = new Map(events.filter((e) => e.type === 'heard').map((e) => [turnKey(e), e.source]));
  return [...gapsByTurn(events).values()].filter((gaps) => gaps.length === 1 && heardFrom.get(turnKey(gaps[0])) === gaps[0].source)
    .map(([gap]) => gap).sort(bySeq);
}

/** Gaps no honest page posts: two for one heard turn, or one shorter than the line's own time to make that reply (R3-8). */
export function gapProblems(events) {
  const heard = new Set(events.filter((e) => e.type === 'heard').map(turnKey));
  const serverMs = new Map(events.filter((e) => e.type === 'said').map((e) => [turnKey(e), e.ms]));
  const problems = [];
  for (const gaps of gapsByTurn(events).values()) {
    if (gaps.length > 1 && heard.has(turnKey(gaps[0]))) problems.push(violation(gaps[0], 'gap', `${gaps.length} gaps were logged for one turn, so none of them counts`));
  }
  for (const gap of countedGaps(events)) {
    const ms = serverMs.get(turnKey(gap));
    if (Number.isFinite(ms) && gap.gapMs < ms) problems.push(violation(gap, 'gap', `the gap of ${gap.gapMs} ms is shorter than the ${ms} ms the line took to make that reply`));
  }
  return problems;
}

/** The turns after the PIN step. A call is voice when all of them came from the talk button. */
export function nonPinTurns(list) {
  const pinStep = list.find((e) => e.type === 'pin_ok' || e.type === 'pin_locked');
  const after = pinStep ? pinStep.turn : Infinity;
  return list.filter((e) => e.type === 'heard' && e.turn > after);
}

export const isCallBy = (list, source) => {
  const turns = nonPinTurns(list);
  return turns.length > 0 && turns.every((e) => e.source === source);
};

/** The four call checks. options holds the configured orgName and subscriptionId in pilot-check. */
export function gradeCall(list, script, options = {}) {
  const grade = {
    facts: checkFacts(list, options),
    writes: checkWrites(list, options),
    safety: checkSafety(list, options),
    behavior: script ? checkScript(list, script) : [],
  };
  return { ...grade, passed: Object.values(grade).every((items) => items.length === 0) };
}

/**
 * Latest call per script number, optionally filtered. Dry-run calls are kept apart and never count.
 * A call with no turns at all is a mis-click, so it never replaces a real run. With until, only calls that started
 * by then count, so a demo after the deadline never replaces the call that met the bar on time (G2).
 */
export function latestCallsByScript(events, { since = null, until = null, filter = () => true, dryRun = false } = {}) {
  const groups = groupByCall(events);
  const latest = new Map();
  const sinceMs = since ? Date.parse(since) : null;
  const untilMs = until ? Date.parse(until) : null;
  for (const [callId, list] of groups) {
    const start = list.find((e) => e.type === 'call_start');
    if (!start || !start.script || Boolean(start.dryRun) !== dryRun) continue;
    // Compared as times, so a --since with a PT offset works like its UTC twin.
    if (sinceMs !== null && !(Date.parse(start.ts) >= sinceMs)) continue;
    if (untilMs !== null && !(Date.parse(start.ts) <= untilMs)) continue;
    if (!list.some((e) => e.type === 'heard')) continue;
    if (!filter(start, list)) continue;
    const current = latest.get(start.script);
    if (!current || current.start.seq < start.seq) latest.set(start.script, { callId, start, list });
  }
  return latest;
}
