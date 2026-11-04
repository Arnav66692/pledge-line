// A fake Twilio for mock mode. It posts signed webhooks the way Twilio does and plays each reply's words on a test clock,
// so the phone line can be run with no account, no number and no network. `npm run phone:fake` plays Script 2 end to end.
// What it copies from Twilio is what TWILIO-SETUP.md cites. No real Twilio has been called, so a live call can still differ.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { buildDeps, createServer } from '../src/server.js';
import { twilioSignature } from '../src/phone.js';
import { scriptByNumber, scriptTurns } from '../src/pilot-scripts.js';

// A plain speaking rate, 150 words a minute. Twilio's real voices vary, so this is the fake's, not a measurement.
export const FAKE_MS_PER_WORD = 400;
const unescape = (text) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function attributes(text) {
  return Object.fromEntries([...text.matchAll(/([A-Za-z]+)="([^"]*)"/g)].map((m) => [m[1], unescape(m[2])]));
}

/** The parts of a TwiML reply the line uses. nested says whether a <Say> sits inside the <Gather>, so speech can reach it. */
export function parseTwiml(xml) {
  const gatherOpen = xml.match(/<Gather\b([^>]*?)(\/?)>/);
  const inner = gatherOpen && !gatherOpen[2] ? xml.slice(gatherOpen.index, xml.indexOf('</Gather>')) : '';
  const says = [...xml.matchAll(/<Say\b([^>]*)>([\s\S]*?)<\/Say>/g)].map((m) => ({ text: unescape(m[2]), voice: attributes(m[1]).voice, nested: inner.includes(m[0]) }));
  const redirect = xml.match(/<Redirect\b[^>]*>([^<]*)<\/Redirect>/);
  return {
    xml,
    says,
    spoken: says.map((s) => s.text).join(' '),
    gather: gatherOpen ? attributes(gatherOpen[1]) : null,
    redirect: redirect ? unescape(redirect[1]) : null,
    hangup: /<Hangup\s*\/>/.test(xml),
    reject: /<Reject\b/.test(xml),
    pause: /<Pause\b/.test(xml),
  };
}

const spokenMs = (text) => String(text).split(/\s+/).filter(Boolean).length * FAKE_MS_PER_WORD;

/**
 * One caller on one call. localUrl is where the server listens, and publicUrl is what Twilio is told and signs, as on
 * Render, where the server only sees plain http behind the proxy.
 */
export function createFakeTwilio({ localUrl, publicUrl, authToken, clock, callSid = 'CA00000000000000000000000000000001', from = '+15551230199', to = '+15550100123' }) {
  const fake = { last: null, lastPost: null, posts: 0 };
  const standard = (callStatus) => ({ CallSid: callSid, AccountSid: 'AC00000000000000000000000000000000', From: from, Caller: from, To: to, Called: to, CallStatus: callStatus, Direction: 'inbound', ApiVersion: '2010-04-01' });

  /** A signed POST, to a path or a full public URL. signAs, token and signature let a test send one Twilio wouldn't. */
  async function post(where, fields, { signAs = null, token = authToken, signature = null, unsigned = false } = {}) {
    const url = where.startsWith('http') ? where : `${publicUrl}${where}`;
    const body = new URLSearchParams(fields).toString();
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };
    if (!unsigned) headers['x-twilio-signature'] = signature ?? twilioSignature(token, signAs ?? url, fields);
    fake.posts += 1;
    const res = await fetch(`${localUrl}${url.slice(publicUrl.length)}`, { method: 'POST', headers, body });
    return { status: res.status, text: await res.text() };
  }

  async function step(where, fields) {
    fake.lastPost = { where, fields };
    const res = await post(where, fields);
    fake.status = res.status;
    fake.last = parseTwiml(res.text);
    if (fake.last.gather) fake.action = fake.last.gather.action;
    // After a hang-up no action is left, so anything more is a late webhook for the turn after the last one.
    else if (fake.last.hangup) fake.action = fake.action.replace(/turn=(\d+)/, (_, n) => `turn=${Number(n) + 1}`);
    return fake.last;
  }

  /** The caller hears the whole reply before anything else happens, unless a test says the words came early. */
  function hear({ early = false } = {}) {
    if (!early && fake.last) clock.advance(spokenMs(fake.last.spoken));
  }

  /** A slow turn answers with a silent hold and a redirect, which Twilio follows until the reply is ready. */
  async function follow(doc) {
    let current = doc;
    while (current.pause && current.redirect) {
      clock.advance(2000);
      current = await step(current.redirect, standard('in-progress'));
    }
    return current;
  }

  Object.assign(fake, {
    post,
    dial: () => step('/phone/voice', standard('ringing')),
    press: (digits, options) => {
      hear(options);
      return step(fake.action, { ...standard('in-progress'), Digits: digits, FinishedOnKey: '#' }).then(follow);
    },
    say: (words, { confidence = '0.92', ...options } = {}) => {
      hear(options);
      return step(fake.action, { ...standard('in-progress'), SpeechResult: words, Confidence: confidence }).then(follow);
    },
    /** The caller says nothing, so the <Gather> times out and posts with no input. */
    silence: (options) => {
      hear(options);
      return step(fake.action, standard('in-progress')).then(follow);
    },
    /**
     * Words said while the reply plays. Twilio listens only inside a <Gather>, so words over a <Say> outside it are never
     * heard, and the call moves on to the empty <Gather> once the reply ends. Returns true when the words got through.
     */
    sayOver: async (words) => {
      if (fake.last.says.some((s) => s.nested)) {
        await fake.say(words, { early: true });
        return true;
      }
      return false;
    },
    /** The same webhook again, as Twilio's retry would send it. */
    retry: () => step(fake.lastPost.where, fake.lastPost.fields).then(follow),
    /** Twilio's status callback once the caller hangs up. */
    hangUp: () => post('/phone/status', { ...standard('completed'), CallDuration: '42' }),
    standard,
  });
  return fake;
}

