import test from 'node:test';
import assert from 'node:assert/strict';
import { SmartHistory } from '../server/history.js';
import { SmartAPI } from '../server/smartapi.js';

const metadata = { localIP: '192.0.2.10', publicIP: '192.0.2.11', mac: '00:11:22:33:44:55' };
function fixture(fetchImpl) {
  let now = Date.parse('2026-11-08T11:00:00+05:30');
  const smartapi = new SmartAPI({ apiKey: 'fixture-key', now: () => now });
  smartapi.session = { authToken: 'fixture-token', expiresAt: now + 3600000, receivedAt: now };
  const sleeps = [];
  const history = new SmartHistory(smartapi, { metadata, fetchImpl, now: () => now, sleep: async ms => { sleeps.push(ms); now += ms; } });
  return { smartapi, history, sleeps };
}
test('download resolves exact NSE equity and makes only properly authenticated search/history requests', async () => {
  const calls = [];
  const { history, smartapi, sleeps } = fixture(async (url, options) => {
    calls.push({ url, options });
    const data = url.endsWith('searchScrip')
      ? [{ exchange: 'NSE', tradingsymbol: 'RELIANCE-BL', symboltoken: '1' }, { exchange: 'NSE', tradingsymbol: 'RELIANCE-EQ', symboltoken: '2885' }]
      : [['2026-10-27T09:15:00+05:30', 100, 101, 99, 100, 1000]];
    return new Response(JSON.stringify({ status: true, errorcode: '', data }));
  });
  const download = await history.download('RELIANCE', ['2026-10-27', '2026-11-06']);
  assert.equal(download.instrument.token, '2885');
  assert.equal(download.request.interval, 'FIVE_MINUTE');
  assert.equal(download.request.fromdate, '2026-10-27 09:15');
  assert.equal(download.request.todate, '2026-11-06 15:35');
  assert.equal(calls.length, 2);
  assert.equal(sleeps[0], 1100);
  for (const { url, options } of calls) {
    assert.ok(url.startsWith('https://apiconnect.angelone.in/rest/secure/'));
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    assert.equal(options.headers['X-PrivateKey'], 'fixture-key');
    assert.equal(options.headers['X-ClientPublicIP'], metadata.publicIP);
  }
  assert.ok(smartapi.session.historicalVerifiedAt);
  assert.ok(!JSON.stringify(download).includes('fixture-token'));
  assert.ok(!JSON.stringify(download).includes('fixture-key'));
  await assert.rejects(history.request('placeOrder', {}, metadata), { code: 'LIVE_DISABLED' });
});
test('HTTP 200 status false, malformed JSON, ambiguous instruments and auth failures are never success', async () => {
  for (const kind of ['false', 'auth', 'json', 'http', 'ambiguous']) {
    const { history } = fixture(async () => {
      if (kind === 'json') return new Response('not-json');
      if (kind === 'http') return new Response('', { status: 500 });
      if (kind === 'auth') return new Response(JSON.stringify({ status: false, errorcode: 'AG8001', message: 'fixture-token' }));
      if (kind === 'false') return new Response(JSON.stringify({ status: false, data: [], message: 'fixture-token' }));
      return new Response(JSON.stringify({ status: true, data: [
        { exchange: 'NSE', tradingsymbol: 'RELIANCE-EQ', symboltoken: '1' },
        { exchange: 'NSE', tradingsymbol: 'RELIANCE-EQ', symboltoken: '2' }
      ] }));
    });
    await assert.rejects(history.download('RELIANCE', ['2026-10-27', '2026-11-06']), error => {
      assert.ok(!error.message.includes('fixture-token'));
      return true;
    }, kind);
  }
});
test('rate limit retries are bounded and session expiry requires a new login without any network call', async () => {
  let count = 0;
  const { history } = fixture(async () => { count++; return new Response('', { status: 429 }); });
  await assert.rejects(history.download('RELIANCE', ['2026-10-27', '2026-11-06']), { code: 'SMARTAPI_RATE_LIMIT' });
  assert.equal(count, 3);
  const other = fixture(async () => { throw new Error('Should not fetch without a session'); });
  other.smartapi.clear();
  await assert.rejects(other.history.download('RELIANCE', ['2026-10-27', '2026-11-06']), { code: 'SMARTAPI_AUTH' });
});
test('successful envelopes accept null/omitted error codes and their alternate spelling without weakening data validation', async () => {
  for (const fields of [{}, { errorcode: '' }, { errorcode: null }, { errorCode: null }, { errorCode: '' }]) {
    const { history } = fixture(async () => new Response(JSON.stringify({ status: true, data: [], ...fields })));
    assert.deepEqual(await history.request('holdings', undefined, metadata), []);
    const empty = fixture(async () => new Response(JSON.stringify({ status: true, data: null, ...fields })));
    assert.deepEqual(await empty.history.request('positions', undefined, metadata), []);
    assert.deepEqual(await empty.history.request('holdings', undefined, metadata), []);
  }
  for (const payload of [
    { status: false, errorcode: '', data: [] },
    { status: false, errorcode: '', data: null },
    { status: true, errorcode: null },
    { status: true, errorcode: '', errorCode: 'AB2001', data: [] },
    { status: true, errorCode: 'AB2001', data: [] },
    { status: true, data: {} }
  ]) {
    const { history } = fixture(async () => new Response(JSON.stringify(payload)));
    await assert.rejects(history.request('holdings', undefined, metadata), { code: 'SMARTAPI_RESPONSE' });
  }
  for (const operation of ['search', 'candles', 'quotes']) {
    const { history } = fixture(async () => new Response(JSON.stringify({ status: true, errorcode: '', data: null })));
    await assert.rejects(history.request(operation, {}, metadata), { code: 'SMARTAPI_RESPONSE' });
  }
});
test('response diagnostics identify the endpoint and recognised broker code without echoing raw messages or values', async () => {
  const { history } = fixture(async () => new Response(JSON.stringify({ status: false, errorcode: 'AB2001', message: 'fixture-token private-account', data: null })));
  await assert.rejects(history.request('holdings', undefined, metadata), error => {
    assert.match(error.message, /getHolding reported failure \(HTTP 200; code AB2001; data null\)/);
    assert.match(error.message, /internal service error/);
    assert.ok(!error.message.includes('fixture-token'));
    assert.ok(!error.message.includes('private-account'));
    return true;
  });
  const unknown = fixture(async () => new Response(JSON.stringify({ status: false, errorcode: 'fixture-token', message: 'fixture-key', data: { account: 'private-account' } })));
  await assert.rejects(unknown.history.request('positions', undefined, metadata), error => {
    assert.match(error.message, /getPosition reported failure/);
    assert.match(error.message, /unrecognised error code; data object/);
    assert.ok(!/fixture-token|fixture-key|private-account/.test(error.message));
    return true;
  });
  for (const errorCode of ['AG8001', 'AG8002', 'AG8003', 'AB8050']) {
    const auth = fixture(async () => new Response(JSON.stringify({ status: false, errorCode, data: null })));
    await assert.rejects(auth.history.request('search', {}, metadata), { code: 'SMARTAPI_AUTH', status: 401 });
  }
});
