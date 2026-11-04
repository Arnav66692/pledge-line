// The recovery timeline: when something goes wrong in a call and the line handles it, what she wanted, what went wrong,
// what the line did and what PayPal shows now. Pure functions over one call's ledger events, as receipt.js is, so every
// time and reference points at the event it came from and nothing on it can be invented. Nothing wrong, nothing shown.
import { formatMoney } from './say.js';

const LABELS = Object.freeze({ wanted: 'You wanted', wrong: 'What went wrong', did: 'What the line did', now: 'What PayPal shows now' });
const WANTED = Object.freeze({
  suspend: 'To pause your monthly gift.', activate: 'To restart your monthly gift.', cancel: 'To cancel your monthly gift.', send_invoice: 'To send your one-time gift invoice.',
  refund_request: 'To ask staff to look at a refund.', cover_capture: 'To give this month back.', cover_refund: 'To give this month back.', cover_unwind: 'To give this month back.',
});
const STATUS_WORDS = Object.freeze({ SUSPENDED: 'paused', DRAFT: 'a draft', CREATED: 'open', PARTIALLY_CAPTURED: 'partly used' });
const NOUNS = Object.freeze({ subscription: 'your monthly gift', plan: 'the gift amount', invoice: 'the invoice', charge: 'the charge', gift_charge: 'the charge', capture: "the sponsor's payment", hold: "the sponsor's hold" });
// Which read shows the thing each kind of write acts on.
const WRITE_READS = Object.freeze({
  suspend: (w) => ({ what: 'subscription', id: w.targetId }), activate: (w) => ({ what: 'subscription', id: w.targetId }), cancel: (w) => ({ what: 'subscription', id: w.targetId }),
  send_invoice: (w) => ({ what: 'invoice', id: w.targetId }), refund_request: (w) => ({ what: 'charge', id: w.targetId }), cover_capture: (w) => ({ what: 'hold', id: w.targetId }),
  cover_refund: (w) => ({ what: 'gift_charge', id: w.targetId }), cover_unwind: (w) => ({ what: 'capture', id: w.captureId }),
});
const WHY_WORDS = Object.freeze({
  age: 'The number could have been your age, not the gift.',
  correction: "You changed the amount as you said it, so it wasn't clear.",
  relative: "That amount depended on another number, so it wasn't clear.",
  two_numbers: "You named two numbers, so the amount wasn't clear.",
  negated: 'You named the amount in a sentence that said no to it.',
  hedged: "That amount was a guess, so the line didn't use it.",
  recurring: 'That was an amount each month, and the line only sets up a one-time gift.',
  not_money: "That number wasn't said as money.",
  router_other_amount: "The amount the AI router picked wasn't the one in your words.",
  router_heard_none: "The AI router heard no amount, so the line didn't pick one.",
  existing_gift: "You named an amount that isn't your gift's. You were asking about your gift, so the line didn't treat it as a new one.",
});
const PAYPAL_UNCLEAR = 'paypal_unclear';

const listOf = (value) => (Array.isArray(value) ? value : []);
const statusWord = (status) => STATUS_WORDS[status] ?? String(status).toLowerCase().replace(/_/g, ' ');

/** One row of the timeline. Its time is the event's own, and its reference is the debug id of the event that gave it. */
function step(part, text, at, ref = null) {
  return { part, label: LABELS[part], text, ts: at?.ts ?? null, seq: at?.seq ?? null, reference: ref?.debugId ?? null, refSeq: ref && ref.debugId ? ref.seq ?? null : null };
}

const isGoodRead = (e) => e.type === 'read' && !e.error;
const readsOf = (list, { what, id }) => list.filter((e) => isGoodRead(e) && e.what === what && e.id === id);
const inTurn = (list, type, turn) => list.filter((e) => e.type === type && e.turn === turn);
const saidIn = (list, turn) => inTurn(list, 'said', turn).at(-1) ?? null;
const heardIn = (list, turn) => inTurn(list, 'heard', turn).at(-1) ?? null;
const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

