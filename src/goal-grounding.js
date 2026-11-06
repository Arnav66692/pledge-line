const WORD_VALUES = Object.freeze({ zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 });
const WORD_PATTERN = `(?:(?:${Object.keys(WORD_VALUES).join('|')}|hundred|thousand|dozen|and)[ -]+){0,7}(?:${Object.keys(WORD_VALUES).join('|')}|hundred|thousand|dozen)`;
const NUMBER_PATTERN = `(?:(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,2})?|${WORD_PATTERN})`;
const MONEY = new RegExp(`(?:([$€£¥]|\\b(?:USD|EUR|GBP|CAD|AUD|JPY|U\\.?S\\.? dollars?|Canadian dollars?|Australian dollars?|euros?|pounds?|yen))\\s*(${NUMBER_PATTERN})(?!\\w|\\.\\d|,\\d)|\\b(${NUMBER_PATTERN})\\s+(USD|EUR|GBP|CAD|AUD|JPY|U\\.?S\\.? dollars?|Canadian dollars?|Australian dollars?|euros?|pounds?|yen|dollars?))`, 'gi');
const GOODS = /\b(?:shirts?|t[- ]?shirts?|tees|mugs?|totes?|bags?|posters?|flyers?|units?|badges?|bottles?|supplies|kits?|meals?|blankets?|jackets?|quantity|count|volunteers?|participants?|people|extras?|spares?)\b/i;
const BUDGET_WORD = /\b(?:budget|cap|maximum|limit|total|spend|under|at most|no more than)\b/i;
const ZONES = Object.freeze({ Pacific: 'America/Los_Angeles', PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles',
  Eastern: 'America/New_York', 'New York': 'America/New_York', 'Los Angeles': 'America/Los_Angeles', Tokyo: 'Asia/Tokyo', London: 'Europe/London',
  EST: 'America/New_York', EDT: 'America/New_York', Central: 'America/Chicago', CDT: 'America/Chicago',
  Mountain: 'America/Denver', MST: 'America/Denver', MDT: 'America/Denver', UTC: 'UTC', GMT: 'UTC' });
