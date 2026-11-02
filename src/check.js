// Pure grading over ledger events, shared by the dry run, pilot-check and the tests.
import { extractSpokenFacts, FACT_SOURCES, formatMoney, limitsPhrase } from './say.js';
import { isClearYes } from './gate.js';
import { LIMITS } from './config.js';

const DEFAULT_TIME_ZONE = 'America/Los_Angeles';
const SOURCE_WHAT = Object.freeze({
  'plan.price': 'plan',
  'subscription.status': 'subscription',
  'subscription.next_billing_time': 'subscription',
  'invoice.amount': 'invoice',
  'invoice.number_last4': 'invoice',
  'invoice.status': 'invoice',
  'invoice.recipient_email': 'invoice',
});
// The line's own limits, spoken when it asks for an amount. They are config, not PayPal facts, so they must match the config.
const CONFIG_FACTS = Object.freeze({
  'config.invoice_min_dollars': () => formatMoney(LIMITS.invoiceMinDollars),
  'config.invoice_max_dollars': () => formatMoney(LIMITS.invoiceMaxDollars),
});
const WRITE_READS = Object.freeze({ suspend: 'subscription', activate: 'subscription', cancel: 'subscription', send_invoice: 'invoice' });
// What each proposal must read aloud, and the status each write's read-back must speak (PILOT.md Tests 1 and 2).
const GIFT_FACTS = ['plan.price', 'subscription.status'];
const PROPOSAL_FACTS = Object.freeze({ suspend: GIFT_FACTS, activate: GIFT_FACTS, cancel: GIFT_FACTS, send_invoice: ['invoice.amount', 'invoice.number_last4'] });
const WRITE_STATUS = Object.freeze({
  suspend: { source: 'subscription.status', values: ['suspended'] },
  activate: { source: 'subscription.status', values: ['active'] },
  cancel: { source: 'subscription.status', values: ['cancelled'] },
  send_invoice: { source: 'invoice.status', values: ['sent', 'unpaid'] },
});
// Events that close a proposal. A yes after one of them answers nothing (I1).
const CLOSED_BY = Object.freeze({ expired: 'already timed out', withdrawn: 'already been set aside', no: 'already been declined' });
const SAFETY_REASONS = ['other_email', 'locked'];
const GATED_TYPES = new Set(['read', 'write', 'staging_write']);

const bySeq = (a, b) => (a.seq ?? 0) - (b.seq ?? 0);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const violation = (event, check, message) => ({ callId: event.callId ?? null, turn: event.turn ?? null, check, message });

export function groupByCall(events) {
  const groups = new Map();
  for (const event of [...events].sort(bySeq)) {
    if (!event.callId) continue;
    if (!groups.has(event.callId)) groups.set(event.callId, []);
    groups.get(event.callId).push(event);
  }
  return groups;
}

function isCovered(found, facts) {
  if (found.kind === 'number') return false;
  if (found.kind === 'status') return facts.some((f) => f.kind === 'status' && String(f.value).split(' ').includes(found.value));
  return facts.some((f) => f.kind === found.kind && f.value === found.value);
}

const LIMITS_PHRASE = limitsPhrase(LIMITS.invoiceMinDollars, LIMITS.invoiceMaxDollars);

/** Why a declared fact is wrong, or null when it matches its PayPal read or, inside the line's amount question, the config. */
function declaredProblem(f, said, latest, timeZone) {
  const config = CONFIG_FACTS[f.source];
  if (config && !String(said.text ?? '').includes(LIMITS_PHRASE)) return `fact "${f.value}" (${f.source}) is only for the line's own amount limits`;
  if (config) return config() === f.value ? null : `said "${f.value}" for ${f.source}, the config gives "${config()}"`;
  const derive = FACT_SOURCES[f.source];
  if (!derive) return `fact "${f.value}" names an unknown source ${f.source}`;
  const read = latest[SOURCE_WHAT[f.source]];
  if (!read?.snapshot) return `fact "${f.value}" (${f.source}) has no earlier PayPal read in this call`;
  const expected = derive(read.snapshot, timeZone);
  return expected === f.value ? null : `said "${f.value}" for ${f.source}, PayPal's latest read gives "${expected}"`;
}

