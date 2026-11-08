import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { presets, exitPresets, instruments } from '../server/store.js';

function fixture() {
  const elements = Object.fromEntries(['id', 'name', 'symbol', 'preset', 'level', 'budget', 'stopPct', 'targetPct', 'exitPreset', 'exitLevel', 'exitSessions', 'exitTime', 'exitMinGainPct'].map(name => [name, { name, value: '' }]));
  const listeners = {};
  const form = {
    elements, reset() { for (const input of Object.values(elements)) input.value = ''; },
    addEventListener(name, callback) { listeners[name] = callback; }
  };
  const nodes = {
    '#bot-form': form, '#preset-help': {}, '#level-label': {}, '#bot-dialog-title': {},
    '#exit-preset-help': {}, '#exit-level-label': {}, '#exit-time-fields': {}, '#exit-gain-label': {}, '#exit-time-help': {},
    '#symbol-options': {}, '#symbol-help': {},
    '#bot-error': {}, '#clock': {}, '#bot-dialog': { open: false, showModal() { this.open = true; } }
  };
  const context = createContext({
    document: { querySelector: selector => nodes[selector], addEventListener() {} },
    location: { search: '' }, URLSearchParams, setInterval() {}, clearTimeout() {}, setTimeout() {},
    fetch: () => new Promise(() => {})
  });
  runInContext(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  context.snapshot = { presets, exitPresets, instruments, quotes: [], settings: { maxPosition: 25000, initialCash: 100000 } };
  runInContext('state = snapshot', context);
  return { elements, nodes, listeners, run: code => runInContext(code, context), context };
}

test('selecting swing applies defaults and requires an explicit daily-chart level', () => {
  const { elements, nodes, listeners } = fixture();
  elements.preset.value = 'swing';
  elements.symbol.value = 'RELIANCE';
  elements.level.value = 1410;
  listeners.change({ target: { name: 'preset' } });
  assert.equal(elements.stopPct.value, 3);
  assert.equal(elements.targetPct.value, 6);
  assert.equal(elements.targetPct.min, 6);
  assert.equal(elements.level.value, '');
  assert.equal(elements.level.required, true);
  assert.equal(elements.level.disabled, false);
  assert.match(nodes['#preset-help'].textContent, /earnings/);
  elements.stopPct.value = 4;
  elements.targetPct.value = 8;
  elements.level.value = 1420;
  listeners.change({ target: { name: 'stopPct' } });
  assert.equal(elements.targetPct.min, 8);
  assert.equal(elements.level.value, 1420);
  elements.symbol.value = 'ITC';
  listeners.change({ target: { name: 'symbol' } });
  assert.equal(elements.level.value, '');
  assert.equal(elements.stopPct.value, 4);
  assert.equal(elements.targetPct.value, 8);
  elements.preset.value = 'sma';
  listeners.change({ target: { name: 'preset' } });
  assert.equal(elements.stopPct.value, 1);
  assert.equal(elements.targetPct.value, 2);
  assert.equal(elements.level.disabled, true);
  assert.equal(elements.level.required, false);
});

test('opening a saved swing bot preserves customized prices and risk settings', () => {
  const { elements, context, run } = fixture();
  context.savedBot = { id: 'saved', name: 'Swing', symbol: 'ITC', preset: 'swing', level: 435, budget: 5000, stopPct: 4, targetPct: 9 };
  run('openBot(savedBot)');
  assert.equal(elements.level.value, 435);
  assert.equal(elements.stopPct.value, 4);
  assert.equal(elements.targetPct.value, 9);
  assert.equal(elements.targetPct.min, 8);
  assert.equal(elements.level.disabled, false);
});
test('entry suggestions require a fresh actual SmartAPI price and never use a synthetic base', () => {
  const { elements, listeners, context } = fixture();
  elements.symbol.value = 'RELIANCE';
  elements.preset.value = 'breakout';
  listeners.change({ target: { name: 'preset' } });
  assert.equal(elements.level.value, '');
  context.snapshot.quotes.push({ symbol: 'RELIANCE', source: 'angel', price: 1400, at: new Date().toISOString() });
  listeners.change({ target: { name: 'symbol' } });
  assert.equal(elements.level.value, '1414.00');
  context.snapshot.quotes[0].at = new Date(Date.now() - 120000).toISOString();
  listeners.change({ target: { name: 'symbol' } });
  assert.equal(elements.level.value, '');
});
test('overview labels stale capital and quote time, distinguishing missing valuations', () => {
  const { context, run } = fixture();
  Object.assign(context.snapshot, {
    bots: [], equity: [], events: [], orders: [], connection: { status: 'connected' },
    engine: { error: null, lastTick: null },
    metrics: { equity: 99990.2, totalPnl: -9.8, cash: 80380.75, invested: 19609.45, unrealised: 0,
      stalePositions: 1, unavailablePositions: 0, valuationAt: '2026-11-06T15:30:00+05:30',
      dayLoss: 0, openRisk: 0, entriesToday: 0, running: 0, positions: 1 }
  });
  Object.assign(context.snapshot.settings, { mode: 'angel', dailyLossLimit: 2000, maxTradeRisk: 500, maxDailyTrades: 10 });
  const html = run('overview()');
  assert.match(html, /99,990\.20/);
  assert.match(html, /Last known prices/);
  assert.match(html, /Oldest quote 06 Nov/);
  assert.match(html, /These are not live values/);
  assert.match(html, /No fills on stale prices/);
  assert.doesNotMatch(html, /Current equity and unrealised P&amp;L are unavailable/);
  context.snapshot.metrics.unavailablePositions = 1;
  context.snapshot.metrics.equity = null;
  context.snapshot.metrics.totalPnl = null;
  const missing = run('overview()');
  assert.match(missing, /no saved valid SmartAPI quote/);
  assert.doesNotMatch(missing, /Last known prices/);
  context.snapshot.metrics.stalePositions = 0;
  context.snapshot.metrics.unavailablePositions = 0;
  assert.doesNotMatch(run('banners()'), /last known SmartAPI prices/);
});

test('exit strategies expose only their required fields and do not modify entry rules', () => {
  const { elements, nodes, listeners } = fixture();
  elements.preset.value = 'swing'; elements.level.value = 435; elements.stopPct.value = 4; elements.targetPct.value = 8;
  elements.exitPreset.value = 'scheduled';
  listeners.change({ target: { name: 'exitPreset' } });
  assert.equal(elements.exitSessions.value, 3);
  assert.equal(elements.exitTime.value, '15:00');
  assert.equal(elements.exitTime.required, true);
  assert.equal(nodes['#exit-time-fields'].hidden, false);
  assert.equal(elements.exitLevel.disabled, true);
  assert.equal(elements.exitMinGainPct.disabled, true);
  assert.equal(elements.preset.value, 'swing');
  assert.equal(elements.level.value, 435);
  assert.equal(elements.stopPct.value, 4);
  elements.exitPreset.value = 'time-performance';
  listeners.change({ target: { name: 'exitPreset' } });
  assert.equal(elements.exitMinGainPct.value, 1);
  assert.equal(elements.exitMinGainPct.required, true);
  elements.exitPreset.value = 'support';
  listeners.change({ target: { name: 'exitPreset' } });
  assert.equal(elements.exitLevel.required, true);
  assert.equal(elements.exitTime.disabled, true);
  elements.exitPreset.value = 'protective';
  listeners.change({ target: { name: 'exitPreset' } });
  assert.equal(elements.exitLevel.disabled, true);
  assert.equal(elements.exitSessions.disabled, true);
});

test('editing preserves custom timed exit parameters independently of entry preset changes', () => {
  const { elements, listeners, context, run } = fixture();
  context.savedBot = { id: 'saved', name: 'Timed dip', symbol: 'ITC', preset: 'dip', level: 435, budget: 5000, stopPct: 2, targetPct: 5, exitPreset: 'time-performance', exitSessions: 1, exitTime: '14:45', exitMinGainPct: 2.5 };
  run('openBot(savedBot)');
  assert.equal(elements.exitSessions.value, 1);
  assert.equal(elements.exitTime.value, '14:45');
  assert.equal(elements.exitMinGainPct.value, 2.5);
  elements.preset.value = 'sma';
  listeners.change({ target: { name: 'preset' } });
  assert.equal(elements.exitPreset.value, 'time-performance');
  assert.equal(elements.exitTime.value, '14:45');
  assert.equal(elements.exitMinGainPct.value, 2.5);
});
test('saved tickers outside the quick picks remain editable without changing their rules', () => {
  const { elements, nodes, context, run } = fixture();
  context.savedBot = { id: 'saved', name: 'New ticker', symbol: 'M&M', preset: 'dip', level: 435, budget: 5000, stopPct: 2, targetPct: 5, exitPreset: 'scheduled', exitSessions: 1, exitTime: '14:45' };
  run('openBot(savedBot)');
  assert.equal(elements.symbol.value, 'M&M');
  assert.match(nodes['#symbol-options'].innerHTML, /M&amp;M/);
  assert.equal(elements.level.value, 435);
  assert.equal(elements.exitTime.value, '14:45');
});
test('SmartAPI ticker search populates dropdown results and discards superseded responses', async () => {
  const { nodes, context, run } = fixture();
  nodes['#bot-dialog'].open = true;
  context.result = { instruments: [{ symbol: 'M&M', name: 'M&M-EQ' }], more: false };
  run('api = async () => result; symbolSearchRevision = 1');
  await run('searchSymbols("M&", 1)');
  assert.match(nodes['#symbol-options'].innerHTML, /value="M&amp;M"/);
  assert.match(nodes['#symbol-help'].textContent, /1 SmartAPI NSE matches/);
  nodes['#symbol-options'].innerHTML = 'latest options';
  run('symbolSearchRevision = 2');
  await run('searchSymbols("OLD", 1)');
  assert.equal(nodes['#symbol-options'].innerHTML, 'latest options');
  run('api = async () => { throw new Error("Login required"); }');
  await run('searchSymbols("NEW", 2)');
  assert.match(nodes['#symbol-help'].textContent, /Ticker search unavailable: Login required/);
});
test('typing a different ticker clears symbol-specific entry/support levels but preserves risk and exit settings', () => {
  const { elements, nodes, listeners } = fixture();
  Object.assign(elements.symbol, { value: 'sbicard' });
  elements.level.value = 435; elements.exitLevel.value = 425;
  elements.stopPct.value = 2; elements.exitTime.value = '14:45';
  listeners.input({ target: elements.symbol });
  assert.equal(elements.symbol.value, 'SBICARD');
  assert.equal(elements.level.value, '');
  assert.equal(elements.exitLevel.value, '');
  assert.equal(elements.stopPct.value, 2);
  assert.equal(elements.exitTime.value, '14:45');
  assert.match(nodes['#symbol-help'].textContent, /Searching SmartAPI/);
});
