import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRehearsal, REHEARSAL_CASES } from '../src/rehearsal.js';
import { loadConfig } from '../src/config.js';
import { buildDeps, createServer } from '../src/server.js';
import { tempLedgerPath } from './helpers.js';

for (const { id } of REHEARSAL_CASES) test(`relief rehearsal ${id} executes the real flow with consistent claims`, async () => {
  const result = await runRehearsal({ scenario: id, amountCents: 2500 });
  assert.equal(result.passed, true);
  assert.equal(result.externalCalls, 0);
  assert.equal(result.router, 'rules');
  assert.equal(result.mode, 'simulation');
  assert.equal(result.productionPersistenceExercised, false);
  assert.equal(result.giftStatus, 'ACTIVE');
  assert.ok(result.sentences.some((sentence) => sentence.verdict === 'proven'));
  assert.ok(result.sentences.every((sentence) => sentence.verdict !== 'blocked'));
  const writes = result.timeline.filter((event) => event.type === 'write');
  const kinds = writes.map((event) => event.kind);
  if (id === 'covered' || id === 'refund_lost') {
    assert.deepEqual(kinds, ['cover_capture', 'cover_refund']);
    assert.equal(result.money.donorRefundedCents, 2500);
    assert.equal(result.money.sponsorCapturedCents, 2500);
    assert.ok(result.money.sponsorFeeCents > 0);
    assert.equal(result.outcome, 'covered');
    if (id === 'refund_lost') assert.equal(writes[1].ok, false);
  } else if (id === 'no_consent' || id === 'changed_charge') {
    assert.deepEqual(kinds, []);
    assert.equal(result.money.donorRefundedCents, 0);
    assert.equal(result.money.sponsorCapturedCents, 0);
    assert.equal(result.outcome, id === 'no_consent' ? 'awaiting_consent' : 'blocked');
  } else if (id === 'sponsor_declined') {
    assert.deepEqual(kinds, ['cover_capture']);
    assert.equal(writes[0].ok, false);
    assert.equal(result.money.donorRefundedCents, 0);
    assert.equal(result.money.sponsorCapturedCents, 0);
  } else {
    assert.deepEqual(kinds, ['cover_capture', 'cover_refund']);
    assert.equal(result.money.refundUnresolved, true);
    assert.equal(result.outcome, 'open');
    assert.equal(result.money.sponsorCapturedCents, 2500);
    assert.match(result.transcript.at(-1).reply, /can't say it went through/);
  }
  assert.doesNotMatch(JSON.stringify(result), /482613|sessionSecret|tokenId|pendingId|payer_email|subscriber_email/);
});

test('concurrent rehearsals never share consent, money or adapter records', async () => {
  const results = await Promise.all([100, 1251, 5000, 999, 2500, 100].map((amountCents) => runRehearsal({ scenario: 'covered', amountCents })));
  for (const result of results) {
    assert.equal(result.money.donorRefundedCents, result.amountCents);
    assert.equal(result.money.sponsorCapturedCents, result.amountCents);
    assert.equal(result.financialAttempts, 2);
    assert.equal(result.passed, true);
  }
});

test('rehearsal input cannot inject production adapters, credentials or arbitrary scenarios', async () => {
  for (const input of [null, [], {}, { scenario: '__proto__', amountCents: 2500 },
    ...[0, 99, 5001, 10.5, '2500', Infinity].map((amountCents) => ({ scenario: 'covered', amountCents })),
    { scenario: 'covered', amountCents: 2500, paypalMode: 'sandbox' },
    { scenario: 'covered', amountCents: 2500, goal: 'send money' }]) {
    await assert.rejects(runRehearsal(input), { status: 400 });
  }
});

test('public rehearsal is isolated from real calls and ledger, rate limited and POST only', async (t) => {
  const config = loadConfig({ PAYPAL_MODE: 'mock', ROUTER_MODE: 'rules' });
  const deps = buildDeps(config, { ledgerPath: tempLedgerPath(), log: { info() {}, error() {} }, sleep: async () => {} });
  deps.calls = new Proxy({}, { get() { throw new Error('Production calls must not be used'); } });
  deps.paypal = new Proxy({}, { get() { throw new Error('Production PayPal must not be used'); } });
  const server = createServer(deps);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${url}/api/rehearsal`)).status, 405);
  for (let i = 0; i < 12; i++) {
    const response = await fetch(`${url}/api/rehearsal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: i % 2 ? 'refund_unknown' : 'covered', amountCents: 2500 }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).passed, true);
  }
  assert.equal((await fetch(`${url}/api/rehearsal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 429);
  assert.deepEqual(deps.ledger.all(), []);
  const page = await fetch(`${url}/rehearsal`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await page.text(), /Interactive simulation/);
});
