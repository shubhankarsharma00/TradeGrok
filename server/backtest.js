import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './broker.js';
import { entryWindow, exitSignal, timedExitSignal, istDay, money, signal, validateBot, validateRisk } from './engine.js';
import { regularSession, calendarSource, tradingSession, muhuratSession } from './market-calendar.js';
import { exitPresets } from './store.js';
export { calendarSource } from './market-calendar.js';

const minute = 60000;
export const scheduleSource = 'https://nsearchives.nseindia.com/web/pressrelease/2026-08/PR_cc_03082026_20260803232411.pdf';

export function sessionSchedule(day) {
  const auction = day >= '2026-08-03';
  return { bars: auction ? 72 : 75, continuousClose: auction ? '15:15' : '15:30', sessionClose: auction ? '15:35' : '15:30', auction };
}

export function sessionDates(now) {
  const today = istDay(now);
  if (!today.startsWith('2026-')) throw new AppError('NSE calendar is verified for 2026 only; update it before running another year.', 422, 'BACKTEST_CALENDAR');
  const clock = new Date(now + 19800000);
  let cursor = Date.parse(`${today}T00:00:00Z`);
  const close = sessionSchedule(today).sessionClose.split(':').map(Number);
  if (clock.getUTCHours() * 60 + clock.getUTCMinutes() < close[0] * 60 + close[1]) cursor -= 86400000;
  const days = [];
  while (days.length < 9) {
    const day = new Date(cursor).toISOString().slice(0, 10);
    if (!day.startsWith('2026-') || ['2026-02-01', '2026-11-08'].includes(day)) {
      throw new AppError('This window reaches an unsupported special NSE session/calendar boundary. Regular sessions cannot silently replace it.', 422, 'BACKTEST_CALENDAR');
    }
    if (regularSession(day)) days.unshift(day);
    cursor -= 86400000;
  }
  return { warmup: days.slice(0, 2), evaluated: days.slice(2), all: days };
}

export function historyDates(now, days = 7) {
  if (!Number.isInteger(days) || days < 1 || days > 7) throw new AppError('History must cover 1-7 calendar days.', 400, 'BACKTEST_RANGE');
  const today = istDay(now), start = Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86400000;
  const all = [], schedules = {};
  for (let cursor = start; cursor <= Date.parse(`${today}T00:00:00Z`); cursor += 86400000) {
    const day = new Date(cursor).toISOString().slice(0, 10);
    if (!day.startsWith('2026-') || day === '2026-02-01') throw new AppError('Requested history reaches an unverified NSE calendar/session. Update the calendar before replaying.', 422, 'BACKTEST_CALENDAR');
    if (!tradingSession(day)) continue;
    const special = day === muhuratSession.date;
    const base = sessionSchedule(day);
    const open = special ? muhuratSession.open : '09:15';
    const close = special ? muhuratSession.conservativeClose : base.continuousClose;
    const sessionClose = base.sessionClose;
    if (day === today && now < Date.parse(`${day}T${sessionClose}:00+05:30`)) continue;
    all.push(day);
    schedules[day] = { open, continuousClose: close, sessionClose,
      bars: (Date.parse(`${day}T${close}:00+05:30`) - Date.parse(`${day}T${open}:00+05:30`)) / minute,
      auction: base.auction, special };
  }
  if (!all.length) throw new AppError('No completed NSE trading session falls inside these calendar days. Choose a larger window; older data will not be substituted.', 422, 'BACKTEST_RANGE');
  return { intervalMinutes: 1, days, from: new Date(start).toISOString().slice(0, 10), through: today, warmup: [], evaluated: all, all, schedules };
}

const scheduleFor = (sessions, day) => sessions.schedules?.[day] ?? { ...sessionSchedule(day), open: '09:15' };

