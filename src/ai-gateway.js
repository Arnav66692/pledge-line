import { randomUUID } from 'node:crypto';

const BODY_LIMIT = 64 * 1024;
const MODELS = Object.freeze({ anthropic: { model: 'claude-sonnet-5-5', input: 2_000, output: 10_000 }, jev: { model: 'jev-1.14.0', input: 42, output: 0 } });
const VISUAL_REVIEW = Object.freeze({ ...MODELS.anthropic, bodyLimit: 96 * 1024 });
const VISUAL_REVIEW_CAP_NANOS = 1_000_000_000;
// Published Haiku 5.5 short-prompt price is $0.10/$0.50 per million input/output tokens.
// Reserve at the higher $0.50/$2.50 tier even though this fixed smoke cannot approach 100k input tokens.
// https://platform.claude.com/docs/en/models/haiku-5-5/overview, checked November 4, 2026.
const HAIKU_SMOKE = Object.freeze({ model: 'claude-haiku-5-5', input: 100, output: 500, reserveInput: 500, reserveOutput: 2500, inputCeiling: 100000 });
const SMOKE_CAP_NANOS = 10_000_000;
const ENDPOINTS = Object.freeze({ anthropic: 'https://api.anthropic.com/v1/messages', jev: 'https://api.typesafe.ai/v1/systemone' });
export class AiGatewayError extends Error {
  constructor(code, provider = null) { super(code); this.name = 'AiGatewayError'; this.code = code; this.provider = provider; }
}
const fail = (code, provider) => { throw new AiGatewayError(code, provider); };
function encode(value, maximum = BODY_LIMIT) {
  let encoded;
  try {
    encoded = JSON.stringify(value, (_key, item) => {
      if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof item) || (typeof item === 'number' && !Number.isFinite(item))) throw Error('Not JSON');
      return item;
    });
  } catch { fail('AI_INVALID_INPUT'); }
  if (!encoded || Buffer.byteLength(encoded) > maximum) fail('AI_INPUT_TOO_LARGE');
  return encoded;
}
function reviewImage(source) {
  if (!source || source.type !== 'base64' || source.media_type !== 'image/jpeg' || typeof source.data !== 'string' ||
    Object.keys(source).some((key) => !['type', 'media_type', 'data'].includes(key)) || source.data.length > 32768) fail('AI_INVALID_INPUT');
  const bytes = Buffer.from(source.data, 'base64');
  if (bytes.length > 24 * 1024 || bytes.toString('base64') !== source.data || bytes[0] !== 255 || bytes[1] !== 216 ||
    bytes.at(-2) !== 255 || bytes.at(-1) !== 217) fail('AI_INVALID_INPUT');
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 255) fail('AI_INVALID_INPUT');
    while (bytes[offset] === 255) offset += 1;
    const marker = bytes[offset++];
    if (marker === 218 || marker === 217) break;
    if (marker === 1 || marker >= 208 && marker <= 215) continue;
    if (offset + 2 > bytes.length) fail('AI_INVALID_INPUT');
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) fail('AI_INVALID_INPUT');
    if ([192, 194].includes(marker)) {
      if (length < 8) fail('AI_INVALID_INPUT');
      const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
      if (!width || !height || width > 1280 || height > 1280 || width * height > 1_000_000) fail('AI_INVALID_INPUT');
      return bytes.length;
    }
    offset += length;
  }
  fail('AI_INVALID_INPUT');
}

