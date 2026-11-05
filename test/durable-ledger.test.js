import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDurableLedger } from '../src/durable-ledger.js';

function fakeStore() {
  let seq = 0;
  const events = new Map();
  const control = { fail: false };
  return { control, events,
    reserveEventSequences: async ({ count }) => Array.from({ length: count }, () => ++seq),
    appendEvents: async ({ events: batch }) => {
      if (control.fail) throw Error('private storage detail');
      for (const event of batch) {
        const previous = events.get(event.seq);
        if (previous) assert.deepEqual(previous, event);
        else events.set(event.seq, structuredClone(event));
      }
      return batch.length;
    },
    listEvents: async ({ afterSeq = 0, limit = 10000 } = {}) => [...events.values()].filter((event) => event.seq > afterSeq).sort((a, b) => a.seq - b.seq).slice(0, limit),
  };
}

test('durable ledger persists before success and hydrates exact sequence numbers across replacement', async () => {
  const store = fakeStore();
  const first = createDurableLedger({ store, now: () => new Date('2026-11-05T00:00:00Z'), blockSize: 8 });
  assert.throws(() => first.append({ type: 'heard' }), /DONOR_LEDGER_NOT_READY/);
  await first.ready();
  const event = first.append({ type: 'heard', callId: 'call-one', text: 'pause' });
  assert.equal(store.events.size, 0);
  assert.equal(Object.isFrozen(event), true);
  await first.flush();
  assert.equal(store.events.size, 1);
  const second = createDurableLedger({ store, blockSize: 8 });
  await second.ready();
  assert.deepEqual(second.byCall('call-one'), [event]);
  assert.deepEqual(second.byType('heard'), [event]);
  const next = second.append({ type: 'said', callId: 'call-one', text: 'fresh' });
  assert.ok(next.seq > event.seq);
  await second.flush();
  await first.reload();
  await first.ensureCapacity(1);
  const resumed = first.append({ type: 'heard', callId: 'call-one', text: 'resume' });
  assert.ok(resumed.seq > next.seq, 'a process cannot use its stale sequence block after another instance advanced the call');
  await first.flush();
  assert.deepEqual(first.all().map((item) => item.seq), [event.seq, next.seq, resumed.seq]);
});

test('a failed durable flush poisons dispatch instead of discarding events or falling back to a file', async () => {
  const store = fakeStore();
  const ledger = createDurableLedger({ store, blockSize: 4 });
  await ledger.ready();
  ledger.append({ type: 'yes', callId: 'call-one' });
  store.control.fail = true;
  await assert.rejects(ledger.flush(), /DONOR_LEDGER_UNAVAILABLE/);
  assert.throws(() => ledger.append({ type: 'write' }), /DONOR_LEDGER_UNAVAILABLE/);
  await assert.rejects(ledger.ensureCapacity(1), /DONOR_LEDGER_UNAVAILABLE/);
  assert.equal(store.events.size, 0);
  assert.equal(ledger.all().length, 1);
});

test('pending events are retained across concurrent flushes and snapshots cannot mutate the audit', async () => {
  const store = fakeStore();
  const ledger = createDurableLedger({ store, blockSize: 8 });
  await ledger.ready();
  const input = { type: 'read', callId: 'one', snapshot: { status: 'ACTIVE' } };
  ledger.append(input);
  input.snapshot.status = 'CANCELLED';
  const firstFlush = ledger.flush();
  ledger.append({ type: 'said', callId: 'two' });
  await Promise.all([firstFlush, ledger.flush()]);
  assert.equal(store.events.size, 2);
  assert.equal(ledger.byCall('one')[0].snapshot.status, 'ACTIVE');
  const view = ledger.all();
  view.length = 0;
  assert.equal(ledger.all().length, 2);
});

test('ledger capacity and persisted-conflict failures refuse work explicitly', async () => {
  const store = fakeStore();
  const ledger = createDurableLedger({ store, blockSize: 1 });
  await ledger.ready();
  const event = ledger.append({ type: 'heard', callId: 'one' });
  assert.throws(() => ledger.append({ type: 'said' }), /DONOR_LEDGER_CAPACITY/);
  await ledger.flush();
  store.events.set(event.seq, { ...event, text: 'tampered' });
  await assert.rejects(ledger.reload(), /DONOR_LEDGER_CONFLICT/);
});
