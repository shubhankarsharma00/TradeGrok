import test from 'node:test';
import assert from 'node:assert/strict';
import { AngelOne, exchangeTime } from '../server/angel.js';
import { SmartAPI } from '../server/smartapi.js';
import { Store } from '../server/store.js';
import { Engine } from '../server/engine.js';

const NOW = Date.parse('2026-11-09T10:00:00+05:30');
const metadata = { localIP: '192.0.2.1', publicIP: '192.0.2.2', mac: '00:11:22:33:44:55' };
const success = data => new Response(JSON.stringify({ status: true, errorcode: '', data }));
function fixture(fetchImpl) {
  const smartapi = new SmartAPI({ apiKey: 'fixture-key', now: () => NOW });
  smartapi.session = { authToken: 'fixture-token', receivedAt: NOW, expiresAt: NOW + 3600000 };
  const broker = new AngelOne(smartapi, { metadata, now: () => NOW, sleep: async () => {}, fetchImpl });
  return { smartapi, broker };
}
const marketRow = { exchange: 'NSE', tradingSymbol: 'RELIANCE-EQ', symbolToken: '2885', ltp: 149.5, percentChange: -0.33, exchFeedTime: '09-Nov-2026 10:00:00' };
test('official read-only portfolio and FULL quote endpoints use authenticated headers and project data', async () => {
  const calls = [];
  const { broker } = fixture(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('getHolding')) return success([{ tradingsymbol: 'RELIANCE-EQ', quantity: 10, averageprice: 100, secret_extra: 'not projected' }]);
    if (url.endsWith('getPosition')) return success([{ exchange: 'NSE', tradingsymbol: 'RELIANCE-EQ', netqty: '2', netprice: '100', realised: '0', producttype: 'DELIVERY' }]);
    if (url.endsWith('searchScrip')) return success([{ exchange: 'NSE', tradingsymbol: 'RELIANCE-EQ', symboltoken: '2885' }]);
    return success({ fetched: [marketRow], unfetched: [] });
  });
  const account = await broker.connect();
  assert.deepEqual(account.holdings, [{ symbol: 'RELIANCE-EQ', quantity: 10, averagePrice: 100 }]);
  assert.equal(account.positions[0].quantity, 2);
  const quote = await broker.quote('RELIANCE');
  assert.equal(quote.source, 'angel');
  assert.equal(quote.price, 149.5);
  assert.equal(Date.parse(quote.at), NOW);
  assert.equal(broker.status().status, 'connected');
  for (const { url, options } of calls) {
    assert.equal(new URL(url).origin, 'https://apiconnect.angelone.in');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    assert.equal(options.headers['X-PrivateKey'], 'fixture-key');
    assert.equal(options.headers['X-ClientPublicIP'], metadata.publicIP);
  }
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(calls[3].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[3].options.body), { mode: 'FULL', exchangeTokens: { NSE: ['2885'] } });
  assert.ok(!JSON.stringify(account).includes('secret_extra'));
  assert.ok(!JSON.stringify(account).includes('fixture-token'));
  await broker.quote('RELIANCE');
  assert.equal(calls.filter(call => call.url.endsWith('searchScrip')).length, 1);
  await assert.rejects(broker.request('placeOrder', {}, metadata), { code: 'LIVE_DISABLED' });
});
test('missing login, expiry, changed session and unsupported instruments cannot request quotes', async () => {
  let calls = 0;
  const { broker, smartapi } = fixture(async () => { calls++; return success([]); });
  await broker.connect();
  const before = calls;
  await assert.rejects(broker.quote('NFO:UNKNOWN'), { code: 'SMARTAPI_INSTRUMENT' });
  smartapi.clear();
  assert.equal(broker.status().status, 'awaiting_login');
  assert.equal(broker.account, null);
  await assert.rejects(broker.quote('RELIANCE'), { code: 'SMARTAPI_AUTH' });
  assert.equal(calls, before);
  smartapi.session = { authToken: 'other-fixture', receivedAt: NOW, expiresAt: NOW + 1000 };
  assert.equal(broker.status().status, 'unverified');
  smartapi.session.expiresAt = NOW;
  await assert.rejects(broker.connect(), { code: 'SMARTAPI_AUTH' });
});
test('invalid JSON, HTTP/auth failures and malformed portfolio rows are sanitized and blocked', async () => {
  for (const response of [
    () => new Response('fixture-token', { status: 401 }),
    () => new Response('fixture-token', { status: 500 }),
    () => new Response('not json'),
    () => success([{ tradingsymbol: 'ITC-EQ', quantity: '', averageprice: 10 }]),
    () => success([{ tradingsymbol: 'ITC-EQ', quantity: 1, averageprice: null }]),
    () => new Response(JSON.stringify({ status: false, errorcode: 'AG8001', message: 'fixture-token' })),
    () => { throw new Error('fixture-token'); }
  ]) {
    const { broker } = fixture(async () => response());
    await assert.rejects(broker.connect(), error => !error.message.includes('fixture-token'));
    assert.equal(broker.account, null);
  }
});
test('verification failures stay visible for the exact session, clear prior account projections and never assume an empty portfolio', async () => {
  let fail = false;
  const { broker, smartapi } = fixture(async url => fail && url.endsWith('getPosition')
    ? new Response(JSON.stringify({ status: false, errorcode: 'AB2001', data: null, message: 'fixture-token' }))
    : success([]));
  await broker.connect();
  assert.equal(broker.status().status, 'connected');
  fail = true;
  await assert.rejects(broker.connect(), { code: 'SMARTAPI_RESPONSE' });
  assert.equal(broker.status().status, 'error');
  assert.match(broker.status().message, /getPosition.*AB2001/);
  assert.ok(!broker.status().message.includes('fixture-token'));
  assert.equal(broker.account, null);
  await assert.rejects(broker.quote('RELIANCE'), { code: 'SMARTAPI_AUTH' });
  smartapi.session = { authToken: 'new-fixture-token', receivedAt: NOW, expiresAt: NOW + 1000 };
  assert.equal(broker.status().status, 'unverified');
  assert.equal(broker.healthSession, null);
  smartapi.clear();
  assert.equal(broker.status().status, 'awaiting_login');
});
test('successful null portfolio responses verify an empty account without weakening actual quote validation', async () => {
  const { broker } = fixture(async () => new Response(JSON.stringify({ status: true, errorcode: '', data: null })));
  const account = await broker.connect();
  assert.deepEqual(account.holdings, []);
  assert.deepEqual(account.positions, []);
  assert.equal(broker.status().status, 'connected');
  await assert.rejects(broker.quote('RELIANCE'), { code: 'SMARTAPI_RESPONSE' });
});
test('malformed or wrong-instrument market data never creates a substitute quote', async () => {
  for (const row of [
    { ...marketRow, exchFeedTime: null },
    { ...marketRow, ltp: '149.5' },
    { ...marketRow, ltp: -1 },
    { ...marketRow, symbolToken: '999' },
    { ...marketRow, exchange: 'BSE' },
    { ...marketRow, tradingSymbol: 'OTHER-EQ' }
  ]) {
    const { broker } = fixture(async url => {
      if (url.endsWith('searchScrip')) return success([{ exchange: 'NSE', tradingsymbol: 'RELIANCE-EQ', symboltoken: '2885' }]);
      if (url.endsWith('/quote')) return success({ fetched: [row], unfetched: [] });
      return success([]);
    });
    await broker.connect();
    await assert.rejects(broker.quote('RELIANCE'), { code: 'SMARTAPI_RESPONSE' });
  }
});
test('exchange timestamp is parsed in IST, not the host timezone or fetch time', () => {
  assert.equal(exchangeTime('09-Nov-2026 10:00:00'), NOW);
  for (const value of ['31-Feb-2026 10:00:00', '09-Nov-2026 25:00:00', '09-XXX-2026 10:00:00', '', null]) assert.ok(Number.isNaN(exchangeTime(value)));
});
test('actual-shape Angel One quotes drive paper fills; stale quotes do not fill and source remains SmartAPI', async t => {
  let stale = true;
  const { broker } = fixture(async url => {
    if (url.endsWith('searchScrip')) return success([{ exchange: 'NSE', tradingsymbol: 'RELIANCE-EQ', symboltoken: '2885' }]);
    if (url.endsWith('/quote')) return success({ fetched: [{ ...marketRow, exchFeedTime: stale ? '09-Nov-2026 09:58:00' : marketRow.exchFeedTime }], unfetched: [] });
    return success([]);
  });
  await broker.connect();
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.saveSettings({ ...store.settings(), mode: 'angel' });
  const bot = store.bots()[0];
  Object.assign(bot, { preset: 'dip', level: 150, status: 'running' });
  store.saveBot(bot);
  const engine = new Engine(store, broker, { now: () => NOW });
  await engine.tick();
  assert.equal(store.orders().length, 0);
  stale = false;
  await engine.tick();
  assert.equal(store.orders().length, 1);
  assert.equal(store.orders()[0].execution, 'paper');
  assert.equal(store.orders()[0].source, 'angel');
  assert.equal(store.bot(bot.id).position.source, 'angel');
});
