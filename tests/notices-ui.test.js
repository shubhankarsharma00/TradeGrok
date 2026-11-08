import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

function fixture() {
  const notices = [];
  const nodes = {
    '#main': { innerHTML: '' }, '#page-label': {}, '#clock': {},
    '#bot-form': { addEventListener() {} }
  };
  const context = createContext({
    document: {
      querySelector: selector => nodes[selector],
      querySelectorAll: selector => selector === 'details[data-notice-id]' ? notices : [],
      addEventListener() {}
    },
    location: { search: '' }, URLSearchParams,
    setInterval() {}, setTimeout() {}, clearTimeout() {},
    fetch: () => new Promise(() => {})
  });
  runInContext(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  context.snapshot = {
    settings: { emergency: false }, engine: { marketWindows: [
      { symbol: 'DIVISLAB', specialSession: true, open: false, description: '14:20-15:15 IST (conservative CAS cutoff). No auction/post-close fills.' },
      { symbol: 'NIFTYBEES', specialSession: true, open: true, description: '14:20-15:30 IST (non-CAS ETF).' },
      { symbol: 'RELIANCE', specialSession: false, open: false }
    ] },
    metrics: { stalePositions: 2 }, orders: [], bots: [], presets: [], exitPresets: [],
    smartapi: { status: 'disconnected' }
  };
  runInContext('state = snapshot; page = "orders"', context);
  return { context, notices, nodes, run: code => runInContext(code, context) };
}

test('routine trade notices use collapsed native disclosures with visible headlines and complete details', () => {
  const f = fixture();
  const html = f.run('banners()');
  assert.equal((html.match(/<details /g) ?? []).length, 3);
  assert.doesNotMatch(html, / open>/);
  assert.match(html, /<summary>NSE:DIVISLAB Muhurat paper window closed\.<\/summary>/);
  assert.match(html, /14:20-15:15 IST \(conservative CAS cutoff\)\. No auction\/post-close fills\./);
  assert.match(html, /No automatic liquidation at close; existing exit rules remain unchanged\./);
  assert.match(html, /<summary>Some open positions have no fresh SmartAPI quote\.<\/summary>/);
  assert.match(html, /Current equity and unrealised P&amp;L are unavailable\. No fills on stale prices\./);
  assert.doesNotMatch(html, /RELIANCE/);
  assert.match(f.run('botsPage()'), /data-notice-id="paper-data"><summary><span class="pill mint">SMARTAPI MARKET DATA/);
});

test('critical notices start expanded and untrusted notice content is escaped', () => {
  const f = fixture();
  f.context.snapshot.settings.emergency = true;
  f.context.snapshot.engine.error = '<script>bad</script>';
  f.context.snapshot.engine.analysisLog = { error: '<img src=x>' };
  f.context.snapshot.engine.marketWindows[0].symbol = 'M&M';
  const html = f.run('banners()');
  assert.match(html, /data-notice-id="entry-lock" open>/);
  assert.match(html, /data-notice-id="market-data" open>/);
  assert.match(html, /data-notice-id="analysis-log" open>.*role="alert"/s);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /NSE:M&amp;M/);
  assert.doesNotMatch(html, /<script>|<img /);
});

test('expanded and collapsed selections survive rerenders and navigation independently', () => {
  const f = fixture();
  f.context.snapshot.settings.emergency = true;
  f.run('renderPage()');
  f.notices.push(
    { dataset: { noticeId: 'market-window:DIVISLAB' }, open: true },
    { dataset: { noticeId: 'entry-lock' }, open: false }
  );
  f.run('renderPage()');
  assert.match(f.nodes['#main'].innerHTML, /data-notice-id="market-window:DIVISLAB" open>/);
  assert.match(f.nodes['#main'].innerHTML, /data-notice-id="entry-lock"><summary>/);
  assert.match(f.nodes['#main'].innerHTML, /data-notice-id="stale-positions"><summary>/);
  f.run('page = "bots"; renderPage()');
  assert.match(f.nodes['#main'].innerHTML, /data-notice-id="market-window:DIVISLAB" open>/);
  f.notices.length = 0;
  f.run('page = "orders"; renderPage()');
  assert.match(f.nodes['#main'].innerHTML, /data-notice-id="entry-lock"><summary>/);
});

test('changed errors reopen and changed market windows reset without losing other selections', () => {
  const f = fixture();
  f.context.snapshot.engine.error = 'First error';
  f.run('renderPage()');
  f.notices.push(
    { dataset: { noticeId: 'market-data' }, open: false },
    { dataset: { noticeId: 'market-window:DIVISLAB' }, open: true },
    { dataset: { noticeId: 'stale-positions' }, open: true }
  );
  f.context.snapshot.engine.error = 'New error';
  f.context.snapshot.engine.marketWindows[0].open = true;
  f.run('renderPage()');
  const html = f.nodes['#main'].innerHTML;
  assert.match(html, /data-notice-id="market-data" open>/);
  assert.match(html, /data-notice-id="market-window:DIVISLAB"><summary>NSE:DIVISLAB Muhurat paper window open/);
  assert.match(html, /data-notice-id="stale-positions" open>/);
  f.context.snapshot.settings.emergency = false;
  f.context.snapshot.engine.error = null;
  f.context.snapshot.engine.marketWindows = [];
  f.context.snapshot.metrics.stalePositions = 0;
  assert.equal(f.run('banners()').trim(), '');
});
