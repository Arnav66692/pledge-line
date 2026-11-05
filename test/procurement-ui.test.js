import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../web/procurement.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../web/procurement.html', import.meta.url), 'utf8');
const sessionId = 'order/one with spaces';
const sessionSecret = 'synthetic-session-secret';
const sessionPath = `/api/procurement/${encodeURIComponent(sessionId)}`;
const storageKey = 'pledge-line.procurement.sandbox.v1';

// Exercise the real event handlers without a browser or a network connection. Rejecting innerHTML
// also makes the rendering tests fail if supplier-controlled content starts using an HTML sink.
class Element {
  constructor(tag = 'div', attributes = {}) {
    this.tagName = tag.toUpperCase();
    this.attributes = { ...attributes };
    this.value = attributes.value || '';
    this.hidden = 'hidden' in attributes;
    this.disabled = 'disabled' in attributes;
    this.checked = false;
    this.dataset = {};
    this.children = [];
    this.events = new Map();
    this.ownText = '';
  }
  get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  set innerHTML(_value) { throw new Error('HTML rendering is not permitted in the supply desk.'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.ownText = ''; this.children = [...children]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  focus() { this.focused = true; }
  addEventListener(name, callback) {
    const listeners = this.events.get(name) || [];
    listeners.push(callback);
    this.events.set(name, listeners);
  }
  async fire(name) {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const callback of this.events.get(name) || []) await callback(event);
    return event;
  }
}

function state(overrides = {}) {
  const now = Date.now();
  const deadline = new Date(now + 7 * 86400000).toISOString();
  const expiresAt = new Date(now + 3600000).toISOString();
  const allocations = [
    { supplierId: 'campus-print', supplierName: 'Campus Print', payeeId: 'mock-campus', quoteId: 'quote-campus',
      quantity: 60, unitPriceCents: 550, goodsCents: 33000, setupCents: 1000, shippingCents: 1000, taxCents: 2500,
      totalCents: 37500, deliveryAt: deadline },
    { supplierId: 'club-threads', supplierName: 'Club Threads', payeeId: 'mock-club', quoteId: 'quote-club',
      quantity: 40, unitPriceCents: 600, goodsCents: 24000, setupCents: 1000, shippingCents: 1000, taxCents: 1800,
      totalCents: 27800, deliveryAt: deadline },
  ];
  return {
    id: sessionId, status: 'awaiting_approval', mode: { suppliers: 'simulated', payments: 'mock' },
    request: { quantity: 100, budgetCents: 80000, currency: 'USD', specification: 'Matching white cotton shirts', deadline },
    quotes: allocations.map((allocation) => ({ ...allocation, currency: 'USD', expiresAt, negotiated: true })),
    rejections: [],
    proposal: { id: 'proposal-one', termsHash: 'exact-terms-hash', confirmationToken: 'exact-approval-token',
      expiresAt, totalCents: 65300, currency: 'USD', quantity: 100, allocations },
    timeline: [{ type: 'quote_checked', at: new Date(now).toISOString(), message: 'Supplier terms checked.' }],
    settlements: [], ...overrides,
  };
}

function browser({ now = Date.now(), mode, storage = new Map(), search = '', initialResponses = [], storageWriteFails = false, storageReadFails = false } = {}) {
  class ClockDate extends Date {
    constructor(...values) { super(...(values.length ? values : [now])); }
    static now() { return now; }
  }
  const elements = new Map();
  for (const [, tag, attributes, id] of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const parsed = Object.fromEntries([...attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)]
      .map(([, name, value]) => [name, value ?? '']));
    elements.set(id, new Element(tag, parsed));
  }
  const byId = (id) => {
    assert.ok(elements.has(id), `The actual supply desk HTML contains #${id}.`);
    return elements.get(id);
  };
  byId('specification').value = 'Matching white cotton shirts';
  byId('scenario').value = 'normal';
  const requests = [];
  const storageSnapshots = [];
  const responses = initialResponses.map((data) => data instanceof Error ? data : { data, status: 200 });
  const createdTags = [];
  const timers = [];
  const location = { search, pathname: '/procurement', hash: '' };
  const historyChanges = [];
  const fetch = async (path, options = {}) => {
    storageSnapshots.push(new Map(storage));
    requests.push({ path, method: options.method, headers: { ...options.headers },
      body: options.body === undefined ? undefined : JSON.parse(options.body) });
    if (!responses.length) throw new Error(`Unexpected request: ${path}`);
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return { ok: response.status >= 200 && response.status < 300, json: async () => response.data };
  };
  vm.runInNewContext(app, {
    document: { ...(mode ? { body: { dataset: { payments: mode } } } : {}), getElementById: byId, createElement(tag) { createdTags.push(tag); return new Element(tag); } },
    window: { location, history: { replaceState(_state, _title, path) {
      historyChanges.push(path);
      const next = new URL(path, 'https://pledge.example');
      location.search = next.search; location.pathname = next.pathname; location.hash = next.hash;
    } }, sessionStorage: {
      getItem(key) { if (storageReadFails) throw new Error('Session storage denied'); return storage.get(key) ?? null; },
      setItem(key, value) { if (storageWriteFails) throw new Error('Session storage denied'); storage.set(key, value); },
    } },
    fetch, Intl, Date: ClockDate, AbortController, URL, URLSearchParams,
    setTimeout(callback, delay) { timers.push(delay); return setTimeout(callback, delay); },
    clearTimeout, setInterval() {}, encodeURIComponent,
  }, { filename: 'web/procurement.js' });
  return {
    byId, requests, createdTags, storage, storageSnapshots, timers, location, historyChanges,
    ready: () => new Promise((resolve) => setImmediate(resolve)),
    respond(data, status = 200) { responses.push({ data, status }); },
    fail(error = new TypeError('Connection lost after approval')) { responses.push(error); },
    async create(plan = state()) {
      this.respond({ id: sessionId, sessionSecret, state: plan }, 201);
      await byId('request').fire('submit');
      assert.equal(byId('error').textContent, '', 'The supplied plan renders successfully.');
    },
    async approve() {
      byId('approval-check').checked = true;
      await byId('approval-check').fire('change');
      await byId('approval-form').fire('submit');
    },
  };
}

