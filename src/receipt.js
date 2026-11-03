// Receipts: every sentence the line said, beside the PayPal read that proves each fact in it and the claims it carries.
// They are built from the same ledger events with the same checks pilot-check grades, so the page and the grader
// can't disagree. When the two can't be tied together, a sentence is blocked, never proven.
import { sentencesOf, slotFacts, spokenForm, saysPhrase, extractSpokenFacts } from './say.js';
import { checkFacts, claimBacked, factProblem, readsBehind, templatesFor, CLAIM_MEANINGS, FACT_READS } from './check.js';

const bySeq = (a, b) => (a.seq ?? 0) - (b.seq ?? 0);
// A blocked sentence always says why. This is the reason when checkFacts found nothing but the receipt can't prove it.
const UNTIED = "the receipt can't tie this sentence to the call's PayPal reads";
const QUOTED = /"([^"]*)"/g;

const listOf = (value) => (Array.isArray(value) ? value : []);
const quotedIn = (message) => [...String(message ?? '').matchAll(QUOTED)].map((m) => m[1]).filter((bit) => bit.trim() !== '');

/** A quoted bit of a checkFacts message names the sentence when it is the sentence, with slots or without, or a phrase in it. */
const names = (bit, sentence) => bit === sentence.text || bit === sentence.slotted || saysPhrase(sentence.text, bit) || saysPhrase(sentence.slotted, bit);

/**
 * The problems that touch each sentence of one reply. A problem that names no sentence of the reply, such as a
 * declared fact the reply never says, or one for the whole call, such as a template list the history lacks, touches
 * every sentence, since it can't be pinned to one.
 */
function problemsBySentence(sentences, turnProblems, callProblems) {
  const touched = sentences.map(() => [...callProblems]);
  for (const problem of turnProblems) {
    const bits = quotedIn(problem.message);
    const hits = sentences.map((sentence) => bits.some((bit) => names(bit, sentence)));
    const anyHit = hits.some(Boolean);
    sentences.forEach((_, i) => { if (!anyHit || hits[i]) touched[i].push(problem); });
  }
  return touched.map((problems) => [...new Set(problems.map((p) => p.message))]);
}

/** The read a fact came from, as the receipt shows it, or null for a config fact or a fact with no read. */
function proofOf(f, reads) {
  const what = Object.hasOwn(FACT_READS, f.source) ? FACT_READS[f.source] : null;
  const read = what ? reads[what] : null;
  if (!read) return null;
  return { seq: read.seq ?? null, ts: read.ts ?? null, what: read.what, id: read.id ?? null, debugId: read.debugId ?? null, status: read.status ?? null };
}

/** A fact is in a sentence when the sentence says its spoken form as whole words, or in words the scans read. */
function factIn(f, text, orgName) {
  const heard = extractSpokenFacts(text, { strict: true, skip: orgName ? [orgName] : [] });
  return heard.some((x) => x.kind === f.kind && x.value === f.value) || saysPhrase(text, spokenForm(f));
}

/** The claims a sentence carries: the ones its template ties to it and the ones the reply declared for it. */
function claimsOf(sentence, said, templates, ctx) {
  const templated = templates && Object.hasOwn(templates.claims, sentence.slotted) ? templates.claims[sentence.slotted] : [];
  const declared = listOf(said.claims).filter((c) => typeof c?.claim === 'string' && typeof c?.sentence === 'string'
    && (c.sentence.trim() === sentence.text || slotFacts(c.sentence.trim(), ctx.proven, ctx.orgName) === sentence.slotted));
  const all = [...new Set([...templated, ...declared.map((c) => c.claim)])];
  return all.map((name) => {
    const made = declared.find((c) => c.claim === name);
    const meaning = Object.hasOwn(CLAIM_MEANINGS, name.split('=')[0]) ? CLAIM_MEANINGS[name.split('=')[0]] : null;
    const proven = Boolean(made) && templated.includes(name) && claimBacked(ctx.list, said, made, ctx.options);
    return { name, meaning, proven };
  });
}

/** proven needs a fact or a claim and every one backed, plain needs neither, and anything else is blocked. */
function verdictOf(facts, claims, problems) {
  if (problems.length > 0) return { verdict: 'blocked', problems };
  if (facts.length === 0 && claims.length === 0) return { verdict: 'plain', problems: [] };
  if (facts.every((f) => f.backed) && claims.every((c) => c.proven)) return { verdict: 'proven', problems: [] };
  return { verdict: 'blocked', problems: [UNTIED] };
}

function receiptFor(said, ctx, problems) {
  const reads = readsBehind(ctx.list, said, ctx.options);
  const text = String(said.text ?? '');
  const facts = listOf(said.facts).filter((f) => f && typeof f.source === 'string');
  const backed = facts.filter((f) => factProblem(f, said, reads, ctx.timeZone) === null);
  // Slots use the facts checkFacts would prove, so each sentence matches its template sentence the same way (R3-6).
  const proven = backed.filter((f) => factIn(f, text, ctx.orgName));
  const local = { ...ctx, proven };
  const sentences = sentencesOf(text).map((sentenceText) => ({ text: sentenceText, slotted: slotFacts(sentenceText, proven, ctx.orgName) }));
  const touched = problemsBySentence(sentences, problems.filter((p) => p.turn === said.turn), problems.filter((p) => p.turn === null));
  return {
    turn: said.turn ?? null,
    seq: said.seq ?? null,
    ts: said.ts ?? null,
    sentences: sentences.map((sentence, i) => {
      const own = facts.filter((f) => factIn(f, sentence.text, ctx.orgName));
      const shown = own.map((f) => ({ kind: f.kind, value: f.value, source: f.source, proof: proofOf(f, reads) }));
      const claims = claimsOf(sentence, said, ctx.templates, local);
      const { verdict, problems: why } = verdictOf(own.map((f) => ({ backed: backed.includes(f) })), claims, touched[i]);
      return { text: sentence.text, verdict, facts: shown, claims, problems: why };
    }),
  };
}

/** The options the line, the staff view and pilot-check all build receipts with, from one config. */
export const receiptOptions = (config) => ({ orgName: config.orgName, subscriptionId: config.demoSubscriptionId ?? null, timeZone: config.timeZone });

/**
 * One receipt per said event of one call, oldest first. orgName and subscriptionId are the configured ones, as
 * pilot-check grades with, else what the call logged. timeZone is used only when the call_start logged none.
 */
export function buildReceipts(events, { orgName = null, subscriptionId = null, timeZone = 'America/Los_Angeles' } = {}) {
  const sorted = listOf(events).filter((e) => e && typeof e === 'object').sort(bySeq);
  const callId = sorted.find((e) => e.callId)?.callId ?? null;
  const list = sorted.filter((e) => e.callId === callId);
  const start = list.find((e) => e.type === 'call_start') ?? null;
  const options = { orgName, subscriptionId };
  const ctx = {
    list,
    options,
    orgName: orgName ?? start?.orgName ?? null,
    timeZone: start?.timeZone ?? timeZone,
    templates: templatesFor(start),
  };
  const problems = checkFacts(list, options);
  return list.filter((e) => e.type === 'said').map((said) => receiptFor(said, ctx, problems));
}
