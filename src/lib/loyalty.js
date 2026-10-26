// Pure check-in rules: no I/O, so everything here is unit-testable.
//
// The metafield only remembers *when* the customer last checked in and which
// day of the cycle that was. Points are never stored here: every check-in is
// sent to Shopify Flow, which adds them to the customer's Growave balance.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function emptyState() {
  return { streak: 0, last_checkin: null };
}

/**
 * Coerce whatever is stored in the metafield into a valid state object.
 * Drops fields from older data shapes (balance, history), so the next write
 * cleans the metafield up.
 */
function normalizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return state;

  if (Number.isInteger(raw.streak) && raw.streak > 0) state.streak = raw.streak;
  if (typeof raw.last_checkin === 'string' && DATE_RE.test(raw.last_checkin)) {
    state.last_checkin = raw.last_checkin;
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

/**
 * Day of the cycle (1..cycleLength) the customer last claimed, or 0 when the
 * streak is broken (skipped a day). Old data could count past the cycle, so
 * it is folded back into it.
 */
function effectiveStreak(state, today, cycleLength) {
  if (!state.streak) return 0;
  if (state.last_checkin !== today && state.last_checkin !== addDays(today, -1)) return 0;
  return ((state.streak - 1) % cycleLength) + 1;
}

/**
 * Apply today's check-in.
 * Returns { alreadyCheckedIn: true } or { state, reward, day }.
 */
function applyCheckin(state, { today, rewardCycle }) {
  if (state.last_checkin === today) {
    return { alreadyCheckedIn: true };
  }

  const previous = effectiveStreak(state, today, rewardCycle.length);
  // A completed cycle starts over at day 1, just like a missed day.
  const day = previous >= rewardCycle.length ? 1 : previous + 1;

  return {
    day,
    reward: rewardCycle[day - 1],
    state: { streak: day, last_checkin: today },
  };
}

/** Shape returned to the storefront. */
function buildView(state, { today, rewardCycle }) {
  const length = rewardCycle.length;
  const checkedInToday = state.last_checkin === today;
  let streak = effectiveStreak(state, today, length);

  // Yesterday finished the cycle: today is day 1 of a new one.
  if (!checkedInToday && streak >= length) streak = 0;

  const completedInCycle = streak;
  const todayIndex = checkedInToday ? streak - 1 : streak;

  return {
    streak,
    checkedInToday,
    today,
    cycle: rewardCycle,
    completedInCycle,
    todayIndex,
    nextReward: checkedInToday ? rewardCycle[streak % length] : rewardCycle[todayIndex],
  };
}

module.exports = {
  emptyState,
  normalizeState,
  dateInTimezone,
  addDays,
  effectiveStreak,
  applyCheckin,
  buildView,
};
