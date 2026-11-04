import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadConfig, LIMITS } from '../src/config.js';
import { buildDeps, createServer } from '../src/server.js';
import { twilioSignature, signatureMatches, signedUrl, formFields, callerInput } from '../src/phone.js';
import { gradeCall, checkWrites } from '../src/check.js';
import { TEMPLATE_SENTENCES, TEMPLATE_CLAIMS } from '../src/template-words.js';
import { TEMPLATE_HISTORY } from '../src/template-history.js';
import { CLAIM_FREE } from '../src/vocabulary.js';
import { PILOT_SCRIPTS, scriptByNumber, scriptTurns } from '../src/pilot-scripts.js';
import { staffCall } from '../src/staff.js';
import { createFakeTwilio, playScript, parseTwiml } from '../scripts/fake-twilio.js';
import { tempLedgerPath, makeClock } from './helpers.js';

// Six digits, so a random UUID in the ledger cannot hold it by chance.
const PIN = '482613';
const TOKEN = 'test-auth-token-not-a-real-one';
const PUBLIC = 'https://pledge-line.example.test';
const FROM = '+15551230199';
const AUTOMATED = 'This is an automated line, not a person.';

const open = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => new Promise((resolve) => { server.close(resolve); })));
});

const phoneEnv = (extra = {}) => ({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules', PILOT_PIN: PIN, PHONE_ENABLED: 'true', TWILIO_AUTH_TOKEN: TOKEN, PUBLIC_BASE_URL: PUBLIC, ...extra });

async function serve({ env = phoneEnv(), overrides = {} } = {}) {
  const clock = makeClock();
  const logged = [];
  const log = { info: (line) => logged.push(line), error: (line) => logged.push(line) };
  const ledgerPath = tempLedgerPath();
  const deps = buildDeps(loadConfig({ ...env, LEDGER_PATH: ledgerPath }), { now: clock.now, monotonic: () => clock.t, log, sleep: async () => {}, ...overrides });
  const server = createServer(deps);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  open.push(server);
  const localUrl = `http://127.0.0.1:${server.address().port}`;
  const phone = (options = {}) => createFakeTwilio({ localUrl, publicUrl: PUBLIC, authToken: TOKEN, clock, from: FROM, ...options });
  return { deps, clock, logged, ledgerPath, localUrl, phone };
}

const eventsOf = (deps, type) => deps.ledger.byType(type);
const onlyCall = (deps) => eventsOf(deps, 'call_start').at(-1).callId;
const callEvents = (deps, type) => deps.ledger.byCall(onlyCall(deps)).filter((e) => !type || e.type === type);
const gridStatus = (deps) => deps.paypal.getSubscription(deps.config.demoSubscriptionId).then((r) => r.data.status);

async function verifiedPhone(env, options) {
  const line = await serve(env);
  const fake = line.phone(options);
  await fake.dial();
  await fake.press(PIN);
  return { ...line, fake };
}

// ---- The signature ----

test("the signature matches Twilio's own worked example", () => {
  const fields = { CallSid: 'CA1234567890ABCDE', Caller: '+14158675310', Digits: '1234', From: '+14158675310', To: '+18005551212' };
  const url = 'https://example.com/myapp.php?foo=1&bar=2';
  assert.equal(twilioSignature('12345', url, fields), 'L/OH5YylLD5NRKLltdqwSvS0BnU=');
  assert.equal(signatureMatches('12345', url, fields, 'L/OH5YylLD5NRKLltdqwSvS0BnU='), true);
  assert.equal(signatureMatches('12345', url, { ...fields, Digits: '1235' }, 'L/OH5YylLD5NRKLltdqwSvS0BnU='), false);
  assert.equal(signatureMatches('12345', url, fields, ''), false);
  assert.equal(signatureMatches('12345', url, fields, undefined), false);
  assert.equal(signatureMatches('', url, fields, 'L/OH5YylLD5NRKLltdqwSvS0BnU='), false);
});

test('the signed URL comes from the public address, with the raw path and query, and no https port', () => {
  assert.equal(signedUrl('https://x.onrender.com', '/phone/turn?turn=3'), 'https://x.onrender.com/phone/turn?turn=3');
  assert.equal(signedUrl('https://x.onrender.com:443', '/phone/voice'), 'https://x.onrender.com/phone/voice');
  assert.equal(signedUrl('https://x.onrender.com:8443', '/phone/voice'), 'https://x.onrender.com/phone/voice');
  assert.equal(signedUrl('http://localhost:3000', '/phone/voice'), 'http://localhost:3000/phone/voice');
  assert.equal(formFields(Buffer.from('From=%2B15551230199&SpeechResult=yes+please')).From, '+15551230199');
  assert.equal(formFields(Buffer.from('From=%2B15551230199&SpeechResult=yes+please')).SpeechResult, 'yes please');
});

test('a good signature passes, behind the proxy, and every bad one is refused before anything runs', async () => {
  const { deps, localUrl, phone } = await serve();
  const fake = phone();
  const fields = fake.standard('ringing');
  const bad = [
    await fake.post('/phone/voice', fields, { unsigned: true }),
    await fake.post('/phone/voice', fields, { signature: 'bm90IGEgc2lnbmF0dXJl' }),
    await fake.post('/phone/voice', fields, { token: 'some-other-token' }),
    // The address the server sees behind Render's proxy, which is not the one Twilio signs.
    await fake.post('/phone/voice', fields, { signAs: `${localUrl}/phone/voice` }),
    await fake.post('/phone/voice', fields, { signAs: `${PUBLIC}/phone/turn?turn=1` }),
    await fake.post('/phone/status', { ...fields, CallStatus: 'completed' }, { unsigned: true }),
  ];
  assert.deepEqual(bad.map((r) => r.status), [403, 403, 403, 403, 403, 403]);
  assert.equal(eventsOf(deps, 'call_start').length, 0);
  // One changed field after signing.
  const signature = twilioSignature(TOKEN, `${PUBLIC}/phone/voice`, fields);
  assert.equal((await fake.post('/phone/voice', { ...fields, From: '+15550000000' }, { signature })).status, 403);
  assert.equal((await fake.post('/phone/voice', fields)).status, 200);
  assert.equal(eventsOf(deps, 'call_start').length, 1);
});

test('a changed turn number in the action URL fails its signature', async () => {
  const { deps, fake } = await verifiedPhone();
  const signature = twilioSignature(TOKEN, fake.action, { ...fake.standard('in-progress'), SpeechResult: 'Yes.' });
  const moved = fake.action.replace(/turn=\d+/, 'turn=9');
  assert.equal((await fake.post(moved, { ...fake.standard('in-progress'), SpeechResult: 'Yes.' }, { signature })).status, 403);
  assert.equal(callEvents(deps, 'heard').length, 1);
});

// ---- Off by default ----

test('the phone routes are a 404 unless both PHONE_ENABLED and TWILIO_AUTH_TOKEN are set', async () => {
  const base = { PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules', PILOT_PIN: PIN, PUBLIC_BASE_URL: PUBLIC };
  const cases = [base, { ...base, PHONE_ENABLED: 'true' }, { ...base, TWILIO_AUTH_TOKEN: TOKEN }, { ...base, PHONE_ENABLED: 'false', TWILIO_AUTH_TOKEN: TOKEN }];
  for (const env of cases) {
    const { localUrl, deps } = await serve({ env });
    assert.equal(deps.config.phone.enabled, false);
    for (const route of ['/phone', '/phone/voice', '/phone/turn?turn=1', '/phone/status']) {
      assert.equal((await fetch(`${localUrl}${route}`, { method: 'POST', body: 'CallSid=CA1' })).status, 404, route);
      assert.equal((await fetch(`${localUrl}${route}`)).status, 404, route);
    }
    assert.equal((await fetch(`${localUrl}/healthz`)).status, 200);
  }
});

test('when on, an unknown path under /phone is a 404 and a GET is a 405', async () => {
  const { localUrl } = await serve();
  assert.equal((await fetch(`${localUrl}/phone/other`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${localUrl}/phone/voice`)).status, 405);
});

test('PHONE_VOICE must be a Twilio voice name, and the token never shows in /healthz', async () => {
  assert.throws(() => loadConfig(phoneEnv({ PHONE_VOICE: 'Joanna"><Hangup/>' })), /PHONE_VOICE/);
  const { localUrl } = await serve();
  assert.equal((await (await fetch(`${localUrl}/healthz`)).text()).includes(TOKEN), false);
});

// ---- The first sentence ----

test('the first sentence says it is automated, and it is on the reviewed list', async () => {
  const { phone, deps } = await serve();
  const doc = await phone().dial();
  assert.ok(doc.spoken.startsWith(`${AUTOMATED} Thanks for calling the Sunny Hollow Pantry donor line.`), doc.spoken);
  assert.ok(TEMPLATE_SENTENCES.includes(AUTOMATED));
  assert.ok(CLAIM_FREE.includes(AUTOMATED));
  assert.equal(Object.hasOwn(TEMPLATE_CLAIMS, AUTOMATED), false);
  assert.equal(doc.says[0].voice, 'Polly.Joanna-Neural');
  const start = eventsOf(deps, 'call_start')[0];
  assert.equal(start.channel, 'phone');
  assert.equal(start.script, null);
  assert.equal(start.browser, 'other');
});

test('the browser greeting is unchanged, and every older template list is still in the history', async () => {
  const { deps } = await serve();
  const { reply } = deps.calls.start({ userAgent: 'x' });
  assert.ok(reply.startsWith('Thanks for calling the Sunny Hollow Pantry donor line.'));
  assert.equal(reply.includes('automated'), false);
  const hashes = Object.keys(TEMPLATE_HISTORY);
  assert.ok(hashes.length >= 6, 'five lists from before the phone line and this one');
  assert.ok(hashes.includes(deps.ledger.byType('call_start')[0].templates));
});

// ---- Script 2 by phone ----

test('Script 2 by fake phone: the PIN, the pause offer, a separate yes, and the pause read back from PayPal', async () => {
  const { deps, phone } = await serve();
  const fake = phone();
  const greeting = await fake.dial();
  assert.ok(greeting.gather, 'the greeting listens');
  assert.equal(greeting.says[0].nested, true, 'the PIN can be keyed over the greeting');

  const verified = await fake.press(PIN);
  assert.ok(verified.spoken.startsWith('Thanks, you are verified.'), verified.spoken);

  const offer = await fake.say('I want to stop my monthly gift.');
  assert.match(offer.spoken, /PayPal shows your monthly gift of \$25\.00/);
  assert.match(offer.spoken, /Would you like me to pause it\?/);
  assert.equal(offer.says[0].nested, false, 'a proposal is spoken before the line starts listening');
  assert.notEqual(offer.gather.speechTimeout, 'auto', 'a proposal waits past the first pause');
  assert.equal(deps.ledger.byType('write').length, 0);

  const paused = await fake.say('Yes.');
  assert.match(paused.spoken, /^Done\. PayPal now shows your monthly gift of \$25\.00 as suspended\./);
  assert.equal(await gridStatus(deps), 'SUSPENDED');

  const bye = await fake.say('Goodbye.');
  assert.equal(bye.spoken, 'Thanks for calling. Goodbye.');
  assert.equal(bye.hangup, true);
  assert.equal(bye.gather, null);
  await fake.hangUp();

  const writes = deps.ledger.byType('write');
  assert.deepEqual(writes.map((w) => [w.kind, w.ok]), [['suspend', true]]);
  // The same four checks a browser call gets, the script's own behavior too.
  const grade = gradeCall(deps.ledger.byCall(onlyCall(deps)), scriptByNumber(2));
  assert.equal(grade.passed, true, JSON.stringify(grade));
});

test('every line spoken is the text the call service returned', async () => {
  const { deps, phone } = await serve();
  const heard = await playScript(phone(), scriptByNumber(5), PIN);
  const said = callEvents(deps, 'said').map((e) => e.text);
  assert.deepEqual(heard.map((doc) => doc.spoken), said);
  for (const doc of heard) assert.ok(doc.says.length === 1, 'one <Say> a reply');
});

test('special characters in a reply are escaped for XML', async () => {
  const { deps, phone } = await serve({ env: phoneEnv({ ORG_NAME: "Bob's & Sons <Pantry>" }) });
  const doc = await phone().dial();
  assert.ok(doc.xml.includes('Bob&apos;s &amp; Sons &lt;Pantry&gt;'));
  assert.ok(doc.spoken.includes("Bob's & Sons <Pantry>"));
  assert.equal(callEvents(deps, 'said')[0].text, doc.spoken);
});

// ---- A yes too early ----

test('a yes said over the read-back is never heard, and the read-back comes again', async () => {
  const { deps, fake } = await verifiedPhone();
  const offer = await fake.say('I want to stop my monthly gift.');
  assert.equal(await fake.sayOver('Yes.'), false, 'the line is not listening during the read-back');
  const again = await fake.silence();
  assert.ok(again.spoken.startsWith("Sorry, I didn't catch that."));
  assert.ok(again.spoken.endsWith(offer.spoken));
  assert.equal(deps.ledger.byType('write').length, 0);
  assert.equal(callEvents(deps, 'yes').length, 0);
  await fake.say('Yes.');
  assert.deepEqual(deps.ledger.byType('write').map((w) => w.ok), [true]);
});

test('a yes that reaches the line before the words could have ended does nothing, and a later one still counts', async () => {
  const { deps, fake } = await verifiedPhone();
  const offer = await fake.say('I want to stop my monthly gift.');
  const again = await fake.say('Yes.', { early: true });
  assert.equal(again.spoken, offer.spoken, 'the proposal is spoken again');
  assert.equal(deps.ledger.byType('write').length, 0);
  assert.equal(callEvents(deps, 'yes').length, 0);
  assert.equal(await gridStatus(deps), 'ACTIVE');
  const early = callEvents(deps, 'heard').at(-1);
  assert.equal(early.text, 'Yes.');
  assert.ok(early.afterReplyMs < early.spokenFloorMs, 'the ledger shows why');
  const words = offer.spoken.split(' ').length;
  assert.equal(early.spokenFloorMs, words * LIMITS.spokenFloorMsPerWord);
  await fake.say('Yes.');
  assert.deepEqual(deps.ledger.byType('write').map((w) => w.kind), ['suspend']);
  assert.equal(gradeCall(deps.ledger.byCall(onlyCall(deps)), null).passed, true);
});

test('a yes in flight before the reply that asks exists never counts', async () => {
  const { deps, fake } = await verifiedPhone();
  const turnNow = Number(new URL(fake.action).searchParams.get('turn'));
  const fields = fake.standard('in-progress');
  const stop = fake.post(fake.action, { ...fields, SpeechResult: 'I want to stop my monthly gift.' });
  const yes = fake.post(fake.action.replace(`turn=${turnNow}`, `turn=${turnNow + 1}`), { ...fields, SpeechResult: 'Yes.' });
  const [, answer] = await Promise.all([stop, yes]);
  assert.match(parseTwiml(answer.text).spoken, /pause it\?/);
  assert.equal(deps.ledger.byType('write').length, 0);
  assert.equal(callEvents(deps, 'yes').length, 0);
});

test('a yes in the same breath as the request, or one with more after it, is no yes', async () => {
  const { deps, fake } = await verifiedPhone();
  await fake.say('Pause my gift. Yes, yes, yes.');
  assert.equal(deps.ledger.byType('write').length, 0);
  await fake.say('Yes wait no');
  assert.equal(deps.ledger.byType('write').length, 0);
  assert.equal(callEvents(deps, 'yes').length, 0);
});

test('a yes Twilio is unsure it heard counts as not caught, and a missing or zero score is no judgment', async () => {
  const { deps, fake } = await verifiedPhone();
  await fake.say('I want to stop my monthly gift.');
  const unsure = await fake.say('Yes.', { confidence: '0.31' });
  assert.ok(unsure.spoken.startsWith("Sorry, I didn't catch that."));
  assert.equal(deps.ledger.byType('write').length, 0);
  assert.deepEqual(callerInput({ SpeechResult: 'yes', Confidence: '0.0' }), { text: 'yes', source: 'voice', silent: false });
  assert.deepEqual(callerInput({ SpeechResult: 'yes' }), { text: 'yes', source: 'voice', silent: false });
  assert.deepEqual(callerInput({ SpeechResult: 'yes', Confidence: '0.2' }), { text: '', source: 'voice', silent: true });
  assert.deepEqual(callerInput({ Digits: '12*4#', SpeechResult: 'yes' }), { text: '124', source: 'keypad', silent: false });
  assert.deepEqual(callerInput({ Digits: '#' }), { text: '', source: 'voice', silent: true });
});

test('a key press is never a yes', async () => {
  const { deps, fake } = await verifiedPhone();
  await fake.say('I want to stop my monthly gift.');
  const asked = await fake.press('1');
  assert.ok(asked.spoken.includes('I need a clear yes or no'));
  assert.equal(deps.ledger.byType('write').length, 0);
});

test('the grader fails a phone write whose yes came before the words could have ended', async () => {
  const { deps, fake } = await verifiedPhone();
  await fake.say('I want to stop my monthly gift.');
  await fake.say('Yes.');
  const events = deps.ledger.byCall(onlyCall(deps));
  assert.deepEqual(checkWrites(events), []);
  const tampered = events.map((e) => (e.type === 'heard' && e.text === 'Yes.' ? { ...e, afterReplyMs: e.spokenFloorMs - 1 } : e));
  assert.match(checkWrites(tampered).map((p) => p.message).join(), /could have ended/);
});

// ---- Retries ----

test('a retried yes is one turn and one write, in order or at the same time, with the same reply', async () => {
  const { deps, fake } = await verifiedPhone();
  await fake.say('I want to stop my monthly gift.');
  const first = await fake.say('Yes.');
  const second = await fake.retry();
  assert.equal(second.xml, first.xml);
  assert.equal(deps.ledger.byType('write').length, 1);
  const turns = callEvents(deps, 'heard').length;
  await fake.retry();
  assert.equal(callEvents(deps, 'heard').length, turns);

  const other = await verifiedPhone();
  await other.fake.say('I want to stop my monthly gift.');
  other.clock.advance(60000);
  const fields = { ...other.fake.standard('in-progress'), SpeechResult: 'Yes.' };
  const [a, b] = await Promise.all([other.fake.post(other.fake.action, fields), other.fake.post(other.fake.action, fields)]);
  assert.equal(a.text, b.text);
  assert.equal(other.deps.ledger.byType('write').length, 1);
});

test('a retried first webhook starts one call, and a retried PIN costs one try', async () => {
  const { deps, phone } = await serve();
  const fake = phone();
  const first = await fake.dial();
  const again = await fake.dial();
  assert.equal(again.xml, first.xml);
  assert.equal(eventsOf(deps, 'call_start').length, 1);
  await fake.press('909090');
  await fake.retry();
  await fake.retry();
  assert.equal(callEvents(deps, 'pin_bad').length, 1);
  assert.equal(callEvents(deps, 'pin_locked').length, 0);
});

test('two callers at once get two calls', async () => {
  const { deps, phone } = await serve();
  await phone({ callSid: 'CA0000000000000000000000000000000A' }).dial();
  await phone({ callSid: 'CA0000000000000000000000000000000B' }).dial();
  assert.equal(eventsOf(deps, 'call_start').length, 2);
});

test('a slow turn gets a silent hold, then its reply, and runs once', async () => {
  let release;
  const gateOpen = new Promise((resolve) => { release = resolve; });
  const router = { route: async () => { await gateOpen; return { intent: 'gift_status', amountDollars: 0, empathy: 'none', latencyMs: 1, model: 'test' }; } };
  const { deps, phone } = await serve({ overrides: { router, phoneOptions: { budgetMs: 15, holdBudgetMs: 15 } } });
  const fake = phone();
  await fake.dial();
  await fake.press(PIN);
  const posted = fake.post(fake.action, { ...fake.standard('in-progress'), SpeechResult: 'How much is my gift?' });
  const hold = parseTwiml((await posted).text);
  assert.equal(hold.pause, true);
  assert.equal(hold.says.length, 0, 'a hold says no words of its own');
  release();
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  const res = await fake.post(hold.redirect, fake.standard('in-progress'));
  assert.match(parseTwiml(res.text).spoken, /monthly gift of \$25\.00/);
  assert.equal(callEvents(deps, 'route').length, 1);
});

test('a webhook after a restart starts over at the greeting, whatever it carried', async () => {
  const { deps, fake, phone } = await verifiedPhone();
  await fake.say('I want to stop my monthly gift.');
  const fresh = phone({ callSid: 'CA000000000000000000000000000000FF' });
  const res = await fresh.post(fake.action, { ...fresh.standard('in-progress'), SpeechResult: 'Yes.' });
  assert.ok(parseTwiml(res.text).spoken.startsWith(AUTOMATED));
  assert.equal(deps.ledger.byType('write').length, 0);
  const newest = deps.ledger.byCall(onlyCall(deps));
  assert.equal(newest.filter((e) => e.type === 'heard').length, 0, 'the words it carried are not a turn');
});

// ---- No input ----

test('no input before the PIN asks for the PIN, and no input after it asks again, with no call to the router', async () => {
  let routed = 0;
  const rules = { route: async () => { routed += 1; return { intent: 'unclear', amountDollars: 0, empathy: 'none', latencyMs: 1, model: 'test' }; } };
  const { deps, phone } = await serve({ overrides: { router: rules } });
  const fake = phone();
  await fake.dial();
  const before = await fake.silence();
  assert.equal(before.spoken, 'I need your PIN first. Please enter it on the keypad.');
  await fake.press(PIN);
  const after = await fake.silence();
  assert.ok(after.spoken.startsWith("Sorry, I didn't catch that."));
  assert.equal(routed, 0);
  const silent = callEvents(deps, 'heard').filter((e) => e.silent);
  assert.equal(silent.length, 2);
  assert.ok(silent.every((e) => e.text === ''));
  assert.equal(gradeCall(deps.ledger.byCall(onlyCall(deps)), null).passed, true);
});

test('a read-back spoken again after no input is what a yes answers, and three silences in a row end the call', async () => {
  const { deps, fake } = await verifiedPhone();
  await fake.say('I want to stop my monthly gift.');
  await fake.silence();
  await fake.say('Yes.');
  assert.deepEqual(deps.ledger.byType('write').map((w) => w.ok), [true]);

  const other = await verifiedPhone();
  await other.fake.say('Please restart my monthly gift.');
  await other.fake.silence();
  await other.fake.say('Hello?');
  await other.fake.silence();
  await other.fake.silence();
  const bye = await other.fake.silence();
  assert.equal(bye.spoken, 'Thanks for calling. Goodbye.');
  assert.equal(bye.hangup, true);
  assert.equal(callEvents(other.deps, 'call_end').at(-1).reason, 'no_input');
  assert.equal(other.deps.ledger.byType('write').length, 0);
});

test('an expired proposal is not spoken again after no input', async () => {
  const { deps, clock, fake } = await verifiedPhone();
  await fake.say('I want to stop my monthly gift.');
  clock.advance(LIMITS.pendingTtlMs + 1000);
  const doc = await fake.silence();
  assert.ok(doc.spoken.includes('timed out'), doc.spoken);
  assert.equal(doc.spoken.includes('pause it?'), false);
  await fake.say('Yes.');
  assert.equal(deps.ledger.byType('write').length, 0);
});

// ---- Hanging up ----

test('a hang-up ends the call, deletes an open draft, and sets aside the proposal, once', async () => {
  const { deps, fake } = await verifiedPhone();
  await fake.say("I'd like to give fifty dollars, just once.");
  assert.equal(callEvents(deps, 'staging_write').filter((e) => e.kind === 'create_draft').length, 1);
  assert.equal((await fake.hangUp()).status, 204);
  assert.equal((await fake.hangUp()).status, 204);
  const events = callEvents(deps);
  assert.deepEqual(events.filter((e) => e.type === 'call_end').map((e) => e.reason), ['hangup']);
  assert.deepEqual(events.filter((e) => e.type === 'staging_write').map((e) => e.kind), ['create_draft', 'delete_draft']);
  assert.equal(events.filter((e) => e.type === 'withdrawn').length, 1);
  // A late webhook carrying a yes does nothing.
  const late = await fake.say('Yes.');
  assert.equal(late.hangup, true);
  assert.equal(deps.ledger.byType('write').length, 0);
});

test('a last result posted with the call already over is not a turn', async () => {
  const { deps, fake } = await verifiedPhone();
  await fake.say('I want to stop my monthly gift.');
  const before = callEvents(deps, 'heard').length;
  const res = await fake.post(fake.action, { ...fake.standard('completed'), SpeechResult: 'Yes.' });
  assert.equal(res.status, 200);
  assert.equal(callEvents(deps, 'heard').length, before);
  assert.equal(deps.ledger.byType('write').length, 0);
  assert.equal(callEvents(deps, 'call_end').at(-1).reason, 'hangup');
});

test('a status callback for a call the line never saw, or one still going, changes nothing', async () => {
  const { deps, phone } = await serve();
  const fake = phone();
  assert.equal((await fake.hangUp()).status, 204);
  assert.equal(eventsOf(deps, 'call_end').length, 0);
  await fake.dial();
  assert.equal((await fake.post('/phone/status', fake.standard('in-progress'))).status, 204);
  assert.equal(eventsOf(deps, 'call_end').length, 0);
});

// ---- The PIN and the caller's number ----

test('no PIN, no heard digits before it passes, and no caller number in the logs, the ledger or the state', async () => {
  const { deps, logged, ledgerPath, phone } = await serve();
  const fake = phone();
  const docs = [await fake.dial()];
  docs.push(await fake.press('909090'));
  docs.push(await fake.say('seven one seven one seven one'));
  docs.push(await fake.say('717171'));
  const other = phone({ callSid: 'CA0000000000000000000000000000000C' });
  docs.push(await other.dial());
  docs.push(await other.say('nine zero nine zero nine zero'));
  docs.push(await other.press(PIN));
  docs.push(await other.say(`My PIN is ${PIN}, how much is my gift?`));
  docs.push(await other.say('four eight two six one three'));
  await other.hangUp();

  const haystacks = [logged.join('\n'), fs.readFileSync(ledgerPath, 'utf8'), docs.map((d) => d.xml).join('\n')];
  for (const text of haystacks) {
    for (const secret of [PIN, '909090', '717171', 'nine zero nine', 'seven one seven', 'four eight two', FROM, FROM.slice(1), '5551230199']) {
      assert.equal(text.includes(secret), false, `${secret} leaked`);
    }
  }
  const callId = eventsOf(deps, 'call_start').at(-1).callId;
  const state = JSON.stringify(deps.calls.get(callId));
  assert.equal(state.includes(PIN), false);
  assert.equal(state.includes(FROM), false);
  const heardBeforePin = deps.ledger.byCall(callId).filter((e) => e.type === 'heard')[0];
  assert.equal(heardBeforePin.text.includes('nine'), false);
  // The staff view hides those turns, and it has no caller number to show.
  const staff = JSON.stringify(staffCall(deps.ledger, callId, deps.config));
  assert.equal(staff.includes(PIN), false);
  assert.equal(staff.includes(FROM), false);
});

test('the key the PIN guard counts a number under never reaches the ledger', async () => {
  const { deps, phone } = await serve();
  await phone().dial();
  const raw = JSON.stringify(eventsOf(deps, 'call_start'));
  assert.equal(raw.includes('phone:'), false);
  assert.equal(raw.includes('clientKey'), false);
});

test('on Render a number that used up its wrong PINs stays blocked on a new call', async () => {
  const { phone, deps } = await serve({ env: phoneEnv({ RENDER: 'true', HOST: '127.0.0.1' }) });
  let n = 0;
  const nextCall = () => phone({ callSid: `CA${String(n += 1).padStart(32, '0')}` });
  for (let call = 0; call < 4; call += 1) {
    const fake = nextCall();
    await fake.dial();
    for (let i = 0; i < 3; i += 1) await fake.press('909090');
  }
  const fake = nextCall();
  await fake.dial();
  const blocked = await fake.press(PIN);
  assert.ok(blocked.spoken.includes('too many wrong PINs'), blocked.spoken);
  assert.equal(callEvents(deps, 'pin_ok').length, 0);
  // Another number isn't blocked.
  const elsewhere = phone({ callSid: 'CA0000000000000000000000000000EEEE', from: '+15559870000' });
  await elsewhere.dial();
  assert.ok((await elsewhere.press(PIN)).spoken.startsWith('Thanks, you are verified.'));
});

test('past the hourly limit a call is turned away unanswered, with no call in the ledger', async () => {
  const { deps, phone } = await serve();
  for (let i = 0; i < LIMITS.newCallsPerHour; i += 1) {
    assert.equal((await phone({ callSid: `CA${String(i).padStart(32, '0')}` }).dial()).reject, false);
  }
  const over = await phone({ callSid: 'CA0000000000000000000000000000FFFF' }).dial();
  assert.equal(over.reject, true);
  assert.equal(over.says.length, 0);
  assert.equal(eventsOf(deps, 'call_start').length, LIMITS.newCallsPerHour);
  assert.equal((await phone({ callSid: 'CA0000000000000000000000000000AAAA', from: '+15559870000' }).dial()).reject, false);
});

// ---- The pilot scripts ----

test('the pilot scripts route the same by phone as typed, and each one passes its checks', async () => {
  const typed = await serve();
  const byPhone = await serve();
  for (const script of PILOT_SCRIPTS) {
    const { callId, turn } = typed.deps.calls.start({ script: script.number, userAgent: 'node-test' });
    let answering = turn;
    for (const line of scriptTurns(script, PIN)) answering = (await typed.deps.calls.turn(callId, { ...line, answering })).turn;

    const fake = byPhone.phone({ callSid: `CA${String(script.number).padStart(32, '0')}` });
    await playScript(fake, script, PIN);
    const phoneCall = onlyCall(byPhone.deps);
    const facts = (deps, id) => {
      const events = deps.ledger.byCall(id);
      return {
        intents: events.filter((e) => e.type === 'route').map((e) => e.intent),
        writes: events.filter((e) => e.type === 'write').map((e) => [e.kind, e.ok]),
        staging: events.filter((e) => e.type === 'staging_write').map((e) => e.kind),
        proposals: events.filter((e) => e.type === 'proposed').map((e) => e.kind),
        refusals: events.filter((e) => e.type === 'refused').map((e) => e.reason),
        said: events.filter((e) => e.type === 'said' && e.turn > 0).map((e) => e.text),
      };
    };
    assert.deepEqual(facts(byPhone.deps, phoneCall), facts(typed.deps, callId), `Script ${script.number}`);
    // Grade with the script, the way pilot-check would, though a phone call logs no script and is never picked to grade.
    const grade = gradeCall(byPhone.deps.ledger.byCall(phoneCall), script);
    assert.equal(grade.passed, true, `Script ${script.number} ${JSON.stringify(grade)}`);
  }
  assert.ok(byPhone.deps.ledger.byType('call_start').every((e) => e.script === null && e.channel === 'phone'));
});

// ---- Found by the attack pass ----

test('signed webhooks saved from one call and replayed after a restart never pass the PIN or reach a write', async () => {
  const first = await serve();
  const caller = first.phone();
  const inProgress = (extra) => ({ ...caller.standard('in-progress'), ...extra });
  await caller.dial();
  const saved = [[caller.action, inProgress({ Digits: PIN, FinishedOnKey: '#' })]];
  await caller.press(PIN);
  saved.push([caller.action, inProgress({ SpeechResult: 'I want to stop my monthly gift.', Confidence: '0.92' })]);
  await caller.say('I want to stop my monthly gift.');
  saved.push([caller.action, inProgress({ SpeechResult: 'Yes.', Confidence: '0.92' })]);
  await caller.say('Yes.');
  assert.equal(first.deps.ledger.byType('write').length, 1, 'the real call wrote once');

  // The same token, a new process, and no memory of the call. Each webhook goes twice, and the clock runs past every floor.
  const second = await serve();
  const replayer = second.phone();
  for (const [url, fields] of [saved[0], ...saved]) {
    second.clock.advance(60000);
    const res = await replayer.post(url, fields);
    assert.equal(res.status, 200);
    assert.ok(parseTwiml(res.text).spoken.startsWith(AUTOMATED), 'each one only gets the greeting');
  }
  assert.equal(second.deps.ledger.byType('pin_ok').length, 0);
  assert.equal(second.deps.ledger.byType('proposed').length, 0);
  assert.equal(second.deps.ledger.byType('write').length, 0);
  assert.equal(second.deps.ledger.byType('heard').length, 0, 'none of them is a turn');
});

test('a late webhook for a call the sweep has forgotten hangs up in silence, not with an error Twilio reads out', async () => {
  const { deps, clock, fake } = await verifiedPhone();
  const late = fake.action;
  await fake.hangUp();
  clock.advance(LIMITS.callIdleMs + 1000);
  await deps.calls.sweep();
  const res = await fake.post(late, { ...fake.standard('in-progress'), SpeechResult: 'Yes.', Confidence: '0.92' });
  assert.equal(res.status, 200);
  const doc = parseTwiml(res.text);
  assert.equal(doc.spoken, '');
  assert.equal(doc.hangup, true);
  assert.equal(deps.ledger.byType('write').length, 0);
});

test('the Gather asks for input in the form Twilio lists', async () => {
  const { phone } = await serve();
  const doc = await phone().dial();
  assert.equal(doc.gather.input, 'dtmf speech');
});
