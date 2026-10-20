#!/usr/bin/env node
/**
 * Call the local server exactly like Shopify's App Proxy would (signed query).
 *
 *   npm run proxy -- balance <customerId>
 *   npm run proxy -- checkin <customerId>
 *   npm run proxy -- redeem  <customerId> <tierId>
 *
 * BASE_URL defaults to http://localhost:3000/proxy.
 */
const dotenv = require('dotenv');
const { computeSignature } = require('../src/lib/appProxy');

dotenv.config({ quiet: true });

const [action, customerId, tierId] = process.argv.slice(2);
const routes = { balance: 'GET', checkin: 'POST', redeem: 'POST' };

if (!routes[action] || !/^\d+$/.test(customerId || '')) {
  console.error('Usage: npm run proxy -- <balance|checkin|redeem> <customerId> [tierId]');
  process.exit(1);
}

const params = {
  shop: process.env.SHOPIFY_STORE_DOMAIN,
  logged_in_customer_id: customerId,
  path_prefix: '/apps/rewards',
  timestamp: String(Math.floor(Date.now() / 1000)),
};
params.signature = computeSignature(params, process.env.SHOPIFY_API_SECRET);

const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}/proxy`;
const url = `${baseUrl}/${action}?${new URLSearchParams(params)}`;

(async () => {
  const response = await fetch(url, {
    method: routes[action],
    headers: { 'Content-Type': 'application/json' },
    body: action === 'redeem' ? JSON.stringify({ tierId }) : undefined,
  });
  console.log(`${response.status} ${routes[action]} /${action}`);
  console.log(JSON.stringify(await response.json(), null, 2));
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
