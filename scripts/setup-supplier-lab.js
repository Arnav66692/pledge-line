// Controlled local supplier infrastructure. Never sends a model or PayPal request.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseEnv } from 'node:util';
import { createMcpSuppliers } from '../src/supplier-mcp.js';
import { createProcurementService } from '../src/procurement.js';

const DEFINITIONS = [
  { id: 'lab-campus', name: 'Controlled Campus Print lab', tokenEnv: 'MCP_LAB_CAMPUS_TOKEN', placeholder: 'LABCAMPUS0001', capacity: 60, unit: 650, floor: 600, setup: 1000, shipping: 800, tax: 500, days: 2 },
  { id: 'lab-club', name: 'Controlled Club Threads lab', tokenEnv: 'MCP_LAB_CLUB_TOKEN', placeholder: 'LABCLUB000001', capacity: 40, unit: 675, floor: 620, setup: 500, shipping: 1200, tax: 500, days: 3 },
  { id: 'lab-rush', name: 'Controlled Rush Merch lab', tokenEnv: 'MCP_LAB_RUSH_TOKEN', placeholder: 'LABRUSH000001', capacity: 100, unit: 850, floor: 780, setup: 1000, shipping: 2000, tax: 500, days: 1 },
];
const SCRIPT = fileURLToPath(new URL('./supplier-server.js', import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
const locations = (rootDirectory) => {
  const root = path.resolve(rootDirectory);
  return { root, directory: path.join(root, '.supplier-lab'), registry: path.join(root, '.suppliers.json'), settings: path.join(root, '.suppliers.env'), manifest: path.join(root, '.supplier-lab', 'manifest.json'), running: path.join(root, '.supplier-lab', 'running.json') };
};
async function exists(file) { try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function privateRead(file, maximum = 65536) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) fail('LAB_CONFIGURATION_INVALID');
  return fs.readFile(file, 'utf8');
}
function status(manifest, root) {
  return { controlledSandbox: true, supplierCount: manifest.suppliers.length, merchantMode: manifest.merchantMode,
    merchantOwnershipVerified: false, independentBusinessParticipation: false, paymentsDisabled: true,
    endpoints: manifest.registry.map((entry) => ({ id: entry.id, endpoint: entry.endpoint })), rootDirectory: root };
}
async function load(rootDirectory) {
  const files = locations(rootDirectory);
  const stat = await fs.lstat(files.directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('LAB_CONFIGURATION_INVALID');
  const [manifestText, registryText, settingsText] = await Promise.all([privateRead(files.manifest), privateRead(files.registry), privateRead(files.settings)]);
  let manifest, registry, settings;
  try { manifest = JSON.parse(manifestText); registry = JSON.parse(registryText); settings = parseEnv(settingsText); } catch { fail('LAB_CONFIGURATION_INVALID'); }
  if (manifest?.version !== 1 || manifest.provenance !== 'pledge-line-controlled-supplier-lab' || !/^[0-9a-f-]{36}$/.test(manifest.labId ?? '') ||
      !['placeholder', 'configured'].includes(manifest.merchantMode) || !Array.isArray(manifest.suppliers) || manifest.suppliers.length < 2 || manifest.suppliers.length > 3 ||
      !Array.isArray(registry) || hash(registryText) !== manifest.registryHash || hash(settingsText) !== manifest.settingsHash ||
      JSON.stringify(manifest.registry) !== JSON.stringify(registry) || settings.LAB_MERCHANT_MODE !== manifest.merchantMode || settings.PAYPAL_SANDBOX_CHECKOUT_WRITES !== 'false') fail('LAB_CONFIGURATION_CHANGED');
  for (const [index, entry] of registry.entries()) {
    const supplier = manifest.suppliers[index], definition = DEFINITIONS[index];
    if (!supplier || supplier.id !== definition.id || entry.id !== supplier.id || entry.name !== definition.name ||
      !Number.isInteger(supplier.port) || supplier.port < 1024 || supplier.port > 65535 || entry.endpoint !== `http://127.0.0.1:${supplier.port}/mcp` ||
      entry.tokenEnv !== definition.tokenEnv || entry.allowLocal !== true || !Array.isArray(entry.allowedHosts) || entry.allowedHosts.length !== 0 ||
      !/^[A-Z0-9]{8,40}$/.test(entry.payeeId ?? '') || !/^[a-f0-9]{64}$/.test(settings[entry.tokenEnv] ?? '') ||
      JSON.stringify(supplier.definition) !== JSON.stringify(definition)) fail('LAB_CONFIGURATION_INVALID');
  }
  if (new Set(manifest.suppliers.map((supplier) => supplier.port)).size !== registry.length) fail('LAB_CONFIGURATION_INVALID');
  return { files, manifest, registry, settings };
}
async function ensureStopped(files) {
  if (!await exists(files.running)) return;
  let running;
  try { running = JSON.parse(await privateRead(files.running)); } catch { fail('LAB_RUNNING_STATE_INVALID'); }
  if (!Number.isInteger(running.launcherPid) || running.launcherPid < 1) fail('LAB_RUNNING_STATE_INVALID');
  try { process.kill(running.launcherPid, 0); fail('LAB_ALREADY_RUNNING'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  await fs.rename(files.running, path.join(files.directory, `running-${randomUUID()}.stale.json`));
}
async function writeNew(file, value) {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
}
async function withLifecycleLock(files, operation) {
  const file = path.join(files.directory, 'lifecycle.lock'), lockId = randomUUID();
  let handle;
  try { handle = await fs.open(file, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('LAB_LIFECYCLE_LOCKED'); throw error; }
  try {
    await handle.writeFile(JSON.stringify({ lockId, launcherPid: process.pid }) + '\n'); await handle.sync();
    return await operation();
  } finally {
    await handle.close();
    // Remove only our own lock; a stale lock after a crash requires operator inspection.
    const current = JSON.parse(await privateRead(file));
    if (current.lockId === lockId) await fs.unlink(file);
  }
}
function manifestFor(suppliers, registry, settingsText, prior = {}) {
  const registryText = JSON.stringify(registry, null, 2) + '\n';
  return { registryText, manifest: { version: 1, provenance: 'pledge-line-controlled-supplier-lab', labId: prior.labId ?? randomUUID(),
    createdAt: prior.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(), merchantMode: parseEnv(settingsText).LAB_MERCHANT_MODE,
    suppliers, registry, registryHash: hash(registryText), settingsHash: hash(settingsText) } };
}

export async function setupSupplierLab({ rootDirectory = process.cwd(), ports = [3160, 3161, 3162], merchantIds = null } = {}) {
  const files = locations(rootDirectory);
  if (await exists(files.manifest)) return status((await load(rootDirectory)).manifest, files.root);
  if (await exists(files.registry) || await exists(files.settings) || await exists(files.directory)) fail('LAB_EXISTING_CONFIG_NOT_OWNED');
  if (!Array.isArray(ports) || ports.length < 2 || ports.length > 3 || ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535) || new Set(ports).size !== ports.length) fail('LAB_PORTS_INVALID');
  if (merchantIds !== null && (!Array.isArray(merchantIds) || merchantIds.length !== ports.length || merchantIds.some((id) => !/^[A-Z0-9]{8,40}$/.test(id)))) fail('LAB_MERCHANT_IDS_INVALID');
  await fs.mkdir(files.directory, { mode: 0o700 });
  const suppliers = ports.map((port, index) => ({ id: DEFINITIONS[index].id, port, definition: DEFINITIONS[index] }));
  const registry = suppliers.map((supplier, index) => ({ id: supplier.id, name: supplier.definition.name, payeeId: merchantIds?.[index] ?? supplier.definition.placeholder,
    endpoint: `http://127.0.0.1:${supplier.port}/mcp`, tokenEnv: supplier.definition.tokenEnv, allowedHosts: [], allowLocal: true }));
  const settingsText = ['# Controlled local supplier lab. No real supplier or fulfillment.',
    'LAB_MERCHANT_MODE=' + (merchantIds ? 'configured' : 'placeholder'), 'PAYPAL_SANDBOX_CHECKOUT_WRITES=false',
    'PROCUREMENT_SUPPLIER_MODE=mcp-sandbox', 'SUPPLIER_REGISTRY_PATH=' + JSON.stringify(files.registry),
    ...suppliers.map((supplier) => supplier.definition.tokenEnv + '=' + randomBytes(32).toString('hex')), ''].join('\n');
  const built = manifestFor(suppliers, registry, settingsText);
  // Exclusive writes never overwrite a pre-existing registry or token file. Partial setups require investigation.
  await writeNew(files.settings, settingsText);
  await writeNew(files.registry, built.registryText);
  await writeNew(files.manifest, JSON.stringify(built.manifest, null, 2) + '\n');
  return status(built.manifest, files.root);
}

export async function configureLabMerchants({ rootDirectory = process.cwd(), merchantIds } = {}) {
  const initial = await load(rootDirectory);
  return withLifecycleLock(initial.files, async () => {
  const lab = await load(rootDirectory);
  await ensureStopped(lab.files);
  if (!Array.isArray(merchantIds) || merchantIds.length !== lab.registry.length || merchantIds.some((id) => !/^[A-Z0-9]{8,40}$/.test(id) || DEFINITIONS.some((definition) => id === definition.placeholder))) fail('LAB_MERCHANT_IDS_INVALID');
  const registry = lab.registry.map((entry, index) => ({ ...entry, payeeId: merchantIds[index] }));
  const settingsText = (await privateRead(lab.files.settings)).replace(/^LAB_MERCHANT_MODE=placeholder$/m, 'LAB_MERCHANT_MODE=configured');
  const built = manifestFor(lab.manifest.suppliers, registry, settingsText, lab.manifest);
  const archive = path.join(lab.files.directory, 'archive'); await fs.mkdir(archive, { recursive: true, mode: 0o700 });
  const revision = randomUUID();
  // Keep originals before replacing verified, owned configuration. Quote history is retained as well.
  for (const [label, file] of [['registry', lab.files.registry], ['settings', lab.files.settings], ['manifest', lab.files.manifest]]) await writeNew(path.join(archive, `${label}-${revision}.txt`), await privateRead(file));
  for (const [file, value] of [[lab.files.registry, built.registryText], [lab.files.settings, settingsText], [lab.files.manifest, JSON.stringify(built.manifest, null, 2) + '\n']]) {
    const temporary = path.join(lab.files.directory, `configuration-${randomUUID()}.pending`);
    await writeNew(temporary, value); await fs.rename(temporary, file);
  }
  return status((await load(rootDirectory)).manifest, lab.files.root);
  });
}

export async function connectSupplierLab({ rootDirectory = process.cwd() } = {}) {
  const lab = await load(rootDirectory);
  return createMcpSuppliers({ registry: lab.registry.map((entry) => { const { tokenEnv, ...publicEntry } = entry; return { ...publicEntry, token: lab.settings[tokenEnv] }; }) });
}

export async function checkSupplierLab({ rootDirectory = process.cwd() } = {}) {
  const lab = await load(rootDirectory), suppliers = await connectSupplierLab({ rootDirectory });
  const state = await createProcurementService({ suppliers }).request({ quantity: 100, budgetCents: 80000, currency: 'USD',
    specification: 'Identical white cotton volunteer shirts for the pantry, one navy print.', deadline: new Date(Date.now() + 7 * 86400000).toISOString() });
  if (state.status !== 'awaiting_approval' || state.proposal.totalCents !== 67415) fail('LAB_QUOTES_UNAVAILABLE');
  return { ...status(lab.manifest, lab.files.root), totalCents: state.proposal.totalCents, quantity: state.proposal.quantity,
    aiRequests: 0, financialWrites: 0, comparisonScope: 'Controlled supplied quotes only, deterministic negotiation check.',
    allocations: state.proposal.allocations, quotes: state.quotes.map((quote) => ({ supplierId: quote.supplierId, quoteId: quote.quoteId, unitPriceCents: quote.unitPriceCents })) };
}

export async function startSupplierLab({ rootDirectory = process.cwd(), startupTimeoutMs = 10000 } = {}) {
  const initial = await load(rootDirectory);
  return withLifecycleLock(initial.files, async () => {
  const lab = await load(rootDirectory);
  await ensureStopped(lab.files);
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 100 || startupTimeoutMs > 30000) fail('LAB_STARTUP_TIMEOUT_INVALID');
  const children = [], completions = [], runId = randomUUID();
  let stopPromise, started = false, unexpectedExit = false;
  function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
    await Promise.all(children.map(async (child, index) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 12000);
      child.kill('SIGTERM');
      try { await completions[index]; } finally { clearTimeout(timer); }
    }));
    try { const current = JSON.parse(await privateRead(lab.files.running)); if (current.runId === runId) await fs.rename(lab.files.running, path.join(lab.files.directory, `running-${runId}.stopped.json`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    })();
    return stopPromise;
  }
  try {
    for (const [index, supplier] of lab.manifest.suppliers.entries()) {
      const definition = supplier.definition;
      const env = { PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? 'en_US.UTF-8',
        MCP_SUPPLIER_ID: definition.id, MCP_SUPPLIER_NAME: definition.name, MCP_SUPPLIER_HOST: '127.0.0.1', MCP_SUPPLIER_PORT: String(supplier.port),
        PAYPAL_SANDBOX_MERCHANT_ID: lab.registry[index].payeeId, MCP_SUPPLIER_TOKEN: lab.settings[definition.tokenEnv],
        MCP_QUOTES_PATH: path.join(lab.files.directory, 'quotes-' + definition.id + '.json'),
        MCP_SUPPLIER_CAPACITY: String(definition.capacity), MCP_SUPPLIER_UNIT_CENTS: String(definition.unit), MCP_SUPPLIER_FLOOR_CENTS: String(definition.floor),
        MCP_SUPPLIER_SETUP_CENTS: String(definition.setup), MCP_SUPPLIER_SHIPPING_CENTS: String(definition.shipping), MCP_SUPPLIER_TAX_BPS: String(definition.tax), MCP_SUPPLIER_LEAD_DAYS: String(definition.days) };
      const child = spawn(process.execPath, [SCRIPT], { cwd: lab.files.root, env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
      // Attach before waiting for readiness so even an early exit always settles closed.
      completions.push(new Promise((resolve) => child.once('close', resolve)));
      child.once('exit', () => {
        if (!stopPromise) {
          unexpectedExit = true;
          if (started) stop().catch(() => { process.exitCode = 1; });
        }
      });
      await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('LAB_SUPPLIER_START_FAILED')), startupTimeoutMs);
        const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
        child.once('error', () => finish(new Error('LAB_SUPPLIER_START_FAILED')));
        child.once('exit', () => finish(new Error('LAB_SUPPLIER_START_FAILED')));
        child.stdout.on('data', (chunk) => { output = (output + chunk.toString()).slice(-4096); if (output.includes(`Controlled sandbox supplier listening on port ${supplier.port}.`)) finish(); });
        child.stderr.on('data', () => {}); // Child errors are deliberately not copied into parent logs.
      });
      if (unexpectedExit) fail('LAB_SUPPLIER_START_FAILED');
    }
    await writeNew(lab.files.running, JSON.stringify({ runId, launcherPid: process.pid, childPids: children.map((child) => child.pid), startedAt: new Date().toISOString(), controlledSandbox: true }) + '\n');
    if (unexpectedExit) fail('LAB_SUPPLIER_START_FAILED');
    started = true;
    return { ...status(lab.manifest, lab.files.root), pids: children.map((child) => child.pid), launcherPid: process.pid, stop,
      closed: Promise.all(completions) };
  } catch { await stop(); fail('LAB_SUPPLIER_START_FAILED'); }
  });
}

