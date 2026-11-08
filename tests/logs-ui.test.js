import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { presets, exitPresets, instruments } from '../server/store.js';

function fixture() {
  const listeners = {}, requests = [];
  const nodes = {
    '#main': { innerHTML: '' }, '#page-label': {}, '#clock': {}, '#bot-dialog': { open: false },
    '#bot-form': { addEventListener() {} }, '#toast': { classList: { toggle() {} } }
  };
  const context = createContext({
    document: {
      querySelector: selector => nodes[selector], querySelectorAll: () => [],
      addEventListener: (event, callback) => { (listeners[event] ??= []).push(callback); }
    },
    location: { search: '' }, window: { scrollTo() {} }, URLSearchParams,
    setInterval() {}, setTimeout() {}, clearTimeout() {},
    fetch: path => new Promise(resolve => { if (path !== '/api/state') requests.push({ path, resolve }); })
  });
  runInContext(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  const bot = { id: 'first', name: 'First bot', symbol: 'RELIANCE', status: 'paused', preset: 'dip', exitPreset: 'protective', level: 1400, stopPct: 1, targetPct: 2, budget: 10000, position: null };
  context.snapshot = { presets, exitPresets, instruments, bots: [bot, { ...bot, id: 'second', name: 'Second bot' }], quotes: [], settings: { mode: 'angel', emergency: false }, engine: { error: null, analysisLog: { enabled: true, error: null } }, metrics: { stalePositions: 0 }, serverTime: '2026-11-09T04:30:00Z' };
  runInContext('state = snapshot', context);
  const run = code => runInContext(code, context);
  const reply = async (index, records, before = null, error = null) => {
    requests[index].resolve({ ok: !error, json: async () => error ? { error } : { records, before, file: 'data/logs/analysis-2026-11-09.jsonl' } });
    await new Promise(resolve => setImmediate(resolve));
  };
  return { context, nodes, listeners, requests, run, reply };
}
const row = (decision = 'blocked') => ({ at: '2026-11-09T04:30:00Z', decision, reason: 'No price <script>unsafe</script>', committed: false, market: { entryWindowOpen: false }, quote: { available: false, fresh: false }, checks: {} });

test('every bot card includes Logs beside Start/Pause and Configure/Close, including held positions', () => {
  const f = fixture();
  let card = f.run('botCard(state.bots[0])');
  assert.match(card, /data-action="edit".*data-action="logs"/s);
  assert.match(card, /aria-label="View logs for First bot"/);
  f.context.snapshot.bots[0].status = 'running';
  f.context.snapshot.bots[0].position = { qty: 1, entry: 1400, stop: 1386, target: 1428, maxLoss: 16 };
  card = f.run('botCard(state.bots[0])');
  assert.match(card, /data-action="pause"/);
  assert.match(card, /data-action="close".*data-action="logs"/s);
});
test('Logs opens a bot-scoped file view with loading, safe JSON, refresh and older-record controls', async () => {
  const f = fixture();
  f.run('openLogs(state.bots[0])');
  assert.match(f.nodes['#main'].innerHTML, /Reading saved analysis/);
  assert.equal(f.requests[0].path, '/api/bots/first/logs?date=2026-11-09');
  await f.reply(0, [row()], 100);
  const html = f.nodes['#main'].innerHTML;
  assert.match(html, /First bot logs/);
  assert.match(html, /No latest price/);
  assert.match(html, /entry window: closed/);
  assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.equal(html.includes('<script>unsafe</script>'), false);
  assert.match(html, /data-action="logs-refresh"/);
  assert.match(html, /data-action="logs-older"/);
  assert.match(html, /Saved analysis JSON/);
  f.run('void loadLogs(true)');
  assert.equal(f.requests[1].path, '/api/bots/first/logs?date=2026-11-09&before=100');
  await f.reply(1, [row('no_action')]);
  assert.match(f.nodes['#main'].innerHTML, /2 records loaded/);
  assert.equal(f.nodes['#main'].innerHTML.includes('data-action="logs-older"'), false);
});
test('stale responses cannot replace a different bot/date and errors never look like empty history', async () => {
  const f = fixture();
  f.run('openLogs(state.bots[0]); openLogs(state.bots[1])');
  await f.reply(1, [row()]);
  await f.reply(0, [row('buy')]);
  assert.match(f.nodes['#main'].innerHTML, /Second bot logs/);
  assert.equal(f.nodes['#main'].innerHTML.includes('Paper buy'), false);
  f.run("logView.date = '2026-11-08'; void loadLogs()");
  assert.match(f.requests[2].path, /date=2026-11-08/);
  await f.reply(2, [], null, 'Analysis file could not be read securely.');
  assert.match(f.nodes['#main'].innerHTML, /role="alert"/);
  assert.match(f.nodes['#main'].innerHTML, /Refresh logs to retry/);
  assert.equal(f.nodes['#main'].innerHTML.includes('No saved analyses for this date'), false);
});
test('empty and bounded-scan states distinguish absent history from older records still to scan', async () => {
  const f = fixture();
  f.run('openLogs(state.bots[0])'); await f.reply(0, []);
  assert.match(f.nodes['#main'].innerHTML, /No saved analyses for this date/);
  f.run('void loadLogs()'); await f.reply(1, [], 100);
  assert.match(f.nodes['#main'].innerHTML, /No matching records in this part of the file/);
  assert.match(f.nodes['#main'].innerHTML, /Load older records/);
});
