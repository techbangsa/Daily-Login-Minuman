const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeState, dateInTimezone, addDays, applyCheckin, buildView } = require('../src/lib/loyalty');

const cycle = [10, 10, 15, 15, 20, 20, 50];
const opts = (today) => ({ today, rewardCycle: cycle });

function checkinDays(start, count, state = normalizeState(null)) {
  let current = state;
  for (let day = 0; day < count; day += 1) current = applyCheckin(current, opts(addDays(start, day))).state;
  return current;
}

test('normalizeState keeps only streak and last check-in', () => {
  assert.deepEqual(normalizeState(null), { streak: 0, last_checkin: null });
  assert.deepEqual(normalizeState({ streak: 'x', last_checkin: 'yesterday' }), { streak: 0, last_checkin: null });
  // Old shape with points: balance and history are dropped.
  assert.deepEqual(normalizeState({ balance: 120, streak: 3, last_checkin: '2026-10-19', history: [{ type: 'earn' }] }), {
    streak: 3,
    last_checkin: '2026-10-19',
  });
});

test('dateInTimezone uses the shop timezone, not UTC', () => {
  // 2026-10-19 18:30 UTC is already 2026-10-20 in Jakarta (UTC+7).
  assert.equal(dateInTimezone(new Date('2026-10-19T18:30:00Z'), 'Asia/Jakarta'), '2026-10-20');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('first check-in is day 1', () => {
  const result = applyCheckin(normalizeState(null), opts('2026-10-19'));
  assert.equal(result.reward, 10);
  assert.equal(result.day, 1);
  assert.deepEqual(result.state, { streak: 1, last_checkin: '2026-10-19' });
});

test('second check-in on the same day is rejected', () => {
  const { state } = applyCheckin(normalizeState(null), opts('2026-10-19'));
  assert.deepEqual(applyCheckin(state, opts('2026-10-19')), { alreadyCheckedIn: true });
});

test('consecutive days follow the cycle rewards', () => {
  let state = normalizeState(null);
  const rewards = [];
  for (let day = 0; day < 7; day += 1) {
    const result = applyCheckin(state, opts(addDays('2026-10-01', day)));
    rewards.push(result.reward);
    state = result.state;
  }
  assert.deepEqual(rewards, cycle);
  assert.equal(state.streak, 7);
});

test('a finished cycle and a missed day both reset to day 1', () => {
  const week = checkinDays('2026-10-01', 7);

  const day8 = applyCheckin(week, opts('2026-10-08'));
  assert.equal(day8.day, 1);
  assert.equal(day8.reward, 10);
  assert.equal(day8.state.streak, 1);

  const threeDays = checkinDays('2026-10-01', 3);
  const afterGap = applyCheckin(threeDays, opts('2026-10-05'));
  assert.equal(afterGap.day, 1);
  assert.equal(afterGap.reward, 10);
});

test('old data counting past the cycle is folded back into it', () => {
  // Streak 9 under the old rules = day 2 of the current cycle.
  const result = applyCheckin({ streak: 9, last_checkin: '2026-10-19' }, opts('2026-10-20'));
  assert.equal(result.day, 3);
  assert.equal(result.reward, 15);
});

test('buildView reports the cycle position', () => {
  let view = buildView(normalizeState(null), opts('2026-10-01'));
  assert.equal(view.checkedInToday, false);
  assert.equal(view.todayIndex, 0);
  assert.equal(view.nextReward, 10);

  let state = checkinDays('2026-10-01', 3);

  view = buildView(state, opts('2026-10-03'));
  assert.equal(view.checkedInToday, true);
  assert.equal(view.completedInCycle, 3);
  assert.equal(view.todayIndex, 2);
  assert.equal(view.nextReward, 15); // tomorrow = day 4

  view = buildView(state, opts('2026-10-04'));
  assert.equal(view.checkedInToday, false);
  assert.equal(view.completedInCycle, 3);
  assert.equal(view.todayIndex, 3);
  assert.equal(view.nextReward, 15);

  // Missed a day: back to day 1.
  view = buildView(state, opts('2026-10-06'));
  assert.equal(view.streak, 0);
  assert.equal(view.todayIndex, 0);

  // Day 7 claimed: full cycle completed, tomorrow starts over.
  state = checkinDays('2026-10-04', 4, state);
  view = buildView(state, opts('2026-10-07'));
  assert.equal(view.completedInCycle, 7);
  assert.equal(view.todayIndex, 6);
  assert.equal(view.nextReward, 10);

  view = buildView(state, opts('2026-10-08'));
  assert.equal(view.checkedInToday, false);
  assert.equal(view.completedInCycle, 0);
  assert.equal(view.todayIndex, 0);
  assert.equal(view.nextReward, 10);
});