/** Plays one pilot script on the fake phone. A line after the call hung up is a late webhook, which must do nothing. */
export async function playScript(fake, script, pin) {
  const heard = [await fake.dial()];
  for (const turn of scriptTurns(script, pin)) {
    heard.push(turn.source === 'keypad' ? await fake.press(turn.text) : await fake.say(turn.text));
  }
  return heard;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pledge-line-phone-'));
  const clock = { t: Date.now(), advance(ms) { this.t += ms; } };
  const publicUrl = 'https://pledge-line.example.test';
  const authToken = 'fake-token-for-the-fake-twilio';
  const config = loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules', PHONE_ENABLED: 'true', TWILIO_AUTH_TOKEN: authToken, PUBLIC_BASE_URL: publicUrl, LEDGER_PATH: path.join(dir, 'ledger.jsonl') });
  const lines = [];
  const deps = buildDeps(config, { now: () => new Date(clock.t), monotonic: () => clock.t, log: { info: (line) => lines.push(line), error: (line) => lines.push(line) }, sleep: async () => {} });
  const server = createServer(deps);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const fake = createFakeTwilio({ localUrl: `http://127.0.0.1:${server.address().port}`, publicUrl, authToken, clock });
  const show = (who, text) => process.stdout.write(`${who.padEnd(8)}${text}\n`);
  try {
    show('line', (await fake.dial()).spoken);
    for (const turn of scriptTurns(scriptByNumber(2), config.pin)) {
      const keypad = turn.source === 'keypad';
      show('caller', keypad ? `${'#'.repeat(turn.text.length)} on the keypad` : turn.text);
      show('line', (keypad ? await fake.press(turn.text) : await fake.say(turn.text)).spoken);
    }
    await fake.hangUp();
    const writes = deps.ledger.byType('write').map((w) => `${w.kind} ok=${w.ok}`);
    process.stdout.write(`\nFake Twilio, mock PayPal. ${fake.posts} signed webhooks, writes: ${writes.join(', ')}.\n`);
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
