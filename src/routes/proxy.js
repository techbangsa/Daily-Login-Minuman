const express = require('express');
const config = require('../config');
const { appProxyAuth } = require('../lib/appProxy');
const { readState, updateState, createVoucher, generateCode, ConflictError, NotFoundError } = require('../lib/store');
const { applyCheckin, applyRedeem, revertRedeem, buildView, dateInTimezone } = require('../lib/loyalty');

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

const view = (state) =>
  buildView(state, {
    today: today(),
    rewardCycle: config.loyalty.rewardCycle,
    redeemTiers: config.loyalty.redeemTiers,
    currency: config.shop.currency,
    voucherExpiryDays: config.loyalty.voucherExpiryDays,
  });

router.get('/balance', guard, async (req, res) => {
  const { state } = await readState(req.proxy.customerId);
  res.json({ ok: true, data: view(state) });
});

router.post('/checkin', guard, async (req, res) => {
  const result = await updateState(req.proxy.customerId, (state) =>
    applyCheckin(state, {
      today: today(),
      rewardCycle: config.loyalty.rewardCycle,
      historyLimit: config.loyalty.historyLimit,
    })
  );

  if (result.alreadyCheckedIn) {
    return res.status(409).json({ ok: false, error: 'already_checked_in', data: view(result.previous) });
  }
  return res.json({ ok: true, reward: result.reward, data: view(result.state) });
});

router.post('/redeem', guard, async (req, res) => {
  const tierId = req.body && req.body.tierId;
  const tier = config.loyalty.redeemTiers.find((t) => t.id === tierId);
  if (!tier) {
    return res.status(400).json({ ok: false, error: 'invalid_tier' });
  }

  const { customerId } = req.proxy;
  const code = generateCode();

  // 1. Deduct points first (compare-and-set), so points can never be spent twice.
  const deducted = await updateState(customerId, (state) =>
    applyRedeem(state, { tier, code, today: today(), historyLimit: config.loyalty.historyLimit })
  );
  if (deducted.insufficient) {
    return res.status(409).json({ ok: false, error: 'insufficient_points', data: view(deducted.previous) });
  }

  // 2. Create the discount code. If it fails, give the points back.
  let voucher;
  try {
    voucher = await createVoucher({ customerId, tier, code });
  } catch (error) {
    console.error('[redeem] discount creation failed, refunding points', { customerId, code, error });
    try {
      await updateState(customerId, (state) => {
        const reverted = revertRedeem(state, { tier, code });
        return reverted ? { state: reverted } : null;
      });
    } catch (refundError) {
      // Needs manual fix: customer lost points without receiving a code.
      console.error('[redeem] REFUND FAILED - manual action needed', {
        customerId,
        code,
        points: tier.points,
        refundError,
      });
    }
    return res.status(502).json({ ok: false, error: 'voucher_failed' });
  }

  return res.json({
    ok: true,
    voucher: {
      code: voucher.code,
      endsAt: voucher.endsAt,
      amount: Number(tier.amount),
      minSubtotal: Number(tier.minSubtotal || 0),
      points: tier.points,
    },
    data: view(deducted.state),
  });
});

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
