const config = require('../config');

const ENDPOINT = `https://${config.shop.domain}/admin/api/${config.shop.apiVersion}/graphql.json`;
const MAX_ATTEMPTS = 4;
const TIMEOUT_MS = 10000;

class ShopifyError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ShopifyError';
    this.details = details;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isThrottled(body) {
  return Array.isArray(body && body.errors) && body.errors.some((e) => e.extensions && e.extensions.code === 'THROTTLED');
}

/**
 * Admin GraphQL request with retries on throttling, 5xx and network errors.
 * Mutations are only retried when the request surely did not reach Shopify
 * (429 / THROTTLED), so a retry never applies a write twice.
 */
async function adminGraphql(query, variables = {}) {
  const isMutation = /^\s*mutation\b/.test(query);
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': config.shop.adminToken,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      lastError = new ShopifyError(`Network error calling Shopify: ${error.message}`);
      if (isMutation) throw lastError;
      await sleep(250 * 2 ** attempt);
      continue;
    }

    const body = await response.json().catch(() => null);

    if (response.status === 429 || isThrottled(body)) {
      lastError = new ShopifyError('Shopify API throttled', body);
      await sleep(500 * 2 ** attempt);
      continue;
    }

    if (response.status >= 500) {
      lastError = new ShopifyError(`Shopify API ${response.status}`, body);
      if (isMutation) throw lastError;
      await sleep(250 * 2 ** attempt);
      continue;
    }

    if (!response.ok) {
      throw new ShopifyError(`Shopify API ${response.status}`, body);
    }
    if (!body || body.errors) {
      throw new ShopifyError('Shopify GraphQL error', body && body.errors);
    }
    return body.data;
  }

  throw lastError;
}

module.exports = { adminGraphql, ShopifyError };
