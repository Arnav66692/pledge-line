(() => {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const els = Object.fromEntries(['request', 'specification', 'quantity', 'budget', 'deadline', 'scenario', 'find-plan', 'request-status', 'error',
    'quotes-summary', 'empty-quotes', 'quote-results', 'quotes', 'rejections', 'rejection-list', 'plan-panel', 'state-label', 'plan-empty',
    'plan-details', 'plan-total', 'plan-budget', 'allocations', 'plan-expiry', 'terms-specification', 'terms-request', 'terms-hash',
    'approval-form', 'approval-check', 'approve', 'settlement', 'settlement-list', 'settlement-note', 'reconcile', 'timeline-empty', 'timeline']
    .map((id) => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), byId(id)]));
  const session = { id: null, secret: null, state: null, busy: false, briefChanged: false, approvalUnknown: false };
  const list = (value) => Array.isArray(value) ? value : [];
  const money = (cents, currency = 'USD') => Number.isSafeInteger(cents)
    ? new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100) : 'Not provided';
  const date = (value) => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(parsed) : 'Not provided';
  };
  const statusNames = Object.freeze({ awaiting_approval: 'Review the plan', no_feasible_quote: 'No plan fits', completed: 'Mock order completed', partial: 'Partially settled', uncertain: 'Result uncertain', failed: 'Settlement failed', expired: 'Plan expired' });
  const settlementNames = Object.freeze({ pending: 'Not attempted', not_started: 'Not attempted', reserved: 'Not attempted', in_flight: 'Attempt in progress', confirmed: 'Mock payment confirmed', completed: 'Mock payment confirmed', captured: 'Mock payment confirmed', succeeded: 'Mock payment confirmed', paid: 'Mock payment confirmed', declined: 'Supplier declined', failed: 'Mock payment failed', unknown: 'Result uncertain', uncertain: 'Result uncertain', skipped: 'Not attempted' });
  const node = (tag, text, className) => {
    const item = document.createElement(tag);
    if (text !== undefined && text !== null) item.textContent = String(text);
    if (className) item.className = className;
    return item;
  };

  function error(message) {
    els.error.textContent = message || '';
    els.error.hidden = !message;
  }

  function approvalExpired() {
    const expiresAt = session.state?.proposal?.expiresAt;
    return Boolean(expiresAt && new Date(expiresAt).getTime() <= Date.now());
  }

  function updateControls() {
    const canApprove = session.state?.status === 'awaiting_approval' && session.state?.proposal && !session.busy &&
      !session.briefChanged && !session.approvalUnknown && !approvalExpired();
    // Keep this order in view until an uncertain payment is reconciled. Starting another session must not become
    // an accidental way to repeat a purchase whose first answer was lost.
    els.findPlan.disabled = session.busy || session.approvalUnknown || ['uncertain', 'partial'].includes(session.state?.status);
    for (const field of [els.specification, els.quantity, els.budget, els.deadline, els.scenario]) field.disabled = session.busy;
    els.findPlan.setAttribute('aria-busy', String(session.busy));
    els.approvalCheck.disabled = !canApprove;
    els.approve.disabled = !canApprove || !els.approvalCheck.checked;
    els.approve.setAttribute('aria-busy', String(session.busy));
    els.reconcile.disabled = session.busy;
    const recoverable = ['uncertain', 'partial'].includes(session.state?.status) || session.approvalUnknown;
    els.reconcile.hidden = !recoverable;
    if (session.approvalUnknown) els.settlement.hidden = false;
  }

  async function api(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(path, {
        method, signal: controller.signal,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(session.secret ? { 'x-procurement-secret': session.secret } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'The supply desk could not complete that request. Try again.');
      return result;
    } catch (problem) {
      if (problem.name === 'AbortError') throw new Error('The supply desk did not answer in time.');
      throw problem;
    } finally {
      clearTimeout(timer);
    }
  }

  function renderQuotes(state) {
    const quotes = list(state?.quotes);
    const included = new Set(list(state?.proposal?.allocations).map((allocation) => allocation.supplierId));
    els.quotes.replaceChildren();
    els.emptyQuotes.hidden = Boolean(state);
    els.quoteResults.hidden = !state;
    for (const quote of quotes) {
      const row = node('tr', null, included.has(quote.supplierId) ? 'chosen' : '');
      const supplier = node('td');
      supplier.append(node('strong', quote.supplierName || 'Simulated supplier'));
      supplier.append(node('small', `${quote.quantity ?? quote.maxQuantity ?? '—'} shirts in this quote`));
      if (quote.negotiated) supplier.append(node('small', 'Negotiated quote'));
      if (included.has(quote.supplierId)) supplier.append(node('span', 'In this plan', 'quote-tag'));
      row.append(supplier, node('td', money(quote.unitPriceCents, quote.currency)), node('td', money(quote.setupCents, quote.currency)),
        node('td', money(quote.shippingCents, quote.currency)), node('td', money(quote.taxCents, quote.currency)));
      const total = node('td');
      total.append(node('strong', money(quote.totalCents, quote.currency)));
      total.append(node('small', `Expires ${date(quote.expiresAt)}`));
      const delivery = node('td', date(quote.deliveryAt));
      row.append(total, delivery);
      els.quotes.append(row);
    }
    els.quotesSummary.textContent = quotes.length
      ? `${quotes.length} simulated supplier quotes. Each total is for its quoted lot, including setup, shipping and tax.`
      : state ? 'No usable supplier quote was returned. Review the checks below or change the brief.' : 'All costs and delivery commitments stay visible. A cheaper unit price alone does not win.';
    const rejected = list(state?.rejections);
    els.rejections.hidden = rejected.length === 0;
    els.rejectionList.replaceChildren();
    for (const rejection of rejected) {
      const name = rejection.supplierName || quotes.find((quote) => quote.supplierId === rejection.supplierId)?.supplierName || rejection.supplierId || 'Supplier response';
      els.rejectionList.append(node('li', `${name}. ${rejection.reason || 'The quote did not meet the brief.'}`));
    }
  }

  function renderPlan(state) {
    const proposal = state?.proposal;
    const request = state?.request;
    els.stateLabel.textContent = statusNames[state?.status] || 'No plan yet';
    els.stateLabel.dataset.state = state?.status || '';
    els.planEmpty.hidden = Boolean(proposal);
    els.planDetails.hidden = !proposal;
    els.approvalForm.hidden = state?.status !== 'awaiting_approval';
    if (!proposal) {
      els.planEmpty.textContent = state?.status === 'no_feasible_quote'
        ? 'No available allocation meets every condition. Nothing was approved or paid. Change the brief to ask again.'
        : 'You will see the exact suppliers, quantities and total before anything is approved.';
      return;
    }
    els.planTotal.textContent = money(proposal.totalCents, proposal.currency);
    const remaining = request?.budgetCents - proposal.totalCents;
    els.planBudget.textContent = Number.isSafeInteger(remaining)
      ? `${money(remaining, proposal.currency)} remains within your ${money(request.budgetCents, proposal.currency)} limit.` : '';
    els.allocations.replaceChildren();
    for (const allocation of list(proposal.allocations)) {
      const item = node('li');
      item.append(node('strong', `${allocation.quantity} shirts from ${allocation.supplierName || allocation.supplierId}`),
        node('span', money(allocation.totalCents, proposal.currency)),
        node('span', `Goods ${money(allocation.goodsCents, proposal.currency)}, setup ${money(allocation.setupCents, proposal.currency)}, shipping ${money(allocation.shippingCents, proposal.currency)}, tax ${money(allocation.taxCents, proposal.currency)}. Delivery ${date(allocation.deliveryAt)}.`, 'allocation-detail'),
        node('span', `Simulated payee ${allocation.payeeId}. Quote ${allocation.quoteId}.`, 'allocation-payee'));
      els.allocations.append(item);
    }
    els.planExpiry.textContent = `Approval closes ${date(proposal.expiresAt)}. The server checks the terms again before settlement.`;
    els.termsSpecification.textContent = request?.specification || '';
    els.termsRequest.textContent = `${proposal.quantity} shirts, delivered by ${date(request?.deadline)}.`;
    els.termsHash.textContent = proposal.termsHash || '';
  }

  function renderSettlement(state) {
    const settlements = list(state?.settlements);
    els.settlement.hidden = settlements.length === 0 && !session.approvalUnknown;
    els.settlementList.replaceChildren();
    for (const payment of settlements) {
      const allocation = list(state?.proposal?.allocations).find((item) => item.supplierId === payment.supplierId);
      const item = node('li');
      item.append(node('span', `${allocation?.supplierName || payment.supplierId}, ${payment.quantity ?? allocation?.quantity ?? '—'} shirts`),
        node('span', `${money(payment.amountCents, state?.request?.currency || 'USD')}. ${settlementNames[payment.status] || String(payment.status || 'Not attempted').replaceAll('_', ' ')}.`));
      els.settlementList.append(item);
    }
    const notes = {
      completed: 'All simulated supplier payments are confirmed. No real payment or goods order was made.',
      partial: 'Only part of this simulated order settled. A confirmed payment is not an automatic rollback. Check each supplier result before continuing.',
      uncertain: 'At least one mock payment has no confirmed result. The agent rechecks it before continuing any still-valid, originally approved supplier payments. It never replaces a supplier or repeats an uncertain payment as a new purchase.',
      failed: 'The simulated purchase did not complete. Review the supplier results and activity below.',
    };
    els.settlementNote.textContent = session.approvalUnknown
      ? 'The purchase request did not return clearly. It may have reached the server. Check its result before taking another action.' : notes[state?.status] || '';
  }

  function renderTimeline(state) {
    const events = list(state?.timeline);
    els.timelineEmpty.hidden = events.length > 0;
    els.timeline.replaceChildren();
    for (const event of events) {
      const item = node('li');
      const time = node('time', date(event.at));
      if (event.at && Number.isFinite(new Date(event.at).getTime())) time.dateTime = new Date(event.at).toISOString();
      item.append(node('p', event.message || String(event.type || 'Record').replaceAll('_', ' ')), time);
      els.timeline.append(item);
    }
  }

  function render(state) {
    session.state = state;
    renderQuotes(state);
    renderPlan(state);
    renderSettlement(state);
    renderTimeline(state);
    updateControls();
  }

  function readBrief() {
    const budget = els.budget.value.trim();
    const quantity = Number(els.quantity.value);
    const budgetCents = Math.round(Number(budget) * 100);
    const deadline = new Date(els.deadline.value);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 500) throw new Error('Enter a whole quantity from 1 to 500.');
    if (!/^\d+(?:\.\d{1,2})?$/.test(budget) || !Number.isSafeInteger(budgetCents) || budgetCents < 100 || budgetCents > 10000000) throw new Error('Enter a budget from $1 to $100,000, with no more than two decimal places.');
    if (!Number.isFinite(deadline.getTime()) || deadline.getTime() <= Date.now()) throw new Error('Choose a delivery deadline in the future.');
    const specification = els.specification.value.trim();
    if (!specification) throw new Error('Describe the shirts and printing you need.');
    return { quantity, budgetCents, currency: 'USD', deadline: deadline.toISOString(), specification, scenario: els.scenario.value };
  }

  els.request.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (session.busy || session.approvalUnknown || ['uncertain', 'partial'].includes(session.state?.status)) return;
    let brief;
    try { brief = readBrief(); } catch (problem) { error(problem.message); return; }
    error('');
    session.busy = true;
    session.id = null;
    session.secret = null;
    session.briefChanged = false;
    session.approvalUnknown = false;
    els.approvalCheck.checked = false;
    render(null);
    els.requestStatus.textContent = 'Asking simulated suppliers, negotiating quotes and checking your limits.';
    try {
      const result = await api('/api/procurement', { method: 'POST', body: brief });
      if (!result.id || !result.sessionSecret || !result.state) throw new Error('The server did not return a complete order session. Find a new plan to try again.');
      session.id = result.id;
      session.secret = result.sessionSecret;
      render(result.state);
      els.requestStatus.textContent = result.state.status === 'no_feasible_quote'
        ? 'No plan fits the brief. No purchase was made.' : 'A plan is ready to review. Approval applies only to the exact terms shown.';
      els.planPanel.focus();
    } catch (problem) {
      error(problem.message);
      els.requestStatus.textContent = 'No plan is ready for approval. Check the brief and try again.';
    } finally {
      session.busy = false;
      updateControls();
    }
  });

  els.approvalForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const proposal = session.state?.proposal;
    if (els.approve.disabled || !session.id || !proposal) return;
    session.busy = true;
    error('');
    updateControls();
    els.requestStatus.textContent = 'Checking the approved terms and attempting mock supplier settlement.';
    try {
      const result = await api(`/api/procurement/${encodeURIComponent(session.id)}/approve`, {
        method: 'POST', body: { confirmationToken: proposal.confirmationToken, termsHash: proposal.termsHash },
      });
      if (!result.state) throw new Error('The server did not return the purchase result.');
      els.approvalCheck.checked = false;
      render(result.state);
      els.requestStatus.textContent = statusNames[result.state.status] || 'The simulated purchase result is shown below.';
    } catch (problem) {
      session.approvalUnknown = true;
      error(problem.message);
      els.requestStatus.textContent = 'The approval answer is unclear. Check the existing result before trying another purchase.';
      renderSettlement(session.state);
    } finally {
      session.busy = false;
      updateControls();
    }
  });

  els.reconcile.addEventListener('click', async () => {
    if (!session.id || session.busy) return;
    session.busy = true;
    error('');
    updateControls();
    els.requestStatus.textContent = 'Rechecking existing mock payments before continuing any still-valid parts of your approved plan. No replacement supplier is approved.';
    try {
      const result = await api(`/api/procurement/${encodeURIComponent(session.id)}/reconcile`, { method: 'POST', body: {} });
      if (!result.state) throw new Error('The server did not return the existing purchase result.');
      session.approvalUnknown = false;
      render(result.state);
      els.requestStatus.textContent = statusNames[result.state.status] || 'The current result is shown below.';
    } catch (problem) {
      error(problem.message);
      els.requestStatus.textContent = 'The result is still unclear. Leave this order open and check again later.';
    } finally {
      session.busy = false;
      updateControls();
    }
  });

  els.approvalCheck.addEventListener('change', updateControls);
  els.request.addEventListener('input', () => {
    if (!session.state) return;
    session.briefChanged = true;
    els.approvalCheck.checked = false;
    els.requestStatus.textContent = 'Your brief changed. Find a new plan before approving a purchase.';
    updateControls();
  });
  els.scenario.addEventListener('change', () => {
    if (!session.state) return;
    session.briefChanged = true;
    els.approvalCheck.checked = false;
    els.requestStatus.textContent = 'The scenario changed. Find a new plan to run it.';
    updateControls();
  });

  // A useful example every time the demo is opened, rather than a hard-coded date that expires before judging.
  const nextFriday = new Date();
  let days = (5 - nextFriday.getDay() + 7) % 7;
  if (days === 0) days = 7;
  nextFriday.setDate(nextFriday.getDate() + days);
  nextFriday.setHours(17, 0, 0, 0);
  // Keep the initial example feasible even late on Wednesday or Thursday. A buyer can choose an earlier date;
  // the solver will then reject suppliers that cannot actually meet it.
  if (nextFriday.getTime() - Date.now() < 3 * 86400000) nextFriday.setDate(nextFriday.getDate() + 7);
  const pad = (value) => String(value).padStart(2, '0');
  els.deadline.value = `${nextFriday.getFullYear()}-${pad(nextFriday.getMonth() + 1)}-${pad(nextFriday.getDate())}T17:00`;
  setInterval(() => {
    if (session.state?.status !== 'awaiting_approval' || !approvalExpired() || session.busy) return;
    els.stateLabel.textContent = 'Plan expired';
    els.stateLabel.dataset.state = 'expired';
    els.planExpiry.textContent = 'This approval window has closed. Find a new plan to refresh the supplier terms.';
    updateControls();
  }, 1000);
  updateControls();
})();