function validateAnthropic(body, visual = false) {
  if (typeof body.system !== 'string' || !body.system.trim() || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 20) fail('AI_INVALID_INPUT');
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 2048) fail('AI_INVALID_INPUT');
  let images = 0, imageBytes = 0;
  for (const message of body.messages) {
    if (!message || !['user', 'assistant'].includes(message.role)) fail('AI_INVALID_INPUT');
    if (typeof message.content === 'string') continue;
    if (!Array.isArray(message.content) || !message.content.length) fail('AI_INVALID_INPUT');
    for (const block of message.content) {
      if (block?.type === 'text' && typeof block.text === 'string' && Object.keys(block).every((key) => ['type', 'text'].includes(key))) continue;
      if (visual && message.role === 'user' && block?.type === 'image' && Object.keys(block).every((key) => ['type', 'source'].includes(key))) {
        imageBytes += reviewImage(block.source); images += 1;
        if (images > 3 || imageBytes > 48 * 1024) fail('AI_INVALID_INPUT');
        continue;
      }
      // Normal application requests remain text/tool-only. No remote media or server tools.
      if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && block.input && typeof block.input === 'object' && Object.keys(block).every((key) => ['type', 'id', 'name', 'input'].includes(key))) continue;
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && typeof block.content === 'string' && Object.keys(block).every((key) => ['type', 'tool_use_id', 'content', 'is_error'].includes(key))) continue;
      fail('AI_INVALID_INPUT');
    }
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 8 || body.tools.some((tool) => !tool || typeof tool.name !== 'string' || !tool.input_schema || (tool.type !== undefined && tool.type !== 'custom') || 'cache_control' in tool))) fail('AI_INVALID_INPUT');
  if (body.tool_choice && (body.tool_choice.type !== 'auto' || Object.keys(body.tool_choice).some((key) => !['type', 'disable_parallel_tool_use'].includes(key)))) fail('AI_INVALID_INPUT');
  // A cache_control hidden in a nested schema/message cannot silently alter the cost contract.
  if (/"cache_control"\s*:/.test(encode(body, visual ? VISUAL_REVIEW.bodyLimit : BODY_LIMIT))) fail('AI_INVALID_INPUT');
  if (visual && images < 1) fail('AI_INVALID_INPUT');
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
function usageCost(provider, payload, inputBound, outputBound, rate = MODELS[provider]) {
  const usage = payload?.usage;
  if (payload?.model !== rate.model) fail('AI_PRICING_MISMATCH', provider);
  if (!usage || !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0 || usage.input_tokens > inputBound ||
      !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0 || (provider === 'anthropic' && usage.output_tokens > outputBound) ||
      (usage.cache_creation_input_tokens ?? 0) !== 0 || (usage.cache_read_input_tokens ?? 0) !== 0) fail('AI_USAGE_UNVERIFIED', provider);
  const cost = usage.input_tokens * rate.input + usage.output_tokens * rate.output;
  if (!Number.isSafeInteger(cost)) fail('AI_USAGE_UNVERIFIED', provider);
  return cost;
}

function reservation(provider, body, rate) {
  // Visual review is a separate bounded path. Its conservative reservation includes
  // encoded bytes plus an extra 8192 input tokens per dimension-limited JPEG.
  const images = rate === VISUAL_REVIEW ? body.messages.reduce((count, message) => count +
    (Array.isArray(message.content) ? message.content.filter((block) => block.type === 'image').length : 0), 0) : 0;
  const inputBound = Buffer.byteLength(encode(body, rate.bodyLimit ?? BODY_LIMIT)) * 4 + 8192 + images * 8192;
  const outputBound = provider === 'anthropic' ? body.max_tokens : 0;
  if (rate.inputCeiling && inputBound > rate.inputCeiling) fail('AI_SMOKE_CAP_EXCEEDED', provider);
  const maxCostNanos = inputBound * (rate.reserveInput ?? rate.input) + outputBound * (rate.reserveOutput ?? rate.output);
  return { inputBound, outputBound, maxCostNanos };
}

