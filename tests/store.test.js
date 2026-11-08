import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, instruments, presets } from '../server/store.js';

test('new workspaces have only SmartAPI prices and no invented instrument or entry levels', () => {
  const store = new Store(':memory:');
  try {
    assert.equal(store.settings().mode, 'angel');
    assert.equal(store.settings().cash, store.settings().initialCash);
    assert.equal(store.bots()[0].level, null);
    assert.ok(instruments.every(item => !Object.hasOwn(item, 'base')));
    assert.ok(presets.filter(item => item.id !== 'sma').every(item => item.defaults.level === null));
  } finally { store.close(); }
});
test('valuation quotes persist across database reopen and never regress to older timestamps', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tradegrok-valuation-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'test.sqlite');
  let store = new Store(path);
  const quote = { symbol: 'RELIANCE', source: 'angel', price: 1400, at: '2026-11-09T09:59:00+05:30' };
  store.saveValuationQuote(quote);
  store.saveValuationQuote({ ...quote, price: 1300, at: '2026-11-09T09:58:00+05:30' });
  store.close();
  store = new Store(path);
  try { assert.deepEqual(store.valuationQuotes(), [quote]); }
  finally { store.close(); }
});

test('bin membership and associated paper history survive restart', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tradegrok-bin-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'test.sqlite');
  let store = new Store(path);
  const bot = store.bots()[0];
  store.order({ id: 'saved-order', botId: bot.id, source: 'angel', side: 'SELL', pnl: -10 });
  store.saveBot({ ...bot, deletedAt: '2026-11-09T04:30:00Z', revision: 1 });
  store.close();
  store = new Store(path);
  t.after(() => store.close());
  assert.deepEqual(store.bots(), []);
  assert.equal(store.bot(bot.id), null);
  assert.equal(store.deletedBots()[0].id, bot.id);
  assert.equal(store.bot(bot.id, true).revision, 1);
  assert.equal(store.orders()[0].botId, bot.id);
  assert.equal(store.orders()[0].pnl, -10);
});

test('migration archives retired feed history and resets its gains without rewriting real-price paper trades', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tradegrok-migration-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'test.sqlite');
  let store = new Store(path);
  const settings = store.settings(), first = store.bots()[0];
  store.saveSettings({ ...settings, mode: 'demo', priceSourceVersion: undefined, demoTick: 123, cash: 99707, emergency: true });
  store.saveBot({ ...first, level: 1400, status: 'running', samples: [100, 110], previous: 110, position: { source: 'demo', qty: 1, entry: 100 }, lastEntryDay: '2026-11-09' });
  const second = { ...first, id: 'actual', preset: 'sma', level: 0, status: 'running', position: { source: 'angel', qty: 1, entry: 200 } };
  store.saveBot(second);
  const at = '2026-11-09T10:00:00+05:30';
  store.order({ id: 'retired', botId: first.id, side: 'BUY', qty: 1, price: 100, fee: 1, source: 'demo', at });
  store.order({ id: 'actual', botId: second.id, side: 'BUY', qty: 1, price: 200, fee: 1, source: 'angel', at });
  store.equityPoint({ source: 'demo', value: 100500, at });
  store.equityPoint({ source: 'angel', value: 99900, at });
  store.event('info', 'Old synthetic feed activity.');
  store.close();

  store = new Store(path);
  assert.equal(store.settings().mode, 'angel');
  assert.equal(store.settings().cash, 99799);
  assert.equal(store.settings().emergency, true);
  assert.ok(!Object.hasOwn(store.settings(), 'demoTick'));
  assert.equal(store.orders().length, 1);
  assert.equal(store.orders()[0].source, 'angel');
  assert.equal(store.equity().length, 1);
  assert.equal(store.bot(first.id).position, null);
  assert.equal(store.bot(first.id).lastEntryDay, null);
  assert.deepEqual(store.bot(first.id).samples, []);
  assert.equal(store.bot(second.id).position.entry, 200);
  assert.equal(store.bot(second.id).lastEntryDay, '2026-11-09');
  assert.ok(store.bots().every(bot => bot.status === 'paused'));
  assert.ok(store.events().every(event => !event.message.includes('synthetic')));
  const archived = store.db.prepare('SELECT kind, body FROM retired_data').all();
  assert.ok(archived.some(row => row.kind === 'orders' && JSON.parse(row.body).id === 'retired'));
  assert.ok(archived.some(row => row.kind === 'bot'));
  const cash = store.settings().cash;
  store.close();
  store = new Store(path);
  assert.equal(store.settings().cash, cash);
  assert.equal(store.orders().length, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM retired_data').get().n, archived.length);
  store.close();
});
