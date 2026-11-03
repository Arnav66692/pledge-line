import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import * as say from './say.js';
import { parseAmountDollars, amountConflict } from './router.js';
import { spokenDigits, maskPinText, textHasPin } from './numbers.js';
import { isClearYes, isClearNo, isAcknowledgment, normalize, describeError } from './gate.js';
import { toSnapshot, PayPalError } from './paypal.js';
import { liveTemplates } from './vocabulary.js';
import { buildReceipts, receiptOptions } from './receipt.js';

export { maskPinText };

// What say.js speaks right now, built when the line loads (about 30 ms). call_start logs its hash, not the checked-in
// one, so a call made before npm run vocabulary names the list it was really spoken with (R4-2). A template that
// can't be built still lets the line start, so Render keeps taking webhooks, and its calls log a hash no history has.
function spokenTemplates() {
  try {
    return liveTemplates();
  } catch (error) {
    return Object.freeze({ hash: 'unbuilt', unreviewed: Object.freeze([]), error: error.message });
  }
}
const LIVE_TEMPLATES = spokenTemplates();
export const LIVE_TEMPLATE_HASH = LIVE_TEMPLATES.hash;
export const LIVE_UNREVIEWED = LIVE_TEMPLATES.unreviewed;
export const LIVE_TEMPLATE_ERROR = LIVE_TEMPLATES.error ?? null;

const RE_READ_TRIES = 3;
const RE_READ_GAP_MS = 600;
const MIN_SPOKEN_PIN_DIGITS = 4;
const USER_AGENT_MAX = 300;
const VENDOR_MAX = 80;
// The engine each named browser runs on. A user-agent override, such as Chrome's device toolbar, does not change it.
const BROWSER_ENGINES = Object.freeze({ chrome: 'chromium', edge: 'chromium', safari: 'webkit', firefox: 'gecko' });
const EXPECTED_STATUS = Object.freeze({ suspend: 'SUSPENDED', activate: 'ACTIVE', cancel: 'CANCELLED' });
const WRITER_METHODS = Object.freeze({ suspend: 'suspendSubscription', activate: 'activateSubscription', cancel: 'cancelSubscription', send_invoice: 'sendInvoice' });
const PENDING_LABELS = Object.freeze({ suspend: 'Pause the monthly gift', activate: 'Restart the monthly gift', cancel: 'Cancel the monthly gift', send_invoice: 'Send the one-time gift invoice' });
const BARE_WORDS = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'correct', 'ok', 'okay', 'please', 'do', 'go', 'ahead', 'it', 'that', "that's", 'is',
  'right', 'confirm', 'no', 'nope', 'nah', 'thanks', 'thank', 'you', 'not', 'now', 'never', 'mind', 'nevermind', 'keep', 'leave', "don't", 'dont']);
