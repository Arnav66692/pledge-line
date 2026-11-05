import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createCheckoutRecovery } from '../src/checkout-recovery.js';
import { listenWithRecovery, createServerShutdown, drainRuntimeServices } from '../src/server.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test('recovery starts only after a successful HTTP listen', async () => {
  const server = http.createServer((req, res) => res.end('ok'));
  let started = 0;
  const listening = listenWithRecovery({ server, host: '127.0.0.1', port: 0,
    recovery: { start() { assert.equal(server.listening, true); started += 1; } } });
  assert.equal(started, 0);
  try {
    assert.equal(await listening, server);
    assert.equal(started, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('a listen failure never starts recovery and removes its temporary listener', async () => {
  const server = new EventEmitter();
  const error = Object.assign(new Error('Synthetic occupied port'), { code: 'EADDRINUSE' });
  server.listen = () => queueMicrotask(() => server.emit('error', error));
  let started = 0;
  await assert.rejects(listenWithRecovery({ server, host: '127.0.0.1', port: 0,
    recovery: { start() { started += 1; } } }), (value) => value === error);
  assert.equal(started, 0);
  assert.equal(server.listenerCount('error'), 0);
});

test('idle shutdown closes HTTP, stops recovery and ends the pool exactly once', async () => {
  const calls = [];
  const server = { close(callback) { calls.push('close'); callback(); } };
  const stop = createServerShutdown({ server,
    recovery: { async stop() { calls.push('recovery-stop'); } },
    pool: { async end() { calls.push('pool-end'); } },
    beforeClose() { calls.push('before-close'); }, onComplete() { calls.push('complete'); } });
  const first = stop(), second = stop();
  assert.equal(first, second, 'Repeated SIGTERM/SIGINT share one drain.');
  await first;
  assert.deepEqual(calls, ['before-close', 'close', 'recovery-stop', 'pool-end', 'complete']);
  assert.equal(stop(), first);
});

test('shutdown aborts an active sweep and retains the database until work and HTTP fully drain', async () => {
  const entered = deferred(), finish = deferred(), closed = deferred();
  const calls = [];
  const recovery = createCheckoutRecovery({ enabled: true,
    listCandidates: async () => ({ ids: ['00000000-0000-0000-0000-000000000001'], nextCursor: null }),
    withLease: async ({ signal }, work) => { await work(signal); calls.push('lease-released'); return { acquired: true }; },
    reconcileExisting: async ({ signal }) => {
      signal.addEventListener('abort', () => { calls.push('read-aborted'); }, { once: true });
      entered.resolve();
      await finish.promise;
      calls.push('read-drained');
      signal.throwIfAborted();
    } });
  const sweep = recovery.sweepOnce();
  await entered.promise;
  const server = { close(callback) { calls.push('close'); void closed.promise.then(() => { calls.push('http-drained'); callback(); }); } };
  const stop = createServerShutdown({ server, recovery,
    pool: { async end() { calls.push('pool-end'); } }, onComplete() { calls.push('complete'); } });
  const stopping = stop();
  assert.equal(stop(), stopping);
  assert.ok(calls.includes('read-aborted'));
  assert.equal(calls.includes('pool-end'), false);
  finish.resolve();
  assert.equal((await sweep).aborted, true);
  assert.equal(calls.includes('pool-end'), false, 'HTTP is also allowed to finish before the pool closes.');
  closed.resolve();
  await stopping;
  assert.deepEqual(calls, ['close', 'read-aborted', 'read-drained', 'http-drained', 'pool-end', 'complete']);
  assert.equal(recovery.status().inFlight, false);
  assert.equal(recovery.status().running, false);
});

test('shutdown also supports the default runtime with no recovery controller or database', async () => {
  let completed = 0;
  const stop = createServerShutdown({ server: { close(callback) { callback(); } }, onComplete() { completed += 1; } });
  await stop(); await stop();
  assert.equal(completed, 1);
});

test('shutdown drains runtime-owned suppliers and audit state before closing the pool', async () => {
  const calls = [];
  const stop = createServerShutdown({ server: { close(callback) { calls.push('http-close'); callback(); } },
    beforePoolClose: async () => { calls.push('runtime-drain'); },
    pool: { async end() { calls.push('pool-close'); } } });
  await stop(); await stop();
  assert.deepEqual(calls, ['http-close', 'runtime-drain', 'pool-close']);
});

test('an audit flush rejection still closes private listeners and the pool while preserving the error', async () => {
  const calls = [], failure = new Error('AUDIT_FLUSH_FAILED');
  const stop = createServerShutdown({ server: { close(callback) { calls.push('http-close'); callback(); } },
    beforePoolClose: () => drainRuntimeServices({
      calls: { async flush() { calls.push('audit-flush'); throw failure; } },
      runtime: { async close() { calls.push('private-close'); } },
    }),
    pool: { async end() { calls.push('pool-close'); } }, onComplete() { calls.push('success'); } });
  const first = stop();
  assert.equal(stop(), first);
  await assert.rejects(first, (error) => error === failure);
  assert.deepEqual(calls, ['http-close', 'audit-flush', 'private-close', 'pool-close']);
});
