import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadConfig } from '../src/config.js';
import { buildDeps, createServer } from '../src/server.js';
import { tempLedgerPath } from './helpers.js';

test('guided evidence page is available without a PIN and cannot start a payment by POST', async () => {
  const deps = buildDeps(loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules' }), { ledgerPath: tempLedgerPath(), log: { info() {}, error() {} } });
  const server = createServer(deps);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base + '/demo');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Recorded PayPal sandbox outcomes/);
    assert.equal((await fetch(base + '/demo', { method: 'POST' })).status, 405);
    const receipt = JSON.parse(await (await fetch(base + '/demo-assets/covered-month-receipt.txt')).text());
    assert.equal(receipt.call.paypal, 'sandbox');
    assert.equal(receipt.signature.keyId, 'b63c499b55817461');
    assert.doesNotMatch(JSON.stringify(receipt), /sessionSecret|receiptSecret|API_KEY|sk-ant-|postgresql:\/\//);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

function browser({ originalValid = true }) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { textContent: '', hidden: false, disabled: false, events: {},
      addEventListener(name, fn) { this.events[name] = fn; }, setAttribute() {}, removeAttribute() {}, focus() {} });
    return elements.get(id);
  };
  const calls = [], chapters = [0, 1, 2, 3].map((i) => element(`chapter${i}`));
  const context = { document: { getElementById: element, querySelector: element, addEventListener() {},
    querySelectorAll: (selector) => selector === '.chapter' ? chapters : [0, 1, 2, 3].map((i) => element(`link${i}`)) },
  window: { addEventListener() {} }, setTimeout, clearTimeout,
  fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('.txt')) return { ok: true, text: async () => JSON.stringify({ sentences: [{ text: 'Your refund was $25.00.' }] }) };
    assert.equal(url, '/api/receipts/check');
    const altered = JSON.parse(options.body).sentences[0].text.includes('$250.00');
    return { ok: true, json: async () => ({ check: { ok: originalValid && !altered } }) };
  } };
  vm.runInNewContext(fs.readFileSync(new URL('../web/demo.js', import.meta.url), 'utf8'), context);
  return { element, calls };
}

test('tampering demo verifies the original before attributing failure to the edit', async () => {
  const failed = browser({ originalValid: false });
  await failed.element('verify-edited').events.click();
  assert.match(failed.element('verification').textContent, /could not verify the original/);
  assert.equal(failed.calls.filter((call) => call.options?.method === 'POST').length, 1);
  const valid = browser({ originalValid: true });
  await valid.element('verify-edited').events.click();
  assert.match(valid.element('verification').textContent, /Edited copy rejected/);
  assert.equal(valid.calls.filter((call) => call.options?.method === 'POST').length, 2);
  assert.equal(valid.element('verify-edited').disabled, false);
});
