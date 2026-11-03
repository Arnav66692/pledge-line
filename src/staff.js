// The morning-after staff view: every call in the ledger, what PayPal changed, and the receipt behind each sentence.
// Pure functions over ledger events, so the list, the detail and pilot-check all read the same record. Each event is
// rebuilt from an allowlist of fields, so a field the ledger gains later never reaches the page by accident. The PIN,
// digits from PIN turns, a full email, token ids, user agents and raw snapshots never leave the server.
import { createHash, timingSafeEqual } from 'node:crypto';
import { buildReceipts, receiptOptions } from './receipt.js';
import { maskPinText, textHasPin } from './numbers.js';
import { looksLikeEmail } from './call.js';

// The newest calls the list shows. A night of calls is a few dozen, and each row runs the facts check once.
export const STAFF_LIST_MAX = 200;
const AT_SIGNS = /[@＠﹫]/;
// A spoken "at" between two words, as in "bob at gmail com", once speech to text drops the "dot". It hides some plain
// turns too, such as "look at it", which is fine for a staff log.
const SPOKEN_AT = /\S+\s*(?:\bat\b|\(at\)|\[at\])\s*\S+/i;
const EMAIL_TOKEN = /[^\s@＠﹫]+\s*[@＠﹫]\s*[^\s@＠﹫]+/g;
export const HIDDEN_PIN = 'PIN entry, hidden';
export const HIDDEN_EMAIL = 'an email address, hidden';

// The fields each event type may show, beside type, seq, ts and turn. Anything else is dropped.
const FIELDS = Object.freeze({
  call_start: ['script', 'browser', 'engine', 'mode', 'timeZone', 'orgName', 'subscriptionId', 'templates', 'dryRun'],
  heard: ['source', 'answering', 'arrivedAfter', 'afterReplyMs'],
  route: ['intent', 'amountDollars', 'latencyMs', 'model', 'error'],
  read: ['what', 'id', 'status', 'debugId', 'ms', 'notFound', 'error'],
  proposed: ['pendingId', 'kind', 'targetId', 'origin'],
  yes: ['pendingId'],
  no: ['pendingId'],
  withdrawn: ['pendingId'],
  expired: ['pendingId'],
  write: ['kind', 'targetId', 'ok', 'debugId', 'ms', 'error', 'httpStatus'],
  staging_write: ['kind', 'id', 'ok', 'debugId', 'ms', 'error'],
  refused: ['reason'],
  said: ['facts', 'claims', 'ms', 'repeats'],
  gap: ['gapMs', 'source', 'muted', 'played'],
  call_end: ['reason'],
});