const ZONE_OFFSETS = Object.freeze({ PST: '-08:00', PDT: '-07:00', EST: '-05:00', EDT: '-04:00', CST: '-06:00', CDT: '-05:00', MST: '-07:00', MDT: '-06:00', UTC: 'Z', GMT: 'Z' });
const MONTHS = Object.freeze(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']);
const DAYS = Object.freeze(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);
const ORDINALS = Object.freeze(['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth', 'twenty-first', 'twenty-second', 'twenty-third', 'twenty-fourth', 'twenty-fifth', 'twenty-sixth', 'twenty-seventh', 'twenty-eighth', 'twenty-ninth', 'thirtieth', 'thirty-first']);

export function numberWords(text) {
  const raw = String(text).toLowerCase().trim();
  if (raw.includes(',') && !/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(raw)) return NaN;
  const value = raw.replaceAll(',', '');
  if (/^\d+(?:\.\d{1,2})?$/.test(value)) return Number(value);
  let total = 0, current = 0;
  for (const word of value.split(/[ -]+/)) {
    if (word === 'and') continue;
    if (Object.hasOwn(WORD_VALUES, word)) current += WORD_VALUES[word];
    else if (word === 'hundred') current = (current || 1) * 100;
    else if (word === 'thousand') { total += (current || 1) * 1000; current = 0; }
    else if (word === 'dozen') current = (current || 1) * 12;
    else return NaN;
  }
  return total + current;
}

function numberMatches(text) {
  return [...text.matchAll(new RegExp(`\\b(${NUMBER_PATTERN})\\b`, 'gi'))].map((match) => ({ value: numberWords(match[1]), index: match.index, end: match.index + match[0].length }));
}

const ITEM_WORDS = '(?:t[- ]?shirts?|shirts?|tees|mugs?|tote bags?|bags?|posters?|flyers?|units?|pieces?|badges?|bottles?|kits?|meals?|blankets?|jackets?)';
const ITEM_DESCRIPTOR = "(?:[a-z]+(?:[-'][a-z]+)*|[abc](?:10|[0-9]))";
const QUANTITY_ROLE_WORD = /^(?:prints?|printing|colou?rs?|logos?|designs?|sizes?|packs?|boxes?|cases?|cartons?|bundles?|sets?|dozens?|percent|percentage|per|each|of|for|with|at|by|on|under|over|between|before|after|and|or|to|from|than|instead|costs?|prices?|budget|usd|eur|gbp|cad|aud|jpy|dollars?|currency|shipping|fees?|delivery|dates?|times?|sku|january|february|march|april|may|june|july|august|september|october|november|december)$/i;
const QUANTITY_PREFIX_ROLE = /\b(?:sku|price|cost|budget|date|time|size|print|colou?r|logo|design|january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(?:id|code|number|count))?\s*[:#=]?\s*$|\b(?:packs?|boxes?|cases?|cartons?|bundles?|sets?|dozens?)\s+of\s*$/i;
const CORRECTION = /\b(?:actually|instead|rather|make that|make it|change|replace|revise|update|adjust|raise|lower|increase|decrease|switch|correct|correction|final|now|i mean)\b/i;
const MONEY_UNIT = /\$|\b(?:USD|U\.?S\.? dollars?|dollars?|euros?|EUR|GBP|CAD|AUD|JPY)\b/i;
const HISTORIC = /\b(?:previous|prior|historical|old|original|vendor|supplier|quot(?:e|ed)|estimate|invoice|reserved?|earmarked)\b/gi;
const BUDGET_ROLE = /\b(?:final\s+(?:budget|cap|ceiling|limit)|budget|cap|ceiling|maximum|limit|all[- ]in|total|spend(?:ing)?|under|up to|no more than|not exceed|remaining|remainder|leaving|left for|use|allocate(?:d)?)\b/gi;
const NON_CURRENCY_WORDS = new Set(['for', 'the', 'and', 'cap', 'max', 'buy', 'get', 'qty', 'now', 'was', 'our', 'use', 'its', 'tax', 'all']);

// Scope correction intent to the clause naming the field, rather than another field's edit.
function intentClauses(text) {
  return text.split(/[;\n]+|[.!?]\s+|,\s+(?=(?:keep|retain|preserve|leave|change|replace|revise|update|adjust|raise|lower|increase|decrease|use|make|set)\b)|\b(?:and|but)\s+(?=(?:keep|retain|preserve|leave|change|replace|revise|update|adjust|raise|lower|increase|decrease)\b)/i).map((clause) => clause.trim()).filter(Boolean);
}

function retainedClause(text) {
  const normalized = text.replace(/\b(?:do not|don't|dont|never)\s+(?:change|replace|adjust|revise|update)\b/gi, 'keep');
  return /\b(?:keep|retain|preserve|leave|unchanged)\b|\b(?:remain|remains|stay|stays)\s+(?:exactly\s+)?(?:the\s+)?same\b/i.test(normalized) &&
    !/\b(?:change|replace|revise|update|adjust|raise|lower|increase|decrease|switch|instead|rather|actually|correct(?:ion)?)\b/i.test(normalized);
}

function purchaseAllocation(before, after) {
  const target = `(?:these\\s+(?:[a-z-]+\\s+){0,6}(?:${ITEM_WORDS}|items?|goods|supplies)|(?:this|the)\\s+(?:order|purchase))`;
  const allocation = '(?:earmarked|reserved|allocated|set aside|dedicated)';
  return new RegExp(`\\b${allocation}\\s+for\\s+${target}\\b`, 'i').test(before) ||
    new RegExp(`^\\s*(?:(?:program|project|overall)\\s+(?:budget|fund|balance)\\s+)?(?:(?:is|are)\\s+)?${allocation}\\s+for\\s+${target}\\b`, 'i').test(after) ||
    new RegExp(`\\b${allocation}\\s*$`, 'i').test(before) && new RegExp(`^\\s+for\\s+${target}\\b`, 'i').test(after);
}

function lastMatch(pattern, text) {
  return [...text.matchAll(pattern)].at(-1)?.index ?? -1;
}

function numericRoleAllowed(text, index, end) {
  const before = text.slice(0, index), after = text.slice(end);
  return !/(?:[$€£¥]\s*|\b(?:USD|EUR|GBP|CAD|AUD|JPY)\s*|\b(?:not|no|instead of)\s*)$/i.test(before) &&
    !/^\s*(?:USD|EUR|GBP|CAD|AUD|JPY|dollars?|U\.?S\.? dollars?)\b/i.test(after) &&
    !/(?:[-/.,]|\d:)$/.test(before) && !/^(?:[-/]|:\d|[.,]\d)/.test(after);
}

function quantityCandidates(text, priorQuantityKnown = false) {
  const found = [], oneEach = /\b(?:one|a)\s+(?:\w+\s+){0,4}(?:shirt|tee|mug|bag|badge|bottle|kit|meal|blanket|jacket)\s+(?:for\s+)?each\b|\bone\s+per\s+(?:volunteer|participant|person)\b/i.test(text);
  if (oneEach) {
    for (const match of text.matchAll(new RegExp(`\\b(${NUMBER_PATTERN})\\s+(?:volunteers?|participants?|people)\\b`, 'gi'))) found.push({ value: numberWords(match[1]), index: match.index, end: match.index + match[0].length });
  } else {
    // Bind to the nearest supported item noun through a bounded, open descriptor grammar.
    // Role words reject packaging, decoration counts, percentages and financial/calendar values;
    // accepting arbitrary descriptors is lexical grounding, not a general semantic proof.
    const itemPattern = new RegExp(`\\b(${NUMBER_PATTERN})\\s+((?:${ITEM_DESCRIPTOR}\\s+){0,8}?)${ITEM_WORDS}\\b`, 'gi');
    for (const match of text.matchAll(itemPattern)) {
      const end = match.index + match[0].length;
      const descriptors = match[2].trim().split(/[\s-]+/).filter(Boolean);
      if (!descriptors.some((word) => QUANTITY_ROLE_WORD.test(word)) && !QUANTITY_PREFIX_ROLE.test(text.slice(Math.max(0, match.index - 80), match.index)) &&
        numericRoleAllowed(text, match.index, match.index + match[1].length) && !/^\s+(?:colors?|colours?|prints?|designs?|sizes?|per\b|for each\b)/i.test(text.slice(end))) found.push({ value: numberWords(match[1]), index: match.index, end });
    }
  }
  for (const match of text.matchAll(new RegExp(`\\b(?:quantity|qty|count)(?:\\s+(?:is|of|should be))?\\s*[:=]?\\s*(${NUMBER_PATTERN})\\b`, 'gi'))) {
    const index = match.index + match[0].lastIndexOf(match[1]);
    if (!/\b(?:print|color|colour|design|size)\s*$/i.test(text.slice(0, match.index)) && numericRoleAllowed(text, index, index + match[1].length)) found.push({ value: numberWords(match[1]), index, end: index + match[1].length });
  }
  if (!found.length && priorQuantityKnown && CORRECTION.test(text) && !MONEY_UNIT.test(text) && !BUDGET_WORD.test(text) && !/\b(?:date|deliver|deadline|time|print|color|colour|design|am|pm|suppliers?|split|splitting|payee|currency)\b/i.test(text)) {
    const values = numberMatches(text).filter((match) => numericRoleAllowed(text, match.index, match.end));
    if (values.length === 1) found.push(values[0]);
  }
  return found.filter((item) => Number.isSafeInteger(item.value)).sort((a, b) => a.index - b.index);
}

function selectCandidate(candidates, text) {
  if (!candidates.length) return null;
  const unique = [...new Set(candidates.map((item) => item.value))];
  if (unique.length === 1) return unique[0];
  const last = candidates.at(-1), previous = candidates.slice(0, -1).findLast((item) => item.value !== last.value);
  return previous && CORRECTION.test(text.slice(previous.end, last.end)) ? last.value : null;
}

function currencyUnit(value) {
  const token = String(value).replace(/[.\s]/g, '').toUpperCase();
  if (token === '$' || token === 'DOLLAR' || token === 'DOLLARS') return { currency: 'USD', explicit: false };
  if (token === 'USD' || token === 'USDOLLAR' || token === 'USDOLLARS') return { currency: 'USD', explicit: true };
  const glyphs = { '€': 'EUR', '£': 'GBP', '¥': 'JPY', EURO: 'EUR', EUROS: 'EUR', POUND: 'GBP', POUNDS: 'GBP', YEN: 'JPY', CANADIANDOLLAR: 'CAD', CANADIANDOLLARS: 'CAD', AUSTRALIANDOLLAR: 'AUD', AUSTRALIANDOLLARS: 'AUD' };
  return { currency: glyphs[token] ?? token, explicit: true };
}

function budgetCandidates(text) {
  const found = [];
  for (const clauseMatch of text.matchAll(/[^!?;\n]+/g)) {
    const clause = clauseMatch[0];
    const monies = [...clause.matchAll(MONEY)];
    for (const [index, match] of monies.entries()) {
      const start = match.index, end = start + match[0].length;
      const before = clause.slice(monies[index - 1] ? monies[index - 1].index + monies[index - 1][0].length : 0, start).split(/[.!?]\s+/).at(-1);
      const after = clause.slice(end, monies[index + 1]?.index ?? clause.length).split(/[.!?]\s+/)[0];
      const role = lastMatch(BUDGET_ROLE, before), historic = lastMatch(HISTORIC, before);
      const currentAllocation = purchaseAllocation(before, after);
      if (!currentAllocation && (historic > role || /\b(?:reserved|earmarked|allocated|set aside|dedicated)\s+for\b/i.test(before) || /^\s*(?:(?:is|are)\s+)?(?:reserved|earmarked|allocated|set aside|dedicated)\s+for\b/i.test(after)) ||
        /\b(?:not|instead of)\s*$/i.test(before) || /^\s*(?:each|per\s+(?:shirt|item|unit|person)|was (?:a |the )?(?:previous|old|prior|vendor|supplier) quote)\b/i.test(after) || /(?:\$|\bUSD)\s*-|(?:^|\s)-\d/.test(match[0])) continue;
      const dollars = numberWords(match[2] ?? match[3]), unit = currencyUnit(match[1] ?? match[4]);
      const globalFund = /\b(?:program|project|overall|organization-wide|company-wide)\s+(?:budget|fund|balance)\b/i.test(before + ' ' + after);
      if (globalFund && !currentAllocation && !/\bfinal\s+(?:budget|cap|ceiling|limit)\b/i.test(before)) continue;
      const priority = /\bfinal\s+(?:budget|cap|ceiling|limit)\b/i.test(before) ? 3 : currentAllocation ? 2 : globalFund ? 0 : role >= 0 || /^\s*(?:all[- ]in|total|maximum|budget|cap)\b/i.test(after) ? 2 : 1;
      if (Number.isFinite(dollars)) found.push({ value: Math.round(dollars * 100), priority, currency: unit.currency, explicitCurrency: unit.explicit, index: clauseMatch.index + start, end: clauseMatch.index + end });
    }
  }
  if (!found.length && BUDGET_WORD.test(text) && !MONEY_UNIT.test(text)) {
    const labeled = new RegExp(`\\b(?:budget|cap|ceiling|maximum|limit|under|spend|up to|total)(?:\\s+(?:is|of|should be|at|to|with))?\\s*[:=]?\\s*(${NUMBER_PATTERN})\\b|\\b(${NUMBER_PATTERN})\\s+(?:total|all[- ]in|maximum|budget|cap)\\b`, 'gi');
    for (const match of text.matchAll(labeled)) {
      const before = text.slice(0, match.index).split(/[.!?]\s+|[;\n]/).at(-1), after = text.slice(match.index + match[0].length).split(/[.!?]\s+|[;\n]/)[0];
      if (/\b(?:program|project|overall|organization-wide|company-wide)\s*$/i.test(before) && !purchaseAllocation(before, after)) continue;
      const dollars = numberWords(match[1] ?? match[2]);
      if (Number.isFinite(dollars)) found.push({ value: Math.round(dollars * 100), priority: 2, currency: null, explicitCurrency: false, index: match.index, end: match.index + match[0].length });
    }
  }
  return found.filter((item) => Number.isSafeInteger(item.value)).sort((a, b) => a.index - b.index);
}

function latestFieldValue(turns, field) {
  let quantity = null, budget = null, hadGoods = false;
  for (const text of turns) {
    const quantities = quantityCandidates(text, quantity !== null), budgets = budgetCandidates(text);
    const bare = /^\s*([\d,]+(?:\.\d{1,2})?|[a-z -]+)\s*[.!]?\s*$/i.exec(text);
    const bareValue = bare ? numberWords(bare[1]) : NaN;
    if (quantities.length) quantity = selectCandidate(quantities, text);
    else if (/\b(?:quantity|qty)\b.*(?:unknown|undecided|not sure|[=-]\s*-\d)|\b(?:forget|remove)\b.*\b(?:quantity|qty)\b/i.test(text)) quantity = null;
    else if (hadGoods && quantity === null && budget !== null && Number.isSafeInteger(bareValue) && bareValue >= 1 && bareValue <= 500) quantity = bareValue;
    if (budgets.length) {
      const priority = Math.max(...budgets.map((item) => item.priority));
      budget = selectCandidate(budgets.filter((item) => item.priority === priority), text);
    } else if (BUDGET_WORD.test(text) && /(?:\$|\bUSD)\s*-|\b(?:unknown|undecided|no budget|not sure)\b/i.test(text)) budget = null;
    else if (hadGoods && budget === null && quantity !== null && !quantities.length && Number.isFinite(bareValue) && bareValue >= 1) budget = Math.round(bareValue * 100);
    hadGoods ||= GOODS.test(text);
  }
  return field === 'quantity' ? quantity : budget;
}

/** Track the currency of the active buying budget, rather than any historical quote in the conversation. */
export function goalCurrencyContext(turns) {
  let active = { currency: 'USD', explicit: false };
  for (const text of turns) {
    const candidates = budgetCandidates(text);
    if (candidates.length) {
      const priority = Math.max(...candidates.map((candidate) => candidate.priority));
      const relevant = candidates.filter((candidate) => candidate.priority === priority), value = selectCandidate(relevant, text);
      const matching = relevant.filter((candidate) => candidate.value === value).map((candidate) => {
        if (candidate.currency) return candidate;
        const before = text.slice(Math.max(0, candidate.index - 20), candidate.index), after = text.slice(candidate.end, candidate.end + 20);
        const unit = /\b([a-z]{3})\s*$/i.exec(before)?.[1] ?? /^\s*([a-z]{3})\b/i.exec(after)?.[1];
        return unit && !NON_CURRENCY_WORDS.has(unit.toLowerCase()) ? { ...candidate, currency: unit.toUpperCase(), explicitCurrency: true } : candidate;
      }).filter((candidate) => candidate.currency);
      const currencies = [...new Set(matching.map((candidate) => candidate.currency))];
      // Equally relevant candidates with different units are unresolved even when their nominal amounts match.
      // A correction word about another field is never currency authority; ask for one final USD budget instead.
      if (currencies.length > 1) { active = { currency: 'conflict', explicit: false }; continue; }
      const chosen = matching.at(-1);
      if (chosen) active = { currency: chosen.currency, explicit: chosen.explicitCurrency || active.currency === chosen.currency && active.explicit };
    } else if (isBudgetUpdate(text) && lastMatch(HISTORIC, text) < 0) {
      const mentions = [...text.matchAll(/\b(?:USD|EUR|GBP|CAD|AUD|JPY|U\.?S\.? dollars?|Canadian dollars?|Australian dollars?|euros?|pounds?|yen)\b/gi),
        ...[...text.matchAll(/\b([a-z]{3})(?=\s*\d)/gi)].filter((match) => !['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY'].includes(match[0].toUpperCase()) && !NON_CURRENCY_WORDS.has(match[0].toLowerCase()))];
      if (mentions.length === 1) active = currencyUnit(mentions[0][0]);
    }
  }
  return active;
}

function isBudgetUpdate(text) {
  if (retainedClause(text)) return false;
  const hasMoney = MONEY_UNIT.test(text) || /[€£¥]/.test(text);
  const strongRole = BUDGET_WORD.test(text) || /\b(?:ceiling|remaining|remainder|leaving|left for|not exceed|allocate(?:d)?)\b/i.test(text), historic = lastMatch(HISTORIC, text);
  return budgetCandidates(text).length > 0 || strongRole && (numberMatches(text).length > 0 || hasMoney || CORRECTION.test(text)) ||
    hasMoney && historic < 0 && (CORRECTION.test(text) || !/\b(?:quote|vendor|supplier|invoice)\b/i.test(text));
}

const SPEC_FEATURE = /\b(?:print(?:ing)?|artwork|quality|material|fabric|cotton|polyester|canvas|white|black|blue|navy|red|green|color|colour|logo|design|embroid\w*)\b/i;
const MONTH_NAMES = `${MONTHS.join('|')}|${MONTHS.map((month) => month.slice(0, 3)).join('|')}`;
const ORDINAL_PATTERN = ORDINALS.slice(1).map((word) => word.replace('-', '[ -]')).join('|');
const DATE_ANCHOR = new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}(?=T|\\b)|\\b(?:${MONTH_NAMES})\\.?\\s+(?:the\\s+)?(?:\\d{1,2}|${ORDINAL_PATTERN})\\b|\\b(?:\\d{1,2}(?:st|nd|rd|th)?|${ORDINAL_PATTERN})(?:\\s+of)?\\s+(?:${MONTH_NAMES})\\b|\\b(?:${DAYS.join('|')}|today|tomorrow|next week)\\b`, 'i');
const CLOCK_ANCHOR = /\d{1,2}:\d{2}|\b(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:a\.?m\.?|p\.?m\.?)\b|\b(?:noon|midnight)\b/i;
const ZONE_ANCHOR = /[+-]\d{2}:\d{2}|\b(?:UTC|GMT|Pacific|PST|PDT|Eastern|EST|EDT|Central|CST|CDT|Mountain|MST|MDT|IST|Tokyo|London|New York|Los Angeles)\b|\b[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/i;

function specificationUpdate(text, previous) {
  if (retainedClause(text)) {
    // Generic preservation language is not an edit. A newly named concrete feature still is.
    const features = [...text.matchAll(/\b(?:white|black|blue|navy|red|green|cotton|polyester|canvas|embroid\w*|print(?:ed|ing)?)\b/gi)];
    return features.some(([feature]) => {
      const pattern = /^embroid/i.test(feature) ? '\\bembroid\\w*\\b' : /^print/i.test(feature) ? '\\bprint(?:ed|ing)?\\b' : `\\b${feature}\\b`;
      return !new RegExp(pattern, 'i').test(previous);
    });
  }
  if (SPEC_FEATURE.test(text) && (CORRECTION.test(text) || /\b(?:use|with|want|need|require|must|no|not|without|avoid|exclude)\b/i.test(text))) return true;
  if (!CORRECTION.test(text)) return false;
  const items = [...text.matchAll(new RegExp(`\\b${ITEM_WORDS}\\b`, 'gi'))].map((match) => match[0].toLowerCase());
  return items.some((item) => !new RegExp(`\\b${item}\\b`, 'i').test(previous));
}

function containsPositivePhrase(text, phrase) {
  let cursor = 0;
  const lower = text.toLowerCase(), needle = phrase.toLowerCase();
  while ((cursor = lower.indexOf(needle, cursor)) !== -1) {
    const before = lower.slice(Math.max(0, cursor - 35), cursor);
    if (!/\b(?:no|not|without|avoid|exclude|instead of|rather than|do not use|don't use)\s+(?:the\s+)?$/.test(before)) return true;
    cursor += needle.length;
  }
  return false;
}

/** Require current proof for every recognized updated field; unknown associations remain review-only clarification. */
export function latestSourceIssues(evidence, turns, specification, localDelivery = null) {
  const latest = {}, missing = [];
  let previous = '';
  for (const [index, text] of turns.entries()) {
    const clauses = intentClauses(text), before = turns.slice(0, index), through = turns.slice(0, index + 1);
    const quantityChanged = latestFieldValue(before, 'quantity') !== latestFieldValue(through, 'quantity');
    const budgetChanged = latestFieldValue(before, 'budget') !== latestFieldValue(through, 'budget');
    if (quantityCandidates(text, true).length && (index === 0 || quantityChanged) || clauses.some((clause) => !retainedClause(clause) && /\b(?:change|replace|revise|update|adjust)\b/i.test(clause) && /\b(?:quantity|qty|count)\b/i.test(clause) && !quantityCandidates(clause, true).length)) latest.quantity = index;
    if (clauses.some(isBudgetUpdate) && (index === 0 || budgetChanged || !budgetCandidates(text).length)) latest.budget = index;
    for (const clause of clauses) {
      const deliveryChange = !retainedClause(clause) && CORRECTION.test(clause) && /\b(?:deliver|delivery|deadline)\b/i.test(clause);
      if (DATE_ANCHOR.test(clause) || deliveryChange && /\bdate\b/i.test(clause) || deliveryChange && !CLOCK_ANCHOR.test(clause) && !ZONE_ANCHOR.test(clause) && !/\b(?:same|keep|unchanged)\b/i.test(clause)) latest.delivery_date = index;
      if (CLOCK_ANCHOR.test(clause) || deliveryChange && /\btime\b/i.test(clause) && !/\btime\s*zone\b/i.test(clause)) latest.delivery_time = index;
      if (ZONE_ANCHOR.test(clause) || deliveryChange && /\b(?:timezone|time zone|zone|offset)\b/i.test(clause)) latest.time_zone = index;
    }
    if (index === 0 && GOODS.test(text) || clauses.some((clause) => specificationUpdate(clause, previous))) latest.specification = index;
    previous += '\n' + text;
  }
  const sourceField = { quantity: 'quantity', budget: 'budget', specification: 'specification', delivery_date: 'delivery', delivery_time: 'delivery', time_zone: 'delivery' };
  const proofChecks = { quantity: (text) => quantityCandidates(text, true).length > 0 || /^\s*\d+\s*$/.test(text),
    budget: (text) => budgetCandidates(text).length > 0 || /^\s*\d+(?:\.\d{1,2})?\s*$/.test(text),
    specification: (text) => SPEC_FEATURE.test(text) || new RegExp(`\\b${ITEM_WORDS}\\b`, 'i').test(text),
    delivery_date: (text) => DATE_ANCHOR.test(text), delivery_time: (text) => CLOCK_ANCHOR.test(text), time_zone: (text) => ZONE_ANCHOR.test(text) };
  for (const [field, index] of Object.entries(latest)) {
    const clauses = String(evidence[sourceField[field]] ?? '').split('\n').filter(Boolean);
    if (!clauses.some((clause) => turns[index].includes(clause) && proofChecks[field](clause))) missing.push(field);
  }
  if (localDelivery && latest.delivery_time !== undefined && !clockIsGrounded(localDelivery.time, turns[latest.delivery_time])) missing.push('delivery_time');
  const lastSpec = latest.specification;
  if (lastSpec !== undefined) {
    const featureWords = '(?:white|black|blue|navy|red|green|cotton|polyester|canvas|screen|printed|embroidery|print|artwork|quality|logo|design|material|fabric|shirts?|mugs?)';
    const removed = new RegExp(`\\b(?:instead of|rather than|without|no|not|avoid|exclude|do not use|don't use)\\s+(?:the\\s+)?(${featureWords}(?:\\s+${featureWords}){0,4})`, 'gi');
    for (const match of turns[lastSpec].matchAll(removed)) if (containsPositivePhrase(specification, match[1])) missing.push('specification');
  }
  return { missingFields: [...new Set(missing)], currency: goalCurrencyContext(turns) };
}

export function quantityIsGrounded(value, evidence, turns = [evidence]) {
  if (!Number.isSafeInteger(value) || !evidence || latestFieldValue(turns, 'quantity') !== value) return false;
  const cited = quantityCandidates(evidence, turns.some((turn) => quantityCandidates(turn).length));
  return cited.some((candidate) => candidate.value === value) || /^\s*[\d,]+\s*$/.test(evidence) && numberWords(evidence) === value;
}

export function budgetIsGrounded(cents, evidence, turns = [evidence]) {
  if (!Number.isSafeInteger(cents) || !evidence || /[€£¥]|\b(?:EUR|GBP|CAD|AUD|JPY|euros?|pounds?|yen|Canadian dollars|Australian dollars)\b/i.test(evidence) || /(?:\$|\bUSD)\s*-|(?:^|\s)-\d/.test(evidence)) return false;
  return goalCurrencyContext(turns).currency === 'USD' && latestFieldValue(turns, 'budget') === cents && (budgetCandidates(evidence).some((candidate) => candidate.value === cents) || /^\s*[\d,]+(?:\.\d{1,2})?\s*$/.test(evidence) && Math.round(numberWords(evidence) * 100) === cents);
}

/** Bounded buyer-policy grammar with exact source provenance; later explicit turns replace earlier policy. */
export function splitPolicy(turns) {
  let result = { permission: 'unspecified', source: '', turnIndex: null };
  const party = '(?:suppliers?|vendors?)', many = `(?:multiple|several|more than one|two or more) ${party}`;
  const distributed = '(?:shared|divided|distributed|share|divide|distribute)', distributionTarget = `(?:among|across|between)\\s+(?:(?:multiple|several|two or more)\\s+)?${party}`;
  const negatives = [
    /\b(?:do not|don't|dont|never|no|may not|must not|will not|cannot|can't|can not|could not|would not|should not)\s+(?:\w+\s+){0,3}split(?:ting|s)?\b/gi,
    new RegExp(`\\b(?:no more than|not more than|at most) one ${party}\\b`, 'gi'),
    new RegExp(`\\b(?:no|not|never)\\s+(?:${many}|across ${party})\\b`, 'gi'),
    new RegExp(`\\b(?:not|don't|dont|cannot|can't|can not|may not|must not)\\s+(?:allow(?:ing)?|permit(?:ting)?|approv(?:e|ing)|use)(?:\\s+\\w+){0,4}\\s+(?:split(?:ting|s)?|${many}|across ${party})\\b`, 'gi'),
    new RegExp(`\\b(?:split(?:ting|s)?|${many})(?:\\s+\\w+){0,2}\\s+(?:is |are )?(?:not allowed|not permitted|forbidden)\\b`, 'gi'),
    new RegExp(`\\b(?:do not|don't|dont|never|no|may not|must not|will not|cannot|can't|can not|could not|would not|should not|not)\\s+(?:\\w+\\s+){0,6}${distributed}\\s+${distributionTarget}\\b`, 'gi'),
  ];
  const positives = [
    /\b(?:may|can|allow|permit)\s+(?:\w+\s+){0,2}split(?:ting)?\b/gi,
    /\bsplit(?:ting)?(?:\s+\w+){0,3}\s+(?:allowed|okay|ok|fine|permitted)\b/gi,
    new RegExp(`\\b(?:allow|permit|use|can use|may use)(?:\\s+\\w+){0,2}\\s+(?:${many}|across ${party})\\b`, 'gi'),
    new RegExp(`\\b(?:${many}|across ${party})(?:\\s+\\w+){0,2}\\s+(?:allowed|okay|ok|fine|permitted)\\b`, 'gi'),
    new RegExp(`\\b(?:may|can|allow|permit)\\s+(?:\\w+\\s+){0,2}${distributed}\\s+${distributionTarget}\\b`, 'gi'),
  ];
  for (const [turnIndex, turn] of turns.entries()) {
    const raw = String(turn), text = raw.replaceAll('’', "'"), signals = [];
    let cursor = 0;
    for (const clause of text.split(/(?:[.!?;\n]+|\bbut\b)/i)) {
      const start = text.indexOf(clause, cursor); cursor = start + clause.length;
      const source = raw.slice(start, cursor).trim();
      const conditional = /\b(?:if|when|unless|provided|assuming)\b|\b(?:after|before|until)(?:\s+[a-z'-]+){0,4}\s+(?:approv(?:al|e[ds]?)|confirm(?:ation|ed|s)?|consent(?:s|ed)?)\b/i.test(clause);
      if (conditional && new RegExp(`\\bsplit(?:ting|s)?\\b|\\b${party}\\b`, 'i').test(clause)) {
        signals.push({ permission: 'conflict', source, index: start, end: cursor, clauseStart: start }); continue;
      }
      const denied = negatives.flatMap((pattern) => [...clause.matchAll(pattern)].map((match) => ({ index: match.index, end: match.index + match[0].length })));
      for (const match of clause.matchAll(new RegExp(`\\b(?:one|single) (?:supplier|vendor)\\b`, 'gi'))) {
        if (!/\b(?:more than|at least|not|not only)\s*$/i.test(clause.slice(0, match.index))) denied.push({ index: match.index, end: match.index + match[0].length });
      }
      const allowed = positives.flatMap((pattern) => [...clause.matchAll(pattern)].map((match) => ({ index: match.index, end: match.index + match[0].length })))
        .filter((match) => !denied.some((deny) => match.index < deny.end && deny.index < match.end));
      for (const [permission, matches] of [['deny', denied], ['allow', allowed]]) for (const match of matches) {
        signals.push({ permission, source, index: start + match.index, end: start + match.end, clauseStart: start });
      }
    }
    if (!signals.length) continue;
    signals.sort((first, second) => first.index - second.index || first.end - second.end);
    const last = signals.at(-1), previous = signals.slice(0, -1).findLast((signal) => signal.permission !== last.permission);
    const corrected = /\b(?:actually|instead|rather|make that|change|correct|correction|final|now)\b[^.!?;]{0,60}$/i.test(text.slice(last.clauseStart, last.index));
    const permission = signals.some((signal) => signal.permission === 'conflict') || previous && !corrected ? 'conflict' : last.permission;
    result = { permission, source: permission === 'conflict' || last.source.length > 500 ? '' : last.source, turnIndex };
  }
  return result;
}

export function splitPermission(turns) {
  return splitPolicy(turns).permission;
}

export function sourceClauses(value, turns) {
  if (typeof value !== 'string' || value.length > 500) return null;
  if (!value) return [];
  const clauses = value.split('\n').map((part) => part.trim());
  return clauses.length <= 4 && clauses.every((part) => part && turns.some((turn) => turn.includes(part))) ? clauses : null;
}

function localComponents(date, time) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? ''), t = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(time ?? '');
  if (!d || !t || +d[1] < 1000 || +t[1] > 23 || +t[2] > 59 || +(t[3] ?? 0) > 59) return null;
  const values = [+d[1], +d[2], +d[3], +t[1], +t[2], +(t[3] ?? 0), +(t[4] ?? '').padEnd(3, '0')];
  const wall = Date.UTC(values[0], values[1] - 1, values[2], values[3], values[4], values[5], values[6]);
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 10) !== date) return null;
  return { values, wall };
}

