// Loads .env and validates required settings before anything else.
const config = require('./config');
const express = require('express');
const webhookRoutes = require('./routes/webhook');
const proxyRoutes = require('./routes/proxy');
const mobileRoutes = require('./routes/mobile');

const app = express();

app.disable('x-powered-by');
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(express.json({ limit: '10kb' }));

// Routes
app.get("/", (req, res) => {
  res.send("Minuman Daily Login Proxy API running 🚀");
});

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