function moneyOf(snapshot) {
  return snapshot ? formatMoney(snapshot.amount_value, snapshot.amount_currency ?? undefined) : null;
}

/** One PayPal read in plain words, from that read's own snapshot, so no amount or status here can come from anywhere else. */
function readWords(read) {
  const noun = NOUNS[read.what] ?? 'that record';
  const Noun = `${noun.charAt(0).toUpperCase()}${noun.slice(1)}`;
  if (read.notFound || !read.snapshot) return `PayPal can't find ${noun}.`;
  if (read.what === 'charge' && read.snapshot.count === 0) return 'PayPal lists no charge for your gift.';
  const money = moneyOf(read.snapshot);
  if (!read.snapshot.status) return `${Noun}${money ? ` is ${money}` : ' has no status PayPal gave'}.`;
  return `${Noun}${money ? `, ${money},` : ''} is ${statusWord(read.snapshot.status)}.`;
}

/** The latest read of that thing, so "now" stays true when a later turn reads it again. No read means no claim about PayPal. */
function nowStep(list, target, fallback) {
  const read = readsOf(list, target).at(-1);
  return read ? step('now', readWords(read), read, read) : step('now', "The line couldn't read PayPal after this, so it says nothing here about what PayPal shows.", fallback);
}

/** The read and the yes behind a failed write, so the row can say when she asked and which read she answered. */
function wantedForWrite(list, write) {
  const yes = list.find((e) => e.type === 'yes' && (e.tokenId === write.tokenId || listOf(e.tokenIds).includes(write.tokenId))) ?? write;
  const target = WRITE_READS[write.kind]?.(write);
  const before = target ? readsOf(list, target).filter((e) => e.seq < write.seq).at(-1) ?? null : null;
  return step('wanted', WANTED[write.kind] ?? 'A change in PayPal.', yes, before);
}

function failureWords(write) {
  const code = write.httpStatus;
  if (code === 0) return "PayPal didn't answer in time, so the line couldn't tell if the change went through.";
  if (code >= 500) return `PayPal answered with an error, code ${code}, so the line couldn't tell if the change went through.`;
  if (code >= 400) return `PayPal turned it down, code ${code}.`;
  return "The change didn't go through.";
}

const isLost = (write) => write.httpStatus === 0 || write.httpStatus >= 500;

function didAfterWrite(list, write, target) {
  const reads = target ? readsOf(list, target).filter((e) => e.seq > write.seq && e.turn === write.turn) : [];
  const said = saidIn(list, write.turn) ?? write;
  const lastRead = reads.at(-1) ?? null;
  if (reads.length === 0) return step('did', isLost(write) ? "It tried to read PayPal again, couldn't, and told you it wasn't clear." : 'It told you the change did not go through.', said);
  const lead = isLost(write) ? `It read PayPal again, ${times(reads.length)}, before it told you anything.` : 'It told you PayPal said no, and read PayPal again to check.';
  return step('did', lead, said, lastRead);
}

function writeIncident(list, write) {
  const target = WRITE_READS[write.kind]?.(write) ?? null;
  return {
    kind: isLost(write) ? 'lost_answer' : 'refused',
    seq: write.seq,
    steps: [
      wantedForWrite(list, write),
      step('wrong', failureWords(write), write, write),
      didAfterWrite(list, write, target),
      target ? nowStep(list, target, saidIn(list, write.turn) ?? write) : step('now', "The line has no read of PayPal for this.", write),
    ],
  };
}

// What makes two reads of one record differ, for each record a change can reach.
const recordValue = (read) => (read.what === 'charge' ? `${read.snapshot?.transaction_id ?? ''}|${read.snapshot?.status ?? ''}` : read.snapshot?.status ?? null);

/** Two reads of one record that differ with no write of this call between them: someone else changed it. */
function changedPairs(list) {
  const last = new Map();
  const pairs = [];
  for (const event of list) {
    if (event.type === 'write' || event.type === 'staging_write') last.clear();
    if (!isGoodRead(event) || event.what === 'plan') continue;
    const key = `${event.what}|${event.id}`;
    const before = last.get(key);
    if (before?.snapshot && (event.notFound || recordValue(before) !== recordValue(event))) pairs.push({ before, after: event });
    last.set(key, event);
  }
  return pairs;
}

