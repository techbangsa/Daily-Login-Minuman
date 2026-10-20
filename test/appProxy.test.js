const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { computeSignature, verifyProxyRequest } = require('../src/lib/appProxy');

const secret = 'test-secret';
const shopDomain = 'minumancom.myshopify.com';
const now = Date.UTC(2026, 9, 19, 9, 0, 0);

function signedQuery(overrides = {}) {
  const params = {
    shop: shopDomain,
    logged_in_customer_id: '123456',
    path_prefix: '/apps/rewards',
    timestamp: String(now / 1000),
    ...overrides,
  };
  params.signature = computeSignature(params, secret);
  return new URLSearchParams(params).toString();
}

const verify = (query, extra = {}) => verifyProxyRequest(query, { secret, shopDomain, maxAgeSeconds: 300, now, ...extra });

test('signs the same message as the Shopify docs example', () => {
  // https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
  const params = {
    extra: ['1', '2'],
    shop: 'shop-name.myshopify.com',
    logged_in_customer_id: '',
    path_prefix: '/apps/awesome_reviews',
    timestamp: '1317327555',
  };
  const expectedMessage =
    'extra=1,2logged_in_customer_id=path_prefix=/apps/awesome_reviewsshop=shop-name.myshopify.comtimestamp=1317327555';
  const expected = crypto.createHmac('sha256', 'hush').update(expectedMessage).digest('hex');
  assert.equal(computeSignature(params, 'hush'), expected);
});

test('accepts a valid signed request', () => {
  assert.deepEqual(verify(signedQuery()), { ok: true, shop: shopDomain, customerId: '123456' });
});

test('rejects tampered customer id', () => {
  const query = signedQuery().replace('123456', '999999');
  assert.equal(verify(query).error, 'invalid_signature');
});

test('rejects missing signature, wrong shop, stale timestamp, logged out', () => {
  assert.equal(verify('shop=x').error, 'invalid_signature');
  assert.equal(verify(signedQuery({ shop: 'evil.myshopify.com' })).error, 'unknown_shop');
  assert.equal(verify(signedQuery({ timestamp: String(now / 1000 - 3600) })).error, 'expired_request');
  assert.equal(verify(signedQuery({ logged_in_customer_id: '' })).error, 'login_required');
});
