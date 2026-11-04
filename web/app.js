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
    events: $('events'), gift: $('gift'), subRead: $('sub-read'), subChange: $('sub-change'), demo: $('demo'),
    receipts: $('receipts'), receiptsSummary: $('receipts-summary'), receiptsScroll: $('receipts-scroll'),
  };

  // Read times show in Pacific time, the line's own zone, whatever zone the viewer's computer is in.
  const READ_ZONE = 'America/Los_Angeles';
  const DEMO_OPEN_KEY = 'pledge-line.demo-open';
  const STATUS_WORDS = { ACTIVE: 'Active', SUSPENDED: 'Paused', CANCELLED: 'Cancelled', EXPIRED: 'Expired', APPROVAL_PENDING: 'Waiting for approval' };
  // The line says "suspended", PayPal's word, so the card says once that it is the same thing as paused.
  const STATUS_NOTES = { SUSPENDED: " PayPal's word for a pause is suspended." };
  // What a change the card marks did, in the donor's words.
  const CHANGE_WORDS = { SUSPENDED: 'Paused', ACTIVE: 'Restarted' };
  // The statuses a change's read-back can land on that the gift card marks, a pause and a restart.
  const MARKED_CHANGES = new Set(['SUSPENDED', 'ACTIVE']);
  const clockFormat = new Intl.DateTimeFormat('en-US', { timeZone: READ_ZONE, hour: 'numeric', minute: '2-digit' });
  // PayPal read times show to the second, so a read-back after a change reads as later than the read before it.
  const secondsFormat = new Intl.DateTimeFormat('en-US', { timeZone: READ_ZONE, hour: 'numeric', minute: '2-digit', second: '2-digit' });
  // Plain words for the claims a chip shows. Its title says what backs it, from claim-words.js. A claim not named here shows the grader's meaning.
  const CLAIM_LABELS = {
    pin_ok: 'PIN accepted', pin_bad: 'Checked against your PIN', tries_left: 'Counted on this call', pin_locked: 'Call locked after wrong PINs',
    pin_limit: 'Too many wrong PINs from here', not_verified: 'No PIN yet',
    wrote: 'PayPal accepted the change', wrote_suspend: 'PayPal took it as a pause, not a cancel', wrote_activate: 'PayPal accepted the restart',
    wrote_cancel: 'PayPal accepted the cancellation', wrote_send_invoice: 'PayPal agreed to send it',
    write_failed: 'PayPal turned down the change', send_failed: 'PayPal turned down the send', write_unclear: 'PayPal gave no clear answer',
    gift_unread: 'PayPal didn\'t return the gift after the request', invoice_unread: 'PayPal didn\'t return the invoice after the request',
    draft_deleted: 'Draft deleted, PayPal no longer finds it', draft_kept: 'The draft is still in PayPal',
    no_gift: 'PayPal found no monthly gift', no_email: 'PayPal has no email on file', paypal_unclear: 'No clear answer from PayPal',
    unchanged: 'Nothing changed in PayPal', no_pause: 'You said no, nothing changed', email_refused: 'New email turned down',
    set_aside: 'Set aside, nothing changed', callback_noted: 'Call back noted for staff', turn_limit: 'The call reached its limit',
    timed_out: 'Timed out, nothing changed', nothing_pending: 'Nothing waiting for a yes', call_ended: 'The call had ended',
    gift_read: 'Checked your gift in PayPal', gift_active: 'PayPal shows the gift active', nothing_to: 'PayPal shows nothing to change',
    invoice_read: 'Checked the draft in PayPal', gift_rechecked: 'Checked PayPal again for this answer',
  };

  const LABELS = { suspend: 'pausing the monthly gift', activate: 'restarting the monthly gift', cancel: 'cancelling the monthly gift', send_invoice: 'sending the one-time gift invoice' };
  // The same changes as a request, for the event log's "PayPal accepted the request to ...".
  const REQUESTS = { suspend: 'pause the monthly gift', activate: 'restart the monthly gift', cancel: 'cancel the monthly gift', send_invoice: 'send the one-time gift invoice' };
  const CLAIM_WORDS = window.PledgeClaimWords || {};
  const READ_NAMES = { subscription: 'the gift', plan: 'the gift amount', invoice: 'the invoice' };
  // How the event log says what the line took each request to be.
  const INTENT_WORDS = {
    gift_status: 'Took that as asking about the gift.', stop_gift: 'Took that as a request to stop the gift.',
    cancel_now: 'Took that as a request to cancel now.', pause_gift: 'Took that as a request to pause the gift.',
    resume_gift: 'Took that as a request to restart the gift.', one_time_gift: 'Took that as asking to give once.',
    other_email: 'Took that as a new email address.', how_do_you_know: 'Took that as asking how the line knows.',
    repeat: 'Took that as asking to hear it again.', help: 'Took that as asking for help.',
    staff_callback: 'Took that as asking for a call back.', goodbye: 'Took that as goodbye.',
    unclear: 'That wasn\'t a request on its own.',
  };
  const END_WORDS = {
    goodbye: 'Call ended after you said goodbye.', locked: 'Call ended, locked after wrong PINs.',
    idle: 'Call ended after a long quiet.', client: 'Call ended when the page closed.',
  };
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
    network: 'Talking needs an internet connection. Try again, or type instead.',
    'audio-capture': 'No microphone was found. Please type instead.',
  };

  // lastTurn is the turn of the last reply this page received. Each turn says it answers that reply, so a yes only counts for a proposal the caller heard.
  // giftStatus is the status the gift card last showed in this call, so a change's read-back can be marked when it lands.
  const state = { callId: null, verified: false, ended: true, locked: false, busy: false, pin: '', scripts: [], primed: false, voiceGaps: [], listening: null, lastTurn: 0, giftStatus: null, giftShown: false };

  // Engine signals a user-agent override, such as Chrome's device toolbar, does not change. The line checks them against the agent.
  const engineSignals = () => ({ vendor: String(navigator.vendor || ''), chrome: typeof window.chrome !== 'undefined', uaData: 'userAgentData' in navigator });

  async function api(path, body) {
    const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const res = await fetch(path, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'The line didn\'t answer. Please try again.');
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
      item.textContent = `This script should end like this. ${script.expected}.`;
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

  /** "5:42 pm" in Pacific time, or "5:42:07 pm" with seconds, or null when there is no usable time. */
  function clockTime(ts, { seconds = false } = {}) {
    const at = new Date(ts ?? NaN);
    if (Number.isNaN(at.getTime())) return null;
    const parts = Object.fromEntries((seconds ? secondsFormat : clockFormat).formatToParts(at).map((p) => [p.type, p.value]));
    const sec = seconds ? `:${parts.second}` : '';
    return `${parts.hour}:${parts.minute}${sec} ${String(parts.dayPeriod ?? '').toLowerCase()}`.trim();
  }

  function renderGiftRead(ts, rawStatus) {
    const time = clockTime(ts, { seconds: true });
    if (!time) return;
    els.subRead.textContent = `Checked with PayPal at ${time}.${STATUS_NOTES[rawStatus] ?? ''}`;
  }

  function clearGiftChange() {
    els.gift.classList.remove('changed', 'flash');
    els.subChange.hidden = true;
    els.subChange.textContent = '';
  }

  /** A change's read-back landed. The card keeps a border in the new status's color, and the status word pops once. */
  function markGiftChange(from, to) {
    els.gift.classList.add('changed');
    els.gift.classList.remove('flash');
    // Reading layout restarts the animation when two changes land in one call.
    void els.gift.offsetWidth;
    els.gift.classList.add('flash');
    const word = (status) => STATUS_WORDS[status] ?? status;
    els.subChange.textContent = `${CHANGE_WORDS[to] ?? word(to)} on this call. It was ${word(from).toLowerCase()} before.`;
    els.subChange.hidden = false;
  }

  function trackGiftStatus(sub) {
    const status = sub && !sub.notFound ? sub.status ?? null : null;
    state.giftShown = Boolean(sub);
    if (!sub) {
      state.giftStatus = null;
      clearGiftChange();
      els.subRead.textContent = 'Not checked with PayPal yet.';
      return;
    }
    if (state.giftStatus && status && status !== state.giftStatus && MARKED_CHANGES.has(status)) markGiftChange(state.giftStatus, status);
    state.giftStatus = status;
  }

  function renderRecord(record) {
    const sub = record?.subscription;
    trackGiftStatus(sub);
    els.gift.dataset.status = sub && !sub.notFound ? String(sub.status ?? '') : '';
    const shown = sub && !sub.notFound && sub.status ? STATUS_WORDS[sub.status] ?? sub.status : null;
    setText(els.subStatus, sub?.notFound ? 'Not found' : shown, 'not checked yet');
    setText(els.subAmount, sub?.amount, 'not checked yet');
    setText(els.subNext, sub?.status === 'ACTIVE' ? sub?.nextDate : null, sub ? 'Nothing scheduled' : 'not checked yet');
    setText(els.subDebug, sub?.debugId, 'none');
    const inv = record?.invoice;
    // Left empty with no invoice, so style.css shows the card's one line, "No one-time gift on this call.", instead.
    setText(els.invNumber, inv?.number, '');
    setText(els.invStatus, inv?.status === 'NOT_FOUND' ? 'not found, deleted' : inv?.status, '');
    setText(els.invAmount, inv?.amount, 'none');
    setText(els.invDebug, inv?.debugId, 'none');
    els.invLink.replaceChildren();
    if (inv?.recipientViewUrl && /^https:\/\//.test(inv.recipientViewUrl) && inv.status !== 'NOT_FOUND') {
      const link = document.createElement('a');
      link.href = inv.recipientViewUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open PayPal\'s payment page';
      els.invLink.append(link);
    } else {
      els.invLink.textContent = 'none';
    }
  }

  function renderPending(pending) {
    els.pending.hidden = !pending;
    if (!pending) return;
    els.pendingLabel.textContent = `${pending.label}. Nothing changes in PayPal until you say yes.`;
    const time = clockTime(pending.expiresAt);
    els.pendingExpiry.textContent = time ? `The line will wait for your yes or no until ${time}.` : 'The line will wait a few minutes for your yes or no.';
  }

  // ---- Receipts, every sentence the line said beside the PayPal read behind it ----

  const listOf = (value) => (Array.isArray(value) ? value : []);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  /**
   * One chip per read time behind the sentence's facts, so the plan and gift reads of one minute share a chip with
   * the facts in the order the sentence says them, then one chip per claim the sentence carries.
   */
  function chipLabels(sentence) {
    const groups = new Map();
    for (const fact of listOf(sentence.facts)) {
      const time = fact.proof ? clockTime(fact.proof.ts, { seconds: true }) ?? 'some point in this call' : null;
      const key = fact.proof ? `at ${time}` : 'config';
      if (!groups.has(key)) groups.set(key, { key, proofs: [], values: [] });
      const group = groups.get(key);
      if (fact.proof) group.proofs.push(fact.proof);
      group.values.push(String(fact.value));
    }
    const reads = [...groups.values()].map(({ key, proofs, values }) => {
      if (key === 'config') return { text: `The line's own limit, ${values.join(', ')}`, title: '' };
      const seen = [...new Map(proofs.map((p) => [p.seq, p])).values()];
      const title = seen.map((p) => `Checked ${READ_NAMES[p.what] ?? p.what} in PayPal, reference ${p.debugId ?? 'none'}`).join('. ');
      return { text: `From PayPal ${key}, ${values.join(', ')}`, title };
    });
    const claims = listOf(sentence.claims).filter((c) => c.proven).map((c) => {
      const name = String(c.name).split('=')[0];
      const label = CLAIM_LABELS[name];
      const words = CLAIM_WORDS[name];
      const backing = words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}.` : `Backed by ${c.meaning ?? c.name}`;
      return label ? { text: label, title: backing } : { text: backing, title: '' };
    });
    return [...reads, ...claims];
  }

  function sentenceItem(sentence) {
    const blocked = sentence.verdict === 'blocked';
    const item = element('div', `sentence sentence-${blocked ? 'blocked' : sentence.verdict === 'proven' ? 'proven' : 'plain'}`);
    item.append(element('span', 'sentence-text', String(sentence.text ?? '')));
    if (sentence.verdict === 'proven') {
      const chips = element('span', 'chips');
      for (const { text, title } of chipLabels(sentence)) {
        const chip = element('span', 'chip chip-proven', text);
        if (title) chip.title = title;
        chips.append(chip);
      }
      item.append(chips);
    } else if (blocked) {
      // Never expected, since the line speaks only what it can prove. If it happens, say so plainly.
      item.append(element('span', 'chip chip-blocked', 'This didn\'t check out'));
      const problems = listOf(sentence.problems);
      if (problems.length > 0) {
        const list = element('ul', 'problems');
        for (const message of problems) list.append(element('li', '', String(message)));
        item.append(list);
      }
    }
    return item;
  }

  function receiptItem(receipt) {
    const item = element('li', 'turn');
    const time = clockTime(receipt.ts);
    const name = receipt.turn === 0 ? 'Greeting' : `Reply ${receipt.turn}`;
    item.append(element('p', 'turn-time', time ? `${name}, ${time}` : name));
    for (const sentence of listOf(receipt.sentences)) item.append(sentenceItem(sentence));
    return item;
  }

  function renderReceipts(receipts) {
    if (!Array.isArray(receipts)) return;
    els.receipts.replaceChildren(...receipts.map(receiptItem));
    const sentences = receipts.flatMap((r) => listOf(r.sentences));
    const count = (verdict) => sentences.filter((s) => s.verdict === verdict).length;
    const checked = count('proven') + count('blocked');
    const said = `The line has said ${plural(sentences.length, 'sentence', 'sentences')}.`;
    const outcome = count('blocked') > 0 ? `${count('blocked')} didn't check out. Those are marked in red.`
      : checked === 1 ? 'It checked out.' : `All ${checked} checked out.`;
    els.receiptsSummary.textContent = sentences.length === 0 ? 'Nothing said yet.'
      : checked === 0 ? `${said} None had anything to check yet.`
        : `${said} ${checked} had something to check. ${outcome}`;
    els.receiptsScroll.scrollTop = els.receiptsScroll.scrollHeight;
    const lastGiftRead = receipts.flatMap((r) => listOf(r.sentences)).flatMap((s) => listOf(s.facts))
      .map((f) => f.proof).filter((p) => p && p.what === 'subscription').sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).at(-1);
    if (lastGiftRead && state.giftShown) renderGiftRead(lastGiftRead.ts, lastGiftRead.status);
  }

  const statusText = (status) => String(STATUS_WORDS[status] ?? status).replace(/_/g, ' ').toLowerCase();
  // A PIN turn reaches the page with its numbers hidden as #, so the log says a PIN came in rather than quote the marks.
  const isHiddenPin = (text) => /^[#\s]+$/.test(String(text ?? ''));

  function describe(e) {
    const what = LABELS[e.kind] || e.kind;
    const request = REQUESTS[e.kind] || e.kind;
    const readName = READ_NAMES[e.what] || `the ${e.what}`;
    switch (e.type) {
      case 'call_start': return 'Call started.';
      case 'heard':
        if (e.source === 'keypad') return 'Got a PIN from the keypad.';
        if (isHiddenPin(e.text)) return e.source === 'voice' ? 'Heard a PIN.' : 'Got a typed PIN.';
        // "You typed "Yes."" ends on the caller's own stop, so the log adds one only when they left it off.
        return `${e.source === 'voice' ? 'You said' : 'You typed'} "${e.text}"${/[.?!]$/.test(String(e.text)) ? '' : '.'}`;
      case 'pin_ok': return 'PIN accepted.';
      case 'pin_bad': return 'Wrong PIN.';
      case 'pin_locked': return 'Too many wrong PINs. The call is locked.';
      case 'route': return INTENT_WORDS[e.intent] ?? `Took that as ${String(e.intent).replace(/_/g, ' ')}.`;
      case 'read':
        if (e.notFound) return `Asked PayPal for ${readName}. PayPal couldn't find it.`;
        if (e.error) return `Couldn't check ${readName} in PayPal, ${e.error}.`;
        return e.status
          ? `Checked ${readName} in PayPal. It shows ${statusText(e.status)}, reference ${e.debugId || 'none'}.`
          : `Checked ${readName} in PayPal, reference ${e.debugId || 'none'}.`;
      case 'proposed': return `Asked for your yes before ${what}.`;
      case 'yes': return 'You said yes, so the line can make this one change.';
      case 'no': return 'You said no.';
      case 'write': return e.ok ? `PayPal accepted the request to ${request}, reference ${e.debugId || 'none'}.` : `PayPal turned down the request to ${request}, ${e.error || 'error'}.`;
      case 'staging_write':
        if (e.kind === 'create_draft') return e.ok ? `Made a draft invoice, ${e.id}. It isn't sent.` : 'Couldn\'t make a draft invoice.';
        return e.ok ? `Deleted the draft invoice ${e.id}.` : `Couldn't delete the draft invoice ${e.id}.`;
      case 'refused': return `Turned that down because ${REASONS[e.reason] || e.reason}.`;
      case 'expired': return 'No answer in time, so nothing changed.';
      case 'withdrawn': return 'The request was set aside.';
      case 'staff_callback': return 'Noted that you want a call back from staff.';
      case 'call_end': return END_WORDS[e.reason] ?? `Call ended, ${e.reason}.`;
      default: return null;
    }
  }

  async function refreshEvents(callId = state.callId, transcriptTurn = null) {
    if (!callId) return;
    try {
      const data = await api(`/api/calls/${callId}`);
      // A page that moved on to a new call keeps that call's view.
      if (callId !== state.callId) return;
      // Never display raw input: the server has the PIN and masks it before recording a heard event.
      // Until that event arrives, keep the neutral placeholder rather than revealing an interim transcript.
      if (transcriptTurn !== null) {
        const heard = listOf(data.events).find((e) => e.type === 'heard' && e.turn === transcriptTurn);
        if (heard) els.transcript.textContent = heard.source === 'keypad' ? 'PIN entered.' : heard.text;
      }
      renderReceipts(data.receipts);
      // The card shows the call's latest gift read, so its time comes from that read, spoken or not.
      const giftRead = listOf(data.events).filter((e) => e.type === 'read' && e.what === 'subscription' && !e.error).at(-1);
      if (giftRead && state.giftShown) renderGiftRead(giftRead.ts, giftRead.status);
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
    else if (!s.verified) els.status.textContent = 'Enter your PIN on the keypad, or say the numbers.';
    else els.status.textContent = s.script ? `PIN accepted. Say the next line from Script ${s.script} once the line stops talking.` : 'PIN accepted. Go ahead and ask about your monthly gift.';
    renderPending(s.pending);
    renderRecord(s.record);
    renderReceipts(s.receipts);
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
    els.gapLast.textContent = `${seconds(gapMs)}${muted ? ', muted' : played ? '' : ', the reply didn\'t play'}`;
    if (source === 'voice' && !muted && played) {
      state.voiceGaps.push(gapMs);
      els.gapMedian.textContent = `${seconds(median(state.voiceGaps))} over ${state.voiceGaps.length} ${state.voiceGaps.length === 1 ? 'reply' : 'replies'}`;
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
      // The picker goes back to No script, so a stray second call is never filed under this script.
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
    els.transcript.textContent = source === 'keypad' ? 'PIN entered.' : 'Checking what you said…';
    setBusy(true);
    try {
      const data = await api(`/api/calls/${callId}/turn`, { text: clean, source, answering: state.lastTurn });
      state.lastTurn = data.turn;
      els.reply.textContent = data.reply;
      applyState(data.state);
      const muted = isMuted();
      speak(data.reply, (played) => logGap(callId, data.turn, startedAt, source, muted, played));
      await refreshEvents(callId, data.turn);
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
      // Interim recognition can contain a PIN before we know its full form. Do not render it.
      els.transcript.textContent = 'Listening…';
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
    els.pinDots.textContent = state.pin ? '•'.repeat(state.pin.length) : 'No numbers yet';
    els.pinDots.classList.toggle('dots-empty', !state.pin);
  }

  // Whether Demo controls is open is a per-viewer convenience, so a lost setting only means it starts folded.
  function rememberDemo() {
    try {
      if (window.localStorage.getItem(DEMO_OPEN_KEY) === '1') els.demo.open = true;
    } catch {
      // Storage can be blocked. The section still works folded.
    }
    els.demo.addEventListener('toggle', () => {
      try {
        window.localStorage.setItem(DEMO_OPEN_KEY, els.demo.open ? '1' : '0');
      } catch {
        // Nothing to keep.
      }
    });
  }

  function wire() {
    rememberDemo();
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
      els.talk.textContent = 'Talking isn\'t available in this browser';
      showError('This browser can\'t listen, so please type below.');
    }
    wire();
    setControls();
    loadScripts();
  }

  init();
})();
