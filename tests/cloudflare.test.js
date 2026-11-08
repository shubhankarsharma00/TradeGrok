import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../server/cloudflare.js';

const publicOrigin = 'https://tradegrok-smartapi.fixture.workers.dev';
const env = { PUBLIC_ORIGIN: publicOrigin, LOCAL_RETURN_ORIGIN: 'http://127.0.0.1:3100' };
const call = (path, options = {}, bindings = env) => worker.fetch(new Request(`${publicOrigin}${path}`, options), bindings);
const callback = params => `/auth/smartapi/callback?${new URLSearchParams(params)}`;

test('Cloudflare configuration requires HTTPS and a fixed literal loopback return', t => {
  t.mock.method(console, 'error', () => {});
  assert.equal(call('/healthz', {}, { PUBLIC_ORIGIN: publicOrigin }).status, 200);
  for (const origin of ['', 'http://fixture.workers.dev', `${publicOrigin}/path`, `${publicOrigin}?q=1`,
    `${publicOrigin}#fragment`, 'https://user:password@fixture.workers.dev', `${publicOrigin}:8080`]) {
    assert.equal(call('/healthz', {}, { ...env, PUBLIC_ORIGIN: origin }).status, 500);
  }
  for (const origin of ['http://localhost:3100', 'http://evil.example:3100', 'https://127.0.0.1:3100',
    'http://127.0.0.1:3100/path', 'http://127.0.0.1:3100?query=1', 'http://127.0.0.1:3100#fragment', 'http://127.0.0.1:80']) {
    assert.equal(call('/healthz', {}, { ...env, LOCAL_RETURN_ORIGIN: origin }).status, 500);
  }
});

test('Cloudflare exposes only the callback and minimal health with no-store security headers', async () => {
  const health = call('/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  for (const path of ['/', '/api/state', '/api/smartapi/status', '/api/smartapi/login', '/api/smartapi/disconnect',
    '/api/broker/connect', '/api/bots', '/api/settings', '/api/emergency', '/tokens', '/app.js',
    '/auth/smartapi/return', '/.env', '/data/tradegrok.sqlite']) {
    const response = call(path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
    assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('set-cookie'), null);
  }
});

test('Cloudflare uses only the allowlisted fragment and ignores caller-controlled return addresses', async () => {
  const response = call(callback({
    state: 'a'.repeat(64), auth_token: 'fixture/auth+token=', feed_token: 'fixture-feed',
    redirect_url: 'https://evil.example', return_url: 'https://evil.example', extra: 'private-extra'
  }));
  assert.equal(response.status, 303);
  assert.equal(await response.text(), '');
  const destination = new URL(response.headers.get('location'));
  assert.equal(destination.origin, env.LOCAL_RETURN_ORIGIN);
  assert.equal(destination.pathname, '/auth/smartapi/return');
  assert.equal(destination.search, '');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(destination.hash.slice(1))), {
    state: 'a'.repeat(64), auth_token: 'fixture/auth+token=', feed_token: 'fixture-feed'
  });
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('Cloudflare rejects malformed state, other hosts, HTTP and non-GET callbacks', () => {
  for (const query of ['', 'state=wrong', `state=${'a'.repeat(64)}&state=${'a'.repeat(64)}`]) {
    const response = call(`/auth/smartapi/callback?${query}`);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('location'), null);
  }
  for (const origin of ['http://tradegrok-smartapi.fixture.workers.dev', 'https://evil.example',
    'https://tradegrok-smartapi.fixture.workers.dev.evil.example', 'https://preview.fixture.workers.dev']) {
    const response = worker.fetch(new Request(`${origin}/auth/smartapi/callback`, {
      headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': new URL(publicOrigin).host }
    }), env);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('location'), null);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
    assert.equal(call('/auth/smartapi/callback', { method }).status, 405);
  }
});

test('Cloudflare relays denied login and malformed tokens without leaking partial credentials or broker errors', () => {
  const state = 'a'.repeat(64);
  for (const params of [
    { state, error: 'private-error', auth_token: 'partial-token', feed_token: 'feed' },
    { state, errorcode: 'private-error', auth_token: 'partial-token', feed_token: 'feed' },
    { state, auth_token: 'partial-token' },
    { state, auth_token: '', feed_token: 'feed' },
    { state, auth_token: 'with space', feed_token: 'feed' },
    { state, auth_token: 'with\nnewline', feed_token: 'feed' },
    { state, auth_token: 'a'.repeat(8193), feed_token: 'feed' },
    [['state', state], ['auth_token', 'one'], ['auth_token', 'two'], ['feed_token', 'feed']]
  ]) {
    const response = call(callback(params));
    assert.equal(response.status, 303);
    const destination = new URL(response.headers.get('location'));
    assert.deepEqual(Object.fromEntries(new URLSearchParams(destination.hash.slice(1))), {
      state, error: 'login_incomplete'
    });
  }
});

test('invalid Cloudflare bindings fail explicitly with sanitised diagnostics', async t => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  const response = call('/healthz', {}, { ...env, PUBLIC_ORIGIN: 'invalid-private-setting' });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'The relay operation did not complete.', code: 'INTERNAL' });
  assert.deepEqual(logs, [['Cloudflare relay request failed:', 'Error']]);
});

test('Cloudflare deployment disables persisted invocation logging and preview URLs', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.main, 'server/cloudflare.js');
  assert.equal(config.observability.enabled, false);
  assert.equal(config.logpush, false);
  assert.equal(config.preview_urls, false);
  assert.equal(config.workers_dev, true);
  assert.deepEqual(Object.keys(config.vars).sort(), ['LOCAL_RETURN_ORIGIN', 'PUBLIC_ORIGIN']);
});
