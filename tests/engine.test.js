import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, presets } from '../server/store.js';
import { Engine, metrics, validateBot, validateRisk, signal, validQuote, entryWindow, istDay } from '../server/engine.js';

const MONDAY = Date.parse('2026-11-09T10:00:00+05:30');
function fixture(t) {
  const store = new Store(':memory:');
  let time = MONDAY;
  const engine = new Engine(store, {}, { now: () => time });
  t.after(() => store.close());
  const bot = store.bots()[0];
  Object.assign(bot, { preset: 'dip', level: 1400, status: 'running', revision: 0 });
  store.saveBot(bot);
  const quote = (price = 1390, source = 'angel') => ({ symbol: bot.symbol, price, at: new Date(time).toISOString(), source });
  const evaluate = (price, source = 'angel') => {
    engine.quotes.set(bot.symbol, quote(price, source));
    store.transaction(() => engine.evaluate(store.bot(bot.id)));
    return store.bot(bot.id);
  };
  return { store, engine, bot, quote, evaluate, time: value => { time = value; } };
}

test('paper entry and target exit conserve cash, apply fees, and prevent daily re-entry', t => {
  const { store, evaluate, bot } = fixture(t);
  const opened = evaluate(1390);
  assert.ok(opened.position);
  assert.equal(store.orders()[0].execution, 'paper');
  assert.equal(store.orders()[0].source, 'angel');
  assert.ok(opened.position.maxLoss <= store.settings().maxTradeRisk);
  assert.equal(opened.position.qty, 7);
  const closed = evaluate(opened.position.target + 3);
  assert.equal(closed.position, null);
  assert.equal(store.orders().length, 2);
  assert.equal(store.orders()[0].reason, 'Take profit');
  assert.ok(store.settings().cash > 100000);
  evaluate(1390);
  assert.equal(store.orders().length, 2);
  assert.match(store.bot(bot.id).message, /Daily entry completed/);
});
test('pause and emergency entry lock do not suppress stop exits', t => {
  const { store, engine, bot, evaluate } = fixture(t);
  const opened = evaluate(1390);
  opened.status = 'paused'; store.saveBot(opened);
  const settings = store.settings(); settings.emergency = true; store.saveSettings(settings);
  evaluate(opened.position.stop - 25);
  assert.equal(store.bot(bot.id).position, null);
  assert.equal(store.orders()[0].reason, 'Stop loss');
  assert.ok(store.orders()[0].pnl < -opened.position.maxLoss, 'gap losses can exceed modelled risk');
  const stats = metrics(store, engine.quotes, MONDAY);
  assert.ok(stats.dayLoss > 0);
  assert.equal(stats.positions, 0);
});
test('cash, per-trade risk, and per-position thresholds are measured exactly', t => {
  const { store, evaluate } = fixture(t);
  const settings = store.settings();
  settings.maxTradeRisk = 30; settings.maxPosition = 4000;
  store.saveSettings(settings);
  const opened = evaluate(1390);
  assert.ok(opened.position.maxLoss <= 30);
  assert.ok(opened.position.entry * opened.position.qty <= 4000);
  assert.ok(store.settings().cash >= 0);
  assert.equal(opened.position.qty, 1);
});
test('risk insufficient for one share blocks, not a success-shaped fill', t => {
  const { store, bot, evaluate } = fixture(t);
  const settings = store.settings(); settings.maxTradeRisk = 1; store.saveSettings(settings);
  evaluate(1390);
  assert.equal(store.orders().length, 0);
  assert.match(store.bot(bot.id).message, /Blocked/);
  assert.equal(store.settings().cash, 100000);
});
test('global daily entry limit blocks a second bot and daily risk is shared', t => {
  const { store, bot, evaluate, engine, quote } = fixture(t);
  const settings = store.settings(); settings.maxDailyTrades = 1; store.saveSettings(settings);
  evaluate(1390);
  const second = { ...store.bot(bot.id), id: 'second', position: null, lastEntryDay: null };
  store.saveBot(second);
  engine.quotes.set(second.symbol, quote());
  store.transaction(() => engine.evaluate(second));
  assert.equal(store.orders().length, 1);
  assert.match(store.bot(second.id).message, /daily entry limit/);
});
test('reserved open risk reduces remaining risk for another bot', t => {
  const { store, bot, engine, evaluate } = fixture(t);
  const settings = store.settings(); settings.dailyLossLimit = 110; settings.maxTradeRisk = 110; store.saveSettings(settings);
  evaluate(1390);
  const second = { ...store.bot(bot.id), id: 'second', position: null, lastEntryDay: null };
  store.saveBot(second);
  store.transaction(() => engine.evaluate(second));
  assert.equal(store.orders().length, 1);
  assert.match(store.bot(second.id).message, /risk budget/);
});
test('missing, stale, future and mismatched feed quotes never fill or close', t => {
  const { store, engine, bot, evaluate, quote } = fixture(t);
  const opened = evaluate(1390);
  for (const invalid of [undefined, { ...quote(1300), at: new Date(MONDAY - 61000).toISOString() }, quote(1300, 'unsupported'), { ...quote(1300), at: new Date(MONDAY + 6000).toISOString() }]) {
    engine.quotes.set(bot.symbol, invalid);
    assert.throws(() => store.transaction(() => engine.exit(store.bot(bot.id), invalid, 'Manual')), /fresh/);
    assert.ok(store.bot(bot.id).position);
  }
  assert.equal(store.orders().length, 1);
  assert.equal(store.bot(bot.id).position.entry, opened.position.entry);
});
test('Angel One-mode entries enforce IST window even when quotes are fresh', t => {
  const { store, evaluate, time } = fixture(t);
  const settings = store.settings(); settings.mode = 'angel'; store.saveSettings(settings);
  time(Date.parse('2026-11-07T10:00:00+05:30')); evaluate(1390, 'angel');
  assert.equal(store.orders().length, 0);
  time(Date.parse('2026-11-09T15:20:00+05:30')); evaluate(1390, 'angel');
  assert.equal(store.orders().length, 0);
  time(MONDAY); evaluate(1390, 'angel');
  assert.equal(store.orders().length, 1);
});
test('daily guard follows IST date, resets overnight, not UTC midnight', t => {
  const { store, evaluate, time } = fixture(t);
  const opened = evaluate(1390);
  evaluate(opened.position.target + 3);
  time(Date.parse('2026-11-09T23:59:00+05:30')); evaluate(1390);
  assert.equal(store.orders().length, 2);
  time(Date.parse('2026-11-10T00:01:00+05:30')); evaluate(1390);
  assert.equal(store.orders().length, 2, 'new IST day does not bypass market hours');
  time(Date.parse('2026-11-10T09:15:00+05:30')); evaluate(1390);
  assert.equal(store.orders().length, 3);
  assert.equal(istDay(Date.parse('2026-11-09T19:00:00Z')), '2026-11-10');
});
test('breakout requires a cross; SMA uses the prior and current polling windows', () => {
  const base = { preset: 'breakout', previous: null, level: 100 };
  assert.equal(signal(base, 101), false);
  assert.equal(signal({ ...base, previous: 101 }, 102), false);
  assert.equal(signal({ ...base, previous: 100 }, 101), true);
  assert.equal(signal({ preset: 'sma', samples: Array(12).fill(100) }, 101), false);
  assert.equal(signal({ preset: 'sma', samples: [...Array(12).fill(100), 110] }, 110), true);
  assert.equal(signal({ preset: 'sma', samples: [...Array(12).fill(100), 90] }, 90), false);
});
test('swing preset requires manual resistance and at least 2:1 configured reward/risk', t => {
  const { store, bot } = fixture(t);
  const preset = presets.find(item => item.id === 'swing');
  assert.deepEqual(preset.defaults, { level: null, stopPct: 3, targetPct: 6 });
  const config = { ...bot, preset: 'swing', level: 1400, stopPct: 3, targetPct: 6 };
  assert.equal(validateBot(config, store.settings()).preset, 'swing');
  for (const level of [null, undefined, 0]) {
    assert.throws(() => validateBot({ ...config, level }, store.settings()), /Entry level/);
  }
  assert.throws(() => validateBot({ ...config, targetPct: 5.9 }, store.settings()), /2:1/);
  assert.equal(validateBot({ ...config, stopPct: 4, targetPct: 8 }, store.settings()).targetPct, 8);
  assert.equal(validateBot({ ...config, preset: 'breakout', targetPct: 3 }, store.settings()).targetPct, 3);
  assert.equal(signal({ preset: 'swing', previous: null, level: 1400 }, 1401), false);
  assert.equal(signal({ preset: 'swing', previous: 1401, level: 1400 }, 1402), false);
  assert.equal(signal({ preset: 'swing', previous: 1399, level: 1400 }, 1400), false);
  assert.equal(signal({ preset: 'swing', previous: 1400, level: 1400 }, 1401), true);
});
test('swing entries obey risk limits and carry overnight with paused gap-stop monitoring', t => {
  const { store, bot, evaluate, time } = fixture(t);
  const settings = store.settings();
  settings.mode = 'angel';
  settings.maxTradeRisk = 100;
  store.saveSettings(settings);
  store.saveBot({ ...bot, preset: 'swing', stopPct: 3, targetPct: 6 });
  assert.equal(evaluate(1401, 'angel').position, null, 'starting above resistance does not trigger');
  evaluate(1400, 'angel');
  const opened = evaluate(1401, 'angel');
  assert.ok(opened.position);
  assert.equal(opened.position.qty, 2);
  assert.ok(opened.position.maxLoss <= settings.maxTradeRisk);
  assert.equal(opened.position.stop, Math.round(opened.position.entry * 0.97 * 100) / 100);
  assert.equal(opened.position.target, Math.round(opened.position.entry * 1.06 * 100) / 100);
  assert.equal(store.orders()[0].reason, 'Swing breakout');
  time(Date.parse('2026-11-09T15:30:00+05:30'));
  assert.ok(evaluate(1401, 'angel').position, 'no automatic end-of-day close');
  time(Date.parse('2026-11-10T09:15:00+05:30'));
  assert.ok(evaluate(1401, 'angel').position, 'position survives the IST day boundary');
  store.saveBot({ ...store.bot(bot.id), status: 'paused' });
  evaluate(opened.position.stop - 30, 'angel');
  assert.equal(store.bot(bot.id).position, null);
  assert.equal(store.orders()[0].reason, 'Stop loss');
  assert.ok(store.orders()[0].pnl < -opened.position.maxLoss);
});
test('malformed configs, shorts, unsupported stocks, bad risk, and live flags rejected', t => {
  const { store, bot } = fixture(t);
  const settings = store.settings();
  for (const overrides of [{ stopPct: NaN }, { stopPct: -1 }, { targetPct: 0.1 }, { budget: '1000' }, { symbol: 'NFO:NIFTY' }, { symbol: 'INVALID TICKER' }, { preset: 'custom' }, { execution: 'live' }, { name: '' }, { level: Infinity }]) {
    assert.throws(() => validateBot({ ...bot, ...overrides }, settings));
  }
  assert.throws(() => validateRisk({ ...settings, maxDailyTrades: 1.1 }, settings));
  assert.throws(() => validateRisk({ ...settings, dailyLossLimit: 1 }, settings));
  assert.equal(validQuote({ price: NaN, source: 'angel', at: new Date(MONDAY).toISOString() }, 'angel', MONDAY), false);
  assert.equal(entryWindow(Date.parse('2026-11-09T09:14:59+05:30')), false);
  assert.equal(entryWindow(Date.parse('2026-11-09T09:15:00+05:30')), true);
});
test('SQLite restart preserves configuration, open position, orders and daily guard', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tradegrok-test-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'test.sqlite');
  let store = new Store(path);
  const engine = new Engine(store, {}, { now: () => MONDAY });
  const bot = store.bots()[0];
  Object.assign(bot, { preset: 'dip', level: 1400, status: 'running' }); store.saveBot(bot);
  engine.quotes.set(bot.symbol, { price: 1390, at: new Date(MONDAY).toISOString(), source: 'angel' });
  store.transaction(() => engine.evaluate(bot));
  const cash = store.settings().cash;
  store.close();
  store = new Store(path);
  assert.ok(store.bot(bot.id).position);
  assert.equal(store.bot(bot.id).lastEntryDay, '2026-11-09');
  assert.equal(store.settings().cash, cash);
  assert.equal(store.orders().length, 1);
  assert.equal(store.bots().length, 1);
  store.close();
});
test('transaction rolls back orders, bot state and cash together', t => {
  const { store, engine, bot, quote } = fixture(t);
  engine.quotes.set(bot.symbol, quote());
  assert.throws(() => store.transaction(() => { engine.evaluate(store.bot(bot.id)); throw new Error('Injected failure'); }));
  assert.equal(store.orders().length, 0);
  assert.equal(store.bot(bot.id).position, null);
  assert.equal(store.settings().cash, 100000);
});
test('broker fetch failure blocks the entire cycle, never substitutes prices', async t => {
  const { store, engine } = fixture(t);
  const settings = store.settings(); settings.mode = 'angel'; store.saveSettings(settings);
  engine.broker = { status: () => ({ status: 'connected' }), quote: async () => { throw new Error('Network failed'); } };
  assert.equal(await engine.tick(), false);
  assert.equal(store.orders().length, 0);
  assert.equal(engine.quotes.size, 0);
  assert.match(engine.error, /runner failed/);
});
test('missing SmartAPI login never creates prices or equity history, even with paused bots', async t => {
  const { store, engine } = fixture(t);
  let calls = 0;
  engine.broker = { status: () => ({ status: 'awaiting_login' }), quote: async () => { calls++; } };
  assert.equal(await engine.tick(), false);
  assert.equal(calls, 0);
  assert.equal(engine.quotes.size, 0);
  assert.equal(store.orders().length, 0);
  assert.equal(store.equity().length, 0);
  assert.match(engine.error, /unavailable until verified/);
});
test('paper valuation is unavailable instead of using a fabricated mark when quotes are missing', t => {
  const { store, engine, evaluate } = fixture(t);
  evaluate(1390);
  engine.quotes.clear();
  const result = metrics(store, engine.quotes, MONDAY);
  assert.equal(result.equity, null);
  assert.equal(result.unrealised, null);
  assert.equal(result.totalPnl, null);
  assert.ok(result.cash > 0);
  assert.ok(result.invested > 0);
});
test('stale quotes value positions at the last market price, not entry cost', t => {
  const { store, engine, evaluate, quote } = fixture(t);
  const opened = evaluate(1390);
  engine.quotes.set(opened.symbol, quote(1400));
  const result = metrics(store, engine.quotes, MONDAY + 61000);
  const value = number => Math.round((number + Number.EPSILON) * 100) / 100;
  assert.equal(result.equity, value(store.settings().cash + 1400 * opened.position.qty));
  assert.equal(result.unrealised, value((1400 - opened.position.entry) * opened.position.qty));
  assert.equal(result.totalPnl, value(result.equity - store.settings().initialCash));
  assert.equal(result.stalePositions, 1);
  assert.equal(result.unavailablePositions, 0);
  assert.equal(result.valuationAt, quote().at);
});
test('saved valuation survives failed cycles and restarts without allowing stale fills or chart observations', async t => {
  const { store, engine, bot, quote, time } = fixture(t);
  engine.broker = { status: () => ({ status: 'connected' }), quote: async () => quote(1390) };
  assert.equal(await engine.tick(), true);
  assert.equal(store.valuationQuotes().length, 1);
  const opened = store.bot(bot.id), historyLength = store.equity().length;
  const closedTime = Date.parse('2026-11-14T10:00:00+05:30');
  time(closedTime);
  engine.broker.quote = async () => ({ ...quote(1300), at: new Date(MONDAY).toISOString() });
  assert.equal(await engine.tick(), true);
  assert.equal(store.orders().length, 1);
  assert.equal(store.equity().length, historyLength);
  const expected = Math.round((store.settings().cash + 1300 * opened.position.qty) * 100) / 100;
  assert.equal(metrics(store, engine.quotes, closedTime).equity, expected);
  engine.broker.quote = async () => { throw new Error('Network failed'); };
  assert.equal(await engine.tick(), false);
  assert.equal(engine.quotes.size, 0);
  const restarted = new Engine(store, engine.broker, { now: () => closedTime });
  assert.equal(restarted.quotes.size, 0);
  assert.equal(metrics(store, restarted.quotes, closedTime).equity, expected);
  assert.throws(() => store.transaction(() => restarted.exit(store.bot(bot.id), restarted.quotes.get(bot.symbol), 'Manual')), /fresh/);
  assert.equal(store.orders().length, 1);
  time(MONDAY + 86400000);
  engine.broker.quote = async () => quote(1400);
  assert.equal(await engine.tick(), true);
  assert.equal(metrics(store, engine.quotes, MONDAY + 86400000).stalePositions, 0);
  assert.equal(store.equity().length, historyLength + 1);
});
test('valuation rejects invalid quotes and missing marks rather than reporting a partial portfolio', t => {
  const { store, engine, evaluate, quote } = fixture(t);
  const opened = evaluate(1390);
  for (const invalid of [
    quote(1400, 'unsupported'), quote(0), quote(NaN),
    { ...quote(), at: 'invalid' }, { ...quote(), at: new Date(MONDAY + 6000).toISOString() },
    { ...quote(), symbol: 'ITC' }
  ]) {
    engine.quotes.set(opened.symbol, invalid);
    assert.equal(metrics(store, engine.quotes, MONDAY).equity, null);
  }
  store.saveValuationQuote(quote(1400));
  assert.ok(metrics(store, engine.quotes, MONDAY + 61000).equity > 0);
  engine.quotes.set(opened.symbol, quote(1380));
  store.saveValuationQuote({ ...quote(1400), at: new Date(MONDAY + 1000).toISOString() });
  assert.equal(metrics(store, engine.quotes, MONDAY + 61000).unrealised,
    Math.round((1400 - opened.position.entry) * opened.position.qty * 100) / 100);
  store.saveBot({ ...opened, id: 'missing-mark', symbol: 'ITC' });
  const result = metrics(store, engine.quotes, MONDAY + 61000);
  assert.equal(result.equity, null);
  assert.equal(result.unrealised, null);
  assert.equal(result.totalPnl, null);
  assert.equal(result.unavailablePositions, 1);
});
test('overlapping ticks are skipped; emergency pause during fetch wins over old state', async t => {
  const { store, engine, bot, quote } = fixture(t);
  const settings = store.settings(); settings.mode = 'angel'; store.saveSettings(settings);
  let resolve;
  engine.broker = { status: () => ({ status: 'connected' }), quote: () => new Promise(done => { resolve = done; }) };
  const tick = engine.tick();
  assert.equal(await engine.tick(), false);
  const current = store.bot(bot.id); current.status = 'paused'; current.revision = 1; store.saveBot(current);
  resolve(quote(1390, 'angel'));
  assert.equal(await tick, true);
  assert.equal(store.orders().length, 0);
});
