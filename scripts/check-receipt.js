// Checks a Pledge Line receipt file offline, with only the line's public key. No server, no ledger, no network.
//
//   node scripts/check-receipt.js receipt.json --key receipt-key.json
//   node scripts/check-receipt.js receipt.json --key 64-hex-characters
//
// The key is the JSON that /receipt-key serves, saved to a file, or its publicKey value. Exit code 0 means the file is
// untouched and signed by that key, 1 means it was changed or signed by another key, and 2 means the command was wrong.
import fs from 'node:fs';
import { publicKeyFromHex, verifyReceipt, RECEIPT_MAX_BYTES } from '../src/receipt-seal.js';

const USAGE = 'Usage: node scripts/check-receipt.js RECEIPT.json --key KEY, where KEY is the file /receipt-key gave, or its publicKey value.';

function argsOf(argv) {
  const keyAt = argv.indexOf('--key');
  const key = keyAt >= 0 ? argv[keyAt + 1] ?? null : null;
  const rest = argv.filter((_, i) => i !== keyAt && i !== keyAt + 1);
  return { file: rest.length === 1 ? rest[0] : null, key };
}

/** The key as 64 hex characters, from a file with the /receipt-key JSON or from the value itself. */
function keyHexOf(given) {
  if (/^[0-9a-fA-F]{64}$/.test(given)) return given;
  const text = fs.readFileSync(given, 'utf8');
  const trimmed = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed;
  const parsed = JSON.parse(trimmed);
  if (typeof parsed?.publicKey !== 'string') throw new Error('that key file has no publicKey');
  return parsed.publicKey;
}

function main() {
  const { file, key } = argsOf(process.argv.slice(2));
  if (!file || !key) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let publicKey;
  try {
    publicKey = publicKeyFromHex(keyHexOf(key));
  } catch (error) {
    process.stderr.write(`Couldn't read the key, ${error.message}.\n${USAGE}\n`);
    return 2;
  }
  let bytes;
  try {
    if (fs.statSync(file).size > RECEIPT_MAX_BYTES) throw new Error('it is too large to be a receipt');
    bytes = fs.readFileSync(file);
  } catch (error) {
    process.stderr.write(`Couldn't read ${file}, ${error.message}.\n`);
    return 2;
  }
  const check = verifyReceipt(bytes, publicKey);
  const out = (line) => process.stdout.write(`${line}\n`);
  out(`Receipt ${file}, call ${check.callId ?? 'unknown'}, checked with key ${publicKey.keyId}.`);
  if (check.ok) {
    out(`Untouched, and signed by this key. ${check.sentences.length} sentences, in order, each one as the line signed it.`);
    return 0;
  }
  out(check.changed.length > 0 ? `Changed, at sentence ${check.changed.join(', ')}.` : 'Changed, or signed by another key.');
  for (const problem of check.problems) out(`  ${problem}`);
  for (const s of check.sentences.filter((x) => !x.ok)) out(`  Sentence ${s.n} now reads ${s.text === null ? '(unreadable)' : JSON.stringify(s.text)}`);
  return 1;
}

process.exitCode = main();
