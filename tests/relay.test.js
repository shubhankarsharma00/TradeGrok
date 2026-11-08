import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Store } from '../server/store.js';
import { AngelOne } from '../server/angel.js';
import { createApp } from '../server/app.js';
import { createAzureCallback } from '../server/azure-callback.js';
import { SmartAPI, smartApiCallbackPath } from '../server/smartapi.js';

const relayOrigin = 'https://callback.example.test';
async function fixture(t, now = () => Date.now()) {
  const store = new Store(':memory:');
  const smartapi = new SmartAPI({ apiKey: 'fixture-api-key', now });
  const { server } = createApp(store, new AngelOne(new SmartAPI()), { now, smartapi, smartapiRelayOrigin: relayOrigin });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cloud = createAzureCallback({ publicOrigin: relayOrigin, localReturnOrigin: base });
  await new Promise(resolve => cloud.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await Promise.all([server, cloud].map(s => new Promise(resolve => s.close(resolve)))); store.close(); });
  const initial = await (await fetch(`${base}/api/state`)).json();
  const post = (path, input, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: {
    Origin: base, 'Content-Type': 'application/json', 'X-Tradegrok-CSRF': initial.csrf, ...headers
  }, body: JSON.stringify(input) });
  const start = async () => {
    const response = await post('/api/smartapi/login', {});
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const url = new URL((await response.json()).loginUrl);
    assert.equal(url.searchParams.get('redirect_url'), `${relayOrigin}${smartApiCallbackPath}`);
    return { cookie, state: url.searchParams.get('state') };
  };
  const relay = params => new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${cloud.address().port}${smartApiCallbackPath}?${new URLSearchParams(params)}`,
      { headers: { Host: new URL(relayOrigin).host, 'X-Forwarded-Proto': 'https' } }, response => {
        response.resume(); resolve(response.headers.location);
      });
    req.on('error', reject); req.end();
  });
  return { base, store, smartapi, initial, start, relay, post };
}
async function landingScript(base, destination, cookie) {
  const events = [];
  const location = { hash: new URL(destination).hash };
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  location.replace = url => { events.push(['navigate', url]); finish(url); };
  const script = await readFile(new URL('../public/smartapi-return.js', import.meta.url), 'utf8');
  vm.runInNewContext(script, {
    URLSearchParams, location,
    history: { replaceState: (_state, _title, url) => { events.push(['scrub', url]); location.hash = ''; } },
    fetch: async (url, options) => {
      assert.equal(events[0][0], 'scrub', 'fragment is scrubbed synchronously before sending tokens');
      assert.equal(location.hash, '');
      assert.equal(url, '/auth/smartapi/callback');
      events.push(['post', url]);
      return fetch(`${base}${url}`, { ...options, headers: { ...options.headers, Origin: base, Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } });
    }
  });
  return { result: await done, events };
}
test('exact local -> HTTPS relay -> fragment landing -> same-origin POST completes session in local TradeGrok', async t => {
  const { base, store, smartapi, start, relay } = await fixture(t);
  const { cookie, state } = await start();
  const destination = await relay({ state, auth_token: 'fixture-auth', feed_token: 'fixture-feed' });
  const landing = new URL(destination);
  assert.equal(landing.origin, base);
  assert.equal(landing.search, '');
  const response = await fetch(`${base}${landing.pathname}`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } });
  assert.equal(response.status, 200, 'cross-site top-level GET admits a SameSite=Lax cookie');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(!(await response.text()).includes('fixture-auth'));
  const completed = await landingScript(base, destination, cookie);
  assert.equal(completed.result, '/?smartapi=received');
  assert.deepEqual(completed.events.map(event => event[0]), ['scrub', 'post', 'navigate']);
  assert.equal(smartapi.session.authToken, 'fixture-auth');
  assert.equal(smartapi.session.feedToken, 'fixture-feed');
  assert.equal(smartapi.pending, null);
  const dashboard = await (await fetch(`${base}/api/state`)).json();
  assert.equal(dashboard.smartapi.status, 'callback_received');
  assert.equal(dashboard.smartapi.callbackUrl, `${relayOrigin}${smartApiCallbackPath}`);
  assert.equal(dashboard.account, null);
  assert.equal(dashboard.liveEnabled, false);
  assert.equal(store.orders().length, 0);
  for (const secret of ['fixture-auth', 'fixture-feed', 'fixture-api-key']) assert.ok(!JSON.stringify(dashboard).includes(secret));
  assert.equal((await landingScript(base, destination, cookie)).result, '/?smartapi=error', 'replay is rejected');
});
test('local completion rejects other browsers, missing/wrong state, malformed tokens and cross-origin POSTs', async t => {
  const { smartapi, start, post } = await fixture(t);
  for (const kind of ['missing-cookie', 'wrong-cookie', 'wrong-state', 'missing-state', 'malformed-token', 'missing-feed', 'foreign-origin']) {
    const { cookie, state } = await start();
    const input = { state, auth_token: 'fixture-auth', feed_token: 'fixture-feed' };
    const headers = { Cookie: cookie };
    if (kind === 'missing-cookie') delete headers.Cookie;
    if (kind === 'wrong-cookie') headers.Cookie = 'tradegrok_smartapi_login=another-browser';
    if (kind === 'wrong-state') input.state = 'b'.repeat(64);
    if (kind === 'missing-state') delete input.state;
    if (kind === 'malformed-token') input.auth_token = ['not-a-string'];
    if (kind === 'missing-feed') delete input.feed_token;
    if (kind === 'foreign-origin') headers.Origin = 'https://evil.example';
    const response = await post(smartApiCallbackPath, input, headers);
    assert.ok([400, 403].includes(response.status), kind);
    assert.equal(smartapi.session, null);
  }
});
test('duplicate fragment fields never POST and denied login or expiry never create a local session', async t => {
  let now = 1000;
  const { base, smartapi, start, relay } = await fixture(t, () => now);
  let attempt = await start();
  const duplicate = `${base}/auth/smartapi/return#state=${attempt.state}&state=${attempt.state}&auth_token=x&feed_token=y`;
  const result = await landingScript(base, duplicate, attempt.cookie);
  assert.equal(result.result, '/?smartapi=error');
  assert.ok(!result.events.some(event => event[0] === 'post'));
  const denied = await relay({ state: attempt.state, error: 'broker-private-error' });
  assert.equal((await landingScript(base, denied, attempt.cookie)).result, '/?smartapi=error');
  assert.equal(smartapi.pending, null);
  attempt = await start();
  const expired = await relay({ state: attempt.state, auth_token: 'fixture-auth', feed_token: 'fixture-feed' });
  now += 300000;
  assert.equal((await landingScript(base, expired, attempt.cookie)).result, '/?smartapi=error');
  assert.equal(smartapi.session, null);
});
