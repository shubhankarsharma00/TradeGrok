import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { azureConfig, createAzureCallback } from '../server/azure-callback.js';
import { smartApiCallbackPath } from '../server/smartapi.js';

const publicOrigin = 'https://callback.example.test';
async function fixture(t) {
  const server = createAzureCallback({ publicOrigin, localReturnOrigin: 'http://127.0.0.1:3100' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers: {
      Host: new URL(publicOrigin).host, 'X-Forwarded-Proto': 'https', ...headers
    } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject); req.end();
  });
  return { call };
}
test('Azure relay configuration requires actual HTTPS App Service host and a fixed literal loopback return', () => {
  const env = { PUBLIC_ORIGIN: publicOrigin, WEBSITE_HOSTNAME: 'callback.example.test', WEBSITE_SITE_NAME: 'fixture' };
  assert.equal(azureConfig(env).localReturnOrigin, 'http://127.0.0.1:3100');
  for (const origin of ['', 'http://callback.example.test', `${publicOrigin}/callback`, `${publicOrigin}?q=1`,
    `${publicOrigin}#fragment`, 'https://user:password@callback.example.test', 'https://callback.example.test:8080', 'https://another.example.test']) {
    assert.throws(() => azureConfig({ ...env, PUBLIC_ORIGIN: origin }));
  }
  for (const origin of ['http://localhost:3100', 'http://evil.example:3100', 'http://127.0.0.1:3100/path',
    'http://127.0.0.1:3100?query=1', 'http://127.0.0.1:3100#fragment', 'https://127.0.0.1:3100', 'http://127.0.0.1:80']) {
    assert.throws(() => azureConfig({ ...env, LOCAL_RETURN_ORIGIN: origin }));
  }
  assert.throws(() => azureConfig({ ...env, WEBSITE_SITE_NAME: '' }));
});
test('cloud exposes only relay and minimal health, never dashboards, status, token redemption or controls', async t => {
  const { call } = await fixture(t);
  assert.deepEqual(JSON.parse((await call('/healthz')).text), { status: 'ok' });
  for (const path of ['/', '/api/state', '/api/smartapi/status', '/api/smartapi/login', '/api/smartapi/disconnect',
    '/api/broker/connect', '/api/bots', '/api/settings', '/api/emergency', '/tokens', '/app.js', '/.env', '/data/tradegrok.sqlite']) {
    assert.equal((await call(path)).status, 404, path);
  }
});
test('relay returns allowlisted tokens in a fragment to its fixed local landing page, with no body or cookies', async t => {
  const { call } = await fixture(t);
  const params = new URLSearchParams({ state: 'a'.repeat(64), auth_token: 'fixture-auth', feed_token: 'fixture-feed',
    redirect_url: 'https://evil.example', return_url: 'https://evil.example', extra: 'private-extra' });
  const response = await call(`${smartApiCallbackPath}?${params}`);
  assert.equal(response.status, 303);
  const destination = new URL(response.headers.location);
  assert.equal(destination.origin, 'http://127.0.0.1:3100');
  assert.equal(destination.pathname, '/auth/smartapi/return');
  assert.equal(destination.search, '');
  const fragment = new URLSearchParams(destination.hash.slice(1));
  assert.equal(fragment.get('auth_token'), 'fixture-auth');
  assert.equal(fragment.get('feed_token'), 'fixture-feed');
  assert.equal(fragment.get('state'), 'a'.repeat(64));
  assert.equal(fragment.size, 3);
  assert.equal(response.text, '');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
});
test('malformed state, unsafe host, non-HTTPS transport and non-GET requests are rejected', async t => {
  const { call } = await fixture(t);
  for (const query of ['', 'state=wrong', `state=${'a'.repeat(64)}&state=${'a'.repeat(64)}`]) {
    const response = await call(`${smartApiCallbackPath}?${query}`);
    assert.equal(response.status, 400);
    assert.equal(response.headers.location, undefined);
  }
  assert.equal((await call(smartApiCallbackPath, { Host: 'evil.example', 'X-Forwarded-Host': 'callback.example.test' })).status, 403);
  assert.equal((await call(smartApiCallbackPath, { 'X-Forwarded-Proto': 'http' })).status, 403);
  assert.equal((await call(smartApiCallbackPath, {}, 'POST')).status, 405);
});
test('failed broker login and malformed tokens relay only a generic error, not raw error details or partial tokens', async t => {
  const { call } = await fixture(t);
  for (const query of [
    new URLSearchParams({ state: 'a'.repeat(64), error: 'private-error', auth_token: 'partial-token' }),
    new URLSearchParams({ state: 'a'.repeat(64), auth_token: 'partial-token' }),
    new URLSearchParams([['state', 'a'.repeat(64)], ['auth_token', 'one'], ['auth_token', 'two'], ['feed_token', 'feed']])
  ]) {
    const response = await call(`${smartApiCallbackPath}?${query}`);
    assert.equal(response.status, 303);
    const fragment = new URLSearchParams(new URL(response.headers.location).hash.slice(1));
    assert.equal(fragment.get('error'), 'login_incomplete');
    assert.equal(fragment.size, 2);
    assert.ok(!response.headers.location.includes('private-error'));
    assert.ok(!response.headers.location.includes('partial-token'));
  }
});
