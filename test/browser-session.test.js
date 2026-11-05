import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const KEY = 'pledge-line.call-session';
const ID = 'daff0172-e04b-4c63-91cf-59f6a04c4217';
const SECRET = 'a'.repeat(64);
const RECEIPT = 'synthetic-receipt-capability';
const tick = () => new Promise((resolve) => setImmediate(resolve));

class Element {
  constructor(tag = 'DIV') {
    this.tagName = tag; this.dataset = {}; this.value = ''; this.textContent = ''; this.events = {};
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  addEventListener(name, callback) { this.events[name] = callback; }
  fire(name, event = {}) { return this.events[name]?.({ preventDefault() {}, ...event }); }
  replaceChildren(...children) { this.children = children; }
  append(...children) { (this.children ??= []).push(...children); }
  focus() {}
}

function browser({ storage = new Map(), restored = false, getStatus = 200, endStatus = 200 } = {}) {
  const elements = new Map(), requests = [], pageEvents = {}, localWrites = [];
  const byId = (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const document = { getElementById: byId, querySelectorAll: () => [], createElement: (tag) => new Element(tag.toUpperCase()), addEventListener() {} };
  let recognition, turn = restored ? 7 : 0, ended = false;
  class SpeechRecognition {
    constructor() { recognition = this; }
    start() {}
    stop() { this.onend(); }
    abort() { this.onend(); }
  }
  const state = () => ({ callId: ID, turn, restored, verified: !restored, ended, locked: false, pending: null, record: {}, receipts: [] });
  const json = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
  const fetch = async (path, options = {}) => {
    requests.push({ path, options });
    if (path === '/api/pilot-scripts') return json({ scripts: [] });
    if (path === '/api/drills') return json({ drills: [] });
    if (path === '/api/calls') return json({ callId: ID, sessionSecret: SECRET, receiptSecret: RECEIPT, turn, reply: 'Enter your PIN.', state: state() });
    assert.equal(options.headers?.['x-call-secret'], SECRET);
    if (path === `/api/calls/${ID}`) return json(getStatus === 200
      ? { ...state(), events: [{ type: 'said', turn, text: 'An earlier request asked for yes.' }, ...(restored ? [{ type: 'session_restored' }] : [])] }
      : { error: 'Call temporarily unavailable.' }, getStatus);
    if (path.endsWith('/end')) {
      if (endStatus !== 200) return json({ error: 'End was not saved.' }, endStatus);
      ended = true;
      return json({ ok: true, state: state() });
    }
    if (path.endsWith('/turn')) {
      turn += 1;
      return json({ reply: 'Enter your PIN.', turn, state: state() });
    }
    if (path.endsWith('/gap')) return json({ ok: true });
    throw new Error(`Unexpected request ${path}`);
  };
  const window = { SpeechRecognition, location: { search: '' },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    localStorage: { getItem: () => null, setItem: (...args) => localWrites.push(args) },
    addEventListener: (name, handler) => { pageEvents[name] = handler; } };
  vm.runInNewContext(app, { window, document, navigator: { userAgent: 'test', vendor: '' }, fetch,
    HTMLElement: Element, performance, URLSearchParams, Intl, Date, setTimeout, clearTimeout });
  return { byId, requests, storage, localWrites, pageEvents, getRecognition: () => recognition };
}

test('tab reload keeps the original bearer, fetches the saved turn, and never replays an input or approval', async () => {
  const first = browser();
  await first.byId('start').fire('click');
  assert.deepEqual(JSON.parse(first.storage.get(KEY)), { callId: ID, sessionSecret: SECRET, receiptSecret: RECEIPT });
  assert.deepEqual(first.localWrites, []);
  first.byId('talk').fire('pointerdown');
  first.getRecognition().onresult({ resultIndex: 0, results: [{ 0: { transcript: 'yes' }, isFinal: true }] });
  first.pageEvents.pagehide();
  await tick();
  assert.equal(first.requests.filter(({ options }) => options.method === 'POST').length, 1, 'pagehide does not end or submit the call');

  const next = browser({ storage: first.storage, restored: true });
  await tick();
  assert.equal(next.requests.filter(({ options }) => options.method === 'POST').length, 0);
  assert.match(next.byId('status').textContent, /PIN again.*new request/);
  assert.equal(next.byId('reply').textContent, 'Call restored. Enter your PIN, then make a new request.');
  assert.equal(next.byId('pending').hidden, true);
  next.byId('typed-text').value = 'yes';
  next.byId('typed-form').fire('submit');
  await tick();
  const sent = next.requests.find(({ path }) => path.endsWith('/turn'));
  assert.deepEqual(JSON.parse(sent.options.body), { text: 'yes', source: 'typed', answering: 7 });
  assert.ok(next.requests.every(({ path }) => !path.includes(SECRET)));
});

test('explicit End removes the saved call only after its authenticated end succeeds', async () => {
  const ui = browser();
  await ui.byId('start').fire('click');
  await ui.byId('start').fire('click');
  assert.equal(ui.storage.has(KEY), false);
  assert.match(ui.byId('status').textContent, /Call ended/);
  assert.equal(ui.requests.filter(({ path }) => path.endsWith('/end')).length, 1);

  const failed = browser({ endStatus: 503 });
  await failed.byId('start').fire('click');
  await failed.byId('start').fire('click');
  assert.equal(failed.storage.has(KEY), true);
  assert.equal(failed.byId('start').textContent, 'End call');
  assert.equal(failed.byId('status').textContent, 'End was not saved.');
});

test('invalid saved credentials are removed but temporary restore failure preserves the capability', async () => {
  const saved = () => new Map([[KEY, JSON.stringify({ callId: ID, sessionSecret: SECRET, receiptSecret: RECEIPT })]]);
  const denied = browser({ storage: saved(), getStatus: 403 });
  await tick();
  assert.equal(denied.storage.has(KEY), false);
  const unavailable = browser({ storage: saved(), getStatus: 503 });
  await tick();
  assert.equal(unavailable.storage.has(KEY), true);
  assert.equal(unavailable.requests.filter(({ options }) => options.method === 'POST').length, 0);
  const invalid = browser({ storage: new Map([[KEY, JSON.stringify({ callId: ID, sessionSecret: 'bad', receiptSecret: RECEIPT })]]) });
  await tick();
  assert.equal(invalid.storage.has(KEY), false);
  assert.ok(!invalid.requests.some(({ path }) => path === `/api/calls/${ID}`));
});
