import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const presets = [
  { id: 'breakout', name: 'Price breakout', description: 'Buy when a sampled price crosses above your configured level. One entry per bot per IST day.', defaults: { level: null, stopPct: 1, targetPct: 2 } },
  { id: 'dip', name: 'Buy the dip', description: 'Buy at or below your configured level. One entry per bot per IST day.', defaults: { level: null, stopPct: 1, targetPct: 2 } },
  { id: 'sma', name: 'Moving-average cross', description: 'Buy when the 5-sample average crosses above the 12-sample average. Samples are polling observations, not exchange candles.', defaults: { level: 0, stopPct: 1, targetPct: 2 } },
  {
    id: 'swing', name: 'Swing breakout',
    description: 'For a stock you have checked is in a daily-chart uptrend, enter its resistance level manually. Buy on a sampled cross above it; choose an independent exit strategy alongside stop and target protection. Defaults: 3% stop / 6% target; minimum 2:1 reward/risk. Review daily volatility and upcoming earnings first. No automatic chart, ATR or earnings checks; overnight gaps can exceed stop risk, and monitoring requires the server running.',
    defaults: { level: null, stopPct: 3, targetPct: 6 }, minRewardRisk: 2,
    sources: [
      { name: 'Schwab: swing trading', url: 'https://www.schwab.com/learn/story/swing-trading-strategies' },
      { name: 'Fidelity: volatility and ATR stops', url: 'https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/atr' }
    ]
  }
];
export const exitPresets = [
  { id: 'protective', name: 'Stop loss / take profit', description: 'Exit at the stop or target, or close manually. Same-day exits allowed. No automatic timed exit.' },
  { id: 'sma', name: 'Moving-average reversal', description: 'Exit when the 5-sample average is below the 12-sample average. Needs 12 polling samples collected while holding, across sessions. Same-day exits allowed; stop and target always active.' },
  { id: 'support', name: 'Support breakdown', description: 'Exit at or below your manually configured support level. Same-day exits allowed; stop and target always active.' },
  { id: 'max-hold', name: 'Maximum holding period', description: 'Exit by the selected IST time on the Nth regular trading session, regardless of profit. Entry day is session 1. Stop and target always active.', defaults: { exitSessions: 5, exitTime: '15:00' } },
  { id: 'scheduled', name: 'Scheduled exit', description: 'Exit at the selected IST time on the selected regular trading session. Choose session 1 for a same-day exit. Stop and target always active.', defaults: { exitSessions: 3, exitTime: '15:00' } },
  { id: 'time-performance', name: 'Time + performance', description: 'At the first eligible quote on or after the deadline, exit if the price gain from the paper entry is below your minimum. Otherwise keep holding with stop and target protection; the performance check runs once per position.', defaults: { exitSessions: 3, exitTime: '15:00', exitMinGainPct: 1 } }
];
export const instruments = [
  { symbol: 'RELIANCE', name: 'Reliance Industries' },
  { symbol: 'TCS', name: 'Tata Consultancy Services' },
  { symbol: 'INFY', name: 'Infosys' },
  { symbol: 'HDFCBANK', name: 'HDFC Bank' },
  { symbol: 'ITC', name: 'ITC' },
  { symbol: 'SBIN', name: 'State Bank of India' }
];
export const isNseSymbol = symbol => typeof symbol === 'string' && /^[A-Z0-9][A-Z0-9&._-]{0,39}$/.test(symbol);

