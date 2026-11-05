import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../web/procurement.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../web/procurement.html', import.meta.url), 'utf8');
const sessionId = 'order/one with spaces';
const sessionSecret = 'synthetic-session-secret';
const sessionPath = `/api/procurement/${encodeURIComponent(sessionId)}`;

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
  focus() { this.focused = true; }
  addEventListener(name, callback) {
    const listeners = this.events.get(name) || [];
    listeners.push(callback);
    this.events.set(name, listeners);
  }
  async fire(name) {
    for (const callback of this.events.get(name) || []) await callback({ preventDefault() {} });
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

function browser({ now = Date.now() } = {}) {
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
  const responses = [];
  const createdTags = [];
  const fetch = async (path, options = {}) => {
    requests.push({ path, method: options.method, headers: { ...options.headers },
      body: options.body === undefined ? undefined : JSON.parse(options.body) });
    if (!responses.length) throw new Error(`Unexpected request: ${path}`);
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return { ok: response.status >= 200 && response.status < 300, json: async () => response.data };
  };
  vm.runInNewContext(app, {
    document: { getElementById: byId, createElement(tag) { createdTags.push(tag); return new Element(tag); } },
    fetch, Intl, Date: ClockDate, AbortController, setTimeout, clearTimeout, setInterval() {}, encodeURIComponent,
  }, { filename: 'web/procurement.js' });
  return {
    byId, requests, createdTags,
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
