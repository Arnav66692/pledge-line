// Sets up the PayPal sandbox for the pilot. Never prints the client secret or a token.
//   npm run seed                      product, $25 monthly plan and a subscription to approve
//   npm run seed -- --check           status of the seeded subscription
//   npm run seed -- --webhook URL     registers the Render webhook, or reuses one with the same URL
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, assertReady } from '../src/config.js';
import { createPayPal, PayPalError } from '../src/paypal.js';

const PRICE = '25.00';
const EVENT_TYPES = ['INVOICING.INVOICE.PAID', 'BILLING.SUBSCRIPTION.SUSPENDED', 'BILLING.SUBSCRIPTION.ACTIVATED', 'BILLING.SUBSCRIPTION.CANCELLED'];
const args = process.argv.slice(2);
const out = (line = '') => process.stdout.write(`${line}\n`);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function client(config) {
  // No token store is passed, so this client cannot run any donor-facing write.
  return createPayPal({ baseUrl: config.paypal.baseUrl, clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret });
}

async function seed(config) {
  assertReady(config, { need: ['paypal', 'publicUrl'] });
  const existing = readState(config.stateFile);
  if (existing.subscriptionId && !args.includes('--force')) {
    out(`${config.stateFile} already has subscription ${existing.subscriptionId}. Run with --force to make a new one.`);
    process.exitCode = 1;
    return;
  }
  const paypal = client(config);
  const name = `${config.orgName} monthly gift`;
  const product = await paypal.createProduct({ name, description: `Monthly gift to ${config.orgName}` });
  out(`Product ${product.id}, debug id ${product.debugId}`);
  const plan = await paypal.createPlan({ productId: product.id, name, priceValue: PRICE, currency: config.currency });
  out(`Plan ${plan.id}, status ${plan.status}, debug id ${plan.debugId}`);
  const returnUrl = `${config.publicBaseUrl}/`;
  const sub = await paypal.createSubscription({ planId: plan.id, returnUrl, cancelUrl: returnUrl, brandName: config.orgName });
  out(`Subscription ${sub.id}, status ${sub.status}, debug id ${sub.debugId}`);
  const state = { productId: product.id, planId: plan.id, subscriptionId: sub.id, approveUrl: sub.approveUrl, createdAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
  fs.writeFileSync(config.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  out(`Saved ${config.stateFile}`);
  out('');
  out('Next, open this link, log in as the sandbox personal account, and approve the subscription.');
  out(sub.approveUrl ?? 'PayPal returned no approve link.');
  out('Then run npm run seed -- --check and confirm it says ACTIVE.');
}

async function check(config) {
  assertReady(config, { need: ['paypal', 'subscription'] });
  const paypal = client(config);
  const res = await paypal.getSubscription(config.demoSubscriptionId);
  if (res.notFound) {
    out(`PayPal has no subscription ${config.demoSubscriptionId}. Debug id ${res.debugId}`);
    process.exitCode = 1;
    return;
  }
  const email = res.data?.subscriber?.email_address ?? '';
  const domain = email.includes('@') ? email.split('@').pop() : 'none yet';
  out(`Subscription ${res.data.id}, status ${res.data.status}, subscriber email domain ${domain}, debug id ${res.debugId}`);
  const scope = paypal.tokenScope() ?? '';
  out(`Token scope has invoicing ${scope.includes('services/invoicing')}, subscriptions ${scope.includes('services/subscriptions')}`);
  if (res.data.status !== 'ACTIVE') out('It is not ACTIVE yet. Approve it as the sandbox personal account, then check again.');
}

async function webhook(config, url) {
  assertReady(config, { need: ['paypal'] });
  if (!/^https:\/\//.test(url)) throw new Error('The webhook URL must start with https, PayPal only posts to HTTPS on port 443.');
  const paypal = client(config);
  const { webhooks } = await paypal.listWebhooks();
  const found = webhooks.find((hook) => hook.url === url);
  if (found) {
    const names = new Set((found.event_types ?? []).map((e) => e.name));
    const missing = EVENT_TYPES.filter((name) => !names.has(name) && !names.has('*'));
    out(`A webhook for this URL already exists, reusing it. Webhook id ${found.id}`);
    if (missing.length) out(`It is missing ${missing.join(', ')}. Add them in the PayPal dashboard.`);
  } else {
    const created = await paypal.createWebhook({ url, eventTypes: EVENT_TYPES });
    out(`Webhook id ${created.id}, debug id ${created.debugId}`);
  }
  out('Put the webhook id in .env and in Render as PAYPAL_WEBHOOK_ID, then save and deploy on Render.');
}

async function main() {
  const config = loadConfig(process.env, { partial: true });
  const url = flagValue('--webhook');
  if (args.includes('--webhook')) {
    if (!url) throw new Error('Pass the full URL, for example npm run seed -- --webhook https://pledge-line.onrender.com/webhooks/paypal');
    return webhook(config, url);
  }
  if (args.includes('--check')) return check(config);
  return seed(config);
}

main().catch((error) => {
  if (error instanceof PayPalError) {
    process.stderr.write(`PayPal said ${error.name}, status ${error.status}, debug id ${error.debugId ?? 'none'}. ${error.message}\n`);
  } else {
    process.stderr.write(`${error.message}\n`);
  }
  process.exitCode = 1;
});
