// Start with a private environment file. Never paste tokens into command arguments or logs.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSupplierProtocol } from '../src/supplier-protocol.js';

let server;
try {
  const number = (name, fallback) => process.env[name] === undefined ? fallback : Number(process.env[name]);
  const port = number('MCP_SUPPLIER_PORT', 3160), host = process.env.MCP_SUPPLIER_HOST ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !['127.0.0.1', '::1', '0.0.0.0'].includes(host)) throw new Error('Invalid listener.');
  const file = process.env.MCP_QUOTES_PATH ? path.resolve(process.env.MCP_QUOTES_PATH) : null;
  let quotes = new Map();
  if (file) {
    try {
      const stat = await fs.stat(file);
      if (stat.size > 2000000) throw new Error('Quote file too large.');
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Array.isArray(data) || data.length > 2000) throw new Error('Invalid quote file.');
      quotes = new Map(data);
    } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  }
  let writing = Promise.resolve();
  const persist = file ? ({ entries }) => {
    const write = writing.then(async () => {
      const temporary = `${file}.${randomUUID()}.pending`;
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(entries)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, file);
      const parent = await fs.open(path.dirname(file), 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    });
    writing = write.catch(() => {}); return write;
  } : undefined;
  const protocol = createSupplierProtocol({ id: process.env.MCP_SUPPLIER_ID ?? 'sandbox-campus-print',
    name: process.env.MCP_SUPPLIER_NAME ?? 'Controlled sandbox print supplier', payeeId: process.env.PAYPAL_SANDBOX_MERCHANT_ID,
    token: process.env.MCP_SUPPLIER_TOKEN, capacity: number('MCP_SUPPLIER_CAPACITY', 60), unitPriceCents: number('MCP_SUPPLIER_UNIT_CENTS', 650),
    floorUnitPriceCents: number('MCP_SUPPLIER_FLOOR_CENTS', 600), setupCents: number('MCP_SUPPLIER_SETUP_CENTS', 1000),
    shippingCents: number('MCP_SUPPLIER_SHIPPING_CENTS', 800), taxBps: number('MCP_SUPPLIER_TAX_BPS', 500), leadDays: number('MCP_SUPPLIER_LEAD_DAYS', 2), quotes, persist });
  server = http.createServer((req, res) => { protocol.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"Supplier is unavailable."}'); }); });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  server.listen(port, host, () => process.stdout.write(`Controlled sandbox supplier listening on port ${port}. No real fulfillment or payment.\n`));
  server.on('error', () => { process.stderr.write('SUPPLIER_STARTUP_FAILED. Verify private configuration and port availability.\n'); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
} catch {
  process.stderr.write('SUPPLIER_STARTUP_FAILED. Verify private configuration without printing credentials.\n');
  process.exitCode = 1;
}
