const config = require('../config');
const { appProxyAuth } = require('../lib/appProxy');
const { createCheckinRouter } = require('./checkin');

// Storefront popup via Shopify App Proxy (/apps/rewards/*): the customer comes from the signed query.
// "/balance" is the old name of "/status", kept for pages that still run the previous script.
module.exports = createCheckinRouter({
  auth: appProxyAuth({
    secret: config.shop.apiSecret,
    shopDomain: config.shop.domain,
    maxAgeSeconds: config.proxyMaxAgeSeconds,
  }),
  statusPaths: ['/status', '/balance'],
});
