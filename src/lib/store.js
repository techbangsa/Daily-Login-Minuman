const crypto = require('crypto');
const config = require('../config');
const { adminGraphql, ShopifyError } = require('./shopify');
const { normalizeState } = require('./loyalty');

const READ_QUERY = `query LoyaltyRead($id: ID!, $namespace: String!, $key: String!) {
  customer(id: $id) {
    id
    metafield(namespace: $namespace, key: $key) {
      jsonValue
      compareDigest
    }
  }
}`;

const WRITE_MUTATION = `mutation LoyaltyWrite($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields {
      compareDigest
    }
    userErrors {
      field
      message
      code
    }
  }
}`;

const DISCOUNT_CREATE = `mutation RedeemCode($basicCodeDiscount: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
    codeDiscountNode {
      id
    }
    userErrors {
      field
      message
      code
    }
  }
}`;

/** Thrown when the metafield changed between our read and write. */
class ConflictError extends Error {
  constructor() {
    super('Loyalty data was modified concurrently');
    this.name = 'ConflictError';
  }
}

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
  }
}

const customerGid = (customerId) => `gid://shopify/Customer/${customerId}`;

async function readState(customerId) {
  const data = await adminGraphql(READ_QUERY, {
    id: customerGid(customerId),
    namespace: config.metafield.namespace,
    key: config.metafield.key,
  });

  if (!data.customer) throw new NotFoundError(`Customer ${customerId} not found`);

  const metafield = data.customer.metafield;
  return {
    state: normalizeState(metafield && metafield.jsonValue),
    // null digest = "metafield must not exist yet" for compare-and-set.
    digest: metafield ? metafield.compareDigest : null,
  };
}

async function writeState(customerId, state, digest) {
  const data = await adminGraphql(WRITE_MUTATION, {
    metafields: [
      {
        ownerId: customerGid(customerId),
        namespace: config.metafield.namespace,
        key: config.metafield.key,
        type: 'json',
        value: JSON.stringify(state),
        compareDigest: digest,
      },
    ],
  });

  const { userErrors } = data.metafieldsSet;
  if (userErrors.length) {
    if (userErrors.some((e) => e.code === 'STALE_OBJECT')) throw new ConflictError();
    throw new ShopifyError('metafieldsSet failed', userErrors);
  }
}

/**
 * Read -> mutate -> compare-and-set, retried on concurrent modification.
 * `mutate(state)` returns { state, ...extra } to write, or any object without
 * `state` to stop without writing (e.g. "already checked in").
 */
async function updateState(customerId, mutate, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { state, digest } = await readState(customerId);
    const result = mutate(state);
    if (!result || !result.state) return { ...result, previous: state };

    try {
      await writeState(customerId, result.state, digest);
      return result;
    } catch (error) {
      if (!(error instanceof ConflictError) || attempt === attempts) throw error;
    }
  }
  throw new ConflictError();
}

// No 0/O/1/I to keep codes easy to type.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode() {
  const bytes = crypto.randomBytes(8);
  let suffix = '';
  for (const byte of bytes) suffix += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return `${config.loyalty.voucherCodePrefix}-${suffix}`;
}

async function createVoucher({ customerId, tier, code, now = new Date() }) {
  const endsAt = new Date(now.getTime() + config.loyalty.voucherExpiryDays * 24 * 60 * 60 * 1000);
  const minSubtotal = Number(tier.minSubtotal || 0);

  const data = await adminGraphql(DISCOUNT_CREATE, {
    basicCodeDiscount: {
      title: `Daily Rewards ${tier.points} pts - customer ${customerId} - ${code}`,
      code,
      // Back-date a minute so a slightly fast clock never makes the code "not active yet".
      startsAt: new Date(now.getTime() - 60 * 1000).toISOString(),
      endsAt: endsAt.toISOString(),
      context: { customers: { add: [customerGid(customerId)] } },
      customerGets: {
        value: { discountAmount: { amount: String(tier.amount), appliesOnEachItem: false } },
        items: { all: true },
      },
      minimumRequirement:
        minSubtotal > 0 ? { subtotal: { greaterThanOrEqualToSubtotal: String(minSubtotal) } } : null,
      usageLimit: 1,
      appliesOncePerCustomer: true,
      combinesWith: { orderDiscounts: false, productDiscounts: true, shippingDiscounts: true },
    },
  });

  const { codeDiscountNode, userErrors } = data.discountCodeBasicCreate;
  if (userErrors.length || !codeDiscountNode) {
    throw new ShopifyError('discountCodeBasicCreate failed', userErrors);
  }
  return { id: codeDiscountNode.id, code, endsAt: endsAt.toISOString() };
}

module.exports = {
  readState,
  updateState,
  createVoucher,
  generateCode,
  ConflictError,
  NotFoundError,
};
