// The receipt a donor keeps: every sentence the line said on one call, in order, each with what backs it. The content
// is buildReceipts, the same receipts the page shows and pilot-check grades with. receipt-seal.js signs it.
// The file holds no PIN, no full email, no token ids, no user agent and no raw snapshots. It is built from the said
// events and the receipts alone, and each sentence is rebuilt from a short list of fields.
import { buildReceipts, receiptOptions } from './receipt.js';
import { sealReceipt } from './receipt-seal.js';

export const RECEIPT_ABOUT = 'A receipt from the Pledge Line donor line. It lists every sentence the line said on this call, in order, '
  + 'with the PayPal read behind each fact. The line signed it, so it is tamper-evident. Any edit to this file can be detected. '
  + 'Check it on the line at /check, or offline with scripts/check-receipt.js and the public key from /receipt-key. Times are in UTC.';
// What the receipt says beside a sentence that had nothing to check, and beside one that didn't check out.
export const PLAIN_NOTE = 'Nothing to check.';
export const BLOCKED_NOTE = "This sentence didn't check out against the call's PayPal reads. The reasons are listed.";

// An email written out in full, which the line never says, since it reads the email on file masked. Hidden anyway.
const EMAIL_TOKEN = /[^\s@＠﹫]+\s*[@＠﹫]\s*[^\s@＠﹫]+/g;
const HIDDEN_EMAIL = '(an email address, hidden)';
const hideEmail = (value) => String(value ?? '').replace(EMAIL_TOKEN, HIDDEN_EMAIL);
const orNull = (value) => (value === undefined ? null : value);

function proofOf(proof) {
  if (!proof) return null;
  return { seq: orNull(proof.seq), ts: orNull(proof.ts), what: orNull(proof.what), id: orNull(proof.id), debugId: orNull(proof.debugId), status: orNull(proof.status) };
}

/** One sentence of buildReceipts, rebuilt from its own fields, with the note a person reads beside it. */
function sentenceOf(receipt, sentence) {
  return {
    turn: orNull(receipt.turn),
    at: orNull(receipt.ts),
    text: hideEmail(sentence.text),
    verdict: sentence.verdict,
    facts: (sentence.facts ?? []).map((f) => ({ kind: f.kind, value: hideEmail(f.value), source: f.source, proof: proofOf(f.proof) })),
    claims: (sentence.claims ?? []).map((c) => ({ name: c.name, meaning: orNull(c.meaning), proven: Boolean(c.proven) })),
    problems: (sentence.problems ?? []).map(hideEmail),
    note: sentence.verdict === 'plain' ? PLAIN_NOTE : sentence.verdict === 'blocked' ? BLOCKED_NOTE : null,
  };
}

/**
 * The receipt body for one call, from its ledger events, oldest first, or why there is none. The call must have
 * ended, so the receipt covers the whole call.
 */
export function receiptBody(events, config, signer) {
  const list = [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const start = list.find((e) => e.type === 'call_start');
  if (!start) return { error: 'not_found' };
  const end = list.findLast((e) => e.type === 'call_end');
  if (!end) return { error: 'not_ended' };
  const receipts = buildReceipts(list, receiptOptions(config));
  const mode = start.mode ?? {};
  const call = {
    id: signer.receiptIdFor(start.callId),
    org: config.orgName,
    script: Number.isInteger(start.script) ? start.script : null,
    startedAt: start.ts,
    endedAt: end.ts,
    endReason: typeof end.reason === 'string' ? end.reason : null,
    timeZone: start.timeZone ?? config.timeZone,
    paypal: mode.paypal === 'mock' ? 'mock' : 'sandbox',
    router: typeof mode.router === 'string' ? mode.router : null,
    practice: mode.paypal === 'mock' || mode.router === 'rules',
  };
  const sentences = receipts.flatMap((receipt) => receipt.sentences.map((sentence) => sentenceOf(receipt, sentence)));
  return { body: { about: RECEIPT_ABOUT, call, sentences } };
}

/** The signed file text for one call, or the reason there is none. */
export function receiptFile(events, config, signer) {
  const { body, error } = receiptBody(events, config, signer);
  return error ? { error } : { text: sealReceipt(body, signer) };
}
