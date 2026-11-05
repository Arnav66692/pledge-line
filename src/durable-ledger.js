const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };

/** Synchronous audit indexing with explicit PostgreSQL barriers before provider writes and HTTP success. */
export function createDurableLedger({ store, now = () => new Date(), blockSize = 512, maxEvents = 100000 } = {}) {
  if (!store || ['reserveEventSequences', 'appendEvents', 'listEvents'].some((name) => typeof store[name] !== 'function')) fail('DONOR_LEDGER_STORE_REQUIRED');
  if (!Number.isInteger(blockSize) || blockSize < 1 || blockSize > 1024 || !Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 100000) fail('DONOR_LEDGER_INPUT_INVALID');
  const events = new Map();
  let byCall = new Map(), byType = new Map();
  let available = [], pending = [], initialized = false, poisoned = false, highWater = 0;
  let flushing = Promise.resolve(), preparing = Promise.resolve();
  const healthy = () => { if (poisoned) fail('DONOR_LEDGER_UNAVAILABLE'); };
  function index() {
    byCall = new Map(); byType = new Map();
    for (const event of [...events.values()].sort((a, b) => a.seq - b.seq)) {
      if (event.callId) { if (!byCall.has(event.callId)) byCall.set(event.callId, []); byCall.get(event.callId).push(event); }
      if (!byType.has(event.type)) byType.set(event.type, []);
      byType.get(event.type).push(event);
    }
  }
  function merge(event) {
    if (!event || !Number.isSafeInteger(event.seq) || event.seq < 1 || typeof event.type !== 'string' || !Number.isFinite(Date.parse(event.ts))) fail('DONOR_LEDGER_EVENT_INVALID');
    const previous = events.get(event.seq);
    if (previous && !same(previous, event)) fail('DONOR_LEDGER_CONFLICT');
    if (!previous) {
      if (events.size >= maxEvents) fail('DONOR_LEDGER_CAPACITY');
      events.set(event.seq, freeze(structuredClone(event)));
    }
    highWater = Math.max(highWater, event.seq);
  }
  async function reload() {
    healthy();
    try {
      let afterSeq = 0;
      for (;;) {
        const batch = await store.listEvents({ afterSeq, limit: 10000 });
        if (!Array.isArray(batch)) fail('DONOR_LEDGER_EVENT_INVALID');
        for (const event of batch) { if (event.seq <= afterSeq) fail('DONOR_LEDGER_EVENT_INVALID'); merge(event); afterSeq = event.seq; }
        if (batch.length < 10000) break;
      }
      available = available.filter((seq) => seq > highWater);
      index();
      return events.size;
    } catch (error) {
      poisoned = true;
      if (error.code?.startsWith('DONOR_LEDGER_')) throw error;
      fail('DONOR_LEDGER_UNAVAILABLE');
    }
  }
  async function ensureCapacity(count = Math.min(256, blockSize)) {
    healthy();
    if (!Number.isInteger(count) || count < 1 || count > 1024) fail('DONOR_LEDGER_INPUT_INVALID');
    const next = preparing.then(async () => {
      healthy();
      available = available.filter((seq) => seq > highWater);
      if (available.length >= count) return;
      const reserved = await store.reserveEventSequences({ count: Math.max(blockSize, count) });
      if (!Array.isArray(reserved) || reserved.length < count || reserved.some((seq, i) => !Number.isSafeInteger(seq) || seq <= highWater || (i && seq <= reserved[i - 1]))) fail('DONOR_LEDGER_CAPACITY');
      available = [...new Set([...available, ...reserved])].sort((a, b) => a - b);
    });
    preparing = next.catch(() => {});
    try { await next; } catch (error) { poisoned = true; if (error.code?.startsWith('DONOR_LEDGER_')) throw error; fail('DONOR_LEDGER_UNAVAILABLE'); }
  }
  async function ready() {
    if (initialized) { healthy(); return; }
    await reload();
    await ensureCapacity();
    initialized = true;
  }
  function append(event) {
    healthy();
    if (!initialized) fail('DONOR_LEDGER_NOT_READY');
    if (!event || typeof event.type !== 'string' || !event.type || event.type.length > 80) fail('DONOR_LEDGER_EVENT_INVALID');
    if (!available.length || events.size >= maxEvents) fail('DONOR_LEDGER_CAPACITY');
    const full = freeze(structuredClone({ ...event, ts: now().toISOString(), seq: available.shift() }));
    merge(full);
    pending.push(full);
    index();
    return full;
  }
  function flush() {
    const next = flushing.then(async () => {
      healthy();
      const batch = pending.slice();
      if (!batch.length) return 0;
      try { await store.appendEvents({ events: batch }); }
      catch { poisoned = true; fail('DONOR_LEDGER_UNAVAILABLE'); }
      pending = pending.slice(batch.length);
      return batch.length;
    });
    flushing = next.catch(() => {});
    return next;
  }
  return { append, ready, ensureCapacity, flush, reload,
    byCall: (id) => (byCall.get(id) ?? []).slice(), byType: (type) => (byType.get(type) ?? []).slice(),
    all: () => [...events.values()].sort((a, b) => a.seq - b.seq),
    since: (at) => [...events.values()].filter((event) => event.ts >= at).sort((a, b) => a.seq - b.seq),
    path: 'postgres-donor-events', durable: true,
  };
}
