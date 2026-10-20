const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeState,
  dateInTimezone,
  addDays,
  applyCheckin,
  applyRedeem,
  revertRedeem,
  buildView,
} = require('../src/lib/loyalty');

const cycle = [10, 10, 15, 15, 20, 20, 50];
const opts = (today) => ({ today, rewardCycle: cycle, historyLimit: 30 });

test('normalizeState handles missing and malformed data', () => {
  assert.deepEqual(normalizeState(null), { balance: 0, streak: 0, last_checkin: null, history: [] });
  assert.deepEqual(normalizeState({ balance: -5, streak: 'x', last_checkin: 'yesterday', history: [{ foo: 1 }] }), {
    balance: 0,
    streak: 0,
    last_checkin: null,
    history: [],
  });
});

test('dateInTimezone uses the shop timezone, not UTC', () => {
  // 2026-10-19 18:30 UTC is already 2026-10-20 in Jakarta (UTC+7).
  assert.equal(dateInTimezone(new Date('2026-10-19T18:30:00Z'), 'Asia/Jakarta'), '2026-10-20');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('first check-in starts the streak', () => {
  const result = applyCheckin(normalizeState(null), opts('2026-10-19'));
  assert.equal(result.reward, 10);
  assert.equal(result.state.balance, 10);
  assert.equal(result.state.streak, 1);
  assert.equal(result.state.history[0].type, 'earn');
});

test('second check-in on the same day is rejected', () => {
  const { state } = applyCheckin(normalizeState(null), opts('2026-10-19'));
  assert.deepEqual(applyCheckin(state, opts('2026-10-19')), { alreadyCheckedIn: true });
});

test('consecutive days continue the streak, a gap resets it', () => {
  let state = normalizeState(null);
  for (let day = 0; day < 7; day += 1) {
    state = applyCheckin(state, opts(addDays('2026-10-01', day))).state;
  }
  assert.equal(state.streak, 7);
  assert.equal(state.balance, cycle.reduce((a, b) => a + b, 0));

  // Day 8 wraps the cycle back to the day-1 reward.
  const day8 = applyCheckin(state, opts('2026-10-08'));
  assert.equal(day8.reward, 10);
  assert.equal(day8.state.streak, 8);

  // Skipping a day resets the streak.
  const afterGap = applyCheckin(state, opts('2026-10-09'));
  assert.equal(afterGap.state.streak, 1);
  assert.equal(afterGap.reward, 10);
});

test('history is capped', () => {
  let state = normalizeState(null);
  for (let day = 0; day < 40; day += 1) {
    state = applyCheckin(state, { ...opts(addDays('2026-01-01', day)), historyLimit: 30 }).state;
  }
  assert.equal(state.history.length, 30);
  assert.equal(state.history[0].date, addDays('2026-01-01', 39));
});

test('redeem deducts points and revert restores them', () => {
  const tier = { id: 'pts-100', points: 100, amount: 10000 };
  const state = { ...normalizeState(null), balance: 150 };

  assert.deepEqual(applyRedeem({ ...state, balance: 99 }, { tier, code: 'X', today: '2026-10-19', historyLimit: 30 }), {
    insufficient: true,
  });

  const redeemed = applyRedeem(state, { tier, code: 'MNM-ABC', today: '2026-10-19', historyLimit: 30 }).state;
  assert.equal(redeemed.balance, 50);
  assert.deepEqual(redeemed.history[0], { type: 'spend', amount: -100, date: '2026-10-19', code: 'MNM-ABC' });

  const reverted = revertRedeem(redeemed, { tier, code: 'MNM-ABC' });
  assert.equal(reverted.balance, 150);
  assert.equal(reverted.history.length, 0);
  assert.equal(revertRedeem(reverted, { tier, code: 'MNM-ABC' }), null);
});

test('buildView reports the cycle position', () => {
  const viewOpts = (today) => ({ today, rewardCycle: cycle, redeemTiers: [], currency: 'IDR' });
  let state = normalizeState(null);

  let view = buildView(state, viewOpts('2026-10-01'));
  assert.equal(view.checkedInToday, false);
  assert.equal(view.todayIndex, 0);
  assert.equal(view.nextReward, 10);

  for (let day = 0; day < 3; day += 1) state = applyCheckin(state, opts(addDays('2026-10-01', day))).state;

  view = buildView(state, viewOpts('2026-10-03'));
  assert.equal(view.checkedInToday, true);
  assert.equal(view.completedInCycle, 3);
  assert.equal(view.todayIndex, 2);
  assert.equal(view.nextReward, 15); // tomorrow = day 4

  view = buildView(state, viewOpts('2026-10-04'));
  assert.equal(view.checkedInToday, false);
  assert.equal(view.completedInCycle, 3);
  assert.equal(view.todayIndex, 3);

  // Missed a day: streak shown as broken.
  view = buildView(state, viewOpts('2026-10-06'));
  assert.equal(view.streak, 0);
  assert.equal(view.todayIndex, 0);

  // Day 7 claimed: full cycle completed.
  for (let day = 3; day < 7; day += 1) state = applyCheckin(state, opts(addDays('2026-10-01', day))).state;
  view = buildView(state, viewOpts('2026-10-07'));
  assert.equal(view.completedInCycle, 7);
  assert.equal(view.todayIndex, 6);
  assert.equal(view.nextReward, 10);
});