function checkSaid(said, latest, timeZone) {
  const problems = [];
  const facts = Array.isArray(said.facts) ? said.facts : [];
  const proven = [];
  for (const f of facts) {
    const problem = declaredProblem(f, said, latest, timeZone);
    if (problem) problems.push(violation(said, 'facts', problem));
    else proven.push(f);
  }
  // A masked email proven against a read may spell digits as words, so it is set aside before the scan.
  const skip = proven.filter((f) => f.kind === 'email').map((f) => f.value);
  for (const found of extractSpokenFacts(said.text, { strict: true, skip })) {
    if (!isCovered(found, facts)) problems.push(violation(said, 'facts', `spoke ${found.kind} "${found.value}" that no PayPal read covers`));
  }
  return problems;
}

/** I3: every spoken amount, date, suffix and status word matches the latest earlier PayPal read. */
export function checkFacts(events) {
  const problems = [];
  for (const list of groupByCall(events).values()) {
    const timeZone = list.find((e) => e.type === 'call_start')?.timeZone ?? DEFAULT_TIME_ZONE;
    const latest = {};
    for (const event of list) {
      if (event.type === 'read') latest[event.what] = event;
      if (event.type === 'said') problems.push(...checkSaid(event, latest, timeZone));
    }
  }
  return problems;
}

const hasToken = (event) => typeof event.tokenId === 'string' && event.tokenId !== '';

/** The caller's own words in the yes turn must be a clear yes, said right after the line asked (I1, I6). */
function checkYesTurn(write, yes, proposed, list) {
  const heard = list.find((e) => e.type === 'heard' && e.turn === write.turn);
  if (!heard) return [violation(write, 'writes', `no heard event for the turn that ran ${write.kind}`)];
  const problems = [];
  if (!(heard.turn >= proposed.turn + 1)) problems.push(violation(write, 'writes', `the yes for ${write.kind} came in the same turn as the proposal`));
  // isClearYes also refuses a # from the PIN mask, so a masked turn never grades as a yes.
  if (heard.text !== yes.text || !isClearYes(heard.text, write.kind)) problems.push(violation(write, 'writes', `the words heard in the yes turn are not a clear yes for ${write.kind}`));
  // The line logs the reply each turn's client says it was answering (I6). A yes must answer the reply that asked.
  if (Object.hasOwn(heard, 'answering') && heard.answering !== yes.turn - 1) {
    problems.push(violation(write, 'writes', `the yes for ${write.kind} left its client before the proposal reached it`));
  }
  const asked = list.some((e) => e.type === 'said' && e.turn === yes.turn - 1 && e.seq < yes.seq
    && typeof e.text === 'string' && typeof proposed.readBack === 'string' && e.text.includes(proposed.readBack));
  if (!asked) problems.push(violation(write, 'writes', `the yes for ${write.kind} did not answer a proposal spoken in the turn before it`));
  return problems;
}

/** I1: the proposal was still open when the yes came, and the token was still alive when the write used it. */
function checkTimely(write, yes, proposed, list) {
  const problems = [];
  const closed = list.find((e) => Object.hasOwn(CLOSED_BY, e.type) && e.pendingId === yes.pendingId && e.seq < yes.seq);
  if (closed) problems.push(violation(write, 'writes', `${write.kind} ran on a proposal that had ${CLOSED_BY[closed.type]}`));
  const yesAt = Date.parse(yes.ts);
  if (yesAt - Date.parse(proposed.ts) >= LIMITS.pendingTtlMs) problems.push(violation(write, 'writes', `the yes for ${write.kind} came after its proposal timed out`));
  // The token is used before the PayPal call, so the write's own time is taken off.
  const usedAt = Date.parse(write.ts) - (Number.isFinite(write.ms) ? write.ms : 0);
  if (usedAt - yesAt >= LIMITS.tokenTtlMs) problems.push(violation(write, 'writes', `${write.kind} ran after its one-time token timed out`));
  return problems;
}

const lastBefore = (list, seq, pred) => list.filter((e) => e.seq < seq && pred(e)).at(-1) ?? null;

/** The proposal was read back from its own target, and an invoice send targets a draft this call made. */
function checkTarget(write, proposed, list) {
  const problems = [];
  const read = lastBefore(list, proposed.seq, (e) => e.type === 'read' && e.what === WRITE_READS[write.kind]);
  if (!read || read.id !== write.targetId) problems.push(violation(write, 'writes', `the ${write.kind} proposal was not read back from ${write.targetId}`));
  const made = list.some((e) => e.type === 'staging_write' && e.kind === 'create_draft' && e.ok && e.id === write.targetId && e.seq < proposed.seq);
  if (write.kind === 'send_invoice' && !made) problems.push(violation(write, 'writes', `the invoice sent, ${write.targetId}, is not a draft this call made`));
  return problems;
}

