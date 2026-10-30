const dotenv = require('dotenv');

dotenv.config({ quiet: true });

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`Env var ${name} must be an integer, got "${raw}"`);
  }
  return value;
}

/**
 * Points given per day of the check-in cycle. Day 1 = index 0.
 * After the last day (or a missed day) the streak resets to day 1.
 * The points themselves live in Growave; this only decides how many to send.
 * Override with REWARD_CYCLE="10,10,15,15,20,20,50".
 */
const rewardCycle = (process.env.REWARD_CYCLE || '10,10,15,15,20,20,50')
  .split(',')
  .map((value) => Number.parseInt(value.trim(), 10));

const config = {
  port: intFromEnv('PORT', 3000),

  shop: {
    domain: required('SHOPIFY_STORE_DOMAIN'),
    adminToken: required('SHOPIFY_ADMIN_API'),
    apiSecret: required('SHOPIFY_API_SECRET'),
    apiVersion: process.env.SHOPIFY_API_VERSION || '2026-10',
    timezone: process.env.SHOP_TIMEZONE || 'Asia/Jakarta',
  },

  metafield: {
    namespace: process.env.LOYALTY_NAMESPACE || 'custom',
    key: process.env.LOYALTY_KEY || 'loyalty_data',
  },

  loyalty: {
    rewardCycle,
  },

  // Handle of the "Daily check-in completed" Flow trigger extension (extensions/daily-checkin-completed).
  // A Flow workflow on this trigger adds the points to the customer's Growave balance.
  flow: {
    triggerHandle: process.env.FLOW_TRIGGER_HANDLE || 'daily-checkin-completed',
  },

  // Shared token the mobile app sends as "Authorization: Bearer <token>" on /mobile/*.
  // Unset = mobile endpoints answer 503 mobile_api_disabled.
  mobile: {
    apiToken: process.env.MOBILE_API_TOKEN || '',
  },

  // App proxy requests older than this are rejected (replay protection).
  proxyMaxAgeSeconds: intFromEnv('PROXY_MAX_AGE_SECONDS', 300),
};

function validateConfig({ loyalty }) {
  if (!loyalty.rewardCycle.length || loyalty.rewardCycle.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error('REWARD_CYCLE must be a comma separated list of positive integers');
  }
}

validateConfig(config);

module.exports = config;
