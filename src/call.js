import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import * as say from './say.js';
import { parseAmountDollars } from './router.js';
import { spokenDigits, maskPinText, textHasPin } from './numbers.js';
import { isClearYes, isClearNo, isAcknowledgment, normalize, describeError } from './gate.js';
import { toSnapshot, PayPalError } from './paypal.js';

export { maskPinText };

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
// "x@y", "x at y dot z" and "x at y.z". NFKC first, so a full-width or small @ counts as @.
const EMAIL_PATTERNS = [
  /[^\s@]+@[^\s@]+/g,
  /\bat\s+[a-z0-9.-]+(?:\s+[a-z0-9.-]+){0,3}\s+(?:dot|period)\s+[a-z]{2,}\b/gi,
  /\bat\s+[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi,
];

export class CallNotFound extends Error {
  constructor() {
    super('No such call');
    this.name = 'CallNotFound';
  }
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The digits of a PIN typed or said, including "twenty four sixty eight" and "thirteen fourteen". */
export function parsePinDigits(text) {
  return spokenDigits(text);
}

// "bob (at) gmail (dot) com" reads like "bob at gmail dot com".
const emailText = (text) => String(text ?? '').normalize('NFKC').replace(/\(\s*(at|dot)\s*\)/gi, ' $1 ');

export function looksLikeEmail(text) {
  const prepared = emailText(text);
  return EMAIL_PATTERNS.some((pattern) => new RegExp(pattern.source, pattern.flags.replace('g', '')).test(prepared));
}

const stripEmails = (text) => EMAIL_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, ' '), emailText(text));

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

  async function readGift(ctx) {
    const { call } = ctx;
    const subId = config.demoSubscriptionId;
    if (!subId) return { sub: null };
    const hint = call.plan ? null : config.demoPlanId;
    const [sub, hinted] = await timed(ctx, () => Promise.all([
      readSnapshot(ctx, 'subscription', subId),
      hint ? readSnapshot(ctx, 'plan', hint).catch(() => null) : Promise.resolve(null),
    ]));
    if (!sub) return { sub: null };
    if (hinted && hinted.id === sub.plan_id) call.plan = hinted;
    if (sub.plan_id && call.plan?.id !== sub.plan_id) {
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
    if (!(amount > 0)) return say.combine(say.otherEmail(), 'If you would like to give a one-time gift to the email on file, tell me the amount.');
    return say.combine(say.otherEmail(), await oneTimeTurn(ctx, amount));
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

  // A proposal that expired or was set aside is never read out again as if it still waited for a yes.
  const repeatLast = (call) => (call.lastSaidPending && call.lastSaidPending !== call.pending?.id ? say.nothingPending() : say.repeat(call.lastSaid));

  async function handleIntent(ctx, routed, text) {
    const { call } = ctx;
    switch (routed.intent) {
      case 'gift_status': return giftStatusTurn(ctx);
      case 'stop_gift': return stopGiftTurn(ctx);
      case 'cancel_now': return cancelTurn(ctx);
      case 'pause_gift': return pauseTurn(ctx);
      case 'resume_gift': return resumeTurn(ctx);
      // The router's amount only. When it heard none, the line asks, rather than reading another number in the turn as one.
      case 'one_time_gift': return oneTimeTurn(ctx, routed.amountDollars);
      case 'other_email': return otherEmailTurn(ctx, text, routed.amountDollars);
      case 'help': return say.help();
      case 'repeat': return repeatLast(call);
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
    const approval = gate.approve(call, text, ctx.turn, ctx.answering);
    if (!approval) return call.pending ? askAgain(ctx) : say.nothingPending();
    const { pending } = approval;
    const writer = (id, token) => paypal[WRITER_METHODS[pending.kind]](id, token, { callId: call.id });
    const result = await timed(ctx, () => gate.execute(call, approval, writer, ctx.turn));
    try {
      if (pending.kind === 'send_invoice') {
        if (result.ok) call.openDraftId = null;
        const inv = await rereadUntil(ctx, () => readSnapshot(ctx, 'invoice', pending.targetId), (s) => !result.ok || (s !== null && s.status !== 'DRAFT'));
        return say.afterWrite('send_invoice', inv, null, { ok: result.ok });
      }
      const expected = EXPECTED_STATUS[pending.kind];
      const sub = await rereadUntil(ctx, () => readSnapshot(ctx, 'subscription', pending.targetId), (s) => !result.ok || s?.status === expected);
      return say.afterWrite(pending.kind, sub, call.plan, { ok: result.ok });
    } catch (error) {
      if (!(error instanceof PayPalError)) throw error;
      // I8: never claim a status PayPal did not return.
      return say.afterWrite(pending.kind, null, call.plan, { ok: result.ok });
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
    if (looksLikeEmail(text)) {
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
    // Anything else moves past the proposal, so it is dropped and a later yes can never approve it.
    await dropPending(ctx);
    const reply = await handleIntent(ctx, routed, text);
    return call.pending ? reply : say.combine(say.setAside(), reply);
  }

  async function freeTurn(ctx, text) {
    if (isBareYesOrNo(text) || isAcknowledgment(text)) return say.nothingPending();
    if (looksLikeEmail(text)) return otherEmailTurn(ctx, text);
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

  async function runTurn(call, { text, source, answering }) {
    const started = performance.now();
    const clean = typeof text === 'string' ? text.trim() : '';
    call.turn += 1;
    // answering is the turn of the last reply the caller's client received. A yes must answer the reply that asked (I6).
    const ctx = { call, turn: call.turn, source: normalizeSource(source), answering: Number.isInteger(answering) ? answering : null,
      routerMs: 0, paypalMs: 0, empathy: null, notice: null, pinShown: false };
    call.lastActiveAt = now().getTime();
    let reply;
    if (clean.length > limits.maxTextChars) {
      refused(ctx, 'too_long');
      reply = say.tooLong();
    } else {
      // I4: mask while waiting for the PIN, on keypad turns, and whenever the PIN shows up later.
      const hidePin = !call.verified || ctx.source === 'keypad' || textHasPin(clean, config.pin);
      const heardText = hidePin ? maskPinText(clean) : clean;
      log(call, { type: 'heard', turn: ctx.turn, text: heardText, source: ctx.source, answering: ctx.answering });
      ctx.pinShown = call.verified && hidePin;
      reply = await dispatch(ctx, call.verified ? heardText : clean);
    }
    const full = say.combine(ctx.empathy, ctx.notice, reply);
    const serverMs = Math.round(performance.now() - started);
    log(call, { type: 'said', turn: ctx.turn, text: full.text, facts: full.facts, ms: serverMs });
    call.lastSaid = full;
    call.lastSaidPending = call.pending?.id ?? null;
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
      pinTries: 0, turn: 0, pending: null, pauseOffered: false, openDraftId: null, lastSaid: null, lastSaidPending: null, ended: false, endedAt: null,
      noticeExpired: false, lastActiveAt: now().getTime(), plan: null, record: { subscription: null, invoice: null }, queue: Promise.resolve(),
    };
    calls.set(call.id, call);
    log(call, {
      type: 'call_start', script: call.script, userAgent: String(userAgent ?? '').slice(0, USER_AGENT_MAX), client: signals, engine: engineOf(signals),
      browser: call.browser, mode: { paypal: config.paypal.mode, router: config.router.mode }, timeZone: config.timeZone, ...(dryRun ? { dryRun: true } : {}),
    });
    const reply = say.greeting(config.orgName);
    log(call, { type: 'said', turn: 0, text: reply.text, facts: reply.facts, ms: 0 });
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
    turn: (callId, input = {}) => {
      const call = getCall(callId);
      return enqueue(call, () => runTurn(call, input));
    },
    logGap: (callId, { turn, gapMs, source, muted, played }) => {
      const call = getCall(callId);
      // muted is the mute switch alone. played is false when the reply was cut off or failed before it began.
      log(call, { type: 'gap', turn, gapMs, source, browser: call.browser, muted: Boolean(muted), ...(typeof played === 'boolean' ? { played } : {}) });
      return { ok: true };
    },
    end: async (callId, reason = 'client') => {
      const call = getCall(callId);
      await enqueue(call, () => endCall(call, reason));
      return { ok: true };
    },
    get: (callId) => {
      const call = getCall(callId);
      return { ...stateFor(call), events: ledger.byCall(call.id).map(projectEvent) };
    },
    sweep,
  };
}
