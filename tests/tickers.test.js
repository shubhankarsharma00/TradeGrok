import test from 'node:test';
import assert from 'node:assert/strict';
import { AngelOne } from '../server/angel.js';
import { SmartAPI } from '../server/smartapi.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { validateBot } from '../server/engine.js';

const NOW = Date.parse('2026-11-09T10:00:00+05:30');
const metadata = { localIP: '192.0.2.1', publicIP: '192.0.2.2', mac: '00:11:22:33:44:55' };
const success = data => new Response(JSON.stringify({ status: true, data }));
function brokerFixture(rows = [{ exchange: 'NSE', tradingsymbol: 'M&M-EQ', symboltoken: '2031' }]) {
  const smartapi = new SmartAPI({ apiKey: 'fixture-key', now: () => NOW });
  smartapi.session = { authToken: 'fixture-auth', feedToken: 'fixture-feed', receivedAt: NOW, expiresAt: NOW + 3600000 };
  const calls = [];
  const broker = new AngelOne(smartapi, { metadata, now: () => NOW, sleep: async () => {}, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('searchScrip')) return success(rows);
    if (url.endsWith('/quote')) return success({ fetched: [{ exchange: 'NSE', tradingSymbol: 'M&M-EQ', symbolToken: '2031', ltp: 100, percentChange: 1, exchFeedTime: '09-Nov-2026 10:00:00' }], unfetched: [] });
    return success([]);
  } });
  return { broker, smartapi, calls };
}
async function appFixture(t, broker, options = {}) {
  const store = new Store(':memory:');
  store.db.exec('DELETE FROM bots');
  const { server, engine } = createApp(store, broker, { now: () => NOW, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(`${base}/api/state`)).json();
  const post = (route, data) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tradegrok-CSRF': state.csrf }, body: JSON.stringify(data) });
  return { store, engine, base, post };
}

test('SmartAPI dropdown search accepts non-preselected tickers and filters non-NSE/non-EQ series', async () => {
  const { broker, calls } = brokerFixture([
    { exchange: 'NSE', tradingsymbol: 'M&M-EQ', symboltoken: '2031' },
    { exchange: 'NSE', tradingsymbol: 'M&M-EQ', symboltoken: '2031' },
    { exchange: 'BSE', tradingsymbol: 'M&M-EQ', symboltoken: '99' },
    { exchange: 'NSE', tradingsymbol: 'M&M-BE', symboltoken: '98' },
    { exchange: 'NFO', tradingsymbol: 'M&M26NOVFUT', symboltoken: '97' }
  ]);
  assert.deepEqual(await broker.searchSymbols('M&'), [{ symbol: 'M&M', name: 'M&M-EQ', token: '2031' }]);
  assert.deepEqual(JSON.parse(calls[0].options.body), { exchange: 'NSE', searchscrip: 'M&' });
  assert.equal(await broker.resolveSymbol('M&M'), '2031');
  const before = calls.length;
  assert.equal(await broker.resolveSymbol('M&M'), '2031');
  assert.equal(calls.length, before);
});

test('ambiguous/malformed instrument identifiers and index-only matches never resolve to cash equity', async () => {
  for (const rows of [
    [null],
    [{ exchange: 'NSE', tradingsymbol: 'M&M-EQ', symboltoken: '' }],
    [{ exchange: 'NSE', tradingsymbol: 'M&M-EQ', symboltoken: '2031' }, { exchange: 'NSE', tradingsymbol: 'M&M-EQ', symboltoken: '999' }],
    [{ exchange: 'NSE', tradingsymbol: 'NIFTY', symboltoken: '999' }]
  ]) {
    const { broker } = brokerFixture(rows);
    await assert.rejects(broker.resolveSymbol('M&M'), { code: 'SMARTAPI_INSTRUMENT' });
  }
});

test('new ticker resolves exact SmartAPI prices and drives paper entry and manual exit without a static allowlist', async t => {
  const { broker, smartapi } = brokerFixture();
  await broker.connect();
  const { store, engine, post } = await appFixture(t, broker, { smartapi });
  const config = { name: 'M&M paper', symbol: 'M&M', preset: 'dip', level: 101, budget: 5000, stopPct: 1, targetPct: 2 };
  assert.equal(validateBot(config, store.settings()).symbol, 'M&M');
  const created = await post('/api/bots', config);
  assert.equal(created.status, 201);
  const bot = await created.json();
  assert.equal((await post(`/api/bots/${bot.id}/start`, {})).status, 200);
  assert.equal(await engine.tick(), true);
  assert.equal(engine.quotes.get('M&M').price, 100);
  assert.ok(store.bot(bot.id).position);
  assert.equal((await post(`/api/bots/${bot.id}/close`, {})).status, 200);
  assert.equal(store.orders().length, 2);
  assert.ok(store.orders().every(order => order.symbol === 'M&M' && order.source === 'angel' && order.execution === 'paper'));
});

test('ticker search route is same-origin, bounded, projects no tokens and unknown tickers cannot be saved', async t => {
  const { broker, smartapi } = brokerFixture();
  const { base, post, store } = await appFixture(t, broker, { smartapi });
  const invalid = await fetch(`${base}/api/instruments?search=M`);
  assert.equal(invalid.status, 400);
  const response = await fetch(`${base}/api/instruments?search=M%26`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.instruments, [{ symbol: 'M&M', name: 'M&M-EQ' }]);
  assert.ok(!JSON.stringify(result).includes('2031'));
  assert.equal((await fetch(`${base}/api/instruments?search=M%26`)).status, 429);
  assert.equal((await fetch(`${base}/api/instruments?search=M%26`, { headers: { Origin: 'https://other.example' } })).status, 403);
  const unknown = await post('/api/bots', { name: 'Unknown', symbol: 'NIFTY', preset: 'sma', budget: 1000, stopPct: 1, targetPct: 2 });
  assert.equal(unknown.status, 422);
  assert.equal(store.bots().length, 0);
  assert.equal(store.orders().length, 0);
});
