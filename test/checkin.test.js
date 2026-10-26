// End-to-end check-in route with Shopify stubbed out: metafield write + Flow trigger.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SHOPIFY_STORE_DOMAIN = 'minumancom.myshopify.com';
process.env.SHOPIFY_ADMIN_API = 'test-token';
process.env.SHOPIFY_API_SECRET = 'test-secret';

const shopify = require('../src/lib/shopify');
const { computeSignature } = require('../src/lib/appProxy');

// In-memory "Shopify": one customer metafield plus the Flow calls we received.
const fake = { metafield: null, digest: 0, flowCalls: [], flowError: null };

shopify.adminGraphql = async (query, variables) => {
  if (query.includes('LoyaltyRead')) {
    return {
      customer: {
        id: variables.id,
        metafield: fake.metafield ? { jsonValue: fake.metafield, compareDigest: String(fake.digest) } : null,
      },
    };
  }
  if (query.includes('LoyaltyWrite')) {
    const [input] = variables.metafields;
    const current = fake.metafield ? String(fake.digest) : null;
    if (input.compareDigest !== current) {
      return { metafieldsSet: { metafields: [], userErrors: [{ code: 'STALE_OBJECT', message: 'stale' }] } };
    }
    fake.metafield = JSON.parse(input.value);
    fake.digest += 1;
    return { metafieldsSet: { metafields: [{ compareDigest: String(fake.digest) }], userErrors: [] } };
  }
  if (query.includes('flowTriggerReceive')) {
    if (fake.flowError) throw fake.flowError;
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
  Object.assign(fake, { metafield: null, digest: 0, flowCalls: [], flowError: null });
});

async function call(path, method = 'GET') {
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

test('check-in stores only the streak marker and sends the points to Flow', async () => {
  const { status, body } = await call('checkin', 'POST');
  assert.equal(status, 200);
  assert.equal(body.reward, 10);
  assert.equal(body.data.checkedInToday, true);

  assert.deepEqual(Object.keys(fake.metafield).sort(), ['last_checkin', 'streak']);
  assert.equal(fake.metafield.streak, 1);

  assert.equal(fake.flowCalls.length, 1);
  assert.equal(fake.flowCalls[0].handle, 'daily-checkin-completed');
  assert.deepEqual(fake.flowCalls[0].payload, {
    customer_id: 777,
    Points: 10,
    'Cycle day': 1,
    'Checkin date': fake.metafield.last_checkin,
  });

  const again = await call('checkin', 'POST');
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'already_checked_in');
  assert.equal(fake.flowCalls.length, 1);
});

test('a rejected Flow trigger undoes the check-in so the customer can retry', async () => {
  fake.flowError = new shopify.ShopifyError('flowTriggerReceive failed', [{ message: 'Invalid handle' }]);

  const { status, body } = await call('checkin', 'POST');
  assert.equal(status, 424);
  assert.equal(body.error, 'reward_failed');
  assert.deepEqual(fake.metafield, { streak: 0, last_checkin: null });

  fake.flowError = null;
  const retry = await call('checkin', 'POST');
  assert.equal(retry.status, 200);
  assert.equal(fake.flowCalls.length, 1);
});

test('an unknown Flow result keeps the day claimed so points are never sent twice', async () => {
  fake.flowError = new shopify.ShopifyError('Network error calling Shopify: reset', null, { maybeApplied: true });

  const { status, body } = await call('checkin', 'POST');
  assert.equal(status, 202);
  assert.equal(body.error, 'reward_pending');
  assert.equal(body.data.checkedInToday, true);
  assert.equal(fake.metafield.streak, 1);
});

test('status reports the cycle without any points balance', async () => {
  const { status, body } = await call('status');
  assert.equal(status, 200);
  assert.equal(body.data.todayIndex, 0);
  assert.equal(body.data.balance, undefined);
});