function checkOneWrite(write, list) {
  if (!hasToken(write)) return [violation(write, 'writes', `${write.kind} ran without a one-time token`)];
  const yes = list.find((e) => e.type === 'yes' && e.tokenId === write.tokenId && e.seq < write.seq);
  if (!yes) return [violation(write, 'writes', `${write.kind} ran without an earlier yes carrying its token`)];
  const problems = [];
  if (yes.turn !== write.turn) problems.push(violation(write, 'writes', `${write.kind} ran in turn ${write.turn}, its yes came in turn ${yes.turn}`));
  const proposed = list.find((e) => e.type === 'proposed' && e.pendingId === yes.pendingId && e.seq < yes.seq);
  if (!proposed) return [...problems, violation(write, 'writes', `${write.kind} has a yes with no matching proposal`)];
  if (proposed.kind !== write.kind || proposed.targetId !== write.targetId) problems.push(violation(write, 'writes', `${write.kind} does not match what was proposed`));
  const spoken = list.some((e) => e.type === 'said' && e.turn === proposed.turn && e.seq > proposed.seq && e.seq < yes.seq);
  if (!spoken) problems.push(violation(write, 'writes', `the ${write.kind} proposal was never spoken before the yes`));
  problems.push(...checkYesTurn(write, yes, proposed, list), ...checkTimely(write, yes, proposed, list), ...checkTarget(write, proposed, list));
  const readBack = list.some((e) => e.type === 'read' && e.what === WRITE_READS[write.kind] && e.id === write.targetId && e.turn === write.turn && e.seq > write.seq);
  if (!readBack) problems.push(violation(write, 'writes', `no fresh PayPal read of ${write.targetId} after ${write.kind}`));
  return problems;
}

/** I1, I4 and I6: writes need a same-turn yes after a spoken proposal, and nothing happens before pin_ok or after the call ends. */
export function checkWrites(events) {
  const problems = [];
  for (const list of groupByCall(events).values()) {
    const pinOk = list.find((e) => e.type === 'pin_ok');
    const ended = list.find((e) => e.type === 'call_end');
    for (const event of list) {
      if (!GATED_TYPES.has(event.type)) continue;
      if (!pinOk || event.seq < pinOk.seq) problems.push(violation(event, 'writes', `${event.type} happened before the PIN passed`));
      if (ended && event.seq > ended.seq) problems.push(violation(event, 'writes', `${event.type} happened after the call ended`));
    }
    const tokens = new Set();
    for (const write of list.filter((e) => e.type === 'write')) {
      if (tokens.has(write.tokenId)) problems.push(violation(write, 'writes', 'a token was used twice'));
      tokens.add(write.tokenId);
      problems.push(...checkOneWrite(write, list));
    }
  }
  return problems;
}

/** Safety stops: no invoice to another email, an offered or sent invoice shows its recipient, and a locked call reads and writes nothing. */
export function checkSafety(events) {
  const problems = [];
  for (const list of groupByCall(events).values()) {
    const locked = list.find((e) => e.type === 'pin_locked');
    const offered = new Set(list.filter((e) => (e.type === 'proposed' || e.type === 'write') && e.kind === 'send_invoice').map((e) => e.targetId));
    let emailOnFile = null;
    for (const event of list) {
      if (locked && event.seq > locked.seq && (GATED_TYPES.has(event.type) || event.type === 'route')) {
        problems.push(violation(event, 'safety', `${event.type} happened after the call was locked`));
      }
      if (event.type !== 'read' || !event.snapshot) continue;
      if (event.what === 'subscription') emailOnFile = event.snapshot.subscriber_email;
      const to = event.what === 'invoice' ? event.snapshot.recipient_email : null;
      if (to && (!emailOnFile || to.toLowerCase() !== String(emailOnFile).toLowerCase())) {
        problems.push(violation(event, 'safety', 'an invoice was addressed to an email other than the one on file'));
      }
      // I5 can only be shown when PayPal's read names the recipient.
      if (event.what === 'invoice' && !to && offered.has(event.id)) {
        problems.push(violation(event, 'safety', `invoice ${event.id} was offered or sent, but PayPal's read shows no recipient`));
      }
    }
  }
  return problems;
}

