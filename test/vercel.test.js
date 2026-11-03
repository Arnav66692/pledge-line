import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, VERCEL_LEDGER, MOCK_DEFAULT_PIN } from '../src/config.js';
import { buildDeps, createServer } from '../src/server.js';
import { createVercelHandler } from '../src/vercel.js';
import { checkWrites } from '../src/check.js';
import { tempLedgerPath } from './helpers.js';

const PAGE_POLICY = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'";
const SAME_HEADERS = ['content-security-policy', 'x-content-type-options', 'referrer-policy', 'x-frame-options', 'content-type', 'cache-control'];
const silent = { info: () => {}, error: () => {} };
const DEMO_ENV = Object.freeze({ VERCEL: '1' });
const BASE = 'https://pledge-line-demo.vercel.app';

let local;
let localUrl;

before(async () => {
  const config = loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules' });
  local = createServer(buildDeps(config, { ledgerPath: tempLedgerPath(), log: silent }));
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  localUrl = `http://127.0.0.1:${local.address().port}`;
});

after(() => local.close());

function demoHandler(env = DEMO_ENV, extra = {}) {
  const ledgerPath = tempLedgerPath();
  const handle = createVercelHandler({ env, overrides: { ledgerPath, log: silent, ...extra } });
  return { handle, ledgerPath };
}

