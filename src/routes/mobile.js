const config = require('../config');
const { mobileAuth } = require('../lib/mobileAuth');
const { createCheckinRouter } = require('./checkin');

// Mobile app (/mobile/*): same check-in data and responses as the storefront popup,
// authenticated with the shared MOBILE_API_TOKEN instead of the App Proxy signature.
module.exports = createCheckinRouter({ auth: mobileAuth({ token: config.mobile.apiToken }) });
