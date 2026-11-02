import { randomUUID } from 'node:crypto';
import { WriteNotAuthorized } from './paypal.js';

const MAX_YES_WORDS = 8;
// A clear yes starts like one of these, the wording SPEC.md gives. A bare "okay" or "please" is only an
// acknowledgment, so the line asks for a clear yes or no instead (a cancel can't be undone, a re-ask costs seconds).
const YES_STARTS = ['yes', 'yeah', 'yep', 'yup', 'sure', 'correct', 'please do', 'go ahead', 'do it', "that's right", 'that is right', 'confirm'];
// Fillers that may come before a yes, as in "okay, go ahead". They never count as a yes by themselves.
const LEAD_FILLERS = /^(?:(?:ok|okay|alright|all right|so|um|uh|well)(?: |$))+/;
const ACKNOWLEDGMENTS = new Set(['ok', 'okay', 'alright', 'all right', 'please', 'thanks', 'thank you', 'ok thanks', 'okay thanks', 'ok thank you', 'okay thank you', 'got it', 'okay got it', 'i see', 'okay i see', 'mm hmm', 'uh huh', 'right', 'okay please']);
// Phrases that count as one approving word. Their words are not allowed on their own, so "is that right" is not a yes.
const YES_PHRASES = ['that is right', "that's right", 'go ahead', 'please do', 'do it', 'do that', 'thank you', "i'm sure", 'i am sure']
  .map((phrase) => new RegExp(`(^| )${phrase}(?= |$)`, 'g'));
