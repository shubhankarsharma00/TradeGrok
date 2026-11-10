import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { csvRows, parseCsv, parseTimestamp, validateBars, coverage, candlesCsv, checksum, atMinute, sessionFor, toCsv, symbols } from '../demo/data.js';
import { createSimulation, defaultRisk, defaultRule, validateRule, validateRisk, indicatorSeries, ruleEvaluator } from '../demo/engine.js';
import { replayBot, prepareCandles } from '../server/backtest.js';
import { exportDemoData, exportChunks } from '../server/demo-export.js';

// Deterministic test fixtures, not exchange prices or publicly bundled market data.
const rowsFor = (from = '2026-08-03', through = from) => {
  const rows = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${through}T00:00:00Z`); t += 86400000) {
    const day = new Date(t).toISOString().slice(0, 10), session = sessionFor(day);
    if (!session) continue;
    for (let m = session.open; m < session.close; m++) {
      const index = m - session.open, close = index === 12 ? 103 : 100;
      rows.push([atMinute(day, m), 100, Math.max(101, close), 99.5, close, 1000]);
    }
  }
  return rows;
};
const makeData = (bars = rowsFor(), symbol = 'INFY') => ({ id: symbol, symbol, bars, sha256: 'test-only', source: 'deterministic test fixture', adjustment: 'unknown' });
const bot = (datasetId = 'INFY', preset = 'sma', exitPreset = 'protective') => ({ id: 'test-bot', name: 'Test fixture', symbol: datasetId, datasetId, enabled: true, preset, exitPreset, level: preset === 'dip' ? 101 : 102, stopPct: preset === 'swing' ? 3 : 1, targetPct: preset === 'swing' ? 6 : 2, budget: 10000, exitLevel: 99, exitSessions: 1, exitTime: '10:00', exitMinGainPct: 1, entryRule: defaultRule(), exitRule: defaultRule() });
const run = (config = {}) => {
  const sim = createSimulation({ datasets: [makeData()], strategies: [bot()], risk: defaultRisk, ...config });
  sim.step(1e6); return sim.finish();
};

test('CSV supports quoted/mapped headers, offset normalization and exact roundtrip', async () => {
  const csv = '\uFEFF"Date","Open","High","Low","Close","Vol"\r\n"2026-08-03 09:15",100,101,99,100,10\r\n';
  const mapping = { timestamp: 'Date', open: 'Open', high: 'High', low: 'Low', close: 'Close', volume: 'Vol' };
  const parsed = parseCsv(csv, mapping);
  assert.equal(parsed.bars[0][0], parseTimestamp('2026-08-03T03:45:00Z'));
  assert.deepEqual(parseCsv(candlesCsv(parsed.bars)).bars, parsed.bars);
  assert.equal(await checksum(parsed.bars), await checksum(parseCsv(candlesCsv(parsed.bars)).bars));
  assert.deepEqual(csvRows('a,b\n"x,y","a""b"\n'), [['a', 'b'], ['x,y', 'a"b']]);
  assert.match(toCsv([['=HYPERLINK("bad")']]), /'=HYPERLINK/);
});
test('CSV rejects malformed dates, empty fields, invalid OHLCV and conflicting duplicates', () => {
  for (const value of ['2026-02-30 09:15', '2026-08-03 24:00', '2026-08-03 09:15:01', '08/03/2026']) assert.throws(() => parseTimestamp(value));
  for (const text of ['a,b\n"x,y', 'a,a\n1,2', 'a,b\n"a"x,2']) assert.throws(() => csvRows(text));
  const bars = rowsFor().slice(0, 2);
  assert.equal(validateBars([...bars.toReversed(), bars[0]]).duplicates, 1);
  assert.equal(validateBars(bars.toReversed()).reordered, true);
  assert.throws(() => validateBars([bars[0], [bars[0][0], 200, 201, 199, 200, 10]]), /Conflicting/);
  assert.throws(() => validateBars([[bars[0][0], 100, 99, 99, 100, 1]]));
  assert.throws(() => parseCsv('timestamp,open,high,low,close,volume\n2026-08-03 09:15,,101,99,100,10'));
});
test('coverage catches missing whole sessions, gaps and zero volume without filling prices', () => {
  const bars = rowsFor('2026-08-03', '2026-08-04');
  assert.equal(coverage(bars).issues.length, 0);
  const missing = coverage(bars.filter(row => row[0] < atMinute('2026-08-04', 555)), { from: '2026-08-03', through: '2026-08-04' });
  assert.equal(missing.sessions[1].missing, 360);
  assert.ok(coverage(bars.slice(1)).issues.length);
  const zero = structuredClone(bars); zero[0][5] = 0;
  assert.ok(coverage(zero).issues.length);
  const old = [[parseTimestamp('2025-08-04 09:15'), 100, 101, 99, 100, 1]];
  assert.throws(() => coverage(old), /No verified/);
  assert.equal(coverage(old, { unverified: true }).verified, false);
  assert.throws(() => run({ datasets: [makeData(bars.slice(1))] }), /Coverage blocked/);
});
test('rules validate a bounded grammar; indicators have explicit warmup and no lookahead', () => {
  const bars = Array.from({ length: 10 }, (_, i) => [i * 60000, i + 1, i + 1, i + 1, i + 1, 100]);
  assert.deepEqual(indicatorSeries(bars, 'sma', 3).slice(0, 4), [null, null, 2, 3]);
  assert.deepEqual(indicatorSeries(bars, 'ema', 3).slice(0, 4), [null, null, 2, 3]);
  assert.deepEqual(indicatorSeries(bars, 'rsi', 3).slice(0, 4), [null, null, null, 100]);
  const rule = { op: 'and', rules: [{ left: { field: 'close' }, op: 'above', right: { field: 'sma', period: 3 } }] };
  validateRule(rule);
  assert.equal(ruleEvaluator(bars)(rule, 1), false);
  assert.equal(ruleEvaluator(bars)(rule, 2), true);
  const altered = structuredClone(bars); altered[9][4] = 99999;
  assert.equal(ruleEvaluator(altered)(rule, 2), ruleEvaluator(bars)(rule, 2));
  assert.throws(() => validateRule({ op: 'eval', left: { field: 'document.cookie' } }));
  assert.throws(() => validateRule({ op: 'and', rules: [] }));
  assert.throws(() => validateRule({ op: 'and', rules: Array(65).fill(rule.rules[0]) }));
  assert.throws(() => validateRule({ ...rule.rules[0], left: { field: 'close', value: 'not a number' } }));
  assert.throws(() => validateRisk({ ...defaultRisk, unexpected: 'not a risk limit' }));
});
test('all four presets and six exit presets match server replay on the same fixtures', () => {
  const bars = rowsFor();
  const raw = bars.map(([time, ...values]) => [new Date(time + 19800000).toISOString().replace('.000Z', '+05:30'), ...values]);
  const sessions = { intervalMinutes: 1, all: ['2026-08-03'], evaluated: ['2026-08-03'], warmup: [], schedules: { '2026-08-03': { open: '09:15', continuousClose: '15:15', sessionClose: '15:35', bars: 360 } } };
  const prepared = prepareCandles(raw, sessions);
  for (const preset of ['sma', 'dip', 'breakout', 'swing']) {
    for (const exit of ['protective', 'sma', 'support', 'scheduled', 'max-hold', 'time-performance']) {
      const strategy = bot('INFY', preset, exit);
      const server = replayBot(strategy, defaultRisk, prepared, sessions);
      const browser = run({ strategies: [strategy] });
      assert.equal(browser.summary.finalCapital, server.summary.finalCapital, `${preset}/${exit}`);
      assert.equal(browser.summary.trades, server.summary.trades, `${preset}/${exit}`);
      assert.deepEqual(browser.orders.map(o => [o.side, o.price, o.qty, o.fee]), server.orders.map(o => [o.side, o.price, o.qty, o.fee]), `${preset}/${exit}`);
    }
  }
});
test('custom rules enter next minute, protection is stop-first, and inputs are unchanged', () => {
  const bars = rowsFor(), strategy = { ...bot('INFY', 'rules'), entryRule: { op: 'and', rules: [{ left: { field: 'close' }, op: 'above', right: { field: 'number', value: 99 } }] } };
  bars[1][2] = 104; bars[1][3] = 95;
  const before = JSON.stringify({ bars, strategy });
  const result = run({ datasets: [makeData(bars)], strategies: [strategy] });
  assert.equal(result.orders[0].at, new Date(bars[1][0]).toISOString());
  assert.equal(result.trades[0].reason, 'Stop loss');
  assert.equal(result.summary.ambiguousBars, 1);
  assert.equal(result.summary.trades, 1);
  assert.equal(JSON.stringify({ bars, strategy }), before);
});
test('shared capital, lock and deterministic seek do not create impossible fills', () => {
  const config = { datasets: [makeData(), makeData(rowsFor(), 'TCS')], strategies: [bot('INFY', 'dip'), { ...bot('TCS', 'dip'), id: 'second' }], risk: { ...defaultRisk, initialCash: 10000, maxPosition: 10000, maxDailyTrades: 1 } };
  const result = run(config);
  assert.equal(result.orders.filter(o => o.side === 'BUY').length, 1);
  const sim = createSimulation(config);
  sim.lock(true); sim.step(10); assert.equal(sim.snapshot().orders.length, 0);
  sim.lock(false); sim.step(2);
  const other = createSimulation(config); other.lock(true); other.step(10); other.lock(false); other.step(2);
  assert.deepEqual(sim.snapshot(), other.snapshot());
  assert.ok(sim.snapshot().cash >= 0);
  assert.equal(sim.snapshot().positions.length, 1);
  sim.close(sim.snapshot().positions[0].key);
  assert.equal(sim.snapshot().positions.length, 0);
  assert.equal(sim.report().finalized, false);
});
test('no-trade reports and benchmarks use the same fees and real date range', () => {
  const report = run({ strategies: [{ ...bot('INFY', 'breakout'), level: 9999 }] });
  assert.equal(report.summary.trades, 0);
  assert.equal(report.summary.winRatePct, null);
  assert.equal(report.summary.returnPct, 0);
  assert.ok(report.benchmarks[0].returnPct < 0);
  assert.equal(report.months[0].month, '2026-08');
});
test('three-month ten-symbol replay and longer import scale remain bounded', () => {
  const start = performance.now(), bars = rowsFor('2026-08-01', '2026-10-31');
  const datasets = symbols.map(symbol => makeData(bars, symbol));
  const result = run({ datasets, strategies: symbols.map(symbol => ({ ...bot(symbol, 'breakout'), id: symbol, level: 9999 })) });
  assert.ok(result.equity.length > 20000);
  assert.equal(result.datasets.length, 10);
  assert.ok(result.logs.length <= 2000);
  assert.ok(performance.now() - start < 30000, 'three-month run exceeded 30 seconds');
  const longer = rowsFor('2026-03-01', '2026-10-31');
  const annual = run({ datasets: [makeData(longer)], strategies: [{ ...bot('INFY', 'breakout'), level: 9999 }] });
  assert.ok(annual.equity.length > 50000);
});
test('export chunks stay under official 30-day max, cover the snapshot without overlap', () => {
  const chunks = exportChunks();
  assert.equal(chunks[0].from, '2026-08-01'); assert.equal(chunks.at(-1).through, '2026-10-31');
  for (let i = 0; i < chunks.length; i++) {
    assert.ok(Date.parse(chunks[i].through) - Date.parse(chunks[i].from) < 30 * 86400000);
    if (i) assert.equal(Date.parse(chunks[i].from) - Date.parse(chunks[i - 1].through), 86400000);
  }
});
test('local broker export uses only search/candles, validates probe and resumes private chunks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tradegrok-demo-export-'));
  const calls = [];
  const history = {
    smartapi: { session: {}, expire() {} }, clientMetadata: async () => ({}),
    request: async (operation, input) => {
      calls.push(operation);
      if (operation === 'search') return [{ exchange: 'NSE', tradingsymbol: 'RELIANCE-EQ', symboltoken: '123' }];
      return rowsFor(input.fromdate.slice(0, 10), input.todate.slice(0, 10)).map(([time, ...values]) => [new Date(time + 19800000).toISOString().replace('.000Z', '+05:30'), ...values]);
    }
  };
  try {
    const result = await exportDemoData(history, dir, { probe: true, onProgress() {} });
    assert.equal(result.complete, true); assert.equal(result.adjustment, 'unadjusted');
    assert.deepEqual(calls, ['search', 'candles']);
    calls.length = 0;
    await exportDemoData(history, dir, { probe: true, onProgress() {} });
    assert.deepEqual(calls, ['search']);
    const chunk = await readFile(join(dir, 'RELIANCE-2026-08-03-2026-08-03.chunk.json'), 'utf8');
    assert.doesNotMatch(chunk, /authToken|apiKey|holdings|feedToken|symboltoken/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(exportDemoData(history, dir, { signal: controller.signal }), /cancelled/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('full mock export yields ten private canonical CSVs with coverage and no publication claim', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tradegrok-demo-full-'));
  const operations = [];
  const history = {
    smartapi: { session: {}, expire() {} }, clientMetadata: async () => ({}),
    request: async (operation, input) => {
      operations.push(operation);
      if (operation === 'search') return [{ exchange: 'NSE', tradingsymbol: `${input.searchscrip}-EQ`, symboltoken: '123' }];
      return rowsFor(input.fromdate.slice(0, 10), input.todate.slice(0, 10)).map(([time, ...values]) => [new Date(time + 19800000).toISOString().replace('.000Z', '+05:30'), ...values]);
    }
  };
  try {
    const records = await exportDemoData(history, dir, { onProgress() {} });
    assert.equal(records.length, 10);
    for (const record of records) {
      assert.equal(record.complete, true); assert.equal(record.redistribution, 'NOT_APPROVED');
      const { bars } = parseCsv(await readFile(join(dir, record.file), 'utf8'));
      assert.equal(await checksum(bars), record.sha256);
      assert.equal(coverage(bars, { from: record.from, through: record.through }).issues.length, 0);
    }
    assert.ok(operations.every(op => ['search', 'candles'].includes(op)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
