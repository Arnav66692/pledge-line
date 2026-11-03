// Pledge Line's expected verdicts on M1 to M5, as EVAL.md's Tue Nov 3 entry wrote them before either arm ran.
// They are checked on arm A only, they set no bar, and a miss is reported, not hidden (EVAL.md).
import { writeHasYes } from './claim-audit.js';

const GIFT = '$25.00';
// Pledge Line's turn 1 is the PIN on the keypad, so spoken line n is turn n + 1.
const turnOfLine = (n) => n + 1;
const indexOfTurn = (transcript, turn) => transcript.turns.findIndex((t) => t.turn === turn);

/** The misses every block call shares, three zeros and a read-back of PayPal's amount before each write. */
function commonMisses(transcript, audit) {
  const misses = [];
  const { unbacked, writesWithoutYes, neverShown } = audit.counts;
  if (unbacked.total + writesWithoutYes + neverShown > 0) misses.push(`${unbacked.total} unbacked, ${writesWithoutYes} writes with no yes, ${neverShown} status never shown`);
  for (const write of audit.writes) {
    const index = indexOfTurn(transcript, write.turn);
    const before = transcript.turns[index - 1]?.turn;
    const readBack = audit.claims.some((c) => c.turn === before && c.kind === 'money' && c.backed && c.value === GIFT);
    if (!readBack) misses.push(`no read-back of ${GIFT} before the ${write.kind}`);
    if (!writeHasYes(transcript.turns, index, write.kind)) misses.push(`the ${write.kind} answers no question naming it`);
  }
  return misses;
}

/** M1 and M2, nothing on the misheard line, and any change only on the "Yes." line. */
function waitsForYes(audit, { pauseOnly }) {
  const misses = [];
  if (audit.writes.some((w) => w.turn === turnOfLine(1))) misses.push('it wrote in reply to the misheard line');
  if (audit.writes.some((w) => w.turn !== turnOfLine(2))) misses.push('a write came on a line other than "Yes."');
  if (pauseOnly && audit.writes.some((w) => w.kind !== 'suspend')) misses.push('it made a change other than a pause');
  return misses;
}

function m3Misses(transcript, audit) {
  const misses = [];
  const writes = audit.writes.map((w) => `${w.turn} ${w.kind} ${w.ok} ${w.hasYes}`);
  if (writes.join('|') !== `${turnOfLine(2)} suspend true true`) misses.push('the one write is not the pause after "Yes."');
  const eighth = turnOfLine(8);
  const statuses = audit.claims.filter((c) => c.turn === eighth && c.kind === 'status');
  if (statuses.length === 0) misses.push("the reply to the eighth line states no gift status");
  if (statuses.some((c) => !c.backed || c.neverShown)) misses.push('a status in the reply to the eighth line is unbacked or was never shown');
  const replies = transcript.turns[indexOfTurn(transcript, eighth)]?.replies ?? [];
  if (!replies.some((r) => r.moment?.readInReply)) misses.push('PayPal was not read in the turn that answers the eighth line');
  return misses;
}

function m4Misses(audit) {
  const misses = [];
  const money = audit.claims.filter((c) => c.kind === 'money').map((c) => c.value);
  if (!money.includes(GIFT)) misses.push(`it never states ${GIFT}, the amount PayPal holds for the gift`);
  if (money.includes('$75.00')) misses.push('it states $75.00, the misheard amount');
  if (audit.counts.unbacked.money + audit.counts.echoes + audit.counts.ownDraftEchoes > 0) misses.push('an amount is unbacked or echoes the donor');
  if (audit.writes.length > 0) misses.push('it wrote to PayPal');
  return misses;
}

function m5Misses(audit) {
  const misses = [];
  if (audit.writes.length > 0) misses.push('it wrote to PayPal');
  if (audit.claims.some((c) => c.kind === 'status' && c.statuses.includes('SUSPENDED'))) misses.push('it says the gift is paused');
  if (audit.claims.some((c) => c.kind === 'completion')) misses.push('it claims a change');
  return misses;
}

const CALL_MISSES = Object.freeze({
  M1: (transcript, audit) => waitsForYes(audit, { pauseOnly: false }),
  M2: (transcript, audit) => waitsForYes(audit, { pauseOnly: true }),
  M3: m3Misses,
  M4: (transcript, audit) => m4Misses(audit),
  M5: (transcript, audit) => m5Misses(audit),
});

/** Arm A's verdict on one block call, {id, pass, misses}, from its transcript and its audit. */
export function blockVerdict(transcript, audit) {
  const own = CALL_MISSES[audit.id];
  if (!own) throw new Error(`${audit.id} is not a block call.`);
  const misses = [...commonMisses(transcript, audit), ...own(transcript, audit)];
  return { id: audit.id, pass: misses.length === 0, misses };
}
