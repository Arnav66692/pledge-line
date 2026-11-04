'use strict';

// The donor's receipt page. The donor page links here after a call ends, with the call number and the call's receipt
// secret in the link's fragment. The fragment never reaches a server, and this page takes it out of the address bar
// at once. The page asks the line for the signed receipt file, draws it, and offers the exact file to download.
(() => {
  const READ_ZONE = 'America/Los_Angeles';
  const SESSION_KEY = 'pledge-line.receipt';
  const LINK = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{32})$/;
  const READ_NAMES = { subscription: 'the gift', plan: 'the gift amount', invoice: 'the invoice' };
  const CLAIM_WORDS = window.PledgeClaimWords || {};
  const END_WORDS = { goodbye: 'ended after the goodbye', locked: 'locked after wrong PINs', idle: 'ended after a long quiet', client: 'ended from the page' };

  const $ = (id) => document.getElementById(id);
  const els = {
    status: $('rc-status'), body: $('rc-body'), org: $('rc-org'), when: $('rc-when'), id: $('rc-id'), practice: $('rc-practice'),
    download: $('rc-download'), print: $('rc-print'), list: $('rc-list'), seal: $('rc-seal'),
  };
  const timeFormat = new Intl.DateTimeFormat('en-US', { timeZone: READ_ZONE, hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const dayFormat = new Intl.DateTimeFormat('en-US', { timeZone: READ_ZONE, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const listOf = (value) => (Array.isArray(value) ? value : []);

  function clock(ts) {
    const date = new Date(ts);
    return Number.isNaN(date.getTime()) ? null : timeFormat.format(date).toLowerCase();
  }

  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  /** The link's fragment, taken out of the address bar. Once the line accepts it, load() keeps it for this tab so a reload still works. */
  function linkParts() {
    const fromHash = window.location.hash.slice(1);
    if (LINK.test(fromHash)) {
      window.history.replaceState(null, '', '/receipt');
      return fromHash.match(LINK);
    }
    let kept = null;
    try { kept = window.sessionStorage.getItem(SESSION_KEY); } catch { kept = null; }
    return kept && LINK.test(kept) ? kept.match(LINK) : null;
  }

  /** One line per PayPal read behind the sentence's facts, in the order the sentence says them. */
  function readLines(sentence) {
    const groups = new Map();
    for (const fact of listOf(sentence.facts)) {
      const key = fact.proof ? `read-${fact.proof.seq}` : 'config';
      if (!groups.has(key)) groups.set(key, { proof: fact.proof, values: [] });
      groups.get(key).values.push(String(fact.value));
    }
    return [...groups.values()].map(({ proof, values }) => {
      if (!proof) return `The line's own limit, ${values.join(', ')}.`;
      const at = clock(proof.ts) ?? 'a time in this call';
      const what = READ_NAMES[proof.what] ?? proof.what;
      return `From PayPal's record of ${what} at ${at}, ${values.join(', ')}. PayPal reference ${proof.debugId ?? 'none'}.`;
    });
  }

  function claimLines(sentence) {
    return listOf(sentence.claims).filter((c) => c.proven).map((c) => {
      const words = CLAIM_WORDS[String(c.name).split('=')[0]];
      const text = words ?? c.meaning ?? c.name;
      return `Backed by the call's record, ${text}.`;
    });
  }

  function sentenceItem(sentence) {
    const item = element('li', `rc-item rc-${sentence.verdict === 'proven' ? 'proven' : sentence.verdict === 'blocked' ? 'blocked' : 'plain'}`);
    const head = element('p', 'rc-item-head');
    head.append(element('span', 'rc-n', String(sentence.n)), element('span', 'rc-time', clock(sentence.at) ?? ''));
    item.append(head, element('p', 'rc-text', String(sentence.text ?? '')));
    const backing = element('div', 'rc-backing');
    if (sentence.verdict === 'proven') {
      for (const line of [...readLines(sentence), ...claimLines(sentence)]) backing.append(element('p', 'rc-proof', line));
    } else if (sentence.verdict === 'blocked') {
      backing.append(element('p', 'rc-flag', "This sentence didn't check out against the call's PayPal reads."));
      const problems = listOf(sentence.problems);
      if (problems.length > 0) {
        const list = element('ul', 'rc-problems');
        for (const message of problems) list.append(element('li', '', String(message)));
        backing.append(list);
      }
    } else {
      backing.append(element('p', 'rc-note', String(sentence.note ?? 'Nothing to check.')));
    }
    item.append(backing);
    return item;
  }

  function whenText(call) {
    const start = new Date(call.startedAt);
    if (Number.isNaN(start.getTime())) return 'unknown';
    const end = clock(call.endedAt);
    const how = END_WORDS[call.endReason] ?? 'ended';
    return `${dayFormat.format(start)}, ${clock(call.startedAt)} to ${end ?? 'unknown'} Pacific, ${how}`;
  }

  /** The file's own text, byte for byte as the line signed it, saved under a name with the call's date. */
  function offerDownload(text, call) {
    els.download.addEventListener('click', () => {
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: READ_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(call.startedAt));
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `pledge-line-receipt-${day}-${String(call.id).slice(0, 8)}.json`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  function render(text) {
    const receipt = JSON.parse(text);
    const call = receipt.call ?? {};
    const sentences = listOf(receipt.sentences);
    els.org.textContent = String(call.org ?? '');
    els.when.textContent = whenText(call);
    els.id.textContent = String(call.id ?? '');
    els.practice.textContent = call.paypal === 'mock'
      ? 'This was a practice call on a fake PayPal, so it touched no PayPal account.'
      : "This call ran on PayPal's test system, so no real money moved.";
    els.list.replaceChildren(...sentences.map(sentenceItem));
    const checked = sentences.filter((s) => s.verdict !== 'plain').length;
    els.seal.textContent = `${sentences.length} sentences, ${checked} with something to check. Signed by the line, key ${receipt.signature?.keyId ?? 'unknown'}. Check the file at ${window.location.origin}/check.`;
    offerDownload(text, call);
    els.print.addEventListener('click', () => window.print());
    els.status.textContent = `The line said ${sentences.length} sentences on this call. Each one is below.`;
    els.body.hidden = false;
  }

  const MESSAGES = {
    401: "This receipt link isn't right for the call. Open it from the line's page with the Keep a receipt of this call button.",
    404: "The line no longer has this call. Its server forgets calls when it restarts. If you downloaded the receipt file, it still holds everything, and you can check it at /check.",
    409: 'This call is still going. Its receipt is ready once the call ends.',
    429: 'Too many requests from here. Please wait a minute and reload.',
  };

  async function load() {
    const parts = linkParts();
    if (!parts) {
      els.status.textContent = 'This page shows the receipt of a call you made on this browser. Make a call on the line, end it, then press Keep a receipt of this call.';
      return;
    }
    try {
      const res = await fetch(`/api/receipts/${parts[1]}`, { headers: { 'x-receipt-secret': parts[2] } });
      const text = await res.text();
      if (!res.ok) {
        els.status.textContent = MESSAGES[res.status] ?? "The line didn't answer. Please reload in a moment.";
        return;
      }
      try { window.sessionStorage.setItem(SESSION_KEY, parts[0]); } catch { /* A reload then needs the link again. */ }
      render(text);
    } catch {
      els.status.textContent = "The line didn't answer. Please reload in a moment.";
    }
  }

  // A new link pasted into this tab is another call, so start over with it.
  window.addEventListener('hashchange', () => window.location.reload());
  load();
})();
