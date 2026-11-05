import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { setupSupplierLab, startSupplierLab, checkSupplierLab, connectSupplierLab, configureLabMerchants } from '../scripts/setup-supplier-lab.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
async function directory(t) {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'pledge-controlled-lab-'));
  t.after(() => fs.rm(rootDirectory, { recursive: true, force: true }));
  return rootDirectory;
}
async function freePorts(count) {
  const servers = [], ports = [];
  for (let index = 0; index < count; index += 1) {
    const server = http.createServer(); servers.push(server);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    ports.push(server.address().port);
  }
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

test('setup creates private controlled placeholders without credentials in the registry and reruns preserve them', async (t) => {
  const rootDirectory = await directory(t);
  const setup = await setupSupplierLab({ rootDirectory, ports: await freePorts(2) });
  assert.equal(setup.supplierCount, 2);
  assert.equal(setup.merchantMode, 'placeholder');
  assert.equal(setup.paymentsDisabled, true);
  const registry = await fs.readFile(path.join(rootDirectory, '.suppliers.json'), 'utf8');
  const privateSettings = await fs.readFile(path.join(rootDirectory, '.suppliers.env'), 'utf8');
  const before = digest(privateSettings);
  const parsed = JSON.parse(registry);
  assert.ok(parsed.every((supplier) => supplier.token === undefined && /^MCP_[A-Z0-9_]+_TOKEN$/.test(supplier.tokenEnv)));
  assert.match(privateSettings, /PAYPAL_SANDBOX_CHECKOUT_WRITES=false/);
  assert.match(privateSettings, /LAB_MERCHANT_MODE=placeholder/);
  assert.equal((await fs.stat(path.join(rootDirectory, '.suppliers.env'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(rootDirectory, '.supplier-lab'))).mode & 0o777, 0o700);
  await setupSupplierLab({ rootDirectory });
  assert.ok(before === digest(await fs.readFile(path.join(rootDirectory, '.suppliers.env'))), 'idempotent setup keeps the existing private tokens');
});

test('setup refuses to overwrite an unrelated or changed registry and merchant reconfiguration archives verified prior config', async (t) => {
  const rootDirectory = await directory(t);
  const otherDirectory = await directory(t);
  await fs.writeFile(path.join(otherDirectory, '.suppliers.json'), '[{"id":"someone-else"}]');
  await assert.rejects(setupSupplierLab({ rootDirectory: otherDirectory }), /LAB_EXISTING_CONFIG_NOT_OWNED/);
  assert.equal(await fs.readFile(path.join(otherDirectory, '.suppliers.json'), 'utf8'), '[{"id":"someone-else"}]');
  await setupSupplierLab({ rootDirectory, ports: await freePorts(2) });
  const configured = await configureLabMerchants({ rootDirectory, merchantIds: ['MERCHANT00001', 'MERCHANT00002'] });
  assert.equal(configured.merchantMode, 'configured');
  assert.equal(configured.paymentsDisabled, true, 'merchant configuration does not enable capture');
  assert.ok((await fs.readdir(path.join(rootDirectory, '.supplier-lab', 'archive'))).length >= 2);
  const registryPath = path.join(rootDirectory, '.suppliers.json');
  const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  registry[0].endpoint = 'http://127.0.0.1:1/mcp';
  await fs.writeFile(registryPath, JSON.stringify(registry));
  await assert.rejects(setupSupplierLab({ rootDirectory }), /LAB_CONFIGURATION_CHANGED/);
});

test('two independent authenticated supplier processes produce the full allocation and preserve the same quote after restart', async (t) => {
  const rootDirectory = await directory(t);
  await setupSupplierLab({ rootDirectory, ports: await freePorts(2) });
  let lab = await startSupplierLab({ rootDirectory });
  t.after(async () => { await lab.stop(); });
  assert.equal(new Set(lab.pids).size, 2);
  const result = await checkSupplierLab({ rootDirectory });
  assert.equal(result.totalCents, 67415);
  assert.equal(result.quantity, 100);
  assert.equal(result.aiRequests, 0);
  assert.equal(result.financialWrites, 0);
  assert.equal(result.merchantMode, 'placeholder');
  const clients = await connectSupplierLab({ rootDirectory });
  const quote = result.quotes.find((item) => item.supplierId === clients[0].id);
  const original = await clients[0].getQuote(quote.quoteId);
  await assert.rejects(configureLabMerchants({ rootDirectory, merchantIds: ['MERCHANT00001', 'MERCHANT00002'] }), /LAB_ALREADY_RUNNING/);
  await lab.stop();
  lab = await startSupplierLab({ rootDirectory });
  const restored = await clients[0].getQuote(quote.quoteId);
  assert.deepEqual(restored, original);
  assert.equal((await checkSupplierLab({ rootDirectory })).totalCents, 67415);
});

test('lifecycle lock blocks concurrent changes and an unexpected supplier exit stops its peers', { timeout: 15000 }, async (t) => {
  const rootDirectory = await directory(t);
  await setupSupplierLab({ rootDirectory, ports: await freePorts(2) });
  const lockPath = path.join(rootDirectory, '.supplier-lab', 'lifecycle.lock');
  await fs.writeFile(lockPath, JSON.stringify({ lockId: 'test-owned-lock', launcherPid: process.pid }), { mode: 0o600 });
  await assert.rejects(startSupplierLab({ rootDirectory }), /LAB_LIFECYCLE_LOCKED/);
  await assert.rejects(configureLabMerchants({ rootDirectory, merchantIds: ['MERCHANT00001', 'MERCHANT00002'] }), /LAB_LIFECYCLE_LOCKED/);
  await fs.unlink(lockPath);
  const lab = await startSupplierLab({ rootDirectory });
  t.after(() => lab.stop());
  process.kill(lab.pids[0], 'SIGTERM');
  await lab.closed;
  await lab.stop();
  for (const pid of lab.pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await assert.rejects(fs.stat(path.join(rootDirectory, '.supplier-lab', 'running.json')), { code: 'ENOENT' });
});
