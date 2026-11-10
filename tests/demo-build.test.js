import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { entryPresets, exitPresets } from '../demo/engine.js';

test('static build is an allowlist, subpath safe, and has no backend/session artifacts', async () => {
  execFileSync(process.execPath, ['scripts/build-demo.js'], { env: { ...process.env, DEMO_GA_MEASUREMENT_ID: '' }, stdio: 'pipe' });
  async function files(directory) {
    const output = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) output.push(...entry.isDirectory() ? await files(join(directory, entry.name)) : [join(directory, entry.name)]);
    return output;
  }
  const published = await files('dist-demo');
  assert.equal(published.length, 18);
  assert.ok(published.every(path => !/server|private|session|\.env|sqlite|TEST-FIXTURE/.test(path)));
  const index = await readFile('dist-demo/index.html', 'utf8');
  assert.doesNotMatch(index, /(?:src|href)="\//);
  assert.match(index, /class="skip-link" href="#main"/);
  assert.match(index, /TradeGrok#quick-start/);
  assert.match(index, /href="\.\/rulebook\.html" target="_blank" rel="noopener noreferrer"/);
  assert.match(index, /href="\.\/rulebook\.html#custom-rules"/);
  const rulebook = await readFile('dist-demo/rulebook.html', 'utf8');
  assert.doesNotMatch(rulebook, /(?:src|href)="\/|demo\/app\.js|\/api\//);
  for (const [kind, presets] of [['entry', entryPresets], ['exit', exitPresets]]) {
    for (const [key, name] of Object.entries(presets)) {
      const article = rulebook.match(new RegExp(`<article id="${kind}-${key}">([\\s\\S]*?)</article>`));
      assert.ok(article?.[1].includes(`<h3>${name}</h3>`), `Rulebook must define ${kind} preset ${key}`);
    }
  }
  const ids = [...rulebook.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const [, target] of rulebook.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(target), `Missing rulebook anchor ${target}`);
  assert.match(rulebook, /Close &gt; SMA\(20\) AND \(RSI\(14\) crosses above 30 OR Volume &gt; 50000\)/);
  assert.doesNotMatch(index, /class="sidebar"|data-page=|id="entry-lock"|id="results-dialog"/);
  assert.doesNotMatch(await readFile('dist-demo/styles.css', 'utf8'), /url\("\/fonts/);
  assert.doesNotMatch(await readFile('dist-demo/demo/app.js', 'utf8'), /\/api\/|smartapi\/login/);
  assert.match(await readFile('dist-demo/demo/config.js', 'utf8'), /"enabled":false/);
  assert.throws(() => execFileSync(process.execPath, ['scripts/build-demo.js'], { env: { ...process.env, DEMO_GA_MEASUREMENT_ID: 'G-TEST123', DEMO_GA_DEPLOYMENT_REVIEWED: '' }, stdio: 'pipe' }), /Command failed/);
});
