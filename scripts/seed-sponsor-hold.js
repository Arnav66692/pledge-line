// The sponsor's one consent for Covered Month, in the browser. Never prints the client secret or a token.
//   npm run seed:hold                 makes an AUTHORIZE order for $200 and prints the link the sponsor approves
//   npm run seed:hold -- --amount 100 the same, for another amount
//   npm run seed:hold -- --authorize  turns the approved order into the hold, and saves its id in .pilot/state.json
//   npm run seed:hold -- --check      what PayPal shows for the hold now
// A hold lasts 29 days, and PayPal advises capturing inside its 3-day honor period, so seed it within 3 days of filming.
import fs from 'node:fs';
import { loadConfig, assertReady } from '../src/config.js';
import { createPayPal, PayPalError } from '../src/paypal.js';

const DEFAULT_AMOUNT = '200.00';
const args = process.argv.slice(2);
const out = (line = '') => process.stdout.write(`${line}\n`);
const amountFlag = args.includes('--amount') ? args[args.indexOf('--amount') + 1] : DEFAULT_AMOUNT;

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const saveState = (file, patch) => fs.writeFileSync(file, `${JSON.stringify({ ...readState(file), ...patch }, null, 2)}\n`);

async function makeOrder(config, paypal) {
  assertReady(config, { need: ['publicUrl'] });
  const amountValue = Number(amountFlag).toFixed(2);
  if (!(Number(amountValue) > 0)) throw new Error('--amount must be an amount above zero');
  const returnUrl = `${config.publicBaseUrl}/`;
  const order = await paypal.createSponsorOrder({ amountValue, currency: config.currency, description: `Hardship fund for ${config.orgName}`, brandName: config.orgName, returnUrl, cancelUrl: returnUrl });
  saveState(config.stateFile, { sponsorOrderId: order.id });
  out(`Order ${order.id}, status ${order.status}, debug id ${order.debugId}`);
  out('Open this link, log in as a sandbox personal account for the sponsor, and approve it. That is the sponsor\'s one consent.');
  out(order.approveUrl ?? 'PayPal returned no approve link.');
  out('Then run npm run seed:hold -- --authorize.');
}

async function authorize(config, paypal) {
  const { sponsorOrderId } = readState(config.stateFile);
  if (!sponsorOrderId) throw new Error(`${config.stateFile} has no sponsorOrderId. Run npm run seed:hold first.`);
  const hold = await paypal.authorizeSponsorOrder(sponsorOrderId);
  if (!hold.holdId) throw new Error(`PayPal returned no authorization id. Debug id ${hold.debugId}`);
  saveState(config.stateFile, { sponsorHoldId: hold.holdId });
  out(`Hold ${hold.holdId}, status ${hold.status}, expires ${hold.expirationTime ?? 'not given'}, debug id ${hold.debugId}`);
  out(`Saved in ${config.stateFile}. On Render, set SPONSOR_HOLD_ID to this id.`);
}

async function check(config, paypal) {
  if (!config.cover.holdId) throw new Error('No hold yet. Set SPONSOR_HOLD_ID or run npm run seed:hold -- --authorize.');
  const res = await paypal.getSponsorHold(config.cover.holdId);
  if (res.notFound) throw new Error(`PayPal has no hold ${config.cover.holdId}. Debug id ${res.debugId}`);
  out(`Hold ${res.data.id}, status ${res.data.status}, amount ${res.data.amount?.value} ${res.data.amount?.currency_code}, expires ${res.data.expiration_time ?? 'not given'}, debug id ${res.debugId}`);
}

async function main() {
  const config = loadConfig(process.env, { partial: true });
  assertReady(config, { need: ['paypal'] });
  // No token store is passed, so this client cannot run any donor-facing write.
  const paypal = createPayPal({ baseUrl: config.paypal.baseUrl, clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret });
  if (args.includes('--authorize')) await authorize(config, paypal);
  else if (args.includes('--check')) await check(config, paypal);
  else await makeOrder(config, paypal);
}

main().catch((error) => {
  const debug = error instanceof PayPalError && error.debugId ? `, debug id ${error.debugId}` : '';
  process.stderr.write(`${error.message}${debug}\n`);
  process.exitCode = 1;
});