export function prepareCandles(rows, sessions) {
  if (!Array.isArray(rows)) throw new AppError('Historical candles must be an array.', 422, 'BACKTEST_CANDLES');
  const byTime = new Map();
  let duplicates = 0;
  const originalTimes = [];
  for (const row of rows) {
    const [at, open, high, low, close, volume] = Array.isArray(row) ? row : [];
    const time = typeof at === 'string' ? Date.parse(at) : NaN;
    if (!Array.isArray(row) || row.length !== 6 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+05:30$/.test(at) ||
        !Number.isFinite(time) || istDay(time) !== at.slice(0, 10) || Number(at.slice(14, 16)) % (sessions.intervalMinutes ?? 5) !== 0 ||
        ![open, high, low, close].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0) ||
        high < Math.max(open, close, low) || low > Math.min(open, close, high) ||
        !Number.isInteger(volume) || volume < 0) {
      throw new AppError('Angel One supplied malformed timestamp/OHLC/volume candles. No backtest was computed.', 422, 'BACKTEST_CANDLES');
    }
    const candle = { at, time, open, high, low, close, volume };
    if (byTime.has(time)) {
      if (JSON.stringify(byTime.get(time)) !== JSON.stringify(candle)) throw new AppError('Conflicting duplicate candles prevent a reproducible backtest.', 422, 'BACKTEST_CANDLES');
      duplicates++; continue;
    }
    byTime.set(time, candle); originalTimes.push(time);
  }
  const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  const from = Date.parse(`${sessions.all[0]}T${scheduleFor(sessions, sessions.all[0]).open}:00+05:30`);
  const through = Date.parse(`${sessions.all.at(-1)}T${scheduleFor(sessions, sessions.all.at(-1)).sessionClose}:00+05:30`);
  if (candles.some(bar => bar.time < from || bar.time > through)) throw new AppError('Broker returned candles outside the requested history interval.', 422, 'BACKTEST_CANDLES');
  const expectedTimes = new Set();
  const coverage = sessions.all.map(day => {
    const schedule = scheduleFor(sessions, day);
    const opening = Date.parse(`${day}T${schedule.open}:00+05:30`);
    const missing = [], zeroVolume = [];
    for (let index = 0; index < schedule.bars; index++) {
      const time = opening + index * (sessions.intervalMinutes ?? 5) * minute;
      expectedTimes.add(time);
      const bar = byTime.get(time);
      if (!bar) missing.push(new Date(time).toISOString());
      else if (bar.volume === 0) zeroVolume.push(bar.at);
    }
    return { date: day, role: sessions.warmup.includes(day) ? 'warmup' : 'evaluated',
      expected: schedule.bars, received: schedule.bars - missing.length,
      continuousHoursIST: `${schedule.open}–${schedule.continuousClose}`, sessionCompletedAtIST: schedule.sessionClose,
      missing, zeroVolume, complete: missing.length === 0 && zeroVolume.length === 0 };
  });
  const outsideSession = candles.filter(bar => !expectedTimes.has(bar.time));
  const unexpectedSessions = [...new Set(outsideSession.filter(bar => {
    const clock = new Date(bar.time + 19800000);
    const atMinute = clock.getUTCHours() * 60 + clock.getUTCMinutes();
    return atMinute >= 555 && atMinute < 930 && !sessions.all.includes(istDay(bar.time));
  }).map(bar => istDay(bar.time)))];
  return {
    candles, regular: candles.filter(bar => expectedTimes.has(bar.time)), coverage, duplicates,
    reordered: originalTimes.some((time, index) => index > 0 && time < originalTimes[index - 1]),
    outsideSession: outsideSession.map(bar => bar.at),
    auctionBars: outsideSession.filter(bar => {
      const day = istDay(bar.time);
      return sessions.all.includes(day) && scheduleFor(sessions, day).auction &&
        bar.time >= Date.parse(`${day}T${scheduleFor(sessions, day).continuousClose}:00+05:30`) && bar.time < Date.parse(`${day}T${scheduleFor(sessions, day).sessionClose}:00+05:30`);
    }).map(bar => ({ at: bar.at, close: bar.close, volume: bar.volume })),
    unexpectedSessions,
    complete: coverage.every(day => day.complete) && unexpectedSessions.length === 0,
    sha256: createHash('sha256').update(JSON.stringify(candles)).digest('hex')
  };
}

