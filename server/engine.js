import { randomUUID } from 'node:crypto';
import { AppError } from './broker.js';
import { isNseSymbol, presets, exitPresets } from './store.js';
import { holdingSession, tradingSession, executionWindow } from './market-calendar.js';

export const money = number => Math.round((number + Number.EPSILON) * 100) / 100;
export function istDay(now) { return new Date(now + 19800000).toISOString().slice(0, 10); }
export function entryWindow(now, symbol) { return executionWindow(now, symbol).open; }
export function validQuote(quote, mode, now) {
  return mode === 'angel' && quote?.source === 'angel' && Number.isFinite(quote.price) && quote.price > 0 &&
    Number.isFinite(Date.parse(quote.at)) && now - Date.parse(quote.at) <= 60000 && now - Date.parse(quote.at) >= -5000;
}
function validValuationQuote(quote, source, symbol, now) {
  return source === 'angel' && quote?.source === 'angel' && (quote.symbol === undefined || quote.symbol === symbol) &&
    Number.isFinite(quote.price) && quote.price > 0 && Number.isFinite(Date.parse(quote.at)) &&
    Date.parse(quote.at) <= now + 5000;
}
function number(value, name, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new AppError(`${name} must be ${integer ? 'a whole number' : 'a number'} between ${min} and ${max}.`);
  }
  return value;
}
export function validateBot(input, settings) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('A bot configuration is required.');
  if (input.execution && input.execution !== 'paper') throw new AppError('Live execution is not available.', 403, 'LIVE_DISABLED');
  if (input.holdingMode !== undefined && !['flexible', 'delivery'].includes(input.holdingMode)) throw new AppError('Choose flexible paper holding; same-day exits are allowed.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 60) throw new AppError('Bot name must contain 1-60 characters.');
  if (!isNseSymbol(input.symbol)) throw new AppError('Choose a valid NSE cash ticker (uppercase, without the exchange prefix or -EQ suffix).');
  const preset = presets.find(item => item.id === input.preset);
  if (!preset) throw new AppError('Choose a supported strategy preset.');
  const exitPreset = input.exitPreset ?? 'protective';
  if (!exitPresets.some(item => item.id === exitPreset)) throw new AppError('Choose a supported exit strategy preset.');
  const timed = ['max-hold', 'scheduled', 'time-performance'].includes(exitPreset);
  if (timed && (typeof input.exitTime !== 'string' || !/^(09:(?:1[5-9]|[2-5]\d)|1[0-4]:[0-5]\d|15:0\d|15:1[0-4])$/.test(input.exitTime))) {
    throw new AppError('Exit time must be HH:MM IST between 09:15 and 15:14, before the earliest supported continuous-session close.');
  }
  const stopPct = number(input.stopPct, 'Stop loss percent', 0.2, 10);
  const targetPct = number(input.targetPct, 'Target percent', 0.2, 30);
  if (targetPct < stopPct) throw new AppError('Target must be at least the stop distance (minimum 1:1 reward/risk).');
  if (targetPct < stopPct * (preset.minRewardRisk ?? 1)) throw new AppError('Swing breakout target must be at least twice the stop distance (minimum 2:1 reward/risk).');
  return {
    name: input.name.trim(), symbol: input.symbol, preset: input.preset,
    holdingMode: 'flexible', exitPreset,
    exitLevel: exitPreset === 'support' ? money(number(input.exitLevel, 'Exit support level', 1, 1000000)) : 0,
    exitSessions: timed ? number(input.exitSessions, 'Exit trading session', 1, 60, true) : 0,
    exitTime: timed ? input.exitTime : '',
    exitMinGainPct: exitPreset === 'time-performance' ? number(input.exitMinGainPct, 'Minimum price gain percent', 0, 30) : 0,
    level: input.preset === 'sma' ? 0 : money(number(input.level, 'Entry level', 1, 1000000)),
    stopPct, targetPct, budget: money(number(input.budget, 'Bot budget', 100, Math.min(settings.initialCash, settings.maxPosition)))
  };
}
export function validateRisk(input, previous) {
  const maxTradeRisk = money(number(input.maxTradeRisk, 'Max trade risk', 1, 10000));
  const dailyLossLimit = money(number(input.dailyLossLimit, 'Daily loss limit', 1, 50000));
  if (dailyLossLimit < maxTradeRisk) throw new AppError('Daily loss limit must be at least max trade risk.');
  return {
    ...previous, maxTradeRisk, dailyLossLimit,
    maxPosition: money(number(input.maxPosition, 'Position cap', 100, previous.initialCash)),
    maxDailyTrades: number(input.maxDailyTrades, 'Daily entry limit', 1, 50, true)
  };
}
const average = values => values.reduce((a, b) => a + b, 0) / values.length;
export function signal(bot, price) {
  if (bot.preset === 'dip') return price <= bot.level;
  if (bot.preset === 'breakout' || bot.preset === 'swing') return bot.previous !== null && bot.previous <= bot.level && price > bot.level;
  if (bot.samples.length < 13) return false;
  const prev = bot.samples.slice(0, -1);
  return average(prev.slice(-5)) <= average(prev.slice(-12)) && average(bot.samples.slice(-5)) > average(bot.samples.slice(-12));
}
export function exitSignal(bot, price) {
  if (bot.exitPreset === 'support') return price <= bot.exitLevel;
  if (bot.exitPreset === 'sma' && (bot.exitSamples ?? []).length >= 12) return average(bot.exitSamples.slice(-5)) < average(bot.exitSamples.slice(-12));
  return false;
}
export function timedExitSignal(bot, quote, now, details = {}) {
  details.sessionsRequired = bot.exitSessions;
  details.timeIst = bot.exitTime;
  details.minimumGainPct = bot.exitMinGainPct ?? null;
  details.performanceAlreadyPassed = Boolean(bot.position.timePerformancePassed);
  if (bot.exitPreset === 'time-performance' && bot.position.timePerformancePassed) return false;
  const openedAt = Date.parse(bot.position.openedAt);
  if (!Number.isFinite(openedAt) || openedAt > now) throw new AppError('Position entry time is invalid. Timed exits cannot establish the deadline; stops and targets remain active.', 409, 'HOLDING_PERIOD');
  const today = istDay(now);
  if (!tradingSession(today)) return false;
  const session = holdingSession(istDay(openedAt), today);
  const deadline = Date.parse(`${today}T${bot.exitTime}:00+05:30`);
  Object.assign(details, {
    currentSession: session, deadlineToday: new Date(deadline).toISOString(),
    sessionsReached: session >= bot.exitSessions, clockReached: session > bot.exitSessions || now >= deadline,
    quoteTimeReached: session > bot.exitSessions || Date.parse(quote.at) >= deadline
  });
  if (session < bot.exitSessions || (session === bot.exitSessions && (now < deadline || Date.parse(quote.at) < deadline))) return false;
  if (bot.exitPreset !== 'time-performance') return true;
  const gain = (quote.price - bot.position.entry) / bot.position.entry * 100;
  details.priceGainPct = gain;
  details.belowMinimumGain = gain < bot.exitMinGainPct;
  if (gain < bot.exitMinGainPct) return true;
  bot.position.timePerformancePassed = true;
  return false;
}
export function metrics(store, quotes, now = Date.now()) {
  const settings = store.settings();
  const bots = store.bots();
  const orders = store.orders();
  let cost = 0, marketValue = 0, unrealised = 0, openRisk = 0;
  let stalePositions = 0, unavailablePositions = 0, valuationAt = null;
  const savedQuotes = new Map(store.valuationQuotes().map(quote => [quote.symbol, quote]));
  for (const bot of bots) {
    if (!bot.position) continue;
    const position = bot.position;
    const quote = [quotes.get(bot.symbol), savedQuotes.get(bot.symbol)]
      .filter(item => validValuationQuote(item, position.source, bot.symbol, now))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    const fresh = validQuote(quote, position.source, now);
    if (!fresh) stalePositions++;
    if (!quote) unavailablePositions++;
    cost += position.entry * position.qty;
    if (quote) {
      marketValue += quote.price * position.qty;
      unrealised += (quote.price - position.entry) * position.qty;
      if (valuationAt === null || Date.parse(quote.at) < Date.parse(valuationAt)) valuationAt = quote.at;
    }
    openRisk += position.maxLoss;
  }
  const today = istDay(now);
  const dayOrders = orders.filter(order => istDay(Date.parse(order.at)) === today);
  const realised = orders.reduce((total, order) => total + (order.pnl ?? 0), 0);
  const dayPnl = dayOrders.reduce((total, order) => total + (order.pnl ?? 0), 0);
  // Entry fees are already deducted from cash; include them in the daily loss gate.
  const dayEntryFees = dayOrders.filter(order => order.side === 'BUY').reduce((total, order) => total + order.fee, 0);
  return {
    cash: settings.cash, invested: money(cost), equity: unavailablePositions ? null : money(settings.cash + marketValue),
    unrealised: unavailablePositions ? null : money(unrealised), realised: money(realised),
    totalPnl: unavailablePositions ? null : money(settings.cash + marketValue - settings.initialCash),
    dayLoss: money(Math.max(0, dayEntryFees - dayPnl)), openRisk: money(openRisk),
    entriesToday: dayOrders.filter(order => order.side === 'BUY').length,
    running: bots.filter(bot => bot.status === 'running').length,
    positions: bots.filter(bot => bot.position).length, stalePositions, unavailablePositions, valuationAt
  };
}

