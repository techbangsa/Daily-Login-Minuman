const crypto = require('crypto');

/**
 * Collect query params from a raw query string, keeping repeated keys as arrays
 * (Shopify joins repeated values with "," when signing).
 */
function parseQuery(queryString) {
  const params = {};
  for (const [key, value] of new URLSearchParams(queryString)) {
    (params[key] ||= []).push(value);
  }
  return params;
}

/**
 * App proxy signature: build "key=value1,value2" for every param except
 * `signature`, sort those strings, concatenate without separator, HMAC-SHA256 (hex) with
 * the app's client secret.
 */
function computeSignature(params, secret) {
  const message = Object.keys(params)
    .filter((key) => key !== 'signature')
    .map((key) => `${key}=${[].concat(params[key]).join(',')}`)
    .sort()
    .join('');
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

function safeEqualHex(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify an app proxy request. Returns { ok: true, shop, customerId } or
 * { ok: false, status, error }.
 */
function verifyProxyRequest(queryString, { secret, shopDomain, maxAgeSeconds, now = Date.now() }) {
  const params = parseQuery(queryString);
  const signature = params.signature && params.signature[0];

  if (!signature || !safeEqualHex(signature, computeSignature(params, secret))) {
    return { ok: false, status: 401, error: 'invalid_signature' };
  }

  const shop = params.shop && params.shop[0];
  if (shop !== shopDomain) {
    return { ok: false, status: 403, error: 'unknown_shop' };
  }

  const timestamp = Number(params.timestamp && params.timestamp[0]);
  if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > maxAgeSeconds) {
    return { ok: false, status: 401, error: 'expired_request' };
  }

  const customerId = params.logged_in_customer_id && params.logged_in_customer_id[0];
  if (!customerId) {
    return { ok: false, status: 401, error: 'login_required' };
  }
  if (!/^\d+$/.test(customerId)) {
    return { ok: false, status: 400, error: 'invalid_customer' };
  }

  return { ok: true, shop, customerId };
}

function appProxyAuth(options) {
  return (req, res, next) => {
    const queryIndex = req.originalUrl.indexOf('?');
    const queryString = queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex + 1);
    const result = verifyProxyRequest(queryString, options);

    if (!result.ok) {
      return res.status(result.status).json({ ok: false, error: result.error });
    }
    req.proxy = { shop: result.shop, customerId: result.customerId };
    return next();
  };
}

module.exports = { parseQuery, computeSignature, verifyProxyRequest, appProxyAuth };
