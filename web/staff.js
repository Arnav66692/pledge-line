'use strict';

// The staff view. Every value from the record reaches the page through textContent or AG Grid's own text cells,
// never as an HTML string, so a caller's words can't turn into markup. The one HTML string, the empty grid's note, is fixed text.
(() => {
  const KEY_STORE = 'pledge-line-staff-key';
  const NARROW = window.matchMedia('(max-width: 760px)');
  const PT = 'America/Los_Angeles';
  const $ = (id) => document.getElementById(id);
  const els = {
    keyCard: $('key-card'), keyForm: $('key-form'), keyInput: $('key-input'), keyError: $('key-error'),
    board: $('board'), status: $('board-status'), filter: $('filter'), refresh: $('refresh'), forget: $('forget'),
    grid: $('grid'), detail: $('detail'), detailTitle: $('detail-title'), detailBody: $('detail-body'), detailClose: $('detail-close'),
    tiles: {
      calls: $('tile-calls'), proven: $('tile-proven'), plain: $('tile-plain'), blocked: $('tile-blocked'),
      changes: $('tile-changes'), callbacks: $('tile-callbacks'),
    },
  };

  const INTENTS = {
    gift_status: 'hear the gift', stop_gift: 'stop the gift', cancel_now: 'cancel now', pause_gift: 'pause the gift',
    resume_gift: 'restart the gift', one_time_gift: 'one-time gift', other_email: 'a new email, refused', how_do_you_know: 'how do you know',
    repeat: 'repeat', help: 'help', staff_callback: 'a call back', goodbye: 'goodbye', unclear: 'unclear',
  };
  const WRITES = {
    suspend: 'paused the gift', activate: 'restarted the gift', cancel: 'cancelled the gift', send_invoice: 'sent the invoice',
    create_draft: 'made a draft invoice', delete_draft: 'deleted the draft',
  };
  const REFUSED = {
    suspend: 'refused the pause', activate: 'refused the restart', cancel: 'refused the cancel', send_invoice: 'refused the send',
    create_draft: 'refused the draft', delete_draft: 'refused the delete',
  };
  const READS = { subscription: 'gift', plan: 'plan', invoice: 'invoice' };
  const VERDICTS = { proven: 'Proven', plain: 'Plain', blocked: 'Blocked' };
  const END_REASONS = { goodbye: 'said goodbye', locked: 'locked after wrong PINs', idle: 'went idle', client: 'closed by the page' };

  const state = { key: null, api: null, rows: [], selected: null, loading: false };

  // ---- Small helpers ----

  function readKey() {
    try { return window.sessionStorage.getItem(KEY_STORE); } catch { return null; }
  }
  function writeKey(value) {
    try {
      if (value) window.sessionStorage.setItem(KEY_STORE, value);
      else window.sessionStorage.removeItem(KEY_STORE);
    } catch { /* A blocked store only means the key is asked for again. */ }
  }

  const dateFormat = new Intl.DateTimeFormat('en-US', { timeZone: PT, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const clockFormat = new Intl.DateTimeFormat('en-US', { timeZone: PT, hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const shortFormat = new Intl.DateTimeFormat('en-US', { timeZone: PT, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  // The column header already says PT, so the grid's cells leave it off.
  const shortPt = (iso) => (iso ? shortFormat.format(new Date(iso)) : 'not yet');
  const tinyFormat = new Intl.DateTimeFormat('en-US', { timeZone: PT, month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const tinyPt = (iso) => (iso ? tinyFormat.format(new Date(iso)) : 'not yet');
  const whenPt = (iso) => (iso ? `${dateFormat.format(new Date(iso))} PT` : 'not yet');
  const clockPt = (iso) => (iso ? `${clockFormat.format(new Date(iso))} PT` : 'no time');
  const statusWord = (status) => (status ? String(status).toLowerCase().replace(/_/g, ' ') : 'not read');
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  // ---- What each row says, in plain words ----

  const callLabel = (row) => (row.kind === 'script' ? `Script ${row.script}` : 'Free call');
  function wanted(row) {
    // A yes or a no routes as unclear, so unclear shows only when nothing else was heard.
    const routed = row.intents.length > 1 ? row.intents.filter((i) => i !== 'unclear') : row.intents;
    // A new email is refused before the router hears it, so it shows from the refusal.
    const heard = row.refusals.includes('other_email') && !routed.includes('other_email') ? [...routed, 'other_email'] : routed;
    if (heard.length > 0) return heard.map((i) => INTENTS[i] ?? i).join(', ');
    if (row.locked) return 'PIN locked';
    return row.verified ? 'nothing after the PIN' : 'no PIN yet';
  }
  const writeWords = (w) => (w.ok ? WRITES[w.kind] : REFUSED[w.kind]) ?? `${w.kind} ${w.ok ? 'done' : 'refused'}`;
  const changed = (row) => (row.writes.length > 0 ? row.writes.map(writeWords).join(', ') : 'nothing');
  function paypalNow(row) {
    const parts = [];
    if (row.paypalNow.subscription) parts.push(`gift ${statusWord(row.paypalNow.subscription.status)}`);
    if (row.paypalNow.invoice) parts.push(`invoice ${statusWord(row.paypalNow.invoice.status)}`);
    return parts.length > 0 ? parts.join(', ') : 'not read';
  }
  const countsText = (c) => `${c.proven} proven ${c.plain} plain ${c.blocked} blocked`;

  // ---- AG Grid cell renderers, built from DOM nodes and textContent ----

  /** The receipt counts as three chips. A call with any blocked sentence is the first thing staff should open. */
  class ReceiptCell {
    init(params) {
      this.gui = el('span', 'receipt-cell');
      this.refresh(params);
    }
    getGui() { return this.gui; }
    refresh(params) {
      const counts = params.data?.counts ?? { proven: 0, plain: 0, blocked: 0 };
      this.gui.replaceChildren(
        ...['proven', 'plain', 'blocked'].map((verdict) => {
          const chip = el('span', `chip chip-${verdict}${verdict === 'blocked' && counts.blocked > 0 ? ' chip-alert' : ''}`);
          chip.append(el('span', 'chip-count', counts[verdict]), el('span', 'chip-word', verdict));
          return chip;
        }),
      );
      this.gui.setAttribute('aria-label', `${counts.proven} sentences proven, ${counts.plain} plain, ${counts.blocked} blocked`);
      return true;
    }
  }

  /** The call's name, with a tag when it is a mock call or a dry run, so practice never reads as a real night. */
  class CallCell {
    init(params) {
      this.gui = el('span', 'call-cell');
      this.refresh(params);
    }
    getGui() { return this.gui; }
    refresh(params) {
      const row = params.data;
      if (!row) return true;
      const tags = [];
      if (row.mock) tags.push(el('span', 'tag', 'mock'));
      if (row.dryRun) tags.push(el('span', 'tag', 'dry run'));
      if (row.callback) tags.push(el('span', 'flag call-flag', 'Call back'));
      this.gui.replaceChildren(el('span', 'call-name', callLabel(row)), ...tags);
      return true;
    }
  }

  class CallbackCell {
    init(params) {
      this.gui = el('span', 'callback-cell');
      this.refresh(params);
    }
    getGui() { return this.gui; }
    refresh(params) {
      const asked = Boolean(params.data?.callback);
      this.gui.replaceChildren(asked ? el('span', 'flag', 'Call back') : el('span', 'flag-none', 'no'));
      return true;
    }
  }

  /**
   * The columns. At phone width the plain-word columns hide, since the side panel shows them in full, and the receipt
   * chips keep their counts only, with the order named in the header and every word in each cell's label.
   */
  function columnDefsFor(narrow, withDetail = false) {
    const defs = [
      { colId: 'started', headerName: narrow ? 'PT' : 'Started (PT)', field: 'started', sort: 'desc', minWidth: narrow ? 118 : 150, flex: 1.1,
        valueFormatter: (p) => (narrow ? tinyPt(p.value) : shortPt(p.value)), getQuickFilterText: (p) => whenPt(p.value) },
      { colId: 'call', headerName: 'Call', minWidth: narrow ? 92 : 130, flex: narrow ? 0.8 : 1, cellRenderer: CallCell,
        valueGetter: (p) => `${callLabel(p.data)}${p.data.mock ? ' mock' : ''}${p.data.dryRun ? ' dry run' : ''}${p.data.callback ? ' callback call back' : ''}` },
      { colId: 'wanted', headerName: 'The donor wanted', minWidth: 170, flex: 1.4, valueGetter: (p) => wanted(p.data), tooltipValueGetter: (p) => wanted(p.data) },
      { colId: 'changed', headerName: 'PayPal changed', minWidth: 170, flex: 1.4, valueGetter: (p) => changed(p.data), tooltipValueGetter: (p) => changed(p.data) },
      { colId: 'now', headerName: 'PayPal now', minWidth: 150, flex: 1.1, valueGetter: (p) => paypalNow(p.data) },
      { colId: 'receipts', headerName: narrow ? 'Proven, plain, blocked' : 'Receipts', minWidth: narrow ? 120 : 280, flex: narrow ? 1.3 : 1.9,
        cellRenderer: ReceiptCell, valueGetter: (p) => countsText(p.data.counts), headerTooltip: 'Sentences proven, plain and blocked',
        // Blocked first, then the most proven, so the calls that need a look sort to the top.
        comparator: (_a, _b, a, b) => (a.data.counts.blocked - b.data.counts.blocked) || (a.data.counts.proven - b.data.counts.proven) },
      { colId: 'callback', headerName: 'Callback', minWidth: 110, flex: 0.8, cellRenderer: CallbackCell, valueGetter: (p) => (p.data.callback ? 'callback call back' : 'no') },
    ];
    // Beside the open panel, which says the same in full, the plain-word columns step aside too.
    const hidden = new Set(narrow ? ['wanted', 'changed', 'now', 'callback'] : withDetail ? ['wanted', 'changed', 'now'] : []);
    return defs.map((def) => ({ ...def, hide: hidden.has(def.colId) }));
  }

  // ---- Talking to the line ----

  class KeyRefused extends Error {}

  async function staffGet(path) {
    const res = await fetch(path, { headers: { 'x-staff-key': state.key }, cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new KeyRefused(data.error || 'That staff key is not right.');
    if (res.status === 404 && path === '/api/staff/calls') throw new KeyRefused('The staff view is off on this line. Set STAFF_KEY and restart it.');
    if (!res.ok) throw new Error(data.error || 'The record could not load. Please try again.');
    return data;
  }

  function showKeyPrompt(message) {
    state.key = null;
    writeKey(null);
    els.board.hidden = true;
    els.keyCard.hidden = false;
    els.keyError.hidden = !message;
    els.keyError.textContent = message || '';
    els.keyInput.value = '';
    els.keyInput.focus();
  }

  // ---- Totals and the grid ----

  function renderTiles(rows) {
    const sum = (pick) => rows.reduce((total, row) => total + pick(row), 0);
    els.tiles.calls.textContent = String(rows.length);
    els.tiles.proven.textContent = String(sum((r) => r.counts.proven));
    els.tiles.plain.textContent = String(sum((r) => r.counts.plain));
    els.tiles.blocked.textContent = String(sum((r) => r.counts.blocked));
    els.tiles.changes.textContent = String(sum((r) => r.writes.filter((w) => w.ok).length));
    els.tiles.callbacks.textContent = String(sum((r) => (r.callback ? 1 : 0)));
  }

  function fitColumns() {
    if (!state.api) return;
    els.grid.classList.toggle('pl-grid-narrow', NARROW.matches);
    state.api.setGridOption('columnDefs', columnDefsFor(NARROW.matches, state.selected !== null));
  }

  /**
   * AG Grid writes each new row's position into a style attribute, which the line's policy (style-src 'self') refuses,
   * so every row would sit at the top. Setting the same position through the style object is allowed, so each row
   * AG Grid adds is placed here from its own rowTop. Rows it moves later, AG Grid places itself the same way.
   */
  function placeRows() {
    for (const row of els.grid.querySelectorAll('.ag-row[row-index]')) {
      const node = state.api.getDisplayedRowAtIndex(Number(row.getAttribute('row-index')));
      if (node && Number.isFinite(node.rowTop)) row.style.transform = `translateY(${node.rowTop}px)`;
    }
  }

  function keepRowsPlaced() {
    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; placeRows(); });
    });
    observer.observe(els.grid, { childList: true, subtree: true, attributes: true, attributeFilter: ['row-index'] });
    placeRows();
  }

  function makeGrid() {
    state.api = window.agGrid.createGrid(els.grid, {
      columnDefs: columnDefsFor(NARROW.matches),
      rowData: [],
      defaultColDef: { sortable: true, resizable: true, suppressHeaderMenuButton: true },
      getRowId: (p) => p.data.callId,
      rowSelection: { mode: 'singleRow', checkboxes: false, enableClickSelection: true },
      rowHeight: 48,
      headerHeight: 44,
      animateRows: false,
      ensureDomOrder: true,
      tooltipShowDelay: 400,
      overlayNoRowsTemplate: '<span class="pl-empty">No calls in the record yet.</span>',
      onSelectionChanged: () => {
        const [row] = state.api.getSelectedRows();
        if (row) openDetail(row.callId);
      },
      onCellKeyDown: (e) => {
        if (e.event && (e.event.key === 'Enter' || e.event.key === ' ')) {
          e.event.preventDefault();
          e.node.setSelected(true, true);
          if (state.selected === e.data.callId) openDetail(e.data.callId);
        }
      },
    });
    fitColumns();
    NARROW.addEventListener('change', fitColumns);
    keepRowsPlaced();
  }

  async function loadCalls() {
    if (state.loading) return;
    state.loading = true;
    els.status.textContent = 'Loading the record.';
    try {
      const { calls } = await staffGet('/api/staff/calls');
      state.rows = calls;
      if (!state.api) makeGrid();
      state.api.setGridOption('rowData', calls);
      renderTiles(calls);
      els.status.textContent = `${plural(calls.length, 'call', 'calls')} in the record, newest first. Loaded at ${clockPt(new Date().toISOString())}.`;
    } catch (error) {
      if (error instanceof KeyRefused) return showKeyPrompt(error.message);
      els.status.textContent = error.message;
    } finally {
      state.loading = false;
    }
  }

  // ---- The side panel ----

  function factLine(fact) {
    const item = el('li', 'proof');
    item.append(el('span', 'proof-value', fact.value));
    if (!fact.proof) {
      item.append(el('span', 'proof-from', ` from the line's own limits, not a PayPal read (${fact.source})`));
      return item;
    }
    const p = fact.proof;
    // A plan read has no status, so only a gift or invoice read names one.
    const status = p.status ? `, which showed ${statusWord(p.status)}` : '';
    item.append(el('span', 'proof-from', ` from PayPal's ${READS[p.what] ?? p.what} read at ${clockPt(p.ts)}${status}`));
    const meta = el('span', 'proof-meta');
    meta.append(el('span', null, 'debug id '), el('code', 'mono', p.debugId ?? 'none'), el('span', null, ', '), el('span', null, fact.source));
    item.append(meta);
    return item;
  }

  function claimLine(claim) {
    const item = el('li', `proof claim ${claim.proven ? 'claim-proven' : 'claim-unproven'}`);
    item.append(el('span', 'proof-value', claim.proven ? 'Claim proven' : 'Claim not proven'));
    item.append(el('span', 'proof-from', ` ${claim.meaning ?? claim.name}`));
    return item;
  }

  function sentenceItem(sentence) {
    const item = el('li', `sentence verdict-${sentence.verdict}`);
    const head = el('div', 'sentence-head');
    head.append(el('span', `verdict verdict-badge-${sentence.verdict}`, VERDICTS[sentence.verdict] ?? sentence.verdict), el('p', 'sentence-text', sentence.text));
    item.append(head);
    const proofs = el('ul', 'proofs');
    for (const fact of sentence.facts) proofs.append(factLine(fact));
    for (const claim of sentence.claims) proofs.append(claimLine(claim));
    for (const problem of sentence.problems) proofs.append(el('li', 'proof problem', problem));
    if (proofs.childElementCount > 0) item.append(proofs);
    return item;
  }

  function turnBlock(receipt, heardByTurn) {
    const block = el('section', 'turn');
    block.append(el('h3', 'turn-title', receipt.turn === 0 ? 'Greeting' : `Turn ${receipt.turn}, at ${clockPt(receipt.ts)}`));
    const heard = heardByTurn.get(receipt.turn);
    if (heard) {
      const said = el('p', 'heard');
      said.append(el('span', 'heard-label', `The donor ${heard.source === 'voice' ? 'said' : heard.source === 'keypad' ? 'keyed' : 'typed'} `), el('span', 'heard-text', heard.text));
      block.append(said);
    }
    const list = el('ol', 'sentences');
    for (const sentence of receipt.sentences) list.append(sentenceItem(sentence));
    block.append(list);
    return block;
  }

  function facts(pairs) {
    const dl = el('dl', 'facts detail-facts');
    for (const [term, value, mono] of pairs) dl.append(el('dt', null, term), el('dd', mono ? 'mono' : null, value));
    return dl;
  }

  function writesList(call) {
    if (call.writes.length === 0) return el('p', 'hint', 'PayPal changed nothing in this call.');
    const list = el('ul', 'writes');
    for (const w of call.writes) {
      const item = el('li', w.ok ? 'write-ok' : 'write-refused');
      item.append(el('span', null, `${writeWords(w)} at ${clockPt(w.ts)}, debug id `), el('code', 'mono', w.debugId ?? 'none'));
      list.append(item);
    }
    return list;
  }

  function renderDetail(call) {
    els.detailTitle.textContent = `${callLabel(call)}, ${whenPt(call.started)}`;
    const heardByTurn = new Map(call.events.filter((e) => e.type === 'heard').map((e) => [e.turn, e]));
    const sub = call.paypalNow.subscription;
    const inv = call.paypalNow.invoice;
    const body = [
      facts([
        ['Run', call.mock ? 'mock, does not count' : call.dryRun ? 'dry run, does not count' : 'PayPal sandbox'],
        ['Ended', call.ended ? `${whenPt(call.ended)}, ${END_REASONS[call.endReason] ?? call.endReason}` : 'still open'],
        ['The donor wanted', wanted(call)],
        ['Gift now', sub ? `${statusWord(sub.status)}, read at ${clockPt(sub.ts)}` : 'not read'],
        ['Invoice now', inv ? `${statusWord(inv.status)}, read at ${clockPt(inv.ts)}` : 'none'],
        ['Callback', call.callback ? 'asked, call the donor back' : 'not asked'],
        ['Receipts', `${call.counts.proven} proven, ${call.counts.plain} plain, ${call.counts.blocked} blocked`],
      ]),
      el('h3', null, 'What PayPal changed'),
      writesList(call),
      el('h3', null, 'Every sentence the line said'),
      el('p', 'hint', 'Proven means each amount, date and status in it matches a PayPal read earlier in the call, and each claim is backed by what PayPal returned. Plain means it states no fact. Blocked means the grader found a problem.'),
      ...call.receipts.map((receipt) => turnBlock(receipt, heardByTurn)),
    ];
    els.detailBody.replaceChildren(...body);
  }

  async function openDetail(callId) {
    state.selected = callId;
    els.detail.hidden = false;
    els.board.classList.add('with-detail');
    fitColumns();
    els.detailTitle.textContent = 'Loading the call';
    els.detailBody.replaceChildren(el('p', 'hint', 'Reading the record.'));
    els.detail.focus();
    try {
      const { call } = await staffGet(`/api/staff/calls/${encodeURIComponent(callId)}`);
      if (state.selected === callId) renderDetail(call);
    } catch (error) {
      if (error instanceof KeyRefused) return showKeyPrompt(error.message);
      els.detailBody.replaceChildren(el('p', 'error', error.message));
    }
  }

  function closeDetail() {
    state.selected = null;
    els.detail.hidden = true;
    els.board.classList.remove('with-detail');
    fitColumns();
    state.api?.deselectAll();
    // Back to the grid, where the keyboard left off.
    const focused = state.api?.getFocusedCell();
    if (focused) state.api.setFocusedCell(focused.rowIndex, focused.column);
    const cell = els.grid.querySelector('.ag-cell-focus');
    if (cell) cell.focus();
    else els.filter.focus();
  }

  // ---- Wiring ----

  function openBoard() {
    els.keyCard.hidden = true;
    els.board.hidden = false;
    loadCalls();
  }

  els.keyForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = els.keyInput.value.trim();
    if (value.length < 16) {
      els.keyError.hidden = false;
      els.keyError.textContent = 'The staff key is at least 16 characters.';
      return;
    }
    state.key = value;
    writeKey(value);
    els.keyInput.value = '';
    openBoard();
  });
  els.filter.addEventListener('input', () => state.api?.setGridOption('quickFilterText', els.filter.value));
  els.refresh.addEventListener('click', loadCalls);
  els.forget.addEventListener('click', () => showKeyPrompt(''));
  els.detailClose.addEventListener('click', closeDetail);
  els.detail.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDetail(); });

  if (!window.agGrid) {
    els.keyError.hidden = false;
    els.keyError.textContent = 'The grid could not load. Reload the page.';
    return;
  }
  state.key = readKey();
  if (state.key) openBoard();
  else els.keyInput.focus();
})();
