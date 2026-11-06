/** Local capability checks only. This never probes a payment or inference provider. */
export function createReadiness({ databaseProbe = null, aiStatus = null, commerceStatus = () => ({}),
  requireDatabase = false, requireAi = false, requireSupplierLab = false, requireRecovery = false,
  now = () => Date.now(), timeoutMs = 1500, cacheMs = 1000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 || !Number.isInteger(cacheMs) || cacheMs < 0 || cacheMs > 10000) throw Error('READINESS_CONFIGURATION_INVALID');
  let current = null, checkedAt = -Infinity, snapshot = null;
  const outstanding = new Map();
  async function probe(name, operation) {
    if (typeof operation !== 'function') return { status: 'unavailable' };
    if (outstanding.has(name)) return { status: 'unavailable' };
    let timer;
    const work = Promise.resolve().then(operation).catch(() => ({ status: 'unavailable' }));
    outstanding.set(name, work);
    void work.finally(() => { if (outstanding.get(name) === work) outstanding.delete(name); });
    try {
      return await Promise.race([work, new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 'unavailable' }), timeoutMs); })]);
    } finally { clearTimeout(timer); }
  }
  return async function checkReadiness() {
    if (current) return current;
    if (snapshot && now() - checkedAt < cacheMs) return snapshot;
    current = (async () => {
      let commerce = {}, commerceReadable = true;
      try { commerce = commerceStatus() ?? {}; } catch { commerceReadable = false; }
      const [database, ai] = await Promise.all([
        requireDatabase ? probe('database', async () => ({ status: await databaseProbe() === true ? 'ready' : 'unavailable' })) : { status: 'not_required' },
        requireAi ? probe('ai', async () => {
          const state = await aiStatus();
          if (!state || typeof state.stopped !== 'boolean' || !Array.isArray(state.pendingRequests) ||
            state.accounts !== undefined && (!state.accounts || Array.isArray(state.accounts) || ['anthropic', 'jev'].some((name) => {
              const account = state.accounts[name];
              return !account || !Number.isSafeInteger(account.allocationNanos) || !Number.isSafeInteger(account.usedNanos) ||
                !Number.isSafeInteger(account.remainingNanos) || account.allocationNanos < 0 || account.usedNanos < 0 ||
                account.remainingNanos !== Math.max(0, account.allocationNanos - account.usedNanos);
            })) || state.credentialsConfigured !== undefined && (!state.credentialsConfigured ||
              ['anthropic', 'jev'].some((name) => typeof state.credentialsConfigured[name] !== 'boolean'))) return { status: 'unavailable' };
          if (state.stopped || state.credentialsConfigured?.anthropic === false || state.credentialsConfigured?.jev === false ||
            Object.values(state.accounts ?? {}).some((account) => account.remainingNanos <= 0)) return { status: 'stopped' };
          return { status: state.pendingRequests?.length ? 'busy' : 'ready' };
        }) : { status: 'not_required' },
      ]);
      const lab = !requireSupplierLab ? 'not_required' : commerceReadable && commerce.hostedSupplierLab?.running === true ? 'ready' : 'unavailable';
      const recovery = !requireRecovery ? 'not_required' : commerceReadable && commerce.checkoutRecovery?.running === true ? 'ready' : 'unavailable';
      const storageReady = database.status === 'ready' || database.status === 'not_required';
      const aiReady = ai.status === 'ready' || ai.status === 'not_required';
      const suppliersReady = lab === 'ready' || lab === 'not_required';
      const recoveryReady = recovery === 'ready' || recovery === 'not_required';
      checkedAt = now();
      snapshot = { ready: storageReady && ['ready', 'busy', 'not_required'].includes(ai.status) && suppliersReady && recoveryReady && commerceReadable,
        checkedAt: new Date(checkedAt).toISOString(), checksOnlyLocalDependencies: true, providerConnectivityChecked: false,
        components: { database: database.status, ai: ai.status, supplierLab: lab, checkoutRecovery: recovery },
        capabilities: { donorReadback: storageReady, financialRecovery: storageReady && recoveryReady,
          goalDrafting: storageReady && requireAi && aiReady, supplierQuotes: storageReady && suppliersReady && aiReady,
          sandboxCheckout: storageReady && suppliersReady && recoveryReady && commerce.sandboxWritesEnabled === true }, livePayments: false };
      return snapshot;
    })();
    try { return await current; } finally { current = null; }
  };
}