// Endings an address can have when said as "dotcom", "gmail .com" or "gmail. com". A short list, so "at once. Thanks" stays plain.
const EMAIL_ENDINGS = 'com|net|org|edu|gov|io|co|us|me|info|biz|uk|ca';
// The endings that are never plain words, for "point com" and "period com", so "at this point me" and "until the period ends" stay plain.
const PLAIN_ENDINGS = 'com|net|org|edu|gov|io';
// Mail domains a short ending can follow, as in "gmail. co. uk" or "outlook. us".
const MAIL_DOMAINS = 'gmail|yahoo|outlook|hotmail|icloud|aol|proton|protonmail|mail';
// The endings that are plain words too, as in "at work. Me and my wife", "at work. Me, I'll email you" or "at work. Co-workers",
// so ". me" joins only right after a mail domain or another short ending, as in "gmail. co. uk" (L1).
const WORD_ENDINGS = 'co|us|me|info|biz|uk|ca';
// One word of an address, such as gmail or mail.acme, never a lone mark.
const ADDRESS_WORD = '[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9][a-z0-9-]*)*';
// The strict forms, "x@y" and "x @ y", "x at y dot z" with spaces only, and "x at y.z". NFKC first, so a full-width or
// small @ counts as @. These count in any turn.
const EMAIL_PATTERNS = [
  /[^\s@]+\s*@\s*[^\s@]+/g,
  new RegExp(`\\bat\\s+${ADDRESS_WORD}(?:\\s+${ADDRESS_WORD}){0,3}\\s+dot\\s+[a-z]{2,}\\b`, 'gi'),
  /\bat\s+[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi,
];
// A word that says the turn is about an email, so the loose forms below are read as one (R4-4).
const EMAIL_WORDS = /\b(?:e-?mails?|e mails?|address(?:es)?|gmail|yahoo|outlook|hotmail|icloud|aol)\b/i;

export class CallNotFound extends Error {
  constructor() {
    super('No such call');
    this.name = 'CallNotFound';
  }
}

/** A gap the line will not log: for the greeting, for a reply it has not finished, or a second one for a turn (R3-8). */
export class GapRefused extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GapRefused';
    this.status = status;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A failed write PayPal gave no clear answer to: a timeout, a lost connection or a 5xx, never a 4xx (L2). */
const unanswered = (result) => !result.ok && result.error instanceof PayPalError && !(result.error.status >= 400 && result.error.status < 500);

/** The digits of a PIN typed or said, including "twenty four sixty eight" and "thirteen fourteen". */
export function parsePinDigits(text) {
  return spokenDigits(text);
}

// "bob (at) gmail [dot] com", "gmail dotcom", "gmail point com" and "gmail .com" read like "bob at gmail dot com" in any turn.
const strictText = (text) => String(text ?? '').normalize('NFKC')
  .replace(/[([{<]\s*(at|dot)\s*[)\]}>]/gi, ' $1 ')
  .replace(new RegExp(`\\bdot(${EMAIL_ENDINGS})\\b`, 'gi'), ' dot $1')
  .replace(new RegExp(`\\bpoint\\s*(${PLAIN_ENDINGS})\\b`, 'gi'), ' dot $1')
  .replace(new RegExp(`\\s+\\.\\s*(${EMAIL_ENDINGS})\\b`, 'gi'), '.$1');

// The loose forms, read only in a turn that also says an email word or a mail domain, since plain speech has them too,
// as in "at the end of the period, me and my wife" or "at work. Net is down" (R4-4). Marks touching at, dot or period,
// as in "-at-", "dot." or "dot-com", "period com", "gmail. com" and "gmail,com", and commas or other marks between the words.
const looseText = (text) => strictText(text)
  .replace(/[-,.;:!?]*\b(at|dot|period)\b[-,.;:!?]*/gi, ' $1 ')
  .replace(new RegExp(`\\bperiod\\s+(${PLAIN_ENDINGS})\\b`, 'gi'), ' dot $1')
  .replace(new RegExp(`(?<=[a-z0-9])(?:,(${EMAIL_ENDINGS})|,\\s+(${PLAIN_ENDINGS}))\\b`, 'gi'), (_, joined, spaced) => `.${joined ?? spaced}`)
  .replace(new RegExp(`\\.\\s+(${PLAIN_ENDINGS})\\b`, 'gi'), '.$1')
  .replace(new RegExp(`\\b(${MAIL_DOMAINS}|${WORD_ENDINGS})\\.\\s+(${WORD_ENDINGS})\\b`, 'gi'), '$1.$2')
  .replace(new RegExp(`\\b(${WORD_ENDINGS})\\.\\s+(${WORD_ENDINGS})\\b`, 'gi'), '$1.$2')
  .replace(/(?<!\d),(?!\d)|[;:!?]+|\.{2,}|\.(?=\s|$)|(?<=\s)\.|(?<![a-z0-9])-+|-+(?![a-z0-9])/gi, ' ');

/** The text the email check reads: the loose form when the turn says an email word, else the strict form only. */
const emailReading = (text) => (EMAIL_WORDS.test(String(text ?? '').normalize('NFKC')) ? looseText(text) : strictText(text));
const matchesEmail = (prepared) => EMAIL_PATTERNS.some((pattern) => new RegExp(pattern.source, pattern.flags.replace('g', '')).test(prepared));

export function looksLikeEmail(text) {
  return matchesEmail(strictText(text)) || matchesEmail(emailReading(text));
}

const stripEmails = (text) => EMAIL_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, ' '), emailReading(text));

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The text with the email on file set aside, in the masked form invoiceConfirm reads aloud, as in "s b at personal dot
 * example dot com". That phrase names the email on file, never a new one, so a caller who checks it back is not refused.
 * The draft still goes to the email from a fresh GET either way (I5, L3).
 */
function withoutEmailOnFile(call, text) {
  const masked = say.maskEmail(call.record.subscription?.snapshot?.subscriber_email);
  if (!masked) return String(text ?? '');
  const phrase = masked.split(' ').map(escapeRegex).join('\\s+');
  return String(text ?? '').replace(new RegExp(`(?<![\\p{L}\\p{N}])${phrase}(?![\\p{L}\\p{N}])`, 'giu'), ' ');
}

const looksLikeNewEmail = (call, text) => looksLikeEmail(withoutEmailOnFile(call, text));

function pinMatches(candidate, pin) {
  if (typeof pin !== 'string' || pin === '') return false;
  const digest = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(candidate), digest(pin));
}

function isBareYesOrNo(text) {
  const norm = normalize(text);
  if (norm === '' || !(isClearYes(text) || isClearNo(text))) return false;
  return norm.split(' ').every((word) => BARE_WORDS.has(word));
}

