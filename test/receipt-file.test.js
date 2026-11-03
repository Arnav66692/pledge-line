// The donor's receipt file: its content, its signatures, the check, the routes and what it must never hold.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { buildDeps, createServer } from '../src/server.js';
import { buildReceipts, receiptOptions } from '../src/receipt.js';
import { receiptBody, receiptFile, PLAIN_NOTE } from '../src/receipt-file.js';
import { createReceiptSigner, publicKeyFromHex, verifyReceipt, secretMatches, canonical } from '../src/receipt-seal.js';
import { PILOT_SCRIPTS } from '../src/pilot-scripts.js';
import { buildStack, runScript, tempDir, tempLedgerPath } from './helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Six digits, so no uuid or debug id holds it by chance. Hex hashes can, so those are left out of the PIN search.
const PIN = '482613';
const KEY = randomBytes(32).toString('hex');
const OTHER_KEY = randomBytes(32).toString('hex');
const FILE_EMAIL = 'sb-maria@personal.example.com';
const NEW_EMAIL = 'bob.new@gmail.com';
const AGENT = 'Mozilla/5.0 receipt-test-agent';
const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const silent = { info: () => {}, error: () => {} };
const servers = [];
const signer = createReceiptSigner(KEY);
const lineKey = { publicKey: signer.publicKey, keyId: signer.keyId };

async function serve(env) {
  const config = loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules', PILOT_PIN: PIN, ...env });
  const deps = buildDeps(config, { ledgerPath: tempLedgerPath(), log: silent, sleep: async () => {} });
  const server = createServer(deps);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { deps, base: `http://127.0.0.1:${server.address().port}` };
}

