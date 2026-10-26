const express = require('express');
const config = require('../config');
const { appProxyAuth } = require('../lib/appProxy');
const { readState, updateState, sendCheckinToFlow, ConflictError, NotFoundError } = require('../lib/store');
const { applyCheckin, buildView, dateInTimezone } = require('../lib/loyalty');

const router = express.Router();

// Responses are per customer: never let Shopify, the CDN or the browser cache them.
const noStore = (req, res, next) => {
  res.set('Cache-Control', 'no-store, private');
  next();
};

// Applied per route (not router.use) so this router can also be mounted at "/"
// without turning every unknown URL into a 401.
const guard = [
  noStore,
  appProxyAuth({
    secret: config.shop.apiSecret,
    shopDomain: config.shop.domain,
    maxAgeSeconds: config.proxyMaxAgeSeconds,
  }),
];

const today = () => dateInTimezone(new Date(), config.shop.timezone);

const view = (state) => buildView(state, { today: today(), rewardCycle: config.loyalty.rewardCycle });

// Check-in status only: the points balance comes from Growave on the storefront.
// "/balance" is the old name, kept for pages that still run the previous script.
router.get(['/status', '/balance'], guard, async (req, res) => {
  const { state } = await readState(req.proxy.customerId);
  res.json({ ok: true, data: view(state) });
});

router.post('/checkin', guard, async (req, res) => {
  const { customerId } = req.proxy;
  const date = today();

  // 1. Mark today as claimed first (compare-and-set), so a day can never be claimed twice.
  const result = await updateState(customerId, (state) =>
    applyCheckin(state, { today: date, rewardCycle: config.loyalty.rewardCycle })
  );

  if (result.alreadyCheckedIn) {
    return res.status(409).json({ ok: false, error: 'already_checked_in', data: view(result.previous) });
  }

  // 2. Hand the points to Flow -> Growave. If Flow surely did not get them, un-claim the day.
  try {
    await sendCheckinToFlow({ customerId, reward: result.reward, day: result.day, date });
  } catch (error) {
    if (error.maybeApplied) {
      // Flow may have started anyway: keep the day claimed so points can't be sent twice.
      console.error('[checkin] Flow trigger result unknown - check the Flow run history', {
        customerId,
        date,
        reward: result.reward,
        error,
      });
      return res.status(202).json({ ok: false, error: 'reward_pending', data: view(result.state) });
    }

    console.error('[checkin] Flow trigger failed, undoing check-in', { customerId, date, error });
    try {
      await updateState(customerId, (state) =>
        state.last_checkin === date && state.streak === result.day ? { state: result.previous } : null
      );
    } catch (undoError) {
      // Needs manual fix: day is marked claimed but no points were sent.
      console.error('[checkin] UNDO FAILED - manual action needed', { customerId, date, undoError });
    }
    return res.status(424).json({ ok: false, error: 'reward_failed' });
  }

  return res.json({ ok: true, reward: result.reward, data: view(result.state) });
});

// Expected failures use 2xx/4xx on purpose: for 5xx responses the App Proxy
// replaces our JSON with the storefront's HTML error page, hiding the reason.

// Express 5 forwards rejected promises from async handlers here.
// eslint-disable-next-line no-unused-vars
router.use((error, req, res, next) => {
  if (error instanceof NotFoundError) {
    return res.status(404).json({ ok: false, error: 'customer_not_found' });
  }
  if (error instanceof ConflictError) {
    return res.status(409).json({ ok: false, error: 'busy_try_again' });
  }
  console.error('[proxy] unexpected error', { path: req.path, customerId: req.proxy && req.proxy.customerId, error });
  return res.status(500).json({ ok: false, error: 'server_error' });
});

module.exports = router;
