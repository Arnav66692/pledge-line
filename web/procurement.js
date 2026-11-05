(() => {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const els = Object.fromEntries(['request', 'specification', 'quantity', 'budget', 'deadline', 'allow-split', 'scenario', 'find-plan', 'request-status', 'error',
    'goal-intake', 'goal', 'draft-goal', 'goal-status', 'goal-assumptions',
    'quotes-summary', 'quotes-caption', 'empty-quotes', 'quote-results', 'quotes', 'rejections', 'rejection-list', 'plan-panel', 'state-label', 'plan-empty',
    'plan-details', 'plan-total', 'plan-budget', 'allocations', 'plan-expiry', 'terms-specification', 'terms-request', 'terms-disclosure', 'terms-hash',
    'approval-form', 'approval-check', 'approval-consent', 'approve', 'settlement', 'settlement-title', 'settlement-list', 'settlement-note',
    'checkout-legs', 'checkout-blocked', 'prepare-checkout', 'reconcile', 'close-unpaid', 'timeline-empty', 'timeline', 'timeline-label', 'demo-disclosure',
    'demo-controls', 'commerce-panel', 'commerce-status', 'refresh-commerce', 'comparison', 'comparison-baseline', 'comparison-negotiated',
    'comparison-saving', 'comparison-scope', 'price-guard', 'price-guard-baseline', 'price-guard-model', 'price-guard-selected', 'price-guard-note',
    'review-panel', 'review-note', 'review-reasons', 'review-check-details', 'review-checks',
    'negotiation-trace-panel', 'negotiation-trace-summary', 'negotiation-trace-rounds', 'negotiation-trace-allocation']
    .map((id) => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), byId(id)]));
  const configuredMode = document.body?.dataset?.payments || 'mock';
  const storageKey = 'pledge-line.procurement.sandbox.v1';
  const session = { id: null, secret: null, state: null, busy: false, briefChanged: false, approvalUnknown: false,
    restoreBlocked: false, restoreRetryable: false, commerce: { payments: configuredMode, sandboxWritesEnabled: false }, legControls: [] };
  let briefRevision = 0;
  const networkMode = () => configuredMode === 'paypal-sandbox';
  const list = (value) => Array.isArray(value) ? value : [];
  function localDeadlineValue(deadline) {
    const pad = (value, length = 2) => String(value).padStart(length, '0');
    return `${deadline.getFullYear()}-${pad(deadline.getMonth() + 1)}-${pad(deadline.getDate())}T${pad(deadline.getHours())}:${pad(deadline.getMinutes())}:${pad(deadline.getSeconds())}${deadline.getMilliseconds() ? `.${pad(deadline.getMilliseconds(), 3)}` : ''}`;
  }
  const money = (cents, currency = 'USD') => Number.isSafeInteger(cents)
    ? new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100) : 'Not provided';
  const date = (value, timeZone) => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', ...(timeZone ? { timeZone } : {}) }).format(parsed) : 'Not provided';
  };
  const statusNames = Object.freeze({ awaiting_approval: 'Review the plan', no_feasible_quote: 'No plan fits', awaiting_checkout: 'Sandbox checkout ready', awaiting_paypal_approval: 'PayPal buyer approval needed', ready_to_capture: 'Ready for sandbox capture', completed: networkMode() ? 'Sandbox captures confirmed' : 'Mock order completed', partial: 'Partially settled', uncertain: 'Result uncertain', failed: 'Settlement failed', expired: 'Plan expired', closed_unpaid: 'Expired plan closed in this app' });
  const legNames = Object.freeze({ awaiting_checkout: 'Order not created', awaiting_paypal_approval: 'Buyer approval needed in PayPal sandbox', ready_to_capture: 'PayPal approval verified; capture needed', confirmed: 'Sandbox capture confirmed', uncertain: 'Result uncertain; recheck before continuing', closed_unpaid: 'Closed in this app. No capture attempted' });
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

  function unfinishedPurchase() {
    const state = session.state;
    if (state?.status === 'closed_unpaid' && state.checkout?.blockedReason === 'closed_unpaid' &&
      list(state.checkout.legs).length > 0 && state.checkout.legs.every((leg) => leg.status === 'closed_unpaid')) return false;
    if (['partial', 'uncertain'].includes(state?.status)) return true;
    if (!networkMode()) return false;
    const legs = list(state?.checkout?.legs);
    return Boolean(state?.checkout || ['awaiting_checkout', 'awaiting_paypal_approval', 'ready_to_capture'].includes(state?.status)) &&
      (state?.status !== 'completed' || legs.some((leg) => leg.status !== 'confirmed'));
  }

  const newPlanBlocked = () => session.busy || session.approvalUnknown || session.restoreBlocked || unfinishedPurchase();
  const nextLeg = () => list(session.state?.checkout?.legs).find((leg) => leg.status !== 'confirmed');
  const sandboxWritesAllowed = () => networkMode() && session.commerce?.sandboxWritesEnabled === true && !session.restoreBlocked;
  const placeholderMerchants = () => networkMode() && session.commerce?.sandboxWriteBlockedReason === 'placeholder_merchants';
  const statusName = (status) => status === 'awaiting_checkout' && session.commerce?.sandboxWritesEnabled !== true && networkMode()
    ? placeholderMerchants() ? 'Lab plan saved' : 'Plan saved; checkout unavailable' : statusNames[status];

  function approvalHref(leg) {
    if (typeof leg.orderId !== 'string' || !leg.orderId || typeof leg.approvalUrl !== 'string') return null;
    try {
      const url = new URL(leg.approvalUrl);
      const expected = `https://www.sandbox.paypal.com/checkoutnow?token=${encodeURIComponent(leg.orderId)}`;
      return url.protocol === 'https:' && url.hostname === 'www.sandbox.paypal.com' && !url.port &&
        !url.username && !url.password && !url.hash && url.pathname === '/checkoutnow' &&
        url.searchParams.size === 1 && url.searchParams.get('token') === leg.orderId &&
        leg.approvalUrl === expected ? expected : null;
    } catch { return null; }
  }

  function saveSession() {
    if (!networkMode() || !session.id || !session.secret) return;
    try {
      const record = JSON.stringify({ id: session.id, secret: session.secret });
      window.sessionStorage.setItem(storageKey, record);
      if (window.sessionStorage.getItem(storageKey) !== record) throw new Error('Storage did not retain the key.');
    } catch {
      throw new Error('This tab could not save its checkout key in session storage. Enable session storage before approving or opening PayPal, so you can safely resume this order.');
    }
  }

  function applyResult(result) {
    if (!result?.state) throw new Error('The server did not return the existing purchase result.');
    const mode = result.state.mode?.payments || 'mock';
    if (mode !== configuredMode || (result.state.id && session.id && result.state.id !== session.id)) {
      session.restoreBlocked = true;
      session.restoreRetryable = false;
      const problem = new Error('The server returned a different checkout mode or order. Keep this tab open and restore the original server configuration before reloading this page.');
      problem.unsafeRestore = true;
      throw problem;
    }
    if (result.commerce) applyCommerce(result.commerce);
    render(result.state);
  }

  function applyCommerce(commerce) {
    if (commerce?.payments && commerce.payments !== configuredMode) {
      session.restoreBlocked = true;
      session.restoreRetryable = false;
      const problem = new Error('The server checkout mode changed. Restore the original mode and reload this page before starting another purchase.');
      problem.unsafeRestore = true;
      throw problem;
    }
    session.commerce = commerce || session.commerce;
    renderCommerce();
    if (session.state) render(session.state);
  }

  function renderCommerce() {
    els.commercePanel.hidden = !networkMode();
    els.demoControls.hidden = networkMode();
    if (!networkMode()) return;
    const placeholders = placeholderMerchants();
    els.demoDisclosure.textContent = placeholders
      ? 'Controlled sandbox supplier lab with placeholder merchant IDs. Checkout is unavailable until authorized PayPal sandbox merchants are configured. No independent businesses participate and no goods fulfillment is promised. Test funds only: no real money moves.'
      : 'MCP sandbox suppliers and PayPal sandbox checkout. Test funds only: no real money moves. These endpoints are not independent businesses or promises of goods fulfillment.';
    els.timelineLabel.textContent = 'Sandbox records';
    els.quotesCaption.textContent = placeholders
      ? 'Controlled supplier lab quotes with placeholder merchant IDs. Totals include all fees for the quoted quantity. No independent business participation or fulfillment.'
      : 'MCP sandbox supplier quotes. Totals are for the quoted quantity, including all fees. These are sandbox endpoints, not independent businesses.';
    els.approvalConsent.textContent = placeholders
      ? 'I approve and save these exact lab suppliers, quantities, delivery terms and total. Their payees use placeholder merchant IDs. Saving this plan cannot create PayPal orders or move test funds while checkout is unavailable. PayPal buyer approval and a separate capture would still be required for each authorized sandbox merchant.'
      : 'I approve these registered sandbox payees, quantities, delivery terms and this exact total. Approval saves these terms and creates PayPal sandbox checkout orders when server writes are enabled. Each supplier still needs buyer approval in PayPal sandbox before a separate capture.';
    els.approve.textContent = placeholders ? 'Save lab plan' : 'Approve plan and prepare PayPal checkout';
    const unlockAt = session.commerce?.sandboxWriteUnlockAt;
    const blockedReason = session.commerce?.sandboxWriteBlockedReason;
    if (sandboxWritesAllowed()) {
      els.commerceStatus.textContent = 'The server allows sandbox order creation and capture. Buyer approval is required for each supplier. Test funds only.';
    } else if (placeholders) {
      els.commerceStatus.textContent = 'Sandbox order creation and capture are disabled because this lab uses placeholder merchant IDs. The operator must configure authorized PayPal sandbox merchants before checkout can be enabled. Passing the time gate alone will not enable checkout. You can save a lab plan and recheck status; neither action moves funds.';
    } else if (blockedReason === 'operator_disabled') {
      els.commerceStatus.textContent = 'Sandbox order creation and capture are disabled by the operator. Refresh availability after the operator enables checkout. Quotes and status checks do not authorize a payment.';
    } else if (blockedReason === 'time_gate') {
      els.commerceStatus.textContent = `Sandbox order creation and capture are disabled by the server's time gate.${unlockAt ? ` Earliest permitted time: ${date(unlockAt, 'America/Los_Angeles')} (Pacific time).` : ''} Refresh availability to check the server status. Other checkout requirements still apply. Quotes and status checks do not authorize a payment.`;
    } else {
      els.commerceStatus.textContent = 'Sandbox order creation and capture are disabled by the server. Refresh availability to check the server status. Quotes and status checks do not authorize a payment.';
    }
  }

  function updateControls() {
    const canApprove = session.state?.status === 'awaiting_approval' && session.state?.proposal && !session.busy && !session.restoreBlocked &&
      !session.briefChanged && !session.approvalUnknown && !approvalExpired();
    // Keep this order in view until an uncertain payment is reconciled. Starting another session must not become
    // an accidental way to repeat a purchase whose first answer was lost.
    els.findPlan.disabled = newPlanBlocked();
    for (const field of [els.specification, els.quantity, els.budget, els.deadline, els.allowSplit, els.scenario]) field.disabled = session.busy || (networkMode() && unfinishedPurchase());
    els.goal.disabled = newPlanBlocked();
    els.draftGoal.disabled = newPlanBlocked() || !els.goal.value.trim() || els.goal.value.length > 1000;
    els.draftGoal.setAttribute('aria-busy', String(session.busy));
    els.findPlan.setAttribute('aria-busy', String(session.busy));
    els.approvalCheck.disabled = !canApprove;
    els.approve.disabled = !canApprove || !els.approvalCheck.checked;
    els.approve.setAttribute('aria-busy', String(session.busy));
    els.refreshCommerce.disabled = session.busy || (session.restoreBlocked && !session.restoreRetryable);
    els.refreshCommerce.textContent = session.restoreRetryable ? 'Retry checkout restore' : 'Refresh availability';
    els.reconcile.disabled = session.busy || session.restoreBlocked;
    const recoverable = (networkMode() && session.id) || ['uncertain', 'partial'].includes(session.state?.status) || session.approvalUnknown;
    els.reconcile.hidden = !recoverable;
    const unprepared = list(session.state?.checkout?.legs).some((leg) => leg.status === 'awaiting_checkout' && !leg.orderId);
    els.prepareCheckout.hidden = !networkMode() || !unprepared || ['awaiting_approval', 'closed_unpaid'].includes(session.state?.status);
    els.prepareCheckout.disabled = !sandboxWritesAllowed() || session.busy || session.approvalUnknown || approvalExpired() || session.restoreBlocked || Boolean(session.state?.checkout?.blockedReason) || session.state?.status === 'uncertain';
    const canCloseUnpaid = networkMode() && session.id && session.state?.status === 'expired' && session.state?.checkout?.canCloseUnpaid === true && approvalExpired();
    els.closeUnpaid.hidden = !canCloseUnpaid;
    els.closeUnpaid.disabled = !canCloseUnpaid || session.busy || session.restoreBlocked || session.approvalUnknown;
    for (const control of session.legControls) {
      const active = nextLeg()?.id === control.leg.id && sandboxWritesAllowed() && !session.busy && !session.approvalUnknown && !session.state?.checkout?.blockedReason && !['uncertain', 'closed_unpaid'].includes(session.state?.status) && !approvalExpired();
      if (control.link) {
        if (active && control.href) control.link.setAttribute('href', control.href);
        else control.link.removeAttribute('href');
        control.link.setAttribute('aria-disabled', String(!active || !control.href));
      }
      if (control.capture) control.capture.disabled = !active || control.leg.status !== 'ready_to_capture';
    }
    if (session.approvalUnknown || (networkMode() && session.id)) els.settlement.hidden = false;
  }

  async function api(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), method === 'GET' ? 15000 : 45000);
    try {
      const response = await fetch(path, {
        method, signal: controller.signal,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(session.secret && path.startsWith('/api/procurement/') && path !== '/api/procurement/interpret' ? { 'x-procurement-secret': session.secret } : {}) },
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
      supplier.append(node('strong', quote.supplierName || (networkMode() ? 'MCP sandbox supplier' : 'Simulated supplier')));
      if (networkMode()) supplier.append(node('small', placeholderMerchants() ? 'Controlled supplier lab; placeholder merchant ID' : 'MCP sandbox supplier'));
      supplier.append(node('small', `${quote.quantity ?? quote.maxQuantity ?? '—'} shirts in this quote`));
      if (quote.negotiated) supplier.append(node('small', 'Negotiated quote'));
      if (Number.isSafeInteger(quote.counterOfferCents)) supplier.append(node('small', `Agent offered ${money(quote.counterOfferCents, quote.currency)} per shirt. Chosen quote is ${money(quote.unitPriceCents, quote.currency)} per shirt.`));
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
      ? `${quotes.length} ${networkMode() ? 'MCP sandbox' : 'simulated'} supplier quotes. Each total is for its quoted lot, including setup, shipping and tax.`
      : state?.proposal ? 'The exact plan is retained below. The original quote sheet is not available in this restored session.'
        : state ? 'No usable supplier quote was returned. Review the checks below or change the brief.' : 'All costs and delivery commitments stay visible. A cheaper unit price alone does not win.';
    const rejected = list(state?.rejections);
    els.rejections.hidden = rejected.length === 0;
    els.rejectionList.replaceChildren();
    for (const rejection of rejected) {
      const name = rejection.supplierName || quotes.find((quote) => quote.supplierId === rejection.supplierId)?.supplierName || rejection.supplierId || 'Supplier response';
      els.rejectionList.append(node('li', `${name}. ${rejection.reason || 'The quote did not meet the brief.'}`));
    }
    const comparison = state?.comparison;
    const hasComparison = comparison && ['baselineTotalCents', 'negotiatedTotalCents', 'savingsCents'].every((key) => Number.isSafeInteger(comparison[key]));
    els.comparison.hidden = !hasComparison;
    if (hasComparison) {
      const currency = state.request?.currency || 'USD';
      els.comparisonBaseline.textContent = money(comparison.baselineTotalCents, currency);
      els.comparisonNegotiated.textContent = money(comparison.negotiatedTotalCents, currency);
      els.comparisonSaving.textContent = money(comparison.savingsCents, currency);
      els.comparisonScope.textContent = `This order only. The baseline ${comparison.baselineWithinBudget ? 'fits' : 'exceeds'} the requested budget.${typeof comparison.scope === 'string' ? ` ${comparison.scope}` : ''} This comparison is not a claim of general savings.`;
    }
  }

  function renderPlan(state) {
    const proposal = state?.proposal;
    const request = state?.request;
    els.stateLabel.textContent = statusName(state?.status) || 'No plan yet';
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
        node('span', `${networkMode() ? placeholderMerchants() ? 'Placeholder sandbox payee' : 'Registered sandbox payee' : 'Simulated payee'} ${allocation.payeeId}. Quote ${allocation.quoteId}.`, 'allocation-payee'));
      els.allocations.append(item);
    }
    els.planExpiry.textContent = `Terms expire ${date(proposal.expiresAt)}. The server checks the terms again before settlement. Status rechecks remain available after expiry.`;
    els.termsSpecification.textContent = request?.specification || '';
    els.termsRequest.textContent = `${proposal.quantity} shirts, delivered by ${date(request?.deadline)}.`;
    els.termsDisclosure.textContent = typeof proposal.disclosure === 'string' ? proposal.disclosure : networkMode() ? 'MCP sandbox supplier and PayPal sandbox demonstration. Test funds only.' : 'Simulated supplier and payment demonstration.';
    if (placeholderMerchants()) els.termsDisclosure.textContent += ' Controlled supplier lab: payees use placeholder merchant IDs. Checkout is unavailable until authorized PayPal sandbox merchants are configured.';
    els.termsHash.textContent = proposal.termsHash || '';
    const review = state?.review;
    const reviewText = typeof review === 'string' ? review : review?.summary || review?.message || review?.recommendation ||
      (review?.decision === 'within_limits' ? 'The advisory model found the supplied plan within the stated limits. This does not grant payment permission.'
        : review?.decision === 'needs_review' ? 'The advisory model flagged this plan for closer review. Inspect its exact terms before deciding whether to approve.' : '');
    els.reviewPanel.hidden = typeof reviewText !== 'string' || !reviewText;
    els.reviewNote.textContent = typeof reviewText === 'string' ? reviewText : '';
    const reasons = list(review?.reasons).slice(0, 12);
    els.reviewReasons.hidden = !reasons.length;
    els.reviewReasons.replaceChildren();
    for (const reason of reasons) {
      const code = typeof reason?.code === 'string' && /^[A-Z_]{1,48}$/.test(reason.code) ? reason.code : 'REVIEW_DETAIL_UNAVAILABLE';
      const message = typeof reason?.message === 'string' ? reason.message.slice(0, 300) : 'Inspect the exact plan evidence.';
      const item = node('li');
      item.append(node('strong', code.replaceAll('_', ' ')), node('span', message));
      if (code === 'JEV_LOW_CONFIDENCE' && Number.isFinite(reason.evidence?.confidence) && reason.evidence.confidence >= 0 && reason.evidence.confidence <= 1) {
        item.append(node('span', `Reported confidence: ${Math.round(reason.evidence.confidence * 100)}%.`, 'field-hint'));
      }
      els.reviewReasons.append(item);
    }
    const checks = list(review?.checks).slice(0, 9);
    els.reviewCheckDetails.hidden = !checks.length;
    els.reviewChecks.replaceChildren();
    for (const check of checks) {
      const label = typeof check?.label === 'string' ? check.label.slice(0, 80) : 'Evidence check';
      const status = check?.status === 'pass' ? 'Matches supplied evidence' : check?.status === 'fail' ? 'Mismatch found' : 'Evidence incomplete';
      const item = node('li', `${label}: ${status}.`);
      item.dataset.status = ['pass', 'fail'].includes(check?.status) ? check.status : 'unverified';
      els.reviewChecks.append(item);
    }
  }

  function renderNegotiationTrace(state) {
    const trace = state?.negotiationTrace;
    const rounds = trace?.version === 1 ? list(trace.supplierRounds).filter((round) => round && typeof round === 'object' && !Array.isArray(round)).slice(0, 5) : [];
    const guard = trace?.priceGuard;
    const guardAmount = (value) => Number.isSafeInteger(value) && value > 0 && value <= 100000000;
    const selectedTotal = trace?.allocation?.totalCents;
    const guardLegs = list(trace?.allocation?.allocations);
    const completeAllocation = trace?.version === 1 && trace.allocation?.status === 'feasible' && guardLegs.length > 0 && guardLegs.length <= 5 &&
      guardLegs.every((leg) => Number.isSafeInteger(leg?.quantity) && leg.quantity > 0 && leg.quantity <= 500 && guardAmount(leg.totalCents)) &&
      guardLegs.reduce((sum, leg) => sum + leg.quantity, 0) === state?.request?.quantity &&
      guardLegs.reduce((sum, leg) => sum + leg.totalCents, 0) === selectedTotal;
    const completeComparison = completeAllocation && guard && guardAmount(guard.baselineTotalCents) && guardAmount(guard.agentTotalCents) && guardAmount(selectedTotal) &&
      selectedTotal === state?.proposal?.totalCents && Number.isSafeInteger(guard.avoidedCents) && guard.avoidedCents >= 0 &&
      guard.avoidedCents === guard.agentTotalCents - selectedTotal &&
      (guard.selectedSource === 'baseline' && selectedTotal === guard.baselineTotalCents && guard.baselineTotalCents <= guard.agentTotalCents ||
        guard.selectedSource === 'agent' && selectedTotal === guard.agentTotalCents && guard.agentTotalCents < guard.baselineTotalCents ||
        guard.selectedSource === 'hybrid' && selectedTotal < guard.baselineTotalCents && selectedTotal < guard.agentTotalCents);
    els.priceGuard.hidden = !completeComparison;
    if (completeComparison) {
      els.priceGuardBaseline.textContent = money(guard.baselineTotalCents);
      els.priceGuardModel.textContent = money(guard.agentTotalCents);
      els.priceGuardSelected.textContent = money(selectedTotal);
      els.priceGuardNote.textContent = guard.selectedSource === 'baseline'
        ? guard.avoidedCents > 0
          ? `The verified deterministic negotiated plan costs ${money(guard.avoidedCents)} less than the AI alternative, so it was selected. No extra purchase was created by this comparison.`
          : 'Both verified portfolios have the same complete-order total. The deterministic negotiated plan was retained on the tie.'
        : guard.selectedSource === 'hybrid'
          ? 'Combining validated quotes from both portfolios produced a lower complete-order total. The solver uses at most one quote per supplier. This is a code-selected combination, not proof of AI-specific savings.'
          : 'The verified AI negotiated portfolio has the lower complete-order total for these supplied quotes, so it was selected. This result applies only to this request.';
    }
    els.negotiationTracePanel.hidden = !rounds.length;
    els.negotiationTraceRounds.replaceChildren();
    if (!rounds.length) return;
    els.negotiationTraceSummary.textContent = 'Compare the initial offer, the proposed counteroffer and the supplier response. Only accepted quote terms can enter the exact plan. ' +
      (networkMode() ? 'Approving a sandbox checkout retains this evidence across restart.' : 'This simulated session remains in memory.');
    const rationales = { volume: 'Volume discount', split_order: 'Split-order price', deadline: 'Delivery timing', budget: 'All-in budget' };
    const outcomes = { accepted_response: 'Model-negotiated response retained', accepted_baseline: 'Deterministic negotiated quote retained', kept_initial: 'Initial quote retained', rejected: 'Quote rejected' };
    for (const round of rounds) {
      const item = node('li');
      const name = typeof round?.supplierName === 'string' ? round.supplierName.slice(0, 100) : String(round?.supplierId || 'Supplier').slice(0, 48);
      item.append(node('h3', name));
      const quoteLine = (label, quote) => {
        if (!quote) return `${label}: no valid quote retained.`;
        const reference = typeof quote.quoteId === 'string' ? quote.quoteId.slice(0, 120) : 'unavailable';
        return `${label}: ${money(quote.unitPriceCents)} per unit; setup ${money(quote.setupCents)}, shipping ${money(quote.shippingCents)}, tax ${Number.isInteger(quote.taxBps) ? quote.taxBps / 100 : 'unavailable'}%. ${Number.isSafeInteger(quote.maxQuantity) ? `All-in for this quote's ${quote.maxQuantity}-unit maximum: ${money(quote.totalCents)}. ` : ''}Delivery ${date(quote.deliveryAt)}. Quote ${reference}.`;
      };
      item.append(node('p', quoteLine('Initial offer', round.initialQuote)));
      if (round.baselineQuote) item.append(node('p', quoteLine('Deterministic negotiation response', round.baselineQuote)));
      item.append(node('p', round.counteroffer
        ? `${round.counteroffer.source === 'anthropic' ? 'Anthropic' : 'Main agent'} counteroffer: ${money(round.counteroffer.unitPriceCents)} per unit. Rationale: ${rationales[round.counteroffer.rationale] || 'Not provided'}. This suggestion is not a supplier commitment.`
        : 'No model counteroffer was sent for this supplier.'));
      item.append(node('p', quoteLine(round.counteroffer ? 'Response to model counteroffer' : 'Reused default-policy response', round.responseQuote)));
      if (typeof round.acceptedQuoteId === 'string' && /^[A-Za-z0-9-]{1,120}$/.test(round.acceptedQuoteId)) {
        item.append(node('p', `Retained quote reference: ${round.acceptedQuoteId}.`, 'field-hint'));
      }
      const reason = typeof round.reasonCode === 'string' && /^[A-Za-z_]{1,60}$/.test(round.reasonCode) ? round.reasonCode.replaceAll('_', ' ').toLowerCase() : 'See the quote terms';
      item.append(node('p', `${outcomes[round.outcome] || 'Outcome unavailable'}. ${round.selectedForAllocation === true ? 'Selected for the complete allocation.' : 'Not selected for the complete allocation.'} Reason: ${reason}.`, 'field-hint'));
      els.negotiationTraceRounds.append(item);
    }
    const selected = list(trace.allocation?.allocations).filter((leg) => leg && typeof leg === 'object' && !Array.isArray(leg)).slice(0, 5);
    els.negotiationTraceAllocation.textContent = trace.allocation?.status === 'feasible'
      ? `Complete allocation: ${selected.map((leg) => `${Number.isSafeInteger(leg.quantity) ? leg.quantity : '?'} units from ${String(leg.supplierId || 'supplier').slice(0, 48)}`).join('; ')}. All-in total ${money(trace.allocation.totalCents)}.`
      : 'No complete allocation met the request. No purchase is authorized by this trace.';
  }

  function renderCheckout(state) {
    session.legControls = [];
    const legs = list(state?.checkout?.legs);
    els.checkoutLegs.hidden = !networkMode() || !legs.length;
    els.checkoutLegs.replaceChildren();
    if (!networkMode()) return;
    els.settlementTitle.textContent = 'Supplier sandbox checkout';
    els.reconcile.textContent = 'Recheck PayPal sandbox status';
    const blockedReason = state?.checkout?.blockedReason;
    els.checkoutBlocked.hidden = !blockedReason;
    els.checkoutBlocked.textContent = blockedReason === 'closed_unpaid' ? 'Closed in this app. PayPal orders were not canceled.' : typeof blockedReason === 'string' ? blockedReason : '';
    for (const leg of legs) {
      const item = node('li', null, 'checkout-leg');
      item.append(node('strong', `${leg.supplierName || leg.supplierId}, ${leg.quantity} shirts`),
        node('span', `${money(leg.amountCents, leg.currency || 'USD')}. ${legNames[leg.status] || 'Status must be rechecked'}.`, 'checkout-leg-status'),
        node('span', placeholderMerchants() ? 'Controlled supplier lab; placeholder merchant ID. Checkout unavailable. No goods fulfillment.' : 'MCP sandbox supplier. Test funds; no goods fulfillment.', 'field-hint'));
      if (leg.orderId) item.append(node('span', `PayPal sandbox order ${leg.orderId}${leg.captureId ? `. Capture ${leg.captureId}` : ''}.`, 'allocation-payee'));
      const control = { leg };
      if (leg.status === 'awaiting_paypal_approval') {
        const href = approvalHref(leg);
        if (href) {
          const link = node('a', `Approve ${leg.supplierName || leg.supplierId} in PayPal sandbox`, 'button secondary checkout-link');
          link.addEventListener('click', (event) => {
            if (!sandboxWritesAllowed() || session.busy || session.approvalUnknown || session.restoreBlocked || session.state?.checkout?.blockedReason || session.state?.status === 'uncertain' || approvalExpired() || nextLeg()?.id !== leg.id) { event.preventDefault(); return; }
            try { saveSession(); } catch (problem) { event.preventDefault(); error(problem.message); }
          });
          control.link = link;
          control.href = href;
          item.append(link, node('p', 'Opens in this tab. Return here, recheck the PayPal status, then capture only after approval is verified. Returning or cancelling does not confirm payment.', 'field-hint'));
        } else {
          item.append(node('p', 'The server did not provide a valid PayPal sandbox approval link for this order. Recheck the existing order; do not use an alternative payment link.', 'error'));
        }
      }
      if (leg.status === 'ready_to_capture') {
        const capture = node('button', `Capture ${money(leg.amountCents, leg.currency || 'USD')} in sandbox`, 'button primary');
        capture.setAttribute('type', 'button');
        capture.addEventListener('click', () => captureLeg(leg.id));
        control.capture = capture;
        item.append(capture);
      }
      if (state?.status !== 'closed_unpaid' && leg !== nextLeg() && leg.status !== 'confirmed') item.append(node('p', 'Finish or reconcile the previous supplier before continuing this leg.', 'field-hint'));
      session.legControls.push(control);
      els.checkoutLegs.append(item);
    }
  }

  function renderSettlement(state) {
    const settlements = list(state?.settlements);
    els.settlement.hidden = settlements.length === 0 && !session.approvalUnknown && !(networkMode() && session.id);
    els.settlementList.hidden = networkMode();
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
    if (networkMode() && !session.approvalUnknown) {
      const networkNotes = {
        awaiting_approval: placeholderMerchants() ? 'Save the exact lab plan for review. Placeholder merchants cannot receive PayPal sandbox orders or captures. Authorized sandbox merchants must be configured before checkout can be enabled.' : 'Approval saves the exact terms and, when server writes are enabled, creates sandbox checkout orders. No payment occurs until PayPal buyer approval and a separate capture.',
        awaiting_checkout: placeholderMerchants() ? 'The exact lab plan is saved. Checkout remains unavailable until authorized PayPal sandbox merchants are configured. Passing the time gate alone will not enable checkout.' : 'Create the sandbox orders explicitly, then approve each supplier in PayPal sandbox. Each capture is a separate action with a fresh provider status check.',
        awaiting_paypal_approval: 'PayPal buyer approval is required per supplier. After returning, recheck status before capture. A return URL or checkbox is not evidence of payment.',
        ready_to_capture: 'PayPal buyer approval has been verified. Capture the next supplier explicitly; later suppliers remain separate.',
        completed: 'Every supplier sandbox capture is confirmed by the server. Test funds only. No real money moved and no goods fulfillment was promised.',
        partial: 'Only part of the sandbox order is confirmed. These captures are not atomic: one supplier may already be paid in test funds. Recheck before continuing the original plan.',
        uncertain: 'A sandbox order or capture has an uncertain result. Recheck existing provider records. This recheck never creates an order or captures funds.',
        expired: 'The quote terms expired. Recheck the existing PayPal records. If no capture was attempted and the server verifies the orders are unpaid, close this plan in the app before requesting fresh quotes. Expiry does not reverse a capture.',
        closed_unpaid: 'This expired plan is closed in this app. No capture was attempted by this app. PayPal orders were not canceled. Find a new plan for fresh quotes and a separate exact approval.',
        failed: 'The sandbox checkout did not complete. Recheck existing provider records before attempting another purchase.',
      };
      els.settlementNote.textContent = networkNotes[state?.status] || 'Sandbox status rechecks read existing PayPal records only. They never create an order or capture funds.';
    }
    renderCheckout(state);
  }

  function renderTimeline(state) {
    const events = list(state?.timeline);
    els.timelineEmpty.hidden = events.length > 0;
    els.timelineEmpty.textContent = state?.proposal && networkMode()
      ? 'The approved plan and provider records are retained. This older record has no activity timeline; inspect the retained quotes and exact terms.'
      : 'The negotiation, checks and settlement attempts will appear here.';
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
    renderNegotiationTrace(state);
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
    if (specification.length < 8 || specification.length > 1000) throw new Error('Describe the shirts and printing you need in 8 to 1000 characters.');
    return { quantity, budgetCents, currency: 'USD', deadline: deadline.toISOString(), specification, allowSplit: els.allowSplit.checked, scenario: els.scenario.value };
  }

  function invalidateBrief(message) {
    briefRevision += 1;
    if (session.state) session.briefChanged = true;
    els.approvalCheck.checked = false;
    if (session.state) els.requestStatus.textContent = message;
    updateControls();
  }

  function draftedLimits(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ready !== 'boolean' ||
      result.requiresReview !== true || result.authorizesPayment !== false || typeof result.clarification !== 'string' ||
      result.clarification.length > 500 || !Array.isArray(result.assumptions) || result.assumptions.length > 2 ||
      result.assumptions.some((value) => !['currency_usd', 'single_supplier_default'].includes(value)) ||
      new Set(result.assumptions).size !== result.assumptions.length) throw new Error('The drafted limits could not be checked. Enter or edit the limits below yourself.');
    if (!result.ready) {
      if (result.rfq !== null || !result.clarification.trim()) throw new Error('The draft is incomplete. Enter the limits below yourself.');
      return null;
    }
    const rfq = result.rfq;
    const keys = ['quantity', 'budgetCents', 'currency', 'deadline', 'specification', 'allowSplit'];
    const deadline = new Date(rfq?.deadline);
    if (!rfq || typeof rfq !== 'object' || Array.isArray(rfq) || Object.keys(rfq).length !== keys.length ||
      Object.keys(rfq).some((key) => !keys.includes(key)) || !Number.isSafeInteger(rfq.quantity) || rfq.quantity < 1 || rfq.quantity > 500 ||
      !Number.isSafeInteger(rfq.budgetCents) || rfq.budgetCents < 100 || rfq.budgetCents > 10000000 || rfq.currency !== 'USD' ||
      typeof rfq.specification !== 'string' || rfq.specification.trim().length < 8 || rfq.specification.length > 1000 || typeof rfq.allowSplit !== 'boolean' ||
      typeof rfq.deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(rfq.deadline) ||
      !Number.isFinite(deadline.getTime()) || deadline.getTime() <= Date.now() || deadline.getTime() > Date.now() + 366 * 86400000) {
      throw new Error('The drafted limits are outside this form\'s supported quantity, budget or deadline. Enter or edit the limits below yourself.');
    }
    if (result.assumptions.includes('single_supplier_default') && rfq.allowSplit) throw new Error('The draft gives conflicting split-order limits. Enter or edit the limits below yourself.');
    const localDeadline = localDeadlineValue(deadline);
    if (new Date(localDeadline).getTime() !== deadline.getTime()) throw new Error('The drafted deadline is ambiguous in your local timezone. Enter the intended delivery deadline below yourself.');
    return { ...rfq, localDeadline };
  }

  els.goal.addEventListener('input', () => {
    if (unfinishedPurchase() || session.restoreBlocked || session.approvalUnknown) return;
    invalidateBrief('Your buying goal changed. Draft and review the limits, then find a new plan before approving.');
    els.goalStatus.textContent = 'Draft the limits, then review and edit every field before requesting quotes.';
    els.goalAssumptions.hidden = true;
    els.goalAssumptions.replaceChildren();
  });

  els.goalIntake.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (newPlanBlocked()) return;
    const goal = els.goal.value.trim();
    if (!goal || goal.length > 1000) { els.goalStatus.textContent = 'Describe the buying goal in up to 1000 characters, or enter the limits below yourself.'; return; }
    invalidateBrief('A new buying goal is being drafted. The existing plan is not approved by this request.');
    const revision = briefRevision;
    session.busy = true;
    updateControls();
    els.goalStatus.textContent = 'Drafting the limits. No suppliers are being contacted and no purchase is approved.';
    els.goalAssumptions.hidden = true;
    els.goalAssumptions.replaceChildren();
    try {
      const result = await api('/api/procurement/interpret', { method: 'POST', body: { goal } });
      if (revision !== briefRevision || els.goal.value.trim() !== goal) throw new Error('Your brief changed while the draft was being prepared. Draft it again to use the latest wording.');
      const rfq = draftedLimits(result);
      if (!rfq) { els.goalStatus.textContent = result.clarification; return; }
      els.specification.value = rfq.specification;
      els.quantity.value = String(rfq.quantity);
      els.budget.value = (rfq.budgetCents / 100).toFixed(2);
      els.deadline.value = rfq.localDeadline;
      els.allowSplit.checked = rfq.allowSplit;
      const assumptions = { currency_usd: 'The budget was interpreted as USD. Check the currency and amount.',
        single_supplier_default: 'No split permission was supplied, so the draft requires one supplier.' };
      for (const assumption of result.assumptions) els.goalAssumptions.append(node('li', assumptions[assumption]));
      els.goalAssumptions.hidden = result.assumptions.length === 0;
      els.goalStatus.textContent = 'Limits drafted only. Review the quantity, USD budget, specification, local delivery time and split permission below, then choose Find a plan when they are correct.';
      els.specification.focus();
    } catch (problem) {
      els.goalStatus.textContent = `${String(problem.message || 'Drafting is unavailable.').slice(0, 500)} Enter or edit the limits below yourself.`;
    } finally { session.busy = false; updateControls(); }
  });

  els.request.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (newPlanBlocked()) return;
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
    els.requestStatus.textContent = `Asking ${networkMode() ? 'MCP sandbox' : 'simulated'} suppliers, negotiating quotes and checking your limits.`;
    try {
      const result = await api('/api/procurement', { method: 'POST', body: brief });
      if (!result.id || !result.sessionSecret || !result.state) throw new Error('The server did not return a complete order session. Find a new plan to try again.');
      session.id = result.id;
      session.secret = result.sessionSecret;
      applyResult(result);
      if (networkMode()) {
        try { saveSession(); } catch (problem) { error(problem.message); }
      }
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
    try { saveSession(); } catch (problem) { error(problem.message); return; }
    session.busy = true;
    error('');
    updateControls();
    els.requestStatus.textContent = networkMode()
      ? placeholderMerchants() ? 'Saving the exact lab plan. Placeholder merchant IDs cannot receive PayPal sandbox orders or captures.' : 'Saving the exact approved terms and preparing PayPal sandbox checkout orders when server writes are enabled. No capture is authorized by this action.'
      : 'Checking the approved terms and attempting mock supplier settlement.';
    try {
      const result = await api(`/api/procurement/${encodeURIComponent(session.id)}/approve`, {
        method: 'POST', body: { confirmationToken: proposal.confirmationToken, termsHash: proposal.termsHash },
      });
      els.approvalCheck.checked = false;
      applyResult(result);
      els.requestStatus.textContent = statusName(result.state.status) || 'The simulated purchase result is shown below.';
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
    if (!session.id || session.busy || session.restoreBlocked) return;
    session.busy = true;
    error('');
    updateControls();
    els.requestStatus.textContent = networkMode()
      ? 'Reading existing PayPal sandbox orders and captures only. This recheck never creates an order or captures funds.'
      : 'Rechecking existing mock payments before continuing any still-valid parts of your approved plan. No replacement supplier is approved.';
    try {
      const result = await api(`/api/procurement/${encodeURIComponent(session.id)}/reconcile`, { method: 'POST', body: {} });
      applyResult(result);
      session.approvalUnknown = false;
      renderSettlement(result.state);
      els.requestStatus.textContent = statusName(result.state.status) || 'The current result is shown below.';
    } catch (problem) {
      error(problem.message);
      els.requestStatus.textContent = 'The result is still unclear. Leave this order open and check again later.';
    } finally {
      session.busy = false;
      updateControls();
    }
  });

  els.closeUnpaid.addEventListener('click', async () => {
    if (els.closeUnpaid.hidden || els.closeUnpaid.disabled || !session.id || session.busy || session.restoreBlocked || session.approvalUnknown ||
      session.state?.status !== 'expired' || session.state?.checkout?.canCloseUnpaid !== true || !approvalExpired()) return;
    session.busy = true;
    error('');
    updateControls();
    els.requestStatus.textContent = 'Checking the existing PayPal orders before closing this expired plan in the app. This step never creates, captures or cancels a PayPal order.';
    try {
      const result = await api(`/api/procurement/${encodeURIComponent(session.id)}/close-unpaid`, { method: 'POST', body: {} });
      applyResult(result);
      if (result.state.status !== 'closed_unpaid') throw new Error('The server did not confirm that this expired plan could be closed. Keep the existing checkout open and recheck its status.');
      els.requestStatus.textContent = 'This expired plan is closed in the app. Its records are retained and PayPal orders were not canceled. Your brief is ready for fresh quotes and a new exact approval.';
    } catch (problem) {
      error(problem.message);
      els.requestStatus.textContent = 'The plan remains open until its unpaid state is verified. Keep this checkout and recheck the existing records before taking another action.';
    } finally {
      session.busy = false;
      updateControls();
    }
  });

  async function checkoutWrite(action, body = {}) {
    if (!sandboxWritesAllowed() || session.busy || session.approvalUnknown || !session.id || approvalExpired() || session.state?.checkout?.blockedReason || ['uncertain', 'closed_unpaid'].includes(session.state?.status)) return;
    try { saveSession(); } catch (problem) { error(problem.message); return; }
    session.busy = true;
    error('');
    updateControls();
    els.requestStatus.textContent = action === 'prepare'
      ? 'Creating the existing plan\'s PayPal sandbox orders. No capture is authorized by this action.'
      : 'Freshly checking PayPal buyer approval before attempting one sandbox capture and verifying its result.';
    try {
      const result = await api(`/api/procurement/${encodeURIComponent(session.id)}/${action}`, { method: 'POST', body });
      applyResult(result);
      els.requestStatus.textContent = statusName(result.state.status) || 'The server result is shown below.';
    } catch (problem) {
      // A lost response can follow a successful provider write. Recheck the same order instead of
      // automatically retrying order creation or capture as a fresh payment.
      session.approvalUnknown = true;
      error(problem.message);
      els.requestStatus.textContent = 'The sandbox write answer is unclear. Recheck this existing checkout before continuing.';
      renderSettlement(session.state);
    } finally {
      session.busy = false;
      updateControls();
    }
  }

  function captureLeg(legId) {
    const leg = nextLeg();
    if (!leg || leg.id !== legId || leg.status !== 'ready_to_capture' || !leg.orderId || leg.captureId) return;
    return checkoutWrite('capture', { legId });
  }

  els.prepareCheckout.addEventListener('click', () => {
    if (els.prepareCheckout.disabled || els.prepareCheckout.hidden || session.state?.status === 'uncertain') return;
    return checkoutWrite('prepare');
  });

  els.refreshCommerce.addEventListener('click', async () => {
    if (!networkMode() || session.busy || (session.restoreBlocked && !session.restoreRetryable)) return;
    if (session.restoreRetryable) { await initializePage(); return; }
    session.busy = true;
    error('');
    updateControls();
    try { applyCommerce(await api('/api/commerce-status')); }
    catch (problem) { error(problem.message); }
    finally { session.busy = false; updateControls(); }
  });

  els.approvalCheck.addEventListener('change', updateControls);
  els.request.addEventListener('input', () => {
    if (unfinishedPurchase()) return;
    invalidateBrief('Your brief changed. Find a new plan before approving a purchase.');
  });
  els.scenario.addEventListener('change', () => {
    if (!session.state) return;
    if (unfinishedPurchase()) return;
    session.briefChanged = true;
    els.approvalCheck.checked = false;
    els.requestStatus.textContent = 'The scenario changed. Find a new plan to run it.';
    updateControls();
  });

  async function initializePage() {
    let saved = null;
    let returned = false;
    let hadSavedKey = false;
    try {
      const query = new URLSearchParams(window.location.search);
      returned = ['checkout', 'leg', 'returned', 'cancelled'].some((key) => query.has(key));
      const record = window.sessionStorage.getItem(storageKey);
      hadSavedKey = Boolean(record);
      if (record) {
        saved = JSON.parse(record);
        if (!saved || typeof saved.id !== 'string' || !saved.id || saved.id.length > 512 ||
          typeof saved.secret !== 'string' || !saved.secret || saved.secret.length > 2048) throw new Error('Invalid saved checkout key.');
      }
      if (((returned || session.restoreRetryable) && !saved) || (saved && query.has('checkout') && query.get('checkout') !== saved.id)) {
        session.restoreBlocked = true;
        session.restoreRetryable = false;
        error('This return URL cannot authorize a checkout. Return to the original browser tab with its saved checkout key to recheck the existing order. Do not start a replacement purchase.');
        updateControls();
        return;
      }
      if (saved && !networkMode()) {
        session.restoreBlocked = true;
        session.restoreRetryable = false;
        error('This tab has a saved PayPal sandbox checkout, but the server is in mock mode. Restore sandbox mode and recheck the original order before starting another purchase.');
        updateControls();
        return;
      }
    } catch {
      if (returned) {
        session.restoreBlocked = true;
        session.restoreRetryable = false;
        error('The checkout key is unavailable in this tab. Return to the original tab with its session storage to recheck the order. A return URL cannot grant payment permission.');
        updateControls();
        return;
      }
      // An unreadable existing key must never be silently replaced by a new checkout.
      if (hadSavedKey) {
        session.restoreBlocked = true;
        session.restoreRetryable = false;
        error('The saved sandbox checkout key could not be read safely. Keep this tab and restore its original session storage before starting another purchase.');
        updateControls();
        return;
      }
      if (networkMode()) {
        session.restoreBlocked = true;
        session.restoreRetryable = false;
        error('This tab cannot read its session storage, so an earlier checkout key cannot be ruled out. Enable session storage and reload this page before starting another purchase.');
        updateControls();
        return;
      }
    }
    if (!networkMode()) return;
    session.busy = true;
    updateControls();
    try {
      applyCommerce(await api('/api/commerce-status'));
      if (saved) {
        session.id = saved.id;
        session.secret = saved.secret;
        applyResult(await api(`/api/procurement/${encodeURIComponent(session.id)}`));
        if (returned) {
          // Remove stale return identifiers only after the original key authenticated this order.
          // Otherwise a later completed-order replacement would keep the old id in its address.
          const query = new URLSearchParams(window.location.search);
          for (const key of ['checkout', 'leg', 'returned', 'cancelled', 'token', 'PayerID']) query.delete(key);
          const remaining = query.toString();
          window.history.replaceState(null, '', `${window.location.pathname || '/procurement'}${remaining ? `?${remaining}` : ''}${window.location.hash || ''}`);
        }
        session.restoreBlocked = false;
        session.restoreRetryable = false;
        renderCommerce();
        const request = session.state?.request;
        let deadlineNeedsReview = false;
        if (request) {
          els.specification.value = request.specification || '';
          els.quantity.value = String(request.quantity);
          els.budget.value = (request.budgetCents / 100).toFixed(2);
          els.allowSplit.checked = request.allowSplit !== false;
          const deadline = new Date(request.deadline);
          const localDeadline = Number.isFinite(deadline.getTime()) ? localDeadlineValue(deadline) : '';
          deadlineNeedsReview = !localDeadline || new Date(localDeadline).getTime() !== deadline.getTime();
          els.deadline.value = deadlineNeedsReview ? '' : localDeadline;
        }
        els.requestStatus.textContent = 'Restored this tab\'s original checkout from the server. The return URL granted no payment permission; no order creation or capture was attempted.' +
          (deadlineNeedsReview ? ' Choose an unambiguous delivery date and time before requesting another plan.' : '');
        els.planPanel.focus();
      } else {
        els.requestStatus.textContent = 'Ready to ask MCP sandbox suppliers. PayPal sandbox checkout uses test funds only.';
      }
    } catch (problem) {
      if (saved) {
        session.restoreBlocked = true;
        session.restoreRetryable = !problem.unsafeRestore;
      }
      error(problem.message);
      els.requestStatus.textContent = saved
        ? session.restoreRetryable ? 'The existing checkout could not be restored. Keep the original key. After the connection recovers, use Retry checkout restore to read the existing order before taking another action.'
          : 'The checkout identity or mode could not be verified. Restore the original server configuration and reload this page with its original session storage.'
        : 'Sandbox availability could not be checked. Order creation and capture remain disabled until the server confirms availability.';
    } finally {
      session.busy = false;
      updateControls();
    }
  }

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
  renderCommerce();
  updateControls();
  // Older mock-only harnesses have no body or window. A real page always checks saved checkout
  // credentials before allowing a replacement purchase, including when its server mode changed.
  if (document.body) void initializePage();
})();
