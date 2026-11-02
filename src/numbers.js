// Number words shared by the PIN reader, the amount parser and the spoken facts scan.

const ONES = Object.freeze({ zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 });
const TEENS = Object.freeze({ ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19 });
const TENS = Object.freeze({ twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 });
const SCALES = Object.freeze({ hundred: 100, thousand: 1000 });
const ORDINALS = Object.freeze({ first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
  tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30 });
// "oh" and "o" mean zero only when someone reads a code out loud, never in an amount.
const SPOKEN_ZEROS = new Set(['oh', 'o']);
const REPEATS = Object.freeze({ double: 2, triple: 3 });
// Speech to text often writes a spoken digit as one of these words.
const HOMOPHONES = Object.freeze({ to: 2, too: 2, for: 4, fore: 4, won: 1, ate: 8 });

// Object.hasOwn, so a word like "constructor" is never read as a number.
const has = (table, key) => Object.hasOwn(table, key);
const SMALL = Object.freeze({ ...ONES, ...TEENS });

export const NUMBER_WORDS = Object.freeze([...Object.keys(SMALL), ...Object.keys(TENS), ...Object.keys(SCALES)]);
export const ORDINAL_WORDS = Object.freeze(Object.keys(ORDINALS));
const NUMBER_WORD_SET = new Set(NUMBER_WORDS);

/** Every word that can carry a digit of a spoken PIN, so the ledger can mask it (I4). */
export const DIGIT_CARRIERS = new Set([...NUMBER_WORDS, ...SPOKEN_ZEROS, ...Object.keys(REPEATS), ...Object.keys(HOMOPHONES)]);

export const isNumberWord = (word) => NUMBER_WORD_SET.has(word);

/** Lowercase words and ASCII digit runs. NFKC turns full-width digits into ASCII ones first. */
export const tokenize = (text) => String(text ?? '').normalize('NFKC').toLowerCase().replace(/-/g, ' ').match(/\d+|[a-z]+/g) ?? [];

/** Groups neighbouring number words, so "one hundred and fifty" is one run. */
export function numberRuns(tokens) {
  const runs = [];
  let run = null;
  tokens.forEach((token, i) => {
    const next = tokens[i + 1] ?? '';
    const joinsRun = run && token === 'and' && isNumberWord(next);
    const startsScale = token === 'a' && has(SCALES, next);
    if (isNumberWord(token) || joinsRun || startsScale) {
      if (!run) run = { words: [], start: i };
      run.words.push(token);
      run.end = i;
      return;
    }
    if (run) runs.push(run);
    run = null;
  });
  if (run) runs.push(run);
  return runs;
}

/** The value of one run of number words. "one hundred and fifty" is 150. */
export function runValue(words) {
  let total = 0;
  let current = 0;
  for (const word of words) {
    if (has(SMALL, word)) current += SMALL[word];
    else if (has(TENS, word)) current += TENS[word];
    else if (word === 'hundred') current = (current || 1) * 100;
    else if (word === 'thousand') { total += (current || 1) * 1000; current = 0; }
  }
  return total + current;
}

/** Each run of number words read as one number, joined. "four hundred twelve" is 412. */
export const runDigits = (text) => {
  const tokens = tokenize(text);
  return numberRuns(tokens).map((run) => String(runValue(run.words))).join('');
};

/** A day said as an ordinal, "first" or "twenty first", or null. */
export function ordinalValue(words) {
  if (words.length === 1) return has(ORDINALS, words[0]) ? ORDINALS[words[0]] : null;
  const [tens, ordinal] = words;
  if (words.length === 2 && has(TENS, tens) && has(ORDINALS, ordinal) && ORDINALS[ordinal] < 10) return TENS[tens] + ORDINALS[ordinal];
  return null;
}

function digitOf(token, homophones) {
  if (has(ONES, token)) return ONES[token];
  if (SPOKEN_ZEROS.has(token)) return 0;
  return homophones && has(HOMOPHONES, token) ? HOMOPHONES[token] : null;
}

/**
 * Reads digits the way people say a PIN, group by group. "twenty four sixty eight" is 2468,
 * "thirteen fourteen" is 1314 and "double four" is 44. With homophones, "to" and "for" count too.
 */
export function spokenDigits(text, { homophones = false } = {}) {
  const groups = [];
  let tens = null;
  let repeat = 1;
  const push = (digits) => { groups.push(digits.repeat(repeat)); repeat = 1; };
  const flushTens = () => { if (tens !== null) push(String(tens)); tens = null; };
  for (const token of tokenize(text)) {
    const digit = digitOf(token, homophones);
    if (tens !== null && digit !== null && digit > 0) {
      push(String(tens + digit));
      tens = null;
      continue;
    }
    flushTens();
    if (/^\d+$/.test(token)) push(token);
    else if (digit !== null) push(String(digit));
    else if (has(TEENS, token)) push(String(TEENS[token]));
    else if (has(TENS, token)) tens = TENS[token];
    else if (has(SCALES, token)) { if (groups.length > 0) groups.push(String(SCALES[token]).slice(1)); }
    else repeat = has(REPEATS, token) ? REPEATS[token] : 1;
  }
  flushTens();
  return groups.join('');
}
