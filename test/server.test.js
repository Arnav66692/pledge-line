import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { buildDeps, createServer, resolveStatic, clientIp } from '../src/server.js';
import { checkWrites } from '../src/check.js';
import { tempLedgerPath } from './helpers.js';

// Six digits, so a random UUID in the ledger cannot contain it by chance.
const PIN = '482613';
const silent = { info: () => {}, error: () => {} };
let server;
let base;
let deps;

async function listen(d) {
  const s = createServer(d);
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  return { s, url: `http://127.0.0.1:${s.address().port}` };
}

before(async () => {
  const config = loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules', PILOT_PIN: PIN });
  deps = buildDeps(config, { ledgerPath: tempLedgerPath(), log: silent, sleep: async () => {} });
  const started = await listen(deps);
  server = started.s;
  base = started.url;
});

after(() => server.close());

function rawGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/`, { method: 'GET', path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

const sessions = new Map();
const callHeaders = (path) => {
  const id = path.match(/^\/api\/calls\/([0-9a-f-]{36})/)?.[1];
  return id && sessions.has(id) ? { 'x-call-secret': sessions.get(id) } : {};
};
const postJson = async (path, body) => {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...callHeaders(path) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  if (path === '/api/calls' && response.ok) {
    const started = await response.clone().json();
    sessions.set(started.callId, started.sessionSecret);
  }
  return response;
};
const getCall = (id) => fetch(`${base}/api/calls/${id}`, { headers: callHeaders(`/api/calls/${id}`) });

test('static files are served from web/ with the right types and security headers', async () => {
  const page = await rawGet('/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.body, /Pledge Line/);
  assert.equal(page.headers['content-security-policy'], "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'");
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.headers['access-control-allow-origin'], undefined);
  assert.match((await rawGet('/app.js')).headers['content-type'], /text\/javascript/);
  assert.match((await rawGet('/style.css')).headers['content-type'], /text\/css/);
});

test('/subscribers serves the subscribers page with the same content security policy as /', async () => {
  const home = await rawGet('/');
  const page = await rawGet('/subscribers');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.body, /Any subscriber can run this line/);
  assert.equal(page.headers['content-security-policy'], home.headers['content-security-policy']);
  assert.equal(page.headers['x-frame-options'], home.headers['x-frame-options']);
});

const PAGE_POLICY = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'";

test('the unseen look files serve with their types and the page policy, with STAFF_KEY unset', async () => {
  const assets = {
    '/chrome.css': /^text\/css/, '/chrome.js': /^text\/javascript/, '/scene.js': /^text\/javascript/,
    '/favicon.svg': /^image\/svg\+xml$/,
    '/fonts/geist-latin-wght-normal.woff2': /^font\/woff2$/,
    '/fonts/instrument-serif-latin-400-normal.woff2': /^font\/woff2$/,
    '/fonts/instrument-serif-latin-400-italic.woff2': /^font\/woff2$/,
    '/fonts/OFL-geist.txt': /^text\/plain/, '/fonts/OFL-instrument-serif.txt': /^text\/plain/,
  };
  for (const [path, type] of Object.entries(assets)) {
    const res = await rawGet(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers['content-type'], type, path);
    assert.equal(res.headers['content-security-policy'], PAGE_POLICY, path);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', path);
  }
  // The README is notes for people, not a page file.
  assert.equal((await rawGet('/fonts/README.md')).status, 404);
});

test('the fonts match the sha256 in web/fonts/README.md', async () => {
  const { createHash } = await import('node:crypto');
  const dir = new URL('../web/fonts/', import.meta.url);
  const readme = fs.readFileSync(new URL('README.md', dir), 'utf8');
  const rows = [...readme.matchAll(/^\| `([^`]+)` \|.*\| `([0-9a-f]{64})` \|$/gm)];
  const files = fs.readdirSync(dir).filter((f) => f !== 'README.md').sort();
  assert.deepEqual(rows.map((r) => r[1]).sort(), files);
  for (const [, file, sum] of rows) assert.equal(createHash('sha256').update(fs.readFileSync(new URL(file, dir))).digest('hex'), sum, file);
});

test('the baked room files serve with their types and the page policy, with STAFF_KEY unset', async () => {
  const assets = { '/room/room.glb': /^model\/gltf-binary$/, '/room/room-light.webp': /^image\/webp$/, '/room/rocks-light.webp': /^image\/webp$/ };
  for (const [path, type] of Object.entries(assets)) {
    const res = await rawGet(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers['content-type'], type, path);
    assert.equal(res.headers['content-security-policy'], PAGE_POLICY, path);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', path);
  }
  // The README is notes for people, not a page file.
  assert.equal((await rawGet('/room/README.md')).status, 404);
});