// Every other word must come from this list. A question, a delay, a new detail or a second action is never a yes.
const YES_WORDS = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'correct', 'ok', 'okay', 'confirm', 'confirmed', 'please', 'thanks', 'it', 'now']);
// The one action word each pending kind may repeat back, as in "yes, pause it".
const KIND_WORDS = Object.freeze({ suspend: ['pause', 'suspend'], activate: ['restart', 'resume', 'unpause', 'reactivate'], cancel: ['cancel'], send_invoice: ['send'] });
const QUESTION_MARK = /[?\uFF1F\u00BF]/;
const NO_STARTS = ['no', 'nope', 'nah', "don't", 'dont', 'do not', 'not now', 'never mind', 'nevermind', 'keep it', 'leave it'];
const CURLY_QUOTES = /[\u2018\u2019`]/g;
const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;
const MASKED_DIGIT = '#';

/**
 * normalize drops what it cannot read, so text it would change is refused before it can count as a yes.
 * A question mark from another script, a word in another script, a look-alike letter or a # left by the
 * PIN mask never quietly vanishes from a yes (I1). A refusal only costs a re-ask.
 */
function isPlainText(text) {
  const raw = String(text ?? '');
  return PRINTABLE_ASCII.test(raw.replace(CURLY_QUOTES, "'")) && !raw.includes(MASKED_DIGIT);
}

export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/(^|\s)'+|'+(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const startsWithPhrase = (norm, phrase) => norm === phrase || norm.startsWith(`${phrase} `);
const withoutPhrases = (norm) => YES_PHRASES.reduce((acc, pattern) => acc.replace(pattern, '$1'), norm).split(' ').filter(Boolean);

/**
 * Clear yes for the pending kind. It starts like a yes, has at most eight words, has no question mark,
 * and every word is a plain yes word or the pending action's own verb. Anything else is not a yes,
 * so "please repeat that", "do it later" and "okay, how much is it" never approve a write (I1, I6).
 */
export function isClearYes(text, kind) {
  if (!isPlainText(text) || QUESTION_MARK.test(String(text ?? ''))) return false;
  const full = normalize(text);
  if (full === '' || full.split(' ').length > MAX_YES_WORDS) return false;
  const norm = full.replace(LEAD_FILLERS, '');
  if (!YES_STARTS.some((phrase) => startsWithPhrase(norm, phrase))) return false;
  const allowed = new Set([...YES_WORDS, ...(KIND_WORDS[kind] ?? [])]);
  return withoutPhrases(norm).every((word) => allowed.has(word));
}

/** "Okay", "thanks", "got it" and the like. While an action is pending, the line asks for a clear yes or no. */
export function isAcknowledgment(text) {
  if (!isPlainText(text) || QUESTION_MARK.test(String(text ?? ''))) return false;
  return ACKNOWLEDGMENTS.has(normalize(text));
}

export function isClearNo(text) {
  const norm = normalize(text);
  return norm !== '' && NO_STARTS.some((phrase) => startsWithPhrase(norm, phrase));
}

/** One-time write tokens. Only the gate mints them, every write method consumes one. */
export function createTokens({ now = () => new Date(), ttlMs = 60000 } = {}) {
  const store = new Map();

  function prune(at) {
    for (const [id, record] of store) if (record.expiresAt <= at) store.delete(id);
  }

  function mint({ callId, pendingId, kind, targetId }) {
    const at = now().getTime();
    prune(at);
    const id = randomUUID();
    store.set(id, { callId, pendingId, kind, targetId, expiresAt: at + ttlMs });
    return id;
  }

  function consume(tokenId, { kind, targetId, callId } = {}) {
    if (typeof tokenId !== 'string' || tokenId === '') throw new WriteNotAuthorized('missing');
    const record = store.get(tokenId);
    if (!record) throw new WriteNotAuthorized('unknown_or_used');
    store.delete(tokenId);
    if (now().getTime() >= record.expiresAt) throw new WriteNotAuthorized('expired');
    if (record.kind !== kind) throw new WriteNotAuthorized('wrong_kind');
    if (record.targetId !== targetId) throw new WriteNotAuthorized('wrong_target');
    if (record.callId !== callId) throw new WriteNotAuthorized('wrong_call');
    return record;
  }

  return { mint, consume };
}

export function describeError(error) {
  if (!error) return 'Error';
  const status = Number.isInteger(error.status) && error.status > 0 ? ` ${error.status}` : '';
  const reason = error.reason ? ` ${error.reason}` : '';
  return `${error.name ?? 'Error'}${status}${reason}`;
}

export function createGate({ ledger, tokens, now = () => new Date(), pendingTtlMs = 120000 }) {
  function propose(call, { kind, targetId, readBack, origin, turn }) {
    const createdAt = now().getTime();
    // askedTurn is the last turn whose reply spoke this proposal, the only turn a yes may answer.
    const pending = Object.freeze({ id: randomUUID(), kind, targetId, origin, readBack, turn, askedTurn: turn, createdAt, expiresAt: createdAt + pendingTtlMs });
    call.pending = pending;
    ledger.append({ type: 'proposed', callId: call.id, turn, pendingId: pending.id, kind, targetId, origin, readBack: readBack.text });
    return pending;
  }

  /** Records that this turn's reply spoke the proposal again, so the next turn's yes answers it. */
  function reask(call, turn) {
    if (!call.pending) return null;
    call.pending = Object.freeze({ ...call.pending, askedTurn: turn });
    return call.pending;
  }

  function classify(call, text) {
    if (!call.pending) return 'other';
    if (isClearYes(text, call.pending.kind)) return 'yes';
    if (isClearNo(text)) return 'no';
    return 'other';
  }

  /**
   * answering is the turn of the last reply the caller's client says it received. call.js always passes it,
   * null when the client sent none, so a yes that left the client before the proposal reached it never counts.
   */
  function approve(call, text, turn, answering) {
    const pending = call.pending;
    if (!pending || !call.verified || call.locked || call.ended) return null;
    // I6: the yes has to be its own turn, right after the turn whose reply spoke the proposal or its read-back.
    if (turn !== pending.askedTurn + 1) return null;
    if (answering !== undefined && answering !== pending.askedTurn) return null;
    if (now().getTime() >= pending.expiresAt) return null;
    if (!isClearYes(text, pending.kind)) return null;
    const token = tokens.mint({ callId: call.id, pendingId: pending.id, kind: pending.kind, targetId: pending.targetId });
    ledger.append({ type: 'yes', callId: call.id, turn, pendingId: pending.id, tokenId: token, text });
    return { token, pending };
  }

  function clearWith(call, event) {
    const pending = call.pending;
    if (!pending) return null;
    ledger.append({ ...event, callId: call.id, pendingId: pending.id });
    call.pending = null;
    return pending;
  }

  function expireIfStale(call) {
    if (!call.pending || now().getTime() < call.pending.expiresAt) return null;
    return clearWith(call, { type: 'expired' });
  }

  async function execute(call, approval, writer, turn) {
    const { token, pending } = approval;
    const started = performance.now();
    let outcome;
    try {
      const result = await writer(pending.targetId, token);
      outcome = { ok: true, result, debugId: result?.debugId ?? null };
    } catch (error) {
      outcome = { ok: false, error, debugId: error?.debugId ?? null };
    }
    const ms = Math.round(performance.now() - started);
    const errorText = outcome.ok ? {} : { error: describeError(outcome.error) };
    ledger.append({ type: 'write', callId: call.id, turn, kind: pending.kind, targetId: pending.targetId, tokenId: token, ok: outcome.ok, debugId: outcome.debugId, ms, ...errorText });
    if (call.pending?.id === pending.id) call.pending = null;
    return { ...outcome, ms, kind: pending.kind, targetId: pending.targetId };
  }

  return {
    propose,
    reask,
    classify,
    approve,
    decline: (call, text, turn) => clearWith(call, { type: 'no', turn, text }),
    withdraw: (call, turn) => clearWith(call, { type: 'withdrawn', turn }),
    expireIfStale,
    execute,
  };
}