export class Store {
  constructor(path) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS equity (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS backtests (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS retired_data (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
    `);
    if (!this.db.prepare('SELECT id FROM settings').get()) {
      this.saveSettings({ mode: 'angel', priceSourceVersion: 1, initialCash: 100000, cash: 100000, maxTradeRisk: 500, dailyLossLimit: 2000, maxDailyTrades: 10, maxPosition: 25000, emergency: false });
      this.saveBot({
        id: randomUUID(), name: 'Reliance breakout', symbol: 'RELIANCE', preset: 'breakout',
        level: null, stopPct: 1, targetPct: 2, budget: 10000, status: 'paused',
        holdingMode: 'flexible', exitPreset: 'protective', exitLevel: 0, exitSamples: [],
        position: null, samples: [], previous: null, lastEntryDay: null, message: 'Ready when you are. Paper execution only.', createdAt: new Date().toISOString()
      });
      this.event('info', 'Workspace created. SmartAPI is the only market-data source. Login and configure your paper bot before starting.');
    }
    if (this.settings().priceSourceVersion !== 1) this.migratePriceSource();
    const legacyBots = this.bots().filter(bot => bot.holdingMode !== 'flexible' || bot.exitPreset === undefined);
    if (legacyBots.length) this.transaction(() => {
      for (const bot of legacyBots) this.saveBot({
        ...bot, holdingMode: 'flexible', exitPreset: bot.exitPreset ?? 'protective',
        exitLevel: bot.exitLevel ?? 0, exitSamples: bot.exitSamples ?? []
      });
      this.event('info', 'Same-day paper exits enabled. Open positions, entry configurations and daily entry guards preserved.');
    });
  }
  migratePriceSource() {
    this.transaction(() => {
      const settings = this.settings();
      const archive = this.db.prepare('INSERT OR REPLACE INTO retired_data VALUES (?, ?, ?)');
      archive.run('settings', 'before-smartapi-only', JSON.stringify(settings));
      let removed = settings.mode !== 'angel';
      for (const table of ['orders', 'equity']) {
        for (const row of this.db.prepare(`SELECT id, body FROM ${table}`).all()) {
          if (JSON.parse(row.body).source === 'angel') continue;
          archive.run(table, String(row.id), row.body);
          this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(row.id);
          removed = true;
        }
      }
      const orders = this.orders();
      for (const bot of this.bots()) {
        if (bot.position && bot.position.source !== 'angel') {
          archive.run('bot', bot.id, JSON.stringify(bot));
          bot.position = null;
          removed = true;
        }
        bot.samples = []; bot.previous = null; bot.sampleDay = null;
        const lastEntry = orders.find(order => order.botId === bot.id && order.side === 'BUY');
        bot.lastEntryDay = lastEntry ? new Date(Date.parse(lastEntry.at) + 19800000).toISOString().slice(0, 10) : null;
        bot.status = 'paused';
        bot.revision = (bot.revision ?? 0) + 1;
        bot.message = 'SmartAPI-only prices. Verify Angel One and start this paper bot explicitly.';
        this.saveBot(bot);
      }
      if (removed) {
        for (const row of this.db.prepare('SELECT id, body FROM events').all()) archive.run('events', String(row.id), row.body);
        this.db.exec('DELETE FROM events');
      }
      const cash = orders.reduce((balance, order) => balance + (order.side === 'BUY' ? -order.price * order.qty - order.fee : order.price * order.qty - order.fee), settings.initialCash);
      if (!Number.isFinite(cash) || cash < 0) throw new Error('SmartAPI-only migration could not reconstruct paper cash from the retained journal.');
      this.saveSettings({
        mode: 'angel', priceSourceVersion: 1, initialCash: settings.initialCash,
        cash: Math.round((cash + Number.EPSILON) * 100) / 100,
        maxTradeRisk: settings.maxTradeRisk, dailyLossLimit: settings.dailyLossLimit,
        maxDailyTrades: settings.maxDailyTrades, maxPosition: settings.maxPosition, emergency: settings.emergency
      });
      this.event('info', 'SmartAPI-only market data enabled. Retired feed history archived outside the active portfolio; paper cash rebuilt from retained SmartAPI-priced fills. Bots paused.');
    });
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  settings() { return JSON.parse(this.db.prepare('SELECT body FROM settings WHERE id=1').get().body); }
  saveSettings(value) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES (1, ?)').run(JSON.stringify(value)); }
  bots() { return this.db.prepare('SELECT body FROM bots ORDER BY rowid').all().map(row => JSON.parse(row.body)).filter(bot => !bot.deletedAt); }
  deletedBots() { return this.db.prepare('SELECT body FROM bots ORDER BY rowid DESC').all().map(row => JSON.parse(row.body)).filter(bot => bot.deletedAt); }
  bot(id, includeDeleted = false) {
    const row = this.db.prepare('SELECT body FROM bots WHERE id=?').get(id);
    const bot = row ? JSON.parse(row.body) : null;
    return bot && (!bot.deletedAt || includeDeleted) ? bot : null;
  }
  saveBot(bot) { this.db.prepare('INSERT OR REPLACE INTO bots VALUES (?, ?)').run(bot.id, JSON.stringify(bot)); }
  orders() { return this.db.prepare('SELECT body FROM orders ORDER BY rowid DESC').all().map(row => JSON.parse(row.body)); }
  order(value) { this.db.prepare('INSERT INTO orders VALUES (?, ?, ?)').run(value.id, value.botId, JSON.stringify(value)); }
  event(level, message, botId = null, at = new Date().toISOString()) {
    this.db.prepare('INSERT INTO events (body) VALUES (?)').run(JSON.stringify({ level, message, botId, at }));
    this.db.exec('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 300)');
  }
  events() { return this.db.prepare('SELECT body FROM events ORDER BY id DESC LIMIT 50').all().map(row => JSON.parse(row.body)); }
  equityPoint(point) {
    this.db.prepare('INSERT INTO equity (body) VALUES (?)').run(JSON.stringify(point));
    this.db.exec('DELETE FROM equity WHERE id NOT IN (SELECT id FROM equity ORDER BY id DESC LIMIT 240)');
  }
  equity() { return this.db.prepare('SELECT body FROM equity ORDER BY id').all().map(row => JSON.parse(row.body)); }
  saveBacktest(run) { this.db.prepare('INSERT INTO backtests VALUES (?, ?)').run(run.id, JSON.stringify(run)); }
  latestBacktest() {
    const row = this.db.prepare('SELECT body FROM backtests ORDER BY rowid DESC LIMIT 1').get();
    return row ? JSON.parse(row.body) : null;
  }
  close() { this.db.close(); }
}