function changeWords({ before, after }) {
  if (after.notFound || !after.snapshot) return `PayPal's record changed since the line last read it. It showed ${statusWord(before.snapshot.status)}, and PayPal can't find it now.`;
  if (before.snapshot.status === after.snapshot.status) return "PayPal's record changed since the line last read it. PayPal now lists a newer charge.";
  return `PayPal's record changed since the line last read it. It showed ${statusWord(before.snapshot.status)}, and now shows ${statusWord(after.snapshot.status)}.`;
}

function changeIncident(list, pair) {
  const { after } = pair;
  const withdrawn = inTurn(list, 'withdrawn', after.turn).at(-1) ?? null;
  const proposal = withdrawn ? list.find((e) => e.type === 'proposed' && e.pendingId === withdrawn.pendingId) : null;
  const heard = heardIn(list, after.turn);
  const said = saidIn(list, after.turn) ?? after;
  const wanted = proposal ? step('wanted', WANTED[proposal.kind] ?? 'A change in PayPal.', proposal, pair.before)
    : step('wanted', heard ? `You said "${heard.text}"` : 'To check your gift.', heard ?? after, pair.before);
  const did = withdrawn ? 'It set the waiting change aside, so a later yes can\'t approve it, and told you what PayPal shows.' : 'It told you what PayPal shows now, and changed nothing.';
  return { kind: 'changed', seq: after.seq, steps: [wanted, step('wrong', changeWords(pair), after, after), step('did', did, said, after), nowStep(list, { what: after.what, id: after.id }, said)] };
}

/** The price PayPal's own read gave for the gift in that turn or before it, to tell a wrong number from a right one. */
function giftPriceBy(list, turn) {
  return list.filter((e) => isGoodRead(e) && e.what === 'plan' && e.turn <= turn && e.snapshot).at(-1)?.snapshot.price_value ?? null;
}

/** A question that names the gift's own amount went nothing wrong. It only shows when PayPal's read says otherwise. */
function namedRightAmount(list, event) {
  const price = giftPriceBy(list, event.turn);
  return price !== null && Number.isFinite(event.namedDollars) && Math.round(Number(price) * 100) === Math.round(event.namedDollars * 100);
}

function giftNow(list, fallback) {
  const read = list.filter((e) => isGoodRead(e) && e.what === 'subscription').at(-1);
  if (!read) return step('now', "The line couldn't read PayPal after this, so it says nothing here about what PayPal shows.", fallback);
  const plan = list.filter((e) => isGoodRead(e) && e.what === 'plan' && e.snapshot).at(-1);
  const money = plan ? formatMoney(plan.snapshot.price_value, plan.snapshot.price_currency ?? undefined) : null;
  if (read.notFound || !read.snapshot) return step('now', readWords(read), read, read);
  return step('now', `Your monthly gift${money ? `, ${money},` : ''} is ${statusWord(read.snapshot.status)}.`, read, read);
}

function amountNow(list, event, said) {
  const inv = list.filter((e) => isGoodRead(e) && e.what === 'invoice' && e.seq > event.seq).at(-1);
  if (inv) return step('now', readWords(inv), inv, inv);
  const removed = inTurn(list, 'staging_write', event.turn).find((e) => e.kind === 'delete_draft' && e.ok);
  return removed ? step('now', 'The earlier draft is deleted, and no new one was made.', removed, removed) : step('now', 'No draft was made, so PayPal has nothing new from this.', said);
}

