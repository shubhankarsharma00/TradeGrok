import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { presets, exitPresets, instruments } from '../server/store.js';

function fixture() {
  const listeners = {}, requests = [];
  const nodes = {
    '#main': { innerHTML: '' }, '#page-label': {}, '#clock': {}, '#bot-dialog': { open: false },
    '#backtest-results-dialog': { open: false, showModal() { this.open = true; }, close() { this.open = false; } },
    '#backtest-results-content': { innerHTML: '' }, '#backtest-results-title': { focus() { this.focused = true; } },
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
test('bin shows removed bots with working logs and no trading controls', async () => {
  const f = fixture();
  f.context.snapshot.deletedBots = [{ ...f.context.snapshot.bots.shift(), deletedAt: '2026-11-09T04:30:00Z' }];
  f.context.snapshot.deletedBots[0].name = 'Removed <script>bot</script>';
  f.run("page = 'bin'; renderPage()");
  const html = f.nodes['#main'].innerHTML;
  assert.match(html, /Removed &lt;script&gt;bot&lt;\/script&gt;/);
  assert.match(html, /data-action="logs"/);
  for (const action of ['start', 'pause', 'edit', 'delete', 'close']) assert.equal(html.includes(`data-action="${action}"`), false);
  const opening = f.listeners.click[0]({ target: { closest: () => ({ dataset: { action: 'logs', id: 'first' } }) } });
  assert.equal(f.requests[0].path, '/api/bots/first/logs?date=2026-11-09');
  await f.reply(0, [row()]);
  await opening;
  assert.match(f.nodes['#main'].innerHTML, /data-page="bin"/);
  assert.match(f.nodes['#main'].innerHTML, /Removed &lt;script&gt;bot&lt;\/script&gt; logs/);
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

test('backtest setup stays separate from the popup report while preserving ticker and replay controls', async () => {
  const f = fixture();
  f.context.snapshot.smartapi = { status: 'callback_received' };
  f.context.snapshot.backtest = {
    id: 'saved-run', createdAt: '2026-11-06T10:00:00Z', bot: { name: '<Any bot>', symbol: 'M&M' }, interval: 'ONE_MINUTE', status: 'completed', evaluated: ['2026-11-06'],
    summary: { trades: 3, wins: 2, losses: 1, breakeven: 0, winRatePct: 66.67, netPnl: 100, returnPct: 0.1, fees: 10, slippage: 10, maxDrawdown: 20, maxDrawdownPct: 0.02 },
    coverage: [{ date: '2026-11-06', expected: 360, received: 360, zeroVolume: [] }]
  };
  const html = f.run('backtestPanel()');
  assert.match(html, /id="backtest-bot"/);
  assert.match(html, /First bot/);
  assert.match(html, /Second bot/);
  assert.match(html, /id="backtest-symbol"/);
  assert.match(html, /1 minute \(fixed\)/);
  assert.match(html, /<option value="7" selected>7 days/);
  assert.equal(html.includes('<option value="8"'), false);
  assert.doesNotMatch(html, /backtest-download|Download history only/);
  assert.match(html, /data-action="backtest"[^>]*>Run<\/button>/);
  assert.match(html, /data-action="backtest-replay"/);
  assert.match(html, /data-action="backtest-results"/);
  assert.doesNotMatch(html, /Wins \/ losses \/ breakeven|66.67%|Candle coverage|Download saved candles/);
  assert.match(html, /&lt;Any bot&gt;/);
  await f.listeners.click[0]({ target: { closest: () => ({ dataset: { action: 'backtest-results' } }) } });
  assert.equal(f.nodes['#backtest-results-dialog'].open, true);
  assert.equal(f.nodes['#backtest-results-title'].focused, true);
  const result = f.nodes['#backtest-results-content'].innerHTML;
  assert.match(result, /Wins \/ losses \/ breakeven/);
  assert.match(result, /2 \/ 1 \/ 0/);
  assert.match(result, /66.67%/);
  assert.match(result, /&lt;Any bot&gt;/);
  assert.match(result, /Download saved candles/);
  assert.match(result, /360\/360 continuous bars/);
  const selection = f.run('JSON.stringify(backtestSelection)');
  await f.listeners.click[0]({ target: { closest: () => ({ dataset: { action: 'backtest-results-close' } }) } });
  assert.equal(f.nodes['#backtest-results-dialog'].open, false);
  assert.equal(f.run('JSON.stringify(backtestSelection)'), selection);
  f.context.snapshot.backtest.summary.winRatePct = null;
  assert.match(f.run('backtestResults(state.backtest)'), /N\/A/);
  f.context.snapshot.smartapi.status = 'login_required';
  assert.doesNotMatch(f.run('backtestPanel()'), /data-action="backtest" disabled/);
  assert.match(f.run('backtestLearnMore()'), /fully cached runs work offline/);
  f.run("backtestSelection.symbol = 'TCS'; backtestSelection.days = 3");
  assert.match(f.run('backtestPanel()'), /value="TCS"/);
  assert.match(f.run('backtestPanel()'), /<option value="3" selected>/);
  const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(index, /<dialog id="backtest-results-dialog" aria-labelledby="backtest-results-title"/);
  assert.match(index, /aria-label="Close backtest results"/);
});

test('backtest guidance and strategy descriptions are collapsed at the end and retain their disclosure state', () => {
  const f = fixture();
  const panel = f.run('backtestPanel()');
  assert.doesNotMatch(panel, /Complete local history|Entry\/support prices|All entry and exit|Fresh initial/);
  f.run("page = 'bots'; renderPage()");
  const html = f.nodes['#main'].innerHTML;
  assert.match(html, /<details id="backtest-learn-more" class="panel backtest-learn-more"><summary>Learn more about backtest/);
  assert.ok(html.endsWith('</details>'));
  assert.ok(html.indexOf('Learn more about backtest') > html.indexOf('>Run</button>'));
  assert.ok(html.indexOf('Entry strategies') > html.indexOf('Learn more about backtest'));
  assert.ok(html.indexOf('Exit strategies') > html.indexOf('Learn more about backtest'));
  assert.match(html, /Missing\/zero-volume continuous candles block results/);
  f.nodes['#backtest-learn-more'] = { open: true };
  f.run('renderPage()');
  assert.match(f.nodes['#main'].innerHTML, /class="panel backtest-learn-more" open/);
  f.nodes['#backtest-learn-more'].open = false;
  f.run('renderPage()');
  assert.doesNotMatch(f.nodes['#main'].innerHTML, /class="panel backtest-learn-more" open/);
});

test('backtest log records cannot be mistaken for committed paper transactions', async () => {
  const f = fixture();
  f.run('openLogs(state.bots[0])');
  await f.reply(0, [{ ...row('buy'), execution: 'backtest', backtestId: 'run-1', committed: true }]);
  const html = f.nodes['#main'].innerHTML;
  assert.match(html, /Backtest/);
  assert.match(html, /Historical simulation only; no paper transaction/);
  assert.equal(html.includes('Paper transaction committed'), false);
});

test('backtest controls send selected rules and normalized ticker, with offline saved-history replay', async () => {
  const f = fixture(), requests = [];
  f.context.snapshot.csrf = 'fixture-csrf';
  f.context.snapshot.smartapi = { status: 'callback_received' };
  f.nodes['#bot-count'] = {};
  f.nodes['#emergency'] = { classList: { toggle() {} } };
  f.context.fetch = async (path, options) => {
    const mutation = options?.method === 'POST';
    if (mutation) requests.push({ path, input: JSON.parse(options.body), headers: options.headers });
    return { ok: true, json: async () => mutation ? {} : f.context.snapshot };
  };
  f.run("backtestPanel(); backtestSelection.symbol = 'm&m'; backtestSelection.days = 3; page = 'bots'; refreshing = null");
  for (const action of ['backtest', 'backtest-replay', 'backtest-original']) {
    await f.listeners.click[0]({ target: { closest: () => ({ dataset: { action } }) } });
  }
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => request.path === '/api/backtest' && request.headers['X-Tradegrok-CSRF'] === 'fixture-csrf'));
  assert.deepEqual(requests[0].input, { botId: 'first', symbol: 'M&M', days: 3 });
  assert.deepEqual(requests[1].input, { botId: 'first', reuseLatest: true });
  assert.deepEqual(requests[2].input, { reuseLatest: true });
});

test('new backtests open the popup using the actual response even if state refresh fails', async () => {
  for (const status of ['completed']) {
    const f = fixture();
    f.context.snapshot.csrf = 'fixture-csrf';
    f.context.snapshot.smartapi = { status: 'callback_received' };
    const run = { id: 'new-run', status, createdAt: '2026-11-09T10:00:00Z',
      snapshot: { bot: { name: 'New run', symbol: 'ITC' } }, dataset: { request: { interval: 'ONE_MINUTE' } },
      sessions: { evaluated: ['2026-11-06'] }, result: status === 'completed' ? { summary: { trades: 0, netPnl: 0, wins: 0, losses: 0, breakeven: 0, winRatePct: null, returnPct: 0, fees: 0, slippage: 0, maxDrawdown: 0, maxDrawdownPct: 0 } } : null, coverage: [] };
    f.context.fetch = async (path, options) => ({ ok: options?.method === 'POST', json: async () => options?.method === 'POST' ? run : { error: 'State refresh failed.' } });
    f.run("backtestPanel(); page = 'bots'; refreshing = null");
    await f.listeners.click[0]({ target: { closest: () => ({ dataset: { action: 'backtest' } }) } });
    assert.equal(f.nodes['#backtest-results-dialog'].open, true);
    assert.match(f.nodes['#backtest-results-content'].innerHTML, /New run on NSE:ITC/);
    assert.match(f.nodes['#backtest-results-content'].innerHTML, /Download complete report/);
    assert.equal(f.run('backtestBusy'), false);
    if (status === 'downloaded') assert.match(f.nodes['#backtest-results-content'].innerHTML, /no simulation has run yet/);
    else assert.match(f.nodes['#backtest-results-content'].innerHTML, /Wins \/ losses \/ breakeven/);
  }
});

test('results popup reports cached and newly downloaded session counts', () => {
  const f = fixture();
  f.context.snapshot.backtest = { status: 'downloaded', bot: { name: 'Saved', symbol: 'INFY' }, cache: { reusedSessions: ['2026-11-03', '2026-11-04'], downloadedSessions: ['2026-11-05'] } };
  const html = f.run('backtestResults(state.backtest)');
  assert.match(html, /2 complete sessions reused locally; 1 sessions downloaded from Angel One/);
  assert.match(html, /no simulation has run yet/);
});

test('persisted coverage/logging failures open the report, while unsaved failures do not show an old result', async () => {
  for (const scenario of ['blocked', 'logging-error', 'unsaved']) {
    const f = fixture();
    f.context.snapshot.csrf = 'fixture-csrf';
    f.context.snapshot.smartapi = { status: 'callback_received' };
    f.context.snapshot.backtest = { id: 'old-run', bot: { name: 'Old run', symbol: 'RELIANCE' }, interval: 'ONE_MINUTE', status: 'downloaded' };
    f.nodes['#bot-count'] = {};
    f.nodes['#emergency'] = { classList: { toggle() {} } };
    f.context.fetch = async (path, options) => {
      if (options?.method !== 'POST') return { ok: true, json: async () => f.context.snapshot };
      if (scenario !== 'unsaved') f.context.snapshot.backtest = {
        id: 'new-run', status: scenario === 'blocked' ? 'blocked' : 'completed',
        bot: { name: 'New run', symbol: 'ITC' }, interval: 'ONE_MINUTE', evaluated: ['2026-11-06'], coverage: [],
        loggingError: scenario === 'logging-error' ? 'Log write failed <unsafe>' : null
      };
      return { ok: false, json: async () => ({ error: 'Request failed.' }) };
    };
    f.run("backtestPanel(); page = 'bots'; refreshing = null");
    await f.listeners.click[0]({ target: { closest: () => ({ dataset: { action: 'backtest' } }) } });
    assert.equal(f.nodes['#backtest-results-dialog'].open, scenario !== 'unsaved');
    const html = f.nodes['#backtest-results-content'].innerHTML;
    if (scenario === 'blocked') assert.match(html, /Coverage blocked this run/);
    if (scenario === 'logging-error') assert.match(html, /Log write failed &lt;unsafe&gt;/);
    assert.doesNotMatch(html, /Old run/);
  }
});