test('the room files match the sha256 in web/room/README.md and stay under 1 MB together', async () => {
  const { createHash } = await import('node:crypto');
  const dir = new URL('../web/room/', import.meta.url);
  const readme = fs.readFileSync(new URL('README.md', dir), 'utf8');
  const rows = [...readme.matchAll(/^\| `([^`]+)` \|.*\| (\d+) \| `([0-9a-f]{64})` \|$/gm)];
  const files = fs.readdirSync(dir).filter((f) => f !== 'README.md').sort();
  assert.deepEqual(rows.map((r) => r[1]).sort(), files);
  let total = 0;
  for (const [, file, bytes, sum] of rows) {
    const data = fs.readFileSync(new URL(file, dir));
    assert.equal(data.length, Number(bytes), file);
    assert.equal(createHash('sha256').update(data).digest('hex'), sum, file);
    total += data.length;
  }
  assert.ok(total < 1024 * 1024, `room files are ${total} bytes`);
  // The room is a glTF 2.0 binary, which the scene's own loader reads.
  const glb = fs.readFileSync(new URL('room.glb', dir));
  assert.equal(glb.readUInt32LE(0), 0x46546c67);
  assert.equal(glb.readUInt32LE(4), 2);
});

test('static path traversal is refused', async () => {
  const attempts = ['/../package.json', '/..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/web/../../package.json',
    '/%2e%2e%2fsrc%2fconfig.js', '//etc/passwd', '/..\\package.json', '/%252e%252e/package.json', '/%00index.html', '/.env', '/web/'];
  for (const path of attempts) {
    const res = await rawGet(path);
    assert.ok([400, 404].includes(res.status), `${path} gave ${res.status}`);
    assert.doesNotMatch(res.body, /"name": "pledge-line"|SANDBOX_BASE_URL|root:/, path);
  }
  assert.equal(resolveStatic('/../package.json'), null);
  assert.equal(resolveStatic('/%2e%2e/package.json'), null);
});

test('bad JSON is a 400 and an oversized body is a 413', async () => {
  const bad = await postJson('/api/calls', '{"script": 1,');
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /not valid JSON/);
  const big = await postJson('/api/calls', JSON.stringify({ pad: 'x'.repeat(20000) }));
  assert.equal(big.status, 413);
  const unknown = await fetch(`${base}/api/calls/00000000-0000-4000-8000-000000000000`);
  assert.equal(unknown.status, 401);
  const health = await (await fetch(`${base}/healthz`)).json();
  assert.deepEqual(health, { ok: true, mode: { paypal: 'mock', router: 'rules' } });
});

test('the PIN never appears in replies, call state, events or the ledger file', async () => {
  const start = await (await postJson('/api/calls', { script: 1, userAgent: 'Mozilla/5.0 Chrome/140.0 Safari/537.36' })).json();
  const bodies = [JSON.stringify(start)];
  const turns = [{ text: PIN, source: 'keypad' }, { text: 'How much is my monthly gift?', source: 'typed' }, { text: `my pin is ${PIN}`, source: 'typed' },
    { text: 'four eight two six one three', source: 'voice' }, { text: 'it is forty eight twenty six thirteen', source: 'voice' }];
  for (const turn of turns) {
    const res = await postJson(`/api/calls/${start.callId}/turn`, turn);
    assert.equal(res.status, 200);
    bodies.push(await res.text());
  }
  const state = await (await getCall(start.callId)).text();
  bodies.push(state);
  assert.ok(JSON.parse(state).verified);
  // The same PIN in compound words, before the PIN passes, in a second call.
  const second = await (await postJson('/api/calls', { script: 1 })).json();
  const spoken = await (await postJson(`/api/calls/${second.callId}/turn`, { text: 'forty eight twenty six thirteen', source: 'voice' })).json();
  assert.equal(spoken.state.verified, true);
  bodies.push(JSON.stringify(spoken), await (await getCall(second.callId)).text());
  for (const body of bodies) {
    assert.equal(body.includes(PIN), false, body);
    assert.doesNotMatch(body, /forty eight twenty six thirteen|four eight two six one three/, body);
  }
  const file = fs.readFileSync(deps.ledger.path, 'utf8');
  assert.equal(file.includes(PIN), false);
  assert.doesNotMatch(file, /four eight two six one three|forty eight twenty six thirteen/);
});

test('gap logging validates its body', async () => {
  const start = await (await postJson('/api/calls', { script: null })).json();
  // A gap is only for a reply the line has finished, so the turn comes first (R3-8).
  await postJson(`/api/calls/${start.callId}/turn`, { text: 'hello', source: 'voice', answering: start.turn });
  const ok = await postJson(`/api/calls/${start.callId}/gap`, { turn: 1, gapMs: 1234, source: 'voice', muted: false });
  assert.equal(ok.status, 200);
  const bad = await postJson(`/api/calls/${start.callId}/gap`, { turn: 'x', gapMs: -5, source: 'mind' });
  assert.equal(bad.status, 400);
});

test('new calls are rate limited per IP', async () => {
  const config = loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules' });
  const own = await listen(buildDeps(config, { ledgerPath: tempLedgerPath(), log: silent }));
  try {
    const statuses = [];
    for (let i = 0; i < config.limits.newCallsPerHour + 1; i += 1) {
      statuses.push((await fetch(`${own.url}/api/calls`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
    }
    assert.ok(statuses.slice(0, -1).every((s) => s === 200));
    assert.equal(statuses.at(-1), 429);
  } finally {
    own.s.close();
  }
});

test('behind a proxy, limits key on the right-most forwarded address, which a client cannot set', async () => {
  const fake = (forwarded) => ({ headers: { 'x-forwarded-for': forwarded }, socket: { remoteAddress: '10.9.9.9' } });
  assert.equal(clientIp(fake('203.0.113.50, 198.51.100.7'), true), '198.51.100.7');
  assert.equal(clientIp(fake('198.51.100.7'), true), '198.51.100.7');
  assert.equal(clientIp(fake('203.0.113.50, 198.51.100.7'), false), '10.9.9.9');
  const config = loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules', RENDER: 'true' });
  const own = await listen(buildDeps(config, { ledgerPath: tempLedgerPath(), log: silent }));
  try {
    const post = (forwarded) => fetch(`${own.url}/api/calls`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwarded }, body: '{}' });
    const statuses = [];
    for (let i = 0; i < config.limits.newCallsPerHour + 1; i += 1) statuses.push((await post(`10.0.0.${i}, 203.0.113.7`)).status);
    assert.ok(statuses.slice(0, -1).every((st) => st === 200), statuses.join(' '));
    const blocked = await post('10.0.0.99, 203.0.113.7');
    assert.equal(blocked.status, 429, 'a new left-most value does not buy a fresh limit');
    assert.match(blocked.headers.get('retry-after') ?? '', /^\d+$/);
    assert.match((await blocked.json()).error, /try again in about \d+ minutes?\./);
    assert.equal((await post('203.0.113.8')).status, 200, 'another real address has its own limit');
  } finally {
    own.s.close();
  }
});

test('on Render, wrong PINs add up across calls from one address and then stop PIN entry', async () => {
  const config = loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules', RENDER: 'true', PILOT_PIN: PIN });
  const d = buildDeps(config, { ledgerPath: tempLedgerPath(), log: silent, sleep: async () => {} });
  const own = await listen(d);
  const as = (address) => ({ 'Content-Type': 'application/json', 'X-Forwarded-For': address });
  const ownSessions = new Map();
  const startCall = async (address) => {
    const started = await (await fetch(`${own.url}/api/calls`, { method: 'POST', headers: as(address), body: '{}' })).json();
    ownSessions.set(started.callId, started.sessionSecret);
    return started.callId;
  };
  const sayPin = async (address, callId, text) => (await fetch(`${own.url}/api/calls/${callId}/turn`, { method: 'POST', headers: { ...as(address), 'x-call-secret': ownSessions.get(callId) }, body: JSON.stringify({ text, source: 'keypad' }) })).json();
  try {
    let callId = null;
    for (let miss = 0; miss < config.limits.wrongPinsPerHour; miss += 1) {
      if (miss % config.limits.pinTries === 0) callId = await startCall('198.51.100.20');
      await sayPin('198.51.100.20', callId, '111111');
    }
    const fresh = await startCall('198.51.100.20');
    const refused = await sayPin('198.51.100.20', fresh, PIN);
    assert.equal(refused.state.verified, false, 'even the right PIN is refused once the limit is reached');
    assert.match(refused.reply, /too many wrong PINs from here/);
    assert.deepEqual(d.ledger.byCall(fresh).filter((e) => e.type === 'refused').map((e) => e.reason), ['pin_limit']);
    const other = await sayPin('203.0.113.30', await startCall('203.0.113.30'), PIN);
    assert.equal(other.state.verified, true, 'another address is not affected');
  } finally {
    own.s.close();
  }
});

test('turns say which reply they answer, gaps say whether the reply played, and calls log their engine signals', async () => {
  // What Chrome's device toolbar sends for its iPhone presets, from a page whose engine signals are Chrome's.
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
  const start = await (await postJson('/api/calls', { script: 1, userAgent: iphone, client: { vendor: 'Google Inc.', chrome: true, uaData: true } })).json();
  const bad = await postJson(`/api/calls/${start.callId}/turn`, { text: PIN, source: 'keypad', answering: 'zero' });
  assert.equal(bad.status, 400);
  assert.equal((await postJson(`/api/calls/${start.callId}/turn`, { text: PIN, source: 'keypad', answering: start.turn })).status, 200);
  assert.equal((await postJson(`/api/calls/${start.callId}/gap`, { turn: 1, gapMs: 900, source: 'keypad', muted: false, played: false })).status, 200);
  assert.equal((await postJson(`/api/calls/${start.callId}/gap`, { turn: 1, gapMs: 900, source: 'keypad', played: 'no' })).status, 400);
  const events = deps.ledger.byCall(start.callId);
  const callStart = events.find((e) => e.type === 'call_start');
  assert.equal(callStart.engine, 'chromium');
  assert.equal(callStart.browser, 'other', 'Chrome with an iPhone agent is never Safari');
  assert.equal(events.find((e) => e.type === 'heard').answering, 0);
  assert.equal(events.find((e) => e.type === 'gap').played, false);
});

test('the line logs one gap per finished reply, and refuses the greeting, an unfinished turn and a second gap', async () => {
  const start = await (await postJson('/api/calls', { script: null })).json();
  const gap = (turn) => postJson(`/api/calls/${start.callId}/gap`, { turn, gapMs: 900, source: 'voice', muted: false, played: true });
  assert.equal((await gap(0)).status, 400, 'the greeting has no gap');
  assert.equal((await gap(1)).status, 409, 'turn 1 has not happened yet');
  await postJson(`/api/calls/${start.callId}/turn`, { text: 'hello', source: 'voice', answering: start.turn });
  assert.equal((await gap(1)).status, 200);
  assert.equal((await gap(1)).status, 409, 'a second gap for one turn');
  assert.equal(deps.ledger.byCall(start.callId).filter((e) => e.type === 'gap').length, 1);
});

test('a yes that reaches the line sooner after the asking reply than a person can answer is asked again', async () => {
  const start = await (await postJson('/api/calls', { script: 2 })).json();
  const turn = async (text, source, answering) => (await postJson(`/api/calls/${start.callId}/turn`, { text, source, answering })).json();
  const pin = await turn(PIN, 'keypad', start.turn);
  const offer = await turn('I want to stop my monthly gift.', 'voice', pin.turn);
  // Sent the moment the offer came back, with the right turn, as a script could. No one hears an offer that fast.
  const quick = await turn('Yes.', 'voice', offer.turn);
  assert.match(quick.reply, /Would you like me to pause it\?/);
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  const yes = await turn('Yes.', 'voice', quick.turn);
  assert.match(yes.reply, /as suspended/);
  const events = deps.ledger.byCall(start.callId);
  assert.equal(events.filter((e) => e.type === 'write').length, 1);
  assert.ok(events.find((e) => e.type === 'heard' && e.turn === quick.turn).afterReplyMs < 250);
  assert.deepEqual(checkWrites(events), []);
});

test('ROUTER_MODE gemini needs GEMINI_API_KEY, takes GEMINI_MODEL, and counts as a real router', () => {
  assert.throws(() => loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'gemini' }), /GEMINI_API_KEY is required when ROUTER_MODE is gemini/);
  const config = loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'gemini', GEMINI_API_KEY: 'k' });
  assert.deepEqual({ ...config.router }, { mode: 'gemini', apiKey: 'k', model: 'gemini-3.5-flash-lite' });
  assert.equal(loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'gemini', GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-2.5-flash-lite' }).router.model, 'gemini-2.5-flash-lite');
  assert.throws(() => loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'openai' }), /ROUTER_MODE must be anthropic, haiku, gemini or rules/);
  assert.equal(loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'gemini', GEMINI_API_KEY: 'k', GEMINI_MODEL: 'models/gemini-3.1-flash-lite' }).router.model, 'gemini-3.1-flash-lite');
  assert.throws(() => loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'gemini', GEMINI_API_KEY: 'k', GEMINI_MODEL: 'Gemini 3.5 Flash Lite' }), /GEMINI_MODEL must be a model id/);
});

test('guarded Anthropic mode requires both explicit API keys and pins the priced main model', () => {
  assert.throws(() => loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'anthropic' }), /ANTHROPIC_API_KEY is required/);
  assert.throws(() => loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'anthropic', ANTHROPIC_API_KEY: 'synthetic-anthropic-key' }), /TYPESAFE_API_KEY is required/);
  const config = loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'anthropic', ANTHROPIC_API_KEY: 'synthetic-anthropic-key', TYPESAFE_API_KEY: 'synthetic-jev-key', ANTHROPIC_AUTH_TOKEN: 'subscription-session-must-not-be-used', ANTHROPIC_BASE_URL: 'https://untrusted.example' });
  assert.deepEqual({ ...config.router }, { mode: 'anthropic', apiKey: 'synthetic-anthropic-key', jevApiKey: 'synthetic-jev-key', model: 'claude-sonnet-5-5' });
});
