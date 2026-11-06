import { rulesRoute } from './router.js';

// These checks describe explicit requests and refusals. They never authorize a write or establish consent.
// Group the supported invoice/email combination and stop/cancel synonyms as one task each.
const FAMILIES = Object.freeze({ stop_gift: 'stop', cancel_now: 'stop', pause_gift: 'pause', resume_gift: 'resume',
  one_time_gift: 'invoice', other_email: 'invoice', hardship_cover: 'cover' });
const UNDECIDED = /\b(?:haven't|have not|not yet|not)\s+(?:decided|chosen)(?:\s+yet)?\s+(?:whether|if|between|to)\b|\b(?:still deciding|still choosing|undecided|torn)\s+(?:whether|if|between|to)\b|\b(?:not sure|unsure|uncertain|don't know|do not know)\s+(?:whether|if|between|which)\b/;
const DECLINED = /^(?:please\s+)?(?:i\s+)?(?:(?:do not|don't|dont|no|never|not|would not|wouldn't|will not|won't|cannot|can't)\b|(?:would like|want|wish|prefer|choose|would rather)\s+not\b|(?:(?:have|had)\s+)?(?:already\s+)?(?:declined|refused|rejected|ruled out)\b)/;
const DECLINED_OUTCOME = /\b(?:is not|isn't|was not|wasn't)\s+(?:acceptable|an option|wanted|what i want)\b|\b(?:will not|won't|would not|wouldn't)\s+(?:do|work)\b/;
const NEGATED_REQUEST = /^(?:please\s+)?(?:i(?:'d)?\s+(?:(?:would\s+)?(?:like|want|wish|need|prefer)|would rather|choose|chose|decided|have (?:now )?(?:decided|chosen))\s+(?:you\s+(?:(?:would|should|will|could)\s+)?)?(?:to\s+)?(?:not|never)\b|(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:not|never)\b)/;
const NEW_REQUEST = /^(?:please|just|now)\b|^i\s+(?:want|wish|need|would like|would prefer|prefer|have (?:now )?(?:decided|chosen)|choose|chose|decided)\b|^i'd like\b|^(?:can|could|would|will) you\b/;
const IMPERATIVE = /^(?:stop|cancel|pause|skip|suspend|restart|resume|unpause|reactivate|send|give|donate|make|create|use|put|turn|start|finish|end|terminate|discontinue|unsubscribe|get|cover)\b/;
const CHOSEN = /^i\s+(?:have (?:now )?(?:decided|chosen)|choose|chose|decided)\b/;
const READS = new Set(['gift_status', 'how_do_you_know', 'repeat', 'help', 'goodbye', 'staff_callback', 'charge_check']);
// "Also" may modify a request ("I also want"), rather than separate two clauses.
const requestText = (text) => text.replace(/\balso\b/g, '').replace(/\s+/g, ' ').trim();
const isNewRequest = (text) => NEW_REQUEST.test(requestText(text));
const isDeclined = (text) => DECLINED.test(requestText(text)) || NEGATED_REQUEST.test(requestText(text)) || DECLINED_OUTCOME.test(text);
const isRequested = (text) => isNewRequest(text) || IMPERATIVE.test(requestText(text));
const nominalTask = (text) => /^(?:a|an|the|my|another|one|some)\b|^\$?\d/.test(text) && !/\b(?:is|are|was|were|had|has|used to)\b/.test(text);
function splitTasks(text) {
  const tasks = [];
  let start = 0, boundary = '';
  for (const match of text.matchAll(/[,;.!?]+|\b(?:and|also|then|but|actually)\b/g)) {
    const part = text.slice(start, match.index).trim();
    if (match[0] === 'also' && /^(?:please|i(?:'d)?(?: would| will)?|(?:can|could|would|will) you)$/.test(part)) continue;
    if (part) tasks.push({ text: part, boundary });
    start = match.index + match[0].length;
    boundary = match[0];
  }
  if (text.slice(start).trim()) tasks.push({ text: text.slice(start).trim(), boundary });
  return tasks;
}

function familyFor(text) {
  const intent = rulesRoute(text).intent;
  // A hardship reason accompanying an explicit request is not a second request for sponsor coverage.
  if (intent === 'hardship_cover' && !/\b(?:cover|sponsor|give (?:this|the) month back)\b/.test(text)) return null;
  if (!FAMILIES[intent] && isRequested(text) && /\b(?:gift|donation|pledge|subscription)\b/.test(text) &&
    /\b(?:running|active|going|on) again\b|\bback (?:on|up)\b|\b(?:reactivated|resumed|restarted|unpaused)\b/.test(text)) return 'resume';
  if (!FAMILIES[intent] && isDeclined(text) && /\b(?:pause|break|hold)\b/.test(text)) return 'pause';
  return FAMILIES[intent] ?? null;
}

function alternativeFamilies(text) {
  return new Set(text.split(/\bor\b|\bversus\b|\bagainst\b/).map(familyFor).filter(Boolean));
}

function inspect(text) {
  const requested = new Set();
  const declined = new Set();
  let unresolved = false;
  let declinedScope = false;
  let requestedScope = false;
  let reasonScope = false;
  let hasAffirmativeRequest = false;
  for (const { text: original, boundary } of splitTasks(text)) {
    let task = original;
    const coordinated = /^(?:,+|and|also|then)$/.test(boundary);
    if (!coordinated || isNewRequest(task)) { declinedScope = false; requestedScope = false; reasonScope = false; }
    const startsTask = isRequested(task) || (requestedScope && nominalTask(task) && familyFor(task));
    if (reasonScope && !startsTask) continue;
    if (startsTask) reasonScope = false;
    // Explanations can contain uncertainty about finances without making the requested action
    // uncertain. A later explicit request still starts its own task and is checked normally.
    if (requested.size > 0 && /^(?:because|since)\b/.test(task)) { reasonScope = true; continue; }
    const reason = /\b(?:because|since)\b/.exec(task);
    if (reason && isRequested(task.slice(0, reason.index).trim()) && familyFor(task.slice(0, reason.index).trim())) {
      task = task.slice(0, reason.index).trim();
      reasonScope = true;
    }
    // Bare coordinated verbs inherit a refusal. A new sentence or explicit positive request can end
    // that scope; comma-separated lists cannot turn a declined action into an affirmative request.
    if (isDeclined(task)) { declinedScope = true; requestedScope = false; }
    const alternatives = alternativeFamilies(task);
    const uncertain = UNDECIDED.test(task) || (!declinedScope && alternatives.size > 1);
    if (uncertain) unresolved = true;
    if (uncertain && !declinedScope) continue;
    const positive = !declinedScope && (isRequested(task) || (requestedScope && nominalTask(task)));
    // Historical consideration and a refused option are mentions, not additional current requests.
    // Only a request/choice clause contributes a positive mutation family. Read questions can still
    // reach the classifier after a refusal, without turning them into permission for a mutation.
    if (!declinedScope && READS.has(rulesRoute(task).intent)) hasAffirmativeRequest = true;
    if (positive) {
      requestedScope = true;
      hasAffirmativeRequest = true;
      if (CHOSEN.test(requestText(task)) && requested.size === 0) unresolved = false;
    }
    if (!declinedScope && !positive) continue;
    const target = declinedScope ? declined : requested;
    for (const family of alternatives) target.add(family);
  }
  return { requested, declined, unresolved, hasAffirmativeRequest };
}

export function assessIntentClarity(text) {
  const normalized = String(text ?? '').toLowerCase().replace(/[‘’]/g, "'").replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  let current = inspect(normalized);
  // A caller may describe earlier indecision and then make a clear current choice. A contrasting final
  // choice can resolve that comparison, but cannot silently discard two affirmative requested tasks.
  const contrast = /\b(?:but|actually)\b([^.!?]*)(?:[.!?]\s*)?$/.exec(normalized);
  if (contrast) {
    const previous = inspect(normalized.slice(0, contrast.index));
    const final = inspect(contrast[1].trim());
    if (previous.requested.size === 0 && (previous.unresolved || previous.declined.size > 0) &&
      !final.unresolved && final.requested.size === 1 && final.declined.size === 0) current = final;
  }
  return {
    needsClarification: current.unresolved || current.requested.size > 1 || (current.declined.size > 0 && current.requested.size === 0),
    declinedIntents: Object.keys(FAMILIES).filter((intent) => current.declined.has(FAMILIES[intent])),
    requestedFamilies: [...current.requested],
    hasAffirmativeRequest: current.hasAffirmativeRequest,
  };
}
