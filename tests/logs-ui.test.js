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
  assert.match(card, /data-action="delete"[^>]*>Move to bin/);
  f.context.snapshot.bots[0].status = 'running';
  f.context.snapshot.bots[0].position = { qty: 1, entry: 1400, stop: 1386, target: 1428, maxLoss: 16 };
  card = f.run('botCard(state.bots[0])');
  assert.match(card, /data-action="pause"/);
  assert.match(card, /data-action="close".*data-action="logs"/s);
  assert.equal(card.includes('data-action="delete"'), false);
  f.context.snapshot.bots[0].status = 'paused';
  assert.match(f.run('botCard(state.bots[0])'), /data-action="delete"[^>]*disabled/);
});
test('bots page embeds the bin after the active list with working logs and no removed-bot trading controls', async () => {
  const f = fixture();
  f.context.snapshot.deletedBots = [{ ...f.context.snapshot.bots.shift(), deletedAt: '2026-11-09T04:30:00Z' }];
  f.context.snapshot.deletedBots[0].name = 'Removed <script>bot</script>';
  f.run("page = 'bots'; renderPage()");
  const html = f.nodes['#main'].innerHTML;
  assert.equal(f.nodes['#page-label'].textContent, 'My bots');
  assert.ok(html.indexOf('Second bot') < html.indexOf('id="bot-bin"'));
  assert.ok(html.indexOf('id="bot-bin"') < html.indexOf('safe play historical backtest'));
  assert.doesNotMatch(html, /data-page="bin"/);
  assert.match(html, /Removed &lt;script&gt;bot&lt;\/script&gt;/);
  assert.match(html, /data-action="logs"/);
  const bin = f.run('botBinSection()');
  for (const action of ['start', 'pause', 'edit', 'delete', 'close']) assert.equal(bin.includes(`data-action="${action}"`), false);
  const opening = f.listeners.click[0]({ target: { closest: () => ({ dataset: { action: 'logs', id: 'first' } }) } });
  assert.equal(f.requests[0].path, '/api/bots/first/logs?date=2026-11-09');
  await f.reply(0, [row()]);
  await opening;
  assert.match(f.nodes['#main'].innerHTML, /data-page="bots" data-section="bot-bin"/);
  assert.match(f.nodes['#main'].innerHTML, /Removed &lt;script&gt;bot&lt;\/script&gt; logs/);
  let scrolled = false, focused = false;
  f.nodes['#bot-bin'] = { scrollIntoView() { scrolled = true; } };
  f.nodes['#bot-bin-title'] = { focus() { focused = true; } };
  await f.listeners.click[0]({ target: { closest: () => ({ dataset: { page: 'bots', section: 'bot-bin' } }) } });
  assert.equal(f.nodes['#page-label'].textContent, 'My bots');
  assert.equal(scrolled, true);
  assert.equal(focused, true);
});
test('bots page shows an empty bin below the list when there are no removed bots', () => {
  const f = fixture();
  const html = f.run('botsPage()');
  assert.match(html, /Bot bin \(0\)/);
  assert.match(html, /The bot bin is empty/);
  assert.ok(html.indexOf('Second bot') < html.indexOf('id="bot-bin"'));
  assert.doesNotMatch(html, /data-page="bin"/);
});
test('moving a bot to the bin requires confirmation and sends the protected mutation', async () => {
  const f = fixture();
  const target = { dataset: { action: 'delete', id: 'first' } };
  const click = () => f.listeners.click[0]({ target: { closest: () => target } });
  let confirmed = false, prompt, calls = [];
  f.context.window.confirm = message => { prompt = message; return confirmed; };
  f.context.fetch = async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith('/delete')) {
      f.context.snapshot.deletedBots = [{ ...f.context.snapshot.bots.shift(), deletedAt: '2026-11-09T04:30:00Z' }];
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => f.context.snapshot };
  };
  f.context.snapshot.csrf = 'fixture-csrf';
  f.nodes['#bot-count'] = {};
  f.nodes['#emergency'] = { classList: { toggle() {} } };
  await click();
  assert.match(prompt, /Saved logs and paper order history will be kept/);
  assert.equal(calls.length, 0);
  confirmed = true;
  f.run("page = 'bots'; refreshing = null");
  await click();
  assert.equal(calls[0].path, '/api/bots/first/delete');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['X-Tradegrok-CSRF'], 'fixture-csrf');
  assert.equal(f.nodes['#bot-count'].textContent, 1);
  assert.match(f.nodes['#main'].innerHTML, /Bot bin \(1\)/);
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
