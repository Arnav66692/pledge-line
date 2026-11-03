// The public Vercel demo. Vercel hands the function a Web Request, and this turns it into the Node request and
// response that src/server.js already answers, so every route, file, header and limit is the local server's own.
// It runs only with mock PayPal and the rules router. The graded pilot stays on Render.
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { loadConfig } from './config.js';
import { buildDeps, createHandler, createLogger, templateWarnings, SECURITY_HEADERS } from './server.js';

// The local server sweeps every 30 seconds. A function has no timer between requests, so a request starts the sweep.
const SWEEP_EVERY_MS = 30000;
const NO_BODY = new Set(['GET', 'HEAD']);

/** A Node style request over the body bytes. The caller's address comes from X-Forwarded-For, which Vercel sets. */
export function nodeRequest(request, body) {
  const url = new URL(request.url);
  const req = Readable.from(body.length > 0 ? [body] : [], { objectMode: false });
  req.method = request.method;
  req.url = `${url.pathname}${url.search}`;
  req.headers = Object.fromEntries(request.headers);
  req.socket = { remoteAddress: 'unknown' };
  return req;
}

/** A Node style response that resolves `done` with a Web Response when the handler ends it. */
export function nodeResponse() {
  const res = new EventEmitter();
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  let headers = {};
  res.statusCode = 200;
  res.headersSent = false;
  res.writeHead = (status, head = {}) => {
    res.statusCode = status;
    headers = { ...head };
    res.headersSent = true;
    return res;
  };
  res.end = (payload) => {
    if (!res.headersSent) res.writeHead(res.statusCode);
    const body = payload === undefined || payload === null ? null : payload;
    finish(new Response(body, { status: res.statusCode, headers }));
    res.emit('finish');
    return res;
  };
  return { res, done };
}

function refusal() {
  return new Response(JSON.stringify({ error: 'The demo is not set up right. Its log says why.' }), {
    status: 500,
    headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * Builds the deps once per instance, on the first request, and answers every request with the local server's
 * handler. A config that is not the demo's mock and rules never builds, so no sandbox client can start here.
 */
export function createVercelHandler({ env = process.env, overrides = {} } = {}) {
  const log = overrides.log ?? createLogger();
  let ready = null;
  let lastSweep = 0;

  function setup() {
    const config = loadConfig(env);
    if (config.paypal.mode !== 'mock' || config.router.mode !== 'rules') {
      throw new Error('The Vercel demo runs only with PAYPAL_MODE mock and ROUTER_MODE rules');
    }
    const deps = buildDeps(config, { ...overrides, log });
    for (const warning of templateWarnings()) log.error(warning);
    log.info(`Pledge Line demo ready, PayPal ${config.paypal.mode}, router ${config.router.mode}`);
    return { deps, handle: createHandler(deps) };
  }

  function instance() {
    if (!ready) {
      try {
        ready = { ok: setup() };
      } catch (error) {
        ready = { error };
        log.error(`demo refused to start ${error?.message ?? error}`);
      }
    }
    return ready.ok ?? null;
  }

  function sweepNow(deps) {
    const at = deps.now().getTime();
    if (at - lastSweep < SWEEP_EVERY_MS) return;
    lastSweep = at;
    deps.calls.sweep().catch((error) => log.error(`sweep failed ${error?.name ?? 'Error'}`));
  }

  return async function handleRequest(request) {
    const live = instance();
    if (!live) return refusal();
    sweepNow(live.deps);
    const body = NO_BODY.has(request.method) ? Buffer.alloc(0) : Buffer.from(await request.arrayBuffer());
    const { res, done } = nodeResponse();
    await live.handle(nodeRequest(request, body), res);
    return done;
  };
}
