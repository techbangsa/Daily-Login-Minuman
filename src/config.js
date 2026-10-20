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

function jsonFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Env var ${name} must be valid JSON: ${error.message}`);
  }
}

/**
 * Points given per day of the check-in cycle. Day 1 = index 0.
 * After the last day the cycle restarts, while the streak keeps counting.
 * Override with REWARD_CYCLE="10,10,15,15,20,20,50".
 */
const rewardCycle = (process.env.REWARD_CYCLE || '10,10,15,15,20,20,50')
  .split(',')
  .map((value) => Number.parseInt(value.trim(), 10));

/**
 * Redeem tiers: points -> fixed amount off the order (in shop currency).
 * minSubtotal is optional (0 = no minimum purchase).
 * Override with REDEEM_TIERS='[{"id":"t100","points":100,"amount":10000}]'.
 */
const redeemTiers = jsonFromEnv('REDEEM_TIERS', [
  { id: 'pts-100', points: 100, amount: 10000, minSubtotal: 100000 },
  { id: 'pts-250', points: 250, amount: 30000, minSubtotal: 200000 },
  { id: 'pts-500', points: 500, amount: 75000, minSubtotal: 300000 },
]);

const config = {
  port: intFromEnv('PORT', 3000),

  shop: {
    domain: required('SHOPIFY_STORE_DOMAIN'),
    adminToken: required('SHOPIFY_ADMIN_API'),
    apiSecret: required('SHOPIFY_API_SECRET'),
    apiVersion: process.env.SHOPIFY_API_VERSION || '2026-10',
    timezone: process.env.SHOP_TIMEZONE || 'Asia/Jakarta',
    currency: process.env.SHOP_CURRENCY || 'IDR',
  },

  metafield: {
    namespace: process.env.LOYALTY_NAMESPACE || 'custom',
    key: process.env.LOYALTY_KEY || 'loyalty_data',
  },

  loyalty: {
    rewardCycle,
    redeemTiers,
    // Must stay <= the "maxItems" in the metafield definition's JSON schema.
    historyLimit: intFromEnv('HISTORY_LIMIT', 30),
    voucherExpiryDays: intFromEnv('VOUCHER_EXPIRY_DAYS', 30),
    voucherCodePrefix: process.env.VOUCHER_CODE_PREFIX || 'MNM',
  },

  // App proxy requests older than this are rejected (replay protection).
  proxyMaxAgeSeconds: intFromEnv('PROXY_MAX_AGE_SECONDS', 300),
};

function validateConfig({ loyalty }) {
  if (!loyalty.rewardCycle.length || loyalty.rewardCycle.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error('REWARD_CYCLE must be a comma separated list of positive integers');
  }

  const ids = new Set();
  for (const tier of loyalty.redeemTiers) {
    if (!tier || typeof tier.id !== 'string' || !tier.id) {
      throw new Error('Every redeem tier needs a string "id"');
    }
    if (ids.has(tier.id)) throw new Error(`Duplicate redeem tier id: ${tier.id}`);
    ids.add(tier.id);
    if (!Number.isInteger(tier.points) || tier.points <= 0) {
      throw new Error(`Redeem tier ${tier.id}: "points" must be a positive integer`);
    }
    if (!(Number(tier.amount) > 0)) {
      throw new Error(`Redeem tier ${tier.id}: "amount" must be a positive number`);
    }
    if (tier.minSubtotal !== undefined && !(Number(tier.minSubtotal) >= 0)) {
      throw new Error(`Redeem tier ${tier.id}: "minSubtotal" must be >= 0`);
    }
  }

  if (loyalty.historyLimit < 1) throw new Error('HISTORY_LIMIT must be >= 1');
  if (loyalty.voucherExpiryDays < 1) throw new Error('VOUCHER_EXPIRY_DAYS must be >= 1');
}

validateConfig(config);

module.exports = config;
