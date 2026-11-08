import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, readdirSync, symlinkSync, linkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { EnvFile } from '../server/env-file.js';
import { SmartAPI } from '../server/smartapi.js';
import { AngelOne } from '../server/angel.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';

const input = { apiKey: 'synthetic-test-key', relayOrigin: 'https://test-relay.workers.dev' };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tradegrok-env-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const path = join(directory, '.env');
  return { directory, path, file: new EnvFile(path) };
}

test('saving creates an owner-only local .env, records the current port and returns no credentials', t => {
  const f = fixture(t);
  assert.deepEqual(f.file.save(input, { port: 3101 }), { saved: true, restartRequired: true });
  assert.deepEqual(parseEnv(readFileSync(f.path, 'utf8')), {
    SMARTAPI_API_KEY: input.apiKey, SMARTAPI_RELAY_ORIGIN: input.relayOrigin, PORT: '3101'
  });
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(f.directory), ['.env']);
});

test('updates preserve comments, other variables, multiline values and existing port without duplicate keys', t => {
  const f = fixture(t);
  const original = '# Personal config\r\nPORT=3200\r\nOTHER="keep # this"\r\nMULTILINE="first\r\nSMARTAPI_API_KEY=not-an-assignment\r\nlast"\r\nexport SMARTAPI_API_KEY="old"\r\nSMARTAPI_API_KEY=duplicate\r\nSMARTAPI_RELAY_ORIGIN=\'https://old.example\' # old relay\r\n# End\r\n';
  writeFileSync(f.path, original, { mode: 0o644 });
  f.file.save(input, { port: 3101 });
  const saved = readFileSync(f.path, 'utf8');
  const parsed = parseEnv(saved);
  assert.equal(parsed.PORT, '3200');
  assert.equal(parsed.OTHER, 'keep # this');
  assert.equal(parsed.MULTILINE, parseEnv(original).MULTILINE);
  assert.equal(parsed.SMARTAPI_API_KEY, input.apiKey);
  assert.equal(parsed.SMARTAPI_RELAY_ORIGIN, input.relayOrigin);
  assert.match(saved, /^# Personal config\r\n/);
  assert.match(saved, /# End\r\n$/);
  assert.equal((saved.match(/^SMARTAPI_API_KEY='/gm) ?? []).length, 1);
  assert.doesNotMatch(saved, /duplicate|old relay/);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
});

test('special printable API key characters round-trip literally without expanding or adding settings', t => {
  const f = fixture(t);
  const apiKey = 'synthetic#$"\\`key=123';
  f.file.save({ ...input, apiKey });
  assert.equal(parseEnv(readFileSync(f.path, 'utf8')).SMARTAPI_API_KEY, apiKey);
  assert.equal(Object.keys(parseEnv(readFileSync(f.path, 'utf8'))).length, 2);
});

test('invalid keys, unsafe origins and additional fields never change the file or leak values', t => {
  const f = fixture(t);
  writeFileSync(f.path, 'PORT=3100\n# unchanged\n');
  const invalid = [
    { ...input, apiKey: '' }, { ...input, apiKey: 'synthetic\nINJECTED=true' },
    { ...input, apiKey: "synthetic'key" }, { ...input, apiKey: 'x'.repeat(257) },
    { ...input, apiKey: 123 }, { ...input, relayOrigin: 'http://test-relay.workers.dev' },
    { ...input, relayOrigin: 'https://test-relay.workers.dev/auth/smartapi/callback' },
    { ...input, relayOrigin: 'https://test-relay.workers.dev:8443' },
    { ...input, relayOrigin: 'https://private:secret@test-relay.workers.dev' },
    { ...input, path: '../other.env' }, { ...input, relayOrigin: 'https://test.example?key=secret' }
  ];
  for (const value of invalid) {
    assert.throws(() => f.file.save(value), error => {
      assert.equal(error.status, 400);
      assert.doesNotMatch(error.message, /synthetic|INJECTED|private:secret/);
      return true;
    });
    assert.equal(readFileSync(f.path, 'utf8'), 'PORT=3100\n# unchanged\n');
  }
  assert.deepEqual(readdirSync(f.directory), ['.env']);
});

test('symlinks, hardlinks, directories and oversized files are refused without modifying their targets', t => {
  const f = fixture(t);
  const target = join(f.directory, 'target');
  writeFileSync(target, 'private original');
  for (const name of ['symlink', 'hardlink', 'directory', 'large']) {
    const path = join(f.directory, name);
    if (name === 'symlink') symlinkSync(target, path);
    if (name === 'hardlink') linkSync(target, path);
    if (name === 'directory') mkdirSync(path);
    if (name === 'large') writeFileSync(path, 'x'.repeat(65537));
    assert.throws(() => new EnvFile(path).save(input), error => error.code === 'SMARTAPI_CONFIG_FILE');
    assert.equal(readFileSync(target, 'utf8'), 'private original');
  }
  assert.ok(readdirSync(f.directory).every(name => !name.endsWith('.tmp')));
});

test('local API requires canonical same-origin CSRF protection, stores only .env and activates settings only after restart', async t => {
  const f = fixture(t);
  const store = new Store(':memory:');
  const smartapi = new SmartAPI();
  const broker = new AngelOne(smartapi);
  const { server } = createApp(store, broker, { smartapi, configFile: f.file });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.smartapiConfigWritable, true);
  const post = headers => fetch(`${base}/api/smartapi/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Tradegrok-CSRF': state.csrf, ...headers },
    body: JSON.stringify(input)
  });
  for (const headers of [
    { 'X-Tradegrok-CSRF': '' }, { Origin: 'https://evil.example' },
    { 'Sec-Fetch-Site': 'cross-site' }, { Origin: `http://localhost:${server.address().port}` }
  ]) assert.equal((await post(headers)).status, 403);
  assert.deepEqual(readdirSync(f.directory), []);
  const saved = await post({});
  assert.equal(saved.status, 200);
  assert.match(saved.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await saved.json(), { saved: true, restartRequired: true });
  assert.equal(smartapi.apiKey, '');
  const after = await (await fetch(`${base}/api/state`)).json();
  assert.equal(after.smartapi.configured, false);
  assert.equal(after.account, null);
  assert.equal(after.orders.length, 0);
  assert.doesNotMatch(JSON.stringify(after), /synthetic-test-key/);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/api/smartapi/config`)).status, 404);
  const parsed = parseEnv(readFileSync(f.path, 'utf8'));
  assert.equal(parsed.PORT, String(server.address().port));
  const restarted = new SmartAPI({ apiKey: parsed.SMARTAPI_API_KEY });
  assert.equal(restarted.status(`${parsed.SMARTAPI_RELAY_ORIGIN}/auth/smartapi/callback`).configured, true);
});
