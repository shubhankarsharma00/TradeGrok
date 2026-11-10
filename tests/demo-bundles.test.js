import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, checksum, coverage, symbols } from '../demo/data.js';

const source = fileURLToPath(new URL('../demo/bundles/', import.meta.url));
const publisher = fileURLToPath(new URL('../scripts/publish-demo-data.js', import.meta.url));

test('all ten public bundles carry synthetic provenance and valid complete candles', async () => {
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  assert.equal(manifest.datasets.length, symbols.length);
  assert.deepEqual(manifest.datasets.map(data => data.symbol).sort(), [...symbols].sort());
  for (const meta of manifest.datasets) {
    assert.equal(meta.synthetic, true);
    assert.match(meta.source, /Synthetic demo data.*not real market history/);
    assert.ok(meta.redistribution && meta.redistribution !== 'NOT_APPROVED');
    const parsed = parseCsv(await readFile(join(source, meta.file), 'utf8'));
    assert.equal(parsed.duplicates, 0);
    assert.equal(parsed.reordered, false);
    assert.equal(parsed.bars.length, meta.count);
    assert.equal(await checksum(parsed.bars), meta.sha256);
    const result = coverage(parsed.bars, meta);
    assert.deepEqual(result.issues, []);
    assert.equal(result.sessions.length, 62);
    assert.equal(result.outside, 62);
  }
});

test('synthetic publisher preserves CSV bytes and validates everything before copying', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tradegrok-bundles-'));
  try {
    assert.throws(() => execFileSync(process.execPath, [publisher, '--synthetic', source], { cwd: directory, stdio: 'pipe' }));
    assert.throws(() => execFileSync(process.execPath, [publisher, '--synthetic', directory, 'Test permission'], { cwd: directory, stdio: 'pipe' }));
    await assert.rejects(access(join(directory, 'demo/bundles')));
    execFileSync(process.execPath, [publisher, '--synthetic', source, 'Test permission'], { cwd: directory, stdio: 'pipe' });
    const manifest = JSON.parse(await readFile(join(directory, 'demo/bundles/manifest.json'), 'utf8'));
    assert.equal(manifest.datasets.length, 10);
    for (const meta of manifest.datasets) {
      assert.equal(meta.synthetic, true);
      assert.equal(meta.redistribution, 'Test permission');
      assert.deepEqual(await readFile(join(directory, 'demo/bundles', meta.file)), await readFile(join(source, meta.file)));
    }
    assert.throws(() => execFileSync(process.execPath, [publisher, ''], { cwd: directory, stdio: 'pipe' }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
