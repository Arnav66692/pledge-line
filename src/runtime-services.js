import fs from 'node:fs';
import { createAiBudget, AI_DEFAULT_LIMITS } from './ai-budget.js';
import { createAiGateway } from './ai-gateway.js';
import { createMainAgent } from './agent.js';
import { createMcpSuppliers } from './supplier-mcp.js';
import { createSandboxOrders } from './paypal-orders.js';
import { createCheckoutStore } from './checkout-store.js';
import { createSandboxCheckout } from './sandbox-checkout.js';
import { validateProcurementQuote } from './procurement.js';

export const SANDBOX_WRITE_UNLOCK_AT = '2026-11-05T05:00:00.000Z';
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };

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
export async function configureRuntimeServices({ config, database, env = process.env, now = () => new Date(), fetchImpl = globalThis.fetch } = {}) {
  const paid = config.router.mode === 'anthropic';
  if (config.router.mode === 'haiku') fail('USE_GUARDED_ANTHROPIC_MODE');
  let gateway = null, agent = null, suppliers = null, checkoutStore = null, checkout = null;
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
  const writesAllowed = () => env.PAYPAL_SANDBOX_CHECKOUT_WRITES === 'true' && new Date(now()).getTime() >= Date.parse(SANDBOX_WRITE_UNLOCK_AT);
  if (supplierMode === 'mcp-sandbox') {
    if (!database?.pool) fail('CHECKOUT_DATABASE_REQUIRED');
    suppliers = createMcpSuppliers({ registry: readSupplierRegistry(env.SUPPLIER_REGISTRY_PATH || '.suppliers.json', env), now });
    const registered = new Map(suppliers.map((supplier) => [supplier.id, supplier]));
    checkoutStore = createCheckoutStore({ pool: database.pool });
    await checkoutStore.checkSchema();
    const paypal = createSandboxOrders({ clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, fetchImpl });
    const options = { store: checkoutStore, paypal, now, checkoutOrigin: new URL(config.publicBaseUrl).origin,
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
  }
  return { agent, aiGateway: gateway, suppliers, checkout, checkoutStore, commerceStatus: () => ({
    suppliers: supplierMode, payments: supplierMode === 'mcp-sandbox' ? 'paypal-sandbox' : 'mock',
    sandboxWritesEnabled: supplierMode === 'mcp-sandbox' && writesAllowed(), sandboxWriteUnlockAt: SANDBOX_WRITE_UNLOCK_AT,
    supplierProvenance: suppliers ? 'Operator-registered endpoints. Independent business participation and fulfillment are not verified.' : 'Simulated suppliers.',
    livePayments: false,
  }) };
}