export function parseOffset(offset) {
  if (offset === 'Z') return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset ?? '');
  if (!match || +match[2] > 14 || +match[3] > 59 || +match[2] === 14 && +match[3] !== 0) return null;
  return (match[1] === '-' ? -1 : 1) * (+match[2] * 60 + +match[3]);
}

export function strictIsoInstant(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(Z|[+-]\d{2}:\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const local = localComponents(match[1], match[2]), offset = parseOffset(match[3]);
  return local && offset !== null ? new Date(local.wall - offset * 60000).toISOString() : null;
}

function formatter(timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' });
}

function parts(at, format) {
  return Object.fromEntries(format.formatToParts(new Date(at)).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

export function canonicalZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim() || timeZone.length > 80) return null;
  try { return formatter(timeZone).resolvedOptions().timeZone; } catch { return null; }
}

/** Enumerate possible instants; never silently choose one occurrence of a daylight-saving fold. */
export function resolveLocalDelivery({ date, time, timeZone, offset = '' } = {}) {
  const local = localComponents(date, time), zone = canonicalZone(timeZone);
  if (!local || !zone || offset !== '' && parseOffset(offset) === null) return { status: 'invalid', candidates: [] };
  const format = formatter(zone), candidates = [];
  // Modern IANA offsets are multiples of15minutes; this date-bounded buying desk never resolves historical dates.
  for (let minutes = -14 * 60; minutes <= 14 * 60; minutes += 15) {
    const at = local.wall - minutes * 60000, p = parts(at, format), v = local.values;
    if (p.year === v[0] && p.month === v[1] && p.day === v[2] && p.hour === v[3] && p.minute === v[4] && p.second === v[5]) candidates.push(new Date(at).toISOString());
  }
  candidates.sort();
  if (!candidates.length) return { status: 'gap', candidates };
  if (offset) {
    const selected = new Date(local.wall - parseOffset(offset) * 60000).toISOString();
    return candidates.includes(selected) ? { status: 'ok', instant: selected, candidates } : { status: 'invalid', candidates };
  }
  return candidates.length === 1 ? { status: 'ok', instant: candidates[0], candidates } : { status: 'fold', candidates };
}

function namedZones(text) {
  const found = [];
  const zoneText = text.replace(/\b(?:UTC|GMT)[+-]\d{2}:\d{2}\b/gi, '');
  for (const [alias, zone] of Object.entries(ZONES)) if (new RegExp(`\\b${alias}\\b`, 'i').test(zoneText)) found.push(zone);
  for (const match of text.matchAll(/\b[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/g)) {
    const zone = canonicalZone(match[0]); if (zone) found.push(zone);
  }
  return [...new Set(found.map(canonicalZone).filter(Boolean))];
}

function clockIsGrounded(time, text) {
  const expected = localComponents('2030-01-01', time)?.values;
  if (!expected) return false;
  const candidates = [], protectedSpans = [];
  const negated = (index) => /\b(?:not|never|no|instead of|rather than|not before|do not use|don't use)(?:\s+at)?\s*$/.test(text.slice(Math.max(0, index - 35), index).toLowerCase());
  const add = (index, hour, minute = 0, second = 0, ms = 0) => {
    if (!negated(index) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59) candidates.push(`${hour}:${minute}:${second}:${ms}`);
  };
  for (const match of text.matchAll(/\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?/g)) {
    protectedSpans.push([match.index, match.index + match[0].length]);
    add(match.index, +match[1], +match[2], +(match[3] ?? 0), +(match[4] ?? '').padEnd(3, '0'));
  }
  for (const match of text.matchAll(/[+-]\d{2}:\d{2}\b/g)) protectedSpans.push([match.index, match.index + match[0].length]);
  for (const match of text.matchAll(/\b(?:noon|midnight)\b/gi)) add(match.index, /^noon$/i.test(match[0]) ? 12 : 0);
  const pattern = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?\s*(a\.?m\.?|p\.?m\.?)?\b/gi;
  for (const match of text.matchAll(pattern)) {
    if (!match[2] && !match[5] || protectedSpans.some(([start, end]) => match.index >= start && match.index < end)) continue;
    let hour = numberWords(match[1]);
    if (match[5]) { if (hour < 1 || hour > 12) continue; hour = hour % 12 + (/^p/i.test(match[5]) ? 12 : 0); }
    add(match.index, hour, +(match[2] ?? 0), +(match[3] ?? 0), +(match[4] ?? '').padEnd(3, '0'));
  }
  const unique = [...new Set(candidates)];
  return unique.length === 1 && unique[0] === `${expected[3]}:${expected[4]}:${expected[5]}:${expected[6]}`;
}

function dateIsGrounded(date, text, now, zone) {
  const local = localComponents(date, '00:00'); if (!local) return false;
  const numeric = [...new Set([...text.matchAll(/\b\d{4}-\d{2}-\d{2}(?=T|\b)/g)].map((match) => match[0]))];
  if (numeric.length && (numeric.length !== 1 || numeric[0] !== date)) return false;
  const named = [];
  for (const [index, month] of MONTHS.entries()) {
    const name = `${month}|${month.slice(0, 3)}`;
    const monthFirst = new RegExp(`\\b(?:${name})\\.?\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?\\b`, 'gi');
    const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(?:${name})(?:\\s*,?\\s*(\\d{4}))?\\b`, 'gi');
    for (const pattern of [monthFirst, dayFirst]) for (const match of text.matchAll(pattern)) named.push({ month: index + 1, day: +match[1], year: match[2] ? +match[2] : null });
    for (let day = 1; day <= 31; day += 1) {
      const ordinal = ORDINALS[day].replace('-', '[ -]');
      const pattern = new RegExp(`\\b${ordinal}(?:\\s+of)?\\s+(?:${name})(?:\\s*,?\\s*(\\d{4}))?\\b|\\b(?:${name})\\s+(?:the\\s+)?${ordinal}(?:\\s*,?\\s*(\\d{4}))?\\b`, 'gi');
      for (const match of text.matchAll(pattern)) named.push({ month: index + 1, day, year: match[1] || match[2] ? +(match[1] ?? match[2]) : null });
    }
  }
  if (named.some((part) => part.month !== local.values[1] || part.day !== local.values[2] || part.year !== null && part.year !== local.values[0])) return false;
  const absolute = numeric.length > 0 || named.length > 0;
  const today = parts(now, formatter(zone)), todayAt = Date.UTC(today.year, today.month - 1, today.day), delta = (local.wall - todayAt) / 86400000;
  const tomorrow = /\btomorrow\b/i.test(text), sameDay = /\btoday\b/i.test(text);
  if (tomorrow && sameDay || tomorrow && delta !== 1 || sameDay && delta !== 0) return false;
  const weekdayPattern = new RegExp(`\\b(?:(this|next|coming|upcoming)\\s+)?(${DAYS.join('|')})\\b`, 'gi');
  const weekdays = [...text.matchAll(weekdayPattern)];
  const day = new Date(local.wall).getUTCDay(), currentDay = new Date(todayAt).getUTCDay();
  // Shared app convention: this weekday uses the current Monday-based week;
  // weekday next week uses the following week; next weekday otherwise means nearest upcoming.
  for (const match of weekdays) {
    const target = DAYS.indexOf(match[2].toLowerCase()), modifier = match[1]?.toLowerCase();
    if (day !== target) return false;
    const inCurrentWeek = (target + 6) % 7 - (currentDay + 6) % 7;
    if (modifier === 'this' && delta !== inCurrentWeek) return false;
    else if (/\bnext week\b/i.test(text)) {
      if (delta !== inCurrentWeek + 7) return false;
    } else if (!absolute && modifier !== 'this') {
      const nearest = (target - currentDay + 7) % 7;
      if (modifier === 'next' && nearest === 0 ? delta !== 7 : delta !== nearest && !(nearest === 0 && delta === 7)) return false;
    }
  }
  return absolute || weekdays.length > 0 || tomorrow || sameDay;
}

export function groundedDelivery(local, deadline, evidence, { now, timeZone }) {
  const text = evidence.join('\n'), iso = strictIsoInstant(deadline);
  if (!iso) return { status: 'invalid', field: 'delivery_date' };
  const named = namedZones(text), zone = canonicalZone(local.timeZone);
  const explicitIana = [...text.matchAll(/\b[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/g)].some((match) => canonicalZone(match[0]));
  if (/\b(?:CST|IST|CET|CEST|BST|JST|AEST|AEDT|NZST|NZDT|NST|NDT|HST|AKST|AKDT)\b/i.test(text) && !explicitIana && !/(?:[+-]\d{2}:\d{2}|\b(?:UTC|GMT)\b)/i.test(text)) return { status: 'invalid', field: 'time_zone' };
  const numericOffsets = [...text.matchAll(/[+-]\d{2}:\d{2}\b/g)].map((match) => match[0]);
  const abbreviationText = text.replace(/\b(?:UTC|GMT)(?=[+-]\d{2}:\d{2})/gi, '');
  const abbreviationOffsets = Object.entries(ZONE_OFFSETS).filter(([alias]) => alias !== 'CST' && new RegExp(`\\b${alias}\\b`, 'i').test(abbreviationText)).map(([, offset]) => offset);
  const literalZulu = [...text.matchAll(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z\b/g)].length ? ['Z'] : [];
  const offsets = [...numericOffsets, ...abbreviationOffsets, ...literalZulu];
  if (offsets.some((offset) => parseOffset(offset) === null)) return { status: 'invalid', field: 'time_zone' };
  const sourceOffsets = [...new Map(offsets.map((offset) => [parseOffset(offset), offset])).values()];
  const first = /\b(?:first|earlier) (?:occurrence|instance)\b/i.test(text), second = /\b(?:second|later) (?:occurrence|instance)\b/i.test(text);
  if (sourceOffsets.length > 1 || first && second) return { status: 'invalid', field: 'time_zone' };
  if (local.offset && parseOffset(local.offset) === null) return { status: 'invalid', field: 'time_zone' };
  if (sourceOffsets.length && local.offset && parseOffset(sourceOffsets[0]) !== parseOffset(local.offset)) return { status: 'invalid', field: 'time_zone' };
  const literals = [...text.matchAll(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})\b/g)].map((match) => match[0]);
  // A single literal timestamp is authoritative on its own; contradictory source constraints are checked first.
  if (!named.length && !first && !second && literals.some((value) => strictIsoInstant(value) === iso)) return { status: 'ok', instant: iso };
  if (!named.length && sourceOffsets.length && !first && !second) {
    const offset = sourceOffsets[0], localNow = now + parseOffset(offset) * 60000;
    if (!dateIsGrounded(local.date, text, localNow, 'UTC')) return { status: 'invalid', field: 'delivery_date' };
    if (!clockIsGrounded(local.time, text)) return { status: 'invalid', field: 'delivery_time' };
    const selected = strictIsoInstant(`${local.date}T${local.time}${offset}`);
    return selected === iso ? { status: 'ok', instant: selected } : { status: 'invalid', field: 'delivery_time' };
  }
  if (!zone || named.length > 1 || zone !== (named[0] ?? canonicalZone(timeZone))) return { status: 'invalid', field: 'time_zone' };
  if (!dateIsGrounded(local.date, text, now, zone)) return { status: 'invalid', field: 'delivery_date' };
  if (!clockIsGrounded(local.time, text)) return { status: 'invalid', field: 'delivery_time' };
  const resolved = resolveLocalDelivery({ ...local, offset: '' });
  if (resolved.status === 'gap') return { status: 'gap', field: 'delivery_time' };
  if (!['ok', 'fold'].includes(resolved.status)) return { status: 'invalid', field: 'delivery_date' };
  const selectedByOffset = sourceOffsets.length ? resolveLocalDelivery({ ...local, offset: sourceOffsets[0] }) : null;
  if (selectedByOffset && selectedByOffset.status !== 'ok') return { status: 'invalid', field: 'time_zone' };
  const selectedByOccurrence = first ? resolved.candidates[0] : second ? resolved.candidates[1] : null;
  if (second && !selectedByOccurrence || selectedByOffset && selectedByOccurrence && selectedByOffset.instant !== selectedByOccurrence) return { status: 'invalid', field: 'time_zone' };
  const chosen = selectedByOffset?.instant ?? selectedByOccurrence ?? (resolved.status === 'ok' ? resolved.instant : null);
  if (!chosen) return { status: 'fold', field: 'time_zone' };
  if (local.offset) {
    const model = resolveLocalDelivery(local);
    if (model.status !== 'ok' || model.instant !== chosen) return { status: 'invalid', field: 'time_zone' };
  }
  return chosen === iso ? { status: 'ok', instant: chosen } : { status: 'invalid', field: 'delivery_time' };
}
