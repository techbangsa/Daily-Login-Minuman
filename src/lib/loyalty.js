// Pure loyalty rules: no I/O, so everything here is unit-testable.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function emptyState() {
  return { balance: 0, streak: 0, last_checkin: null, history: [] };
}

/**
 * Coerce whatever is stored in the metafield into a valid state object.
 * Protects against manual edits in the admin or older data shapes.
 */
function normalizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return state;

  if (Number.isInteger(raw.balance) && raw.balance > 0) state.balance = raw.balance;
  if (Number.isInteger(raw.streak) && raw.streak > 0) state.streak = raw.streak;
  if (typeof raw.last_checkin === 'string' && DATE_RE.test(raw.last_checkin)) {
    state.last_checkin = raw.last_checkin;
  }
  if (Array.isArray(raw.history)) {
    state.history = raw.history.filter(
      (entry) =>
        entry &&
        (entry.type === 'earn' || entry.type === 'spend') &&
        Number.isInteger(entry.amount) &&
        typeof entry.date === 'string'
    );
  }
  return state;
}

/** YYYY-MM-DD for `now` in the given IANA timezone. */
function dateInTimezone(now, timezone) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function pushHistory(history, entry, limit) {
  return [entry, ...history].slice(0, limit);
}

/** Streak that still counts today (0 when the customer skipped a day). */
function effectiveStreak(state, today) {
  if (state.last_checkin === today || state.last_checkin === addDays(today, -1)) {
    return state.streak;
  }
  return 0;
}

/**
 * Apply today's check-in.
 * Returns { alreadyCheckedIn: true } or { state, reward }.
 */
function applyCheckin(state, { today, rewardCycle, historyLimit }) {
  if (state.last_checkin === today) {
    return { alreadyCheckedIn: true };
  }

  const streak = effectiveStreak(state, today) + 1;
  const reward = rewardCycle[(streak - 1) % rewardCycle.length];

  return {
    reward,
    state: {
      ...state,
      balance: state.balance + reward,
      streak,
      last_checkin: today,
      history: pushHistory(state.history, { type: 'earn', amount: reward, date: today }, historyLimit),
    },
  };
}

/**
 * Deduct points for a redeem tier.
 * Returns { insufficient: true } or { state }.
 */
function applyRedeem(state, { tier, code, today, historyLimit }) {
  if (state.balance < tier.points) {
    return { insufficient: true };
  }
  return {
    state: {
      ...state,
      balance: state.balance - tier.points,
      history: pushHistory(
        state.history,
        { type: 'spend', amount: -tier.points, date: today, code },
        historyLimit
      ),
    },
  };
}

/** Undo a redeem whose discount code could not be created. */
function revertRedeem(state, { tier, code }) {
  const index = state.history.findIndex((entry) => entry.type === 'spend' && entry.code === code);
  if (index === -1) return null; // Already reverted or never written.
  return {
    ...state,
    balance: state.balance + tier.points,
    history: state.history.filter((_, i) => i !== index),
  };
}

/** Shape returned to the storefront. */
function buildView(state, { today, rewardCycle, redeemTiers, currency, voucherExpiryDays }) {
  const checkedInToday = state.last_checkin === today;
  const streak = effectiveStreak(state, today);
  const length = rewardCycle.length;

  // Days already completed in the current cycle, and which tile is "today".
  const completedInCycle = checkedInToday ? ((streak - 1) % length) + 1 : streak % length;
  const todayIndex = checkedInToday ? completedInCycle - 1 : completedInCycle;

  return {
    balance: state.balance,
    streak,
    checkedInToday,
    today,
    nextReward: checkedInToday ? rewardCycle[streak % length] : rewardCycle[todayIndex],
    cycle: rewardCycle,
    completedInCycle,
    todayIndex,
    currency,
    voucherExpiryDays,
    tiers: redeemTiers.map((tier) => ({
      id: tier.id,
      points: tier.points,
      amount: Number(tier.amount),
      minSubtotal: Number(tier.minSubtotal || 0),
      affordable: state.balance >= tier.points,
    })),
    history: state.history,
  };
}

module.exports = {
  emptyState,
  normalizeState,
  dateInTimezone,
  addDays,
  effectiveStreak,
  applyCheckin,
  applyRedeem,
  revertRedeem,
  buildView,
};
