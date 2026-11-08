import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { Store } from '../server/store.js';
import { AngelOne } from '../server/angel.js';
import { createApp } from '../server/app.js';
import { SmartAPI, smartApiCallbackPath, smartApiCookiePath } from '../server/smartapi.js';

async function fixture(t, broker = new AngelOne(new SmartAPI()), options = {}) {
  const store = new Store(':memory:');
  const { server, engine } = createApp(store, broker, options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const initial = await (await fetch(`${base}/api/state`)).json();
  const post = (path, input, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tradegrok-CSRF': initial.csrf, ...headers }, body: JSON.stringify(input) });
  return { store, server, engine, initial, post, base };
}
test('dashboard serves private state but never environment/database files', async t => {
  const { base, initial } = await fixture(t);
  assert.equal(initial.liveEnabled, false);
  assert.equal(initial.execution, 'paper');
  assert.equal(initial.connection.status, 'not_configured');
  assert.equal(initial.account, null);
  assert.equal(initial.orders.length, 0);
  for (const path of ['/', '/app.js', '/styles.css', '/favicon.svg']) {
    const response = await fetch(`${base}${path}`); assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  }
  for (const path of ['/.env', '/data/tradegrok.sqlite', '/server/broker.js', '/api/unknown']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404);
  }
});
test('same-origin mutation token, Host and cross-site read protections', async t => {
  const { post, base } = await fixture(t);
  assert.equal((await post('/api/emergency', { active: true }, { 'X-Tradegrok-CSRF': '' })).status, 403);
  assert.equal((await post('/api/emergency', { active: true }, { Origin: 'https://evil.example' })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = request(`${base}/api/state`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal((await fetch(`${base}/api/state`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/state`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(base, { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } })).status, 200);
});
test('create/configure/start/pause/manual close and emergency release end to end', async t => {
  const now = () => Date.parse('2026-11-09T10:00:00+05:30');
  const broker = { status: () => ({ status: 'connected' }), account: null, quote: async symbol => ({ symbol, price: 500, source: 'angel', at: new Date(now()).toISOString() }) };
  const { store, engine, post, initial } = await fixture(t, broker, { now });
  const config = { name: 'My dip rule', symbol: 'ITC', preset: 'dip', level: 1000, stopPct: 1, targetPct: 2, budget: 5000 };
  const created = await post('/api/bots', config);
  assert.equal(created.status, 201);
  const bot = await created.json();
  assert.equal(bot.status, 'paused');
  assert.equal((await post(`/api/bots/${bot.id}/configure`, { ...config, name: 'Edited dip' })).status, 200);
  assert.equal((await post(`/api/bots/${bot.id}/start`, {})).status, 200);
  await engine.tick();
  assert.ok(store.bot(bot.id).position);
  assert.equal((await post(`/api/bots/${bot.id}/configure`, config)).status, 409);
  assert.equal((await post('/api/emergency', { active: true })).status, 200);
  assert.equal(store.bot(bot.id).status, 'paused');
  assert.equal((await post(`/api/bots/${initial.bots[0].id}/configure`, { ...initial.bots[0], level: 1410 })).status, 200);
  assert.ok(store.bot(bot.id).position, 'emergency does not flatten');
  assert.equal((await post(`/api/bots/${bot.id}/start`, {})).status, 409);
  assert.equal((await post(`/api/bots/${bot.id}/close`, {})).status, 200);
  assert.equal(store.bot(bot.id).position, null);
  assert.equal((await post('/api/emergency', { active: false })).status, 200);
  assert.equal(store.bot(bot.id).status, 'paused');
  assert.equal((await post(`/api/bots/${initial.bots[0].id}/start`, {})).status, 200);
  assert.equal((await post(`/api/bots/${initial.bots[0].id}/pause`, {})).status, 200);
  assert.ok(store.orders().every(order => order.execution === 'paper'));
});
test('swing preset is exposed, saved, and enforces its risk floor through the API', async t => {
  const { store, initial, post } = await fixture(t);
  const preset = initial.presets.find(item => item.id === 'swing');
  assert.ok(preset);
  assert.equal(preset.sources.length, 2);
  const config = { name: 'ITC swing', symbol: 'ITC', preset: preset.id, level: 430, stopPct: 3, targetPct: 6, budget: 5000 };
  assert.equal((await post('/api/bots', { ...config, level: 0 })).status, 400);
  const rejected = await post('/api/bots', { ...config, targetPct: 5.9 });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /2:1/);
  const response = await post('/api/bots', config);
  assert.equal(response.status, 201);
  const bot = await response.json();
  assert.equal(bot.status, 'paused');
  assert.equal(store.bot(bot.id).preset, 'swing');
  assert.equal((await post(`/api/bots/${bot.id}/configure`, { ...config, stopPct: 4, targetPct: 7 })).status, 400);
  assert.equal(store.bot(bot.id).stopPct, 3);
  assert.equal((await post(`/api/bots/${bot.id}/configure`, { ...config, stopPct: 4, targetPct: 8 })).status, 200);
  assert.equal(store.bot(bot.id).targetPct, 8);
  assert.equal(store.orders().length, 0);
});
test('paused bots move to the bin without losing logs, orders, cash or daily risk history', async t => {
  const now = () => Date.parse('2026-11-09T10:00:00+05:30');
  const broker = { status: () => ({ status: 'connected' }), account: null, quote: async symbol => ({ symbol, price: 500, source: 'angel', at: new Date(now()).toISOString() }) };
  const reads = [];
  const analysisLog = {
    status: () => ({ enabled: true }),
    append() {},
    read: async (...args) => { reads.push(args); return { records: [{ reason: 'Saved bot analysis' }], before: null }; }
  };
  const { store, engine, post, initial, base } = await fixture(t, broker, { now, analysisLog });
  const bot = initial.bots[0], path = `/api/bots/${bot.id}`;
  assert.equal((await post(`${path}/delete`, {}, { 'X-Tradegrok-CSRF': '' })).status, 403);
  assert.equal((await post(`${path}/configure`, { ...bot, preset: 'dip', level: 1000 })).status, 200);
  assert.equal((await post(`${path}/start`, {})).status, 200);
  assert.equal((await post(`${path}/delete`, {})).status, 409);
  await engine.tick();
  assert.ok(store.bot(bot.id).position);
  assert.equal((await post(`${path}/pause`, {})).status, 200);
  assert.equal((await post(`${path}/delete`, {})).status, 409);
  assert.ok(store.bot(bot.id).position);
  assert.equal((await post(`${path}/close`, {})).status, 200);
  const orders = store.orders(), settings = store.settings();
  const before = await (await fetch(`${base}/api/state`)).json();
  assert.equal((await post('/api/emergency', { active: true })).status, 200);
  const response = await post(`${path}/delete`, {});
  assert.equal(response.status, 200);
  const removed = await response.json();
  assert.equal(removed.deletedAt, new Date(now()).toISOString());
  assert.equal(store.bot(bot.id), null);
  assert.equal(store.bot(bot.id, true).status, 'paused');
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.bots.length, 0);
  assert.equal(state.deletedBots[0].id, bot.id);
  assert.deepEqual(state.orders, orders);
  assert.equal(state.settings.cash, settings.cash);
  for (const metric of ['dayLoss', 'entriesToday', 'equity', 'totalPnl']) assert.equal(state.metrics[metric], before.metrics[metric]);
  for (const action of ['start', 'pause', 'close', 'configure', 'delete']) assert.equal((await post(`${path}/${action}`, {})).status, 404);
  const logs = await fetch(`${base}${path}/logs?date=2026-11-09&before=100`);
  assert.equal(logs.status, 200);
  assert.equal((await logs.json()).records[0].reason, 'Saved bot analysis');
  assert.deepEqual(reads[0], [bot.id, '2026-11-09', 100]);
  assert.ok(store.events().some(event => event.botId === bot.id && event.message.includes('delete')));
});
test('moving a bot to the bin frees an active slot and an in-flight quote cannot recreate it', async t => {
  let release;
  const now = () => Date.parse('2026-11-09T10:00:00+05:30');
  const broker = { status: () => ({ status: 'connected' }), account: null, quote: symbol => new Promise(resolve => {
    release = () => resolve({ symbol, price: 1500, source: 'angel', at: new Date(now()).toISOString() });
  }) };
  const { store, engine, post, initial } = await fixture(t, broker, { now });
  const bot = initial.bots[0];
  const tick = engine.tick();
  assert.equal((await post(`/api/bots/${bot.id}/delete`, {})).status, 200);
  release(); await tick;
  assert.equal(store.bot(bot.id), null);
  assert.equal(store.deletedBots().length, 1);
  assert.equal(store.orders().length, 0);
  for (let index = 0; index < 12; index++) assert.equal((await post('/api/bots', { ...bot, level: 1410, name: `Replacement ${index}` })).status, 201);
  assert.equal((await post('/api/bots', { ...bot, level: 1410 })).status, 400);
  assert.equal(store.bots().length, 12);
});
test('new timed exit strategies are exposed and saved independently with strict API validation', async t => {
  const { initial, post, store } = await fixture(t);
  assert.equal(initial.exitPresets.length, 6);
  const config = { name: 'Timed SMA', symbol: 'ITC', preset: 'sma', budget: 5000, stopPct: 1, targetPct: 2, exitPreset: 'time-performance', exitSessions: 1, exitTime: '14:45', exitMinGainPct: 0.5, intraday: true };
  const response = await post('/api/bots', config);
  assert.equal(response.status, 201);
  const bot = await response.json();
  assert.equal(bot.holdingMode, 'flexible');
  assert.equal(bot.exitSessions, 1);
  assert.equal(bot.exitTime, '14:45');
  assert.equal((await post(`/api/bots/${bot.id}/configure`, { ...config, exitSessions: 1.5 })).status, 400);
  assert.equal(store.bot(bot.id).exitSessions, 1);
  assert.equal((await post(`/api/bots/${bot.id}/configure`, { ...config, exitTime: '15:15' })).status, 400);
  assert.equal((await post(`/api/bots/${bot.id}/configure`, { ...config, exitPreset: 'support', exitLevel: 425 })).status, 200);
  assert.equal(store.bot(bot.id).preset, 'sma');
  assert.equal(store.bot(bot.id).exitTime, '');
  assert.equal(store.bot(bot.id).exitLevel, 425);
  assert.equal(store.orders().length, 0);
});
test('live flags and synthetic sources are refused; risk settings do not need a login', async t => {
  const { store, post, initial } = await fixture(t);
  assert.equal((await post('/api/settings', { ...initial.settings, liveEnabled: true })).status, 403);
  assert.equal((await post('/api/bots', { ...initial.bots[0], execution: 'live' })).status, 403);
  assert.equal((await post('/api/settings', { ...initial.settings, mode: 'angel' })).status, 200);
  assert.equal((await post('/api/settings', { ...initial.settings, mode: 'demo' })).status, 400);
  assert.equal((await post('/api/settings', { ...initial.settings, mode: 'groww' })).status, 400);
  assert.equal((await post('/api/broker/connect', {})).status, 503);
  assert.equal(store.settings().mode, 'angel');
  assert.equal((await post(`/api/bots/${initial.bots[0].id}/start`, {})).status, 409);
  assert.equal(store.orders().length, 0);
});
test('verified Angel One connection reads actual fixture holdings, then enables paper-on-quotes only', async t => {
  const calls = [];
  const smartapi = new SmartAPI({ apiKey: 'fixture-key' });
  smartapi.session = { authToken: 'fake-test-token', receivedAt: Date.now(), expiresAt: Date.now() + 3600000 };
  const broker = new AngelOne(smartapi, { metadata: { localIP: '192.0.2.1', publicIP: '192.0.2.2', mac: '00:11:22:33:44:55' }, sleep: async () => {}, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const data = url.endsWith('/getHolding') ? [{ tradingsymbol: 'ITC-EQ', quantity: 2, averageprice: 400 }] : [];
    return new Response(JSON.stringify({ status: true, data }));
  } });
  const { post, initial, base, store } = await fixture(t, broker, { smartapi });
  assert.equal((await post('/api/broker/connect', {})).status, 200);
  assert.equal((await post('/api/broker/connect', {})).status, 429);
  const connected = await (await fetch(`${base}/api/state`)).json();
  assert.equal(connected.account.source, 'angel');
  assert.equal(connected.account.holdings[0].quantity, 2);
  assert.ok(!JSON.stringify(connected).includes('fake-test-token'));
  assert.equal((await post('/api/settings', { ...initial.settings, mode: 'angel' })).status, 200);
  assert.equal(store.settings().mode, 'angel');
  assert.equal(connected.liveEnabled, false);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.options.method === 'GET'));
  assert.equal((await post('/api/settings', { ...initial.settings, mode: 'demo' })).status, 400);
});
test('invalid input never partially changes state and bot count is bounded', async t => {
  const { post, initial, store } = await fixture(t);
  assert.equal((await post('/api/settings', { ...initial.settings, maxDailyTrades: 2.5 })).status, 400);
  assert.equal(store.settings().maxDailyTrades, initial.settings.maxDailyTrades);
  assert.equal((await post('/api/emergency', { active: 'yes' })).status, 400);
  for (const input of [null, [], true, 'bad input']) {
    for (const route of ['/api/settings', '/api/emergency', '/api/bots']) assert.equal((await post(route, input)).status, 400);
  }
  for (let index = 1; index < 12; index++) assert.equal((await post('/api/bots', { ...initial.bots[0], level: 1410, name: `Bot ${index}` })).status, 201);
  assert.equal((await post('/api/bots', initial.bots[0])).status, 400);
  assert.equal(store.bots().length, 12);
});
test('SmartAPI callback uses the actual port, browser-bound state and a clean redirect without enabling trades', async t => {
  const smartapi = new SmartAPI({ apiKey: 'fixture-api-key' });
  const { post, initial, base, store } = await fixture(t, new AngelOne(new SmartAPI()), { smartapi });
  assert.equal(initial.smartapi.callbackUrl, `${base}${smartApiCallbackPath}`);
  assert.equal(initial.smartapi.status, 'ready');
  assert.ok(!JSON.stringify(initial).includes('fixture-api-key'));
  assert.equal((await post('/api/smartapi/login', {}, { 'X-Tradegrok-CSRF': '' })).status, 403);
  assert.equal((await post('/api/smartapi/login', {}, { Origin: 'https://evil.example' })).status, 403);
  const login = await post('/api/smartapi/login', {});
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.ok(setCookie.includes('HttpOnly'));
  assert.ok(setCookie.includes('SameSite=Lax'));
  assert.ok(setCookie.includes(`Path=${smartApiCookiePath}`));
  const cookie = setCookie.split(';')[0];
  const loginUrl = new URL((await login.json()).loginUrl);
  assert.equal(loginUrl.origin, 'https://smartapi.angelone.in');
  assert.equal(loginUrl.pathname, '/publisher-login');
  assert.equal(loginUrl.searchParams.get('api_key'), 'fixture-api-key');
  assert.equal(loginUrl.searchParams.get('redirect_url'), `${base}${smartApiCallbackPath}`);
  const callback = new URL(`${base}${smartApiCallbackPath}`);
  callback.search = new URLSearchParams({ state: loginUrl.searchParams.get('state'), auth_token: 'fixture-auth', feed_token: 'fixture-feed' });
  const received = await fetch(callback, { redirect: 'manual', headers: {
    Cookie: cookie, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate'
  } });
  assert.equal(received.status, 303);
  assert.equal(received.headers.get('location'), '/?smartapi=received');
  assert.ok(received.headers.get('set-cookie').includes('Max-Age=0'));
  assert.equal(await received.text(), '');
  assert.equal(received.headers.get('cache-control'), 'no-store');
  assert.equal(received.headers.get('referrer-policy'), 'no-referrer');
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.smartapi.status, 'callback_received');
  assert.equal(state.connection.status, 'not_configured');
  assert.equal(state.account, null);
  assert.equal(state.liveEnabled, false);
  for (const secret of ['fixture-api-key', 'fixture-auth', 'fixture-feed', cookie.split('=')[1]]) assert.ok(!JSON.stringify(state).includes(secret));
  assert.equal(store.orders().length, 0);
  assert.equal(store.settings().mode, initial.settings.mode);
  const replay = await fetch(callback, { redirect: 'manual', headers: { Cookie: cookie } });
  assert.equal(replay.headers.get('location'), '/?smartapi=error');
  assert.equal((await post('/api/smartapi/disconnect', {})).status, 200);
  assert.equal(smartapi.session, null);
  assert.equal(smartapi.pending, null);
});
test('SmartAPI unconfigured login, direct callbacks, non-GET callbacks and cross-site status reads are rejected', async t => {
  const { base, post } = await fixture(t);
  assert.equal((await post('/api/smartapi/login', {})).status, 503);
  const callback = await fetch(`${base}${smartApiCallbackPath}?auth_token=not-a-real-token`, { redirect: 'manual' });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), '/?smartapi=error');
  assert.equal(await callback.text(), '');
  assert.equal((await fetch(`${base}${smartApiCallbackPath}`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/api/state`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});
test('SmartAPI login on localhost directs the user to the canonical 127.0.0.1 origin', async t => {
  const smartapi = new SmartAPI({ apiKey: 'fixture-key' });
  const { base, initial } = await fixture(t, new AngelOne(new SmartAPI()), { smartapi });
  const response = await new Promise((resolve, reject) => {
    const req = request(`${base}/api/smartapi/login`, { method: 'POST', headers: {
      Host: `localhost:${new URL(base).port}`, 'Content-Type': 'application/json', 'X-Tradegrok-CSRF': initial.csrf
    } }, res => { res.resume(); resolve(res); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(response.statusCode, 409);
  assert.equal(smartapi.pending, null);
});
function historyRows() {
  const days = ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
  return days.flatMap(day => Array.from({ length: 72 }, (_, index) => {
    const time = 555 + index * 5;
    return [`${day}T${String(Math.floor(time / 60)).padStart(2, '0')}:${String(time % 60).padStart(2, '0')}:00+05:30`, 100, 101, 99.5, 100, 1000];
  }).concat([[`${day}T15:25:00+05:30`, 100, 100, 100, 100, 0]]));
}
test('safe play historical route persists real-shape dataset/results separately without bot/settings/order changes', async t => {
  const now = () => Date.parse('2026-11-08T11:00:00+05:30');
  const smartapi = new SmartAPI({ apiKey: 'fixture-history-key', now });
  smartapi.session = { authToken: 'fixture-history-token', receivedAt: now(), expiresAt: now() + 3600000 };
  const history = { download: async () => ({
    source: 'fixture historical endpoint', fetchedAt: new Date(now()).toISOString(),
    instrument: { exchange: 'NSE', symbol: 'RELIANCE-EQ', token: '2885' }, request: { interval: 'FIVE_MINUTE' }, data: historyRows()
  }) };
  const { store, post, base } = await fixture(t, new AngelOne(new SmartAPI()), { smartapi, history, now });
  const bot = store.bots()[0];
  store.saveBot({ ...bot, name: 'safe play', preset: 'sma', level: 0 });
  const unchanged = JSON.stringify({ settings: store.settings(), bots: store.bots(), orders: store.orders() });
  assert.equal((await fetch(`${base}/api/backtests/latest`)).status, 404);
  assert.equal((await post('/api/backtest/safe-play', {}, { 'X-Tradegrok-CSRF': '' })).status, 403);
  assert.equal((await post('/api/backtest/safe-play', { bot: 'another' })).status, 400);
  const response = await post('/api/backtest/safe-play', {});
  assert.equal(response.status, 200);
  const run = await response.json();
  assert.equal(run.status, 'completed');
  assert.equal(run.dataset.candles.length, 657);
  assert.equal(run.auctionBars.length, 9);
  assert.equal(run.result.summary.evaluatedBars, 504);
  assert.equal(run.result.summary.trades, 0);
  assert.equal(run.result.summary.netPnl, 0);
  assert.equal(store.latestBacktest().id, run.id);
  const downloaded = await (await fetch(`${base}/api/backtests/latest`)).json();
  assert.equal(downloaded.dataset.sha256, run.dataset.sha256);
  for (const secret of ['fixture-history-key', 'fixture-history-token']) assert.ok(!JSON.stringify(downloaded).includes(secret));
  assert.equal(JSON.stringify({ settings: store.settings(), bots: store.bots(), orders: store.orders() }), unchanged);
  store.saveBot({ ...store.bots()[0], budget: 15000 });
  smartapi.clear();
  history.download = async () => { throw new Error('Cached replay must not call the broker'); };
  const replayed = await post('/api/backtest/safe-play', { reuseLatest: true });
  assert.equal(replayed.status, 200);
  const replay = await replayed.json();
  assert.equal(replay.replayedFrom, run.id);
  assert.equal(replay.snapshot.bot.budget, run.snapshot.bot.budget);
  assert.equal(replay.dataset.sha256, run.dataset.sha256);
  assert.equal(replay.dataset.fetchedAt, run.dataset.fetchedAt);
  assert.deepEqual(replay.result, run.result);
  assert.equal(store.bots()[0].budget, 15000);
  const corrupt = store.latestBacktest();
  corrupt.id = 'corrupt-fixture';
  corrupt.dataset.candles[0].volume++;
  store.saveBacktest(corrupt);
  assert.equal((await post('/api/backtest/safe-play', { reuseLatest: true })).status, 422);
  assert.equal(store.latestBacktest().id, corrupt.id, 'checksum failure must not persist a fabricated result');
  assert.equal((await post('/api/backtest/safe-play', { reuseLatest: 'yes' })).status, 400);
});
test('coverage failure persists actual available candles but no summary and never substitutes older dates', async t => {
  const history = { download: async () => ({ source: 'fixture', fetchedAt: '2026-11-08T06:00:00Z', instrument: { symbol: 'RELIANCE-EQ' }, request: {}, data: historyRows().filter(row => row[0] !== '2026-11-06T15:10:00+05:30') }) };
  const { store, post } = await fixture(t, new AngelOne(new SmartAPI()), { history, now: () => Date.parse('2026-11-08T11:00:00+05:30') });
  store.saveBot({ ...store.bots()[0], name: 'safe play', preset: 'sma', level: 0 });
  const response = await post('/api/backtest/safe-play', {});
  assert.equal(response.status, 422);
  const run = store.latestBacktest();
  assert.equal(run.status, 'blocked');
  assert.equal(run.result, null);
  assert.equal(run.sessions.evaluated.at(-1), '2026-11-06');
  assert.equal(run.coverage.at(-1).received, 71);
  assert.equal(run.dataset.candles.length, 656);
  assert.equal(store.orders().length, 0);
});
