import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStack, verifiedCall, say, eventsOf } from './helpers.js';
import { assessIntentClarity } from '../src/intent-guards.js';
import { gradeCall } from '../src/check.js';

const broadCancellation = { route: async () => ({ intent: 'stop_gift', amountDollars: 0, empathy: 'none' }) };
for (const text of [
  "I don't want a pause; please cancel my monthly gift now.",
  'Cancel the gift. Another pause is not acceptable.',
  'A temporary break will not do. I already declined the pause; finish cancelling the monthly donation.',
]) test(`a broad cancellation label preserves the explicit pause refusal: ${text}`, async () => {
  const stack = buildStack({ router: broadCancellation });
  const id = await verifiedCall(stack);
  const offer = await say(stack, id, text);
  assert.equal(offer.state.pending.kind, 'cancel');
  assert.match(offer.reply, /Do you want me to cancel it\?/);
  assert.doesNotMatch(offer.reply, /Would you like me to pause/);
  assert.deepEqual(eventsOf(stack, id, 'write'), []);
  await say(stack, id, 'Yes, cancel it.');
  assert.deepEqual(eventsOf(stack, id, 'write').map((event) => [event.kind, event.ok]), [['cancel', true]]);
  const grade = gradeCall(stack.ledger.byCall(id), null);
  assert.deepEqual([...grade.facts, ...grade.writes, ...grade.safety], []);
});

test('ordinary cancellation still offers the existing pause option without a write', async () => {
  const stack = buildStack({ router: broadCancellation });
  const id = await verifiedCall(stack);
  const offer = await say(stack, id, 'Please cancel my monthly gift.');
  assert.equal(offer.state.pending.kind, 'suspend');
  assert.deepEqual(eventsOf(stack, id, 'write'), []);
});

test('a refusal, unresolved alternatives or a different positive task cannot select the cancellation exception', () => {
  for (const text of ["I don't want a pause.", "I don't want a pause or a cancellation.",
    "I don't want a pause. When is my next gift?", 'Should I pause or cancel?',
    "I don't want a pause. Please resume the gift.", "Don't pause or cancel it. Please check my gift."]) {
    const choice = assessIntentClarity(text);
    assert.equal(!choice.needsClarification && choice.declinedIntents.includes('pause_gift') &&
      choice.requestedFamilies.length === 1 && choice.requestedFamilies[0] === 'stop', false, text);
  }
});
