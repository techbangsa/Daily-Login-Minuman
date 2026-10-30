const crypto = require('crypto');
const { findCustomerIdByEmail } = require('./store');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Hash both sides first so timingSafeEqual gets equal-length buffers.
function sameToken(a, b) {
  const hash = (value) => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}

/** "123", "gid://shopify/Customer/123" -> "123"; anything else -> null. */
function parseCustomerId(value) {
  const match = /^(?:gid:\/\/shopify\/Customer\/)?(\d+)$/.exec(String(value).trim());
  return match ? match[1] : null;
}

/**
 * Mobile app auth: a shared API token (MOBILE_API_TOKEN) in "Authorization: Bearer <token>",
 * plus the customer as `customerId` or `email` (query string for GET, JSON body for POST).
 * Sets req.customerId like the App Proxy auth does.
 */
function mobileAuth({ token }) {
  return async (req, res, next) => {
    if (!token) {
      return res.status(503).json({ ok: false, error: 'mobile_api_disabled' });
    }

    const header = req.get('authorization') || '';
    const [scheme, provided] = header.split(' ');
    if (scheme !== 'Bearer' || !provided) {
      return res.status(401).json({ ok: false, error: 'token_required' });
    }
    if (!sameToken(provided, token)) {
      return res.status(401).json({ ok: false, error: 'invalid_token' });
    }

    const input = { ...req.query, ...(req.body || {}) };
    if (input.customerId !== undefined && input.customerId !== '') {
      const customerId = parseCustomerId(input.customerId);
      if (!customerId) return res.status(400).json({ ok: false, error: 'invalid_customer' });
      req.customerId = customerId;
      return next();
    }
    if (typeof input.email === 'string' && input.email.trim()) {
      const email = input.email.trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: 'invalid_email' });
      // Unknown email -> NotFoundError -> 404 customer_not_found from the router's error handler.
      req.customerId = await findCustomerIdByEmail(email);
      return next();
    }
    return res.status(400).json({ ok: false, error: 'customer_required' });
  };
}

module.exports = { mobileAuth, parseCustomerId };
