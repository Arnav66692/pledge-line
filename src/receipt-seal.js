// The donor's receipt file: its exact layout, the line's Ed25519 signatures over it, and the check that tells whether
// a file is the one the line signed. It needs node:crypto alone, so scripts/check-receipt.js can check a file offline
// with nothing but the line's public key.
//
// Tamper-evident, which means an edit is caught, not stopped. Anyone can edit the file, and the check then says it was edited and which
// sentence changed. Three things make that work.
// 1. Each sentence is signed on its own, so an edited sentence fails its own signature even if every seal after it
//    was rebuilt.
// 2. A sha256 chain runs from the call details through every sentence in order, so a sentence taken out, added,
//    moved or copied in from another receipt breaks the chain at that sentence.
// 3. The file has one exact layout, so an edit that keeps the same JSON values, such as a changed space or line
//    ending, still shows. The top line may hold only the keys the seal covers, so nothing unsigned rides along.
//    Any edited byte fails the check.
import { createHash, createPrivateKey, createPublicKey, createHmac, sign, verify, timingSafeEqual } from 'node:crypto';

export const RECEIPT_FORMAT = 'pledge-line-receipt';
export const RECEIPT_VERSION = 1;
export const RECEIPT_ALG = 'Ed25519';
// The largest receipt file the check reads. A 40 turn call is well under 200 KB.
export const RECEIPT_MAX_BYTES = 512 * 1024;

const SEED_HEX = /^[0-9a-f]{64}$/;
const PUBLIC_HEX = /^[0-9a-f]{64}$/;
const HASH_HEX = /^[0-9a-f]{64}$/;
const SIG_HEX = /^[0-9a-f]{128}$/;
const KEY_ID_HEX = /^[0-9a-f]{16}$/;
// DER prefixes that wrap a raw 32-byte Ed25519 key as PKCS8 (private) and SPKI (public), from RFC 8410.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
// Each signed or hashed message starts with its own label, so a signature for one part can never pass as another.
const LABEL = `${RECEIPT_FORMAT}/${RECEIPT_VERSION}`;
const CALL_LABEL = `${LABEL} call\n`;
const SENTENCE_LABEL = `${LABEL} sentence\n`;
const SEAL_LABEL = `${LABEL} seal\n`;
const ACCESS_LABEL = `${LABEL} access`;
const SENTENCES_OPEN = ',"sentences":[';
const SENTENCES_CLOSE = ']}';
const VERDICTS = new Set(['proven', 'plain', 'blocked']);