function browserFromAgent(userAgent) {
  const ua = String(userAgent ?? '');
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'edge';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'firefox';
  if (/OPR\//.test(ua)) return 'other';
  if (/Chrome\/|CriOS\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'safari';
  return 'other';
}

/** Keeps only the engine signals the page sends, so nothing else from the client reaches the ledger. */
export function normalizeClient(client) {
  if (!client || typeof client !== 'object' || typeof client.vendor !== 'string') return null;
  return { vendor: client.vendor.slice(0, VENDOR_MAX), chrome: client.chrome === true, uaData: client.uaData === true };
}

/** The engine the page's own signals point to. window.chrome and navigator.userAgentData exist only in Chromium. */
export function engineOf(client) {
  const signals = normalizeClient(client);
  if (!signals) return 'unknown';
  if (signals.chrome || signals.uaData) return 'chromium';
  if (/^Apple/.test(signals.vendor)) return 'webkit';
  return signals.vendor === '' ? 'gecko' : 'unknown';
}

/** The browser the user agent names, kept only when the engine signals agree, so a spoofed agent counts as other. */
export function detectBrowser(userAgent, client = null) {
  const named = browserFromAgent(userAgent);
  return named !== 'other' && BROWSER_ENGINES[named] === engineOf(client) ? named : 'other';
}

function normalizeScript(script) {
  const n = Number(script);
  return script !== null && script !== undefined && script !== '' && Number.isInteger(n) && n >= 1 && n <= 10 ? n : null;
}

const normalizeSource = (source) => (['voice', 'typed', 'keypad'].includes(source) ? source : 'typed');

function formatRecord(call, timeZone) {
  const sub = call.record.subscription;
  const inv = call.record.invoice;
  const plan = call.plan;
  return {
    subscription: sub && {
      id: sub.id,
      status: sub.snapshot?.status ?? null,
      amount: plan ? say.formatMoney(plan.price_value, plan.price_currency ?? undefined) : null,
      nextDate: say.formatDate(sub.snapshot?.next_billing_time, timeZone),
      debugId: sub.debugId,
      notFound: sub.snapshot === null,
    },
    invoice: inv && {
      id: inv.id,
      number: inv.snapshot?.number ?? null,
      status: inv.snapshot ? inv.snapshot.status : 'NOT_FOUND',
      amount: inv.snapshot ? say.formatMoney(inv.snapshot.amount_value, inv.snapshot.amount_currency ?? undefined) : null,
      recipientViewUrl: inv.snapshot?.recipient_view_url ?? null,
      debugId: inv.debugId,
    },
  };
}

function projectEvent(event) {
  const { snapshot, userAgent, tokenId, ...rest } = event;
  return rest;
}

export function createCallService({ config, ledger, paypal, router, gate, now = () => new Date(), sleep = defaultSleep, pinGuard = null }) {
  const calls = new Map();
  const limits = config.limits;

  const log = (call, event) => ledger.append({ ...event, callId: call.id });
  const refused = (ctx, reason) => log(ctx.call, { type: 'refused', turn: ctx.turn, reason });

  async function timed(ctx, fn) {
    const started = performance.now();
    try {
      return await fn();
    } finally {
      ctx.paypalMs += Math.round(performance.now() - started);
    }
  }

  function enqueue(call, fn) {
    const run = call.queue.then(fn);
    call.queue = run.catch(() => {});
    return run;
  }

  function stateFor(call) {
    const p = call.pending;
    return {
      callId: call.id,
      script: call.script,
      verified: call.verified,
      locked: call.locked,
      ended: call.ended,
      pending: p ? { kind: p.kind, label: PENDING_LABELS[p.kind], expiresAt: new Date(p.expiresAt).toISOString() } : null,
      record: formatRecord(call, config.timeZone),
      // Built from the same ledger events, with the same orgName and subscription, that pilot-check grades.
      receipts: buildReceipts(ledger.byCall(call.id), receiptOptions(config)),
    };
  }

  // ---- PayPal reads, each logged as a `read` event ----

  const GETTERS = { subscription: 'getSubscription', plan: 'getPlan', invoice: 'getInvoice' };

  async function readSnapshot(ctx, what, id) {
    const base = { type: 'read', turn: ctx.turn, what, id };
    let res;
    try {
      res = await paypal[GETTERS[what]](id);
    } catch (error) {
      log(ctx.call, { ...base, status: null, snapshot: null, debugId: error?.debugId ?? null, ms: 0, error: describeError(error) });
      throw error;
    }
    const snapshot = res.notFound ? null : toSnapshot(what, res.data);
    const notFound = res.notFound ? { notFound: true } : {};
    log(ctx.call, { ...base, status: snapshot?.status ?? null, snapshot, debugId: res.debugId ?? null, ms: res.ms ?? 0, ...notFound });
    if (what === 'subscription') ctx.call.record.subscription = { id, snapshot, debugId: res.debugId ?? null };
    if (what === 'invoice') ctx.call.record.invoice = { id, snapshot, debugId: res.debugId ?? null };
    return snapshot;
  }

  async function readGift(ctx, { fresh = false } = {}) {
    const { call } = ctx;
    const subId = config.demoSubscriptionId;
    if (!subId) return { sub: null };
    // A fresh read reads the plan again too, so the amount it speaks comes from that turn's own reads.
    const hint = fresh ? (call.plan?.id ?? config.demoPlanId) : call.plan ? null : config.demoPlanId;
    const [sub, hinted] = await timed(ctx, () => Promise.all([
      readSnapshot(ctx, 'subscription', subId),
      hint ? readSnapshot(ctx, 'plan', hint).catch(() => null) : Promise.resolve(null),
    ]));
    if (!sub) return { sub: null };
    const gotPlan = Boolean(hinted) && hinted.id === sub.plan_id;
    if (gotPlan) call.plan = hinted;
    if (sub.plan_id && (fresh ? !gotPlan : call.plan?.id !== sub.plan_id)) {
      call.plan = await timed(ctx, () => readSnapshot(ctx, 'plan', sub.plan_id));
    }
    return { sub, plan: call.plan };
  }

  async function rereadUntil(ctx, read, isDone) {
    let snapshot = null;
    for (let i = 0; i < RE_READ_TRIES; i += 1) {
      if (i > 0) await sleep(RE_READ_GAP_MS);
      snapshot = await timed(ctx, read);
      if (isDone(snapshot)) break;
    }
    return snapshot;
  }

  // ---- Staging writes (I2) ----

  async function createDraft(ctx, email, amount) {
    const started = performance.now();
    const base = { type: 'staging_write', turn: ctx.turn, kind: 'create_draft' };
    try {
      const res = await timed(ctx, () => paypal.createDraftInvoice({ recipientEmail: email, amountValue: amount.toFixed(2), currency: config.currency, orgName: config.orgName }));
      log(ctx.call, { ...base, id: res.id, ok: true, debugId: res.debugId ?? null, ms: res.ms ?? 0 });
      ctx.call.openDraftId = res.id;
      ctx.call.lastDraftId = res.id;
      return res.id;
    } catch (error) {
      log(ctx.call, { ...base, id: null, ok: false, debugId: error?.debugId ?? null, ms: Math.round(performance.now() - started), error: describeError(error) });
      return null;
    }
  }

  async function deleteDraft(ctx, id) {
    const started = performance.now();
    const base = { type: 'staging_write', turn: ctx.turn, kind: 'delete_draft', id };
    try {
      const res = await timed(ctx, () => paypal.deleteDraftInvoice(id));
      log(ctx.call, { ...base, ok: true, debugId: res.debugId ?? null, ms: res.ms ?? 0 });
      if (ctx.call.openDraftId === id) ctx.call.openDraftId = null;
      // The line already said PayPal no longer shows a draft it deleted, so "How do you know?" doesn't read it again.
      if (ctx.call.lastDraftId === id) ctx.call.lastDraftId = null;
      return true;
    } catch (error) {
      log(ctx.call, { ...base, ok: false, debugId: error?.debugId ?? null, ms: Math.round(performance.now() - started), error: describeError(error) });
      return false;
    }
  }

  async function endCall(call, reason) {
    if (call.ended) return;
    const ctx = { call, turn: call.turn, paypalMs: 0, routerMs: 0 };
    call.ended = true;
    call.endedAt = now().getTime();
    gate.withdraw(call, call.turn);
    if (call.openDraftId) {
      await deleteDraft(ctx, call.openDraftId);
      call.openDraftId = null;
    }
    log(call, { type: 'call_end', reason });
  }

  // ---- Proposals ----

  function propose(ctx, kind, targetId, readBack, origin) {
    if (kind === 'suspend') ctx.call.pauseOffered = true;
    gate.propose(ctx.call, { kind, targetId, readBack, origin, turn: ctx.turn });
    return readBack;
  }

  function proposeCancel(ctx, sub, plan) {
    if (!['ACTIVE', 'SUSPENDED'].includes(sub.status)) return say.nothingTo('cancel', sub, plan);
    return propose(ctx, 'cancel', sub.id ?? config.demoSubscriptionId, say.cancelConfirm(sub, plan), 'request');
  }

  async function withGift(ctx, fn) {
    const { sub, plan } = await readGift(ctx);
    if (!sub) {
      refused(ctx, 'no_subscription');
      return say.noSubscription();
    }
    return fn(sub, plan);
  }

  const giftStatusTurn = (ctx) => withGift(ctx, (sub, plan) => say.giftStatus(sub, plan, { timeZone: config.timeZone }));

  const stopGiftTurn = (ctx) => withGift(ctx, (sub, plan) => {
    if (ctx.call.pauseOffered || sub.status !== 'ACTIVE') return proposeCancel(ctx, sub, plan);
    return propose(ctx, 'suspend', sub.id ?? config.demoSubscriptionId, say.pauseOffer(sub, plan), 'pause_offer');
  });

  const cancelTurn = (ctx) => withGift(ctx, (sub, plan) => proposeCancel(ctx, sub, plan));

  const pauseTurn = (ctx) => withGift(ctx, (sub, plan) => (sub.status === 'ACTIVE'
    ? propose(ctx, 'suspend', sub.id ?? config.demoSubscriptionId, say.pauseConfirm(sub, plan), 'request')
    : say.nothingTo('suspend', sub, plan)));

  const resumeTurn = (ctx) => withGift(ctx, (sub, plan) => (sub.status === 'SUSPENDED'
    ? propose(ctx, 'activate', sub.id ?? config.demoSubscriptionId, say.resumeConfirm(sub, plan), 'request')
    : say.nothingTo('activate', sub, plan)));

  function draftMatches(inv, email, amount) {
    return Boolean(inv) && inv.status === 'DRAFT' && Boolean(inv.number)
      && typeof inv.recipient_email === 'string' && inv.recipient_email.toLowerCase() === email.toLowerCase()
      && inv.amount_currency === config.currency && Math.round(Number(inv.amount_value) * 100) === Math.round(amount * 100);
  }

  async function createGiftDraft(ctx, amount) {
    // I2: at most one open draft, so a draft PayPal would not delete blocks a new one. endCall tries it again.
    if (ctx.call.openDraftId && !(await deleteDraft(ctx, ctx.call.openDraftId))) return say.paypalProblem();
    const subId = config.demoSubscriptionId;
    const sub = subId ? await timed(ctx, () => readSnapshot(ctx, 'subscription', subId)) : null;
    if (!sub) {
      refused(ctx, 'no_subscription');
      return say.noSubscription();
    }
    // I5: the recipient is always the email on file from this fresh GET.
    if (!sub.subscriber_email) return say.noEmail();
    const draftId = await createDraft(ctx, sub.subscriber_email, amount);
    if (!draftId) return say.paypalProblem();
    let inv;
    try {
      inv = await timed(ctx, () => readSnapshot(ctx, 'invoice', draftId));
    } catch (error) {
      await deleteDraft(ctx, draftId);
      throw error;
    }
    if (!draftMatches(inv, sub.subscriber_email, amount)) {
      if (inv) await deleteDraft(ctx, draftId);
      return say.paypalProblem();
    }
    return propose(ctx, 'send_invoice', draftId, say.invoiceConfirm(inv, config.orgName), 'request');
  }

  async function oneTimeTurn(ctx, amount) {
    const { invoiceMinDollars: min, invoiceMaxDollars: max } = limits;
    if (!(amount >= min && amount <= max)) {
      if (amount > 0) refused(ctx, 'amount_out_of_range');
      return say.amountOutOfRange(min, max);
    }
    return createGiftDraft(ctx, amount);
  }

  async function otherEmailTurn(ctx, text, routedAmount = 0) {
    refused(ctx, 'other_email');
    // Only an amount said as money counts here, so digits left over from a spoken address never become a gift.
    const amount = routedAmount > 0 ? routedAmount : parseAmountDollars(stripEmails(text), { needCurrency: true });
    if (!(amount > 0)) return say.combine(say.otherEmail(), say.amountForFile());
    return say.combine(say.otherEmail(), await oneTimeTurn(ctx, amount));
  }

  // ---- "How do you know?" (proof) ----

  // The values a proposal's read-back said, still what PayPal's fresh reads give, so speaking it again stays true.
  const stillAsRead = (pending, snapshots) => (pending.readBack.facts ?? []).every((f) => {
    const snapshot = snapshots[String(f.source).split('.')[0]];
    return Boolean(snapshot) && Object.hasOwn(say.FACT_SOURCES, f.source) && say.FACT_SOURCES[f.source](snapshot, config.timeZone) === f.value;
  });

  /** The proposal still waiting, spoken again after the fresh reads, so a yes in the next turn answers it (I1, I6). */
  function proofWhilePending(ctx, sub, plan) {
    const { pending } = ctx.call;
    gate.reask(ctx.call, ctx.turn);
    // A send's read-back names the draft, so the gift is read aloud first. A gift change's read-back opens with the gift.
    const lead = pending.kind === 'send_invoice' ? say.recheck(sub, plan, null, { close: false }) : say.rechecked();
    return say.combine(lead, pending.readBack);
  }

  /**
   * After the PIN, read the call's own subscription again with a fresh GET, and the call's own draft when it made one
   * it has not deleted, then say what those reads show. A proposal still waiting stays open only when the fresh reads
   * match what its read-back said, else it is set aside and the line says what PayPal shows now (I3, I8).
   */
  async function proofTurn(ctx) {
    const { call } = ctx;
    const waiting = call.pending;
    const draftId = waiting?.kind === 'send_invoice' ? waiting.targetId : call.lastDraftId;
    let sub, plan, inv;
    try {
      ({ sub, plan } = await readGift(ctx, { fresh: true }));
      inv = sub && draftId ? await timed(ctx, () => readSnapshot(ctx, 'invoice', draftId)) : undefined;
    } catch (error) {
      if (!(error instanceof PayPalError) || !waiting) throw error;
      // A read that failed can't back the read-back, so the change is set aside and no later yes can approve it.
      await dropPending(ctx);
      return say.combine(say.setAside(), say.paypalProblem());
    }
    if (waiting && sub && stillAsRead(waiting, { subscription: sub, plan, invoice: inv ?? null })) return proofWhilePending(ctx, sub, plan);
    const dropped = waiting ? await dropPending(ctx) : null;
    const lead = dropped ? say.setAside() : null;
    if (!sub) {
      refused(ctx, 'no_subscription');
      return say.combine(lead, say.noSubscription());
    }
    // A draft just deleted with the proposal it belonged to is not read aloud as if it were still there.
    if (dropped?.kind === 'send_invoice' || inv === undefined) return say.combine(lead, say.recheck(sub, plan));
    return say.combine(lead, say.recheck(sub, plan, inv, { draftGone: inv === null }));
  }

  // ---- Routing ----

  async function routeTurn(ctx, text) {
    const { call } = ctx;
    const state = { verified: call.verified, pendingKind: call.pending?.kind ?? null, pauseOffered: call.pauseOffered, lastSaid: call.lastSaid?.text ?? '' };
    const routed = await router.route({ text, state });
    ctx.routerMs += routed.latencyMs ?? 0;
    const error = routed.error ? { error: routed.error } : {};
    log(call, { type: 'route', turn: ctx.turn, intent: routed.intent, amountDollars: routed.amountDollars, latencyMs: routed.latencyMs, model: routed.model, ...error });
    // The model only picks a phrase key, so the words spoken here are always our own (I3).
    const empathy = say.filterEmpathy(say.empathyPhrase(routed.empathy));
    if (empathy) ctx.empathy = { text: empathy, facts: [] };
    return routed;
  }

  // A proposal that expired or was set aside is never read out again as if it still waited for a yes. A repeat notes the
  // turn whose reply it repeats, so check.js proves that reply's claims where they were first made (R4-1).
  function repeatLast(ctx) {
    const { call } = ctx;
    if (call.lastSaidPending && call.lastSaidPending !== call.pending?.id) return say.nothingPending();
    if (call.lastSaid?.text) ctx.repeats = call.lastSaidTurn;
    return say.repeat(call.lastSaid);
  }

  // The router's amount, unless the caller's own words correct it or name another number, as in "fifty dollars, I mean
  // sixty". Then the line asks, whatever the router heard, so a model that picks the first number never drafts it (R3-1).
  const routedAmount = (routed, words) => (amountConflict(words) ? 0 : routed.amountDollars);

  async function handleIntent(ctx, routed, text) {
    const { call } = ctx;
    switch (routed.intent) {
      case 'gift_status': return giftStatusTurn(ctx);
      case 'stop_gift': return stopGiftTurn(ctx);
      case 'cancel_now': return cancelTurn(ctx);
      case 'pause_gift': return pauseTurn(ctx);
      case 'resume_gift': return resumeTurn(ctx);
      // The router's amount only. When it heard none, the line asks, rather than reading another number in the turn as one.
      case 'one_time_gift': return oneTimeTurn(ctx, routedAmount(routed, text));
      case 'other_email': return otherEmailTurn(ctx, text, routedAmount(routed, stripEmails(text)));
      case 'help': return say.help();
      case 'how_do_you_know': return proofTurn(ctx);
      case 'repeat': return repeatLast(ctx);
      case 'staff_callback':
        log(call, { type: 'staff_callback', turn: ctx.turn });
        return say.staffCallback();
      case 'goodbye':
        await endCall(call, 'goodbye');
        return say.goodbye();
      default: return say.unclear();
    }
  }

  // ---- Turn phases ----

  async function pinTurn(ctx, text) {
    const { call } = ctx;
    const digits = parsePinDigits(text);
    const isAttempt = ctx.source === 'keypad' ? digits.length > 0 : digits.length >= MIN_SPOKEN_PIN_DIGITS;
    if (!isAttempt) {
      refused(ctx, 'not_verified');
      return say.notVerified();
    }
    // Wrong PINs add up across calls from one address, so starting new calls never buys more guesses.
    if (pinGuard?.blocked(call.clientKey)) {
      refused(ctx, 'pin_limit');
      return say.pinLimit();
    }
    if (pinMatches(digits, config.pin)) {
      call.verified = true;
      log(call, { type: 'pin_ok', turn: ctx.turn });
      return say.pinOk();
    }
    pinGuard?.record(call.clientKey);
    call.pinTries += 1;
    log(call, { type: 'pin_bad', turn: ctx.turn });
    const left = limits.pinTries - call.pinTries;
    if (left > 0) return say.pinBad(left);
    call.locked = true;
    log(call, { type: 'pin_locked', turn: ctx.turn });
    await endCall(call, 'locked');
    return say.pinLocked();
  }

  async function yesTurn(ctx, text) {
    const { call } = ctx;
    const approval = gate.approve(call, text, ctx.turn, ctx.answering, ctx.arrival);
    if (!approval) return call.pending ? askAgain(ctx) : say.nothingPending();
    const { pending } = approval;
    const writer = (id, token) => paypal[WRITER_METHODS[pending.kind]](id, token, { callId: call.id });
    const result = await timed(ctx, () => gate.execute(call, approval, writer, ctx.turn));
    // A 4xx is PayPal saying no. A timeout or a 5xx leaves it open, since PayPal may have made the change and lost its
    // answer, so the line reads PayPal again as for an ok write and says what it shows (L2).
    const unclear = unanswered(result);
    const settled = (changed) => (s) => (!result.ok && !unclear) || changed(s);
    const outcome = { ok: result.ok, unclear };
    try {
      if (pending.kind === 'send_invoice') {
        if (result.ok) call.openDraftId = null;
        const inv = await rereadUntil(ctx, () => readSnapshot(ctx, 'invoice', pending.targetId), settled((s) => s !== null && s.status !== 'DRAFT'));
        // A send PayPal made though its answer was lost is no longer a draft, so the end of the call must not delete it.
        if (inv && inv.status !== 'DRAFT') call.openDraftId = null;
        return say.afterWrite('send_invoice', inv, null, outcome);
      }
      const expected = EXPECTED_STATUS[pending.kind];
      const sub = await rereadUntil(ctx, () => readSnapshot(ctx, 'subscription', pending.targetId), settled((s) => s?.status === expected));
      return say.afterWrite(pending.kind, sub, call.plan, outcome);
    } catch (error) {
      if (!(error instanceof PayPalError)) throw error;
      // I8: never claim a status PayPal did not return.
      return say.afterWrite(pending.kind, null, call.plan, outcome);
    }
  }

  async function noTurn(ctx, text) {
    const pending = gate.decline(ctx.call, text, ctx.turn);
    if (pending.kind === 'send_invoice') {
      await deleteDraft(ctx, pending.targetId);
      const inv = await timed(ctx, () => readSnapshot(ctx, 'invoice', pending.targetId));
      return say.draftDeleted(inv === null);
    }
    if (pending.kind === 'suspend' && pending.origin === 'pause_offer') {
      return withGift(ctx, (sub, plan) => say.combine(say.noPause(), proposeCancel(ctx, sub, plan)));
    }
    return say.declined(pending.kind);
  }

  /** Speaks the pending proposal again, so a yes in the next turn answers it (I6). */
  function askAgain(ctx, lead = null) {
    gate.reask(ctx.call, ctx.turn);
    return say.combine(lead, ctx.call.pending.readBack);
  }

  async function dropPending(ctx) {
    const dropped = gate.withdraw(ctx.call, ctx.turn);
    if (dropped?.kind === 'send_invoice') await deleteDraft(ctx, dropped.targetId);
    return dropped;
  }

  async function pendingTurn(ctx, text) {
    const { call } = ctx;
    // I5: an email anywhere in the turn is refused before a yes can count, as in "yes, send it to bob@x.com".
    if (looksLikeNewEmail(call, text)) {
      refused(ctx, 'other_email');
      return askAgain(ctx, say.otherEmail());
    }
    // I1 and I4: a turn that carried the PIN reaches here masked, and the mask can hide the words that make it
    // a change request, as in "yes double it to 468". So it is never a yes or a no, and the line asks again.
    if (ctx.pinShown) return askAgain(ctx, say.needYesOrNo());
    const verdict = gate.classify(call, text);
    if (verdict === 'yes') return yesTurn(ctx, text);
    if (verdict === 'no') return noTurn(ctx, text);
    if (isAcknowledgment(text)) return askAgain(ctx, say.needYesOrNo());
    const routed = await routeTurn(ctx, text);
    if (routed.intent === 'other_email') {
      refused(ctx, 'other_email');
      return askAgain(ctx, say.otherEmail());
    }
    if (routed.intent === 'repeat' || routed.intent === 'unclear') return askAgain(ctx);
    // "Are you sure?" while a change waits reads PayPal again and keeps the change open when PayPal still agrees.
    if (routed.intent === 'how_do_you_know') return proofTurn(ctx);
    // Anything else moves past the proposal, so it is dropped and a later yes can never approve it.
    await dropPending(ctx);
    const reply = await handleIntent(ctx, routed, text);
    return call.pending ? reply : say.combine(say.setAside(), reply);
  }

  async function freeTurn(ctx, text) {
    if (isBareYesOrNo(text) || isAcknowledgment(text)) return say.nothingPending();
    if (looksLikeNewEmail(ctx.call, text)) return otherEmailTurn(ctx, text);
    const routed = await routeTurn(ctx, text);
    return handleIntent(ctx, routed, text);
  }

  async function verifiedTurn(ctx, text) {
    const { call } = ctx;
    const expired = gate.expireIfStale(call);
    if (expired || call.noticeExpired) {
      ctx.notice = say.expiredNotice();
      call.noticeExpired = false;
    }
    if (expired?.kind === 'send_invoice') await deleteDraft(ctx, expired.targetId);
    if (call.pending) return pendingTurn(ctx, text);
    return freeTurn(ctx, text);
  }

  async function dispatch(ctx, text) {
    const { call } = ctx;
    if (call.ended || call.locked) {
      refused(ctx, call.locked ? 'locked' : 'ended');
      return say.callEnded();
    }
    if (call.turn > limits.maxTurnsPerCall) {
      refused(ctx, 'turn_limit');
      await endCall(call, 'limit');
      return say.turnLimit();
    }
    try {
      return call.verified ? await verifiedTurn(ctx, text) : await pinTurn(ctx, text);
    } catch (error) {
      if (error instanceof PayPalError) return say.paypalProblem();
      throw error;
    }
  }

  async function runTurn(call, { text, source, answering }, arrival) {
    const started = performance.now();
    const clean = typeof text === 'string' ? text.trim() : '';
    call.turn += 1;
    // answering is the turn of the last reply the caller's client received. A yes must answer the reply that asked (I6).
    // arrival holds the server's own facts about when the turn arrived, which the client can't forge (I1).
    const ctx = { call, turn: call.turn, source: normalizeSource(source), answering: Number.isInteger(answering) ? answering : null,
      arrival, routerMs: 0, paypalMs: 0, empathy: null, notice: null, pinShown: false, repeats: null };
    call.lastActiveAt = now().getTime();
    let reply;
    if (clean.length > limits.maxTextChars) {
      refused(ctx, 'too_long');
      reply = say.tooLong();
    } else {
      // I4: mask while waiting for the PIN, on keypad turns, and whenever the PIN shows up later.
      const hidePin = !call.verified || ctx.source === 'keypad' || textHasPin(clean, config.pin);
      const heardText = hidePin ? maskPinText(clean) : clean;
      log(call, { type: 'heard', turn: ctx.turn, text: heardText, source: ctx.source, answering: ctx.answering, ...arrival });
      ctx.pinShown = call.verified && hidePin;
      reply = await dispatch(ctx, call.verified ? heardText : clean);
    }
    const full = say.combine(ctx.empathy, ctx.notice, reply);
    const serverMs = Math.round(performance.now() - started);
    const repeats = Number.isInteger(ctx.repeats) ? { repeats: ctx.repeats } : {};
    log(call, { type: 'said', turn: ctx.turn, text: full.text, facts: full.facts, claims: full.claims, ms: serverMs, ...repeats });
    call.lastSaid = full;
    call.lastSaidTurn = Number.isInteger(ctx.repeats) ? ctx.repeats : ctx.turn;
    call.lastSaidPending = call.pending?.id ?? null;
    call.lastFinishedTurn = ctx.turn;
    call.lastFinishedAt = performance.now();
    return { reply: full.text, turn: ctx.turn, state: stateFor(call), timings: { serverMs, routerMs: ctx.routerMs, paypalMs: ctx.paypalMs } };
  }

  // ---- Public API ----

  function getCall(callId) {
    const call = calls.get(callId);
    if (!call) throw new CallNotFound();
    return call;
  }

  function start({ script = null, userAgent = '', dryRun = false, clientKey = null, client = null } = {}) {
    const signals = normalizeClient(client);
    const call = {
      // clientKey is the caller's address for the PIN guard. It never goes to the ledger or the browser.
      id: randomUUID(), script: normalizeScript(script), browser: detectBrowser(userAgent, signals), clientKey, verified: false, locked: false,
      pinTries: 0, turn: 0, pending: null, pauseOffered: false, openDraftId: null, lastDraftId: null, lastSaid: null, lastSaidTurn: 0, lastSaidPending: null, ended: false, endedAt: null,
      noticeExpired: false, lastActiveAt: now().getTime(), plan: null, record: { subscription: null, invoice: null }, queue: Promise.resolve(),
      // The greeting, turn 0, is finished as soon as the call starts. gapTurns holds the turns that already have a gap.
      lastFinishedTurn: 0, lastFinishedAt: performance.now(), gapTurns: new Set(),
    };
    calls.set(call.id, call);
    log(call, {
      type: 'call_start', script: call.script, userAgent: String(userAgent ?? '').slice(0, USER_AGENT_MAX), client: signals, engine: engineOf(signals),
      browser: call.browser, mode: { paypal: config.paypal.mode, router: config.router.mode }, timeZone: config.timeZone, orgName: config.orgName,
      // The configured subscription and the template list, so pilot-check can grade the call with what it ran on (R4-2, R4-3).
      subscriptionId: config.demoSubscriptionId ?? null, templates: LIVE_TEMPLATE_HASH,
      ...(dryRun ? { dryRun: true } : {}),
    });
    const reply = say.greeting(config.orgName);
    log(call, { type: 'said', turn: 0, text: reply.text, facts: reply.facts, claims: reply.claims, ms: 0 });
    call.lastSaid = reply;
    return { callId: call.id, reply: reply.text, turn: 0, state: stateFor(call) };
  }

  async function expirePending(call) {
    const expired = gate.expireIfStale(call);
    if (!expired) return;
    call.noticeExpired = true;
    if (expired.kind === 'send_invoice') await deleteDraft({ call, turn: call.turn, paypalMs: 0, routerMs: 0 }, expired.targetId);
  }

  async function sweep() {
    const at = now().getTime();
    const jobs = [];
    for (const call of calls.values()) {
      if (call.ended) {
        if (at - call.endedAt > limits.callIdleMs) calls.delete(call.id);
      } else if (at - call.lastActiveAt >= limits.callIdleMs) {
        jobs.push(enqueue(call, () => endCall(call, 'idle')));
      } else if (call.pending && at >= call.pending.expiresAt) {
        jobs.push(enqueue(call, () => expirePending(call)));
      }
    }
    await Promise.all(jobs);
    return jobs.length;
  }

  return {
    start,
    /**
     * The arrival facts are taken before the turn waits in the queue, so they say which replies existed when it
     * arrived (I1). receivedAt is when the HTTP server got the request. Tests and the dry run send none.
     */
    turn: (callId, input = {}, { receivedAt = null } = {}) => {
      const call = getCall(callId);
      const arrival = { arrivedAfter: call.lastFinishedTurn };
      if (Number.isFinite(receivedAt)) arrival.afterReplyMs = Math.round(receivedAt - call.lastFinishedAt);
      return enqueue(call, () => runTurn(call, input, Object.freeze(arrival)));
    },
    logGap: (callId, { turn, gapMs, source, muted, played }) => {
      const call = getCall(callId);
      // One gap per reply the line finished, so a client can't add gaps to pull the median down (Test 4).
      if (!(turn >= 1)) throw new GapRefused(400, 'The greeting has no gap.');
      if (turn > call.lastFinishedTurn) throw new GapRefused(409, 'That reply is not finished yet.');
      if (call.gapTurns.has(turn)) throw new GapRefused(409, 'A gap for that turn was already logged.');
      call.gapTurns.add(turn);
      // muted is the mute switch alone. played is false when the reply was cut off or failed before it began.
      log(call, { type: 'gap', turn, gapMs, source, browser: call.browser, muted: Boolean(muted), ...(typeof played === 'boolean' ? { played } : {}) });
      return { ok: true };
    },
    end: async (callId, reason = 'client') => {
      const call = getCall(callId);
      await enqueue(call, () => endCall(call, reason));
      return { ok: true, state: stateFor(call) };
    },
    get: (callId) => {
      const call = getCall(callId);
      return { ...stateFor(call), events: ledger.byCall(call.id).map(projectEvent) };
    },
    sweep,
  };
}