export function replaySafePlay(bot, settings, prepared, sessions) {
  if (bot.preset !== 'sma' || bot.symbol !== 'RELIANCE') throw new AppError('This backtest supports saved safe play SMA on RELIANCE only; other instruments need verified session schedules.', 422, 'BACKTEST_BOT');
  if ((bot.exitPreset ?? 'protective') !== 'protective') throw new AppError('Historical replay supports stop-loss/take-profit exits only. Custom exit strategies cannot be silently ignored.', 422, 'BACKTEST_EXIT');
  return replayBot(bot, settings, prepared, sessions);
}

export function replayBot(bot, settings, prepared, sessions) {
  const config = validateBot(bot, settings);
  const risk = validateRisk(settings, settings);
  if (!prepared.complete) throw new AppError('Incomplete/zero-volume sessions prevent this backtest; gaps cannot be replaced by older sessions.', 422, 'BACKTEST_COVERAGE');
  const step = (sessions.intervalMinutes ?? 5) * minute;
  const bars = prepared.regular.filter(bar => sessions.evaluated.includes(istDay(bar.time)));
  let cash = settings.initialCash, position = null, pending = null, sampleDay = null;
  const model = { ...config, samples: [], exitSamples: [], previous: null };
  const trades = [], equity = [], skipped = [], analysis = [], orders = [], ledgers = new Map();
  let record;
  let ambiguousBars = 0;
  const ledger = day => {
    if (!ledgers.has(day)) ledgers.set(day, { entries: 0, entryFees: 0, exitPnl: 0 });
    return ledgers.get(day);
  };
  function exit(bar, reference, reason, endOfWindow = false) {
    const price = money(reference * 0.9995);
    const fee = money(price * position.qty * 0.0005);
    const pricePnl = money((price - position.entryPrice) * position.qty);
    const pnl = money(pricePnl - position.entryFee - fee);
    cash = money(cash + price * position.qty - fee);
    ledger(istDay(bar.time)).exitPnl += pricePnl - fee;
    trades.push({
      ...position, exitBarAt: bar.at, exitAt: endOfWindow ? new Date(bar.time + step).toISOString() : null,
      exitReference: reference, exitPrice: price, exitFee: fee, reason, pnl,
      fees: money(position.entryFee + fee),
      slippage: money(((position.entryPrice - position.entryReference) + (reference - price)) * position.qty)
    });
    const fill = { execution: 'backtest', source: 'angel', botId: bot.id, botName: config.name, symbol: config.symbol, side: 'SELL', qty: position.qty, price, fee, pnl, reason, at: endOfWindow ? new Date(bar.time + step).toISOString() : bar.at };
    orders.push(fill);
    record.fills.push(fill);
    Object.assign(record, { decision: 'sell', reason });
    position = null;
    model.exitSamples = [];
  }
  for (const [index, bar] of bars.entries()) {
    const day = istDay(bar.time);
    record = {
      version: 1, event: 'bot_analysis', trigger: 'historical_replay', execution: 'backtest',
      at: new Date(bar.time + step).toISOString(), atIst: new Date(bar.time + step + 19800000).toISOString().replace('Z', '+05:30'),
      bot: { id: bot.id, name: config.name, symbol: config.symbol, status: 'backtesting', entryPreset: config.preset, exitPreset: config.exitPreset },
      market: { entryWindowOpen: entryWindow(bar.time + step, config.symbol), window: 'Historical continuous candles only' },
      quote: { available: true, latestPrice: bar.close, source: 'angel', exchangeAt: bar.at, fresh: true },
      configuration: config, checks: {}, decision: position ? 'holding' : 'no_action',
      reason: position ? 'Monitoring saved exit rules, stop and target.' : 'Watching completed closes for the entry rule.',
      committed: false, simulated: true, fills: []
    };
    analysis.push(record);
    if (sampleDay !== day) { model.samples = []; model.previous = null; sampleDay = day; }
    let occupied = false;
    if (pending?.exit && position) {
      exit(bar, bar.open, bar.open <= position.stop ? 'Stop gap at open' : bar.open >= position.target ? 'Target gap at open' : `Exit strategy: ${exitPresets.find(preset => preset.id === config.exitPreset).name}`);
      pending = null;
      occupied = true;
    }
    if (pending) {
      if (entryWindow(bar.time, config.symbol)) {
        const entry = money(bar.open * 1.0005), stop = money(entry * (1 - config.stopPct / 100)), target = money(entry * (1 + config.targetPct / 100));
        const perShareRisk = entry - stop + entry * 0.0015;
        const daily = ledger(day);
        const remaining = risk.dailyLossLimit - Math.max(0, daily.entryFees - daily.exitPnl);
        const qty = Math.floor(Math.min(config.budget / entry, risk.maxPosition / entry, cash / (entry * 1.0005), risk.maxTradeRisk / perShareRisk, remaining / perShareRisk));
        record.checks.positionSizing = { passed: qty >= 1, quantity: qty, cash, remaining, perShareRisk, entry, stop, target, budget: config.budget, maxPosition: risk.maxPosition, maxTradeRisk: risk.maxTradeRisk };
        record.checks.dailyEntryLimit = { passed: daily.entries < Math.min(1, risk.maxDailyTrades), entries: daily.entries, limit: Math.min(1, risk.maxDailyTrades) };
        if (qty >= 1 && daily.entries < Math.min(1, risk.maxDailyTrades)) {
          const entryFee = money(entry * qty * 0.0005);
          cash = money(cash - entry * qty - entryFee);
          position = { signalBarAt: pending.at, entryAt: bar.at, entryReference: bar.open, entryPrice: entry, qty, stop, target, entryFee, modelledRisk: money(perShareRisk * qty) };
          model.exitSamples = config.exitPreset === 'sma' ? [bar.open] : [];
          const fill = { execution: 'backtest', source: 'angel', botId: bot.id, botName: config.name, symbol: config.symbol, side: 'BUY', qty, price: entry, fee: entryFee, stop, target, at: bar.at };
          orders.push(fill); record.fills.push(fill);
          Object.assign(record, { decision: 'buy', reason: 'Completed-close entry signal filled at the next actual open.' });
          daily.entries++; daily.entryFees += entryFee;
        } else {
          const reason = 'Cash, budget, risk or daily-entry limit prevented a whole-share fill.';
          skipped.push({ at: bar.at, reason });
          Object.assign(record, { decision: 'blocked', reason });
        }
      } else skipped.push({ at: bar.at, reason: 'Next-bar open is outside the saved 09:15–15:20 IST entry window.' });
      pending = null;
    }
    if (position) {
      occupied = true;
      record.position = { ...position };
      record.checks.stopLoss = { passed: bar.low <= position.stop, threshold: position.stop, low: bar.low };
      record.checks.takeProfit = { passed: bar.high >= position.target, threshold: position.target, high: bar.high };
      if (bar.open <= position.stop) exit(bar, bar.open, 'Stop gap at open');
      else if (bar.open >= position.target) exit(bar, bar.open, 'Target gap at open');
      else if (bar.low <= position.stop) {
        if (bar.high >= position.target) ambiguousBars++;
        exit(bar, position.stop, 'Stop loss');
      } else if (bar.high >= position.target) exit(bar, position.target, 'Take profit');
      else {
        if (config.exitPreset === 'sma') model.exitSamples = [...model.exitSamples, bar.close].slice(-12);
        model.position = { entry: position.entryPrice, openedAt: position.entryAt, timePerformancePassed: position.timePerformancePassed };
        const details = {};
        const closeAt = bar.time + step;
        const timed = ['max-hold', 'scheduled', 'time-performance'].includes(config.exitPreset);
        const eligible = entryWindow(closeAt, config.symbol) && closeAt < Date.parse(`${day}T${scheduleFor(sessions, day).continuousClose}:00+05:30`);
        const triggered = eligible && (timed
          ? timedExitSignal(model, { price: bar.close, at: new Date(closeAt).toISOString() }, closeAt, details)
          : exitSignal(model, bar.close));
        position.timePerformancePassed = Boolean(model.position.timePerformancePassed);
        record.checks.exitSignal = { evaluated: eligible, passed: triggered, values: details, samples: [...model.exitSamples] };
        if (triggered) {
          const next = bars[index + 1];
          // The rule sees this close, never this bar's earlier open or intrabar extrema.
          if (next && next.time === closeAt && istDay(next.time) === day) pending = { exit: true, at: bar.at };
        }
      }
    }
    if (!occupied && !position) {
      if (!entryWindow(bar.time + step, config.symbol)) { model.samples = []; model.previous = null; }
      else {
        model.samples = [...model.samples, bar.close].slice(-13);
        const triggered = signal(model, bar.close);
        record.checks.entrySignal = { passed: triggered, previous: model.previous, samples: [...model.samples], level: config.level };
        record.checks.botDailyEntry = { passed: ledger(day).entries === 0 };
        model.previous = bar.close;
        if (triggered && ledger(day).entries === 0) {
          const next = bars[index + 1];
          if (next && istDay(next.time) === day && next.time === bar.time + step && entryWindow(next.time, config.symbol)) {
            pending = { at: bar.at };
            Object.assign(record, { decision: 'signal', reason: 'Entry rule triggered at completed close; awaiting next same-session open.' });
          }
          else skipped.push({ at: bar.at, reason: 'No next same-session continuous-trading open inside the entry window; signal cannot fill in the auction or roll overnight.' });
        }
      }
    }
    if (bar === bars.at(-1) && position) exit(bar, bar.close, 'End-window liquidation', true);
    equity.push({ at: new Date(bar.time + step).toISOString(), value: money(cash + (position ? position.qty * bar.close : 0)) });
  }
  let peak = settings.initialCash, drawdown = 0, drawdownPct = 0;
  for (const point of equity) {
    peak = Math.max(peak, point.value);
    drawdown = Math.max(drawdown, peak - point.value);
    drawdownPct = Math.max(drawdownPct, (peak - point.value) / peak * 100);
  }
  return {
    algorithm: sessions.intervalMinutes === 1 ? 'bot-one-minute-close-next-open-v1' : 'safe-play-sma5x12-continuous-close-next-open-v2', bot: { id: bot.id, ...config },
    risk: { initialCash: settings.initialCash, maxTradeRisk: risk.maxTradeRisk, dailyLossLimit: risk.dailyLossLimit, maxDailyTrades: risk.maxDailyTrades, maxPosition: risk.maxPosition },
    summary: {
      initialCapital: settings.initialCash, finalCapital: cash, netPnl: money(cash - settings.initialCash),
      returnPct: money((cash - settings.initialCash) / settings.initialCash * 100),
      trades: trades.length, wins: trades.filter(trade => trade.pnl > 0).length, losses: trades.filter(trade => trade.pnl < 0).length,
      breakeven: trades.filter(trade => trade.pnl === 0).length,
      winRatePct: trades.length ? money(trades.filter(trade => trade.pnl > 0).length / trades.length * 100) : null,
      fees: money(trades.reduce((sum, trade) => sum + trade.fees, 0)),
      slippage: money(trades.reduce((sum, trade) => sum + trade.slippage, 0)),
      maxDrawdown: money(drawdown), maxDrawdownPct: money(drawdownPct), ambiguousBars,
      evaluatedBars: bars.length, skippedSignals: skipped.length
    },
    trades, equity, skipped, orders, analysis,
    assumptions: sessions.intervalMinutes === 1 ? [
      'Standalone replay of the selected bot configuration on the selected NSE cash ticker. Fresh simulated initial capital; existing positions, cash, start/pause/emergency state and other bots are excluded. One entry per bot per IST day and saved sizing/risk limits.',
      'Fixed one-minute completed closes replace polling samples for all entry and exit rules. SMA entry resets daily and does not collect while holding; SMA exits collect holding samples across sessions. No extra warmup days downloaded.',
      'Signals fill at the next same-session continuous open; protection uses intrabar low/high and actual gap opens, with stop first when both levels touch. No tick-level ordering or guaranteed stops.',
      'Conservative common continuous window: 09:15-15:15 IST from 3 August 2026 (09:15-15:30 earlier); verified 8 November Muhurat uses 14:20-15:15. Later non-CAS prints/auction marks are retained but not traded. This truncation can exclude valid non-CAS trading; ticker-specific auction eligibility is not inferred.',
      'Only completed sessions inside the selected last 1-7 IST calendar days. Weekends/holidays are not replaced by older sessions. Missing or zero-volume continuous bars block performance.',
      'Timed exits count actual trading sessions from simulated entry, including Muhurat. Time + performance checks once; a passed check keeps protection active. Signals at the final continuous close cannot create a later fill.',
      '0.05% adverse slippage and 0.05% fee per side, paise rounding; not actual Angel One brokerage/STT/GST. Trade P/L and wins/losses include both fees. Zero trades has no win rate.',
      'Positions may carry overnight. Any remainder is liquidated at the final continuous close with costs. Drawdown uses continuous close equity, not tick-level excursions. Backtest fills and logs are labelled separately; active paper orders/settings are unchanged.'
    ] : [
      'Standalone safe play, fresh portfolio funded by saved initialCash; current paper cash, positions, other bots and operational start/emergency flags are not historical inputs.',
      'Saved 5/12 polling-sample SMA becomes 5/12 completed five-minute closes. Signals reset each IST session and do not collect during an open position, matching the runner. Two prior complete sessions are downloaded/validated, but cannot seed the daily-reset MA; first 12 eligible bars each day are warmup.',
      'A completed continuous-trading close signals; earliest fill is the next same-session continuous bar open, before the saved 15:20 IST cutoff and before continuous trading ends. Signals cannot fill in closing auctions or roll overnight. Whole shares, saved sizing/daily risk limits, one entry per IST day.',
      'RELIANCE is an F&O cash stock covered by NSE CAS from 3 August 2026: 72 continuous bars, 09:15–15:15 IST; auction 15:15–15:35. Earlier dates have 75 continuous bars through 15:30. Auction marks (including zero-volume reference marks) are retained in the dataset but excluded from tradable OHLC, signals, exits and equity. Missing 15:15/15:20 continuous bars on CAS dates are not data gaps; CAS stop-loss orders are unavailable. No auction execution is simulated.',
      '0.05% adverse slippage and 0.05% fee per side, paise rounding and the runner risk formula. These are simulation costs, not actual Angel One brokerage/STT/GST or guaranteed fills.',
      'Stops/targets use intrabar low/high; stop wins when both touch. Overnight gaps fill at the next actual open with adverse slippage, not at the guaranteed stop. Exact intrabar exit time is unknown (exitBarAt labels its candle).',
      'Positions carry overnight through the excluded closing auction until a continuous-session stop/target. Any remainder is simulated liquidated at the final continuous bar close (15:15 IST for CAS dates), not the official auction closing price, with exit costs; no real/paper orders are created.',
      'Drawdown is based on continuous five-minute close equity and realized exits, not auction/tick-level/intrabar excursions. Zero-volume continuous bars or missing expected sessions block results; no older dates or mock candles substitute.'
    ]
  };
}