/** Only explicit API keys and fixed API hosts are accepted. No SDK credential chain, OAuth, cookies or retry exists. */
export function createAiGateway({ budget, anthropicApiKey, jevApiKey, fetchImpl = globalThis.fetch,
  anthropicModel = MODELS.anthropic.model, jevModel = MODELS.jev.model, timeoutMs = 30000 } = {}) {
  if (!budget || ['reserve', 'checkDispatch', 'settle', 'trip', 'status'].some((method) => typeof budget[method] !== 'function')) fail('AI_STORAGE_REQUIRED');
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
  async function dispatch(provider, body, rate = MODELS[provider], capNanos = null) {
    if (locallyStopped) fail('AI_STOPPED', provider);
    const key = keys[provider];
    if (typeof key !== 'string' || !key.trim() || /\s/.test(key) || (provider === 'anthropic' && key.startsWith('sk-ant-oat'))) fail('AI_API_KEY_REQUIRED', provider);
    const priced = rate === MODELS[provider] ? models[provider] === rate.model : provider === 'anthropic' &&
      (rate === HAIKU_SMOKE || rate === VISUAL_REVIEW && models[provider] === rate.model);
    if (!priced) fail('AI_UNPRICED_MODEL', provider);
    if (body.model !== rate.model) fail('AI_UNPRICED_MODEL', provider);
    const encoded = encode(body, rate.bodyLimit ?? BODY_LIMIT);
    const { inputBound, outputBound, maxCostNanos } = reservation(provider, body, rate);
    if (capNanos !== null && maxCostNanos > capNanos) fail(rate === VISUAL_REVIEW ? 'AI_VISUAL_CAP_EXCEEDED' : 'AI_SMOKE_CAP_EXCEEDED', provider);
    const requestId = randomUUID();
    let permission;
    try { permission = await budget.reserve({ provider, requestId, maxCostNanos }); }
    catch { haltLocal(); fail('AI_STORAGE_UNAVAILABLE', provider); }
    if (!permission?.allowed) {
      if (permission?.stopped) haltLocal();
      fail(permission?.stopped ? 'AI_STOPPED' : permission?.reason === 'request_in_progress' ? 'AI_BUSY' : 'AI_REQUEST_BLOCKED', provider);
    }
    // A peer may have tripped the circuit or settled this claim before dispatch. Re-read the
    // durable matching reservation and latched stop, without hydrating the whole budget view.
    let dispatchPermission;
    try { dispatchPermission = await budget.checkDispatch({ provider, requestId, maxCostNanos }); }
    catch { haltLocal(); fail('AI_STORAGE_UNAVAILABLE', provider); }
    if (!dispatchPermission?.allowed) {
      haltLocal();
      fail(dispatchPermission?.stopped ? 'AI_STOPPED' : 'AI_REQUEST_BLOCKED', provider);
    }
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
      try { costNanos = usageCost(provider, payload, inputBound, outputBound, rate); }
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
  function enqueue(provider, body, rate = MODELS[provider], capNanos = null) {
    if (locallyStopped) return Promise.reject(new AiGatewayError('AI_STOPPED', provider));
    if (queued >= 16) return Promise.reject(new AiGatewayError('AI_BUSY', provider));
    queued += 1;
    const task = queue.then(() => dispatch(provider, body, rate, capNanos));
    queue = task.catch(() => {});
    return task.finally(() => { queued -= 1; });
  }
  return {
    async anthropicSmoke() {
      // The narrow probe is intentionally not a general Haiku model selector or prepaid-billing attestation.
      const body = { model: HAIKU_SMOKE.model, system: 'Return exactly OK.', messages: [{ role: 'user', content: 'Reply OK.' }],
        max_tokens: 8, thinking: { type: 'disabled' }, output_config: { effort: 'low' } };
      validateAnthropic(body);
      const estimate = reservation('anthropic', body, HAIKU_SMOKE);
      if (estimate.maxCostNanos > SMOKE_CAP_NANOS) fail('AI_SMOKE_CAP_EXCEEDED', 'anthropic');
      const response = await enqueue('anthropic', body, HAIKU_SMOKE, SMOKE_CAP_NANOS);
      return { response, accounting: { reservedMaxNanos: estimate.maxCostNanos,
        estimatedChargeNanos: usageCost('anthropic', response, estimate.inputBound, estimate.outputBound, HAIKU_SMOKE),
        authorizedCapNanos: SMOKE_CAP_NANOS, providerBalanceVerified: false,
        pricingSource: 'https://platform.claude.com/docs/en/models/haiku-5-5/overview' } };
    },
    anthropic({ system, messages, tools, tool_choice, max_tokens = 1024 } = {}) {
      const body = JSON.parse(encode({ model: anthropicModel, system, messages, max_tokens, thinking: { type: 'between_tools' }, output_config: { effort: 'low' },
        ...(tools !== undefined ? { tools } : {}), ...(tool_choice !== undefined ? { tool_choice } : {}) }));
      validateAnthropic(body);
      return enqueue('anthropic', body);
    },
    anthropicVisualReview({ system, messages, tools, tool_choice, max_tokens = 1024 } = {}) {
      const body = JSON.parse(encode({ model: anthropicModel, system, messages, max_tokens,
        thinking: { type: 'between_tools' }, output_config: { effort: 'low' },
        ...(tools !== undefined ? { tools } : {}), ...(tool_choice !== undefined ? { tool_choice } : {}) }, VISUAL_REVIEW.bodyLimit));
      validateAnthropic(body, true);
      return enqueue('anthropic', body, VISUAL_REVIEW, VISUAL_REVIEW_CAP_NANOS);
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
