// The 15-minute sandbox gate check for the "PayPal said no" fault drill (A12), from "Pledge Line add-ons.md".
// Usage, only after Wed Nov 4, 2026, 9:00 pm PT: npm run errsub:check
// It asks PayPal's sandbox for an access token, then sends exactly two suspend POSTs, one to ERRSUB062 and one to
// ERRSUB059, PayPal's own test ids that fail on purpose. It reads nothing, touches no real gift and writes no ledger.
// PASS needs ERRSUB062 to answer 422 UNPROCESSABLE_ENTITY and ERRSUB059 to answer 500 INTERNAL_SERVER_ERROR.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createPayPal, PayPalError } from '../src/paypal.js';
import { createTokens } from '../src/gate.js';
import { DRILLS, SANDBOX_DRILL_OPENS } from '../src/drill.js';

const CHECK_CALL_ID = 'errsub-check';
// The order the add-ons report gives, the 422 first.
const CHECKS = [DRILLS.refused, DRILLS.unclear];

/** Why the check must not run now, or null. Before the pilot deadline a sandbox write to any id stays off the table. */
export function refusalAt(now) {
  if (!(now.getTime() >= Date.parse(SANDBOX_DRILL_OPENS))) {
    return 'errsub-check refuses to run before Wed Nov 4, 2026, 9:00 pm PT, the pilot deadline. Nothing was sent to PayPal.';
  }
  return null;
}

/** What PayPal answered one suspend with, as the check compares it. */
function answerOf(outcome) {
  if (outcome.ok) return { httpStatus: outcome.status ?? 200, name: 'OK', debugId: outcome.debugId ?? null };
  const error = outcome.error;
  if (!(error instanceof PayPalError)) throw error;
  return { httpStatus: error.status, name: error.name, debugId: error.debugId ?? null };
}

/**
 * Sends the two suspends and compares each answer with what PayPal's test values page documents. Each suspend gets
 * its own one-time token, minted here for its own test id only, so the write path is the one the line uses.
 */
export async function checkErrsub({ paypal, tokens }) {
  const results = [];
  for (const drill of CHECKS) {
    const token = tokens.mint({ callId: CHECK_CALL_ID, pendingId: CHECK_CALL_ID, kind: 'suspend', targetId: drill.writeId });
    let outcome;
    try {
      const res = await paypal.suspendSubscription(drill.writeId, token, { callId: CHECK_CALL_ID });
      outcome = { ok: true, status: res.status, debugId: res.debugId };
    } catch (error) {
      outcome = { ok: false, error };
    }
    const got = answerOf(outcome);
    const pass = got.httpStatus === drill.httpStatus && got.name === drill.name;
    results.push({ id: drill.writeId, want: { httpStatus: drill.httpStatus, name: drill.name }, got, pass });
  }
  return { pass: results.every((r) => r.pass), results };
}

/** The lines the check prints, one per suspend, then PASS or FAIL. */
export function reportLines({ pass, results }) {
  const lines = results.map((r) => `${r.pass ? 'pass' : 'fail'}, POST /v1/billing/subscriptions/${r.id}/suspend answered ${r.got.httpStatus} ${r.got.name}, debug id ${r.got.debugId ?? 'none'}, expected ${r.want.httpStatus} ${r.want.name}`);
  lines.push(pass
    ? 'PASS. Both test ids failed the way PayPal documents, so the sandbox drill can be built.'
    : 'FAIL. Do not build the sandbox drill. Keep the mock-only drill, labeled as mock, and say so in the video.');
  return lines;
}

async function main() {
  const refusal = refusalAt(new Date());
  if (refusal) {
    process.stderr.write(`${refusal}\n`);
    process.exitCode = 2;
    return;
  }
  const config = loadConfig(process.env, { partial: true });
  if (config.paypal.mode !== 'sandbox' || !config.paypal.clientId || !config.paypal.clientSecret) {
    process.stderr.write('errsub-check needs PAYPAL_MODE=sandbox with PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET. Nothing was sent to PayPal.\n');
    process.exitCode = 2;
    return;
  }
  const tokens = createTokens();
  const paypal = createPayPal({ baseUrl: config.paypal.baseUrl, clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, tokens });
  const outcome = await checkErrsub({ paypal, tokens });
  process.stdout.write(`${reportLines(outcome).join('\n')}\n`);
  process.exitCode = outcome.pass ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`errsub-check stopped, ${error.message}\n`);
    process.exitCode = 1;
  });
}
