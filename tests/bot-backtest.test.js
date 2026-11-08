import test from 'node:test';
import assert from 'node:assert/strict';
import { historyDates, prepareCandles, replayBot, createBotBacktest } from '../server/backtest.js';
import { exitPresets } from '../server/store.js';
import { AnalysisLog } from '../server/analysis-log.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const now = Date.parse('2026-11-08T12:00:00+05:30');
const sessions = historyDates(now);
const settings = { initialCash: 100000, maxTradeRisk: 500, dailyLossLimit: 2000, maxPosition: 25000, maxDailyTrades: 10 };
const bot = { id: 'fixture-bot', name: 'Any bot', symbol: 'INFY', preset: 'sma', level: 0, budget: 10000, stopPct: 1, targetPct: 2, exitPreset: 'protective' };

export function minuteCandles(window = sessions) {
  return window.all.flatMap(day => {
    const start = Date.parse(`${day}T${window.schedules[day].open}:00+05:30`);
    return Array.from({ length: window.schedules[day].bars }, (_, index) => [
      new Date(start + index * 60000 + 19800000).toISOString().replace('.000Z', '+05:30'),
      100, 101, 99.5, 100, 1000
    ]);
  });
}
function entryCandles(preset = 'sma') {
  const rows = minuteCandles();
  for (const day of sessions.all) {
    const index = rows.findIndex(row => row[0].startsWith(day)) + 12;
    rows[index] = [rows[index][0], 100, 103, 99.5, 103, 1000];
    if (preset === 'swing') rows[index][2] = 107;
  }
  return rows;
}
const replay = (rows, config = bot) => replayBot(config, settings, prepareCandles(rows, sessions), sessions);
export function minuteDownload(window = sessions, symbol = 'INFY', rows = minuteCandles(window)) {
  return { source: 'Angel One fixture', fetchedAt: new Date(now).toISOString(),
    instrument: { exchange: 'NSE', symbol: `${symbol}-EQ`, token: '123' },
    request: { interval: 'ONE_MINUTE' }, data: rows };
}