/** The key check. Both sides are hashed first, so the buffers are always equal length and the key's length never shows. */
export function staffKeyMatches(given, expected) {
  if (typeof expected !== 'string' || expected === '' || typeof given !== 'string' || given === '') return false;
  const digest = (value) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * Words the caller said, with any PIN masked. A turn with any email form in it is hidden whole, since a spoken one, as in
 * "bob at gmail dot com", has no clean edge to cut at. The line refused that email, and its own reply says so.
 */
function callerText(text, pin) {
  const raw = String(text ?? '');
  const masked = textHasPin(raw, pin) ? maskPinText(raw) : raw;
  return looksLikeEmail(masked) || AT_SIGNS.test(masked) || SPOKEN_AT.test(masked) ? `(${HIDDEN_EMAIL})` : masked;
}

/** Words the line said. They come from templates, which read the email on file masked, so only a stray @ form is hidden. */
const lineText = (text) => String(text ?? '').replace(EMAIL_TOKEN, `(${HIDDEN_EMAIL})`);

/** The turns where the caller was entering the PIN: every heard turn before pin_ok, and every keypad turn. */
function pinTurns(events) {
  const verifiedAt = events.find((e) => e.type === 'pin_ok')?.seq ?? Infinity;
  return new Set(events.filter((e) => e.type === 'heard' && (e.seq < verifiedAt || e.source === 'keypad')).map((e) => e.seq));
}

function pick(event, names) {
  const out = {};
  for (const name of names) if (Object.hasOwn(event, name) && event[name] !== undefined) out[name] = event[name];
  return out;
}

/** One event as the staff view shows it, rebuilt from the allowlist. */
export function projectStaffEvent(event, { pin = null, pinSeqs = new Set() } = {}) {
  const base = { type: event.type, seq: event.seq ?? null, ts: event.ts ?? null, ...(Number.isInteger(event.turn) ? { turn: event.turn } : {}) };
  const shown = { ...base, ...pick(event, FIELDS[event.type] ?? []) };
  if (event.type === 'heard') shown.text = pinSeqs.has(event.seq) ? `(${HIDDEN_PIN})` : callerText(event.text, pin);
  if (event.type === 'yes' || event.type === 'no') shown.text = callerText(event.text, pin);
  if (event.type === 'said' || event.type === 'proposed') shown.text = lineText(event.type === 'said' ? event.text : event.readBack);
  if (event.type === 'said') shown.facts = (shown.facts ?? []).map((f) => ({ kind: f.kind, value: lineText(f.value), source: f.source }));
  return shown;
}

const countVerdicts = (receipts) => {
  const counts = { proven: 0, plain: 0, blocked: 0 };
  for (const receipt of receipts) for (const s of receipt.sentences) if (Object.hasOwn(counts, s.verdict)) counts[s.verdict] += 1;
  return counts;
};

const unique = (values) => [...new Set(values)];
const latestRead = (events, what) => events.filter((e) => e.type === 'read' && e.what === what).at(-1) ?? null;

function paypalNow(events) {
  const sub = latestRead(events, 'subscription');
  const inv = latestRead(events, 'invoice');
  const statusOf = (read) => (read ? (read.notFound ? 'NOT_FOUND' : read.status ?? null) : null);
  return {
    subscription: sub ? { id: sub.id ?? null, status: statusOf(sub), debugId: sub.debugId ?? null, ts: sub.ts ?? null } : null,
    invoice: inv ? { id: inv.id ?? null, status: statusOf(inv), debugId: inv.debugId ?? null, ts: inv.ts ?? null } : null,
  };
}

const writesOf = (events) => events.filter((e) => e.type === 'write' || e.type === 'staging_write').map((e) => ({
  kind: e.kind, ok: Boolean(e.ok), debugId: e.debugId ?? null, staging: e.type === 'staging_write', ts: e.ts ?? null,
  ...(Number.isInteger(e.httpStatus) ? { httpStatus: e.httpStatus } : {}),
}));

/** One row of the list, from one call's events, oldest first. The receipts are the ones the line and pilot-check build. */
export function summarizeCall(events, config, receipts = buildReceipts(events, receiptOptions(config))) {
  const start = events.find((e) => e.type === 'call_start') ?? {};
  const end = events.findLast((e) => e.type === 'call_end') ?? null;
  const mode = start.mode ?? {};
  return {
    callId: start.callId ?? events[0]?.callId ?? null,
    started: start.ts ?? null,
    ended: end?.ts ?? null,
    endReason: end?.reason ?? null,
    script: Number.isInteger(start.script) ? start.script : null,
    kind: Number.isInteger(start.script) ? 'script' : 'free',
    browser: start.browser ?? 'other',
    verified: events.some((e) => e.type === 'pin_ok'),
    locked: events.some((e) => e.type === 'pin_locked'),
    intents: unique(events.filter((e) => e.type === 'route' && typeof e.intent === 'string').map((e) => e.intent)),
    writes: writesOf(events),
    refusals: unique(events.filter((e) => e.type === 'refused').map((e) => e.reason)),
    paypalNow: paypalNow(events),
    counts: countVerdicts(receipts),
    callback: events.some((e) => e.type === 'staff_callback'),
    dryRun: start.dryRun === true,
    mock: mode.paypal === 'mock' || mode.router === 'rules',
  };
}

/** Every call in the ledger, newest first, at most STAFF_LIST_MAX. */
export function staffCalls(ledger, config) {
  const starts = ledger.byType('call_start').sort((a, b) => b.seq - a.seq).slice(0, STAFF_LIST_MAX);
  return starts.map((start) => summarizeCall(ledger.byCall(start.callId), config));
}

/** One call's row, its receipts and its events, or null when the ledger has no such call. */
export function staffCall(ledger, callId, config) {
  const events = ledger.byCall(callId).sort((a, b) => a.seq - b.seq);
  if (!events.some((e) => e.type === 'call_start')) return null;
  const pinSeqs = pinTurns(events);
  const receipts = buildReceipts(events, receiptOptions(config));
  return {
    ...summarizeCall(events, config, receipts),
    receipts,
    events: events.map((e) => projectStaffEvent(e, { pin: config.pin, pinSeqs })),
  };
}
