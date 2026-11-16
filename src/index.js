// Loads .env and validates required settings before anything else.
const config = require('./config');
const path = require('path');
const express = require('express');
const webhookRoutes = require('./routes/webhook');
const proxyRoutes = require('./routes/proxy');
const mobileRoutes = require('./routes/mobile');

const app = express();

app.disable('x-powered-by');
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(express.json({ limit: '10kb' }));

// Handover docs: index.html at "/", docs/ (API spec for the mobile vendor) at "/docs".
// Both are listed in vercel.json "includeFiles" so they are bundled with the function.
const ROOT = path.join(__dirname, '..');
app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});
app.use('/docs', express.static(path.join(ROOT, 'docs')));

// Use the webhook routes
app.use('/api/webhook', webhookRoutes);

// Mobile app: same check-in data as the storefront, authenticated with MOBILE_API_TOKEN.
// Mounted before the "/" proxy mount below.
app.use('/mobile', mobileRoutes);

// Shopify App Proxy: storefront /apps/rewards/* -> <proxy url>/*
// Mounted twice so the proxy URL in the Dev Dashboard can be either
// https://daily-login-minuman.vercel.app or https://daily-login-minuman.vercel.app/proxy
app.use('/proxy', proxyRoutes);
app.use('/', proxyRoutes);

// Vercel imports the app; locally we start the server ourselves.
if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`EXPRESS API IS RUNNING ON PORT ${config.port}`)
  })
}

module.exports = app;