const post = (base, route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** A call through HTTP, as the page makes it: a pause and its yes, a new email, the PIN said aloud, a callback. */
async function httpCall(base, { end = true } = {}) {
  const start = await (await post(base, '/api/calls', { script: null, userAgent: AGENT, client: { vendor: 'Google Inc.', chrome: true, uaData: true } })).json();
  let answering = start.turn;
  const say = async (text, source = 'typed') => {
    const result = await (await post(base, `/api/calls/${start.callId}/turn`, { text, source, answering })).json();
    answering = result.turn;
  };
  await say(PIN, 'keypad');
  await say('How much is my monthly gift?');
  await say('Please pause my monthly gift.');
  await say('Yes.');
  await say(`Send a one-time gift of 20 dollars to ${NEW_EMAIL} please`);
  await say('I want to give a one-time gift of 20 dollars.');
  await say('Yes.');
  await say(`My PIN is ${PIN.split('').join(' ')}`);
  await say('Can a person call me back?');
  if (end) await say('Goodbye.');
  return start;
}

const getReceipt = (base, callId, secret) => fetch(`${base}/api/receipts/${callId}`, { headers: secret === null ? {} : { 'x-receipt-secret': secret } });

let off;
let on;
let call;
let other;
let live;

before(async () => {
  off = await serve({});
  on = await serve({ RECEIPT_SIGNING_KEY: KEY });
  call = await httpCall(on.base);
  other = await httpCall(on.base);
  live = await httpCall(on.base, { end: false });
  await httpCall(off.base);
});

after(() => { for (const server of servers) server.close(); });

/** The file's sentences without their seals, beside buildReceipts' sentences in the same order. */
function contentOf(text) {
  return JSON.parse(text).sentences.map(({ link, sig, n, turn, at, note, ...rest }) => rest);
}
const expectedContent = (events, config) => buildReceipts(events, receiptOptions(config))
  .flatMap((r) => r.sentences.map((s) => JSON.parse(JSON.stringify({ text: s.text, verdict: s.verdict, facts: s.facts, claims: s.claims, problems: s.problems }))));

async function endedScript(number) {
  const stack = buildStack({ env: { PILOT_PIN: PIN } });
  const script = PILOT_SCRIPTS.find((s) => s.number === number);
  const { callId } = await runScript(stack, script);
  await stack.calls.end(callId);
  return { stack, callId, events: stack.ledger.byCall(callId) };
}

test('the receipt holds every sentence buildReceipts gives, in order, for all ten scripts', async () => {
  for (const script of PILOT_SCRIPTS) {
    const { stack, events } = await endedScript(script.number);
    const { text } = receiptFile(events, stack.config, signer);
    const file = JSON.parse(text);
    assert.deepEqual(contentOf(text), expectedContent(events, stack.config), `Script ${script.number}`);
    const said = buildReceipts(events, receiptOptions(stack.config));
    const turns = said.flatMap((r) => r.sentences.map(() => [r.turn, r.ts]));
    assert.deepEqual(file.sentences.map((s) => [s.turn, s.at]), turns, `Script ${script.number} turns and times`);
    assert.deepEqual(file.sentences.map((s) => s.n), file.sentences.map((_, i) => i + 1));
    for (const s of file.sentences) assert.equal(s.note, s.verdict === 'plain' ? PLAIN_NOTE : s.note, 'plain sentences carry the plain note');
    if (events.some((e) => e.type === 'read')) assert.ok(file.sentences.some((s) => s.verdict === 'proven' && s.facts.some((f) => f.proof?.ts && f.proof?.status !== undefined)), `Script ${script.number} has a proven fact with its read`);
    assert.equal(file.sentences.filter((s) => s.verdict === 'blocked').length, 0, `Script ${script.number} has no blocked sentence`);
    assert.equal(verifyReceipt(text, lineKey).ok, true, `Script ${script.number} verifies`);
  }
});

test('a call that has not ended has no receipt yet, and the same call always gives the same file', async () => {
  const stack = buildStack({ env: { PILOT_PIN: PIN } });
  const { callId } = stack.calls.start({ script: null, userAgent: 'node-test' });
  await stack.calls.turn(callId, { text: PIN, source: 'keypad', answering: 0 });
  await stack.calls.turn(callId, { text: 'How much is my monthly gift?', source: 'typed', answering: 1 });
  assert.deepEqual(receiptBody(stack.ledger.byCall(callId), stack.config), { error: 'not_ended' });
  assert.deepEqual(receiptBody([], stack.config), { error: 'not_found' });
  await stack.calls.end(callId);
  const first = receiptFile(stack.ledger.byCall(callId), stack.config, signer).text;
  assert.equal(receiptFile(stack.ledger.byCall(callId), stack.config, signer).text, first);
});

test('the signature verifies with the line key, offline from the hex /receipt-key serves, and fails with another key', async () => {
  const { stack, events } = await endedScript(2);
  const { text } = receiptFile(events, stack.config, signer);
  const offline = publicKeyFromHex(signer.publicHex);
  const result = verifyReceipt(Buffer.from(text), offline);
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.signedByThisLine, true);
  assert.deepEqual(result.changed, []);
  const stranger = createReceiptSigner(OTHER_KEY);
  const foreign = verifyReceipt(receiptFile(events, stack.config, stranger).text, offline);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.signedByThisLine, false);
  assert.deepEqual(foreign.problems, ['This receipt was signed with another key, not by this line.']);
});

/** The line of the file a byte sits on, 0 for the top line, then one per sentence. */
function lineAt(text, index) {
  return Buffer.from(text).subarray(0, index).toString('utf8').split('\n').length - 1;
}

function expectNamed(text, index, result) {
  const buf = Buffer.from(text);
  assert.equal(result.ok, false, `byte ${index} edited still passed`);
  const line = lineAt(text, index);
  const sentences = JSON.parse(text).sentences.length;
  if (buf[index] === 0x0a) {
    // A broken line ending names a sentence beside it, or the top or the end of the file.
    assert.ok(result.problems.length > 0, `byte ${index}`);
    if (line >= 1 && line <= sentences) assert.ok(result.changed.some((n) => n === line || n === line + 1), `newline ${index} names ${result.changed}`);
  } else if (line >= 1 && line <= sentences) {
    assert.deepEqual(result.changed, [line], `byte ${index} on sentence ${line} named ${result.changed}, ${result.problems}`);
  } else {
    assert.deepEqual(result.changed, [], `byte ${index} at the top or end named a sentence`);
  }
}

test('every single edited byte of a short call fails, and names the sentence it is in', async () => {
  const stack = buildStack({ env: { PILOT_PIN: PIN } });
  const { callId } = stack.calls.start({ script: null, userAgent: 'node-test' });
  await stack.calls.turn(callId, { text: PIN, source: 'keypad', answering: 0 });
  await stack.calls.turn(callId, { text: 'Goodbye.', source: 'typed', answering: 1 });
  const { text } = receiptFile(stack.ledger.byCall(callId), stack.config, signer);
  const buf = Buffer.from(text);
  for (let i = 0; i < buf.length; i += 1) {
    const edited = Buffer.from(buf);
    edited[i] ^= 0x01;
    expectNamed(text, i, verifyReceipt(edited, lineKey));
  }
});