const ip = (address) => ({ 'x-forwarded-for': address });
const get = (handle, path, headers = ip('198.51.100.1')) => handle(new Request(`${BASE}${path}`, { headers }));
const post = (handle, path, body, headers = ip('198.51.100.1')) => handle(new Request(`${BASE}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
}));

test('on Vercel the config defaults to mock and rules, trusts the proxy, uses the mock PIN and keeps the ledger in /tmp', () => {
  const config = loadConfig(DEMO_ENV);
  assert.equal(config.paypal.mode, 'mock');
  assert.equal(config.router.mode, 'rules');
  assert.equal(config.trustProxy, true);
  assert.equal(config.pin, MOCK_DEFAULT_PIN);
  assert.equal(config.ledgerPath, VERCEL_LEDGER);
  assert.ok(VERCEL_LEDGER.startsWith('/tmp/'));
  assert.equal(config.staffKey, null);
});

test('on Vercel the config refuses sandbox, a real router, real keys, a real PIN and a ledger outside /tmp', () => {
  const refuses = (env, pattern) => assert.throws(() => loadConfig({ ...DEMO_ENV, ...env }), pattern);
  refuses({ PAYPAL_MODE: 'sandbox', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PILOT_PIN: '482613' }, /PAYPAL_MODE must be mock on Vercel/);
  refuses({ PAYPAL_MODE: 'sandbox' }, /PAYPAL_MODE must be mock on Vercel/);
  refuses({ ROUTER_MODE: 'gemini', GEMINI_API_KEY: 'key' }, /ROUTER_MODE must be rules on Vercel/);
  refuses({ ROUTER_MODE: 'haiku' }, /ROUTER_MODE must be rules on Vercel/);
  for (const name of ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY']) {
    refuses({ [name]: 'set-by-mistake' }, new RegExp(`${name} must not be set on Vercel`));
  }
  refuses({ PILOT_PIN: '482613' }, /PILOT_PIN must be unset on Vercel/);
  refuses({ LEDGER_PATH: '.pilot/ledger.jsonl' }, /LEDGER_PATH must be under \/tmp on Vercel/);
  refuses({ LEDGER_PATH: '/var/task/ledger.jsonl' }, /LEDGER_PATH must be under \/tmp on Vercel/);
  assert.equal(loadConfig({ ...DEMO_ENV, LEDGER_PATH: '/tmp/demo/ledger.jsonl' }).ledgerPath, '/tmp/demo/ledger.jsonl');
  assert.equal(loadConfig({ ...DEMO_ENV, PILOT_PIN: MOCK_DEFAULT_PIN }).pin, MOCK_DEFAULT_PIN);
});

test('off Vercel the config is unchanged, sandbox by default with no proxy trust', () => {
  assert.throws(() => loadConfig({}), /PILOT_PIN is required in sandbox mode/);
  const config = loadConfig({}, { partial: true });
  assert.equal(config.paypal.mode, 'sandbox');
  assert.equal(config.router.mode, 'haiku');
  assert.equal(config.trustProxy, false);
  assert.equal(config.ledgerPath, '.pilot/ledger.jsonl');
  assert.equal(loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules' }).ledgerPath, '.pilot/mock-ledger.jsonl');
});

test('the handler refuses to start in sandbox mode, on Vercel or not, and never calls PayPal', async () => {
  const fetchImpl = () => { throw new Error('the demo must never reach PayPal'); };
  const cases = [
    { ...DEMO_ENV, PAYPAL_MODE: 'sandbox' },
    { PAYPAL_MODE: 'sandbox', ROUTER_MODE: 'rules', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PILOT_PIN: '482613' },
    { PAYPAL_MODE: 'mock', ROUTER_MODE: 'gemini', GEMINI_API_KEY: 'key' },
  ];
  for (const env of cases) {
    const { handle } = demoHandler(env, { fetchImpl });
    for (const path of ['/', '/healthz']) {
      const res = await get(handle, path);
      assert.equal(res.status, 500, JSON.stringify(env));
      assert.equal(res.headers.get('content-security-policy'), PAGE_POLICY);
      assert.match((await res.json()).error, /not set up right/);
    }
  }
});

test('the handler serves the page and its files with the same headers and bytes as the local server', async () => {
  const { handle } = demoHandler();
  for (const path of ['/', '/app.js', '/style.css', '/chrome.js', '/scene.js', '/favicon.svg', '/fonts/geist-latin-wght-normal.woff2', '/healthz', '/api/pilot-scripts', '/nope.js', '/fonts/README.md', '/src/config.js', '/package.json']) {
    const demo = await get(handle, path);
    const own = await fetch(`${localUrl}${path}`);
    assert.equal(demo.status, own.status, path);
    for (const name of SAME_HEADERS) assert.equal(demo.headers.get(name), own.headers.get(name), `${path} ${name}`);
    assert.equal(demo.headers.get('content-security-policy'), PAGE_POLICY, path);
    assert.deepEqual(Buffer.from(await demo.arrayBuffer()), Buffer.from(await own.arrayBuffer()), path);
  }
  const page = await get(handle, '/');
  assert.match(await page.text(), /Pledge Line/);
  assert.deepEqual(await (await get(handle, '/healthz')).json(), { ok: true, mode: { paypal: 'mock', router: 'rules' } });
});

test('the handler refuses traversal and bad bodies as the local server does', async () => {
  const { handle } = demoHandler();
  for (const path of ['/%2e%2e/package.json', '/..%2fpackage.json', '/fonts/..%2f..%2fpackage.json', '/%00']) {
    const demo = await get(handle, path);
    assert.notEqual(demo.status, 200, path);
    assert.equal(demo.status, (await fetch(`${localUrl}${path}`)).status, path);
  }
  const bad = await handle(new Request(`${BASE}/api/calls`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ip('198.51.100.2') }, body: '{nope' }));
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get('content-security-policy'), PAGE_POLICY);
  const big = await post(handle, '/api/calls', { pad: 'x'.repeat(20000) });
  assert.equal(big.status, 413);
});

test('with STAFF_KEY unset the staff routes and files are 404s', async () => {
  const { handle } = demoHandler();
  for (const path of ['/staff', '/staff.js', '/staff.css', '/staff.html', '/api/staff/calls', '/vendor/ag-grid-community.min.js']) {
    const res = await get(handle, path);
    assert.equal(res.status, 404, path);
    assert.equal(res.headers.get('content-security-policy'), PAGE_POLICY, path);
  }
});

test('Script 2 runs through the handler, the pause is offered and the yes suspends the gift', async () => {
  const { handle, ledgerPath } = demoHandler(DEMO_ENV, { sleep: async () => {} });
  const start = await (await post(handle, '/api/calls', { script: 2 })).json();
  assert.ok(start.callId);
  const turn = async (text, source, answering) => {
    const res = await post(handle, `/api/calls/${start.callId}/turn`, { text, source, answering });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-security-policy'), PAGE_POLICY);
    return res.json();
  };
  const pin = await turn(MOCK_DEFAULT_PIN, 'keypad', start.turn);
  assert.equal(pin.state.verified, true);
  const offer = await turn('I want to stop my monthly gift.', 'typed', pin.turn);
  assert.match(offer.reply, /pause/i);
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  const yes = await turn('Yes.', 'typed', offer.turn);
  assert.match(yes.reply, /as suspended/);
  const bye = await turn('Goodbye.', 'typed', yes.turn);
  assert.ok(bye.reply);
  const state = await (await get(handle, `/api/calls/${start.callId}`)).json();
  const writes = state.events.filter((e) => e.type === 'write');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, 'suspend');
  assert.equal(writes[0].ok, true);
  const { createLedger } = await import('../src/ledger.js');
  const events = createLedger({ path: ledgerPath }).byCall(start.callId);
  assert.deepEqual(checkWrites(events), []);
  assert.equal(JSON.stringify(events).includes(`"${MOCK_DEFAULT_PIN}"`), false);
});

test('behind the Vercel proxy each visitor has its own limit, keyed on X-Forwarded-For', async () => {
  const { handle } = demoHandler();
  const limit = loadConfig(DEMO_ENV).limits.newCallsPerHour;
  for (let i = 0; i < limit; i += 1) assert.equal((await post(handle, '/api/calls', {}, ip('203.0.113.7'))).status, 200);
  const blocked = await post(handle, '/api/calls', {}, ip('203.0.113.7'));
  assert.equal(blocked.status, 429);
  assert.match(blocked.headers.get('retry-after') ?? '', /^\d+$/);
  assert.doesNotMatch((await blocked.json()).error, /npm start/, 'no local hint on the public demo');
  assert.equal((await post(handle, '/api/calls', {}, ip('203.0.113.8'))).status, 200, 'another visitor is not blocked');
});

test('the deps are built once per instance, so a call started on one request is there on the next', async () => {
  let built = 0;
  const handle = createVercelHandler({ env: DEMO_ENV, overrides: { ledgerPath: tempLedgerPath(), log: { info: (line) => { if (/demo ready/.test(line)) built += 1; }, error: () => {} } } });
  const start = await (await post(handle, '/api/calls', { script: 1 })).json();
  assert.equal((await get(handle, `/api/calls/${start.callId}`)).status, 200);
  await get(handle, '/');
  assert.equal(built, 1);
});

test('the shared mock gift is reset when a call starts with no other call live, so Script 2 suspends it every time', async () => {
  const { handle } = demoHandler(DEMO_ENV, { sleep: async () => {} });
  for (let run = 1; run <= 2; run += 1) {
    const start = await (await post(handle, '/api/calls', { script: 2 })).json();
    const turn = async (text, source, answering) => (await post(handle, `/api/calls/${start.callId}/turn`, { text, source, answering })).json();
    const pin = await turn(MOCK_DEFAULT_PIN, 'keypad', start.turn);
    assert.equal(pin.state.verified, true, `run ${run}`);
    const offer = await turn('I want to stop my monthly gift.', 'typed', pin.turn);
    assert.match(offer.reply, /pause/i, `run ${run}`);
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    const yes = await turn('Yes.', 'typed', offer.turn);
    assert.match(yes.reply, /as suspended/, `run ${run}`);
    await turn('Goodbye.', 'typed', yes.turn);
    assert.equal((await (await get(handle, `/api/calls/${start.callId}`)).json()).ended, true, `run ${run} ended`);
  }
});
