import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const SESSION_PATH = /^\/api\/procurement\/([0-9a-f-]{36})(?:\/(approve|reconcile))?$/;
const TTL_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 500;
const digest = (value) => createHash('sha256').update(value).digest();

/** Session authority is independent of the quote confirmation token and never appears in a comparison or receipt. */
export function createProcurementHttp({ createService, send, readJson, limiter, now = () => Date.now() }) {
  const sessions = new Map();
  function expire() {
    for (const [id, session] of sessions) if (session.expiresAt <= now()) sessions.delete(id);
  }
  function error(res, status, message) { send(res, status, { error: message }); }

  return async function procurementRoute(req, res, pathname, ip) {
    if (!limiter.allow(ip)) return error(res, 429, 'Please wait before trying the supply desk again.');
    expire();
    try {
      if (pathname === '/api/procurement') {
        if (req.method !== 'POST') return error(res, 405, 'Method not allowed.');
        if (sessions.size >= MAX_SESSIONS) return error(res, 503, 'The supply desk is busy. Please try again later.');
        const body = await readJson(req);
        const service = await createService(body.scenario ?? 'normal');
        const state = await service.request(body.rfq ?? body);
        const secret = randomBytes(32).toString('base64url');
        sessions.set(state.id, { service, secretHash: digest(secret), expiresAt: now() + TTL_MS });
        return send(res, 201, { id: state.id, sessionSecret: secret, state });
      }
      const match = pathname.match(SESSION_PATH);
      if (!match) return error(res, 404, 'That supply request was not found.');
      const [, id, action] = match;
      const session = sessions.get(id);
      const secret = req.headers['x-procurement-secret'];
      if (!session || typeof secret !== 'string' || secret.length > 200 || !timingSafeEqual(session.secretHash, digest(secret))) {
        return error(res, 401, 'This supply request needs its session key. Start a new request on this page.');
      }
      if (!action) {
        if (req.method !== 'GET') return error(res, 405, 'Method not allowed.');
        return send(res, 200, { id, state: await session.service.get(id) });
      }
      if (req.method !== 'POST') return error(res, 405, 'Method not allowed.');
      const body = await readJson(req);
      const state = action === 'approve'
        ? await session.service.approve(id, { confirmationToken: body.confirmationToken, termsHash: body.termsHash })
        : await session.service.reconcile(id);
      return send(res, 200, { id, state });
    } catch (cause) {
      // Only public validation errors cross this boundary. Database/provider errors never expose credentials or SQL.
      const status = Number.isInteger(cause?.status) && cause.status >= 400 && cause.status < 500 ? cause.status : 503;
      return error(res, status, status < 500 ? 'The request or approval is invalid or expired. Please review the terms and try again.' : 'The supply desk could not verify this step. No new payment will be attempted until it is checked again.');
    }
  };
}