test('edited bytes across a long call fail and name their sentence', async () => {
  const { stack, events } = await endedScript(5);
  const { text } = receiptFile(events, stack.config, signer);
  const buf = Buffer.from(text);
  const picks = Array.from({ length: 400 }, (_, i) => Math.floor((i * buf.length) / 400));
  for (const i of picks) {
    for (const value of [buf[i] ^ 0x01, buf[i] ^ 0x20, 0x41]) {
      if (value === buf[i]) continue;
      const edited = Buffer.from(buf);
      edited[i] = value;
      expectNamed(text, i, verifyReceipt(edited, lineKey));
    }
  }
});

/** The file rebuilt with one change, its links redone the way someone without the key could. */
function rebuild(text, change) {
  const lines = text.split('\n');
  const sentences = lines.slice(1, -2).map((line) => JSON.parse(line.replace(/,$/, '')));
  const top = JSON.parse(`${lines[0].replace(/,"sentences":\[$/, '')}}`);
  const changed = change(sentences, top) ?? sentences;
  return `${canonical({ ...top }).slice(0, -1)},"sentences":[\n${changed.map((s, i) => `${canonical(s)}${i < changed.length - 1 ? ',' : ''}`).join('\n')}\n]}\n`;
}

/** Redoes every link from the chain's start, as anyone can with sha256 alone, and moves the chain head to match. */
function relink(top, sentences) {
  let link = top.chain.start;
  const out = sentences.map(({ link: old, sig, ...content }) => {
    const digest = createHash('sha256').update(`pledge-line-receipt/1 sentence\n${canonical(content)}`).digest();
    link = createHash('sha256').update(Buffer.concat([Buffer.from(link, 'hex'), digest])).digest('hex');
    return { ...content, link, sig };
  });
  top.chain = { ...top.chain, head: link };
  return out;
}

test('an edit stays named even when every link after it is rebuilt, and out-of-place sentences are caught', async () => {
  const { stack, events } = await endedScript(2);
  const { text } = receiptFile(events, stack.config, signer);
  assert.equal(rebuild(text, () => null), text, 'the test rebuild matches the line layout');
  const proven = JSON.parse(text).sentences.findIndex((s) => s.verdict === 'proven');

  // Someone without the key rewords one sentence and redoes its link and every link after it, and the chain head.
  const reworded = verifyReceipt(rebuild(text, (s, top) => relink(top, s.map((x, i) => (i === proven ? { ...x, text: `${x.text} Really.` } : x)))), lineKey);
  assert.equal(reworded.ok, false);
  assert.deepEqual(reworded.changed, [proven + 1]);

  const dropped = verifyReceipt(rebuild(text, (s) => s.filter((_, i) => i !== 2)), lineKey);
  assert.equal(dropped.ok, false);
  assert.ok(dropped.changed.includes(3), `a dropped sentence is named where it was, ${dropped.changed}`);
  assert.ok(dropped.problems.some((p) => /signed \d+ sentences, and this file holds/.test(p)));

  const swapped = verifyReceipt(rebuild(text, (s) => [s[1], s[0], ...s.slice(2)]), lineKey);
  assert.equal(swapped.ok, false);
  assert.ok(swapped.changed.includes(1) && swapped.changed.includes(2));

  const pretty = verifyReceipt(JSON.stringify(JSON.parse(text), null, 2), lineKey);
  assert.equal(pretty.ok, false, 'the same values in another layout still fail');
  const unix = verifyReceipt(text.replace(/\n/g, '\r\n'), lineKey);
  assert.equal(unix.ok, false, 'changed line endings fail');
});

test('a sentence copied in from another call breaks the chain at that sentence', async () => {
  const a = await endedScript(2);
  const b = await endedScript(2);
  const textA = receiptFile(a.events, a.stack.config, signer).text;
  const textB = receiptFile(b.events, b.stack.config, signer).text;
  const fromB = textB.split('\n')[3];
  const lines = textA.split('\n');
  lines[3] = fromB;
  const result = verifyReceipt(lines.join('\n'), lineKey);
  assert.equal(result.ok, false);
  assert.ok(result.changed.includes(3), `${result.changed} ${result.problems}`);
});

