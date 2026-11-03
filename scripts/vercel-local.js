// Runs the Vercel function locally with plain node, no vercel dev. It plays Vercel's proxy, so X-Forwarded-For is
// set to the caller's address and anything a client sent there is dropped, as Vercel does.
// VERCEL=1 LEDGER_PATH=/tmp/pledge-line-demo/ledger.jsonl PORT=3871 node scripts/vercel-local.js
import http from 'node:http';
import { Readable } from 'node:stream';
import demo from '../api/index.js';

const port = Number(process.env.PORT ?? 3871);

function toRequest(req) {
  const headers = { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress ?? 'unknown' };
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  return new Request(`http://${req.headers.host ?? `127.0.0.1:${port}`}${req.url}`, {
    method: req.method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const response = await demo.fetch(toRequest(req));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    process.stderr.write(`vercel-local failed ${error?.message ?? error}\n`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(port, '127.0.0.1', () => process.stdout.write(`Vercel demo function on http://127.0.0.1:${port}\n`));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
