import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { atMinute, candlesCsv, sessionFor } from '../demo/data.js';
import { defaultRisk } from '../demo/engine.js';

async function background(t) {
  const url = new URL('../demo/worker.js', import.meta.url).href;
  const instance = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.self = { postMessage: value => parentPort.postMessage(value) };
    import(${JSON.stringify(url)}).then(() => {
      parentPort.on('message', data => self.onmessage({ data }));
      parentPort.postMessage({ ready: true });
    });
  `, { eval: true });
  t.after(() => instance.terminate());
  await new Promise((resolve, reject) => {
    instance.once('error', reject);
    instance.once('message', data => data.ready ? resolve() : reject(new Error('Worker initialization failed.')));
  });
  let sequence = 0;
  const request = (action, input) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const receive = data => {
      if (data.id !== id || data.progress) return;
      instance.off('message', receive);
      data.error ? reject(new Error(data.error)) : resolve(data.result);
    };
    instance.on('message', receive);
    instance.postMessage({ id, action, input });
  });
  return { instance, request };
}
const bars = () => Array.from({ length: 360 }, (_, i) => [atMinute('2026-08-03', 555 + i), 100, 100.5, 99.5, 100, 1000]);
const config = () => ({ datasets: [{ id: 'INFY', symbol: 'INFY', bars: bars(), sha256: 'test', source: 'test fixture', adjustment: 'unknown' }], strategies: [{ id: 'test', name: 'Worker test', datasetId: 'INFY', symbol: 'INFY', enabled: true, preset: 'dip', level: 101, budget: 10000, stopPct: 1, targetPct: 2, exitPreset: 'protective' }], risk: defaultRisk });

test('real worker parses CSV, propagates malformed input and computes reproducible batch output', { timeout: 10000 }, async t => {
  const { request } = await background(t);
  const file = new Blob([candlesCsv(bars())]);
  const preview = await request('preview', { file });
  assert.equal(preview.rows, 360);
  const parsed = await request('parse', { file });
  assert.equal(parsed.bars.length, 360);
  assert.match(parsed.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(request('parse', { file: new Blob(['not a csv']) }), /header/);
  const report = await request('run', config());
  assert.equal(report.finalized, true); assert.equal(report.summary.trades, 1);
  assert.equal(report.trades[0].reason, 'End-window liquidation');
});
test('fresh worker can resume action log, including manual closes, without a prior init', { timeout: 10000 }, async t => {
  const { request } = await background(t);
  const input = config();
  await request('init', input);
  const entered = await request('step', { count: 2 });
  assert.equal(entered.positions.length, 1);
  const closed = await request('close', { key: 0 });
  assert.equal(closed.positions.length, 0);
  const other = await background(t);
  const resumed = await other.request('seek', { config: input, steps: 2, actions: [{ step: 2, action: 'close', input: { key: 0 } }] });
  assert.deepEqual(resumed, closed);
  const locked = await other.request('seek', { config: input, steps: 20, actions: [{ step: 0, action: 'lock', input: { active: true } }] });
  assert.equal(locked.orders.length, 0); assert.equal(locked.locked, true);
  await assert.rejects(other.request('unknown-operation'), /Unknown/);
});
test('worker can be cancelled during a large run while the caller remains responsive', { timeout: 10000 }, async t => {
  const { instance } = await background(t);
  let progress = false, completed = false;
  const input = config(), large = [];
  for (let time = Date.parse('2026-03-01'); time < Date.parse('2026-11-01'); time += 86400000) {
    const day = new Date(time).toISOString().slice(0, 10), session = sessionFor(day);
    if (session) for (let minute = session.open; minute < session.close; minute++) large.push([atMinute(day, minute), 100, 100.5, 99.5, 100, 1000]);
  }
  input.datasets[0].bars = large;
  instance.on('message', data => { if (data.progress) progress = true; if (data.result) completed = true; });
  instance.postMessage({ id: 1, action: 'run', input });
  let heartbeats = 0;
  const interval = setInterval(() => { heartbeats++; }, 1);
  await new Promise(resolve => { const check = () => progress ? resolve() : setTimeout(check, 1); check(); });
  await instance.terminate(); clearInterval(interval);
  assert.ok(heartbeats > 0);
  assert.ok(progress);
  assert.equal(completed, false);
});