test('supply desk approval binds the exact displayed terms to its authenticated session', async () => {
  const ui = browser();
  const plan = state();
  await ui.create(plan);
  assert.equal(ui.requests[0].headers['x-procurement-secret'], undefined, 'A new session does not reuse a secret.');
  assert.deepEqual(ui.requests[0].body, {
    quantity: 100, budgetCents: 80000, currency: 'USD', specification: 'Matching white cotton shirts',
    deadline: new Date(ui.byId('deadline').value).toISOString(), scenario: 'normal',
  });
  assert.equal(ui.byId('approve').disabled, true, 'Showing a plan alone is not consent.');
  await ui.byId('approval-form').fire('submit');
  assert.equal(ui.requests.length, 1, 'Submitting without consent makes no purchase request.');

  ui.respond({ state: state({ status: 'completed' }) });
  await ui.approve();
  assert.deepEqual(ui.requests[1], {
    path: `${sessionPath}/approve`, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-procurement-secret': sessionSecret },
    body: { confirmationToken: plan.proposal.confirmationToken, termsHash: plan.proposal.termsHash },
  });
  assert.equal(ui.byId('state-label').textContent, 'Mock order completed');
  assert.equal(ui.byId('approve').disabled, true);
});

test('editing an order brief invalidates consent to its earlier plan', async () => {
  const ui = browser();
  await ui.create();
  ui.byId('approval-check').checked = true;
  await ui.byId('approval-check').fire('change');
  assert.equal(ui.byId('approve').disabled, false);

  ui.byId('budget').value = '700';
  await ui.byId('request').fire('input');
  assert.equal(ui.byId('approval-check').checked, false);
  assert.equal(ui.byId('approve').disabled, true);
  await ui.approve();
  assert.equal(ui.requests.length, 1, 'Checking consent again cannot approve stale terms.');
});

test('partial supplier settlement cannot be bypassed by creating or approving another plan', async () => {
  const ui = browser();
  const partial = state({ status: 'partial', settlements: [
    { supplierId: 'campus-print', quantity: 60, amountCents: 37500, status: 'confirmed' },
    { supplierId: 'club-threads', quantity: 40, amountCents: 27800, status: 'failed' },
  ] });
  await ui.create();
  ui.respond({ state: partial });
  await ui.approve();
  assert.equal(ui.byId('find-plan').disabled, true);
  assert.equal(ui.byId('approve').disabled, true);
  assert.equal(ui.byId('reconcile').hidden, false);
  assert.match(ui.byId('settlement-note').textContent, /not an automatic rollback/);

  await ui.byId('request').fire('input');
  await ui.byId('request').fire('submit');
  await ui.approve();
  assert.equal(ui.requests.length, 2, 'Programmatic form submission also respects partial settlement.');
  ui.respond({ state: partial });
  await ui.byId('reconcile').fire('click');
  assert.equal(ui.requests[2].path, `${sessionPath}/reconcile`);
  assert.equal(ui.requests[2].headers['x-procurement-secret'], sessionSecret);
  assert.deepEqual(ui.requests[2].body, {});
  assert.equal(ui.byId('find-plan').disabled, true, 'A still-partial reconciliation keeps the purchase locked.');
  await ui.byId('request').fire('submit');
  assert.equal(ui.requests.length, 3);
});