/**
 * JSON with every object's keys sorted and no spaces, so the same value always gives the same bytes. Only plain
 * objects, arrays, strings, whole numbers, booleans and null are allowed, so nothing can serialize two ways.
 */
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('receipt numbers must be whole numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  throw new Error(`a receipt can't hold a ${typeof value}`);
}

const sha256 = (data) => createHash('sha256').update(data).digest();
const hex = (buf) => Buffer.from(buf).toString('hex');

/** The key id is the start of the public key's sha256, so a person can compare it by eye with /receipt-key. */
export const keyIdOf = (publicRaw) => hex(sha256(publicRaw)).slice(0, 16);

/** A public key from the 64 hex characters /receipt-key serves. */
export function publicKeyFromHex(publicHex) {
  const raw = String(publicHex ?? '').trim().toLowerCase();
  if (!PUBLIC_HEX.test(raw)) throw new Error('a receipt key is 64 hex characters');
  const bytes = Buffer.from(raw, 'hex');
  return { publicKey: createPublicKey({ key: Buffer.concat([SPKI_PREFIX, bytes]), format: 'der', type: 'spki' }), keyId: keyIdOf(bytes), publicHex: raw };
}

/**
 * The line's signer from RECEIPT_SIGNING_KEY, a 32-byte Ed25519 seed as 64 hex characters. The access key for the
 * per-call receipt secrets comes from the same seed through an HMAC with its own label, so the signing key itself
 * never signs anything but receipts.
 */
export function createReceiptSigner(seedHex) {
  const seed = String(seedHex ?? '').trim().toLowerCase();
  if (!SEED_HEX.test(seed)) throw new Error('RECEIPT_SIGNING_KEY must be 64 hex characters');
  const seedBytes = Buffer.from(seed, 'hex');
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seedBytes]), format: 'der', type: 'pkcs8' });
  const publicDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const publicRaw = publicDer.subarray(SPKI_PREFIX.length);
  const accessKey = createHmac('sha256', seedBytes).update(ACCESS_LABEL).digest();
  const keyId = keyIdOf(publicRaw);
  const publicHex = hex(publicRaw);
  return Object.freeze({
    keyId,
    publicHex,
    publicKey: createPublicKey(privateKey),
    publicPem: createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }),
    sign: (message) => hex(sign(null, Buffer.from(message, 'utf8'), privateKey)),
    /** The call's receipt secret, 128 bits. Only the page that started the call is given it. */
    secretFor: (callId) => hex(createHmac('sha256', accessKey).update(String(callId)).digest().subarray(0, 16)),
  });
}

/** Constant time. Both sides are hashed first, so the buffers are always equal length. */
export function secretMatches(signer, callId, given) {
  if (!signer || typeof given !== 'string' || given === '' || typeof callId !== 'string') return false;
  const digest = (value) => sha256(Buffer.from(value, 'utf8'));
  return timingSafeEqual(digest(given), digest(signer.secretFor(callId)));
}

// ---- The messages that are hashed and signed ----

const callMessage = (head) => `${CALL_LABEL}${canonical({ about: head.about, call: head.call, format: head.format, version: head.version })}`;
// A sentence's signature and its link both cover its content alone, so links redone after an edit still leave that
// one sentence failing its signature, and every other sentence still matching.
const contentMessage = (s) => `${SENTENCE_LABEL}${canonical(sentenceContent(s))}`;
const sealMessage = (chain) => `${SEAL_LABEL}${canonical({ count: chain.count, head: chain.head, start: chain.start })}`;
const nextLink = (prevHex, message) => hex(sha256(Buffer.concat([Buffer.from(prevHex, 'hex'), sha256(Buffer.from(message, 'utf8'))])));

/** A sentence without its own link and signature, which is what both of them cover. */
function sentenceContent(s) {
  const { link, sig, ...content } = s;
  return content;
}

/** The exact bytes of a receipt file. One line for the call details and the seal, one per sentence, then the close. */
function layout(head, sentences) {
  const top = canonical(head);
  const lines = [`${top.slice(0, -1)}${SENTENCES_OPEN}`];
  sentences.forEach((s, i) => lines.push(`${canonical(s)}${i < sentences.length - 1 ? ',' : ''}`));
  lines.push(SENTENCES_CLOSE);
  return `${lines.join('\n')}\n`;
}

/**
 * Signs a receipt body, { about, call, sentences }, and returns the file's text. Each sentence gets its chain link
 * and its own signature, and the seal signs the chain's start, its head and the sentence count.
 */
export function sealReceipt({ about, call, sentences }, signer) {
  const head = { about, call, format: RECEIPT_FORMAT, version: RECEIPT_VERSION };
  const start = hex(sha256(Buffer.from(callMessage(head), 'utf8')));
  let link = start;
  const signed = sentences.map((content, i) => {
    const s = { ...content, n: i + 1 };
    const message = contentMessage(s);
    link = nextLink(link, message);
    return { ...s, link, sig: signer.sign(message) };
  });
  const chain = { count: signed.length, head: link, start };
  const signature = { alg: RECEIPT_ALG, keyId: signer.keyId, value: signer.sign(sealMessage(chain)) };
  return layout({ ...head, chain, signature }, signed);
}

// ---- The check ----

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string';
const isWhole = (v) => Number.isSafeInteger(v) && v >= 0;
const isTextList = (v) => Array.isArray(v) && v.every(isText);
// The seal and the chain's start cover only these keys, so a key outside them would ride along unsigned. None is allowed.
const keysAre = (v, keys) => Object.keys(v).sort().join(',') === keys;
const HEAD_KEYS = 'about,call,chain,format,signature,version';
const CHAIN_KEYS = 'count,head,start';
const SIGNATURE_KEYS = 'alg,keyId,value';

/** Whether the line could have written this value. A decimal, a huge number or deep nesting can't be signed, so it can't be read. */
function canonicalOk(value) {
  try {
    canonical(value);
    return true;
  } catch {
    return false;
  }
}

function headShapeOk(head) {
  return isObject(head) && keysAre(head, HEAD_KEYS) && head.format === RECEIPT_FORMAT && head.version === RECEIPT_VERSION && isText(head.about) && isObject(head.call)
    && isText(head.call.id) && isObject(head.chain) && keysAre(head.chain, CHAIN_KEYS) && isWhole(head.chain.count) && HASH_HEX.test(String(head.chain.head)) && HASH_HEX.test(String(head.chain.start))
    && isObject(head.signature) && keysAre(head.signature, SIGNATURE_KEYS) && head.signature.alg === RECEIPT_ALG && KEY_ID_HEX.test(String(head.signature.keyId)) && SIG_HEX.test(String(head.signature.value))
    && canonicalOk(head);
}

function sentenceShapeOk(s) {
  return isObject(s) && isWhole(s.n) && s.n >= 1 && isText(s.text) && VERDICTS.has(s.verdict) && Array.isArray(s.facts) && Array.isArray(s.claims)
    && isTextList(s.problems) && (s.note === null || isText(s.note)) && HASH_HEX.test(String(s.link)) && SIG_HEX.test(String(s.sig))
    && canonicalOk(s);
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/** Splits the raw bytes on newlines, so a damaged line can be pinned to the part of the file it holds. */
function linesOf(buf) {
  const lines = [];
  let from = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0a) {
      lines.push(buf.subarray(from, i));
      from = i + 1;
    }
  }
  lines.push(buf.subarray(from));
  // One newline at the end is the layout. Without it the file still reads, and the layout check says so.
  const endsWithNewline = buf.length > 0 && buf[buf.length - 1] === 0x0a;
  if (endsWithNewline) lines.pop();
  return { lines, endsWithNewline };
}

function readLine(bytes) {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

function parseJson(text) {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const verifies = (publicKey, message, sigHex) => {
  try {
    return verify(null, Buffer.from(message, 'utf8'), publicKey, Buffer.from(sigHex, 'hex'));
  } catch {
    return false;
  }
};

/** Reads the top line, which holds the call details and the seal. */
function readHead(lines) {
  const text = lines.length > 0 ? readLine(lines[0]) : null;
  if (text === null || !text.endsWith(SENTENCES_OPEN)) return null;
  const head = parseJson(`${text.slice(0, -SENTENCES_OPEN.length)}}`);
  return headShapeOk(head) ? head : null;
}

/** Reads each sentence line, by its place in the file. A line that can't be read is kept as null. */
function readSentences(bodyLines) {
  return bodyLines.map((bytes, i) => {
    const text = readLine(bytes);
    const last = i === bodyLines.length - 1;
    const comma = text !== null && text.endsWith(',');
    const parsed = parseJson(text === null ? null : comma ? text.slice(0, -1) : text);
    const sentence = sentenceShapeOk(parsed) ? parsed : null;
    return { place: i + 1, sentence, commaOk: sentence === null || comma === !last };
  });
}

/** The top line's verdict, as plain sentences. The seal vouches for the call details through the chain's start. */
function headProblems(head, start, sealOk, keyId) {
  const problems = [];
  if (!head) problems.push('The call details or the seal at the top of the file were changed.');
  else if (!sealOk) problems.push('The seal at the top of the file was changed, or this line never signed it.');
  else if (start !== head.chain.start) problems.push('The call details at the top of the file were changed.');
  if (head && head.signature.keyId !== keyId) problems.push(sealOk ? 'The key name in the seal was changed.' : 'This receipt names another key, not the key of this line.');
  return problems;
}

/**
 * Walks the sentences in order. A sentence is named when its own signature fails, when it sits out of its signed
 * order, or when the chain breaks at it. The chain is followed from every link the check can still trust, so one
 * edited sentence or link is named alone, not with every sentence after it.
 */
function sentenceProblems(read, signed, firstLinks, mark) {
  let trusted = firstLinks;
  let lastN = 0;
  let afterGap = false;
  read.forEach(({ place, sentence, commaOk }, i) => {
    const label = `Sentence ${place}`;
    if (!commaOk) mark(place, `The layout around sentence ${place} was changed.`);
    if (!sentence) {
      // A line that can't be read may hold more than one sentence, so the order and the chain start again after it.
      trusted = null;
      afterGap = true;
      mark(place, `${label} was changed, so it can't be read.`);
      return;
    }
    const message = contentMessage(sentence);
    const inOrder = afterGap ? sentence.n > lastN : sentence.n === place || sentence.n === lastN + 1;
    if (!signed[i]) mark(place, `${label} was changed. It no longer matches what the line signed.`);
    else if (!inOrder) mark(place, `${label} is out of place. The line signed it as sentence ${sentence.n}.`);
    const next = trusted ? [...trusted].map((link) => nextLink(link, message)) : [];
    const chained = !trusted || next.includes(sentence.link);
    // A sentence whose own words changed breaks the chain too, which says nothing more, so only a signed one is named for it.
    if (!chained && signed[i]) mark(place, `${label} breaks the chain. A sentence was changed, added, moved or taken out here.`);
    trusted = new Set(signed[i] && chained ? [sentence.link] : [sentence.link, ...next]);
    if (signed[i]) {
      lastN = sentence.n;
      afterGap = false;
    }
  });
}

