import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleManifest, sessionFor, atMinute, candlesCsv, checksum } from '../demo/data.js';

const script = fileURLToPath(new URL('../scripts/serve-demo.js', import.meta.url));
const env = { ...process.env, DEMO_PORT: '0', DEMO_BASE_PATH: '/TradeGrok/' };

async function preview(cwd, privateData = false) {
  const child = spawn(process.execPath, [script, ...(privateData ? ['--private-data'] : [])], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
  };
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Preview startup timed out: ${output}`)), 15000);
      const fail = error => { clearTimeout(timer); reject(error); };
      child.once('error', fail);
      child.once('exit', code => fail(new Error(`Preview exited (${code}): ${output}`)));
      child.stderr.on('data', chunk => { output += chunk; });
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/Static preview: (http:\/\/127\.0\.0\.1:\d+\/TradeGrok\/)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    return { url, stop };
  } catch (error) { await stop(); throw error; }
}

test('private preview serves only validated market assets, without changing the public build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tradegrok-private-preview-'));
  let server;
  try {
    const directory = join(root, 'data/demo-export');
    await mkdir(directory, { recursive: true });
    await mkdir(join(root, 'dist-demo/demo/bundles'), { recursive: true });
    const publicManifest = JSON.stringify({ version: 1, datasets: [] });
    await writeFile(join(root, 'dist-demo/index.html'), '<h1>Synthetic preview fixture</h1>');
    await writeFile(join(root, 'dist-demo/demo/bundles/manifest.json'), publicManifest);
    const bars = [];
    for (let time = Date.parse('2026-08-01'); time <= Date.parse('2026-10-31'); time += 86400000) {
      const day = new Date(time).toISOString().slice(0, 10), session = sessionFor(day);
      if (session) for (let minute = session.open; minute < session.close; minute++) bars.push([atMinute(day, minute), 100, 101, 99, 100, 1000]);
    }
    const text = candlesCsv(bars), sha256 = await checksum(bars);
    const manifest = {
      version: 1,
      datasets: bundleManifest.map(({ symbol, from, through }) => ({
        symbol, from, through, file: `${symbol}.csv`, sha256, count: bars.length, complete: true,
        source: 'Synthetic test fixture', adjustment: 'unadjusted', redistribution: 'NOT_APPROVED',
        internalOnly: 'must not be served'
      }))
    };
    const manifestPath = join(directory, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    await Promise.all(manifest.datasets.map(meta => writeFile(join(directory, meta.file), text)));
    await writeFile(join(directory, 'RELIANCE.metadata.json'), 'private sidecar');

    server = await preview(root);
    assert.equal(await (await fetch(`${server.url}demo/bundles/manifest.json`)).text(), publicManifest);
    assert.equal((await fetch(`${server.url}demo/bundles/RELIANCE.csv`)).status, 404);
    await server.stop();

    server = await preview(root, true);
    assert.equal((await fetch(server.url, { headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://example.com' } })).status, 200);
    const response = await fetch(`${server.url}demo/bundles/manifest.json`);
    const served = await response.json();
    assert.equal(served.localOnly, true);
    assert.equal(served.datasets.length, 10);
    assert.ok(served.datasets.every(meta => meta.redistribution === 'NOT_APPROVED'));
    assert.ok(served.datasets.every(meta => !Object.hasOwn(meta, 'internalOnly')));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const csv = await fetch(`${server.url}demo/bundles/RELIANCE.csv`);
    assert.equal(csv.headers.get('content-type'), 'text/csv');
    assert.equal(await csv.text(), text);
    for (const path of ['demo/bundles/RELIANCE.metadata.json', 'data/demo-export/manifest.json', '.env', '../data/private/smartapi-session.json']) {
      assert.equal((await fetch(new URL(path, server.url))).status, 404);
    }
    assert.equal((await fetch(`${server.url}demo/bundles/RELIANCE.csv`, { headers: { Origin: 'https://example.com' } })).status, 403);
    assert.equal((await fetch(`${server.url}demo/bundles/RELIANCE.csv`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(`${server.url}demo/bundles/RELIANCE.csv`, { method: 'POST' })).status, 404);
    assert.equal(await readFile(join(root, 'dist-demo/demo/bundles/manifest.json'), 'utf8'), publicManifest);
    await assert.rejects(readFile(join(root, 'dist-demo/demo/bundles/RELIANCE.csv')), { code: 'ENOENT' });
    await server.stop();

    manifest.datasets[0].file = '../private/smartapi-session.json';
    await writeFile(manifestPath, JSON.stringify(manifest));
    assert.throws(() => execFileSync(process.execPath, [script, '--private-data'], { cwd: root, env, timeout: 15000, stdio: 'pipe' }), /Invalid private export metadata/);
    manifest.datasets[0].file = 'RELIANCE.csv';
    manifest.datasets[0].sha256 = 'f'.repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest));
    assert.throws(() => execFileSync(process.execPath, [script, '--private-data'], { cwd: root, env, timeout: 15000, stdio: 'pipe' }), /Private export validation failed/);
  } finally { await server?.stop(); await rm(root, { recursive: true, force: true }); }
});
