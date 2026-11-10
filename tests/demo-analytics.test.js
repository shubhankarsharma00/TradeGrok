import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('GA4 sends only allowlisted generic payloads and excludes localhost', async () => {
  const source = (await readFile(new URL('../demo/analytics.js', import.meta.url), 'utf8'))
    .replace("import { analyticsConfig } from './config.js';", "const analyticsConfig = { enabled: true, measurementId: 'G-TEST123' };");
  const original = { window: globalThis.window, document: globalThis.document, location: globalThis.location };
  const scripts = [];
  globalThis.window = {};
  globalThis.document = { createElement: () => ({}), head: { append: script => scripts.push(script) } };
  globalThis.location = { hostname: 'demo.example.com', origin: 'https://demo.example.com' };
  try {
    const { track } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    track('page_view', 'backtest');
    track('backtest_completed', 'secret ticker/strategy');
    track('page_view', 'private-file.csv');
    track('secret_strategy_name');
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].referrerPolicy, 'no-referrer');
    const entries = window.dataLayer.map(args => [...args]);
    assert.equal(entries.length, 4);
    assert.equal(entries[1][2].send_page_view, false);
    assert.equal(entries[1][2].allow_google_signals, false);
    assert.equal(entries[2][2].page_location, 'https://demo.example.com/demo/backtest');
    assert.equal(entries[2][2].page_referrer, '');
    assert.doesNotMatch(JSON.stringify(entries), /secret|private-file|ticker/);
    globalThis.location.hostname = 'localhost';
    track('page_view', 'overview');
    assert.equal(window.dataLayer.length, 4);
  } finally { Object.assign(globalThis, original); }
});
