import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { Engine, entryWindow } from '../server/engine.js';
import { executionWindow, holdingSession, regularSession, tradingSession } from '../server/market-calendar.js';
import { sessionDates } from '../server/backtest.js';

const at = clock => Date.parse(`2026-11-08T${clock}+05:30`);
function fixture(t, symbol = 'NIFTYBEES') {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let now = at('14:36:00');
  const records = [];
  const engine = new Engine(store, {}, { now: () => now });
  const bot = store.bots()[0];
  Object.assign(bot, { symbol, preset: 'dip', status: 'running', level: 101, exitPreset: 'protective' });
  store.saveBot(bot);
  const evaluate = (price = 100, quoteAt = now) => {
    engine.quotes.set(symbol, { symbol, source: 'angel', price, at: new Date(quoteAt).toISOString() });
    store.transaction(() => records.push(engine.evaluate(store.bot(bot.id))));
    return store.bot(bot.id);
  };
  return { store, bot, engine, evaluate, records, time: value => { now = value; } };
}
test('only verified Muhurat date gets a special window; NIFTYBEES closes precisely at 15:30', () => {
  assert.equal(entryWindow(at('14:19:59'), 'NIFTYBEES'), false);
  assert.equal(entryWindow(at('14:20:00'), 'NIFTYBEES'), true);
  assert.equal(entryWindow(at('15:29:59'), 'NIFTYBEES'), true);
  assert.equal(entryWindow(at('15:30:00'), 'NIFTYBEES'), false);
  assert.equal(entryWindow(at('15:14:59'), 'RELIANCE'), true);
  assert.equal(entryWindow(at('15:15:00'), 'RELIANCE'), false);
  assert.equal(entryWindow(at('15:15:00'), 'UNVERIFIED'), false);
  assert.equal(entryWindow(Date.parse('2026-11-15T14:30:00+05:30'), 'NIFTYBEES'), false);
  assert.equal(entryWindow(Date.parse('2026-11-09T15:20:00+05:30'), 'NIFTYBEES'), false);
  assert.equal(executionWindow(at('14:36:00'), 'NIFTYBEES').specialSession, true);
});
test('Muhurat allows existing paper entry/target rules and logs actual special-session eligibility', t => {
  const f = fixture(t);
  const held = f.evaluate();
  assert.ok(held.position);
  assert.equal(f.records[0].market.entryWindowOpen, true);
  assert.equal(f.records[0].market.specialSession, true);
  assert.match(f.records[0].market.window, /14:20-15:30/);
  assert.equal(f.records[0].checks.continuousSession.passed, true);
  f.time(at('15:29:59'));
  assert.equal(f.evaluate(held.position.target + 1).position, null);
  assert.equal(f.store.orders()[0].reason, 'Take profit');
  assert.ok(f.store.orders().every(order => order.execution === 'paper' && order.source === 'angel'));
});
test('pre-open/auction/post-close prices never create paper fills, even when fresh or protective', t => {
  const f = fixture(t);
  f.time(at('14:20:10'));
  f.evaluate(100, at('14:19:59'));
  assert.equal(f.store.orders().length, 0);
  assert.equal(f.records.at(-1).checks.continuousSession.quoteOpen, false);
  f.time(at('14:36:00'));
  const held = f.evaluate();
  f.time(at('15:30:00'));
  assert.ok(f.evaluate(held.position.stop - 1).position);
  assert.equal(f.store.orders().length, 1);
  assert.throws(() => f.store.transaction(() => f.engine.exit(f.store.bot(f.bot.id), f.engine.quotes.get(f.bot.symbol), 'Stop loss')), { code: 'EXIT_WINDOW' });
  const cas = fixture(t, 'RELIANCE');
  const casHeld = cas.evaluate();
  cas.time(at('15:15:00'));
  assert.ok(cas.evaluate(casHeld.position.stop - 1).position);
  assert.equal(cas.store.orders().length, 1);
});
test('manual and timed same-day exits work in Muhurat; historical regular replay stays explicitly unsupported', t => {
  const f = fixture(t);
  f.evaluate();
  f.time(at('15:25:00'));
  f.engine.quotes.set(f.bot.symbol, { source: 'angel', price: 100, at: new Date(at('15:25:00')).toISOString() });
  f.store.transaction(() => f.engine.exit(f.store.bot(f.bot.id), f.engine.quotes.get(f.bot.symbol), 'Manual paper close'));
  assert.equal(f.store.bot(f.bot.id).position, null);
  const timed = fixture(t);
  const bot = timed.store.bot(timed.bot.id);
  Object.assign(bot, { exitPreset: 'scheduled', exitSessions: 1, exitTime: '15:00' }); timed.store.saveBot(bot);
  timed.evaluate(); timed.time(at('15:00:00'));
  assert.equal(timed.evaluate().position, null);
  assert.equal(tradingSession('2026-11-08'), true);
  assert.equal(holdingSession('2026-11-08', '2026-11-09'), 2);
  assert.throws(() => regularSession('2026-11-08'), { code: 'EXIT_CALENDAR' });
  assert.throws(() => sessionDates(at('16:01:00')), { code: 'BACKTEST_CALENDAR' });
});
