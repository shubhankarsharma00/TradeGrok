import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { Engine, validateBot, timedExitSignal, money } from '../server/engine.js';
import { holdingSession, regularSession } from '../server/market-calendar.js';

const at = clock => Date.parse(`2026-11-09T${clock}+05:30`);
function fixture(t, overrides = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let now = at('10:00:00');
  const engine = new Engine(store, {}, { now: () => now });
  const bot = store.bots()[0];
  Object.assign(bot, { preset: 'dip', level: 1400, status: 'running', exitPreset: 'scheduled', exitSessions: 1, exitTime: '15:00', ...overrides });
  store.saveBot(bot);
  const evaluate = (price = 1390, quoteTime = now) => {
    const quote = { symbol: bot.symbol, price, source: 'angel', at: new Date(quoteTime).toISOString() };
    engine.quotes.set(bot.symbol, quote);
    store.transaction(() => engine.evaluate(store.bot(bot.id)));
    return store.bot(bot.id);
  };
  return { store, engine, bot, evaluate, time: time => { now = time; } };
}

test('exit configuration allows same-day holding and validates timed presets precisely', t => {
  const { store, bot } = fixture(t);
  assert.equal(validateBot({ ...bot, intraday: true }, store.settings()).holdingMode, 'flexible');
  for (const exitPreset of ['max-hold', 'scheduled', 'time-performance']) {
    const config = { ...bot, exitPreset, exitMinGainPct: 1 };
    assert.equal(validateBot(config, store.settings()).exitSessions, 1);
    for (const exitSessions of [0, 61, 1.5, '1', NaN]) assert.throws(() => validateBot({ ...config, exitSessions }, store.settings()), /Exit trading session/);
    for (const exitTime of ['9:15', '09:14', '15:15', '24:00', '12:60', null, 1500]) assert.throws(() => validateBot({ ...config, exitTime }, store.settings()), /Exit time/);
    for (const exitTime of ['09:15', '10:00', '14:59', '15:14']) assert.equal(validateBot({ ...config, exitTime }, store.settings()).exitTime, exitTime);
  }
  for (const exitMinGainPct of [-1, 31, '1', NaN]) assert.throws(() => validateBot({ ...bot, exitPreset: 'time-performance', exitMinGainPct }, store.settings()), /Minimum price gain/);
  assert.throws(() => validateBot({ ...bot, exitPreset: 'support', exitLevel: 0 }, store.settings()), /Exit support/);
  assert.throws(() => validateBot({ ...bot, exitPreset: 'unknown' }, store.settings()), /exit strategy/);
});

test('scheduled same-day exit waits for both clock and fresh exchange quote to reach deadline', t => {
  const { store, bot, evaluate, time } = fixture(t);
  evaluate();
  time(at('14:59:59')); assert.ok(evaluate().position);
  assert.ok(evaluate(1390, at('15:00:00')).position, 'future feed timestamp must not trigger an early clock exit');
  time(at('15:00:00')); assert.ok(evaluate(1390, at('14:59:59')).position);
  assert.equal(evaluate().position, null);
  assert.equal(store.orders()[0].reason, 'Exit strategy: Scheduled exit');
  const orders = store.orders();
  assert.equal(store.settings().cash, money(100000 - orders[1].price * orders[1].qty - orders[1].fee + orders[0].price * orders[0].qty - orders[0].fee));
  evaluate(); assert.equal(store.orders().length, 2, 'timed exit must not bypass same-day entry guard');
  assert.equal(store.bot(bot.id).lastEntryDay, '2026-11-09');
});

test('maximum holding period counts entry as session 1 and excludes weekends and verified holidays', t => {
  assert.equal(holdingSession('2026-11-09', '2026-11-11'), 2, 'November 10 is an NSE holiday');
  assert.equal(holdingSession('2026-11-13', '2026-11-16'), 2);
  assert.equal(regularSession('2026-11-10'), false);
  const { evaluate, time, store } = fixture(t, { exitPreset: 'max-hold', exitSessions: 2 });
  evaluate();
  time(at('15:00:00')); assert.ok(evaluate().position);
  time(Date.parse('2026-11-10T15:00:00+05:30')); assert.ok(evaluate().position);
  time(Date.parse('2026-11-11T14:59:59+05:30')); assert.ok(evaluate().position);
  time(Date.parse('2026-11-11T15:00:00+05:30')); assert.equal(evaluate().position, null);
  assert.equal(store.orders()[0].reason, 'Exit strategy: Maximum holding period');
});

test('missed deadlines catch up on the next eligible quote, not stale data or out-of-session marks', t => {
  const { evaluate, time, store } = fixture(t);
  evaluate();
  time(at('15:25:00')); assert.ok(evaluate().position);
  time(Date.parse('2026-11-11T09:15:00+05:30'));
  assert.ok(evaluate(1390, at('15:00:00')).position);
  assert.equal(evaluate(1385).position, null);
  assert.equal(store.orders()[0].price, money(1385 * 0.9995));
  assert.equal(store.orders()[0].at, '2026-11-11T03:45:00.000Z');
});