async function main() {
  const action = process.argv[2];
  if (process.argv.length !== 3 || !['--setup', '--start', '--check', '--configure-merchants'].includes(action)) fail('LAB_USAGE');
  if (action === '--setup') process.stdout.write(JSON.stringify(await setupSupplierLab()) + '\n');
  if (action === '--check') process.stdout.write(JSON.stringify(await checkSupplierLab()) + '\n');
  if (action === '--configure-merchants') {
    const lab = await load(process.cwd());
    const merchantIds = lab.manifest.suppliers.map((supplier) => process.env[supplier.id.toUpperCase().replaceAll('-', '_') + '_PAYPAL_MERCHANT_ID'] ?? process.env.PAYPAL_SANDBOX_MERCHANT_ID);
    process.stdout.write(JSON.stringify(await configureLabMerchants({ merchantIds })) + '\n');
  }
  if (action === '--start') {
    const lab = await startSupplierLab();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { lab.stop().catch(() => { process.exitCode = 1; }); });
    process.stdout.write(JSON.stringify({ ...status((await load(process.cwd())).manifest, process.cwd()), launcherPid: lab.launcherPid, childPids: lab.pids }) + '\n');
    await lab.closed; await lab.stop();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { const safe = /^LAB_[A-Z_]+$/.test(error?.code ?? error?.message ?? '') ? error.code ?? error.message : 'LAB_SETUP_FAILED'; process.stderr.write(safe + '. No private values or child logs printed.\n'); process.exitCode = 1; });
}
