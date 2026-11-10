import test from 'node:test';
import assert from 'node:assert/strict';
import { stockDefaults, ruleConstant } from '../demo/defaults.js';
import { defaultRisk, defaultRule, entryPresets, exitPresets, validateStrategy } from '../demo/engine.js';
import { atMinute, sessionFor } from '../demo/data.js';

function session(day, price, volume = 1000) {
  const { open, close } = sessionFor(day);
  return Array.from({ length: close - open }, (_, i) => [atMinute(day, open + i), price, price * 1.02, price * 0.98, price, volume + i]);
}
const settings = { from: '2026-08-03', through: '2026-08-05', preset: 'breakout', exitPreset: 'protective', risk: defaultRisk };
const data = { symbol: 'TEST', bars: [...session('2026-08-03', 100), ...session('2026-08-04', 110), ...session('2026-08-05', 120)] };

test('every entry/exit preset receives valid stock-scaled starter inputs', () => {
  for (const factor of [1, 3.75, 12.51, 42]) {
    const scaled = { ...data, bars: data.bars.map(([time, ...values]) => [time, ...values.map((value, i) => i < 4 ? value * factor : value)]) };
    for (const preset of Object.keys(entryPresets)) for (const exitPreset of Object.keys(exitPresets)) {
      const profile = stockDefaults(scaled, { ...settings, preset, exitPreset });
      validateStrategy({ ...profile.values, name: 'Stock defaults', symbol: 'TEST', preset, exitPreset, entryRule: defaultRule(), exitRule: defaultRule(true) }, defaultRisk);
      assert.equal(profile.values.targetPct, profile.values.stopPct * 2);
      assert.ok(profile.values.budget <= defaultRisk.maxPosition);
      assert.ok(profile.values.exitLevel < (profile.levels[preset] ?? profile.price));
      assert.equal(profile.values.exitSessions, exitPreset === 'scheduled' ? 1 : preset === 'swing' ? 5 : 3);
      assert.equal(profile.values.exitTime, '15:00');
    }
  }
});

test('the first available session uses its open, not future prices or returns', () => {
  const initial = stockDefaults(data, settings);
  assert.equal(initial.price, 100);
  assert.equal(initial.values.level, 100.5);
  assert.equal(initial.levels.dip, 99);
  assert.equal(initial.levels.swing, 101);
  assert.equal(initial.values.stopPct, 1);
  assert.equal(initial.historySessions, 0);
  const changed = structuredClone(data);
  changed.bars[0][2] = 900; changed.bars[0][4] = 800;
  for (const bar of changed.bars.slice(1)) for (let i = 1; i < 6; i++) bar[i] *= 10;
  assert.deepEqual(stockDefaults(changed, settings), initial);
});

test('later start dates use only earlier complete sessions for levels, volatility and volume', () => {
  const options = { ...settings, from: '2026-08-04' };
  const profile = stockDefaults(data, options);
  assert.equal(profile.historySessions, 1);
  assert.equal(profile.basis, '2026-08-03 close');
  assert.equal(profile.price, 100);
  assert.equal(profile.values.level, 102.1);
  assert.equal(profile.values.stopPct, 4);
  assert.equal(profile.volume, 1179.5);
  const changed = structuredClone(data);
  for (const bar of changed.bars) if (bar[0] >= atMinute('2026-08-04', 0)) for (let i = 1; i < 6; i++) bar[i] *= 20;
  assert.deepEqual(stockDefaults(changed, options), profile);
  const incomplete = structuredClone(data);
  incomplete.bars.splice(20, 1);
  const fallback = stockDefaults(incomplete, options);
  assert.equal(fallback.historySessions, 0);
  assert.equal(fallback.price, 110);
  assert.match(fallback.basis, /no earlier complete session/);
});

test('manual stop/entry inputs guide dependent suggestions without raising risk limits', () => {
  const profile = stockDefaults(data, { ...settings, level: 105, stopPct: 2, targetPct: 5, exitPreset: 'support' });
  assert.equal(profile.values.targetPct, 4);
  assert.equal(profile.support, 103.43);
  assert.equal(profile.targetPrice, 110.25);
  assert.ok(profile.values.budget <= 10000);
  const expensive = { ...data, bars: session('2026-08-03', 100000) };
  const limited = stockDefaults(expensive, settings);
  assert.equal(limited.canSize, false);
  assert.ok(limited.values.budget <= defaultRisk.maxPosition);
  assert.deepEqual(defaultRisk, { initialCash: 100000, maxTradeRisk: 500, dailyLossLimit: 2000, maxDailyTrades: 10, maxPosition: 25000 });
});

test('custom-rule constants respect price, RSI, volume and time units', () => {
  const profile = stockDefaults(data, settings);
  assert.equal(ruleConstant('close', 'above', false, profile), 100.5);
  assert.equal(ruleConstant('close', 'below', false, profile), 99);
  assert.equal(ruleConstant('close', 'below', true, profile), profile.support);
  assert.equal(ruleConstant('close', 'above', true, profile), profile.targetPrice);
  assert.equal(ruleConstant('rsi', 'below', false, profile), 30);
  assert.equal(ruleConstant('rsi', 'above', true, profile), 70);
  assert.equal(ruleConstant('volume', 'above', false, profile), 1500);
  assert.equal(ruleConstant('volume', 'below', false, profile), 500);
  assert.equal(ruleConstant('time', 'above', false, profile), 570);
  assert.equal(ruleConstant('time', 'above', true, profile), 900);
  assert.ok(Number.isNaN(ruleConstant('close', 'above', false)));
  assert.equal(defaultRule(true).rules[0].op, 'crosses-below');
});

test('missing ranges and unsupported price defaults fail explicitly', () => {
  assert.throws(() => stockDefaults(data, { ...settings, from: '2026-09-01', through: '2026-09-02' }), /No continuous-session candles/);
  assert.throws(() => stockDefaults(data, { ...settings, from: '2026-08-05', through: '2026-08-03' }), /valid date range/);
  assert.throws(() => stockDefaults({ symbol: 'TEST', bars: [] }, settings), /Import candles/);
  assert.throws(() => stockDefaults({ symbol: 'TEST', bars: session('2026-08-03', 2000000) }, settings), /outside the supported/);
  const penny = { symbol: 'TEST', bars: session('2026-08-03', 1) };
  const support = { ...settings, preset: 'sma', exitPreset: 'support' };
  assert.throws(() => stockDefaults(penny, support), /No valid support default/);
  assert.equal(stockDefaults(penny, { ...support, exitLevel: 1 }).support, 1);
});
