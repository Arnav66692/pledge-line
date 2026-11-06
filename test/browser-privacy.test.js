import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { maskPinText, textHasPin } from '../src/numbers.js';

const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

class Element {
  constructor(tag = 'DIV') {
    this.tagName = tag;
    this.dataset = {};
    this.value = '';
    this.textContent = '';
    this.events = {};
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  addEventListener(name, callback) { this.events[name] = callback; }
  fire(name, event = {}) { return this.events[name]?.({ preventDefault() {}, ...event }); }
  replaceChildren(...children) { this.children = children; }
  append(...children) { (this.children ??= []).push(...children); }
  focus() {}
}

function browser() {
  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const document = { getElementById: byId, querySelectorAll: () => [], createElement: (tag) => new Element(tag.toUpperCase()), addEventListener() {} };
  let recognition;
  class SpeechRecognition {
    constructor() { recognition = this; }
    start() {}
    stop() { this.onend(); }
  }
  const window = { SpeechRecognition, location: { search: '' }, localStorage: { getItem: () => null, setItem() {} }, addEventListener() {} };
  const pin = '2468';
  const sessionSecret = 'a'.repeat(64);
  let verified = false;
  let turn = 0;
  const events = [];
  const responses = [];
  const state = () => ({ verified, ended: false, locked: false, record: {}, receipts: [] });
  const json = (data) => ({ ok: true, json: async () => data });
  const fetch = async (path, options = {}) => {
    if (path === '/api/pilot-scripts') return json({ scripts: [] });
    if (path === '/api/calls') return json({ callId: 'demo', sessionSecret, turn: 0, reply: 'Enter your PIN.', state: state() });
    if (path.startsWith('/api/calls/demo')) assert.equal(options.headers?.['x-call-secret'], sessionSecret, 'call requests use the page session secret');
    if (path.endsWith('/gap')) return json({ ok: true });
    if (path.endsWith('/turn')) {
      const input = JSON.parse(options.body);
      turn += 1;
      const hidden = !verified || input.source === 'keypad' || textHasPin(input.text, pin);
      events.push({ type: 'heard', turn, source: input.source, text: hidden ? maskPinText(input.text) : input.text });
      verified = true;
      return new Promise((resolve) => responses.push(() => resolve(json({ reply: 'OK.', turn, state: state() }))));
    }
    if (path === '/api/calls/demo') return json({ events, receipts: [] });
    throw Error(`Unexpected route ${path}`);
  };
  vm.runInNewContext(app, { window, document, navigator: { userAgent: 'test', vendor: '' }, fetch, HTMLElement: Element,
    performance, URLSearchParams, Intl, Date, setTimeout, clearTimeout, AbortController, Blob, console });
  return { byId, getRecognition: () => recognition, respond: () => responses.shift()() };
}

test('browser never renders raw speech while listening or waiting for server redaction', async () => {
  const ui = browser();
  await ui.byId('start').fire('click');
  await flush();
  for (const text of ['two four six eight', 'twenty four sixty eight', '２４６８']) {
    ui.byId('talk').fire('pointerdown');
    const rec = ui.getRecognition();
    rec.onresult({ resultIndex: 0, results: [{ 0: { transcript: text }, isFinal: false }] });
    assert.equal(ui.byId('transcript').textContent, 'Listening…');
    ui.byId('talk').fire('pointerup');
    assert.equal(ui.byId('transcript').textContent, 'Checking what you said…');
    ui.respond();
    await flush();
    assert.doesNotMatch(ui.byId('transcript').textContent, /two|four|six|eight|twenty|sixty|２|４|６|８/i);
  }
  // A normal, verified turn is displayed after the server's redaction step.
  ui.byId('talk').fire('pointerdown');
  ui.getRecognition().onresult({ resultIndex: 0, results: [{ 0: { transcript: 'Pause my gift' }, isFinal: true }] });
  ui.byId('talk').fire('pointerup');
  ui.respond();
  await flush();
  assert.equal(ui.byId('transcript').textContent, 'Pause my gift');
});

test('typed input is obscured and a PIN remains masked after submission', async () => {
  assert.match(html, /id="typed-text" type="password"/);
  const ui = browser();
  await ui.byId('start').fire('click');
  await flush();
  ui.byId('typed-text').value = 'twenty four sixty eight';
  ui.byId('typed-form').fire('submit');
  assert.equal(ui.byId('typed-text').value, '');
  assert.equal(ui.byId('transcript').textContent, 'Checking what you said…');
  ui.respond();
  await flush();
  assert.doesNotMatch(ui.byId('transcript').textContent, /twenty|four|sixty|eight/i);
});
