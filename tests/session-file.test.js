import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync, symlinkSync, linkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { SessionFile } from '../server/session-file.js';
import { SmartAPI, smartApiCookie } from '../server/smartapi.js';
import { AngelOne } from '../server/angel.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tradegrok-session-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const path = join(directory, 'private', 'smartapi-session.json');
  let now = Date.parse('2026-11-08T23:59:00+05:30');
  const make = (key = 'fixture-key') => new SmartAPI({ apiKey: key, now: () => now, sessionStore: new SessionFile(path, key, { now: () => now }) });
  return { directory, path, make, now: () => now, time: value => { now = value; } };
}
function login(smartapi, callbackUrl = 'http://127.0.0.1:3100/auth/smartapi/callback') {
  const { loginUrl, browser } = smartapi.start(callbackUrl);
  const url = new URL(callbackUrl);
  url.search = new URLSearchParams({ state: new URL(loginUrl).searchParams.get('state'), auth_token: 'fixture-auth', feed_token: 'fixture-feed' });
  smartapi.receive(url, `${smartApiCookie}=${browser}`);
}

test('validated login saves owner-only tokens atomically and restart restores only the original daily session', t => {
  const { path, make } = fixture(t);
  const api = make();
  assert.equal(existsSync(path), false);
  login(api);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(dirname(path)), [basename(path)]);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.authToken, 'fixture-auth');
  assert.equal(saved.feedToken, 'fixture-feed');
  assert.ok(!readFileSync(path, 'utf8').includes('fixture-key'));
  const expiry = api.session.expiresAt;
  api.session.historicalVerifiedAt = 'fixture-verification';
  api.clear({ keepSavedSession: true });
  assert.equal(api.session, null);
  assert.equal(existsSync(path), true);
  const restored = make();
  assert.equal(restored.session.authToken, 'fixture-auth');
  assert.equal(restored.session.expiresAt, expiry);
  assert.equal(restored.session.historicalVerifiedAt, undefined);
  assert.equal(restored.pending, null);
  assert.equal(restored.status('http://127.0.0.1:3100/auth/smartapi/callback').restored, true);
  const projection = JSON.stringify(restored.status('http://127.0.0.1:3100/auth/smartapi/callback'));
  assert.ok(!/fixture-auth|fixture-feed|fixture-key|fixture-verification/.test(projection));
  assert.equal(new AngelOne(restored).status().status, 'unverified');
});

test('midnight IST clears live tokens and file; expiry on startup cannot extend or restore yesterday', t => {
  const { path, make, time } = fixture(t);
  const api = make(); login(api);
  time(Date.parse('2026-11-09T00:00:00+05:30'));
  api.expire();
  assert.equal(api.session, null);
  assert.equal(existsSync(path), false);
  time(Date.parse('2026-11-09T23:59:00+05:30'));
  login(api);
  api.clear({ keepSavedSession: true });
  time(Date.parse('2026-11-10T00:00:00+05:30'));
  assert.equal(make().session, null);
  assert.equal(existsSync(path), false);
});

test('explicit disconnect deletes persistence and changing the API key cannot reuse an old session', t => {
  const { path, make } = fixture(t);
  const api = make(); login(api);
  api.clear();
  assert.equal(existsSync(path), false);
  assert.equal(make().session, null);
  login(api);
  assert.equal(make('different-fixture-key').session, null);
  assert.equal(existsSync(path), false);
});

test('failed callbacks never save tokens, and failed storage never reports a successful new login', t => {
  const { path, make } = fixture(t);
  const api = make();
  const { loginUrl, browser } = api.start('http://127.0.0.1:3100/auth/smartapi/callback');
  const url = new URL('http://127.0.0.1:3100/auth/smartapi/callback');
  url.search = new URLSearchParams({ state: new URL(loginUrl).searchParams.get('state'), auth_token: 'fixture-auth' });
  assert.throws(() => api.receive(url, `${smartApiCookie}=${browser}`), { code: 'SMARTAPI_TOKENS' });
  assert.equal(existsSync(path), false);
  writeFileSync(path, 'unsafe placeholder');
  const linked = `${path}.hardlink`;
  linkSync(path, linked);
  assert.throws(() => login(api), { code: 'SMARTAPI_SESSION_FILE' });
  assert.equal(api.session, null);
  assert.ok(readdirSync(dirname(path)).every(name => !name.endsWith('.tmp')));
});

test('corrupt or invalid saved sessions produce sanitised errors rather than loading credentials', t => {
  const { path, make } = fixture(t);
  const api = make(); login(api);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  for (const content of [
    'fixture-auth not json',
    JSON.stringify({ ...saved, version: 99 }),
    JSON.stringify({ ...saved, authToken: 123 }),
    JSON.stringify({ ...saved, feedToken: '' }),
    JSON.stringify({ ...saved, expiresAt: saved.expiresAt + 86400000 }),
    JSON.stringify({ ...saved, receivedAt: saved.expiresAt - 1 })
  ]) {
    writeFileSync(path, content);
    assert.throws(make, error => error.code === 'SMARTAPI_SESSION_FILE' && !/fixture-auth|fixture-feed|fixture-key/.test(error.message));
  }
});

test('unsafe links are rejected, permissive owned files are tightened, and targets are never overwritten', t => {
  const { directory, path, make } = fixture(t);
  const api = make(); login(api);
  chmodSync(path, 0o644);
  chmodSync(dirname(path), 0o755);
  make();
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  api.clear();
  const target = join(directory, 'outside-session');
  writeFileSync(target, 'leave this file alone');
  symlinkSync(target, path);
  assert.throws(make, { code: 'SMARTAPI_SESSION_FILE' });
  assert.throws(() => login(api), { code: 'SMARTAPI_SESSION_FILE' });
  assert.equal(readFileSync(target, 'utf8'), 'leave this file alone');
});

test('relay login persists locally and API state/static routes never expose the saved tokens', async t => {
  const { path, make, now } = fixture(t);
  const api = make();
  const store = new Store(':memory:');
  const { server } = createApp(store, new AngelOne(api), { smartapi: api, now, smartapiRelayOrigin: 'https://fixture.azurewebsites.net' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(`${base}/api/state`)).json();
  const response = await fetch(`${base}/api/smartapi/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tradegrok-CSRF': state.csrf }, body: '{}' });
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const { loginUrl } = await response.json();
  const completed = await fetch(`${base}/auth/smartapi/callback`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie },
    body: JSON.stringify({ state: new URL(loginUrl).searchParams.get('state'), auth_token: 'fixture-auth', feed_token: 'fixture-feed' })
  });
  assert.equal(completed.status, 200);
  assert.equal(existsSync(path), true);
  const projection = await (await fetch(`${base}/api/state`)).text();
  assert.ok(!/fixture-auth|fixture-feed|fixture-key/.test(projection));
  assert.equal(JSON.parse(projection).smartapi.persisted, true);
  assert.equal((await fetch(`${base}/data/private/smartapi-session.json`)).status, 404);
  assert.equal((await fetch(`${base}/server/session-file.js`)).status, 404);
  const disconnected = await fetch(`${base}/api/smartapi/disconnect`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tradegrok-CSRF': state.csrf }, body: '{}' });
  assert.equal(disconnected.status, 200);
  assert.equal(existsSync(path), false);
});
