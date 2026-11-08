import test from 'node:test';
import assert from 'node:assert/strict';
import { SmartAPI, smartApiCookie } from '../server/smartapi.js';

const callbackUrl = 'http://127.0.0.1:3100/auth/smartapi/callback';
function attempt(smartapi) {
  const { loginUrl, browser } = smartapi.start(callbackUrl);
  const url = new URL(callbackUrl);
  url.search = new URLSearchParams({
    state: new URL(loginUrl).searchParams.get('state'), auth_token: 'fixture-auth', feed_token: 'fixture-feed'
  });
  return { url, cookie: `${smartApiCookie}=${browser}` };
}
test('valid callback retains only the documented tokens until midnight IST and projects no secrets', () => {
  let now = Date.parse('2026-11-08T23:59:00+05:30');
  const smartapi = new SmartAPI({ apiKey: 'fixture-key', now: () => now });
  const { url, cookie } = attempt(smartapi);
  smartapi.receive(url, cookie);
  assert.equal(smartapi.pending, null);
  assert.equal(smartapi.session.authToken, 'fixture-auth');
  assert.equal(smartapi.session.feedToken, 'fixture-feed');
  assert.equal(smartapi.status(callbackUrl).expiresAt, '2026-11-08T18:30:00.000Z');
  assert.ok(!JSON.stringify(smartapi.status(callbackUrl)).includes('fixture-auth'));
  now += 60000;
  assert.equal(smartapi.status(callbackUrl).status, 'ready');
  assert.equal(smartapi.session, null);
});
test('state, browser binding, exact callback origin/path and replay protection', () => {
  for (const kind of ['missing-state', 'wrong-state', 'duplicate-state', 'missing-cookie', 'wrong-cookie', 'duplicate-cookie', 'wrong-host', 'wrong-port', 'wrong-path']) {
    const smartapi = new SmartAPI({ apiKey: 'fixture-key' });
    const attemptData = attempt(smartapi);
    const { url } = attemptData;
    let { cookie } = attemptData;
    if (kind === 'missing-state') url.searchParams.delete('state');
    if (kind === 'wrong-state') url.searchParams.set('state', 'wrong');
    if (kind === 'duplicate-state') url.searchParams.append('state', url.searchParams.get('state'));
    if (kind === 'missing-cookie') cookie = '';
    if (kind === 'wrong-cookie') cookie = `${smartApiCookie}=wrong`;
    if (kind === 'duplicate-cookie') cookie = `${cookie}; ${cookie}`;
    if (kind === 'wrong-host') url.hostname = 'localhost';
    if (kind === 'wrong-port') url.port = '3101';
    if (kind === 'wrong-path') url.pathname = '/elsewhere';
    assert.throws(() => smartapi.receive(url, cookie), { code: 'SMARTAPI_STATE' }, kind);
    assert.equal(smartapi.session, null);
  }
  const smartapi = new SmartAPI({ apiKey: 'fixture-key' });
  const { url, cookie } = attempt(smartapi);
  smartapi.receive(url, cookie);
  assert.throws(() => smartapi.receive(url, cookie), { code: 'SMARTAPI_STATE' });
});
test('pending logins expire at five minutes and a second attempt invalidates the first', () => {
  let now = 1000;
  const smartapi = new SmartAPI({ apiKey: 'fixture-key', now: () => now });
  const first = attempt(smartapi);
  const second = attempt(smartapi);
  assert.throws(() => smartapi.receive(first.url, first.cookie), { code: 'SMARTAPI_STATE' });
  now += 300000;
  assert.throws(() => smartapi.receive(second.url, second.cookie), { code: 'SMARTAPI_STATE' });
  assert.equal(smartapi.status(callbackUrl).status, 'ready');
});
test('missing, duplicate, malformed tokens and broker-denied callbacks never create a session', () => {
  for (const kind of ['auth_token', 'feed_token', 'duplicate', 'blank', 'whitespace', 'oversize', 'denied']) {
    const smartapi = new SmartAPI({ apiKey: 'fixture-key' });
    const { url, cookie } = attempt(smartapi);
    if (['auth_token', 'feed_token'].includes(kind)) url.searchParams.delete(kind);
    if (kind === 'duplicate') url.searchParams.append('auth_token', 'another');
    if (kind === 'blank') url.searchParams.set('auth_token', '');
    if (kind === 'whitespace') url.searchParams.set('auth_token', 'token\nheader');
    if (kind === 'oversize') url.searchParams.set('auth_token', 'a'.repeat(8193));
    if (kind === 'denied') url.searchParams.set('error', 'private broker error that must not be exposed');
    assert.throws(() => smartapi.receive(url, cookie), { code: kind === 'denied' ? 'SMARTAPI_LOGIN' : 'SMARTAPI_TOKENS' }, kind);
    assert.equal(smartapi.session, null);
    assert.equal(smartapi.pending, null);
  }
});
test('disconnect clears retained tokens and pending login without contacting the broker', () => {
  const smartapi = new SmartAPI({ apiKey: 'fixture-key' });
  const { url, cookie } = attempt(smartapi);
  smartapi.receive(url, cookie);
  attempt(smartapi);
  smartapi.clear();
  assert.equal(smartapi.session, null);
  assert.equal(smartapi.pending, null);
  assert.equal(smartapi.status(callbackUrl).status, 'ready');
});
