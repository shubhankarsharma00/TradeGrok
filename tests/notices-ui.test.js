import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

function fixture() {
  const notices = [], listeners = {};
  const nodes = {
    '#main': { innerHTML: '' }, '#page-label': {}, '#clock': {},
    '#bot-form': { addEventListener() {} }
  };
  const context = createContext({
    document: {
      querySelector: selector => nodes[selector],
      querySelectorAll: selector => selector === 'details[data-notice-id]' ? notices : [],
      addEventListener: (event, callback) => { (listeners[event] ??= []).push(callback); }
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
  return {
    context, notices, nodes, run: code => runInContext(code, context),
    dismiss(id) {
      let removed = false, focused = false;
      const notice = { remove() { removed = true; }, nextElementSibling: { querySelector: () => ({ focus() { focused = true; } }) } };
      const button = { dataset: { dismissNotice: id }, closest: () => notice };
      listeners.click[0]({ target: { closest: () => button } });
      return { removed, focused };
    }
  };
}

test('requested trade notices have dismissal buttons instead of collapsible disclosures', () => {
  const f = fixture();
  const html = f.run('banners()');
  assert.equal((html.match(/data-removable-notice=/g) ?? []).length, 3);
  assert.equal((html.match(/data-dismiss-notice=/g) ?? []).length, 3);
  assert.doesNotMatch(html, /<details|<summary/);
  assert.match(html, />NSE:DIVISLAB Muhurat paper window closed\.<\/strong>/);
  assert.match(html, /14:20-15:15 IST \(conservative CAS cutoff\)\. No auction\/post-close fills\./);
  assert.match(html, /No automatic liquidation at close; existing exit rules remain unchanged\./);
  assert.match(html, />Equity and unrealised P&amp;L use last known SmartAPI prices\.<\/strong>/);
  assert.match(html, /These are not live values\. No fills on stale prices\./);
  assert.doesNotMatch(html, /RELIANCE/);
  assert.match(f.run('botsPage()'), /data-notice-id="paper-data"><summary><span class="pill mint">SMARTAPI MARKET DATA/);
  assert.match(f.run('botsPage()'), /data-removable-notice="bot-bin-help"/);
  assert.match(f.run('botsPage()'), /Bot bin \(0\)/);
  const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(index, /data-page="backtest" class="nav-item"/);
  assert.doesNotMatch(index, /data-section="bot-bin" class="nav-item"/);
});

test('missing saved quotes keep their distinct unavailable notice removable', () => {
  const f = fixture();
  f.context.snapshot.metrics.unavailablePositions = 1;
  const html = f.run('banners()');
  assert.match(html, /data-removable-notice="stale-positions"/);
  assert.match(html, />Some open positions have no saved valid SmartAPI quote\.<\/strong>/);
  assert.match(html, /Equity and unrealised P&amp;L are unavailable until prices are received\. No fills on stale prices\./);
  assert.doesNotMatch(html, /use last known SmartAPI prices/);
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

test('remaining collapsible notices preserve expansion independently of removable notices', () => {
  const f = fixture();
  f.context.snapshot.settings.emergency = true;
  f.run('page = "bots"; renderPage()');
  f.notices.push(
    { dataset: { noticeId: 'paper-data' }, open: true },
    { dataset: { noticeId: 'entry-lock' }, open: false }
  );
  f.run('renderPage()');
  assert.match(f.nodes['#main'].innerHTML, /data-notice-id="paper-data" open>/);
  assert.match(f.nodes['#main'].innerHTML, /data-notice-id="entry-lock"><summary>/);
  assert.match(f.nodes['#main'].innerHTML, /data-removable-notice="stale-positions"/);
  f.run('page = "orders"; renderPage()');
  assert.match(f.nodes['#main'].innerHTML, /data-removable-notice="market-window:DIVISLAB"/);
  f.notices.length = 0;
  f.run('page = "orders"; renderPage()');
  assert.match(f.nodes['#main'].innerHTML, /data-notice-id="entry-lock"><summary>/);
});

test('changed errors reopen and changed market windows reset without losing other selections', () => {
  const f = fixture();
  f.context.snapshot.engine.error = 'First error';
  f.run('renderPage()');
  f.notices.push(
    { dataset: { noticeId: 'market-data' }, open: false }
  );
  f.dismiss('market-window:DIVISLAB');
  f.dismiss('stale-positions');
  f.context.snapshot.engine.error = 'New error';
  f.context.snapshot.engine.marketWindows[0].open = true;
  f.run('renderPage()');
  const html = f.nodes['#main'].innerHTML;
  assert.match(html, /data-notice-id="market-data" open>/);
  assert.match(html, /data-removable-notice="market-window:DIVISLAB"/);
  assert.match(html, /NSE:DIVISLAB Muhurat paper window open/);
  assert.doesNotMatch(html, /data-removable-notice="stale-positions"/);
  f.context.snapshot.settings.emergency = false;
  f.context.snapshot.engine.error = null;
  f.context.snapshot.engine.marketWindows = [];
  f.context.snapshot.metrics.stalePositions = 0;
  assert.equal(f.run('banners()').trim(), '');
});

test('dismissal removes only its notice and survives refresh/navigation without changing bot state', () => {
  const f = fixture();
  f.run('page = "bots"; renderPage()');
  const before = JSON.stringify(f.context.snapshot);
  assert.deepEqual(f.dismiss('market-window:DIVISLAB'), { removed: true, focused: true });
  f.run('renderPage()');
  assert.doesNotMatch(f.nodes['#main'].innerHTML, /data-removable-notice="market-window:DIVISLAB"/);
  assert.match(f.nodes['#main'].innerHTML, /data-removable-notice="market-window:NIFTYBEES"/);
  f.dismiss('bot-bin-help');
  f.dismiss('stale-positions');
  f.run('page = "orders"; renderPage(); page = "bots"; renderPage()');
  for (const id of ['market-window:DIVISLAB', 'bot-bin-help', 'stale-positions']) {
    assert.equal(f.nodes['#main'].innerHTML.includes(`data-removable-notice="${id}"`), false);
  }
  assert.equal(JSON.stringify(f.context.snapshot), before);
  f.context.snapshot.deletedBots = [{ id: 'removed-bot' }];
  f.run('renderPage()');
  assert.match(f.nodes['#main'].innerHTML, /data-removable-notice="bot-bin-help"/);
  assert.match(f.nodes['#main'].innerHTML, /Bot bin \(1\)/);
  f.context.snapshot.metrics.unavailablePositions = 1;
  f.run('renderPage()');
  assert.match(f.nodes['#main'].innerHTML, /Some open positions have no saved valid SmartAPI quote/);
});