export class Engine {
  constructor(store, broker, { now = () => Date.now(), analysisLog = null } = {}) {
    this.store = store; this.broker = broker; this.now = now;
    this.quotes = new Map(); this.busy = false; this.lastTick = null; this.error = null;
    this.analysisLog = analysisLog; this.loggingError = null;
  }
  analysisRecord(bot, quote, cycleId = null) {
    const now = this.now(), settings = this.store.settings();
    const observed = quote?.source === 'angel';
    const quoteAt = observed ? Date.parse(quote.at) : NaN;
    const openedAt = Date.parse(bot?.position?.openedAt);
    const value = number => Number.isFinite(number) ? number : null;
    return {
      version: 1, event: bot ? 'bot_analysis' : 'runner_cycle', cycleId,
      at: new Date(now).toISOString(), atIst: new Date(now + 19800000).toISOString().replace('Z', '+05:30'),
      bot: bot ? { id: bot.id, name: bot.name, symbol: bot.symbol, status: bot.status, revision: bot.revision ?? 0, entryPreset: bot.preset, exitPreset: bot.exitPreset ?? 'protective' } : null,
      market: { entryWindowOpen: entryWindow(now, bot?.symbol), window: executionWindow(now, bot?.symbol).description, specialSession: executionWindow(now, bot?.symbol).specialSession },
      quote: {
        available: Boolean(observed && Number.isFinite(quote.price) && quote.price > 0),
        latestPrice: observed && quote.price > 0 ? value(quote.price) : null,
        source: observed ? 'angel' : quote ? 'unexpected_source' : null,
        exchangeAt: Number.isFinite(quoteAt) ? new Date(quoteAt).toISOString() : null,
        ageMs: Number.isFinite(quoteAt) ? now - quoteAt : null,
        fresh: validQuote(quote, settings.mode, now)
      },
      configuration: bot ? {
        entryLevel: value(bot.level), stopPct: value(bot.stopPct), targetPct: value(bot.targetPct), budget: value(bot.budget),
        exitLevel: value(bot.exitLevel), exitSessions: value(bot.exitSessions), exitTime: bot.exitTime || null, exitMinGainPct: value(bot.exitMinGainPct)
      } : null,
      position: bot?.position ? {
        qty: value(bot.position.qty), entry: value(bot.position.entry), stop: value(bot.position.stop), target: value(bot.position.target),
        maxLoss: value(bot.position.maxLoss), openedAt: Number.isFinite(openedAt) ? new Date(openedAt).toISOString() : null,
        performancePassed: Boolean(bot.position.timePerformancePassed)
      } : null,
      entryLock: Boolean(settings.emergency), checks: {}, decision: 'pending', reason: null, committed: false
    };
  }
  logAnalysis(records) {
    if (!this.analysisLog) return true;
    try {
      this.analysisLog.append(records);
      this.loggingError = null;
      return true;
    } catch {
      const message = 'Analysis file write failed. Check data/logs permissions and disk space. Any committed paper fills remain in the order journal; this file may be incomplete.';
      console.error(message);
      if (this.loggingError !== message) {
        try { this.store.event('error', message, null, new Date(this.now()).toISOString()); }
        catch { console.error('Analysis log failure could not be persisted to the workspace audit log.'); }
      }
      this.loggingError = message;
      return false;
    }
  }
  async tick() {
    if (this.busy) {
      const record = this.analysisRecord(null, null);
      Object.assign(record, { decision: 'skipped', reason: 'Previous runner cycle is still fetching/evaluating. No overlapping analysis or fills.' });
      this.logAnalysis([record]);
      return false;
    }
    this.busy = true;
    const records = [], cycleId = randomUUID();
    let capturedBots = [], newQuotes = new Map(), committed = false, success = false, failedSymbol = null;
    try {
      const startMode = this.store.settings().mode;
      capturedBots = this.store.bots();
      if (startMode !== 'angel') throw new AppError('SmartAPI is the only supported market-data source.', 409, 'PRICE_SOURCE');
      if (this.broker.status().status !== 'connected') throw new AppError('Login with Angel One and verify read-only access. Market data is unavailable until verified.', 409, 'SMARTAPI_AUTH');
      const symbols = [...new Set(capturedBots.map(bot => bot.symbol))];
      for (const symbol of symbols) {
        failedSymbol = symbol;
        const quote = await this.broker.quote(symbol);
        if (quote?.symbol !== symbol || quote.source !== 'angel') throw new AppError('SmartAPI quote instrument or source mismatch.', 502, 'SMARTAPI_RESPONSE');
        newQuotes.set(symbol, quote);
      }
      failedSymbol = null;
      if (this.store.settings().mode !== startMode) throw new AppError('Market-data configuration changed during quote fetching. Cycle skipped.', 409, 'PRICE_SOURCE');
      this.quotes = newQuotes;
      this.store.transaction(() => {
        for (const original of capturedBots) {
          const bot = this.store.bot(original.id);
          // A start/edit during quote fetching must not act on a previous configuration.
          const record = this.analysisRecord(bot ?? original, newQuotes.get(bot?.symbol ?? original.symbol), cycleId);
          records.push(record);
          if (!bot || bot.revision !== original.revision) {
            record.decision = 'skipped';
            record.reason = bot ? 'Bot configuration/status changed during quote fetching; waiting for the next cycle.' : 'Bot was deleted during quote fetching.';
            continue;
          }
          this.evaluate(bot, record);
        }
        for (const quote of newQuotes.values()) {
          if (validValuationQuote(quote, 'angel', quote.symbol, this.now())) this.store.saveValuationQuote(quote);
        }
        const totals = metrics(this.store, this.quotes, this.now());
        if (totals.equity !== null && !totals.stalePositions) this.store.equityPoint({ at: new Date(this.now()).toISOString(), value: totals.equity, source: 'angel', stale: false });
      });
      committed = true;
      for (const record of records) record.committed = true;
      if (!records.length) {
        const record = this.analysisRecord(null, null, cycleId);
        Object.assign(record, { decision: 'no_action', reason: 'No configured bots. No instrument quotes requested.', committed: true });
        records.push(record);
      }
      this.lastTick = new Date(this.now()).toISOString();
      this.error = null;
      success = true;
    } catch (error) {
      this.quotes.clear();
      const safe = committed ? 'Runner failed after the paper transaction committed. Check the order journal.' : error instanceof AppError ? error.message : 'Strategy runner failed. No further fills were committed in this cycle.';
      if (this.error !== safe) {
        try { this.store.event('error', safe); }
        catch (auditError) { console.error('Runner failure could not be persisted to the audit log:', auditError.name); }
      }
      this.error = safe;
      if (!(error instanceof AppError)) console.error('Strategy runner failed:', error.name);
      const failureReason = error instanceof AppError && error.code === 'SMARTAPI_AUTH'
        ? 'Angel One login and read-only account verification are required. No latest price available; no paper fills committed.'
        : error instanceof AppError ? 'Cycle blocked by a data/configuration error; no paper fills committed.' : 'Runner transaction failed; all proposed paper fills were rolled back.';
      for (const record of records) {
        if (committed) { record.cycleError = 'Failure after database commit; recorded fills remain committed.'; continue; }
        if (record.fill) { record.proposedFill = record.fill; delete record.fill; }
        if (['buy', 'sell'].includes(record.decision)) record.proposedDecision = record.decision;
        Object.assign(record, { decision: 'rolled_back', reason: failureReason, committed: false, errorCode: error instanceof AppError ? error.code : 'INTERNAL' });
      }
      for (const bot of capturedBots.filter(bot => !records.some(record => record.bot?.id === bot.id))) {
        const record = this.analysisRecord(bot, newQuotes.get(bot.symbol), cycleId);
        Object.assign(record, { decision: 'blocked', reason: failureReason, failedSymbol, errorCode: error instanceof AppError ? error.code : 'INTERNAL' });
        records.push(record);
      }
      if (!records.length) {
        const record = this.analysisRecord(null, null, cycleId);
        Object.assign(record, { decision: 'blocked', reason: failureReason, errorCode: error instanceof AppError ? error.code : 'INTERNAL' });
        records.push(record);
      }
    } finally { this.busy = false; }
    const logged = this.logAnalysis(records);
    return success && committed && logged;
  }
  message(bot, message, level = 'info') {
    if (bot.message !== message) this.store.event(level, `${bot.name}: ${message}`, bot.id, new Date(this.now()).toISOString());
    bot.message = message;
    this.store.saveBot(bot);
  }
  finishAnalysis(bot, record, decision, reason, level = 'info') {
    Object.assign(record, { decision, reason });
    this.message(bot, reason, level);
    return record;
  }
  evaluate(bot, record = this.analysisRecord(bot, this.quotes.get(bot.symbol))) {
    const settings = this.store.settings();
    const quote = this.quotes.get(bot.symbol);
    record.checks.freshQuote = { passed: validQuote(quote, settings.mode, this.now()), maximumAgeMs: 60000, maximumFutureMs: 5000 };
    if (!bot.position && bot.status !== 'running') {
      record.checks.entriesRunning = { passed: false };
      Object.assign(record, { decision: 'no_action', reason: 'Bot is paused with no position. Quote observed; no entry signal evaluated.' });
      return record;
    }
    if (!validQuote(quote, settings.mode, this.now())) {
      return this.finishAnalysis(bot, record, 'blocked', 'Waiting for a fresh quote. No simulated fills on stale data.', 'warn');
    }
    const window = executionWindow(this.now(), bot.symbol);
    const quoteWindow = window.specialSession ? executionWindow(Date.parse(quote.at), bot.symbol) : null;
    if (window.specialSession) record.checks.continuousSession = { passed: window.open && quoteWindow.open && quoteWindow.date === window.date, clockOpen: window.open, quoteOpen: quoteWindow.open, closeIst: window.closeIst };
    if (window.specialSession && !record.checks.continuousSession.passed) {
      bot.previous = null; bot.samples = [];
      return this.finishAnalysis(bot, record, 'blocked', `Outside verified continuous trading. ${window.description}`, 'warn');
    }
    if (bot.position) {
      if (bot.position.source !== quote.source) throw new AppError('Position price-source mismatch.', 409);
      record.checks.stopLoss = { passed: quote.price <= bot.position.stop, price: quote.price, threshold: bot.position.stop };
      record.checks.takeProfit = { passed: quote.price >= bot.position.target, price: quote.price, threshold: bot.position.target };
      if (quote.price <= bot.position.stop) this.exit(bot, quote, 'Stop loss', record);
      else if (quote.price >= bot.position.target) this.exit(bot, quote, 'Take profit', record);
      else {
        if (bot.exitPreset === 'sma') bot.exitSamples = [...(bot.exitSamples ?? []), quote.price].slice(-12);
        const eligible = entryWindow(this.now(), bot.symbol);
        record.checks.exitWindow = { passed: eligible };
        const timed = ['max-hold', 'scheduled', 'time-performance'].includes(bot.exitPreset);
        let triggered = false;
        const details = {};
        if (bot.exitPreset === 'sma') Object.assign(details, { sampleCount: bot.exitSamples.length, samplesRequired: 12, fastAverage: bot.exitSamples.length >= 5 ? average(bot.exitSamples.slice(-5)) : null, slowAverage: bot.exitSamples.length >= 12 ? average(bot.exitSamples.slice(-12)) : null });
        if (bot.exitPreset === 'support') Object.assign(details, { price: quote.price, supportLevel: bot.exitLevel });
        record.checks.exitSignal = { evaluated: eligible, passed: null, values: details };
        try { triggered = eligible && (timed ? timedExitSignal(bot, quote, this.now(), details) : exitSignal(bot, quote.price)); }
        catch (error) {
          if (!(error instanceof AppError)) throw error;
          record.checks.exitSignal.errorCode = error.code;
          return this.finishAnalysis(bot, record, 'blocked', error.message, 'warn');
        }
        record.checks.exitSignal.passed = eligible ? triggered : null;
        if (triggered) {
          this.exit(bot, quote, `Exit strategy: ${exitPresets.find(item => item.id === bot.exitPreset).name}`, record);
        } else this.finishAnalysis(bot, record, 'holding', !eligible
          ? `Outside strategy exit window. ${window.description}. Stop and target remain active with fresh quotes.`
          : bot.status === 'paused' || settings.emergency
            ? 'Entries paused; exit strategy, stop and target monitoring remain active.'
            : bot.exitPreset === 'sma' && bot.exitSamples.length < 12
              ? `Exit strategy warming up: ${bot.exitSamples.length}/12 holding samples. Stop and target remain active.`
              : timed
                ? bot.position.timePerformancePassed
                  ? 'Deadline performance check passed. Stop, target and manual close remain active.'
                  : `Waiting for timed exit: session ${bot.exitSessions} at ${bot.exitTime} IST (entry day = session 1). Stop and target remain active.`
                : 'Position open. Same-day exits allowed; monitoring exit strategy, stop and target.');
      }
      return record;
    }
    record.checks.entryLockReleased = { passed: !settings.emergency };
    if (settings.emergency) return this.finishAnalysis(bot, record, 'blocked', 'Emergency entry lock is active.', 'warn');
    record.checks.entryWindow = { passed: entryWindow(this.now(), bot.symbol), description: window.description };
    if (settings.mode === 'angel' && !entryWindow(this.now(), bot.symbol)) {
      bot.previous = null; bot.samples = [];
      return this.finishAnalysis(bot, record, 'no_action', 'Outside weekday entry window (09:15-15:20 IST). Fresh exchange timestamps also required.');
    }
    const day = istDay(this.now());
    if (bot.sampleDay !== day) { bot.samples = []; bot.previous = null; bot.sampleDay = day; }
    bot.samples = [...bot.samples, quote.price].slice(-13);
    const previous = bot.previous;
    const triggered = signal(bot, quote.price);
    bot.previous = quote.price;
    const entryValues = { price: quote.price, previousPrice: previous, level: bot.level, sampleCount: bot.samples.length };
    if (bot.preset === 'sma') {
      const previousSamples = bot.samples.slice(0, -1);
      Object.assign(entryValues, {
        samplesRequired: 13,
        fastAverage: bot.samples.length >= 5 ? average(bot.samples.slice(-5)) : null,
        slowAverage: bot.samples.length >= 12 ? average(bot.samples.slice(-12)) : null,
        previousFastAverage: previousSamples.length >= 5 ? average(previousSamples.slice(-5)) : null,
        previousSlowAverage: previousSamples.length >= 12 ? average(previousSamples.slice(-12)) : null
      });
    }
    record.checks.entrySignal = { passed: triggered, values: entryValues };
    record.checks.botDailyEntry = { passed: bot.lastEntryDay !== day, lastEntryDay: bot.lastEntryDay, currentDay: day };
    if (bot.lastEntryDay === day) return this.finishAnalysis(bot, record, 'no_action', 'Daily entry completed. Waiting for the next IST day.');
    if (!triggered) {
      return this.finishAnalysis(bot, record, 'no_action', bot.preset === 'sma' && bot.samples.length < 13 ? `Warming up: ${bot.samples.length}/13 polling samples.` : 'Watching for your entry rule.');
    }
    const totals = metrics(this.store, this.quotes, this.now());
    const entry = money(quote.price * 1.0005);
    const stop = money(entry * (1 - bot.stopPct / 100));
    const target = money(entry * (1 + bot.targetPct / 100));
    const perShareRisk = entry - stop + entry * 0.0015; // Entry fee, exit fee and modelled exit slippage.
    const riskRemaining = settings.dailyLossLimit - totals.dayLoss - totals.openRisk;
    const qty = Math.floor(Math.min(bot.budget / entry, settings.maxPosition / entry, settings.cash / (entry * 1.0005), settings.maxTradeRisk / perShareRisk, riskRemaining / perShareRisk));
    record.checks.dailyEntryLimit = { passed: totals.entriesToday < settings.maxDailyTrades, entriesToday: totals.entriesToday, limit: settings.maxDailyTrades };
    record.checks.positionSizing = {
      passed: qty >= 1, quantity: qty, modelledEntry: entry, stop, target, perShareRisk,
      botBudget: bot.budget, positionCap: settings.maxPosition, cash: settings.cash, maxTradeRisk: settings.maxTradeRisk,
      dailyLossLimit: settings.dailyLossLimit, dayLoss: totals.dayLoss, openRisk: totals.openRisk, riskRemaining
    };
    if (totals.entriesToday >= settings.maxDailyTrades) return this.finishAnalysis(bot, record, 'blocked', 'Blocked by daily entry limit.', 'warn');
    if (qty < 1) return this.finishAnalysis(bot, record, 'blocked', 'Blocked: cash, position cap, or risk budget cannot cover one share.', 'warn');
    const fee = money(entry * qty * 0.0005);
    settings.cash = money(settings.cash - entry * qty - fee);
    this.store.saveSettings(settings);
    bot.position = { qty, entry, stop, target, maxLoss: money(perShareRisk * qty), source: quote.source, openedAt: new Date(this.now()).toISOString() };
    bot.exitSamples = bot.exitPreset === 'sma' ? [quote.price] : [];
    bot.lastEntryDay = day;
    this.store.order({ id: randomUUID(), botId: bot.id, botName: bot.name, symbol: bot.symbol, side: 'BUY', qty, price: entry, fee, pnl: null, reason: presets.find(p => p.id === bot.preset).name, source: quote.source, execution: 'paper', at: new Date(this.now()).toISOString() });
    record.fill = { execution: 'paper', side: 'BUY', qty, price: entry, fee, stop, target };
    return this.finishAnalysis(bot, record, 'buy', `Paper buy: ${qty} shares at Rs ${entry}. Stop ${stop}, target ${target}.`);
  }
  exit(bot, quote, reason, record = null) {
    const settings = this.store.settings();
    if (record) record.checks.hasPosition = { passed: Boolean(bot.position) };
    if (!bot.position) throw new AppError('No paper position to close.', 409);
    if (record) record.checks.freshQuote = { passed: validQuote(quote, bot.position.source, this.now()), maximumAgeMs: 60000, maximumFutureMs: 5000 };
    if (!validQuote(quote, bot.position.source, this.now())) throw new AppError('A fresh matching-source quote is required to close the paper position.', 409, 'STALE_QUOTE');
    const position = bot.position;
    const window = executionWindow(this.now(), bot.symbol);
    const quoteWindow = window.specialSession ? executionWindow(Date.parse(quote.at), bot.symbol) : null;
    if (window.specialSession && (!window.open || !quoteWindow.open || quoteWindow.date !== window.date)) throw new AppError(`No auction/post-close paper fills. ${window.description}`, 409, 'EXIT_WINDOW');
    const protective = (reason === 'Stop loss' && quote.price <= position.stop) || (reason === 'Take profit' && quote.price >= position.target);
    if (record) record.checks.exitAllowed = { passed: protective || window.open, protective, entryWindowOpen: window.open };
    if (!protective && !window.open) throw new AppError('Manual/strategy exits require the weekday 09:15-15:20 IST window. Same-day exits are allowed; stop-loss and take-profit remain active with fresh quotes.', 409, 'EXIT_WINDOW');
    const price = money(quote.price * 0.9995);
    const fee = money(price * position.qty * 0.0005);
    const pnl = money((price - position.entry) * position.qty - fee);
    settings.cash = money(settings.cash + price * position.qty - fee);
    this.store.saveSettings(settings);
    this.store.order({ id: randomUUID(), botId: bot.id, botName: bot.name, symbol: bot.symbol, side: 'SELL', qty: position.qty, price, fee, pnl, reason, source: quote.source, execution: 'paper', at: new Date(this.now()).toISOString() });
    bot.position = null;
    bot.exitSamples = [];
    this.message(bot, `Paper position closed: ${reason}. Realised Rs ${pnl} (excluding entry fee).`);
    if (record) Object.assign(record, { decision: 'sell', reason, fill: { execution: 'paper', side: 'SELL', qty: position.qty, price, fee, pnl } });
  }
}
