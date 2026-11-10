import { money } from '../shared/signals.js';
import { dayOf, minuteOf, atMinute, sessionFor } from './data.js';

const continuous = bar => {
  const session = sessionFor(dayOf(bar[0]));
  return session === null || (session && minuteOf(bar[0]) >= session.open && minuteOf(bar[0]) < session.close);
};
const supportedPrice = value => Number.isFinite(value) && value >= 1 && value <= 1e6;

export function stockDefaults(data, { from, through, preset, exitPreset, risk, level, stopPct, targetPct, exitLevel }) {
  const bars = data.bars;
  if (!bars?.length) throw new Error('Import candles before generating stock defaults.');
  const start = atMinute(from || dayOf(bars[0][0]), 0);
  const end = atMinute(through || dayOf(bars.at(-1)[0]), 1440);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('Choose a valid date range for stock defaults.');
  let low = 0, high = bars.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (bars[middle][0] < start) low = middle + 1;
    else high = middle;
  }
  while (low < bars.length && bars[low][0] < end && !continuous(bars[low])) low++;
  const first = bars[low];
  if (!first || first[0] >= end) throw new Error('No continuous-session candles in this date range for stock defaults.');
  const firstDay = dayOf(first[0]), observed = [];
  for (let i = low - 1; i >= 0; i--) {
    const bar = bars[i], day = dayOf(bar[0]);
    if (day >= firstDay || !continuous(bar)) continue;
    let session = observed.at(-1);
    if (session?.day !== day) {
      if (observed.length === 20) break;
      session = { day, high: bar[2], low: bar[3], close: bar[4], volume: 0, count: 0, firstMinute: minuteOf(bar[0]), lastMinute: minuteOf(bar[0]), zero: false };
      observed.push(session);
    }
    session.high = Math.max(session.high, bar[2]); session.low = Math.min(session.low, bar[3]);
    session.volume += bar[5]; session.count++; session.firstMinute = minuteOf(bar[0]); session.zero ||= bar[5] === 0;
  }
  const history = observed.filter(day => {
    const session = sessionFor(day.day);
    return !day.zero && day.count === day.lastMinute - day.firstMinute + 1 &&
      (!session || (day.firstMinute === session.open && day.lastMinute === session.close - 1));
  });
  const previous = history[0], price = previous?.close ?? first[1];
  const ranges = history.slice(0, 14).map((day, i) => Math.max(day.high - day.low,
    Math.abs(day.high - (history[i + 1]?.close ?? day.close)), Math.abs(day.low - (history[i + 1]?.close ?? day.close))));
  const atr = ranges.length ? ranges.reduce((sum, range) => sum + range, 0) / ranges.length : 0;
  const distance = atr > 0 ? atr : price * 0.01, buffer = Math.max(0.01, price * 0.001);
  const levels = {
    breakout: money(previous ? previous.high + buffer : price + distance * 0.5),
    dip: money(price - distance * (previous ? 0.5 : 1)),
    swing: money(history.length ? Math.max(...history.map(day => day.high)) + buffer : price + distance)
  };
  const volatilityPct = atr > 0 ? atr / price * 100 : 1;
  const suggestedStop = Math.max(0.2, Math.min(10, Math.ceil(volatilityPct * (preset === 'swing' ? 1.5 : 1) * 10 - 1e-9) / 10));
  const effectiveStop = Number.isFinite(stopPct) && stopPct >= 0.2 && stopPct <= 10 ? stopPct : suggestedStop;
  const target = Number.isFinite(targetPct) && targetPct >= 0.2 && targetPct <= 30 ? targetPct : money(effectiveStop * 2);
  const entry = Object.hasOwn(levels, preset) ? supportedPrice(level) ? level : levels[preset] : price;
  const stopDistance = entry * effectiveStop / 100;
  const suggestedSupport = money(previous && previous.low < entry && previous.low > entry - stopDistance
    ? previous.low : entry - stopDistance * 0.75);
  const support = supportedPrice(exitLevel) ? exitLevel : suggestedSupport;
  if (Object.hasOwn(levels, preset) && !supportedPrice(entry)) throw new Error('This stock needs an entry level outside the supported INR 1–1,000,000 range.');
  if (exitPreset === 'support' && !supportedPrice(exitLevel) && (!supportedPrice(support) || support >= entry)) throw new Error('No valid support default fits this stock and stop. Choose another exit or enter a supported level.');
  const cap = Math.min(risk.initialCash, risk.maxPosition);
  const allocation = Math.min(cap, Math.max(100, risk.initialCash * 0.1));
  const shareCost = entry * 1.001, shareRisk = entry * (effectiveStop / 100 + 0.0015);
  let shares = Math.floor(Math.min(allocation / shareCost, risk.maxTradeRisk / shareRisk));
  if (!shares && shareCost <= cap && shareRisk <= risk.maxTradeRisk) shares = 1;
  const session = sessionFor(firstDay);
  const exitMinute = Math.min(900, (session?.close ?? 915) - 5);
  const values = {
    level: levels[preset] ?? levels.breakout,
    budget: Math.min(cap, Math.max(100, shares ? money(shares * shareCost) : allocation)),
    stopPct: suggestedStop, targetPct: money(effectiveStop * 2), exitLevel: suggestedSupport,
    exitSessions: exitPreset === 'scheduled' ? 1 : preset === 'swing' ? 5 : 3,
    exitTime: `${String(Math.floor(exitMinute / 60)).padStart(2, '0')}:${String(exitMinute % 60).padStart(2, '0')}`,
    exitMinGainPct: effectiveStop
  };
  return {
    values, price, levels, support, targetPrice: money(entry * (1 + target / 100)),
    volume: previous ? previous.volume / previous.count : first[5],
    entryMinute: Math.min((session?.open ?? minuteOf(first[0])) + 15, exitMinute),
    exitMinute, historySessions: history.length, volatilityBased: atr > 0, canSize: shares > 0,
    basis: previous ? `${previous.day} close` : `${firstDay} opening price (no earlier complete session)`
  };
}

export function ruleConstant(field, op, exit, profile) {
  if (field === 'rsi') return exit ? 70 : 30;
  if (field === 'time') return exit ? profile?.exitMinute ?? 900 : profile?.entryMinute ?? 570;
  if (!profile) return NaN;
  const below = op === 'below' || op === 'crosses-below';
  if (field === 'volume') return Math.max(1, Math.round(profile.volume * (below ? 0.5 : 1.5)));
  return exit ? below ? profile.support : profile.targetPrice : below ? profile.levels.dip : profile.levels.breakout;
}
