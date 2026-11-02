'use strict';

(() => {
  const FINAL_WAIT_MS = 1500;
  const PIN_MAX = 6;
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'number', 'password', 'tel', 'url']);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const ua = navigator.userAgent;
  const isSafari = /Safari\//.test(ua) && /Version\//.test(ua) && !/Chrome|CriOS|Edg|FxiOS|Firefox/.test(ua);
  const canSpeak = 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';

  const $ = (id) => document.getElementById(id);
  const els = {
    script: $('script'), lines: $('script-lines'), start: $('start'), mute: $('mute'), status: $('status'),
    reply: $('reply'), transcript: $('transcript'), talk: $('talk'), speechError: $('speech-error'),
    pinDots: $('pin-dots'), pinClear: $('pin-clear'), pinSend: $('pin-send'), keys: document.querySelectorAll('.key[data-digit]'),
    typed: $('typed'), typedForm: $('typed-form'), typedText: $('typed-text'), typedSend: $('typed-send'),
    gapLast: $('gap-last'), gapMedian: $('gap-median'), pending: $('pending'), pendingLabel: $('pending-label'), pendingExpiry: $('pending-expiry'),
    subStatus: $('sub-status'), subAmount: $('sub-amount'), subNext: $('sub-next'), subDebug: $('sub-debug'),
    invNumber: $('inv-number'), invStatus: $('inv-status'), invAmount: $('inv-amount'), invDebug: $('inv-debug'), invLink: $('inv-link'),
    events: $('events'),
  };

  const LABELS = { suspend: 'pausing the monthly gift', activate: 'restarting the monthly gift', cancel: 'cancelling the monthly gift', send_invoice: 'sending the one-time gift invoice' };
  const REASONS = {
    other_email: 'the line only sends to the email on file', locked: 'the call is locked', ended: 'the call has ended',
    not_verified: 'the PIN comes first', amount_out_of_range: 'that amount is outside the limits', no_subscription: 'no monthly gift was found',
    too_long: 'that was too long', turn_limit: 'the call reached its limit', pin_limit: 'there were too many wrong PINs from here',
  };
  const SPEECH_ERRORS = {
    'not-allowed': 'The browser blocked the microphone. Allow it in the site settings, or type instead.',
    'service-not-allowed': isSafari
      ? 'Speech input in Safari needs Siri. Turn on Siri in System Settings, then reload, or type instead.'
      : 'Speech input is turned off in this browser. Please type instead.',
    'no-speech': "I didn't hear anything. Hold the button while you speak, or type instead.",
    network: 'Speech input needs a network connection. Try again, or type instead.',
    'audio-capture': 'No microphone was found. Please type instead.',
  };

  // lastTurn is the turn of the last reply this page received. Each turn says it answers that reply, so a yes only counts for a proposal the caller heard.
  const state = { callId: null, verified: false, ended: true, locked: false, busy: false, pin: '', scripts: [], primed: false, voiceGaps: [], listening: null, lastTurn: 0 };

  // Engine signals a user-agent override, such as Chrome's device toolbar, does not change. The line checks them against the agent.
  const engineSignals = () => ({ vendor: String(navigator.vendor || ''), chrome: typeof window.chrome !== 'undefined', uaData: 'userAgentData' in navigator });

  async function api(path, body) {
    const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const res = await fetch(path, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'The line could not answer. Please try again.');
    return data;
  }

  const isMuted = () => els.mute.checked || !canSpeak;
  // A locked call still takes words, so the caller can hear that it is locked (Script 8).
  const canSend = () => Boolean(state.callId) && (!state.ended || state.locked);
  const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  };

  function shownText(text, source) {
    if (source === 'keypad') return '•'.repeat(Math.min(text.length, PIN_MAX));
    return state.verified ? text : text.replace(/\d/g, '•');
  }

  // ---- Script picker ----

  function renderLines(number = els.script.value) {
    els.lines.replaceChildren();
    const script = state.scripts.find((s) => String(s.number) === String(number));
    const lines = script ? script.lines : ['Enter your PIN on the keypad, then ask about your monthly gift.'];
    for (const line of lines) {
      const item = document.createElement('li');
      item.textContent = line;
      els.lines.append(item);
    }
    if (script) {
      const item = document.createElement('li');
      item.className = 'expected';
      item.textContent = `Expected. ${script.expected}.`;
      els.lines.append(item);
    }
  }

  async function loadScripts() {
    try {
      const { scripts } = await api('/api/pilot-scripts');
      state.scripts = scripts;
      for (const script of scripts) {
        const option = document.createElement('option');
        option.value = String(script.number);
        option.textContent = `Script ${script.number}, ${script.title}`;
        els.script.append(option);
      }
    } catch {
      state.scripts = [];
    }
    renderLines();
  }

  // ---- Speech out ----

  function prime() {
    if (state.primed || !canSpeak) return;
    state.primed = true;
    const warm = new SpeechSynthesisUtterance(' ');
    warm.volume = 0;
    window.speechSynthesis.speak(warm);
  }

  /** Calls onStart(played) once, with played false when the reply was cut off or failed before it began. */
  function speak(text, onStart) {
    let started = false;
    const fire = (played) => { if (!started) { started = true; onStart(played); } };
    if (isMuted()) { fire(false); return; }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.onstart = () => fire(true);
    // A reply cancelled by barge-in or a speech error before it began never played.
    utterance.onerror = () => fire(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  function stopSpeaking() {
    if (canSpeak) window.speechSynthesis.cancel();
  }

  // ---- Record card and event log ----

  function setText(el, value, fallback) {
    el.textContent = value === null || value === undefined || value === '' ? fallback : String(value);
  }

  function renderRecord(record) {
    const sub = record?.subscription;
    setText(els.subStatus, sub?.notFound ? 'not found' : sub?.status, 'not read yet');
    setText(els.subAmount, sub?.amount, 'not read yet');
    setText(els.subNext, sub?.status === 'ACTIVE' ? sub?.nextDate : null, sub ? 'none' : 'not read yet');
    setText(els.subDebug, sub?.debugId, 'none');
    const inv = record?.invoice;
    setText(els.invNumber, inv?.number, 'none');
    setText(els.invStatus, inv?.status === 'NOT_FOUND' ? 'not found, deleted' : inv?.status, 'none');
    setText(els.invAmount, inv?.amount, 'none');
    setText(els.invDebug, inv?.debugId, 'none');
    els.invLink.replaceChildren();
    if (inv?.recipientViewUrl && /^https:\/\//.test(inv.recipientViewUrl) && inv.status !== 'NOT_FOUND') {
      const link = document.createElement('a');
      link.href = inv.recipientViewUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open the PayPal payer page';
      els.invLink.append(link);
    } else {
      els.invLink.textContent = 'none';
    }
  }

  function renderPending(pending) {
    els.pending.hidden = !pending;
    if (!pending) return;
    els.pendingLabel.textContent = `${pending.label}. Nothing changes in PayPal until you say yes.`;
    const at = new Date(pending.expiresAt);
    els.pendingExpiry.textContent = `This request times out at ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
  }

  function describe(e) {
    const what = LABELS[e.kind] || e.kind;
    switch (e.type) {
      case 'call_start': return 'Call started.';
      case 'heard': return `Heard by ${e.source}, "${e.text}".`;
      case 'pin_ok': return 'PIN accepted.';
      case 'pin_bad': return 'Wrong PIN.';
      case 'pin_locked': return 'Too many wrong PINs, so the call is locked.';
      case 'route': return `Understood as ${String(e.intent).replace(/_/g, ' ')}.`;
      case 'read':
        if (e.notFound) return `Read the ${e.what} from PayPal, which says it is not found.`;
        if (e.error) return `Could not read the ${e.what} from PayPal, ${e.error}.`;
        return `Read the ${e.what} from PayPal${e.status ? `, status ${e.status}` : ''}, debug id ${e.debugId || 'none'}.`;
      case 'proposed': return `Asked for a yes before ${what}.`;
      case 'yes': return 'Heard a clear yes in its own turn, so a one-time write token was issued.';
      case 'no': return 'Heard a no.';
      case 'write': return e.ok ? `PayPal accepted ${what}, debug id ${e.debugId || 'none'}.` : `PayPal did not accept ${what}, ${e.error || 'error'}.`;
      case 'staging_write':
        if (e.kind === 'create_draft') return e.ok ? `Created a private draft invoice, ${e.id}.` : 'Could not create a draft invoice.';
        return e.ok ? `Deleted the draft invoice ${e.id}.` : `Could not delete the draft invoice ${e.id}.`;
      case 'refused': return `Refused, ${REASONS[e.reason] || e.reason}.`;
      case 'expired': return 'The pending request timed out, nothing changed.';
      case 'withdrawn': return 'The pending request was dropped.';
      case 'staff_callback': return 'Noted a request for a staff callback.';
      case 'call_end': return `Call ended, ${e.reason}.`;
      default: return null;
    }
  }

  async function refreshEvents(callId = state.callId) {
    if (!callId) return;
    try {
      const data = await api(`/api/calls/${callId}`);
      els.events.replaceChildren();
      for (const e of [...data.events].reverse()) {
        const text = describe(e);
        if (!text) continue;
        const item = document.createElement('li');
        item.className = `event event-${e.type}`;
        item.textContent = text;
        els.events.append(item);
      }
    } catch {
      // The log is a convenience. The call keeps working without it.
    }
  }

  // ---- Call state ----

  function setControls() {
    const live = Boolean(state.callId) && !state.ended;
    const open = canSend();
    els.talk.disabled = !open || state.busy || !SR;
    els.typedText.disabled = !open;
    els.typedSend.disabled = !open || state.busy;
    els.pinSend.disabled = !live || state.busy;
    els.pinClear.disabled = !live;
    for (const key of els.keys) key.disabled = !live;
    els.start.textContent = live ? 'End call' : 'Start call';
  }

  function applyState(s) {
    state.verified = Boolean(s.verified);
    state.ended = Boolean(s.ended);
    state.locked = Boolean(s.locked);
    if (s.locked) els.status.textContent = 'This call is locked after too many wrong PINs.';
    else if (s.ended) els.status.textContent = 'Call ended. Press Start call for a new one.';
    else if (!s.verified) els.status.textContent = 'Enter your PIN on the keypad, or say its digits.';
    else els.status.textContent = s.script ? `Verified. Running script ${s.script}.` : 'Verified. Ask about your monthly gift.';
    renderPending(s.pending);
    renderRecord(s.record);
    if (state.ended) stopListening();
    setControls();
  }

  function setBusy(busy) {
    state.busy = busy;
    setControls();
  }

  function showError(message) {
    els.speechError.textContent = message;
    els.speechError.hidden = false;
  }

  function hideError() {
    els.speechError.hidden = true;
    els.speechError.textContent = '';
  }

  function openTyped() {
    els.typed.open = true;
  }

  /**
   * muted is the mute switch alone. played is false when the reply was talked over or failed before it began,
   * and the grader then counts that turn as never starting, so a cut-off reply can't make the median look fast.
   */
  function logGap(callId, turn, startedAt, source, muted, played) {
    const gapMs = Math.max(0, Math.round(performance.now() - startedAt));
    els.gapLast.textContent = `${seconds(gapMs)}${muted ? ', muted' : played ? '' : ', the reply never started'}`;
    if (source === 'voice' && !muted && played) {
      state.voiceGaps.push(gapMs);
      els.gapMedian.textContent = `${seconds(median(state.voiceGaps))} over ${state.voiceGaps.length} ${state.voiceGaps.length === 1 ? 'turn' : 'turns'}`;
    }
    api(`/api/calls/${callId}/gap`, { turn, gapMs, source, muted, played }).catch(() => {});
  }

  async function startCall() {
    setBusy(true);
    hideError();
    try {
      const script = els.script.value ? Number(els.script.value) : null;
      const data = await api('/api/calls', { script, userAgent: navigator.userAgent, client: engineSignals() });
      state.callId = data.callId;
      state.lastTurn = data.turn;
      state.pin = '';
      renderPin();
      // The picker goes back to Free call, so a stray second call is never filed under this script.
      // The lines of the running script stay on screen.
      els.script.value = '';
      renderLines(script ?? '');
      els.transcript.textContent = '';
      els.reply.textContent = data.reply;
      applyState(data.state);
      speak(data.reply, () => {});
      await refreshEvents();
    } catch (error) {
      els.status.textContent = error.message;
    } finally {
      setBusy(false);
    }
    // Move focus off the Start button, so holding Space talks instead of pressing End call.
    if (canSend()) (SR ? els.talk : els.typedText).focus();
  }

  async function endCall() {
    const callId = state.callId;
    stopSpeaking();
    stopListening();
    try {
      await api(`/api/calls/${callId}/end`, {});
    } catch {
      // The server ends idle calls on its own, so the page can move on either way.
    }
    state.ended = true;
    state.locked = false;
    els.status.textContent = 'Call ended. Press Start call for a new one.';
    renderPending(null);
    setControls();
    await refreshEvents(callId);
  }

  async function sendTurn(text, source, startedAt) {
    const clean = text.trim();
    if (!clean || !canSend() || state.busy) return;
    const callId = state.callId;
    els.transcript.textContent = shownText(clean, source);
    setBusy(true);
    try {
      const data = await api(`/api/calls/${callId}/turn`, { text: clean, source, answering: state.lastTurn });
      state.lastTurn = data.turn;
      els.reply.textContent = data.reply;
      applyState(data.state);
      const muted = isMuted();
      speak(data.reply, (played) => logGap(callId, data.turn, startedAt, source, muted, played));
      await refreshEvents(callId);
    } catch (error) {
      els.status.textContent = error.message;
    } finally {
      setBusy(false);
    }
  }

  // ---- Speech in, hold to talk ----

  function finish(session) {
    if (session.done) return;
    session.done = true;
    clearTimeout(session.timer);
    if (state.listening === session) state.listening = null;
    els.talk.classList.remove('listening');
    const text = (session.finalText || session.interimText).trim();
    if (!text) {
      // Keep the reason the browser gave, so a blocked microphone or Siri being off is not shown as silence.
      showError(SPEECH_ERRORS[session.error] || SPEECH_ERRORS['no-speech']);
      openTyped();
      return;
    }
    sendTurn(text, 'voice', session.releasedAt);
  }

  function startListening() {
    if (!SR || !canSend() || state.busy || state.listening) return;
    prime();
    stopSpeaking();
    hideError();
    const rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = true;
    const session = { rec, finalText: '', interimText: '', releasedAt: null, ended: false, done: false, timer: null, error: null };
    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) session.finalText += `${result[0].transcript} `;
        else interim += result[0].transcript;
      }
      session.interimText = interim;
      els.transcript.textContent = shownText(`${session.finalText}${interim}`.trim(), 'voice');
    };
    rec.onerror = (event) => {
      session.error = event.error;
      if (SPEECH_ERRORS[event.error]) showError(SPEECH_ERRORS[event.error]);
      if (['not-allowed', 'service-not-allowed', 'network', 'audio-capture'].includes(event.error)) openTyped();
    };
    rec.onend = () => {
      session.ended = true;
      if (session.releasedAt !== null) finish(session);
    };
    state.listening = session;
    els.talk.classList.add('listening');
    try {
      rec.start();
    } catch {
      state.listening = null;
      els.talk.classList.remove('listening');
    }
  }

  function stopListening() {
    const session = state.listening;
    if (!session || session.releasedAt !== null) return;
    session.releasedAt = performance.now();
    els.talk.classList.remove('listening');
    if (session.ended) {
      finish(session);
      return;
    }
    try {
      session.rec.stop();
    } catch {
      // Already stopped.
    }
    session.timer = setTimeout(() => finish(session), FINAL_WAIT_MS);
  }

  // ---- Keypad and typed box ----

  function typesText(target) {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
    return target.tagName === 'INPUT' && TEXT_INPUT_TYPES.has(target.type);
  }

  function renderPin() {
    els.pinDots.textContent = state.pin ? '•'.repeat(state.pin.length) : 'No digits yet';
  }

  function wire() {
    els.script.addEventListener('change', () => renderLines());
    els.start.addEventListener('click', () => (state.callId && !state.ended ? endCall() : startCall()));
    els.talk.addEventListener('pointerdown', (event) => { event.preventDefault(); startListening(); });
    for (const name of ['pointerup', 'pointercancel', 'pointerleave']) els.talk.addEventListener(name, stopListening);
    els.talk.addEventListener('contextmenu', (event) => event.preventDefault());
    // While a call is open, Space is the talk key everywhere but text fields, so it never presses a focused button.
    document.addEventListener('keydown', (event) => {
      if (event.code !== 'Space' || typesText(event.target) || !canSend()) return;
      event.preventDefault();
      if (!event.repeat) startListening();
    });
    document.addEventListener('keyup', (event) => {
      if (event.code !== 'Space' || typesText(event.target) || !canSend()) return;
      event.preventDefault();
      stopListening();
    });
    for (const key of els.keys) {
      key.addEventListener('click', () => {
        if (state.pin.length < PIN_MAX) state.pin += key.dataset.digit;
        renderPin();
      });
    }
    els.pinClear.addEventListener('click', () => { state.pin = ''; renderPin(); });
    els.pinSend.addEventListener('click', () => {
      const pin = state.pin;
      state.pin = '';
      renderPin();
      if (pin) sendTurn(pin, 'keypad', performance.now());
    });
    els.typedForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const startedAt = performance.now();
      const text = els.typedText.value;
      els.typedText.value = '';
      sendTurn(text, 'typed', startedAt);
    });
    window.addEventListener('pagehide', () => {
      if (state.callId && !state.ended) navigator.sendBeacon(`/api/calls/${state.callId}/end`, new Blob(['{}'], { type: 'application/json' }));
    });
  }

  function init() {
    if (new URLSearchParams(window.location.search).get('mute') === '1') els.mute.checked = true;
    if (!canSpeak) {
      els.mute.checked = true;
      els.mute.disabled = true;
    }
    if (!SR) {
      openTyped();
      els.talk.textContent = 'Hold to talk is not available here';
      showError('This browser has no speech input, so use the typed box below.');
    }
    wire();
    setControls();
    loadScripts();
  }

  init();
})();
