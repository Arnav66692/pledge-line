// The "PayPal said no" fault drill (add-on A12). PayPal's sandbox keeps test subscription ids that make suspend fail on
// purpose (developer.paypal.com/subscriptions/test-go-live). In a drill call the donor asks to pause and says yes, the
// suspend goes to one of those ids, and the line reads the real gift again, so it never claims a change PayPal refused.
// A drill is chosen only by name, never from a script, and it is logged on call_start so every grader can tell it apart.

// Wed Nov 4, 2026, 9:00 pm PT, the pilot's deadline. No sandbox drill before it, since a drill in the graded window
// would be a write to an id other than DEMO_SUBSCRIPTION_ID (see PILOT.md and FEATURES.md).
export const SANDBOX_DRILL_OPENS = '2026-11-05T05:00:00.000Z';

/**
 * The two drills. Each names PayPal's test id, the HTTP code and error name PayPal documents for a suspend of it,
 * and how the line words it. Only suspend is sent to the test id, every read stays on the call's own gift.
 */
export const DRILLS = Object.freeze({
  refused: Object.freeze({
    key: 'refused', writeId: 'ERRSUB062', kind: 'suspend', httpStatus: 422, name: 'UNPROCESSABLE_ENTITY',
    message: 'The requested action could not be performed, semantically incorrect, or failed business validation.',
    title: 'Fault drill, PayPal refuses the pause (ERRSUB062, 422)',
  }),
  unclear: Object.freeze({
    key: 'unclear', writeId: 'ERRSUB059', kind: 'suspend', httpStatus: 500, name: 'INTERNAL_SERVER_ERROR',
    message: 'An internal server error has occurred.',
    title: 'Fault drill, PayPal gives no clear answer (ERRSUB059, 500)',
  }),
});

const BY_WRITE_ID = new Map(Object.values(DRILLS).map((d) => [d.writeId, d]));

/** The drill PayPal's test id stands for, or null, so the mock can raise the same error PayPal documents. */
export const drillByWriteId = (id) => BY_WRITE_ID.get(id) ?? null;

/** A drill the line won't start, with the HTTP status the server answers with. */
export class DrillRefused extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'DrillRefused';
    this.status = status;
  }
}

/** The lines to say and what should happen, for the Demo controls picker. */
export function drillLines(drill) {
  const said = drill.key === 'refused' ? '"PayPal didn\'t accept that change."' : '"PayPal didn\'t answer clearly, so I checked again."';
  return {
    key: drill.key,
    title: drill.title,
    lines: ['PIN.', '"Can I pause my gift for a while?"', '"Yes."', '"Goodbye."'],
    expected: `The suspend goes to PayPal's test id ${drill.writeId}, which answers ${drill.httpStatus} ${drill.name}. The line says ${said} Then it reads the real gift again, and PayPal still shows it active`,
  };
}

/** True while a drill on this PayPal mode may start. Mock drills run any time, sandbox drills only after the deadline. */
export const drillOpen = (paypalMode, at) => paypalMode === 'mock' || at.getTime() >= Date.parse(SANDBOX_DRILL_OPENS);

/**
 * The drill a new call runs, or null when none was asked for. A drill asked for with a script, by a name the line
 * doesn't know, or on the sandbox before the deadline is refused, never quietly dropped or run.
 */
export function drillFor(requested, { script = null, paypalMode, now = new Date() } = {}) {
  if (requested === null || requested === undefined || requested === '') return null;
  if (typeof requested !== 'string' || !Object.hasOwn(DRILLS, requested)) throw new DrillRefused(400, 'There is no such drill.');
  if (script !== null) throw new DrillRefused(400, 'A drill never runs as a script. Pick No script, then the drill.');
  if (!drillOpen(paypalMode, now)) throw new DrillRefused(403, 'The sandbox drill opens after the pilot deadline, Wed Nov 4, 2026, 9:00 pm PT.');
  return DRILLS[requested];
}

/** What call_start logs for a drill, the drill's name and PayPal's test id its suspend goes to. */
export const drillRecord = (drill) => Object.freeze({ key: drill.key, writeId: drill.writeId });

/**
 * The drill a logged call ran, or null. It counts only when call_start names a known drill with its own test id and
 * no script, so a scripted call can never be graded as a drill, and a made-up id never gets a drill's allowance.
 */
export function drillOf(start) {
  const logged = start?.drill;
  if (!logged || typeof logged !== 'object' || typeof logged.key !== 'string' || !Object.hasOwn(DRILLS, logged.key)) return null;
  if (start.script !== null && start.script !== undefined) return null;
  const drill = DRILLS[logged.key];
  return logged.writeId === drill.writeId ? drill : null;
}
