import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { databaseOptions } from '../src/database.js';
import { createPostgresStore } from '../src/storage/postgres-ledger.js';
import { createProcurementService } from '../src/procurement.js';

test('procurement dispatch awaits the hosted journal and preserves exact completed and unknown legs',
  { skip: !process.env.DATABASE_TEST_URL, timeout: 120000 }, async () => {
    const pool = new pg.Pool(databaseOptions(process.env.DATABASE_TEST_URL));
    const journal = createPostgresStore({ pool });
    const organizationId = `procurement-validation-${randomUUID()}`;
    const now = new Date();
    const rfq = { quantity: 100, budgetCents: 80000, currency: 'USD',
      specification: 'Synthetic test, identical white cotton shirts and one-color club logo',
      deadline: new Date(now.getTime() + 7 * 86400000).toISOString() };
    try {
      await journal.checkSchema();
      const service = createProcurementService({ journal, organizationId, now: () => now });
      const plan = await service.request(rfq);
      const approval = { confirmationToken: plan.proposal.confirmationToken, termsHash: plan.proposal.termsHash };
      const paid = await service.approve(plan.id, approval);
      assert.equal(paid.status, 'completed');
      const saved = await journal.getOperation({ organizationId, operationKey: `procurement:${plan.id}` });
      assert.equal(saved.state, 'confirmed');
      assert.equal(saved.legs.length, 2);
      assert.ok(saved.legs.every((leg) => leg.state === 'confirmed' && leg.attemptCount === 1 && leg.providerId));
      assert.equal(saved.legs.reduce((sum, leg) => sum + leg.amountCents, 0), plan.proposal.totalCents);
      await service.approve(plan.id, approval);
      const repeated = await journal.getOperation({ organizationId, operationKey: `procurement:${plan.id}` });
      assert.deepEqual(repeated.legs, saved.legs);

      const pending = await service.request({ ...rfq, scenario: 'pending-payment' });
      const uncertain = await service.approve(pending.id, { confirmationToken: pending.proposal.confirmationToken, termsHash: pending.proposal.termsHash });
      assert.equal(uncertain.status, 'uncertain');
      const unconfirmed = await journal.getOperation({ organizationId, operationKey: `procurement:${pending.id}` });
      assert.equal(unconfirmed.state, 'unknown');
      assert.equal(unconfirmed.legs.filter((leg) => leg.attemptCount === 1).length, 1);
      const unattempted = unconfirmed.legs.find((leg) => leg.state === 'reserved');
      const blocked = await journal.claimLeg({ organizationId, operationKey: `procurement:${pending.id}`, kind: unattempted.kind });
      assert.equal(blocked.claimed, false);
      // This staged supplier makes the original payment readable on the next check. Recovery keeps its identity
      // and then continues the still-approved second leg, rather than sending the first payment again.
      const recovered = await service.reconcile(pending.id);
      assert.equal(recovered.status, 'completed');
      const reconciled = await journal.getOperation({ organizationId, operationKey: `procurement:${pending.id}` });
      assert.equal(reconciled.state, 'confirmed');
      for (const leg of reconciled.legs) {
        assert.equal(leg.attemptCount, 1);
        assert.equal(leg.requestId, unconfirmed.legs.find((before) => before.kind === leg.kind).requestId);
      }
    } finally { await pool.end(); }
  });