test('a lost approval response blocks duplicate purchases until authenticated reconciliation succeeds', async () => {
  const ui = browser();
  await ui.create();
  ui.fail();
  await ui.approve();
  assert.equal(ui.byId('approve').disabled, true);
  assert.equal(ui.byId('find-plan').disabled, true);
  assert.equal(ui.byId('reconcile').hidden, false);
  assert.match(ui.byId('settlement-note').textContent, /may have reached the server/);
  await ui.approve();
  await ui.byId('request').fire('submit');
  assert.equal(ui.requests.length, 2, 'Neither approval nor a new RFQ repeats the uncertain purchase.');

  ui.fail(new TypeError('Reconciliation temporarily unavailable'));
  await ui.byId('reconcile').fire('click');
  assert.equal(ui.byId('find-plan').disabled, true, 'A failed recheck cannot unlock the order.');
  assert.equal(ui.byId('approve').disabled, true);

  ui.respond({ state: state({ status: 'uncertain', settlements: [
    { supplierId: 'campus-print', quantity: 60, amountCents: 37500, status: 'unknown' },
  ] }) });
  await ui.byId('reconcile').fire('click');
  assert.equal(ui.byId('state-label').textContent, 'Result uncertain');
  assert.equal(ui.byId('find-plan').disabled, true, 'A server-confirmed unknown payment remains locked.');
  await ui.approve();
  await ui.byId('request').fire('submit');
  assert.equal(ui.requests.length, 4);

  ui.respond({ state: state({ status: 'completed', settlements: [
    { supplierId: 'campus-print', quantity: 60, amountCents: 37500, status: 'confirmed' },
    { supplierId: 'club-threads', quantity: 40, amountCents: 27800, status: 'confirmed' },
  ] }) });
  await ui.byId('reconcile').fire('click');
  for (const request of ui.requests.slice(2)) {
    assert.equal(request.path, `${sessionPath}/reconcile`);
    assert.equal(request.headers['x-procurement-secret'], sessionSecret);
  }
  assert.equal(ui.byId('state-label').textContent, 'Mock order completed');
  assert.equal(ui.byId('find-plan').disabled, false);
  assert.equal(ui.byId('approve').disabled, true);
  assert.equal(ui.byId('reconcile').hidden, true);
  assert.match(ui.byId('settlement-note').textContent, /No real payment or goods order/);
});

test('supplier, request and timeline content render as text rather than executable markup', async () => {
  const ui = browser();
  const hostile = '<img src=x onerror="globalThis.injected=true"><script>attack()</script>';
  const plan = state();
  plan.request.specification = hostile;
  plan.quotes[0].supplierName = hostile;
  plan.proposal.allocations[0].supplierName = hostile;
  plan.proposal.allocations[0].payeeId = hostile;
  plan.proposal.termsHash = hostile;
  plan.rejections = [{ supplierName: hostile, reason: hostile }];
  plan.timeline[0].message = hostile;
  await ui.create(plan);
  assert.equal(ui.byId('quotes').children[0].children[0].children[0].textContent, hostile);
  assert.match(ui.byId('allocations').textContent, /<img src=x/);
  assert.equal(ui.byId('terms-specification').textContent, hostile);
  assert.equal(ui.byId('terms-hash').textContent, hostile);
  assert.equal(ui.byId('rejection-list').children[0].textContent, `${hostile}. ${hostile}`);
  assert.equal(ui.byId('timeline').children[0].children[0].textContent, hostile);
  assert.ok(!ui.createdTags.some((tag) => ['img', 'script'].includes(tag.toLowerCase())));
});

test('the order form enforces the same 500-shirt maximum in HTML and its request handler', async () => {
  const ui = browser();
  assert.equal(ui.byId('quantity').attributes.max, '500');
  for (const invalid of ['501', '0', '1.5']) {
    ui.byId('quantity').value = invalid;
    await ui.byId('request').fire('submit');
    assert.equal(ui.requests.length, 0, `Quantity ${invalid} cannot reach the API.`);
    assert.match(ui.byId('error').textContent, /whole quantity from 1 to 500/);
  }
  ui.byId('quantity').value = '500';
  await ui.create(state({ status: 'no_feasible_quote', proposal: null, quotes: [] }));
  assert.equal(ui.requests[0].body.quantity, 500, 'The inclusive maximum is a valid request.');
});

