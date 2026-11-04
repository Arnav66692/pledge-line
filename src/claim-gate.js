// The gate over the plain agent, a view of the claim audit's own claims (EVAL.md, change log). For each reply the
// baseline gave, it shows sentence by sentence which ones hold a claim the extractor and backing rule found unbacked,
// and what a donor would have heard instead. Each sentence points at its claims by their place in the audit, so this
// counts nothing of its own. It stays apart from check.js, and a mismatch with Pledge Line's templates is never a reason.
import { centsOf, formatCents, monthDayIn, monthName, sentencesOf } from './claim-audit.js';

export const GATE_NOTE = "A view of the same claims the audit counts, for the plain agent. It adds no score and counts nothing twice. A sentence is marked only when the audit's extractor and backing rule found a claim in it that PayPal's record doesn't back. A mismatch with Pledge Line's templates is never a reason, since that would flag every free text sentence.";
export const TEMPLATE_NOTE = "Pledge Line's own sentences are templates, so a gate on them blocks almost nothing.";
const GIFT_WORDS = Object.freeze({ ACTIVE: 'active', SUSPENDED: 'paused', CANCELLED: 'cancelled' });

const giftWord = (status) => GIFT_WORDS[status] ?? String(status).toLowerCase().replace(/_/g, ' ');

/** What the record the claim was held to says instead. These words come only from that record, never from a model. */
function insteadOf(claim, moment, timeZone) {
  const gift = moment?.gift ?? null;
  if (claim.kind === 'money') {
    const cents = centsOf(gift?.amountValue);
    return cents === null ? 'PayPal shows no amount for this gift.' : `PayPal shows your monthly gift of ${formatCents(cents)}.`;
  }
  if (claim.kind === 'status') {
    if (claim.target !== 'gift') return 'PayPal shows no invoice with that status.';
    return gift?.status ? `PayPal shows your monthly gift as ${giftWord(gift.status)}.` : 'PayPal shows no monthly gift.';
  }
  if (claim.kind === 'date') {
    const next = gift ? monthDayIn(gift.nextBillingTime, timeZone) : null;
    return next ? `PayPal shows the next gift on ${monthName(next.month)} ${next.day}.` : 'PayPal shows no next date.';
  }
  return claim.change === 'any' ? 'PayPal has not accepted a change in this reply.' : 'PayPal has not accepted that change.';
}

/** One sentence of a reply. It is unbacked when the audit found any of its claims unbacked, and the audit's word stands. */
function sentenceView(text, index, own, moment, timeZone) {
  const placed = own.filter(({ claim }) => claim.sentenceIndex === index);
  const unbacked = placed.filter(({ claim }) => !claim.backed);
  const gate = placed.length === 0 ? 'no_claim' : unbacked.length > 0 ? 'unbacked' : 'backed';
  // A sentence that names the change says so once. "All set, I have cancelled it" needs no second line for "all set".
  const namesChange = unbacked.some(({ claim }) => claim.kind === 'completion' && claim.change !== 'any');
  const told = unbacked.filter(({ claim }) => !(namesChange && claim.change === 'any'));
  const instead = [...new Set(told.map(({ claim }) => insteadOf(claim, moment, timeZone)))];
  return { text, gate, claims: placed.map(({ index: at }) => at), instead };
}

/** What a donor would have heard: the reply with each unbacked sentence replaced, and each replacement said once. */
function heardFrom(sentences) {
  const said = sentences.flatMap((s) => (s.gate === 'unbacked' ? s.instead : [s.text]));
  return [...new Set(said)].join(' ');
}

/**
 * The view of one baseline call, from its transcript and its audit. claims are places in audit.claims, so a reader
 * follows each one to the number it already counts toward.
 */
export function gateViewOf(transcript, audit, { timeZone = transcript?.timeZone ?? 'America/Los_Angeles' } = {}) {
  const located = audit.claims.map((claim, index) => ({ claim, index }));
  const replies = transcript.turns.flatMap((turn) => turn.replies.map((reply, replyIndex) => {
    const own = located.filter(({ claim }) => claim.turn === turn.turn && claim.replyIndex === replyIndex);
    const sentences = sentencesOf(reply.text).map((text, index) => sentenceView(text, index, own, reply.moment, timeZone));
    const blocked = sentences.some((s) => s.gate === 'unbacked');
    return { turn: turn.turn, donor: turn.donor ?? null, said: reply.text, sentences, heard: blocked ? heardFrom(sentences) : reply.text, changed: blocked };
  }));
  return { id: audit.id, arm: audit.arm, replies };
}

const GATE_MARKS = Object.freeze({ unbacked: 'Unbacked', backed: 'Backed', no_claim: 'No claim' });

function sentenceLine(sentence, audit) {
  const claims = sentence.claims.map((at) => audit.claims[at]);
  const why = claims.map((c) => `${c.kind} "${c.said}", ${c.backed ? 'backed' : 'unbacked'}, ${c.reason}${c.neverShown ? ', a status no read had shown, counted apart' : ''}`);
  return `- ${GATE_MARKS[sentence.gate]}. "${sentence.text}"${why.length ? ` (${why.join('. ')})` : ''}`;
}

function replyLines(reply, audit) {
  const asked = reply.donor ? ` The donor said "${reply.donor}"` : '';
  return [`**${audit.id}, turn ${reply.turn}.**${asked}`, '', ...reply.sentences.map((s) => sentenceLine(s, audit)), '',
    reply.changed ? `A donor would have heard "${reply.heard}"` : 'A donor would have heard it as said.', ''];
}

/** The view as the report prints it. It prints no total of its own, and points at the numbers in the tables above. */
export function gateMarkdown(views, audits, { label, armAUnbacked }) {
  const body = views.flatMap((view, i) => view.replies.flatMap((reply) => replyLines(reply, audits[i])));
  return ['## The gate over the plain agent', '', label, '', GATE_NOTE, '',
    `${TEMPLATE_NOTE} On this run the same rule found ${armAUnbacked} unbacked in them, the number in the table above.`, '',
    ...(body.length ? body : ['The plain agent gave no reply on this run.', '']),
  ].join('\n');
}
