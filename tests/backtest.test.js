import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCandles, replaySafePlay, sessionDates, sessionSchedule, createBacktest } from '../server/backtest.js';

const now = Date.parse('2026-11-08T11:57:00+05:30');
const sessions = sessionDates(now);
const bot = { id: 'fixture-bot', name: 'safe play', symbol: 'RELIANCE', preset: 'sma', level: 0, budget: 10000, stopPct: 1, targetPct: 2 };
const settings = { initialCash: 100000, cash: 100135.18, maxTradeRisk: 500, dailyLossLimit: 2000, maxPosition: 25000, maxDailyTrades: 10 };
test('custom exit strategies are rejected by both standalone replay and download packaging', () => {
  for (const exitPreset of ['sma', 'support', 'max-hold', 'scheduled', 'time-performance']) {
    const custom = { ...bot, exitPreset, exitLevel: 90, exitSessions: 1, exitTime: '15:00', exitMinGainPct: 1 };
    assert.throws(() => replaySafePlay(custom, settings, prepareCandles(fixtureCandles(), sessions), sessions), { code: 'BACKTEST_EXIT' });
    assert.throws(() => createBacktest({ data: fixtureCandles() }, custom, settings, sessions), { code: 'BACKTEST_EXIT' });
  }
});
export function fixtureCandles(days = sessions.all) {
  return days.flatMap(day => Array.from({ length: sessionSchedule(day).bars }, (_, index) => {
    const clock = 555 + index * 5;
    return [`${day}T${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}:00+05:30`, 100, 101, 99.5, 100, 1000];
  }).concat(sessionSchedule(day).auction ? [[`${day}T15:25:00+05:30`, 100, 100, 100, 100, 0]] : []));
}
test('calendar selects exactly the latest seven completed sessions plus two earlier warmup sessions', () => {
  assert.deepEqual(sessions.evaluated, ['2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
  assert.deepEqual(sessions.warmup, ['2026-10-27', '2026-10-28']);
  assert.equal(sessionDates(Date.parse('2026-11-06T15:29:00+05:30')).evaluated.at(-1), '2026-11-05');
  assert.equal(sessionDates(Date.parse('2026-11-06T15:30:00+05:30')).evaluated.at(-1), '2026-11-05');
  assert.equal(sessionDates(Date.parse('2026-11-06T15:35:00+05:30')).evaluated.at(-1), '2026-11-06');
  assert.throws(() => sessionDates(Date.parse('2026-11-09T10:00:00+05:30')), { code: 'BACKTEST_CALENDAR' });
  assert.throws(() => sessionDates(Date.parse('2027-01-10T10:00:00+05:30')), { code: 'BACKTEST_CALENDAR' });
});
test('CAS coverage validates 648 continuous candles, retains auction marks and rejects genuine gaps/zero volume', () => {
  const rows = fixtureCandles();
  const prepared = prepareCandles(rows, sessions);
  assert.equal(prepared.candles.length, 657);
  assert.equal(prepared.regular.length, 648);
  assert.equal(prepared.auctionBars.length, 9);
  assert.ok(prepared.complete);
  assert.ok(prepared.coverage.every(day => day.received === 72));
  assert.equal(prepareCandles(rows.slice(0, -1), sessions).complete, true, 'auction marks are not mandatory continuous prints');
  const duplicated = prepareCandles([...rows.toReversed(), rows[0]], sessions);
  assert.equal(duplicated.duplicates, 1);
  assert.equal(duplicated.reordered, true);
  assert.equal(duplicated.sha256, prepared.sha256);
  const missing = prepareCandles(rows.slice(1), sessions);
  assert.equal(missing.complete, false);
  assert.equal(missing.coverage[0].missing.length, 1);
  assert.throws(() => replaySafePlay(bot, settings, missing, sessions), { code: 'BACKTEST_COVERAGE' });
  const zero = structuredClone(rows); zero[200][5] = 0;
  assert.equal(prepareCandles(zero, sessions).complete, false);
  const conflict = [...rows, [...rows[0]]]; conflict.at(-1)[5] = 2;
  assert.throws(() => prepareCandles(conflict, sessions), { code: 'BACKTEST_CANDLES' });
  for (const bad of [['bad', 1, 2, 0.5, 1, 1], [rows[0][0], 100, 90, 99, 100, 1], [rows[0][0], 100, 101, 99, 100, -1]]) {
    assert.throws(() => prepareCandles([bad], sessions), { code: 'BACKTEST_CANDLES' });
  }
  const unexpected = prepareCandles([...rows, ['2026-10-31T10:00:00+05:30', 100, 101, 99, 100, 1]], sessions);
  assert.equal(unexpected.complete, false);
  assert.deepEqual(unexpected.unexpectedSessions, ['2026-10-31']);
  assert.throws(() => prepareCandles([['2026-10-27T09:16:00+05:30', 100, 101, 99, 100, 1]], sessions), { code: 'BACKTEST_CANDLES' });
});
test('72-bar CAS schedule is effective August 3 only; earlier missing closing bars still block', () => {
  const earlier = sessionDates(Date.parse('2026-07-31T15:30:00+05:30'));
  const rows = fixtureCandles(earlier.all);
  assert.equal(sessionSchedule('2026-08-02').bars, 75);
  assert.equal(sessionSchedule('2026-08-03').bars, 72);
  assert.equal(prepareCandles(rows, earlier).regular.length, 675);
  assert.equal(prepareCandles(rows.slice(0, -1), earlier).complete, false);
  assert.throws(() => replaySafePlay({ ...bot, symbol: 'ITC' }, settings, prepareCandles(fixtureCandles(), sessions), sessions), { code: 'BACKTEST_BOT' });
});
test('completed-bar crossover fills next open, applies exact costs and conservatively chooses same-bar stop', () => {
  const rows = fixtureCandles();
  for (const day of sessions.evaluated) {
    const first = rows.findIndex(row => row[0].startsWith(day));
    rows[first + 12] = [rows[first + 12][0], 100, 103, 99.5, 103, 1000];
    rows[first + 14] = [rows[first + 14][0], 100, 103, 98, 100, 1000];
    rows[first + 35] = [rows[first + 35][0], 100, 103, 99.5, 103, 1000];
  }
  const saved = JSON.stringify({ bot, settings });
  const run = replaySafePlay(bot, settings, prepareCandles(rows, sessions), sessions);
  assert.equal(run.trades.length, 7, 'one entry per IST day despite later crossovers');
  assert.equal(run.trades[0].entryAt, '2026-10-29T10:20:00+05:30');
  assert.equal(run.trades[0].entryReference, 100, 'no signal-close fill or lookahead high');
  assert.equal(run.trades[0].entryPrice, 100.05);
  assert.equal(run.trades[0].qty, 99);
  assert.equal(run.trades[0].stop, 99.05);
  assert.equal(run.trades[0].exitPrice, 99);
  assert.equal(run.trades[0].entryFee, 4.95);
  assert.equal(run.trades[0].exitFee, 4.9);
  assert.equal(run.trades[0].pnl, -113.8);
  assert.equal(run.summary.netPnl, -796.6);
  assert.equal(run.summary.finalCapital, 99203.4);
  assert.equal(run.summary.ambiguousBars, 7);
  assert.equal(run.summary.evaluatedBars, 504);
  assert.equal(run.summary.maxDrawdown, 796.6);
  assert.equal(JSON.stringify({ bot, settings }), saved, 'simulation never mutates live settings or bot');
});
test('positions carry overnight and gaps use actual open, not a guaranteed stop fill', () => {
  const rows = fixtureCandles();
  const start = rows.findIndex(row => row[0].startsWith(sessions.evaluated[0]));
  rows[start + 12] = [rows[start + 12][0], 100, 103, 99.5, 103, 1000];
  rows[start + 72] = [rows[start + 72][0], 10, 10, 10, 10, 1000];
  const next = rows.findIndex(row => row[0].startsWith(sessions.evaluated[1]));
  rows[next] = [rows[next][0], 95, 96, 94, 95, 1000];
  const run = replaySafePlay(bot, settings, prepareCandles(rows, sessions), sessions);
  assert.equal(run.trades[0].reason, 'Stop gap at open');
  assert.equal(run.trades[0].exitPrice, 94.95);
  assert.ok(-run.trades[0].pnl > run.trades[0].modelledRisk);
  assert.ok(run.trades[0].entryAt.startsWith(sessions.evaluated[0]));
  assert.ok(run.trades[0].exitBarAt.startsWith(sessions.evaluated[1]));
});
test('final-window liquidation includes both fees, and late/out-of-budget signals do not fabricate fills', () => {
  const rows = fixtureCandles();
  const last = rows.findIndex(row => row[0].startsWith(sessions.evaluated.at(-1)));
  rows[last + 12] = [rows[last + 12][0], 100, 103, 99.5, 103, 1000];
  const run = replaySafePlay(bot, settings, prepareCandles(rows, sessions), sessions);
  assert.equal(run.trades.length, 1);
  assert.equal(run.trades[0].reason, 'End-window liquidation');
  assert.equal(run.trades[0].exitAt, '2026-11-06T09:45:00.000Z');
  assert.equal(run.trades[0].pnl, -19.8);
  const small = replaySafePlay({ ...bot, budget: 100 }, settings, prepareCandles(rows, sessions), sessions);
  assert.equal(small.trades.length, 0);
  assert.ok(small.skipped.length > 0);
  const late = fixtureCandles(); late[last + 71] = [late[last + 71][0], 100, 103, 99.5, 103, 1000];
  const lateRun = replaySafePlay(bot, settings, prepareCandles(late, sessions), sessions);
  assert.equal(lateRun.trades.length, 0);
  assert.equal(lateRun.skipped.length, 1, 'last continuous close must not fill in the auction');
  const firstDayLate = fixtureCandles();
  const first = firstDayLate.findIndex(row => row[0].startsWith(sessions.evaluated[0]));
  firstDayLate[first + 71] = [firstDayLate[first + 71][0], 100, 103, 99.5, 103, 1000];
  assert.equal(replaySafePlay(bot, settings, prepareCandles(firstDayLate, sessions), sessions).trades.length, 0, 'unfilled signal must not roll to next session');
});
