import test from 'node:test';
import assert from 'node:assert/strict';
import { checksum } from '../demo/data.js';
import { createSimulation, defaultRisk } from '../demo/engine.js';
import { historyDataset, localBacktest } from '../public/local-backtest.js';

async function history() {
  const candles = Array.from({ length: 360 }, (_, minute) => ({
    at: new Date(Date.parse('2026-11-06T09:15:00+05:30') + minute * 60000).toISOString(),
    open: 100, high: 100.1, low: 99.9, close: 100, volume: 1000
  }));
  return { instrument: { symbol: 'M&M-EQ' }, request: { interval: 'ONE_MINUTE' }, source: 'fixture history', candles, sha256: await checksum(candles) };
}
test('local one-minute history runs nested custom entry and exit rules with the demo engine', async () => {
  const original = await history(), before = JSON.stringify(original);
  const dataset = await historyDataset(original);
  assert.equal(dataset.symbol, 'M&M');
  assert.equal(dataset.from, '2026-11-06');
  assert.equal(dataset.count, 360);
  assert.equal(dataset.sha256, await checksum(dataset.bars));
  assert.equal(JSON.stringify(original), before);
  const condition = (field, op, value) => ({ left: { field }, op, right: { field: 'number', value } });
  const bot = {
    id: 'custom', name: 'Local nested rules', symbol: dataset.symbol, datasetId: dataset.id, enabled: true,
    preset: 'rules', exitPreset: 'rules', budget: 10000, stopPct: 1, targetPct: 2,
    entryRule: { op: 'and', rules: [condition('close', 'above', 99), {
      op: 'or', rules: [condition('volume', 'above', 2000), condition('time', 'below', 570)]
    }] },
    exitRule: { op: 'and', rules: [condition('time', 'above', 570), {
      op: 'or', rules: [condition('close', 'above', 99), condition('volume', 'below', 500)]
    }] }
  };
  const simulation = createSimulation({ datasets: [dataset], strategies: [bot], risk: defaultRisk, from: dataset.from, through: dataset.through });
  while (!simulation.step(1000).done) {}
  const report = simulation.finish();
  assert.equal(report.trades.length, 1);
  assert.equal(report.trades[0].reason, 'Exit strategy');
  assert.deepEqual(report.strategies[0].entryRule, bot.entryRule);
});
test('history adapter rejects legacy, corrupt and malformed datasets rather than fabricating candles', async () => {
  const value = await history();
  await assert.rejects(historyDataset({ ...value, request: { interval: 'FIVE_MINUTE' } }), /one-minute/);
  await assert.rejects(historyDataset({ ...value, sha256: 'wrong' }), /checksum mismatch/);
  await assert.rejects(historyDataset({ ...value, instrument: { symbol: 'NSE:INVALID' } }), /invalid NSE ticker/);
  const candles = [{ ...value.candles[0], high: 1 }];
  await assert.rejects(historyDataset({ ...value, candles, sha256: await checksum(candles) }), /Invalid timestamp\/OHLCV/);
});
test('local bridge uses protected download-only requests and can reuse saved history without downloading', async t => {
  const originalFetch = globalThis.fetch, calls = [], data = await history();
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
    const value = path === '/api/state' ? { csrf: 'fixture-csrf', bots: [{ id: 'bot-1', symbol: 'M&M' }], settings: { ...defaultRisk, cash: 5 } }
      : path === '/api/backtest' ? { dataset: data } : data;
    return { ok: true, json: async () => value };
  };
  const state = await localBacktest.initialize();
  assert.deepEqual(state.risk, defaultRisk);
  await localBacktest.download({ botId: 'bot-1', symbol: ' m&m ', days: 3 });
  const mutation = calls.find(call => call.path === '/api/backtest');
  assert.equal(mutation.options.headers['X-Tradegrok-CSRF'], 'fixture-csrf');
  assert.deepEqual(JSON.parse(mutation.options.body), { botId: 'bot-1', symbol: 'M&M', days: 3, downloadOnly: true });
  calls.length = 0;
  assert.equal((await localBacktest.savedHistory()).symbol, 'M&M');
  assert.deepEqual(calls.map(call => call.path), ['/api/backtests/history']);
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ error: 'Broker login required.' }) });
  await assert.rejects(localBacktest.savedHistory(), /Broker login required/);
});
