import fs from 'node:fs';
import { createAiBudget, AI_DEFAULT_LIMITS } from './ai-budget.js';
import { createAiGateway } from './ai-gateway.js';
import { createMainAgent } from './agent.js';
import { createMcpSuppliers } from './supplier-mcp.js';
import { createSandboxOrders } from './paypal-orders.js';
import { createCheckoutStore } from './checkout-store.js';
import { createSandboxCheckout } from './sandbox-checkout.js';
import { createCheckoutRecovery } from './checkout-recovery.js';
import { validateProcurementQuote } from './procurement.js';
import { startHostedSupplierLab } from './hosted-supplier-lab.js';
import { createDonorStore } from './donor-store.js';
import { createDurableLedger } from './durable-ledger.js';
import { createDonorDurability } from './donor-durability.js';
import { createReadiness } from './readiness.js';

export const SANDBOX_WRITE_UNLOCK_AT = '2026-11-05T05:00:00.000Z';
// The HTTP adapter uses this fixed organization; requests cannot nominate another tenant.
export const CHECKOUT_ORGANIZATION_ID = 'demo-organization';
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };

export function sandboxWritePolicy(env, at) {
  if (env.LAB_MERCHANT_MODE === 'placeholder') return { enabled: false, blockedReason: 'placeholder_merchants' };
  if (env.PAYPAL_SANDBOX_CHECKOUT_WRITES !== 'true') return { enabled: false, blockedReason: 'operator_disabled' };
  if (!(new Date(at).getTime() >= Date.parse(SANDBOX_WRITE_UNLOCK_AT))) return { enabled: false, blockedReason: 'time_gate' };
  return { enabled: true, blockedReason: null };
}

export function dollarsToNanos(raw, fallback, maximum) {
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || !/^\d{1,6}(?:\.\d{1,9})?$/.test(raw)) fail('AI_ALLOCATION_INVALID');
  const [whole, fraction = ''] = raw.split('.');
  const value = Number(BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, '0')));
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail('AI_ALLOCATION_INVALID');
  return value;
}

/** Operator-only registry. HTTP requests cannot nominate an endpoint, credential or merchant. */
export function readSupplierRegistry(file, env = process.env) {
  if (typeof file !== 'string' || !file) fail('SUPPLIER_REGISTRY_REQUIRED');
  let registry;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024) throw Error();
    registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { fail('SUPPLIER_REGISTRY_INVALID'); }
  if (!Array.isArray(registry) || registry.length < 1 || registry.length > 5) fail('SUPPLIER_REGISTRY_INVALID');
  return registry.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some((key) => !['id', 'name', 'payeeId', 'endpoint', 'tokenEnv', 'allowedHosts', 'allowLocal'].includes(key)) ||
      !/^MCP_[A-Z0-9_]{1,68}TOKEN$/.test(entry.tokenEnv ?? '') || !Array.isArray(entry.allowedHosts) ||
      (entry.allowLocal !== undefined && typeof entry.allowLocal !== 'boolean')) fail('SUPPLIER_REGISTRY_INVALID');
    const token = env[entry.tokenEnv];
    if (typeof token !== 'string' || token.length < 24) fail('SUPPLIER_CREDENTIAL_REQUIRED');
    const { tokenEnv, ...publicEntry } = entry;
    return { ...publicEntry, token };
  });
}

