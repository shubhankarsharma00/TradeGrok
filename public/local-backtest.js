import { checksum, dayOf, validSymbol, validateBars } from '../demo/data.js';

async function api(path, input) {
  const state = input === undefined ? null : await api('/api/state');
  const response = await fetch(path, input === undefined ? { cache: 'no-store' } : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tradegrok-CSRF': state.csrf },
    body: JSON.stringify(input)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Local history request failed.');
  return result;
}

export async function historyDataset(history) {
  if (history.request?.interval !== 'ONE_MINUTE') throw new Error('Saved history uses five-minute candles. Download one-minute history first.');
  if (await checksum(history.candles) !== history.sha256) throw new Error('Saved history checksum mismatch. Download history again.');
  const symbol = history.instrument?.symbol?.replace(/-EQ$/, '');
  if (!validSymbol(symbol)) throw new Error('Saved history has an invalid NSE ticker.');
  const { bars } = validateBars(history.candles?.map(bar => [Date.parse(bar.at), bar.open, bar.high, bar.low, bar.close, bar.volume]));
  const sha256 = await checksum(bars);
  return {
    id: `angel-${symbol}-${sha256}`, symbol, bars, sha256, count: bars.length,
    name: `${symbol} · Angel One history`, source: history.source, adjustment: 'unknown',
    from: dayOf(bars[0][0]), through: dayOf(bars.at(-1)[0]), localOnly: true
  };
}

export const localBacktest = {
  async initialize() {
    const state = await api('/api/state');
    return { bots: state.bots, risk: Object.fromEntries(
      ['initialCash', 'maxTradeRisk', 'dailyLossLimit', 'maxDailyTrades', 'maxPosition'].map(key => [key, state.settings[key]])
    ) };
  },
  async savedHistory() { return historyDataset(await api('/api/backtests/history')); },
  async download({ botId, symbol, days }) {
    const run = await api('/api/backtest', { botId, symbol: symbol.trim().toUpperCase(), days, downloadOnly: true });
    return historyDataset(run.dataset);
  }
};
