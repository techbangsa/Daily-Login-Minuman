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

const CUSTOMER_BY_EMAIL = `query CustomerByEmail($email: String!) {
  customerByIdentifier(identifier: { emailAddress: $email }) {
    id
  }
}`;

const FLOW_TRIGGER = `mutation CheckinFlowTrigger($handle: String!, $payload: JSON!) {
  flowTriggerReceive(handle: $handle, payload: $payload) {
    userErrors {
      field
      message
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

/** Numeric customer ID for an email, so mobile can identify customers the same way Growave does. */
async function findCustomerIdByEmail(email) {
  const data = await adminGraphql(CUSTOMER_BY_EMAIL, { email });
  if (!data.customerByIdentifier) throw new NotFoundError(`No customer with email ${email}`);
  return data.customerByIdentifier.id.split('/').pop();
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
 * The result always carries `previous`: the state before this update.
 */
async function updateState(customerId, mutate, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { state, digest } = await readState(customerId);
    const result = mutate(state);
    if (!result || !result.state) return { ...result, previous: state };

    try {
      await writeState(customerId, result.state, digest);
      return { ...result, previous: state };
    } catch (error) {
      if (!(error instanceof ConflictError) || attempt === attempts) throw error;
    }
  }
  throw new ConflictError();
}

/**
 * Start the "Daily check-in completed" Flow workflows for this check-in.
 * The workflow adds `Points` to the customer's Growave balance.
 * Payload keys must match the field keys in the trigger extension's TOML.
 */
async function sendCheckinToFlow({ customerId, reward, day, date }) {
  const data = await adminGraphql(FLOW_TRIGGER, {
    handle: config.flow.triggerHandle,
    payload: {
      customer_id: Number(customerId),
      Points: reward,
      'Cycle day': day,
      'Checkin date': date,
    },
  });

  const { userErrors } = data.flowTriggerReceive;
  if (userErrors.length) throw new ShopifyError('flowTriggerReceive failed', userErrors);
}

module.exports = {
  readState,
  updateState,
  findCustomerIdByEmail,
  sendCheckinToFlow,
  ConflictError,
  NotFoundError,
};
