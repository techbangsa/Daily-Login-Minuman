// Mobile routes (/mobile/*): token auth, customer lookup, and shared state with the App Proxy routes.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SHOPIFY_STORE_DOMAIN = 'minumancom.myshopify.com';
process.env.SHOPIFY_ADMIN_API = 'test-token';
process.env.SHOPIFY_API_SECRET = 'test-secret';
process.env.MOBILE_API_TOKEN = 'mobile-secret';

const shopify = require('../src/lib/shopify');
const { computeSignature } = require('../src/lib/appProxy');

// In-memory "Shopify": metafields per customer, one known email, and the Flow calls we received.
const fake = { metafields: {}, digests: {}, flowCalls: [], emails: { 'budi@example.com': '777' } };

shopify.adminGraphql = async (query, variables) => {
  if (query.includes('CustomerByEmail')) {
    const id = fake.emails[variables.email];
    return { customerByIdentifier: id ? { id: `gid://shopify/Customer/${id}` } : null };
  }
  if (query.includes('LoyaltyRead')) {
    const id = variables.id.split('/').pop();
    if (id === '404') return { customer: null };
    const value = fake.metafields[id];
    return { customer: { id: variables.id, metafield: value ? { jsonValue: value, compareDigest: String(fake.digests[id]) } : null } };
  }
  if (query.includes('LoyaltyWrite')) {
    const [input] = variables.metafields;
    const id = input.ownerId.split('/').pop();
    const current = fake.metafields[id] ? String(fake.digests[id]) : null;
    if (input.compareDigest !== current) {
      return { metafieldsSet: { metafields: [], userErrors: [{ code: 'STALE_OBJECT', message: 'stale' }] } };
    }
    fake.metafields[id] = JSON.parse(input.value);
    fake.digests[id] = (fake.digests[id] || 0) + 1;
    return { metafieldsSet: { metafields: [{ compareDigest: String(fake.digests[id]) }], userErrors: [] } };
  }
  if (query.includes('flowTriggerReceive')) {
    fake.flowCalls.push(variables);
    return { flowTriggerReceive: { userErrors: [] } };
  }
  throw new Error(`Unexpected query: ${query}`);
};

const app = require('../src/index');

let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test.beforeEach(() => {
  Object.assign(fake, { metafields: {}, digests: {}, flowCalls: [] });
});

async function mobile(path, { method = 'GET', body, query, token = 'mobile-secret' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const response = await fetch(`${baseUrl}/mobile/${path}${qs}`, {
    method,
    headers,
    body: body && JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function web(path, method = 'GET') {
  const params = {
    shop: process.env.SHOPIFY_STORE_DOMAIN,
    logged_in_customer_id: '777',
    path_prefix: '/apps/rewards',
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  params.signature = computeSignature(params, process.env.SHOPIFY_API_SECRET);
  const response = await fetch(`${baseUrl}/${path}?${new URLSearchParams(params)}`, { method });
  return { status: response.status, body: await response.json() };
}

test('mobile check-in by customerId sends points and blocks a second claim', async () => {
  const first = await mobile('checkin', { method: 'POST', body: { customerId: '777' } });
  assert.equal(first.status, 200);
  assert.equal(first.body.reward, 10);
  assert.equal(first.body.data.checkedInToday, true);
  assert.equal(fake.flowCalls.length, 1);
  assert.equal(fake.flowCalls[0].payload.customer_id, 777);

  const again = await mobile('checkin', { method: 'POST', body: { customerId: 'gid://shopify/Customer/777' } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'already_checked_in');
  assert.equal(fake.flowCalls.length, 1);
});

test('a web check-in shows up on mobile and cannot be claimed again there', async () => {
  const webClaim = await web('checkin', 'POST');
  assert.equal(webClaim.status, 200);

  const status = await mobile('status', { query: { email: 'Budi@Example.com' } });
  assert.equal(status.status, 200);
  assert.equal(status.body.data.checkedInToday, true);

  const claim = await mobile('checkin', { method: 'POST', body: { email: 'budi@example.com' } });
  assert.equal(claim.status, 409);
  assert.equal(claim.body.error, 'already_checked_in');
  assert.equal(fake.flowCalls.length, 1);
});

test('mobile auth errors', async () => {
  assert.equal((await mobile('status', { query: { customerId: '777' }, token: null })).body.error, 'token_required');
  assert.equal((await mobile('status', { query: { customerId: '777' }, token: 'wrong' })).status, 401);
  assert.equal((await mobile('status', { query: { customerId: '777' }, token: 'wrong' })).body.error, 'invalid_token');
  assert.equal((await mobile('status')).body.error, 'customer_required');
  assert.equal((await mobile('status', { query: { customerId: 'abc' } })).body.error, 'invalid_customer');
  assert.equal((await mobile('status', { query: { email: 'not-an-email' } })).body.error, 'invalid_email');

  const unknownEmail = await mobile('status', { query: { email: 'nobody@example.com' } });
  assert.equal(unknownEmail.status, 404);
  assert.equal(unknownEmail.body.error, 'customer_not_found');

  const unknownId = await mobile('checkin', { method: 'POST', body: { customerId: '404' } });
  assert.equal(unknownId.status, 404);
  assert.equal(unknownId.body.error, 'customer_not_found');
});