export function createBotBacktest(download, bot, settings, sessions, { createdAt = new Date().toISOString(), replayedFrom = null, expectedSha256, downloadOnly = false } = {}) {
  const config = validateBot(bot, settings);
  validateRisk(settings, settings);
  if (sessions.intervalMinutes !== 1 || download.request?.interval !== 'ONE_MINUTE' ||
      download.instrument?.exchange !== 'NSE' || download.instrument.symbol !== `${config.symbol}-EQ`) {
    throw new AppError('Replay requires one-minute Angel One history matching the selected NSE ticker.', 422, 'BACKTEST_INSTRUMENT');
  }
  const prepared = prepareCandles(download.data, sessions);
  if (expectedSha256 && prepared.sha256 !== expectedSha256) throw new AppError('Saved dataset checksum failed. Download history again.', 422, 'BACKTEST_CANDLES');
  const id = randomUUID();
  const result = prepared.complete && !downloadOnly ? replayBot({ id: bot.id, ...config }, settings, prepared, sessions) : null;
  for (const record of result?.analysis ?? []) { record.backtestId = id; record.cycleId = id; }
  return {
    id, createdAt, replayedFrom, status: !prepared.complete ? 'blocked' : downloadOnly ? 'downloaded' : 'completed',
    sessions, calendar: { source: calendarSource, scheduleSource, specialSessionSource: muhuratSession.source, scope: 'Conservative common NSE cash continuous window; later non-CAS/auction prints excluded' },
    dataset: { source: download.source, fetchedAt: download.fetchedAt, instrument: download.instrument, request: download.request, sha256: prepared.sha256, candles: prepared.candles, cache: download.cache },
    coverage: prepared.coverage, duplicates: prepared.duplicates, reordered: prepared.reordered,
    outsideSession: prepared.outsideSession, excludedClosingBars: prepared.auctionBars, unexpectedSessions: prepared.unexpectedSessions,
    snapshot: { bot: { id: bot.id, ...config }, settings: { initialCash: settings.initialCash, maxTradeRisk: settings.maxTradeRisk, dailyLossLimit: settings.dailyLossLimit, maxDailyTrades: settings.maxDailyTrades, maxPosition: settings.maxPosition } },
    result
  };
}

