import { randomUUID } from 'node:crypto';

const BODY_LIMIT = 64 * 1024;
const MODELS = Object.freeze({ anthropic: { model: 'claude-sonnet-5-5', input: 2_000, output: 10_000 }, jev: { model: 'jev-1.14.0', input: 42, output: 0 } });
const ENDPOINTS = Object.freeze({ anthropic: 'https://api.anthropic.com/v1/messages', jev: 'https://api.typesafe.ai/v1/systemone' });
export class AiGatewayError extends Error {
  constructor(code, provider = null) { super(code); this.name = 'AiGatewayError'; this.code = code; this.provider = provider; }
}
const fail = (code, provider) => { throw new AiGatewayError(code, provider); };
function encode(value) {
  let encoded;
  try {
    encoded = JSON.stringify(value, (_key, item) => {
      if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof item) || (typeof item === 'number' && !Number.isFinite(item))) throw Error('Not JSON');
      return item;
    });
  } catch { fail('AI_INVALID_INPUT'); }
  if (!encoded || Buffer.byteLength(encoded) > BODY_LIMIT) fail('AI_INPUT_TOO_LARGE');
  return encoded;
}
function validateAnthropic(body) {
  if (typeof body.system !== 'string' || !body.system.trim() || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 20) fail('AI_INVALID_INPUT');
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 2048) fail('AI_INVALID_INPUT');
  for (const message of body.messages) {
    if (!message || !['user', 'assistant'].includes(message.role)) fail('AI_INVALID_INPUT');
    if (typeof message.content === 'string') continue;
    if (!Array.isArray(message.content) || !message.content.length) fail('AI_INVALID_INPUT');
    for (const block of message.content) {
      if (block?.type === 'text' && typeof block.text === 'string' && Object.keys(block).every((key) => ['type', 'text'].includes(key))) continue;
      // No remote documents, images, prompt caching or billable server tools are exposed by this gateway.
      if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && block.input && typeof block.input === 'object' && Object.keys(block).every((key) => ['type', 'id', 'name', 'input'].includes(key))) continue;
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && typeof block.content === 'string' && Object.keys(block).every((key) => ['type', 'tool_use_id', 'content', 'is_error'].includes(key))) continue;
      fail('AI_INVALID_INPUT');
    }
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 8 || body.tools.some((tool) => !tool || typeof tool.name !== 'string' || !tool.input_schema || (tool.type !== undefined && tool.type !== 'custom') || 'cache_control' in tool))) fail('AI_INVALID_INPUT');
  if (body.tool_choice && (body.tool_choice.type !== 'auto' || Object.keys(body.tool_choice).some((key) => !['type', 'disable_parallel_tool_use'].includes(key)))) fail('AI_INVALID_INPUT');
  // A cache_control hidden in a nested schema/message cannot silently alter the cost contract.
  if (/"cache_control"\s*:/.test(encode(body))) fail('AI_INVALID_INPUT');
}
async function boundedText(response) {
  if (Number(response.headers?.get?.('content-length')) > BODY_LIMIT) fail('AI_RESPONSE_TOO_LARGE');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > BODY_LIMIT) fail('AI_RESPONSE_TOO_LARGE');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) { await reader.cancel().catch(() => {}); fail('AI_RESPONSE_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
function usageCost(provider, payload, inputBound, outputBound) {
  const rate = MODELS[provider];
  const usage = payload?.usage;
  if (payload?.model !== rate.model) fail('AI_PRICING_MISMATCH', provider);
  if (!usage || !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0 || usage.input_tokens > inputBound ||
      !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0 || (provider === 'anthropic' && usage.output_tokens > outputBound) ||
      (usage.cache_creation_input_tokens ?? 0) !== 0 || (usage.cache_read_input_tokens ?? 0) !== 0) fail('AI_USAGE_UNVERIFIED', provider);
  const cost = usage.input_tokens * rate.input + usage.output_tokens * rate.output;
  if (!Number.isSafeInteger(cost)) fail('AI_USAGE_UNVERIFIED', provider);
  return cost;
}

/** Only explicit API keys and fixed API hosts are accepted. No SDK credential chain, OAuth, cookies or retry exists. */
export function createAiGateway({ budget, anthropicApiKey, jevApiKey, fetchImpl = globalThis.fetch,
  anthropicModel = MODELS.anthropic.model, jevModel = MODELS.jev.model, timeoutMs = 12000 } = {}) {
  if (!budget || ['reserve', 'settle', 'trip', 'status'].some((method) => typeof budget[method] !== 'function')) fail('AI_STORAGE_REQUIRED');
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) fail('AI_INVALID_INPUT');
  const keys = { anthropic: anthropicApiKey, jev: jevApiKey };
  const models = { anthropic: anthropicModel, jev: jevModel };
  const controllers = new Set();
  let locallyStopped = false;
  let queue = Promise.resolve();
  let queued = 0;
  const haltLocal = () => { locallyStopped = true; for (const controller of controllers) controller.abort(); };
  async function trip(reason, provider) {
    haltLocal();
    try { await budget.trip({ reason, provider }); } catch { /* Local stop stays latched; the unresolved durable reservation also blocks dispatch. */ }
  }
  async function dispatch(provider, body) {
    if (locallyStopped) fail('AI_STOPPED', provider);
    const key = keys[provider];
    if (typeof key !== 'string' || !key.trim() || /\s/.test(key) || (provider === 'anthropic' && key.startsWith('sk-ant-oat'))) fail('AI_API_KEY_REQUIRED', provider);
    if (models[provider] !== MODELS[provider].model) fail('AI_UNPRICED_MODEL', provider);
    const encoded = encode(body);
    const inputBound = Buffer.byteLength(encoded) * 4 + 8192;
    const outputBound = provider === 'anthropic' ? body.max_tokens : 0;
    const maxCostNanos = inputBound * MODELS[provider].input + outputBound * MODELS[provider].output;
    const requestId = randomUUID();
    let permission;
    try { permission = await budget.reserve({ provider, requestId, maxCostNanos }); }
    catch { haltLocal(); fail('AI_STORAGE_UNAVAILABLE', provider); }
    if (!permission?.allowed) {
      if (permission?.stopped) haltLocal();
      fail(permission?.stopped ? 'AI_STOPPED' : permission?.reason === 'request_in_progress' ? 'AI_BUSY' : 'AI_REQUEST_BLOCKED', provider);
    }
    // A peer may have tripped the shared circuit while this request waited for dispatch.
    try { if ((await budget.status()).stopped) { haltLocal(); fail('AI_STOPPED', provider); } }
    catch (error) { if (error instanceof AiGatewayError) throw error; haltLocal(); fail('AI_STORAGE_UNAVAILABLE', provider); }
    if (locallyStopped) fail('AI_STOPPED', provider);
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(ENDPOINTS[provider], { method: 'POST', redirect: 'error', credentials: 'omit', signal: controller.signal,
        headers: provider === 'anthropic'
          ? { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
          : { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: encoded });
      const text = await boundedText(response);
      if (!response.ok) {
        const billing = response.status === 402 || /\b(credit balance|insufficient (credit|fund)|out of credit|credits? (exhausted|depleted)|balance.{0,20}(zero|insufficient|too low)|billing|quota (exceeded|exhausted))\b/i.test(text);
        if (billing || response.status === 401 || response.status === 403) {
          await trip(billing ? 'credit_exhausted' : 'authentication_failed', provider);
          fail('AI_STOPPED', provider);
        }
        // No usage proof means the conservative reservation remains occupied. Never silently retry or switch provider.
        await trip('usage_unverified', provider);
        fail(response.status === 429 ? 'AI_RATE_LIMITED' : 'AI_PROVIDER_FAILED', provider);
      }
      let payload;
      try { payload = JSON.parse(text); } catch { await trip('usage_unverified', provider); fail('AI_RESPONSE_INVALID', provider); }
      let costNanos;
      try { costNanos = usageCost(provider, payload, inputBound, outputBound); }
      catch (error) { await trip(error.code === 'AI_PRICING_MISMATCH' ? 'pricing_mismatch' : 'usage_unverified', provider); throw error; }
      let settlement;
      try { settlement = await budget.settle({ requestId, costNanos }); }
      catch { haltLocal(); fail('AI_STORAGE_UNAVAILABLE', provider); }
      if (settlement?.settled !== true) { haltLocal(); fail('AI_STORAGE_UNAVAILABLE', provider); }
      if (settlement?.stopped) haltLocal();
      return payload;
    } catch (error) {
      if (error instanceof AiGatewayError) {
        if (!locallyStopped) await trip('usage_unverified', provider);
        throw error;
      }
      const interrupted = controller.signal.aborted;
      await trip('usage_unverified', provider);
      fail(interrupted ? 'AI_REQUEST_INTERRUPTED' : 'AI_PROVIDER_UNAVAILABLE', provider);
    } finally { clearTimeout(timer); controllers.delete(controller); }
  }
  function enqueue(provider, body) {
    if (locallyStopped) return Promise.reject(new AiGatewayError('AI_STOPPED', provider));
    if (queued >= 16) return Promise.reject(new AiGatewayError('AI_BUSY', provider));
    queued += 1;
    const task = queue.then(() => dispatch(provider, body));
    queue = task.catch(() => {});
    return task.finally(() => { queued -= 1; });
  }
  return {
    anthropic({ system, messages, tools, tool_choice, max_tokens = 1024 } = {}) {
      const body = JSON.parse(encode({ model: anthropicModel, system, messages, max_tokens, thinking: { type: 'between_tools' }, output_config: { effort: 'low' },
        ...(tools !== undefined ? { tools } : {}), ...(tool_choice !== undefined ? { tool_choice } : {}) }));
      validateAnthropic(body);
      return enqueue('anthropic', body);
    },
    jev({ state, questions } = {}) {
      if ((typeof state !== 'string' && (!state || typeof state !== 'object' || Array.isArray(state))) || !questions || typeof questions !== 'object' || Array.isArray(questions) || !Object.keys(questions).length || Object.keys(questions).length > 8) fail('AI_INVALID_INPUT');
      const body = JSON.parse(encode({ model: jevModel, state, questions }));
      return enqueue('jev', body);
    },
    async status() {
      let status;
      try { status = await budget.status(); } catch { haltLocal(); fail('AI_STORAGE_UNAVAILABLE'); }
      if (status.stopped) haltLocal();
      return { ...status, stopped: status.stopped || locallyStopped, apiKeyOnly: true, autoRechargeManagedByProvider: true,
        providerBalanceVerified: false, credentialsConfigured: { anthropic: typeof anthropicApiKey === 'string' && Boolean(anthropicApiKey.trim()), jev: typeof jevApiKey === 'string' && Boolean(jevApiKey.trim()) } };
    },
  };
}