test('POST /api/calls gives the page a 128-bit secret for its own call, and only that call', async () => {
  assert.match(call.receiptSecret, /^[0-9a-f]{32}$/);
  assert.notEqual(call.receiptSecret, other.receiptSecret);
  assert.equal(secretMatches(on.deps.receiptSigner, call.callId, call.receiptSecret), true);
  assert.equal(secretMatches(on.deps.receiptSigner, other.callId, call.receiptSecret), false);
  const res = await getReceipt(on.base, call.callId, call.receiptSecret);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-security-policy'), CSP);
  const text = await res.text();
  assert.equal(text, receiptFile(on.deps.ledger.byCall(call.callId), on.deps.config, on.deps.receiptSigner).text);
  assert.equal(JSON.parse(text).call.id, call.callId);
  assert.deepEqual(contentOf(text), expectedContent(on.deps.ledger.byCall(call.callId), on.deps.config));
  // The secret is never written down.
  assert.doesNotMatch(fs.readFileSync(on.deps.ledger.path, 'utf8'), new RegExp(call.receiptSecret));
});

test('a wrong, missing or other call secret gets a 401, and a call still going gets a 409', async () => {
  const wrong = [null, '', 'nope', call.receiptSecret.toUpperCase(), `${call.receiptSecret}0`, call.receiptSecret.slice(0, -1), other.receiptSecret, live.receiptSecret];
  for (const secret of wrong) {
    const res = await getReceipt(on.base, call.callId, secret);
    assert.equal(res.status, 401, JSON.stringify(secret));
    const body = await res.text();
    assert.doesNotMatch(body, /sentences|Sunny Hollow/, 'a 401 gives nothing away');
  }
  assert.equal((await getReceipt(on.base, other.callId, call.receiptSecret)).status, 401, "one call's secret never opens another's");
  assert.equal((await getReceipt(on.base, live.callId, live.receiptSecret)).status, 409);
  const unknown = '00000000-0000-4000-8000-000000000000';
  assert.equal((await getReceipt(on.base, unknown, call.receiptSecret)).status, 401);
  assert.equal((await getReceipt(on.base, unknown, on.deps.receiptSigner.secretFor(unknown))).status, 404);
  assert.equal((await fetch(`${on.base}/api/receipts/${call.callId}`, { method: 'POST' })).status, 405);
});

test('with no RECEIPT_SIGNING_KEY every receipt route and file is a 404 and the page gets no secret', async () => {
  const start = await (await post(off.base, '/api/calls', { script: null, userAgent: AGENT })).json();
  assert.equal(start.receiptSecret, undefined);
  assert.equal(off.deps.receiptSigner, null);
  const paths = ['/receipt', '/check', '/receipt-key', '/receipt.html', '/receipt.js', '/receipt.css', '/check.html', '/receipt-check.js',
    '/Receipt.js', '/%72eceipt.js', '/CHECK.html', `/api/receipts/${start.callId}`, '/api/receipts', '/api/receipts/check'];
  for (const route of paths) {
    const res = await fetch(`${off.base}${route}`, { headers: { 'x-receipt-secret': '0'.repeat(32) } });
    assert.equal(res.status, 404, route);
    assert.equal(res.headers.get('content-security-policy'), CSP, route);
  }
  const check = await fetch(`${off.base}/api/receipts/check`, { method: 'POST', body: 'x' });
  assert.equal(check.status, 404);
  assert.equal((await fetch(`${off.base}/`)).status, 200);
  // With the key on, the same files are served.
  for (const route of ['/receipt', '/check', '/receipt.js', '/receipt.css', '/receipt-check.js', '/claim-words.js']) {
    assert.equal((await fetch(`${on.base}${route}`)).status, 200, route);
  }
});

