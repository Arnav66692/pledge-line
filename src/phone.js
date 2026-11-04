// A real phone number for the line. Twilio posts a webhook for each thing the caller does, and this file turns each one
// into a turn in call.js, then speaks what call.js returned as TwiML. No words are written here, so the gate, the
// templates and the grader are the same as in the browser. TWILIO-SETUP.md has the steps and the prices.
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const VOICE_PATH = '/phone/voice';
const TURN_PATH = '/phone/turn';
const STATUS_PATH = '/phone/status';
export const PHONE_PATHS = Object.freeze([VOICE_PATH, TURN_PATH, STATUS_PATH]);

export const TWIML_TYPE = 'text/xml; charset=utf-8';
const OVER = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);
// Twilio gives a voice webhook 15 seconds. A turn still running at this point gets a silent hold, not a dropped call.
export const TURN_BUDGET_MS = 11000;
const HOLD_BUDGET_MS = 6000;
const HOLD_PAUSE_SECONDS = 2;
// Below this Twilio's own transcript isn't sure of the words, so they are treated as not caught. A guess, not measured.
// Twilio may send no score, and a zero is read the same way, as no score, so a provider that doesn't score still works.
const MIN_CONFIDENCE = 0.5;
const DIGITS_MAX = 32;
const SESSION_MAX_AGE_MS = 3600000;
const SESSIONS_MAX = 2000;
const CALLER_KEY_CHARS = 32;
const CALL_KEY_BYTES = 16;

// How long the line waits, in seconds. A proposal gets a fixed speech pause, not auto, which stops at the first pause,
// so "yes... wait, no" reaches the gate whole and is not a yes. A PIN said aloud gets time between its digits.
const WAIT_PROPOSAL = Object.freeze({ timeout: 8, speechTimeout: 2 });
const WAIT_PIN = Object.freeze({ timeout: 5, speechTimeout: 3 });
const WAIT_FREE = Object.freeze({ timeout: 6, speechTimeout: 'auto' });