test('the default deadline is a local Friday at 17:00 with at least three full days for suppliers', () => {
  // Local constructors match datetime-local semantics in every host timezone. The second on either
  // side of the 72-hour boundary catches a date-only or rounded-day comparison that loses lead time.
  const cases = [
    { label: 'just over three days', now: new Date(2026, 10, 3, 16, 59, 59), expected: '2026-11-06T17:00' },
    { label: 'exactly three days', now: new Date(2026, 10, 3, 17), expected: '2026-11-06T17:00' },
    { label: 'one second short', now: new Date(2026, 10, 3, 17, 0, 1), expected: '2026-11-13T17:00' },
    { label: 'late Wednesday', now: new Date(2026, 10, 4, 23, 30), expected: '2026-11-13T17:00' },
    { label: 'Thursday', now: new Date(2026, 10, 5, 12), expected: '2026-11-13T17:00' },
    { label: 'Friday after the deadline', now: new Date(2026, 10, 6, 18), expected: '2026-11-13T17:00' },
    { label: 'week containing spring clock change', now: new Date(2026, 2, 5, 18), expected: '2026-03-13T17:00' },
    { label: 'week containing autumn clock change', now: new Date(2026, 9, 29, 18), expected: '2026-11-06T17:00' },
  ];
  for (const { label, now, expected } of cases) {
    const ui = browser({ now: now.getTime() });
    const value = ui.byId('deadline').value;
    const deadline = new Date(value);
    assert.equal(value, expected, label);
    assert.equal(deadline.getDay(), 5, `${label}: delivery stays on Friday.`);
    assert.equal(deadline.getHours(), 17, `${label}: the local delivery hour stays unchanged.`);
    assert.ok(deadline.getTime() - now.getTime() >= 3 * 86400000, `${label}: suppliers receive at least 72 hours.`);
  }
});

const commerce = (sandboxWritesEnabled = true) => ({ payments: 'paypal-sandbox', suppliers: 'mcp',
  supplierProvenance: 'MCP sandbox endpoints', sandboxWritesEnabled,
  sandboxWriteBlockedReason: sandboxWritesEnabled ? null : 'time_gate', sandboxWriteUnlockAt: '2026-11-05T05:00:00Z' });

function networkState(overrides = {}) {
  return state({ mode: { suppliers: 'mcp', payments: 'paypal-sandbox' }, ...overrides });
}