test('the receipt file holds nothing private, and only the call\'s own subscription and drafts', async () => {
  const text = await (await getReceipt(on.base, call.callId, call.receiptSecret)).text();
  const file = JSON.parse(text);
  // Hex seals can hold any digits, so the PIN search reads the file without them.
  const { chain, signature, ...head } = file;
  const words = JSON.stringify({ ...head, sentences: file.sentences.map(({ link, sig, ...rest }) => rest) });
  assert.doesNotMatch(words, new RegExp(PIN), 'no PIN');
  assert.doesNotMatch(words, /4\s*8\s*2\s*6\s*1\s*3|four eight two six/i, 'no PIN digits');
  for (const secret of [FILE_EMAIL, NEW_EMAIL, 'sb-maria', 'bob.new', '@', 'receipt-test-agent', 'Mozilla', AGENT, call.receiptSecret, KEY]) {
    assert.ok(!text.includes(secret), `no ${secret}`);
  }
  for (const field of ['snapshot', 'tokenId', 'userAgent', 'pendingId', 'recipient_email', 'subscriber', 'clientKey', 'heard']) {
    assert.doesNotMatch(text, new RegExp(`"${field}"`), `no ${field} field`);
  }
  const ids = new Set(text.match(UUID));
  assert.deepEqual([...ids], [call.callId], 'the only uuid is the call number, so no token or pending id');
  const events = on.deps.ledger.byCall(call.callId);
  const own = new Set([on.deps.config.demoSubscriptionId, on.deps.config.demoPlanId,
    ...events.filter((e) => e.type === 'staging_write' && e.kind === 'create_draft' && e.id).map((e) => e.id)]);
  const proofIds = file.sentences.flatMap((s) => s.facts).map((f) => f.proof?.id).filter(Boolean);
  assert.ok(proofIds.length > 0);
  for (const id of proofIds) assert.ok(own.has(id), `${id} is the call's own`);
  // The masked email the line reads aloud is the only form of the email in it.
  assert.ok(file.sentences.some((s) => s.text.includes('s b at personal dot example dot com')));
});

test('the check route says a receipt is untouched, and names the sentence an edit changed', async () => {
  const text = await (await getReceipt(on.base, call.callId, call.receiptSecret)).text();
  const check = async (body) => (await fetch(`${on.base}/api/receipts/check`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body })).json();
  const good = await check(text);
  assert.equal(good.keyId, signer.keyId);
  assert.equal(good.check.ok, true);
  assert.equal(good.check.signedByThisLine, true);
  assert.equal(good.check.callId, call.callId);
  const lines = text.split('\n');
  lines[4] = lines[4].replace(/"text":"([^"])/, '"text":"X');
  const bad = await check(lines.join('\n'));
  assert.equal(bad.check.ok, false);
  assert.deepEqual(bad.check.changed, [4]);
  assert.match(bad.check.problems[0], /Sentence 4 was changed/);
  const foreign = await check(receiptFile(on.deps.ledger.byCall(call.callId), on.deps.config, createReceiptSigner(OTHER_KEY)).text);
  assert.equal(foreign.check.ok, false);
  assert.equal(foreign.check.signedByThisLine, false);
  const big = await fetch(`${on.base}/api/receipts/check`, { method: 'POST', body: 'x'.repeat(600 * 1024) });
  assert.equal(big.status, 413);
  assert.equal((await fetch(`${on.base}/api/receipts/check`)).status, 405);
  const key = await (await fetch(`${on.base}/receipt-key`)).json();
  assert.deepEqual(Object.keys(key).sort(), ['alg', 'keyId', 'pem', 'publicKey']);
  assert.equal(key.publicKey, signer.publicHex);
  assert.equal(key.keyId, signer.keyId);
  assert.doesNotMatch(JSON.stringify(key), new RegExp(KEY), 'the private key never leaves');
});

test('scripts/check-receipt.js checks a file offline with only the public key', async () => {
  const dir = tempDir();
  const text = await (await getReceipt(on.base, call.callId, call.receiptSecret)).text();
  const good = path.join(dir, 'receipt.json');
  const edited = path.join(dir, 'edited.json');
  const keyFile = path.join(dir, 'receipt-key.json');
  fs.writeFileSync(good, text);
  const lines = text.split('\n');
  lines[2] = lines[2].replace('"verdict":"plain"', '"verdict":"proven"');
  fs.writeFileSync(edited, lines.join('\n'));
  fs.writeFileSync(keyFile, JSON.stringify(await (await fetch(`${on.base}/receipt-key`)).json()));
  const run = (args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check-receipt.js'), ...args], { encoding: 'utf8', env: {} }) };
    } catch (error) {
      return { code: error.status, out: `${error.stdout}${error.stderr}` };
    }
  };
  const ok = run([good, '--key', keyFile]);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /Untouched, and signed by this key/);
  assert.equal(run([good, '--key', signer.publicHex]).code, 0);
  const changed = run([edited, '--key', keyFile]);
  assert.equal(changed.code, 1, changed.out);
  assert.match(changed.out, /Changed, at sentence 2\./);
  const stranger = createReceiptSigner(OTHER_KEY);
  assert.equal(run([good, '--key', stranger.publicHex]).code, 1);
  assert.equal(run([good]).code, 2);
  assert.equal(run([good, '--key', 'not-a-key']).code, 2);
});

