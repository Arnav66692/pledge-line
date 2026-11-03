'use strict';

// The check page. It sends the receipt file's exact bytes to the line, which checks the signatures and the chain, and
// shows the answer: untouched and signed by this line, or what changed.
(() => {
  const MAX_BYTES = 512 * 1024;
  const $ = (id) => document.getElementById(id);
  const els = { drop: $('ck-drop'), file: $('ck-file'), result: $('ck-result') };
  const listOf = (value) => (Array.isArray(value) ? value : []);

  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function show(kind, title, lines = [], sentences = []) {
    const box = element('div', `ck-verdict ck-${kind}`);
    box.append(element('p', 'ck-title', title));
    for (const line of lines) box.append(element('p', 'ck-line', line));
    if (sentences.length > 0) {
      const list = element('ol', 'ck-sentences');
      for (const s of sentences) {
        const item = element('li', s.ok ? 'ck-ok' : 'ck-changed');
        item.append(element('span', 'ck-mark', s.ok ? 'Matches' : 'Changed'), element('span', 'ck-text', s.text === null ? '(this sentence can\'t be read)' : String(s.text)));
        list.append(item);
      }
      box.append(list);
    }
    els.result.replaceChildren(box);
  }

  function showCheck(check, fileName) {
    if (check.ok) {
      const count = listOf(check.sentences).length;
      show('ok', 'Untouched, and signed by this line.', [
        `${fileName} holds ${count} sentences, in the order the line said them, and every one matches what the line signed. Its key is ${check.keyId}.`,
      ]);
      return;
    }
    const changed = listOf(check.changed);
    const title = changed.length === 1 ? `This receipt was changed, at sentence ${changed[0]}.`
      : changed.length > 1 ? `This receipt was changed, at sentences ${changed.join(', ')}.`
        : check.signedByThisLine ? 'This receipt was changed.' : 'This receipt was not signed by this line, or it was changed.';
    show('changed', title, listOf(check.problems), listOf(check.sentences));
  }

  async function checkFile(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      show('changed', "That file is too large to be a receipt from this line.");
      return;
    }
    show('busy', 'Checking the file.');
    try {
      const bytes = await file.arrayBuffer();
      const res = await fetch('/api/receipts/check', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        show('changed', data.error || "The line didn't answer. Please try again.");
        return;
      }
      showCheck(data.check, file.name);
    } catch {
      show('changed', "The line didn't answer. Please try again.");
    }
  }

  els.file.addEventListener('change', () => checkFile(els.file.files[0]));
  for (const type of ['dragenter', 'dragover']) {
    els.drop.addEventListener(type, (event) => {
      event.preventDefault();
      els.drop.classList.add('is-over');
    });
  }
  for (const type of ['dragleave', 'drop']) els.drop.addEventListener(type, () => els.drop.classList.remove('is-over'));
  els.drop.addEventListener('drop', (event) => {
    event.preventDefault();
    checkFile(event.dataTransfer?.files?.[0]);
  });
})();