test('one-minute calendar window never goes beyond seven calendar days or adds warmup', () => {
  assert.equal(sessions.from, '2026-11-02');
  assert.equal(sessions.through, '2026-11-08');
  assert.deepEqual(sessions.all, ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
  assert.deepEqual(sessions.warmup, []);
  assert.equal(sessions.intervalMinutes, 1);
  for (const days of [0, 8, 1.5, '7', null]) assert.throws(() => historyDates(now, days), { code: 'BACKTEST_RANGE' });
  assert.throws(() => historyDates(now, 1), { code: 'BACKTEST_RANGE' });
  assert.throws(() => historyDates(Date.parse('2027-01-05T16:00:00+05:30')), { code: 'BACKTEST_CALENDAR' });
  const friday = Date.parse('2026-11-06T15:35:00+05:30');
  assert.deepEqual(historyDates(friday, 1).all, ['2026-11-06']);
  assert.throws(() => historyDates(friday - 60000, 1), { code: 'BACKTEST_RANGE' });
  const special = historyDates(Date.parse('2026-11-08T15:40:00+05:30'), 1);
  assert.equal(special.schedules['2026-11-08'].bars, 55);
  assert.equal(prepareCandles(minuteCandles(special), special).regular[0].at, '2026-11-08T14:20:00+05:30');
});

test('one-minute coverage counts 360 bars per day, detects gaps/duplicates and keeps later prints out of fills', () => {
  const rows = minuteCandles();
  const prepared = prepareCandles(rows, sessions);
  assert.equal(prepared.regular.length, 1800);
  assert.ok(prepared.complete);
  assert.ok(prepared.coverage.every(day => day.expected === 360));
  const extra = [...rows, ['2026-11-06T15:25:00+05:30', 10, 10, 10, 10, 0]];
  assert.equal(prepareCandles(extra, sessions).regular.length, 1800);
  assert.equal(prepareCandles(extra, sessions).complete, true);
  assert.equal(prepareCandles(rows.slice(1), sessions).complete, false);
  const zero = structuredClone(rows); zero[1][5] = 0;
  assert.equal(prepareCandles(zero, sessions).complete, false);
  assert.equal(prepareCandles([...rows.toReversed(), rows[0]], sessions).sha256, prepared.sha256);
  const conflicting = [...rows, [...rows[0]]]; conflicting.at(-1)[4] = 100.5;
  assert.throws(() => prepareCandles(conflicting, sessions), { code: 'BACKTEST_CANDLES' });
  assert.throws(() => prepareCandles([['2026-11-01T09:15:00+05:30', 100, 101, 99, 100, 1]], sessions), { code: 'BACKTEST_CANDLES' });
});

test('all four entry presets work on an arbitrary ticker, fill next minute and preserve inputs', () => {
  for (const preset of ['sma', 'breakout', 'dip', 'swing']) {
    const config = { ...bot, preset, level: preset === 'dip' ? 101 : 102, stopPct: preset === 'swing' ? 3 : 1, targetPct: preset === 'swing' ? 6 : 2 };
    const rows = entryCandles(preset);
    for (const day of sessions.all) {
      const index = rows.findIndex(row => row[0].startsWith(day)) + (preset === 'dip' ? 2 : 14);
      rows[index] = [rows[index][0], 100, 107, 96, 100, 1000];
    }
    const before = JSON.stringify({ config, settings });
    const run = replay(rows, config);
    assert.equal(run.trades.length, 5, preset);
    assert.equal(run.trades[0].entryAt, `2026-11-02T09:${preset === 'dip' ? '16' : '28'}:00+05:30`);
    assert.equal(run.trades[0].entryPrice, 100.05);
    assert.equal(run.summary.losses, 5);
    assert.equal(run.summary.winRatePct, 0);
    assert.equal(run.summary.ambiguousBars, 5);
    assert.equal(run.summary.netPnl, run.trades.reduce((sum, trade) => sum + trade.pnl, 0));
    assert.equal(run.analysis.length, 1800);
    assert.ok(run.analysis.every(record => record.execution === 'backtest' && record.bot.symbol === 'INFY'));
    assert.ok(run.orders.every(order => order.execution === 'backtest'));
    assert.equal(JSON.stringify({ config, settings }), before);
  }
});

test('support, SMA reversal and each timed exit use completed-close checks with next-open execution', () => {
  for (const exitPreset of ['support', 'sma', 'max-hold', 'scheduled', 'time-performance']) {
    const config = { ...bot, exitPreset, exitLevel: 100, exitSessions: 1, exitTime: '09:30', exitMinGainPct: 1 };
    const rows = entryCandles();
    if (exitPreset === 'sma') {
      for (let index = 20; index < rows.length; index++) {
        if (Number(rows[index][0].slice(11, 13)) === 9 && Number(rows[index][0].slice(14, 16)) >= 35) rows[index][4] = 99.6;
      }
    }
    const run = replay(rows, config);
    assert.equal(run.trades.length, 5, exitPreset);
    assert.ok(run.trades.every(trade => trade.reason === `Exit strategy: ${exitPresets.find(preset => preset.id === exitPreset).name}`), exitPreset);
    const firstExitSignal = run.analysis.find(record => record.checks.exitSignal?.passed);
    assert.ok(firstExitSignal);
    assert.equal(Date.parse(run.trades[0].exitBarAt), Date.parse(firstExitSignal.at));
    assert.equal(run.trades[0].exitReference, 100, 'exit cannot use a prior open or the signal close');
    if (['max-hold', 'scheduled', 'time-performance'].includes(exitPreset)) assert.equal(run.trades[0].exitBarAt, '2026-11-02T09:30:00+05:30');
  }
});

test('performance checks pass once, protective gaps remain active, and no-trade win rate is undefined', () => {
  const rows = entryCandles();
  for (let index = 13; index < 360; index++) rows[index][4] = 100.5;
  const config = { ...bot, exitPreset: 'time-performance', exitSessions: 1, exitTime: '09:30', exitMinGainPct: 0 };
  rows[360] = [rows[360][0], 95, 96, 94, 95, 1000];
  const run = replay(rows, config);
  assert.equal(run.trades[0].reason, 'Stop gap at open');
  assert.equal(run.trades[0].exitPrice, 94.95);
  assert.ok(run.trades[0].timePerformancePassed);
  assert.ok(-run.trades[0].pnl > run.trades[0].modelledRisk);
  const flat = replay(minuteCandles());
  assert.equal(flat.summary.trades, 0);
  assert.equal(flat.summary.winRatePct, null);
  assert.equal(flat.summary.netPnl, 0);
  const small = replay(entryCandles(), { ...bot, budget: 100 });
  assert.equal(small.summary.trades, 0);
  assert.ok(small.analysis.some(record => record.decision === 'blocked' && !record.checks.positionSizing.passed));
});

test('win/loss report classifies realized net trades, not gross price movement', () => {
  const rows = minuteCandles();
  const config = { ...bot, preset: 'dip', level: 101 };
  for (const [index, day] of sessions.all.entries()) {
    const at = rows.findIndex(row => row[0].startsWith(day)) + 2;
    rows[at] = [rows[at][0], 100, index === 0 ? 101 : 103, index === 0 ? 98 : 99.5, 100, 1000];
  }
  const run = replay(rows, config);
  assert.equal(run.summary.trades, 5);
  assert.equal(run.summary.wins, 4);
  assert.equal(run.summary.losses, 1);
  assert.equal(run.summary.breakeven, 0);
  assert.equal(run.summary.winRatePct, 80);
  assert.equal(run.summary.netPnl, Math.round(run.trades.reduce((sum, trade) => sum + trade.pnl, 0) * 100) / 100);
  const final = minuteCandles();
  for (let index = 1; index < final.length; index++) final[index][4] = 100.1;
  const losingSmallGain = replay(final, config);
  assert.ok(losingSmallGain.trades[0].exitReference > losingSmallGain.trades[0].entryReference);
  assert.ok(losingSmallGain.trades[0].pnl < 0);
  assert.equal(losingSmallGain.summary.wins, 0, 'a gross price gain is not a win after fees and slippage');
});

test('packaging preserves original settings, detects corrupted/wrong-interval/wrong-ticker history and persists blocked data', () => {
  const run = createBotBacktest(minuteDownload(), bot, settings, sessions, { downloadOnly: true });
  assert.equal(run.status, 'downloaded');
  assert.equal(run.result, null);
  assert.equal(run.dataset.candles.length, 1800);
  const completed = createBotBacktest(minuteDownload(), bot, settings, sessions);
  assert.ok(completed.result.analysis.every(record => record.backtestId === completed.id));
  for (const download of [minuteDownload(sessions, 'ITC'), { ...minuteDownload(), request: { interval: 'FIVE_MINUTE' } }]) {
    assert.throws(() => createBotBacktest(download, bot, settings, sessions), { code: 'BACKTEST_INSTRUMENT' });
  }
  assert.throws(() => createBotBacktest(minuteDownload(), bot, settings, sessions, { expectedSha256: 'bad' }), { code: 'BACKTEST_CANDLES' });
  const blocked = createBotBacktest(minuteDownload(sessions, 'INFY', minuteCandles().slice(1)), bot, settings, sessions);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.result, null);
  assert.equal(blocked.dataset.candles.length, 1799);
});

test('backtest decisions round-trip through the normal private analysis files and bot-scoped reader', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tradegrok-backtest-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const logger = new AnalysisLog(join(directory, 'logs'));
  const run = createBotBacktest(minuteDownload(), bot, settings, sessions);
  logger.append(run.result.analysis);
  const page = await logger.read(bot.id, sessions.all[0]);
  assert.equal(page.records.length, 50);
  assert.ok(page.before !== null);
  assert.ok(page.records.every(record => record.backtestId === run.id && record.execution === 'backtest'));
  assert.equal(page.records[0].quote.latestPrice, 100);
  assert.equal((await logger.read('another-bot', sessions.all[0])).records.length, 0);
});