function amountIncident(list, event) {
  const heard = heardIn(list, event.turn);
  const said = saidIn(list, event.turn) ?? event;
  const toStatus = event.why === 'existing_gift';
  const drafted = inTurn(list, 'staging_write', event.turn).some((e) => e.kind === 'create_draft' && e.ok);
  const removed = inTurn(list, 'staging_write', event.turn).some((e) => e.kind === 'delete_draft' && e.ok);
  const asked = toStatus ? 'It read your gift from PayPal' : `${removed ? 'It deleted the draft it had made, and asked' : 'It asked'} how much you'd like to give`;
  return {
    kind: 'unclear_amount',
    seq: event.seq,
    steps: [
      step('wanted', heard ? `You said "${heard.text}"` : 'A one-time gift.', heard ?? event),
      step('wrong', WHY_WORDS[event.why] ?? "That amount wasn't clear.", event),
      step('did', `${asked}${drafted ? '.' : ', and made no draft.'}`, said),
      toStatus ? giftNow(list, said) : amountNow(list, event, said),
    ],
  };
}

/** A step in PayPal that failed where the line said it got no clear answer. A write's own failure is told above. */
function stepFailures(list) {
  const failedWrites = new Set(list.filter((e) => e.type === 'write' && !e.ok).map((e) => e.turn));
  const seen = new Set();
  return list.filter((e) => (e.type === 'read' && e.error) || (e.type === 'staging_write' && !e.ok)).filter((e) => {
    const told = listOf(saidIn(list, e.turn)?.claims).some((c) => c.claim === PAYPAL_UNCLEAR);
    if (!told || failedWrites.has(e.turn) || seen.has(e.turn)) return false;
    seen.add(e.turn);
    return true;
  });
}

function stepFailureIncident(list, failed) {
  const heard = heardIn(list, failed.turn);
  const said = saidIn(list, failed.turn) ?? failed;
  const wrong = failed.type === 'read' ? `PayPal didn't answer when the line checked ${NOUNS[failed.what] ?? 'that record'}.` : "PayPal didn't take the draft invoice step.";
  const withdrawn = inTurn(list, 'withdrawn', failed.turn).length > 0;
  return {
    kind: 'read_failed',
    seq: failed.seq,
    steps: [
      step('wanted', heard ? `You said "${heard.text}"` : 'To check your gift.', heard ?? failed),
      step('wrong', wrong, failed, failed),
      step('did', `${withdrawn ? 'It set the waiting change aside, and told you' : 'It told you'} it couldn't get a clear answer. It changed nothing.`, said),
      giftNow(list, said),
    ],
  };
}

/** The label for a call that wasn't on PayPal's test system with the AI router, from what the call logged when it began. */
function runOf(start) {
  if (start?.faultDrill) return { kind: 'drill', text: 'Fault drill. This fault was staged on the mock PayPal, and nothing here touched PayPal.' };
  if (start?.mode?.paypal === 'mock') return { kind: 'mock', text: "Mock run. This is a fake PayPal in memory, and the references are the mock's own." };
  if (start?.mode?.router === 'rules') return { kind: 'mock', text: 'Mock run. Offline rules read what you said, not the AI router.' };
  return start?.dryRun ? { kind: 'mock', text: 'Dry run. This call does not count.' } : null;
}

/**
 * The timeline of one call's events, oldest first, as ledger.byCall gives them. incidents is empty when nothing went
 * wrong, and run labels a mock or a fault drill. A step's seq and refSeq name the ledger events its time and reference
 * came from, and no step carries a PayPal id, a token or a sponsor's hold.
 */
export function buildRecovery(events) {
  const list = listOf(events).filter((e) => e && typeof e === 'object').sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const start = list.find((e) => e.type === 'call_start') ?? null;
  const incidents = [
    ...list.filter((e) => e.type === 'write' && !e.ok).map((e) => writeIncident(list, e)),
    ...changedPairs(list).map((pair) => changeIncident(list, pair)),
    ...list.filter((e) => e.type === 'amount_unclear' && !(e.why === 'existing_gift' && namedRightAmount(list, e))).map((e) => amountIncident(list, e)),
    ...stepFailures(list).map((e) => stepFailureIncident(list, e)),
  ].sort((a, b) => a.seq - b.seq);
  return { run: runOf(start), incidents };
}
