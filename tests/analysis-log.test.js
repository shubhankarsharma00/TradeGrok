import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { AnalysisLog } from '../server/analysis-log.js';
import { createApp } from '../server/app.js';

const MONDAY = Date.parse('2026-11-09T10:00:00+05:30');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'tradegrok-analysis-'));
  const logs = join(directory, 'logs'), logger = new AnalysisLog(logs);
  const store = new Store(':memory:');
  let now = MONDAY, price = 1500, quoteTime = null, failure = null, connected = true;
  const broker = {
    account: null, status: () => ({ status: connected ? 'connected' : 'login_required' }),
    quote: async symbol => {
      if (failure) throw failure;
      return { symbol, source: 'angel', price, at: new Date(quoteTime ?? now).toISOString(), auth_token: 'fixture-credential', raw: { secret: 'fixture-credential' } };
    }
  };
  const engine = new Engine(store, broker, { now: () => now, analysisLog: logger });
  const bot = store.bots()[0];
  Object.assign(bot, { name: 'Analysis bot', preset: 'dip', level: 1400, status: 'running', revision: 0 });
  store.saveBot(bot);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    directory, logs, logger, store, engine, broker, bot, now: () => now,
    set: values => { now = values.now ?? now; price = values.price ?? price; quoteTime = values.quoteTime ?? null; failure = values.failure ?? null; connected = values.connected ?? connected; },
    records: (day = '2026-11-09') => readFileSync(join(logs, `analysis-${day}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  };
}
test('identical no-action polls append separate private records with real quote and condition values', async t => {
  const f = fixture(t);
  await f.engine.tick(); await f.engine.tick();
  const rows = f.records();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].decision, 'no_action');
  assert.equal(rows[0].quote.latestPrice, 1500);
  assert.equal(rows[0].quote.exchangeAt, new Date(MONDAY).toISOString());
  assert.equal(rows[0].quote.ageMs, 0);
  assert.equal(rows[0].quote.fresh, true);
  assert.equal(rows[0].checks.entrySignal.passed, false);
  assert.equal(rows[0].checks.entrySignal.values.level, 1400);
  assert.equal(rows[0].market.entryWindowOpen, true);
  assert.equal(rows[0].committed, true);
  assert.notEqual(rows[0].cycleId, rows[1].cycleId);
  assert.equal(f.store.events().filter(event => event.message.includes('Watching for your entry rule')).length, 1);
  assert.equal(JSON.stringify(rows).includes('fixture-credential'), false);
  assert.equal(statSync(f.logs).mode & 0o777, 0o700);
  assert.equal(statSync(join(f.logs, 'analysis-2026-11-09.jsonl')).mode & 0o777, 0o600);
});
test('unverified access and weekend/missing prices are recorded on every attempt', async t => {
  const f = fixture(t);
  f.set({ now: Date.parse('2026-11-08T10:00:00+05:30'), connected: false });
  await f.engine.tick(); await f.engine.tick();
  const rows = f.records('2026-11-08');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].decision, 'blocked');
  assert.equal(rows[0].quote.latestPrice, null);
  assert.equal(rows[0].market.entryWindowOpen, false);
  assert.match(rows[0].reason, /login.*verification/);
  assert.equal(f.store.orders().length, 0);
});
test('stale, closed-window, paused and emergency decisions preserve existing gates', async t => {
  const f = fixture(t);
  f.set({ quoteTime: MONDAY - 61000 }); await f.engine.tick();
  let row = f.records().at(-1);
  assert.equal(row.quote.latestPrice, 1500);
  assert.equal(row.quote.ageMs, 61000);
  assert.equal(row.checks.freshQuote.passed, false);
  assert.equal(row.checks.entrySignal, undefined);
  f.set({ now: Date.parse('2026-11-09T16:00:00+05:30') }); await f.engine.tick();
  row = f.records().at(-1);
  assert.match(row.reason, /Outside weekday/);
  assert.equal(row.quote.fresh, true);
  const bot = f.store.bot(f.bot.id); bot.status = 'paused'; bot.message = 'Paused message'; f.store.saveBot(bot);
  await f.engine.tick();
  row = f.records().at(-1);
  assert.match(row.reason, /paused/);
  assert.equal(row.quote.latestPrice, 1500);
  assert.equal(f.store.bot(bot.id).message, 'Paused message');
  bot.status = 'running'; f.store.saveBot(bot);
  f.store.saveSettings({ ...f.store.settings(), emergency: true });
  await f.engine.tick();
  assert.equal(f.records().at(-1).checks.entryLockReleased.passed, false);
  assert.equal(f.store.orders().length, 0);
});
test('buy, hold, target sell and daily re-entry guard have committed paper outcomes', async t => {
  const f = fixture(t);
  f.set({ price: 1390 }); await f.engine.tick();
  let row = f.records().at(-1);
  assert.equal(row.decision, 'buy');
  assert.equal(row.fill.side, 'BUY');
  assert.equal(row.fill.execution, 'paper');
  assert.equal(row.checks.positionSizing.quantity, 7);
  assert.equal(row.fill.price, f.store.orders()[0].price);
  assert.ok(row.checks.positionSizing.riskRemaining > 0);
  await f.engine.tick();
  row = f.records().at(-1);
  assert.equal(row.decision, 'holding');
  assert.equal(row.checks.stopLoss.passed, false);
  assert.equal(row.checks.takeProfit.passed, false);
  f.set({ price: f.store.bot(f.bot.id).position.target + 3 }); await f.engine.tick();
  row = f.records().at(-1);
  assert.equal(row.decision, 'sell');
  assert.equal(row.reason, 'Take profit');
  assert.equal(row.checks.takeProfit.passed, true);
  assert.equal(row.fill.price, f.store.orders()[0].price);
  f.set({ price: 1390 }); await f.engine.tick();
  assert.match(f.records().at(-1).reason, /Daily entry completed/);
});
test('SMA warm-up and risk sizing blocks include the actual numerical checks', async t => {
  const f = fixture(t);
  const bot = f.store.bot(f.bot.id); bot.preset = 'sma'; f.store.saveBot(bot);
  await f.engine.tick();
  const row = f.records().at(-1);
  assert.equal(row.checks.entrySignal.values.sampleCount, 1);
  assert.equal(row.checks.entrySignal.values.samplesRequired, 13);
  assert.equal(row.checks.entrySignal.values.fastAverage, null);
  assert.match(row.reason, /Warming up/);
  bot.preset = 'dip'; f.store.saveBot(bot);
  f.store.saveSettings({ ...f.store.settings(), maxTradeRisk: 1 });
  f.set({ price: 1390 }); await f.engine.tick();
  assert.equal(f.records().at(-1).checks.positionSizing.quantity, 0);
  assert.equal(f.records().at(-1).decision, 'blocked');
});
test('timed exit and paused stop exit logs record their triggering rule', async t => {
  const f = fixture(t);
  const bot = f.store.bot(f.bot.id);
  Object.assign(bot, { exitPreset: 'scheduled', exitSessions: 1, exitTime: '10:30' }); f.store.saveBot(bot);
  f.set({ price: 1390 }); await f.engine.tick();
  f.set({ now: Date.parse('2026-11-09T10:29:00+05:30') }); await f.engine.tick();
  assert.equal(f.records().at(-1).checks.exitSignal.values.clockReached, false);
  f.set({ now: Date.parse('2026-11-09T10:30:00+05:30') }); await f.engine.tick();
  assert.equal(f.records().at(-1).decision, 'sell');
  assert.equal(f.records().at(-1).checks.exitSignal.values.currentSession, 1);
  const reset = f.store.bot(bot.id); reset.lastEntryDay = null; reset.exitPreset = 'protective'; f.store.saveBot(reset);
  await f.engine.tick();
  const held = f.store.bot(bot.id); held.status = 'paused'; f.store.saveBot(held);
  f.set({ price: held.position.stop - 1 }); await f.engine.tick();
  assert.equal(f.records().at(-1).reason, 'Stop loss');
});
test('rolled-back paper buys are never logged as committed fills', async t => {
  const f = fixture(t);
  f.set({ price: 1390 });
  f.store.equityPoint = () => { throw new Error('fixture-credential'); };
  assert.equal(await f.engine.tick(), false);
  const row = f.records()[0];
  assert.equal(row.decision, 'rolled_back');
  assert.equal(row.proposedDecision, 'buy');
  assert.equal(row.proposedFill.side, 'BUY');
  assert.equal(row.fill, undefined);
  assert.equal(row.committed, false);
  assert.equal(f.store.orders().length, 0);
  assert.equal(f.store.settings().cash, 100000);
  assert.equal(JSON.stringify(row).includes('fixture-credential'), false);
});
test('broker failures block every bot without leaking raw errors or using prior cached prices', async t => {
  const f = fixture(t);
  await f.engine.tick();
  f.store.saveBot({ ...f.bot, id: 'second-bot', symbol: 'ITC' });
  f.set({ failure: new Error('fixture-credential') }); await f.engine.tick();
  const rows = f.records().slice(1);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.decision === 'blocked' && row.quote.latestPrice === null && row.committed === false));
  assert.equal(f.engine.quotes.size, 0);
  assert.equal(JSON.stringify(rows).includes('fixture-credential'), false);
});
test('overlapping cycles and changes during fetch record skips without acting on stale bot state', async t => {
  const f = fixture(t);
  let release;
  f.broker.quote = symbol => new Promise(resolve => { release = () => resolve({ symbol, source: 'angel', price: 1390, at: new Date(MONDAY).toISOString() }); });
  const pending = f.engine.tick();
  assert.equal(await f.engine.tick(), false);
  let row = f.records().at(-1);
  assert.equal(row.event, 'runner_cycle');
  assert.equal(row.decision, 'skipped');
  const changed = f.store.bot(f.bot.id);
  changed.revision++; changed.status = 'paused'; f.store.saveBot(changed);
  release(); await pending;
  row = f.records().at(-1);
  assert.equal(row.event, 'bot_analysis');
  assert.equal(row.decision, 'skipped');
  assert.match(row.reason, /changed during quote fetching/);
  assert.equal(f.store.orders().length, 0);
  const deleted = f.engine.tick();
  f.store.db.prepare('DELETE FROM bots WHERE id = ?').run(f.bot.id);
  release(); await deleted;
  row = f.records().at(-1);
  assert.match(row.reason, /deleted during quote fetching/);
  assert.equal(f.store.bots().length, 0);
});
test('a logging failure is explicit and does not undo or misreport a committed buy', async t => {
  const f = fixture(t);
  f.set({ price: 1390 });
  f.logger.append = () => { throw new Error('fixture-credential'); };
  assert.equal(await f.engine.tick(), false);
  assert.equal(f.store.orders().length, 1);
  assert.ok(f.store.bot(f.bot.id).position);
  assert.match(f.engine.loggingError, /committed paper fills remain/);
  assert.ok(f.store.events().some(event => event.message.includes('Analysis file write failed')));
  assert.equal(f.engine.error, null, 'not falsely presented as a rolled-back execution');
});
test('file append survives a new logger instance and rotates at IST midnight', async t => {
  const f = fixture(t);
  await f.engine.tick();
  f.engine.analysisLog = new AnalysisLog(f.logs); await f.engine.tick();
  f.set({ now: Date.parse('2026-11-09T19:00:00Z') }); await f.engine.tick();
  assert.equal(f.records().length, 2);
  assert.equal(f.records('2026-11-10').length, 1);
  assert.equal(f.records('2026-11-10')[0].atIst, '2026-11-10T00:30:00.000+05:30');
});
test('reader pages newest-first and isolates bots across UTF-8/chunk boundaries without duplicates', async t => {
  const f = fixture(t);
  const records = [];
  for (let i = 0; i < 153; i++) {
    const record = f.engine.analysisRecord(f.bot, null);
    record.sequence = i; record.reason = '₹'.repeat(2000);
    records.push(record, { ...record, bot: { ...record.bot, id: 'other' } });
  }
  f.logger.append(records);
  let before = null, loaded = [];
  do {
    const result = await f.logger.read(f.bot.id, '2026-11-09', before);
    assert.ok(result.records.length <= 50);
    loaded.push(...result.records); before = result.before;
  } while (before !== null);
  assert.deepEqual(loaded.map(row => row.sequence), Array.from({ length: 153 }, (_, i) => 152 - i));
  assert.ok(loaded.every(row => row.reason === '₹'.repeat(2000)));
});
test('bounded scans return a continuation even when this segment has no matching bot', async t => {
  const f = fixture(t);
  const record = f.engine.analysisRecord(f.bot, null);
  f.logger.append([record, ...Array.from({ length: 2400 }, () => ({ ...record, bot: { id: 'other' }, reason: 'x'.repeat(2500) }))]);
  const first = await f.logger.read(f.bot.id, '2026-11-09');
  assert.equal(first.records.length, 0);
  assert.ok(first.before > 0);
  const second = await f.logger.read(f.bot.id, '2026-11-09', first.before);
  assert.equal(second.records.length, 1);
  assert.equal(second.before, null);
});
test('invalid dates/cursors, malformed records and unsafe file links fail explicitly', async t => {
  const f = fixture(t);
  await f.engine.tick();
  for (const day of ['../private/smartapi-session', '2026-02-30', 'bad']) await assert.rejects(f.logger.read(f.bot.id, day), /valid log date/);
  for (const before of [-1, Infinity, 1.5]) await assert.rejects(f.logger.read(f.bot.id, '2026-11-09', before), /cursor/);
  await assert.rejects(f.logger.read(f.bot.id, '2026-11-09', 1), /incomplete/);
  writeFileSync(join(f.logs, 'analysis-2026-11-10.jsonl'), '{broken}\n');
  await assert.rejects(f.logger.read(f.bot.id, '2026-11-10'), /malformed/);
  const secret = join(f.directory, 'private-fixture'); writeFileSync(secret, 'fixture-credential');
  symlinkSync(secret, join(f.logs, 'analysis-2026-11-11.jsonl'));
  await assert.rejects(f.logger.read(f.bot.id, '2026-11-11'), /securely/);
  linkSync(secret, join(f.logs, 'analysis-2026-11-12.jsonl'));
  await assert.rejects(f.logger.read(f.bot.id, '2026-11-12'), /securely/);
  const malicious = f.engine.analysisRecord(f.bot, null); malicious.at = '2026-11-11T10:00:00Z';
  assert.throws(() => f.logger.append([malicious]), /securely/);
  assert.equal(readFileSync(secret, 'utf8'), 'fixture-credential');
  assert.equal((await f.logger.read(f.bot.id, '2026-11-13')).exists, false);
});
test('bot log API and manual closes read/write actual files without exposing private paths', async t => {
  const f = fixture(t);
  const { server, engine } = createApp(f.store, f.broker, { now: f.now, analysisLog: f.logger });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const initial = await (await fetch(`${base}/api/state`)).json();
  assert.equal(initial.engine.analysisLog.enabled, true);
  f.set({ price: 1390 }); await engine.tick();
  const path = `/api/bots/${f.bot.id}/logs`;
  let response = await fetch(`${base}${path}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).records[0].decision, 'buy');
  const post = () => fetch(`${base}/api/bots/${f.bot.id}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tradegrok-CSRF': initial.csrf }, body: '{}' });
  assert.equal((await post()).status, 200);
  response = await fetch(`${base}${path}`);
  let latest = (await response.json()).records[0];
  assert.equal(latest.trigger, 'manual_close');
  assert.equal(latest.decision, 'sell');
  assert.equal(latest.committed, true);
  assert.equal((await post()).status, 409);
  latest = (await (await fetch(`${base}${path}`)).json()).records[0];
  assert.equal(latest.decision, 'blocked');
  assert.equal(latest.checks.hasPosition.passed, false);
  assert.equal((await fetch(`${base}${path}?date=2026-02-30`)).status, 400);
  assert.equal((await fetch(`${base}${path}?before=-1`)).status, 400);
  assert.equal((await fetch(`${base}${path}`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/bots/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/logs`)).status, 404);
  for (const privatePath of ['/data/logs/analysis-2026-11-09.jsonl', '/data/private/smartapi-session.json', '/.env']) assert.equal((await fetch(`${base}${privatePath}`)).status, 404);
});