/** The X-Twilio-Signature for a URL and its form fields: HMAC-SHA1 of the URL plus each sorted name and value, in base64. */
export function twilioSignature(authToken, url, params) {
  const names = Object.keys(params).sort();
  const data = names.reduce((acc, name) => {
    const values = Array.isArray(params[name]) ? [...new Set(params[name])].sort() : [params[name]];
    return acc + values.map((value) => `${name}${value}`).join('');
  }, url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

/** Both sides are hashed first, so the buffers are equal length and a wrong signature's length never shows. */
export function signatureMatches(authToken, url, params, given) {
  if (typeof authToken !== 'string' || authToken === '' || typeof given !== 'string' || given === '') return false;
  const digest = (value) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(twilioSignature(authToken, url, params)), digest(given));
}

/**
 * The URL Twilio signed, from the configured public address and the raw path and query, never from a Host header a
 * proxy or a caller could change. Render ends TLS and forwards plain http inside, so the request itself can't say it.
 * Twilio drops the port from an https voice callback before it signs, so a stated port is dropped here too.
 */
export function signedUrl(publicBaseUrl, rawUrl) {
  const base = new URL(publicBaseUrl);
  if (base.protocol === 'https:') base.port = '';
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}${rawUrl}`;
}

/** Form fields, a name sent twice kept as a list, as Twilio's own signature check reads them. */
export function formFields(rawBody) {
  const fields = {};
  for (const [name, value] of new URLSearchParams(Buffer.from(rawBody).toString('utf8'))) {
    if (Object.hasOwn(fields, name)) fields[name] = [].concat(fields[name], value);
    else fields[name] = value;
  }
  return fields;
}

const single = (value) => (Array.isArray(value) ? value[0] : value);
const xml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const doc = (inner = '') => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

/** What the caller gave Twilio: digits, words, or nothing. A transcript Twilio is unsure of counts as nothing. */
export function callerInput(fields) {
  const digits = String(single(fields.Digits) ?? '').replace(/[^0-9]/g, '').slice(0, DIGITS_MAX);
  if (digits) return { text: digits, source: 'keypad', silent: false };
  const speech = String(single(fields.SpeechResult) ?? '').trim();
  const score = Number(single(fields.Confidence));
  const unsure = Number.isFinite(score) && score > 0 && score < MIN_CONFIDENCE;
  if (speech && !unsure) return { text: speech, source: 'voice', silent: false };
  return { text: '', source: 'voice', silent: true };
}

function waitFor(state) {
  if (state.pending) return WAIT_PROPOSAL;
  return state.verified ? WAIT_FREE : WAIT_PIN;
}

export function createPhoneLine({ config, calls, log, monotonic = () => performance.now(), allowCall = () => true, budgetMs = TURN_BUDGET_MS, holdBudgetMs = HOLD_BUDGET_MS, wallClock = () => Date.now() }) {
  const sessions = new Map();
  const { voice, authToken } = config.phone;
  const urlFor = (path) => signedUrl(config.publicBaseUrl, path);
  const turnUrl = (turn, callKey) => urlFor(`${TURN_PATH}?turn=${turn}&call=${callKey}`);

  const say = (text) => `<Say voice="${xml(voice)}">${xml(text)}</Say>`;

  /**
   * The line's reply as TwiML. The rule that matters is where the <Say> goes. While a proposal waits for a yes it sits
   * before an empty <Gather>, so the line isn't listening until the whole read-back has been spoken, and a yes said over
   * it is never heard (I1, I6). Everything else sits inside the <Gather>, so a caller can key the PIN over the greeting.
   * The action URL names the turn being answered, Twilio signs it, and it keys the retry cache. It also carries this
   * call's random key, so a signed webhook saved from before a restart can't walk a new call through the PIN and a yes.
   */
  function twimlFor({ reply, turn, state }, callKey) {
    if (state.ended || state.locked) return doc(`${say(reply)}<Hangup/>`);
    const action = xml(turnUrl(turn, callKey));
    const { timeout, speechTimeout } = waitFor(state);
    const attrs = `input="dtmf speech" action="${action}" method="POST" timeout="${timeout}" speechTimeout="${speechTimeout}" language="en-US" finishOnKey="#" actionOnEmptyResult="true"`;
    // Without hints, since a hint of "yes" would pull an unclear word toward the one word that changes something.
    const gather = state.pending ? `${say(reply)}<Gather ${attrs}/>` : `<Gather ${attrs}>${say(reply)}</Gather>`;
    return doc(`${gather}<Redirect method="POST">${action}</Redirect>`);
  }

  /** Forgets calls long over. A webhook for one after that starts a new call, and a new call needs the PIN again. */
  function prune() {
    const cutoff = wallClock() - SESSION_MAX_AGE_MS;
    for (const [sid, session] of sessions) if (session.lastSeen < cutoff) sessions.delete(sid);
    while (sessions.size >= SESSIONS_MAX) sessions.delete(sessions.keys().next().value);
  }

  // Keyed with the auth token, so the short list of US phone numbers can't be hashed to find one. Held in memory only.
  const callerKey = (from) => `phone:${createHmac('sha256', authToken).update(String(from ?? 'unknown')).digest('hex').slice(0, CALLER_KEY_CHARS)}`;

  function startCall(fields) {
    const sid = String(single(fields.CallSid) ?? '');
    const key = callerKey(single(fields.From));
    if (!allowCall(key)) {
      log.info('phone call turned away, over the hourly limit');
      // As the first verb, this leaves the call unanswered and unbilled.
      return { twiml: doc('<Reject reason="busy"/>') };
    }
    prune();
    const started = calls.start({ channel: 'phone', phoneSid: sid, userAgent: 'twilio', clientKey: key });
    const callKey = randomBytes(CALL_KEY_BYTES).toString('hex');
    const session = { callId: started.callId, callKey, results: new Map(), startTwiml: twimlFor(started, callKey), lastSeen: wallClock() };
    sessions.set(sid, session);
    return { twiml: session.startTwiml };
  }

  /** The call over, once. A hang-up also deletes any draft left open and sets aside any proposal, as call.js does on every end. */
  async function endSession(sid, reason) {
    const session = sessions.get(sid);
    if (!session) return;
    try {
      await calls.end(session.callId, reason);
    } catch (error) {
      log.error(`phone end failed ${error?.name ?? 'Error'}`);
    }
  }

  /** One turn, once for a CallSid and turn number however many times Twilio posts it. */
  function runOnce(session, sid, turn, fields, receivedAt) {
    const key = String(turn);
    if (session.results.has(key)) return session.results.get(key);
    const { text, source, silent } = callerInput(fields);
    // In a new Promise, so a call the sweep already forgot ends in the catch below and not in a JSON error Twilio would read out.
    const run = new Promise((resolve) => { resolve(calls.turn(session.callId, { text, source, silent, answering: turn }, { receivedAt, spoken: true })); })
      .then((result) => twimlFor(result, session.callKey))
      .catch(async (error) => {
        // Only the name, since a message could hold what the caller said. The call ends rather than speak words of ours.
        log.error(`phone turn failed ${error?.name ?? 'Error'}`);
        await endSession(sid, 'phone_error');
        return doc('<Hangup/>');
      });
    session.results.set(key, run);
    return run;
  }

  /** The turn's TwiML, or a silent hold that comes back for it, so a slow turn doesn't hit Twilio's 15 seconds. */
  async function withinBudget(run, turn, callKey, wait) {
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), wait);
      timer.unref?.();
    });
    const done = await Promise.race([run, late]);
    clearTimeout(timer);
    if (done !== null) return done;
    log.info('phone turn on hold');
    return doc(`<Pause length="${HOLD_PAUSE_SECONDS}"/><Redirect method="POST">${xml(`${turnUrl(turn, callKey)}&hold=1`)}</Redirect>`);
  }

  async function voiceHook(fields) {
    const sid = String(single(fields.CallSid) ?? '');
    if (OVER.has(single(fields.CallStatus))) {
      await endSession(sid, 'hangup');
      return { status: 200, twiml: doc() };
    }
    const session = sessions.get(sid);
    if (session) {
      session.lastSeen = wallClock();
      return { status: 200, twiml: session.startTwiml };
    }
    return { status: 200, twiml: startCall(fields).twiml };
  }

  async function turnHook(fields, query, receivedAt) {
    const sid = String(single(fields.CallSid) ?? '');
    const turn = Number(query.get('turn'));
    if (!Number.isInteger(turn) || turn < 0) return { status: 400, twiml: doc() };
    // Twilio can post a last result after the caller hung up. Those words never count.
    if (OVER.has(single(fields.CallStatus))) {
      await endSession(sid, 'hangup');
      return { status: 200, twiml: doc() };
    }
    const session = sessions.get(sid);
    // A restart loses the calls in memory, so whatever this webhook carries, a yes or a PIN, starts over with the greeting.
    if (!session) return { status: 200, twiml: startCall(fields).twiml };
    session.lastSeen = wallClock();
    // Signed, but not for this call as it now stands, so it is a saved webhook or one from before a restart. Never a turn.
    if (query.get('call') !== session.callKey) return { status: 200, twiml: session.startTwiml };
    const run = runOnce(session, sid, turn, fields, receivedAt);
    return { status: 200, twiml: await withinBudget(run, turn, session.callKey, query.has('hold') ? holdBudgetMs : budgetMs) };
  }

  async function statusHook(fields) {
    if (OVER.has(single(fields.CallStatus))) await endSession(String(single(fields.CallSid) ?? ''), 'hangup');
    return { status: 204, twiml: '' };
  }

  return {
    /** Checks the signature against the exact URL Twilio signed, before anything in the body is used. */
    verified: (rawUrl, fields, signature) => signatureMatches(authToken, signedUrl(config.publicBaseUrl, rawUrl), fields, signature),
    /** One signed webhook. Nothing here logs a field of the body, so the PIN and the caller's number stay out of the logs. */
    handle(pathname, query, fields, receivedAt = monotonic()) {
      if (pathname === VOICE_PATH) return voiceHook(fields);
      if (pathname === TURN_PATH) return turnHook(fields, query, receivedAt);
      return statusHook(fields);
    },
  };
}