test('RECEIPT_SIGNING_KEY is optional, 64 hex characters, and never shown in an error', () => {
  const base = { PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules' };
  assert.equal(loadConfig(base).receiptSigningKey, null);
  assert.equal(loadConfig({ ...base, RECEIPT_SIGNING_KEY: '' }).receiptSigningKey, null);
  assert.equal(loadConfig({ ...base, RECEIPT_SIGNING_KEY: KEY.toUpperCase() }).receiptSigningKey, KEY);
  for (const bad of ['abc', `${KEY}0`, KEY.slice(0, -1), `${KEY.slice(0, -1)}g`, 'a'.repeat(64), ' '.repeat(3) + 'x'.repeat(64)]) {
    assert.throws(() => loadConfig({ ...base, RECEIPT_SIGNING_KEY: bad }), (error) => {
      assert.match(error.message, /RECEIPT_SIGNING_KEY/);
      assert.ok(!error.message.includes(bad.trim()), 'the value is not echoed');
      return true;
    }, bad);
  }
  assert.equal(loadConfig(base).limits.receiptsPerMinute, 30);
});

test('receipt requests are limited per address, wrong secrets included', async () => {
  const limited = await serve({ RECEIPT_SIGNING_KEY: KEY });
  const limit = limited.deps.config.limits.receiptsPerMinute;
  const unknown = '00000000-0000-4000-8000-000000000000';
  for (let i = 0; i < limit; i += 1) assert.equal((await getReceipt(limited.base, unknown, 'wrong')).status, 401);
  const res = await getReceipt(limited.base, unknown, 'wrong');
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('content-security-policy'), CSP);
});

test('the Content-Security-Policy is the same on every route, receipts on or off', async () => {
  const routes = ['/', '/app.js', '/receipt', '/check', '/receipt.js', '/receipt.css', '/receipt-check.js', '/receipt-key', '/healthz',
    `/api/receipts/${call.callId}`, '/api/receipts/check', '/missing', '/api/missing'];
  for (const { base } of [on, off]) {
    for (const route of routes) assert.equal((await fetch(`${base}${route}`)).headers.get('content-security-policy'), CSP, `${base}${route}`);
  }
  const posted = await fetch(`${on.base}/api/receipts/check`, { method: 'POST', body: 'not a receipt' });
  assert.equal(posted.headers.get('content-security-policy'), CSP);
  assert.equal((await posted.json()).check.ok, false);
});

test('the receipt pages build their content with textContent, never HTML strings, and load nothing from outside', () => {
  for (const file of ['receipt.js', 'receipt-check.js']) {
    const source = fs.readFileSync(path.join(ROOT, 'web', file), 'utf8');
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, file);
  }
  for (const file of ['receipt.html', 'check.html']) {
    const html = fs.readFileSync(path.join(ROOT, 'web', file), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>|<style|\sstyle=|https?:\/\//i, file);
  }
  for (const file of ['receipt.html', 'check.html', 'receipt.js', 'receipt-check.js', 'receipt.css', 'index.html', '../src/receipt-file.js', '../src/receipt-seal.js']) {
    const text = fs.readFileSync(path.join(ROOT, 'web', file), 'utf8');
    assert.doesNotMatch(text, /tamper-proof|tamper proof/i, `${file} says tamper-evident, never tamper-proof`);
    assert.doesNotMatch(text, /\u2014|\bleverage|\bseamless|\brobust\b|\bfoster|\bdelve|tapestry|game-changer|cutting-edge/i, `${file} copy`);
  }
  for (const file of ['receipt.html', 'check.html']) {
    const words = fs.readFileSync(path.join(ROOT, 'web', file), 'utf8').replace(/<[^>]+>/g, ' ');
    assert.doesNotMatch(words, /;/, `${file} copy uses periods and commas`);
  }
});