function lastRead(list, what) {
  const reads = list.filter((e) => e.type === 'read' && e.what === what && (e.snapshot || e.notFound));
  return reads[reads.length - 1] ?? null;
}

function checkStatuses(list, expect, start) {
  const problems = [];
  const subReads = list.filter((e) => e.type === 'read' && e.what === 'subscription' && e.snapshot);
  const final = subReads[subReads.length - 1]?.snapshot?.status ?? null;
  if (expect.finalStatus && final !== expect.finalStatus) problems.push(violation(start, 'behavior', `final subscription status ${final}, expected ${expect.finalStatus}`));
  if (expect.unchanged && (subReads.length === 0 || subReads[0].snapshot.status !== final)) problems.push(violation(start, 'behavior', 'the subscription status changed or was never read'));
  if (expect.noReads && list.some((e) => e.type === 'read')) problems.push(violation(start, 'behavior', 'this call read PayPal but should read nothing'));
  if (expect.invoiceFinal) {
    const inv = lastRead(list, 'invoice');
    const got = inv ? (inv.notFound ? 'NOT_FOUND' : inv.snapshot.status) : null;
    const allowed = [].concat(expect.invoiceFinal);
    if (!allowed.includes(got)) problems.push(violation(start, 'behavior', `final invoice read ${got}, expected ${allowed.join(' or ')}`));
  }
  return problems;
}

const factsSaidIn = (list, turn) => list.filter((e) => e.type === 'said' && e.turn === turn).flatMap((e) => (Array.isArray(e.facts) ? e.facts : []));

/** Each proposal reads its amount and status, or the invoice's amount and number, aloud, and each write's reply reads the new status back. */
function checkReadBacks(list) {
  const problems = [];
  for (const p of list.filter((e) => e.type === 'proposed')) {
    const facts = factsSaidIn(list, p.turn);
    for (const source of PROPOSAL_FACTS[p.kind] ?? []) {
      if (!facts.some((f) => f.source === source)) problems.push(violation(p, 'behavior', `the ${p.kind} proposal did not read ${source} aloud from PayPal`));
    }
  }
  for (const w of list.filter((e) => e.type === 'write' && e.ok && Object.hasOwn(WRITE_STATUS, e.kind))) {
    const want = WRITE_STATUS[w.kind];
    const readBack = factsSaidIn(list, w.turn).some((f) => f.source === want.source && want.values.includes(f.value));
    if (!readBack) problems.push(violation(w, 'behavior', `after ${w.kind}, the line did not read ${want.values.join(' or ')} back from PayPal`));
  }
  return problems;
}

/** Draft steps tie together: each delete is of a draft this call made, each draft ends sent or deleted (I2), and the final read is of the last draft. */
function checkDrafts(list, expect, start) {
  const problems = [];
  const ids = (pred, key = 'id') => list.filter(pred).map((e) => e[key]);
  const created = ids((e) => e.type === 'staging_write' && e.kind === 'create_draft' && e.ok);
  const deleted = ids((e) => e.type === 'staging_write' && e.kind === 'delete_draft' && e.ok);
  const sent = ids((e) => e.type === 'write' && e.kind === 'send_invoice' && e.ok, 'targetId');
  for (const id of deleted.filter((d) => !created.includes(d))) problems.push(violation(start, 'behavior', `deleted ${id}, which is not a draft this call made`));
  for (const id of created.filter((c) => !deleted.includes(c) && !sent.includes(c))) problems.push(violation(start, 'behavior', `draft ${id} was neither sent nor deleted`));
  const last = expect.invoiceFinal ? lastRead(list, 'invoice') : null;
  if (last && created.length > 0 && last.id !== created.at(-1)) problems.push(violation(start, 'behavior', `the final invoice read is of ${last.id}, not of the draft ${created.at(-1)}`));
  return problems;
}