function checkoutLegs(status = 'awaiting_checkout') {
  return networkState().proposal.allocations.map((allocation, index) => {
    const orderId = `ORDER${index + 1}`;
    return { id: `leg-${index + 1}`, supplierId: allocation.supplierId, supplierName: allocation.supplierName,
      quantity: allocation.quantity, amountCents: allocation.totalCents, currency: 'USD', status,
      ...(status === 'awaiting_checkout' ? {} : { orderId, approvalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}` }) };
  });
}

const savedCheckout = () => new Map([[storageKey, JSON.stringify({ id: sessionId, secret: sessionSecret })]]);
const descendants = (element) => [element, ...element.children.flatMap(descendants)];
const checkoutButtons = (ui) => descendants(ui.byId('checkout-legs')).filter((element) => element.tagName === 'BUTTON');
const checkoutLinks = (ui) => descendants(ui.byId('checkout-legs')).filter((element) => element.tagName === 'A');

test('placeholder merchants stay clearly unpaid after the time gate while a lab plan can be saved', async () => {
  const blockedCommerce = { ...commerce(false), sandboxWriteBlockedReason: 'placeholder_merchants',
    supplierProvenance: 'Controlled sandbox supplier lab. Merchant IDs are placeholders and checkout writes are disabled.' };
  const ui = browser({ now: Date.parse('2026-11-06T12:00:00Z'), mode: 'paypal-sandbox', initialResponses: [blockedCommerce] });
  await ui.ready();
  assert.match(ui.byId('commerce-status').textContent, /placeholder merchant IDs/);
  assert.match(ui.byId('commerce-status').textContent, /authorized PayPal sandbox merchants/);
  assert.match(ui.byId('commerce-status').textContent, /Passing the time gate alone will not enable checkout/);
  assert.doesNotMatch(ui.byId('commerce-status').textContent, /Earliest unlock|Refresh availability after the gate opens/);
  assert.match(ui.byId('demo-disclosure').textContent, /Controlled sandbox supplier lab/);
  assert.equal(ui.byId('approve').textContent, 'Save lab plan');
  assert.match(ui.byId('approval-consent').textContent, /placeholder merchant IDs/);

  const plan = networkState();
  plan.proposal.expiresAt = '2026-11-06T13:00:00Z';
  await ui.create(plan);
  assert.match(ui.byId('allocations').textContent, /Placeholder sandbox payee/);
  assert.doesNotMatch(ui.byId('allocations').textContent, /Registered sandbox payee/);
  assert.match(ui.byId('terms-disclosure').textContent, /placeholder merchant IDs/);
  ui.respond({ state: networkState({ proposal: plan.proposal, status: 'awaiting_checkout', checkout: { legs: checkoutLegs() } }), commerce: blockedCommerce });
  await ui.approve();
  assert.equal(ui.requests[2].path, `${sessionPath}/approve`, 'Saving a lab plan still binds the exact approved terms.');
  assert.equal(ui.byId('state-label').textContent, 'Lab plan saved');
  assert.equal(ui.byId('prepare-checkout').disabled, true);
  await ui.byId('prepare-checkout').fire('click');
  assert.equal(ui.requests.length, 3, 'A past unlock time does not create a sandbox order.');

  const legs = checkoutLegs('ready_to_capture');
  legs[1].status = 'awaiting_paypal_approval';
  ui.respond({ state: networkState({ proposal: plan.proposal, status: 'partial', checkout: { legs } }), commerce: blockedCommerce });
  await ui.byId('reconcile').fire('click');
  assert.ok(checkoutButtons(ui).every((button) => button.disabled));
  assert.ok(checkoutLinks(ui).every((link) => !link.attributes.href && link.attributes['aria-disabled'] === 'true'));
  await checkoutButtons(ui)[0].fire('click');
  assert.equal((await checkoutLinks(ui)[0].fire('click')).defaultPrevented, true);
  assert.equal(ui.requests.length, 4, 'Status checks cannot enable a capture or PayPal navigation with placeholder merchants.');
});

test('sandbox availability explains operator and time restrictions separately', async () => {
  const operator = browser({ mode: 'paypal-sandbox', initialResponses: [{ ...commerce(false), sandboxWriteBlockedReason: 'operator_disabled' }] });
  await operator.ready();
  assert.match(operator.byId('commerce-status').textContent, /disabled by the operator/);
  assert.doesNotMatch(operator.byId('commerce-status').textContent, /Earliest|gate opens/);

  const timed = browser({ mode: 'paypal-sandbox', initialResponses: [commerce(false)] });
  await timed.ready();
  const status = timed.byId('commerce-status').textContent;
  assert.match(status, /time gate/);
  assert.match(status, /Nov 4/);
  assert.match(status, /9:00.*(?:PST|GMT-8)/);
  assert.match(status, /Pacific time/);
});

test('retrying a saved plan restore updates the checkout label to the server availability', async () => {
  const ui = browser({ mode: 'paypal-sandbox', storage: savedCheckout(),
    initialResponses: [commerce(), new TypeError('Checkout temporarily unavailable')] });
  await ui.ready();
  assert.equal(ui.byId('refresh-commerce').textContent, 'Retry checkout restore');
  ui.respond(commerce());
  ui.respond({ state: networkState({ status: 'awaiting_checkout', checkout: { legs: checkoutLegs() } }) });
  await ui.byId('refresh-commerce').fire('click');
  assert.equal(ui.byId('state-label').textContent, 'Sandbox checkout ready');
  assert.equal(ui.byId('prepare-checkout').disabled, false);
  assert.equal(ui.requests.length, 4);
  assert.ok(ui.requests.every((request) => request.method === 'GET'), 'Restoring availability only reads the saved checkout.');
});

test('sandbox approval saves its tab key and order creation stays behind the server write gate', async () => {
  const ui = browser({ mode: 'paypal-sandbox', initialResponses: [commerce(false)] });
  await ui.ready();
  assert.deepEqual(ui.requests.map(({ path, method }) => ({ path, method })), [{ path: '/api/commerce-status', method: 'GET' }]);
  await ui.create(networkState({ comparison: { baselineTotalCents: 82000, baselineWithinBudget: false,
    negotiatedTotalCents: 65300, savingsCents: 16700, scope: 'Same requested order and cost components.' }, review: { summary: 'Check the printing specification.' } }));
  assert.equal(ui.byId('comparison').hidden, false);
  assert.match(ui.byId('comparison-scope').textContent, /This order only/);
  assert.match(ui.byId('comparison-scope').textContent, /exceeds/);
  assert.equal(ui.byId('review-note').textContent, 'Check the printing specification.');
  ui.storage.delete(storageKey);
  const approved = networkState({ status: 'awaiting_checkout', checkout: { nonAtomic: true, legs: checkoutLegs() } });
  ui.respond({ state: approved, commerce: commerce(false) });
  await ui.approve();
  assert.deepEqual(JSON.parse(ui.storageSnapshots[2].get(storageKey)), { id: sessionId, secret: sessionSecret }, 'The key is saved before approval is sent.');
  assert.equal(ui.requests[2].path, `${sessionPath}/approve`);
  assert.equal(ui.requests[2].headers['x-procurement-secret'], sessionSecret);
  assert.deepEqual(ui.requests[2].body, { confirmationToken: approved.proposal.confirmationToken, termsHash: approved.proposal.termsHash });
  assert.equal(ui.byId('prepare-checkout').hidden, false);
  assert.equal(ui.byId('prepare-checkout').disabled, true);
  assert.match(ui.byId('commerce-status').textContent, /disabled by the server/);
  assert.match(ui.byId('commerce-status').textContent, /Pacific time/);
  await ui.byId('prepare-checkout').fire('click');
  await ui.byId('request').fire('submit');
  assert.equal(ui.requests.length, 3, 'With writes disabled, plan approval retains the terms without a replacement RFQ or separate order request.');

  ui.respond(commerce(true));
  await ui.byId('refresh-commerce').fire('click');
  assert.equal(ui.requests[3].headers['x-procurement-secret'], undefined, 'The commerce status endpoint does not receive the session key.');
  assert.equal(ui.byId('prepare-checkout').disabled, false);
  ui.respond({ state: networkState({ status: 'awaiting_paypal_approval', checkout: { nonAtomic: true, legs: checkoutLegs('awaiting_paypal_approval') } }), commerce: commerce(true) });
  await ui.byId('prepare-checkout').fire('click');
  assert.equal(ui.requests[4].path, `${sessionPath}/prepare`);
  assert.deepEqual(ui.requests[4].body, {});
  assert.equal(ui.requests.length, 5, 'Order creation does not auto-approve or capture either supplier.');
  assert.ok(ui.timers.includes(45000), 'Write requests allow the network checkout timeout.');
  const links = checkoutLinks(ui);
  assert.equal(links[0].attributes.href, 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1');
  assert.equal(links[0].attributes.target, undefined, 'PayPal opens in the same tab.');
  assert.equal(links[1].attributes.href, undefined, 'Later supplier approval waits for the first leg.');
  assert.equal((await links[0].fire('click')).defaultPrevented, false);
  assert.equal(ui.requests.length, 5, 'Opening a buyer approval link is not an app-side capture.');
});

test('only the exact sandbox approval URL bound to the provider order is rendered as a link', async () => {
  const invalidUrls = [
    'https://www.sandbox.paypal.com.evil.test/checkoutnow?token=ORDER1',
    'http://www.sandbox.paypal.com/checkoutnow?token=ORDER1',
    'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1&next=evil',
    'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1#capture',
    'https://user:password@www.sandbox.paypal.com/checkoutnow?token=ORDER1',
    'https://www.sandbox.paypal.com/checkoutnow?token=OTHER',
    'https://www.sandbox.paypal.com:443/checkoutnow?token=ORDER1',
    'https://www.sandbox.paypal.com/checkoutnow/?token=ORDER1',
    'javascript:alert(1)',
  ];
  for (const approvalUrl of invalidUrls) {
    const legs = checkoutLegs('awaiting_paypal_approval').slice(0, 1);
    legs[0].approvalUrl = approvalUrl;
    const ui = browser({ mode: 'paypal-sandbox', storage: savedCheckout(), initialResponses: [commerce(),
      { state: networkState({ status: 'awaiting_paypal_approval', checkout: { legs } }) }] });
    await ui.ready();
    assert.equal(checkoutLinks(ui).length, 0, approvalUrl);
    assert.match(ui.byId('checkout-legs').textContent, /valid PayPal sandbox approval link/);
    assert.equal(ui.requests.length, 2, 'Invalid links cause no provider write.');
  }
});

test('enabled sandbox plan approval can return prepared orders without authorizing any capture', async () => {
  const ui = browser({ mode: 'paypal-sandbox', initialResponses: [commerce()] });
  await ui.ready();
  await ui.create(networkState({ review: { decision: 'within_limits', advisory: true, authorizesPayment: false } }));
  assert.match(ui.byId('approval-consent').textContent, /creates PayPal sandbox checkout orders/);
  assert.match(ui.byId('approve').textContent, /prepare PayPal checkout/);
  assert.match(ui.byId('review-note').textContent, /does not grant payment permission/);
  ui.respond({ state: networkState({ status: 'awaiting_paypal_approval', checkout: { nonAtomic: true,
    legs: checkoutLegs('awaiting_paypal_approval') } }), commerce: commerce() });
  await ui.approve();
  assert.deepEqual(ui.requests.map((request) => request.path), ['/api/commerce-status', '/api/procurement', `${sessionPath}/approve`]);
  assert.equal(ui.byId('prepare-checkout').hidden, true, 'Already prepared orders are not created again.');
  assert.equal(checkoutButtons(ui).length, 0, 'A return or plan approval alone cannot expose a capture button.');
  assert.equal(checkoutLinks(ui)[0].attributes.href, 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1');
  assert.match(ui.byId('settlement-note').textContent, /return URL or checkbox is not evidence of payment/);
});

test('a sandbox return restores by saved key using reads only and leaves expired checkout recoverable', async () => {
  const restored = networkState({ status: 'partial', quotes: undefined, timeline: undefined,
    checkout: { nonAtomic: true, legs: checkoutLegs('ready_to_capture') } });
  restored.proposal.expiresAt = new Date(Date.now() - 60000).toISOString();
  const ui = browser({ mode: 'paypal-sandbox', storage: savedCheckout(),
    search: `?checkout=${encodeURIComponent(sessionId)}&leg=leg-1&returned=1&approved=1`,
    initialResponses: [commerce(), { state: restored, commerce: commerce() }] });
  await ui.ready();
  assert.deepEqual(ui.requests.map(({ path, method }) => ({ path, method })), [
    { path: '/api/commerce-status', method: 'GET' }, { path: sessionPath, method: 'GET' },
  ]);
  assert.equal(ui.requests[1].headers['x-procurement-secret'], sessionSecret);
  assert.equal(ui.byId('plan-details').hidden, false);
  assert.match(ui.byId('quotes-summary').textContent, /exact plan is retained/);
  assert.doesNotMatch(ui.byId('quotes-summary').textContent, /No usable/);
  assert.equal(ui.byId('reconcile').disabled, false, 'Quote expiry does not disable status reads.');
  assert.equal(ui.byId('find-plan').disabled, true);
  assert.ok(checkoutButtons(ui).every((button) => button.disabled), 'Expired terms do not authorize captures.');
  await ui.byId('request').fire('submit');
  assert.equal(ui.requests.length, 2);
  ui.respond({ state: restored });
  await ui.byId('reconcile').fire('click');
  assert.equal(ui.requests[2].path, `${sessionPath}/reconcile`);
  assert.deepEqual(ui.requests[2].body, {});
  assert.equal(ui.requests.length, 3, 'A recheck never auto-creates or captures an order.');
});

test('return URLs, corrupt keys and changed payment modes cannot start replacement purchases', async () => {
  const cases = [
    { label: 'return without a key', mode: 'paypal-sandbox', search: '?checkout=other&returned=1' },
    { label: 'return for another session', mode: 'paypal-sandbox', storage: savedCheckout(), search: '?checkout=other&cancelled=1' },
    { label: 'mock server with a saved sandbox checkout', mode: 'mock', storage: savedCheckout() },
    { label: 'corrupt key', mode: 'paypal-sandbox', storage: new Map([[storageKey, '{broken']]) },
    { label: 'unreadable session storage', mode: 'paypal-sandbox', storage: savedCheckout(), storageReadFails: true },
    { label: 'server restored a mock result', mode: 'paypal-sandbox', storage: savedCheckout(), initialResponses: [commerce(), { state: state() }] },
  ];
  for (const { label, ...options } of cases) {
    const ui = browser(options);
    await ui.ready();
    const before = ui.requests.length;
    assert.equal(ui.byId('find-plan').disabled, true, label);
    assert.ok(ui.byId('error').textContent, label);
    await ui.byId('request').fire('submit');
    await ui.approve();
    assert.equal(ui.requests.length, before, `${label}: no new purchase is authorized.`);
    assert.ok(ui.requests.every((request) => request.method === 'GET'), label);
  }
});

test('sandbox capture is explicit, ordered and cannot be repeated after a lost response', async () => {
  const ready = networkState({ status: 'partial', checkout: { nonAtomic: true, legs: checkoutLegs('ready_to_capture') } });
  const ui = browser({ mode: 'paypal-sandbox', storage: savedCheckout(), initialResponses: [commerce(), { state: ready }] });
  await ui.ready();
  const buttons = checkoutButtons(ui);
  assert.equal(buttons[0].disabled, false);
  assert.equal(buttons[1].disabled, true);
  await buttons[1].fire('click');
  assert.equal(ui.requests.length, 2, 'A later leg cannot bypass settlement order.');
  ui.fail(new TypeError('Capture answer lost'));
  await buttons[0].fire('click');
  assert.deepEqual(ui.requests[2], { path: `${sessionPath}/capture`, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-procurement-secret': sessionSecret }, body: { legId: 'leg-1' } });
  assert.equal(ui.byId('find-plan').disabled, true);
  await checkoutButtons(ui)[0].fire('click');
  await ui.byId('prepare-checkout').fire('click');
  await ui.byId('request').fire('submit');
  assert.equal(ui.requests.length, 3, 'An uncertain capture cannot be retried or bypassed.');

  const after = networkState({ status: 'partial', checkout: { nonAtomic: true, legs: checkoutLegs('ready_to_capture') } });
  after.checkout.legs[0].status = 'confirmed';
  after.checkout.legs[0].captureId = 'CAPTURE1';
  ui.respond({ state: after });
  await ui.byId('reconcile').fire('click');
  assert.equal(ui.requests.length, 4, 'Rechecking the first capture does not capture the second.');
  const remaining = checkoutButtons(ui);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].disabled, false);
  assert.equal(ui.byId('find-plan').disabled, true, 'An unfinished second leg still blocks a replacement plan.');
});

test('sandbox approval and outbound PayPal navigation require a saved tab key', async () => {
  const ui = browser({ mode: 'paypal-sandbox', storageWriteFails: true, initialResponses: [commerce()] });
  await ui.ready();
  ui.respond({ id: sessionId, sessionSecret, state: networkState(), commerce: commerce() });
  await ui.byId('request').fire('submit');
  await ui.approve();
  assert.equal(ui.requests.length, 2, 'Unavailable session storage prevents the approval request.');
  assert.match(ui.byId('error').textContent, /save its checkout key/);

  const navigation = browser({ mode: 'paypal-sandbox', storage: savedCheckout(), storageWriteFails: true,
    initialResponses: [commerce(), { state: networkState({ status: 'awaiting_paypal_approval', checkout: { legs: checkoutLegs('awaiting_paypal_approval') } }) }] });
  await navigation.ready();
  assert.equal((await checkoutLinks(navigation)[0].fire('click')).defaultPrevented, true);
  assert.equal(navigation.requests.length, 2, 'Failed key persistence cannot lead into a provider checkout.');
});

test('a server-blocked sandbox plan cannot capture even if a leg still shows provider approval', async () => {
  const blocked = networkState({ status: 'expired', checkout: { nonAtomic: true, blockedReason: 'quote_changed', legs: checkoutLegs('ready_to_capture') } });
  const ui = browser({ mode: 'paypal-sandbox', storage: savedCheckout(), initialResponses: [commerce(), { state: blocked }] });
  await ui.ready();
  assert.equal(ui.byId('checkout-blocked').textContent, 'quote_changed');
  assert.ok(checkoutButtons(ui).every((button) => button.disabled));
  await checkoutButtons(ui)[0].fire('click');
  await ui.byId('request').fire('submit');
  assert.equal(ui.requests.length, 2, 'Provider approval does not override the server\'s quote block.');
  assert.equal(ui.byId('reconcile').disabled, false);
});

test('a transient startup read failure can retry the saved checkout without authorizing a write', async () => {
  for (const initialResponses of [[new TypeError('Commerce temporarily unavailable')],
    [commerce(), new TypeError('Checkout temporarily unavailable')]]) {
    const storage = savedCheckout();
    const ui = browser({ mode: 'paypal-sandbox', storage, initialResponses });
    await ui.ready();
    assert.equal(ui.byId('find-plan').disabled, true);
    assert.equal(ui.byId('refresh-commerce').textContent, 'Retry checkout restore');
    const before = ui.requests.length;
    ui.respond(commerce());
    ui.respond({ state: networkState({ status: 'awaiting_paypal_approval', checkout: { nonAtomic: true,
      legs: checkoutLegs('awaiting_paypal_approval') } }) });
    await ui.byId('refresh-commerce').fire('click');
    assert.deepEqual(ui.requests.slice(before).map(({ path, method }) => ({ path, method })), [
      { path: '/api/commerce-status', method: 'GET' }, { path: sessionPath, method: 'GET' },
    ]);
    assert.equal(ui.requests.at(-1).headers['x-procurement-secret'], sessionSecret);
    assert.equal(ui.byId('refresh-commerce').textContent, 'Refresh availability');
    assert.equal(ui.byId('reconcile').disabled, false);
    assert.equal(ui.byId('find-plan').disabled, true, 'Restoring an unfinished checkout never enables a replacement purchase.');
    assert.equal(checkoutLinks(ui)[0].attributes.href, 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1');
    assert.equal(checkoutButtons(ui).length, 0, 'A successful read never grants capture permission.');
    assert.equal(storage.get(storageKey), savedCheckout().get(storageKey));
  }
});

test('an authenticated completed return clears old callback ids before a new plan can be saved', async () => {
  const completed = networkState({ status: 'completed', checkout: { legs: checkoutLegs('confirmed') } });
  const storage = savedCheckout();
  const ui = browser({ mode: 'paypal-sandbox', storage, search: `?checkout=${encodeURIComponent(sessionId)}&leg=leg-1&returned=1&token=ORDER1&PayerID=BUYER&campaign=club`,
    initialResponses: [commerce(), { state: completed }] });
  await ui.ready();
  assert.equal(ui.location.search, '?campaign=club', 'Only callback parameters are removed, after authentication.');
  assert.deepEqual(ui.historyChanges, ['/procurement?campaign=club']);
  assert.equal(ui.byId('find-plan').disabled, false);

  const next = networkState({ id: 'new-order' });
  ui.respond({ id: next.id, sessionSecret: 'new-secret', state: next, commerce: commerce() });
  await ui.byId('request').fire('submit');
  assert.deepEqual(JSON.parse(storage.get(storageKey)), { id: next.id, secret: 'new-secret' });
  const reloaded = browser({ mode: 'paypal-sandbox', storage, search: ui.location.search,
    initialResponses: [commerce(), { state: next }] });
  await reloaded.ready();
  assert.equal(reloaded.byId('error').textContent, '');
  assert.equal(reloaded.requests[1].path, '/api/procurement/new-order');
  assert.equal(reloaded.requests[1].headers['x-procurement-secret'], 'new-secret');
  assert.ok(reloaded.requests.every((request) => request.method === 'GET'), 'Reloading a new plan still performs no provider writes.');
});