test('time + performance closes below the gain threshold and passes exactly at the threshold once', t => {
  const { evaluate, time, store } = fixture(t, { exitPreset: 'time-performance', exitMinGainPct: 1 });
  const opened = evaluate();
  time(at('15:00:00'));
  assert.equal(evaluate(opened.position.entry * 1.005).position, null);
  assert.equal(store.orders()[0].reason, 'Exit strategy: Time + performance');
  const model = { exitPreset: 'time-performance', exitSessions: 1, exitTime: '15:00', exitMinGainPct: 1, position: { entry: 100, openedAt: new Date(at('10:00:00')).toISOString() } };
  const quote = { price: 101, at: new Date(at('15:00:00')).toISOString() };
  assert.equal(timedExitSignal(model, quote, at('15:00:00')), false);
  assert.equal(model.position.timePerformancePassed, true);
  assert.equal(timedExitSignal(model, { ...quote, price: 100 }, at('15:00:00')), false);
});

test('a passed performance check retains protection and persists the pass in SQLite', t => {
  const { evaluate, time, store, bot } = fixture(t, { exitPreset: 'time-performance', exitMinGainPct: 1 });
  const opened = evaluate();
  time(at('15:00:00'));
  assert.ok(evaluate(1410).position.timePerformancePassed);
  assert.ok(evaluate(1390).position, 'a passed one-time performance check must not become a later threshold stop');
  assert.equal(store.bot(bot.id).position.timePerformancePassed, true);
  assert.equal(evaluate(opened.position.stop - 1).position, null);
  assert.equal(store.orders()[0].reason, 'Stop loss');
});

test('same-day SMA and support exits continue while paused and emergency locked', t => {
  for (const exitPreset of ['sma', 'support', 'scheduled']) {
    const { evaluate, time, store, bot } = fixture(t, { exitPreset, exitLevel: 1386 });
    evaluate();
    store.saveBot({ ...store.bot(bot.id), status: 'paused' });
    store.saveSettings({ ...store.settings(), emergency: true });
    if (exitPreset === 'sma') {
      for (let i = 0; i < 10; i++) assert.ok(evaluate().position);
      assert.equal(evaluate(1385).position, null);
    } else if (exitPreset === 'support') assert.equal(evaluate(1385).position, null);
    else { time(at('15:00:00')); assert.equal(evaluate().position, null); }
    assert.match(store.orders()[0].reason, /Exit strategy:/);
  }
});

test('protective stop and target take priority over simultaneously due timed exits', t => {
  for (const reason of ['Stop loss', 'Take profit']) {
    const { evaluate, time, store } = fixture(t);
    const opened = evaluate();
    time(at('15:00:00'));
    evaluate(reason === 'Stop loss' ? opened.position.stop - 1 : opened.position.target + 1);
    assert.equal(store.orders()[0].reason, reason);
  }
});

test('unknown calendar years or special sessions alert explicitly without suppressing protection', t => {
  const { evaluate, time, store, bot } = fixture(t);
  const opened = evaluate();
  time(Date.parse('2027-01-04T10:00:00+05:30'));
  assert.ok(evaluate().position);
  assert.match(store.bot(bot.id).message, /calendar is verified for 2026 only/);
  assert.equal(evaluate(opened.position.stop - 1).position, null);
  assert.equal(store.orders()[0].reason, 'Stop loss');
  assert.equal(holdingSession('2026-11-06', '2026-11-09'), 3, 'verified Muhurat day counts as a live holding session');
  assert.throws(() => holdingSession('2026-01-30', '2026-02-02'), { code: 'EXIT_CALENDAR' });
});

test('restart preserves exit deadline, SMA history, performance flag and daily guard without recreating deleted bots', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tradegrok-exits-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'test.sqlite');
  let store = new Store(path);
  const bot = store.bots()[0];
  const config = { ...bot, preset: 'dip', level: 1400, exitPreset: 'scheduled', exitSessions: 1, exitTime: '15:00', status: 'paused', exitSamples: [1390, 1385], lastEntryDay: '2026-11-09', position: { entry: 1390, qty: 1, stop: 1370, target: 1420, maxLoss: 22, source: 'angel', openedAt: new Date(at('10:00:00')).toISOString(), timePerformancePassed: true } };
  store.saveBot(config); store.close();
  store = new Store(path);
  assert.deepEqual(store.bot(bot.id), config);
  const engine = new Engine(store, {}, { now: () => at('15:00:00') });
  engine.quotes.set(bot.symbol, { price: 1390, source: 'angel', at: new Date(at('15:00:00')).toISOString() });
  store.transaction(() => engine.evaluate(store.bot(bot.id)));
  assert.equal(store.bot(bot.id).position, null);
  assert.equal(store.orders()[0].reason, 'Exit strategy: Scheduled exit');
  store.db.exec('DELETE FROM orders; DELETE FROM bots');
  store.close();
  store = new Store(path);
  assert.equal(store.bots().length, 0);
  store.close();
});