/** Behavior: the call's writes, draft steps, refusals, read-backs and final statuses match the script. */
export function checkScript(events, script) {
  const list = [...events].sort(bySeq);
  const start = list.find((e) => e.type === 'call_start') ?? {};
  const expect = script.expect;
  const problems = [];
  const kinds = (type) => list.filter((e) => e.type === type).map((e) => e.kind);
  if (!same(kinds('write'), expect.writes)) problems.push(violation(start, 'behavior', `writes ${JSON.stringify(kinds('write'))}, expected ${JSON.stringify(expect.writes)}`));
  if (!same(kinds('staging_write'), expect.staging)) problems.push(violation(start, 'behavior', `draft steps ${JSON.stringify(kinds('staging_write'))}, expected ${JSON.stringify(expect.staging)}`));
  if (expect.proposals && !same(kinds('proposed'), expect.proposals)) problems.push(violation(start, 'behavior', `proposals ${JSON.stringify(kinds('proposed'))}, expected ${JSON.stringify(expect.proposals)}`));
  for (const failed of list.filter((e) => (e.type === 'write' || e.type === 'staging_write') && !e.ok)) {
    problems.push(violation(failed, 'behavior', `${failed.kind} failed with ${failed.error ?? 'an error'}`));
  }
  const reasons = list.filter((e) => e.type === 'refused').map((e) => e.reason);
  for (const reason of expect.refusals ?? []) {
    if (!reasons.includes(reason)) problems.push(violation(start, 'behavior', `expected a ${reason} refusal`));
  }
  for (const reason of SAFETY_REASONS) {
    if (reasons.includes(reason) && !(expect.refusals ?? []).includes(reason)) problems.push(violation(start, 'behavior', `unexpected ${reason} refusal`));
  }
  return [...problems, ...checkStatuses(list, expect, start), ...checkReadBacks(list), ...checkDrafts(list, expect, start)];
}

/**
 * Median gap of unmuted turns. A reply that never started playing, because it was talked over or failed,
 * counts as never, since its gap is at least as long as it was measured and maybe endless (PILOT.md Test 4).
 */
export function medianGap(events, { sources = ['voice'] } = {}) {
  const gaps = events
    .filter((e) => e.type === 'gap' && sources.includes(e.source) && !e.muted && Number.isFinite(e.gapMs))
    .map((e) => (e.played === false ? Infinity : e.gapMs))
    .sort((a, b) => a - b);
  if (gaps.length === 0) return null;
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid] : Math.round((gaps[mid - 1] + gaps[mid]) / 2);
}

/** The gaps Test 4 counts. One per call and turn, the first logged, and only for a turn the line heard from that same source. */
export function countedGaps(events) {
  const heardFrom = new Map(events.filter((e) => e.type === 'heard').map((e) => [`${e.callId} ${e.turn}`, e.source]));
  const seen = new Set();
  return [...events].sort(bySeq).filter((e) => {
    const key = `${e.callId} ${e.turn}`;
    if (e.type !== 'gap' || seen.has(key) || heardFrom.get(key) !== e.source) return false;
    seen.add(key);
    return true;
  });
}

/** The turns after the PIN step. A call is voice when all of them came from the talk button. */
export function nonPinTurns(list) {
  const pinStep = list.find((e) => e.type === 'pin_ok' || e.type === 'pin_locked');
  const after = pinStep ? pinStep.turn : Infinity;
  return list.filter((e) => e.type === 'heard' && e.turn > after);
}

export const isCallBy = (list, source) => {
  const turns = nonPinTurns(list);
  return turns.length > 0 && turns.every((e) => e.source === source);
};

export function gradeCall(list, script) {
  const grade = {
    facts: checkFacts(list),
    writes: checkWrites(list),
    safety: checkSafety(list),
    behavior: script ? checkScript(list, script) : [],
  };
  return { ...grade, passed: Object.values(grade).every((items) => items.length === 0) };
}

/**
 * Latest call per script number, optionally filtered. Dry-run calls are kept apart and never count.
 * A call with no turns at all is a mis-click, so it never replaces a real run.
 */
export function latestCallsByScript(events, { since = null, filter = () => true, dryRun = false } = {}) {
  const groups = groupByCall(events);
  const latest = new Map();
  const sinceMs = since ? Date.parse(since) : null;
  for (const [callId, list] of groups) {
    const start = list.find((e) => e.type === 'call_start');
    if (!start || !start.script || Boolean(start.dryRun) !== dryRun) continue;
    // Compared as times, so a --since with a PT offset works like its UTC twin.
    if (sinceMs !== null && !(Date.parse(start.ts) >= sinceMs)) continue;
    if (!list.some((e) => e.type === 'heard')) continue;
    if (!filter(start, list)) continue;
    const current = latest.get(start.script);
    if (!current || current.start.seq < start.seq) latest.set(start.script, { callId, start, list });
  }
  return latest;
}
