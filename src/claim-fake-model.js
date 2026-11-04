// A scripted fake model for the claim audit's baseline arm, so tests and a demo run need no key and no network.
// It follows the baseline's rules to the letter: read first, ask before a change, write only on a clear yes in the
// next line, read again after. Its numbers check the plumbing and are never a result (EVAL.md).
import { isClearYes } from './gate.js';
import { formatDate } from './say.js';
import { sentencesOf } from './claim-audit.js';

const WRITE_TOOL = Object.freeze({ suspend: 'pause_gift', activate: 'restart_gift', cancel: 'cancel_gift' });
const VERB = Object.freeze({ suspend: 'pause', activate: 'restart', cancel: 'cancel' });
const SPOKEN_STATUS = Object.freeze({ ACTIVE: 'active', SUSPENDED: 'paused', CANCELLED: 'cancelled' });
// The statuses each change can start from, as PayPal allows.
const CAN_START = Object.freeze({ suspend: ['ACTIVE'], activate: ['SUSPENDED'], cancel: ['ACTIVE', 'SUSPENDED'] });

// Checked in this order, so "did my pause go through" is a status question and "stop for a few months" a pause.
// "pausar" and a tag question such as "is it?" are there for the mishearing block, M2 and M5 in EVAL.md.
const INTENTS = [
  ['goodbye', /\b(?:bye|goodbye)\b/i],
  ['one_time', /\bone[\s-]time\b|\bjust once\b|\binvoice\b/i],
  ['no', /^\s*(?:no|nope|nah)\b/i],
  ['activate', /\b(?:restart|resume|reactivate)\b/i],
  ['status', /\bhow much\b|\bwhen\b|\bstill\b|\bgo through\b|\bcheck\b|\bpaused now\b|\bis it\?/i],
  ['suspend', /\bpause\b|\bpausar\b|\bfew months\b|\bfor a while\b/i],
  ['cancel', /\b(?:cancel|stop)\b/i],
];

const intentOf = (text) => INTENTS.find(([, regex]) => regex.test(text))?.[0] ?? 'other';
const say = (text) => ({ parts: [{ text }], raw: null });
const use = (name) => ({ parts: [{ call: { name, args: {} } }], raw: null });

function lastIndex(messages, role) {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i].role === role) return i;
  return -1;
}

const resultsIn = (list) => list.filter((m) => m.role === 'tools').flatMap((m) => m.results);
const agentText = (message) => (message?.parts ?? []).filter((p) => typeof p.text === 'string').map((p) => p.text).join(' ');

/** The change the agent's last reply asked about, read from its last question. */
function askedKind(messages, before) {
  const agent = messages.slice(0, before).reverse().find((m) => m.role === 'agent' && agentText(m));
  const question = sentencesOf(agentText(agent)).filter((s) => s.endsWith('?')).pop() ?? '';
  return Object.keys(VERB).find((kind) => new RegExp(`\\b${VERB[kind]}\\b`, 'i').test(question)) ?? null;
}

function giftWords(gift, timeZone) {
  const status = SPOKEN_STATUS[gift.status] ?? gift.status.toLowerCase();
  const lead = `PayPal shows your monthly gift of $${gift.amount} as ${status}.`;
  return { status, lead, next: gift.status === 'ACTIVE' ? ` The next one is on ${formatDate(gift.next_billing_time, timeZone)}.` : '' };
}

function afterYes(kind, results) {
  const wrote = results.find((r) => r.name === WRITE_TOOL[kind]);
  if (!wrote) return use(WRITE_TOOL[kind]);
  const reads = results.filter((r) => r.name === 'get_gift');
  if (reads.length === 0 || results.indexOf(reads.at(-1)) < results.indexOf(wrote)) return use('get_gift');
  const now = SPOKEN_STATUS[reads.at(-1).result.status] ?? 'unknown';
  return say(wrote.result.ok ? `PayPal now shows your monthly gift as ${now}.` : `PayPal didn't accept that change. It still shows your monthly gift as ${now}.`);
}

function offer(kind, gift, timeZone) {
  const words = giftWords(gift, timeZone);
  if (!CAN_START[kind].includes(gift.status)) return say(`${words.lead} So I can't ${VERB[kind]} it right now.`);
  return say(`${words.lead} Do you want me to ${VERB[kind]} it?`);
}

/** The fake baseline model. It reads only the conversation, never the mock, so its words come from tool results. */
export function createScriptedModel({ timeZone = 'America/Los_Angeles' } = {}) {
  async function next({ messages }) {
    const donorAt = lastIndex(messages, 'donor');
    const donor = messages[donorAt]?.text ?? '';
    const thisTurn = resultsIn(messages.slice(donorAt + 1));
    const pending = askedKind(messages, donorAt);
    if (pending && isClearYes(donor, pending)) return afterYes(pending, thisTurn);
    const intent = intentOf(donor);
    if (intent === 'goodbye') return say('Thanks for calling. Goodbye.');
    if (intent === 'one_time') return say("I can't set up a one-time gift on this line. I can read your monthly gift, pause it, restart it or cancel it.");
    if (intent === 'no') return say("OK, I won't change anything.");
    if (intent === 'other') return say('I can read your monthly gift, pause it, restart it or cancel it. What would you like?');
    const read = thisTurn.filter((r) => r.name === 'get_gift').pop();
    if (!read) return use('get_gift');
    if (read.result.error) return say("I couldn't find a monthly gift in PayPal. Staff can help during open hours.");
    if (intent === 'status') {
      const words = giftWords(read.result, timeZone);
      return say(`${words.lead}${words.next}`);
    }
    return offer(intent, read.result, timeZone);
  }
  return { name: 'scripted-fake', next };
}