/** No migration or paid probe happens at startup. Configured storage errors prevent startup. */
export async function configureRuntimeServices({ config, database, env = process.env, now = () => new Date(), fetchImpl = globalThis.fetch,
  startSupplierLab = startHostedSupplierLab } = {}) {
  const paid = config.router.mode === 'anthropic';
  if (config.router.mode === 'haiku') fail('USE_GUARDED_ANTHROPIC_MODE');
  let gateway = null, agent = null, suppliers = null, checkoutStore = null, checkout = null, checkoutRecovery = null;
  let ledger = null, durability = null, donorStore = null;
  let hostedSupplierLab = null, closePromise = null;
  const close = () => { closePromise ??= Promise.resolve().then(() => hostedSupplierLab?.close()); return closePromise; };
  if (paid) {
    if (!database?.pool) fail('AI_DATABASE_REQUIRED');
    if (env.AI_PREPAID_ONLY_CONFIRMED !== 'true') fail('AI_PREPAID_CONFIRMATION_REQUIRED');
    const budget = createAiBudget({ pool: database.pool, scope: env.AI_BUDGET_SCOPE || 'pledge-line', limits: {
      anthropic: dollarsToNanos(env.AI_ANTHROPIC_LIMIT_USD, AI_DEFAULT_LIMITS.anthropic, 200000000000),
      jev: dollarsToNanos(env.AI_JEV_LIMIT_USD, AI_DEFAULT_LIMITS.jev, 10000000000),
    } });
    await budget.checkSchema();
    gateway = createAiGateway({ budget, anthropicApiKey: config.router.apiKey, jevApiKey: config.router.jevApiKey, fetchImpl });
    agent = createMainAgent({ gateway });
  }
  const supplierMode = env.PROCUREMENT_SUPPLIER_MODE || 'mock';
  if (!['mock', 'mcp-sandbox'].includes(supplierMode)) fail('SUPPLIER_MODE_INVALID');
  const hosted = env.HOSTED_SUPPLIER_LAB_ENABLED === 'true';
  if (hosted && supplierMode !== 'mcp-sandbox') fail('HOSTED_SUPPLIER_LAB_MODE_REQUIRED');
  const writePolicy = () => sandboxWritePolicy(env, now());
  const writesAllowed = () => writePolicy().enabled;
  try {
  if (env.DONOR_DURABILITY_ENABLED === 'true') {
    if (!database?.pool) fail('DONOR_DATABASE_REQUIRED');
    donorStore = createDonorStore({ pool: database.pool, organizationId: CHECKOUT_ORGANIZATION_ID, now });
    await donorStore.checkSchema();
    ledger = createDurableLedger({ store: donorStore, now });
    await ledger.ready();
    durability = createDonorDurability({ store: donorStore, ledger, now });
  }
  if (supplierMode === 'mcp-sandbox') {
    if (!database?.pool) fail('CHECKOUT_DATABASE_REQUIRED');
    if (hosted) {
      if ([3160, 3161, 3162].includes(config.port)) fail('HOSTED_SUPPLIER_LAB_PORT_CONFLICT');
      hostedSupplierLab = await startSupplierLab({ pool: database.pool, payeeId: env.SUPPLIER_LAB_PAYEE_ID, now });
    }
    suppliers = createMcpSuppliers({ registry: hostedSupplierLab?.registry ?? readSupplierRegistry(env.SUPPLIER_REGISTRY_PATH || '.suppliers.json', env), now });
    const registered = new Map(suppliers.map((supplier) => [supplier.id, supplier]));
    checkoutStore = createCheckoutStore({ pool: database.pool });
    await checkoutStore.checkSchema();
    const paypal = createSandboxOrders({ clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, fetchImpl });
    const options = { store: checkoutStore, paypal, now, organizationId: CHECKOUT_ORGANIZATION_ID, checkoutOrigin: new URL(config.publicBaseUrl).origin,
      getQuote: async (allocation, rfq) => {
        const supplier = registered.get(allocation.supplierId);
        if (!supplier || supplier.payeeId !== allocation.payeeId) fail('SUPPLIER_BINDING_CHANGED');
        return validateProcurementQuote(await supplier.getQuote(allocation.quoteId), supplier, rfq, new Date(now()).getTime());
      } };
    const base = createSandboxCheckout(options);
    checkout = { ...base,
      prepare: (input) => createSandboxCheckout({ ...options, allowSandboxWrites: writesAllowed() }).prepare(input),
      capture: (input) => createSandboxCheckout({ ...options, allowSandboxWrites: writesAllowed() }).capture(input),
    };
    if (env.CHECKOUT_RECOVERY_ENABLED === 'true') {
      // This instance owns a separate token cache and exposes no financial methods.
      const reads = createSandboxOrders({ clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, fetchImpl, readOnly: true });
      checkoutRecovery = createCheckoutRecovery({ enabled: true, now: () => new Date(now()).getTime(),
        listCandidates: ({ after, limit, signal }) => checkoutStore.listRecoveryCandidates({ organizationId: CHECKOUT_ORGANIZATION_ID, after, limit, signal }),
        withLease: ({ signal }, work) => checkoutStore.withRecoveryLease({ organizationId: CHECKOUT_ORGANIZATION_ID, signal }, work),
        reconcileExisting: async ({ id, signal }) => {
          signal.throwIfAborted();
          const scoped = createCheckoutStore({ pool: database.pool, recoverySignal: signal });
          const store = Object.fromEntries(['get', 'block', 'recordOrder', 'recordCapture'].map((method) => [method, scoped[method]]));
          const readOnlyPaypal = { mode: reads.mode, getOrder: (orderId) => reads.getOrder(orderId, { signal }),
            getCapture: (captureId) => reads.getCapture(captureId, { signal }) };
          const service = createSandboxCheckout({ store, paypal: readOnlyPaypal, now, organizationId: CHECKOUT_ORGANIZATION_ID,
            checkoutOrigin: options.checkoutOrigin, allowSandboxWrites: false,
            getQuote: async () => fail('CHECKOUT_RECOVERY_QUOTE_ACCESS_REFUSED') });
          const state = await service.reconcile({ id });
          signal.throwIfAborted();
          return state;
        },
      });
    }
  }
  const commerceStatus = () => ({
    suppliers: supplierMode, payments: supplierMode === 'mcp-sandbox' ? 'paypal-sandbox' : 'mock',
    sandboxWritesEnabled: supplierMode === 'mcp-sandbox' && writesAllowed(), sandboxWriteUnlockAt: SANDBOX_WRITE_UNLOCK_AT,
    sandboxWriteBlockedReason: supplierMode === 'mcp-sandbox' ? writePolicy().blockedReason : 'mock_mode',
    checkoutRecovery: checkoutRecovery?.status() ?? { enabled: false, running: false, inFlight: false },
    hostedSupplierLab: hostedSupplierLab?.status() ?? null,
    supplierProvenance: hostedSupplierLab ? hostedSupplierLab.status().provenance : suppliers ? env.LAB_MERCHANT_MODE === 'placeholder' ? 'Controlled sandbox supplier lab. Merchant IDs are placeholders and checkout writes are disabled. No independent business participation or fulfillment.' : 'Operator-registered endpoints. Independent business participation and fulfillment are not verified.' : 'Simulated suppliers.',
    livePayments: false,
  });
  const checkReadiness = createReadiness({ requireDatabase: Boolean(database), requireAi: paid, requireSupplierLab: Boolean(hostedSupplierLab),
    requireRecovery: Boolean(checkoutRecovery), now: () => new Date(now()).getTime(), commerceStatus,
    databaseProbe: database ? async () => {
      const client = await database.pool.connect();
      try { const answer = await client.query({ text: 'SELECT 1 AS ready', query_timeout: 1000 }); return answer.rows[0]?.ready === 1; }
      finally { client.release(); }
    } : null,
    aiStatus: gateway ? () => gateway.status() : null });
  return { agent, aiGateway: gateway, suppliers, checkout, checkoutStore, checkoutRecovery, close, checkReadiness,
    ...(donorStore ? { ledger, durability, donorStore } : {}), commerceStatus };
  } catch (error) { try { await close(); } catch { /* Preserve the startup failure after attempting private listener cleanup. */ } throw error; }
}
