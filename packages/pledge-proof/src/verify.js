// The generic checker. The caller splits a reply into sentences and declares the facts each sentence states.
// This module never parses free text. A fact the caller does not declare is not checked.

export const FACT_KINDS = Object.freeze(['status', 'amount', 'date', 'reference', 'action']);
export const VERDICTS = Object.freeze(['backed', 'unbacked', 'no-claim']);

// A status, amount, date or reference is backed by a read of the same subject in the same turn or the turn before.
const WINDOW_TURNS = 1;
// The read field each fact kind is compared with. An action is backed by a write, not a read.
const FIELD = Object.freeze({ status: 'status', amount: 'amount', date: 'date', reference: 'reference' });
const CENTS = /^\d+(\.\d{1,2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}/;

const fail = (where, message) => {
  throw new TypeError(`${where} ${message}`);
};
const isTurn = (value) => Number.isInteger(value) && value >= 0;
const norm = (value) => String(value ?? '').trim().toLowerCase();

function validateFact(fact, where) {
  if (!FACT_KINDS.includes(fact?.kind)) fail(where, `kind must be one of ${FACT_KINDS.join(', ')}`);
  if (typeof fact.subject !== 'string' || fact.subject === '') fail(where, 'subject must name the object the fact is about');
  if (typeof fact.value !== 'string' || fact.value.trim() === '') fail(where, 'value must be a non-empty string');
  if (fact.kind === 'amount' && typeof fact.currency !== 'string') fail(where, 'an amount needs a currency');
}

function validate(sentences, reads, writes) {
  if (!Array.isArray(sentences)) fail('sentences', 'must be an array');
  if (!Array.isArray(reads)) fail('reads', 'must be an array');
  if (!Array.isArray(writes)) fail('writes', 'must be an array');
  sentences.forEach((sentence, i) => {
    const where = `sentences[${i}]`;
    if (!isTurn(sentence?.turn)) fail(where, 'turn must be a whole number from 0');
    if (typeof sentence.text !== 'string') fail(where, 'text must be a string');
    if (sentence.facts !== undefined && !Array.isArray(sentence.facts)) fail(where, 'facts must be an array');
    (sentence.facts ?? []).forEach((fact, j) => validateFact(fact, `${where}.facts[${j}]`));
  });
  reads.forEach((read, i) => {
    const where = `reads[${i}]`;
    if (!isTurn(read?.turn)) fail(where, 'turn must be a whole number from 0');
    if (typeof read.object?.id !== 'string') fail(where, 'object.id must name the object the read came from');
    if (read.values === null || typeof read.values !== 'object') fail(where, 'values must be an object');
  });
  writes.forEach((write, i) => {
    const where = `writes[${i}]`;
    if (!isTurn(write?.turn)) fail(where, 'turn must be a whole number from 0');
    if (typeof write.action !== 'string' || typeof write.subject !== 'string') fail(where, 'action and subject must be strings');
    if (typeof write.ok !== 'boolean') fail(where, 'ok must be true or false');
  });
}

// Reads sorted by turn, then time, then input order, so the last one in a window is the latest.
function ordered(reads) {
  return reads
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.turn - b.item.turn || (Date.parse(a.item.at) || 0) - (Date.parse(b.item.at) || 0) || a.index - b.index)
    .map(({ item }) => item);
}

function cents(value) {
  const text = String(value ?? '').trim();
  return CENTS.test(text) ? Math.round(Number(text) * 100) : null;
}

// Whether a read's value for this field is the value the fact states.
function sameValue(fact, got) {
  if (got === undefined || got === null) return false;
  if (fact.kind === 'amount') {
    const want = cents(fact.value);
    return want !== null && want === cents(got.value) && norm(fact.currency) === norm(got.currency);
  }
  if (fact.kind === 'date') return DATE.test(fact.value) && DATE.test(String(got)) && fact.value.slice(0, 10) === String(got).slice(0, 10);
  if (fact.kind === 'status') return norm(fact.value) === norm(got);
  return fact.value.trim() === String(got).trim();
}

function backingRead(fact, turn, reads) {
  const field = FIELD[fact.kind];
  const latest = reads
    .filter((read) => read.object.id === fact.subject && read.turn >= turn - WINDOW_TURNS && read.turn <= turn && read.values[field] !== undefined)
    .at(-1);
  if (!latest) {
    const from = Math.max(turn - WINDOW_TURNS, 0);
    return { evidence: null, reason: `no read of ${fact.subject} in turns ${from} to ${turn} gives a ${fact.kind}` };
  }
  const evidence = { source: 'read', turn: latest.turn, at: latest.at ?? null, reference: latest.object.id };
  if (sameValue(fact, latest.values[field])) return { evidence, reason: null };
  return { evidence: null, reason: `the latest read of ${fact.subject} gives ${fact.kind} ${JSON.stringify(latest.values[field])}, not "${fact.value}"` };
}

function backingWrite(fact, turn, writes) {
  const write = writes.find((w) => w.turn === turn && w.subject === fact.subject && w.ok === true && norm(w.action) === norm(fact.value));
  if (!write) return { evidence: null, reason: `no successful ${fact.value} write of ${fact.subject} in turn ${turn}` };
  return { evidence: { source: 'write', turn: write.turn, at: write.at ?? null, reference: write.reference ?? write.subject }, reason: null };
}

function checkFact(fact, turn, reads, writes) {
  const found = fact.kind === 'action' ? backingWrite(fact, turn, writes) : backingRead(fact, turn, reads);
  return {
    kind: fact.kind,
    value: fact.value,
    subject: fact.subject,
    currency: fact.currency ?? null,
    backed: found.evidence !== null,
    backing: found.evidence,
    reason: found.reason,
  };
}

function judge(sentence, reads, writes) {
  const facts = (sentence.facts ?? []).map((fact) => checkFact(fact, sentence.turn, reads, writes));
  const verdict = facts.length === 0 ? 'no-claim' : facts.every((fact) => fact.backed) ? 'backed' : 'unbacked';
  return { turn: sentence.turn, text: sentence.text, verdict, facts };
}

function run({ sentences, reads = [], writes = [] } = {}) {
  validate(sentences, reads, writes);
  const sortedReads = ordered(reads);
  return sentences.map((sentence) => judge(sentence, sortedReads, writes));
}

/**
 * One verdict per sentence, in order: "backed" when every declared fact has a read or write behind it,
 * "unbacked" when one does not, and "no-claim" when the sentence declares no fact.
 */
export function verify(input) {
  return run(input).map(({ turn, text, verdict }) => ({ turn, text, verdict }));
}

/**
 * The same verdicts, with each fact's backing read or write (its time and reference) or the reason it is unbacked.
 */
export function receipt(input) {
  return run(input);
}
