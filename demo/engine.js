import { money, signal, exitSignal } from '../shared/signals.js';
import { coverage, dayOf, minuteOf, validSymbol } from './data.js';

export const entryPresets = { breakout: 'Price breakout', dip: 'Buy the dip', sma: 'Moving-average cross', swing: 'Swing breakout', rules: 'Custom rules' };
export const exitPresets = { protective: 'Stop loss / take profit', sma: 'Moving-average reversal', support: 'Support breakdown', 'max-hold': 'Maximum holding period', scheduled: 'Scheduled exit', 'time-performance': 'Time + performance', rules: 'Custom exit rules' };
export const defaultRisk = { initialCash: 100000, maxTradeRisk: 500, dailyLossLimit: 2000, maxDailyTrades: 10, maxPosition: 25000 };
export const defaultRule = (exit = false) => ({ op: 'and', rules: [{ left: { field: 'close' }, op: exit ? 'crosses-below' : 'crosses-above', right: { field: 'sma', period: 20 } }] });
const fields = ['open', 'high', 'low', 'close', 'volume', 'sma', 'ema', 'rsi', 'time', 'number'];
const operators = ['above', 'below', 'crosses-above', 'crosses-below'];
const finite = (n, min, max, label) => {
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} must be between ${min} and ${max}.`);
};
export function validateRule(rule, depth = 0, count = { value: 0 }) {
  if (!rule || typeof rule !== 'object' || depth > 5 || ++count.value > 64) throw new Error('Rule trees allow at most 5 nested groups and 64 nodes.');
  if (['and', 'or'].includes(rule.op)) {
    if (!Array.isArray(rule.rules) || !rule.rules.length) throw new Error('Every rule group needs at least one condition.');
    rule.rules.forEach(child => validateRule(child, depth + 1, count));
  } else {
    if (!operators.includes(rule.op)) throw new Error('Unsupported rule operator.');
    for (const operand of [rule.left, rule.right]) {
      if (!operand || !fields.includes(operand.field)) throw new Error('Unsupported rule operand.');
      if (['sma', 'ema', 'rsi'].includes(operand.field) || operand.period !== undefined) {
        finite(operand.period, 1, 500, 'Indicator period');
        if (!Number.isInteger(operand.period)) throw new Error('Indicator periods must be whole numbers.');
      }
      if (operand.field === 'number' || operand.value !== undefined) finite(operand.value, 0, 1e12, 'Rule constant');
    }
  }
  return rule;
}
export function validateRisk(risk) {
  if (!risk || typeof risk !== 'object' || Object.keys(risk).some(key => !Object.hasOwn(defaultRisk, key))) throw new Error('Risk settings must contain only the supported numeric limits.');
  for (const [key, min, max] of [['initialCash', 100, 1e9], ['maxTradeRisk', 1, 1e7], ['dailyLossLimit', 1, 1e8], ['maxPosition', 100, risk.initialCash], ['maxDailyTrades', 1, 50]]) finite(risk[key], min, max, key);
  if (!Number.isInteger(risk.maxDailyTrades) || risk.dailyLossLimit < risk.maxTradeRisk) throw new Error('Daily entries must be whole; daily loss limit must cover per-trade risk.');
}
export function validateStrategy(bot, risk) {
  if (!bot || typeof bot.name !== 'string' || !bot.name.trim() || bot.name.length > 60 || !validSymbol(bot.symbol)) throw new Error('Use a name (1–60 characters) and a valid uppercase NSE ticker.');
  if (!Object.hasOwn(entryPresets, bot.preset) || !Object.hasOwn(exitPresets, bot.exitPreset)) throw new Error('Unsupported entry/exit preset.');
  finite(bot.budget, 100, Math.min(risk.initialCash, risk.maxPosition), 'Position budget');
  finite(bot.stopPct, 0.2, 10, 'Stop percent'); finite(bot.targetPct, 0.2, 30, 'Target percent');
  if (bot.targetPct < bot.stopPct * (bot.preset === 'swing' ? 2 : 1)) throw new Error('Target must be at least 1R (2R for swing).');
  if (['breakout', 'dip', 'swing'].includes(bot.preset)) finite(bot.level, 1, 1e6, 'Entry level');
  if (bot.exitPreset === 'support') finite(bot.exitLevel, 1, 1e6, 'Support level');
  if (['max-hold', 'scheduled', 'time-performance'].includes(bot.exitPreset)) {
    finite(bot.exitSessions, 1, 60, 'Holding sessions');
    if (!Number.isInteger(bot.exitSessions) || !/^(09:(?:1[5-9]|[2-5]\d)|1[0-4]:[0-5]\d|15:0\d|15:1[0-4])$/.test(bot.exitTime)) throw new Error('Timed exit requires whole sessions and an IST time from 09:15 to 15:14.');
    finite(bot.exitMinGainPct, 0, 30, 'Minimum gain');
  }
  if (bot.preset === 'rules') validateRule(bot.entryRule);
  if (bot.exitPreset === 'rules') validateRule(bot.exitRule);
}

export function indicatorSeries(bars, kind, period) {
  const result = Array(bars.length).fill(null);
  let sum = 0, ema = null, gain = 0, loss = 0;
  for (let i = 0; i < bars.length; i++) {
    const close = bars[i][4];
    if (kind === 'rsi') {
      if (!i) continue;
      const delta = close - bars[i - 1][4];
      if (i <= period) { gain += Math.max(0, delta) / period; loss += Math.max(0, -delta) / period; }
      else { gain = (gain * (period - 1) + Math.max(0, delta)) / period; loss = (loss * (period - 1) + Math.max(0, -delta)) / period; }
      if (i >= period) result[i] = loss === 0 ? gain === 0 ? 50 : 100 : 100 - 100 / (1 + gain / loss);
    } else {
      sum += close;
      if (i >= period) sum -= bars[i - period][4];
      if (i < period - 1) continue;
      ema = ema === null ? sum / period : close * (2 / (period + 1)) + ema * (1 - 2 / (period + 1));
      result[i] = kind === 'sma' ? sum / period : ema;
    }
  }
  return result;
}
export function ruleEvaluator(bars) {
  const cache = new Map(), indexOf = { open: 1, high: 2, low: 3, close: 4, volume: 5 };
  function value(operand, index) {
    if (index < 0) return null;
    if (operand.field === 'number') return operand.value;
    if (operand.field === 'time') return minuteOf(bars[index][0]);
    if (Object.hasOwn(indexOf, operand.field)) return bars[index][indexOf[operand.field]];
    const key = `${operand.field}:${operand.period}`;
    if (!cache.has(key)) cache.set(key, indicatorSeries(bars, operand.field, operand.period));
    return cache.get(key)[index];
  }
  function evaluate(rule, index) {
    if (rule.op === 'and' || rule.op === 'or') {
      const values = rule.rules.map(child => evaluate(child, index));
      return rule.op === 'and' ? values.every(Boolean) : values.some(Boolean);
    }
    const a = value(rule.left, index), b = value(rule.right, index);
    if (a === null || b === null) return false;
    if (rule.op === 'above') return a > b;
    if (rule.op === 'below') return a < b;
    const previousA = value(rule.left, index - 1), previousB = value(rule.right, index - 1);
    if (previousA === null || previousB === null) return false;
    return rule.op === 'crosses-above' ? previousA <= previousB && a > b : previousA >= previousB && a < b;
  }
  return evaluate;
}

export function createSimulation(input) {
  const { datasets, strategies, from, through, unverified = false } = input;
  const risk = { ...defaultRisk, ...input.risk };
  validateRisk(risk);
  if (!strategies?.length || strategies.length > 20) throw new Error('Choose 1–20 strategies.');
  const selected = new Map(), checks = [];
  for (const bot of strategies) {
    validateStrategy(bot, risk);
    const dataset = datasets.find(item => item.symbol === bot.symbol && item.id === bot.datasetId);
    if (!dataset) throw new Error(`Select an imported or available dataset for ${bot.symbol}.`);
    if (!selected.has(dataset.id)) {
      const bars = dataset.bars.filter(bar => (!from || dayOf(bar[0]) >= from) && (!through || dayOf(bar[0]) <= through));
      const prepared = coverage(bars, { from, through, unverified });
      if (prepared.issues.length) throw new Error(`Coverage blocked for ${bot.symbol}: ${prepared.issues.slice(0, 5).join(' ')} Select complete dates or repair the CSV.`);
      selected.set(dataset.id, { ...prepared, id: dataset.id, symbol: dataset.symbol, sha256: dataset.sha256, source: dataset.source, adjustment: dataset.adjustment, rule: ruleEvaluator(prepared.bars) });
      checks.push({ id: dataset.id, symbol: bot.symbol, sha256: dataset.sha256, source: dataset.source, adjustment: dataset.adjustment, verifiedCalendar: prepared.verified, from: prepared.from, through: prepared.through, sessions: prepared.sessions, excludedBars: prepared.outside });
    }
  }
  const bots = strategies.map((bot, index) => ({ ...structuredClone(bot), key: index, samples: [], exitSamples: [], previous: null, pending: null, position: null, lastEntryDay: null, sampleDay: null, entries: 0 }));
  const events = [];
  for (const data of selected.values()) data.bars.forEach((bar, index) => events.push({ datasetId: data.id, bar, index }));
  events.sort((a, b) => a.bar[0] - b.bar[0] || a.datasetId.localeCompare(b.datasetId));
  const orders = [], trades = [], equity = [], logs = [], quotes = new Map(), daily = new Map();
  let cash = risk.initialCash, cursor = 0, locked = false, ambiguous = 0, finished = false;
  const ledger = day => { if (!daily.has(day)) daily.set(day, { entries: 0, entryFees: 0, exitPnl: 0 }); return daily.get(day); };
  const log = (at, bot, decision, reason) => { logs.push({ at, bot: bot.name, symbol: bot.symbol, decision, reason }); if (logs.length > 2000) logs.shift(); };
  const fill = (bot, bar, price, side, qty, fee, reason, pnl = null) => orders.push({ at: new Date(bar[0]).toISOString(), bot: bot.name, symbol: bot.symbol, side, qty, price, fee, reason, pnl, execution: 'historical simulation' });
  const sell = (bot, bar, reference, reason) => {
    const p = bot.position, price = money(reference * 0.9995), fee = money(price * p.qty * 0.0005);
    const pnl = money((price - p.entryPrice) * p.qty - p.entryFee - fee);
    cash = money(cash + price * p.qty - fee);
    ledger(dayOf(bar[0])).exitPnl += (price - p.entryPrice) * p.qty - fee;
    trades.push({ bot: bot.name, symbol: bot.symbol, ...p, exitAt: new Date(bar[0]).toISOString(), exitPrice: price, exitFee: fee, pnl, reason, fees: money(p.entryFee + fee), slippage: money(((p.entryPrice - p.entryReference) + (reference - price)) * p.qty) });
    fill(bot, bar, price, 'SELL', p.qty, fee, reason, pnl); log(bar[0], bot, 'sell', reason);
    bot.position = null; bot.pending = null; bot.exitSamples = [];
  };
  function process(event) {
    const { bar, index, datasetId } = event, day = dayOf(bar[0]), data = selected.get(datasetId);
    quotes.set(datasetId, { symbol: data.symbol, at: bar[0], price: bar[4] });
    for (const bot of bots.filter(bot => bot.datasetId === datasetId)) {
      const sessionIndex = data.sessions.findIndex(session => session.day === day);
      if (bot.sampleDay !== day) { bot.samples = []; bot.previous = null; bot.sampleDay = day; bot.pending = null; }
      let occupied = false;
      if (bot.pending?.type === 'exit' && bot.position) {
        sell(bot, bar, bar[1], bar[1] <= bot.position.stop ? 'Stop gap at open' : bar[1] >= bot.position.target ? 'Target gap at open' : 'Exit strategy');
        occupied = true;
      }
      if (bot.pending?.type === 'entry') {
        if (!locked && bot.enabled !== false && bot.lastEntryDay !== day) {
          const entry = money(bar[1] * 1.0005), stop = money(entry * (1 - bot.stopPct / 100)), target = money(entry * (1 + bot.targetPct / 100));
          const perShare = entry - stop + entry * 0.0015, dailyRisk = ledger(day);
          const openRisk = bots.reduce((sum, item) => sum + (item.position?.modelledRisk ?? 0), 0);
          const remaining = risk.dailyLossLimit - Math.max(0, dailyRisk.entryFees - dailyRisk.exitPnl) - openRisk;
          const qty = Math.floor(Math.min(bot.budget / entry, risk.maxPosition / entry, cash / (entry * 1.0005), risk.maxTradeRisk / perShare, remaining / perShare));
          if (qty >= 1 && dailyRisk.entries < risk.maxDailyTrades) {
            const fee = money(entry * qty * 0.0005);
            cash = money(cash - entry * qty - fee);
            bot.position = { entryAt: new Date(bar[0]).toISOString(), entryPrice: entry, entryReference: bar[1], entryFee: fee, qty, stop, target, modelledRisk: money(qty * perShare), sessionIndex, performancePassed: false };
            bot.exitSamples = bot.exitPreset === 'sma' ? [bar[1]] : [];
            bot.lastEntryDay = day; dailyRisk.entries++; dailyRisk.entryFees += fee;
            fill(bot, bar, entry, 'BUY', qty, fee, 'Next actual open'); log(bar[0], bot, 'buy', 'Completed-close signal filled at next open.');
          } else log(bar[0], bot, 'blocked', 'Cash, budget, per-trade/daily risk or entry limit.');
        }
        bot.pending = null;
      }
      if (bot.position) {
        occupied = true;
        const p = bot.position;
        if (bar[1] <= p.stop) sell(bot, bar, bar[1], 'Stop gap at open');
        else if (bar[1] >= p.target) sell(bot, bar, bar[1], 'Target gap at open');
        else if (bar[3] <= p.stop) { if (bar[2] >= p.target) ambiguous++; sell(bot, bar, p.stop, 'Stop loss'); }
        else if (bar[2] >= p.target) sell(bot, bar, p.target, 'Take profit');
        else {
          if (bot.exitPreset === 'sma') bot.exitSamples = [...bot.exitSamples, bar[4]].slice(-12);
          let triggered = exitSignal(bot, bar[4]);
          if (bot.exitPreset === 'rules') triggered = data.rule(bot.exitRule, index);
          if (['scheduled', 'max-hold', 'time-performance'].includes(bot.exitPreset)) {
            const targetMinute = +bot.exitTime.slice(0, 2) * 60 + +bot.exitTime.slice(3);
            const sessionsHeld = sessionIndex - p.sessionIndex + 1;
            const deadline = sessionsHeld > bot.exitSessions || (sessionsHeld === bot.exitSessions && minuteOf(bar[0]) + 1 >= targetMinute);
            if (deadline && !p.performancePassed) {
              triggered = bot.exitPreset !== 'time-performance' || (bar[4] - p.entryPrice) / p.entryPrice * 100 < bot.exitMinGainPct;
              if (!triggered) p.performancePassed = true;
            }
          }
          const next = data.bars[index + 1];
          if (triggered && next?.[0] === bar[0] + 60000 && dayOf(next[0]) === day) bot.pending = { type: 'exit' };
        }
      }
      if (!occupied && !bot.position && bot.enabled !== false && !locked) {
        bot.samples = [...bot.samples, bar[4]].slice(-13);
        const triggered = bot.preset === 'rules' ? data.rule(bot.entryRule, index) : signal(bot, bar[4]);
        bot.previous = bar[4];
        const next = data.bars[index + 1];
        if (triggered && bot.lastEntryDay !== day && next?.[0] === bar[0] + 60000 && dayOf(next[0]) === day && minuteOf(next[0]) < 920) {
          bot.pending = { type: 'entry' }; log(bar[0], bot, 'signal', 'Awaiting next same-session open.');
        }
      }
    }
  }
  function record(time) {
    equity.push({ at: new Date(time + 60000).toISOString(), value: money(cash + bots.reduce((sum, bot) => sum + (bot.position ? bot.position.qty * quotes.get(bot.datasetId).price : 0), 0)) });
  }
  function step(count = 1) {
    if (finished) throw new Error('Simulation is finalized. Reset before replaying.');
    if (!Number.isSafeInteger(count) || count < 0 || count > 2000000) throw new Error('Step count must be a whole number between 0 and 2,000,000.');
    for (let n = 0; n < count && cursor < events.length; n++) {
      const time = events[cursor].bar[0];
      do { process(events[cursor++]); } while (cursor < events.length && events[cursor].bar[0] === time);
      record(time);
    }
    return snapshot();
  }
  function finish() {
    if (cursor !== events.length) throw new Error('Cannot finalize before all candles have been processed.');
    if (!finished) {
      for (const bot of bots) if (bot.position) {
        const bar = selected.get(bot.datasetId).bars.at(-1);
        sell(bot, [bar[0] + 60000, ...bar.slice(1)], bar[4], 'End-window liquidation');
      }
      if (equity.length) equity.at(-1).value = cash;
      finished = true;
    }
    return report();
  }
  function snapshot() {
    const point = equity.at(-1);
    return { cursor, steps: equity.length, total: events.length, done: cursor === events.length, at: point?.at ?? null, cash, value: point?.value ?? risk.initialCash, bots: bots.map(bot => ({ key: bot.key, enabled: bot.enabled !== false })), positions: bots.filter(bot => bot.position).map(bot => ({ key: bot.key, bot: bot.name, symbol: bot.symbol, ...bot.position })), quotes: [...quotes.values()], orders: orders.slice(-100), logs: logs.slice(-100), equity: equity.filter((_, i) => i % Math.max(1, Math.ceil(equity.length / 500)) === 0).concat(point ? [point] : []), locked };
  }
  function report() {
    let peak = risk.initialCash, drawdown = 0;
    const monthly = new Map();
    for (const point of equity) {
      peak = Math.max(peak, point.value); drawdown = Math.max(drawdown, (peak - point.value) / peak * 100);
      monthly.set(dayOf(Date.parse(point.at)).slice(0, 7), point.value);
    }
    let previous = risk.initialCash;
    const months = [...monthly].map(([month, value]) => { const result = { month, pnl: money(value - previous), returnPct: money((value - previous) / previous * 100) }; previous = value; return result; });
    const wins = trades.filter(trade => trade.pnl > 0).length;
    return { version: 1, execution: 'historical simulation', createdAt: new Date().toISOString(), finalized: finished, positions: snapshot().positions, cash, strategies: structuredClone(strategies), risk, datasets: checks, summary: { initialCapital: risk.initialCash, finalCapital: equity.at(-1)?.value ?? cash, netPnl: money((equity.at(-1)?.value ?? cash) - risk.initialCash), returnPct: money(((equity.at(-1)?.value ?? cash) / risk.initialCash - 1) * 100), trades: trades.length, wins, losses: trades.filter(t => t.pnl < 0).length, breakeven: trades.filter(t => t.pnl === 0).length, winRatePct: trades.length ? money(wins / trades.length * 100) : null, maxDrawdownPct: money(drawdown), fees: money(orders.reduce((sum, order) => sum + order.fee, 0)), slippage: money(trades.reduce((sum, trade) => sum + trade.slippage, 0)), ambiguousBars: ambiguous }, months, trades, orders, equity, logs, benchmarks: [...selected.values()].map(data => {
      const entry = money(data.bars[0][1] * 1.0005), qty = Math.floor(risk.initialCash / (entry * 1.0005)), exit = money(data.bars.at(-1)[4] * 0.9995);
      const final = money(risk.initialCash - entry * qty - money(entry * qty * 0.0005) + exit * qty - money(exit * qty * 0.0005));
      return { symbol: data.symbol, finalCapital: final, returnPct: money((final / risk.initialCash - 1) * 100), label: 'Independent buy-and-hold; full initial capital, same dates and costs' };
    }), assumptions: ['One-minute completed closes; next same-session open signals. No tick-level ordering.', 'Long-only whole shares; one entry per bot per IST day; shared cash/risk in multi-bot runs; stable dataset-ID then configured-bot ordering at equal timestamps.', '0.05% adverse slippage and 0.05% fee per side; stop first on ambiguous bars; gaps can exceed stop risk.', 'Conservative declared continuous sessions only; no fabricated bars. Calendar verification and source/adjustment status recorded per dataset.', 'SMA entry resets daily and does not collect while holding; custom indicators warm up from selected history without looking ahead. Missing warmup yields no signal.', 'Batch runs liquidate at final continuous close; interactive replay does not liquidate automatically. Equity drawdown is close-based.', 'Decision log contains at most the last 2,000 signal/fill/block records, not every bar. Historical outcomes are not forecasts.'] };
  }
  return { step, finish, report, snapshot, lock: value => { locked = Boolean(value); if (locked) for (const bot of bots) if (bot.pending?.type === 'entry') bot.pending = null; }, setEnabled: (key, enabled) => { if (!bots[key]) throw new Error('Unknown bot.'); bots[key].enabled = Boolean(enabled); if (!enabled && bots[key].pending?.type === 'entry') bots[key].pending = null; }, close: key => {
    const bot = bots[key], quote = bot && quotes.get(bot.datasetId);
    if (!bot?.position || !quote || quote.at !== events[cursor - 1]?.bar[0]) throw new Error('Manual close requires a current simulated candle for this position.');
    sell(bot, [quote.at + 60000, quote.price, quote.price, quote.price, quote.price, 1], quote.price, 'Manual historical close');
    if (equity.length) equity.at(-1).value = money(cash + bots.reduce((sum, b) => sum + (b.position ? b.position.qty * quotes.get(b.datasetId).price : 0), 0));
    return snapshot();
  } };
}