/** Any byte the values don't cover, such as a space or a line ending, shows as a layout change. */
function layoutProblem(head, read, buf) {
  const sentences = read.map((r) => r.sentence);
  if (!head || !sentences.every(Boolean)) return null;
  const exact = layout(head, sentences).split('\n');
  const given = buf.toString('utf8').split('\n');
  const at = exact.findIndex((line, i) => line !== given[i]);
  if (at < 0 && given.length === exact.length) return null;
  if (at === 0) return { problem: 'The layout of the top line was changed.' };
  if (at > 0 && at <= sentences.length) return { place: at, problem: `The layout of sentence ${at} was changed.` };
  return { problem: 'The end of the file was changed.' };
}

/**
 * Checks a receipt file's bytes against the line's public key. Returns whether it is untouched and signed by that key,
 * the numbers of the sentences that changed, and plain sentences saying what is wrong.
 */
export function verifyReceipt(input, { publicKey, keyId }) {
  const buf = Buffer.isBuffer(input) ? input : input instanceof Uint8Array ? Buffer.from(input) : Buffer.from(String(input ?? ''), 'utf8');
  const fail = (problem) => ({ ok: false, signedByThisLine: false, callId: null, keyId: null, changed: [], sentences: [], problems: [problem] });
  if (buf.length === 0) return fail('The file is empty.');
  if (buf.length > RECEIPT_MAX_BYTES) return fail('The file is too large to be a receipt from this line.');
  const { lines, endsWithNewline } = linesOf(buf);
  if (lines.length < 2) return fail("This file isn't a Pledge Line receipt, or it was cut short.");
  const head = readHead(lines);
  const closeLine = lines[lines.length - 1];
  const closeOk = readLine(closeLine) === SENTENCES_CLOSE;
  // A close that holds more than the close is the last sentence run into it, so it is read as that sentence.
  const closeHoldsSentence = !closeOk && closeLine.length > SENTENCES_CLOSE.length + 2;
  const read = readSentences(lines.slice(1, closeHoldsSentence ? lines.length : -1));
  if (!head && read.every((r) => r.sentence === null)) return fail("This file isn't a Pledge Line receipt, or too much of it was changed to read.");

  const start = head ? hex(sha256(Buffer.from(callMessage(head), 'utf8'))) : null;
  const sealOk = head ? verifies(publicKey, sealMessage(head.chain), head.signature.value) : false;
  const signed = read.map((r) => Boolean(r.sentence) && verifies(publicKey, contentMessage(r.sentence), r.sentence.sig));
  // A receipt another key signed fails everywhere at once. Say that once instead of calling every sentence changed.
  if (head && !sealOk && !signed.some(Boolean) && head.signature.keyId !== keyId) {
    return { ...fail('This receipt was signed with another key, not by this line.'), callId: head.call.id, keyId: head.signature.keyId };
  }

  const problems = headProblems(head, start, sealOk, keyId);
  const changed = new Set();
  const say = (problem) => { if (!problems.includes(problem)) problems.push(problem); };
  const mark = (place, problem) => {
    changed.add(place);
    say(problem);
  };
  // With the seal sound, its start is the chain's start. Without it, either the start or the call details changed.
  const firstLinks = head ? new Set(sealOk ? [head.chain.start] : [head.chain.start, start]) : null;
  sentenceProblems(read, signed, firstLinks, mark);
  if (!closeOk) say('The end of the file was changed.');
  if (head && sealOk) {
    if (head.chain.count !== read.length) say(`The line signed ${head.chain.count} sentences, and this file holds ${read.length}.`);
    const last = read.at(-1)?.sentence?.link;
    if (read.length > 0 && last !== head.chain.head) say('The last sentence no longer matches the seal.');
  }
  const shape = closeOk ? layoutProblem(head, read, buf) : null;
  if (shape?.place) mark(shape.place, shape.problem);
  else if (shape) say(shape.problem);
  if (!endsWithNewline) say('The newline at the end of the file is missing.');

  return {
    ok: problems.length === 0,
    signedByThisLine: Boolean(head) && sealOk && head.signature.keyId === keyId,
    callId: head?.call.id ?? null,
    keyId: head?.signature.keyId ?? null,
    changed: [...changed].sort((a, b) => a - b),
    sentences: read.map(({ place, sentence }) => ({ n: place, text: sentence?.text ?? null, turn: sentence?.turn ?? null, at: sentence?.at ?? null, ok: !changed.has(place) })),
    problems,
  };
}