export function createBacktest(download, bot, settings, sessions, { createdAt = new Date().toISOString(), replayedFrom = null, expectedSha256 } = {}) {
  if ((bot.exitPreset ?? 'protective') !== 'protective') throw new AppError('Historical backtest supports stop-loss/take-profit exits only.', 422, 'BACKTEST_EXIT');
  const prepared = prepareCandles(download.data, sessions);
  if (expectedSha256 && prepared.sha256 !== expectedSha256) throw new AppError('Saved dataset checksum failed. Download history again; no result computed.', 422, 'BACKTEST_CANDLES');
  return {
    id: randomUUID(), createdAt, replayedFrom, status: prepared.complete ? 'completed' : 'blocked',
    sessions, calendar: { year: 2026, verifiedOn: '2026-11-08', source: calendarSource, scheduleSource, scope: 'RELIANCE continuous cash trading; CAS marks excluded',
      applicabilitySource: 'https://nsearchives.nseindia.com/web/mediaattachment/2026-08/Closing-Auction-Session-19-Aug-2026_20260819171631.csv',
      derivativeEvidence: { observedOn: '2026-11-08', source: 'https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json', symbol: 'RELIANCE23NOV26FUT', expiry: '2026-11-23' },
      auctionOrderSource: 'https://nsearchives.nseindia.com/content/circulars/CMTR73362.pdf',
      futureRevisionSource: 'https://www.sebi.gov.in/sebi_data/attachdocs/oct-2026/1792079571420.pdf',
      futureRevisionEffective: '2027-02-08' },
    dataset: { source: download.source, fetchedAt: download.fetchedAt, instrument: download.instrument, request: download.request, sha256: prepared.sha256, candles: prepared.candles },
    coverage: prepared.coverage, duplicates: prepared.duplicates, reordered: prepared.reordered,
    outsideSession: prepared.outsideSession, auctionBars: prepared.auctionBars, unexpectedSessions: prepared.unexpectedSessions,
    snapshot: {
      bot: { id: bot.id, name: bot.name, symbol: bot.symbol, preset: bot.preset, level: bot.level, budget: bot.budget, stopPct: bot.stopPct, targetPct: bot.targetPct, exitPreset: 'protective' },
      settings: { initialCash: settings.initialCash, maxTradeRisk: settings.maxTradeRisk, dailyLossLimit: settings.dailyLossLimit, maxDailyTrades: settings.maxDailyTrades, maxPosition: settings.maxPosition }
    },
    result: prepared.complete ? replaySafePlay(bot, settings, prepared, sessions) : null
  };
}
