import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { AppError } from './broker.js';
import { sessionSchedule, prepareCandles } from './backtest.js';
import { isNseSymbol } from './store.js';

const endpoints = {
  search: '/rest/secure/angelbroking/order/v1/searchScrip',
  candles: '/rest/secure/angelbroking/historical/v1/getCandleData',
  holdings: '/rest/secure/angelbroking/portfolio/v1/getHolding',
  positions: '/rest/secure/angelbroking/order/v1/getPosition',
  quotes: '/rest/secure/angelbroking/market/v1/quote'
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const responseErrors = {
  AG8001: 'Angel One rejected the session. Sign in again.',
  AG8002: 'Angel One expired the session. Sign in again.',
  AG8003: 'Angel One rejected the session token. Sign in again.',
  AB8050: 'Angel One rejected authentication. Sign in again.',
  AB2001: 'Angel One reported an internal service error. Retry later; an empty portfolio cannot be assumed.',
  AB1004: 'Angel One reported a service failure. Retry later; no substitute data was used.'
};
const authErrors = new Set(['AG8001', 'AG8002', 'AG8003', 'AB8050']);
const operationNames = { search: 'searchScrip', candles: 'getCandleData', holdings: 'getHolding', positions: 'getPosition', quotes: 'FULL quote' };

export class SmartHistory {
  constructor(smartapi, { fetchImpl = fetch, now = () => Date.now(), sleep = wait, metadata } = {}) {
    this.smartapi = smartapi;
    this.fetch = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.metadata = metadata;
    this.lastRequest = null;
    this.queue = Promise.resolve();
  }
  async clientMetadata() {
    if (this.metadata) return this.metadata;
    const local = Object.values(networkInterfaces()).flat().find(item =>
      item && !item.internal && item.family === 'IPv4' && item.mac !== '00:00:00:00:00:00');
    if (!local) throw new AppError('No usable local IPv4 network interface for SmartAPI request headers.', 503, 'SMARTAPI_NETWORK');
    let publicIP;
    try {
      const response = await this.fetch('https://api.ipify.org', { redirect: 'error', signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('Public IP lookup failed.');
      publicIP = (await response.text()).trim();
      if (isIP(publicIP) !== 4) throw new Error('Public IP lookup did not return IPv4.');
    } catch {
      throw new AppError('Could not determine public IPv4 for SmartAPI headers. Check your network and retry.', 503, 'SMARTAPI_NETWORK');
    }
    this.metadata = { localIP: local.address, publicIP, mac: local.mac };
    return this.metadata;
  }
  async request(operation, input, metadata) {
    const pending = this.queue.then(() => this.performRequest(operation, input, metadata));
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }
  async performRequest(operation, input, metadata) {
    if (!Object.hasOwn(endpoints, operation)) throw new AppError('SmartAPI operation is not allowed.', 403, 'LIVE_DISABLED');
    for (let attempt = 0; attempt < 3; attempt++) {
      this.smartapi.expire();
      const session = this.smartapi.session;
      if (!session) throw new AppError('Sign in with Angel One again in Broker connection before requesting data.', 401, 'SMARTAPI_AUTH');
      if (this.lastRequest !== null) await this.sleep(Math.max(0, 1100 - (this.now() - this.lastRequest)));
      this.smartapi.expire();
      if (this.smartapi.session !== session) throw new AppError('SmartAPI session changed or expired. Sign in again and retry.', 401, 'SMARTAPI_AUTH');
      this.lastRequest = this.now();
      let response;
      try {
        response = await this.fetch(`https://apiconnect.angelone.in${endpoints[operation]}`, {
          method: ['holdings', 'positions'].includes(operation) ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
          headers: {
            Authorization: `Bearer ${session.authToken}`, 'X-PrivateKey': this.smartapi.apiKey,
            Accept: 'application/json', 'Content-Type': 'application/json',
            'X-SourceID': 'WEB', 'X-UserType': 'USER',
            'X-ClientLocalIP': metadata.localIP, 'X-ClientPublicIP': metadata.publicIP, 'X-MACAddress': metadata.mac
          },
          ...(['holdings', 'positions'].includes(operation) ? {} : { body: JSON.stringify(input) })
        });
      } catch {
        throw new AppError('Unable to reach Angel One data services securely. No substitute data was used.', 502, 'SMARTAPI_NETWORK');
      }
      if ([403, 429].includes(response.status)) {
        if (attempt < 2) { await this.sleep(2000 * (attempt + 1)); continue; }
        throw new AppError('Angel One access/rate limit rejected data requests after bounded retries. Check account permissions or retry later.', 503, 'SMARTAPI_RATE_LIMIT');
      }
      if (response.status === 401) throw new AppError('Angel One rejected the session. Sign in again and retry.', 401, 'SMARTAPI_AUTH');
      if (!response.ok) throw new AppError(`Angel One data request failed (HTTP ${response.status}).`, 502, 'SMARTAPI_UNAVAILABLE');
      let payload;
      try { payload = await response.json(); }
      catch { throw new AppError(`Angel One ${operationNames[operation]} returned invalid data JSON (HTTP ${response.status}).`, 502, 'SMARTAPI_RESPONSE'); }
      const errorCode = payload?.errorcode ?? payload?.errorCode;
      const noError = errorCode === undefined || errorCode === null || errorCode === '';
      const conflictingCodes = payload?.errorcode != null && payload?.errorCode != null && payload.errorcode !== payload.errorCode;
      const emptyPortfolio = ['holdings', 'positions'].includes(operation) && payload?.data === null;
      const validData = operation === 'quotes' ? payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data) : Array.isArray(payload?.data) || emptyPortfolio;
      if (payload?.status !== true || !validData || !noError || conflictingCodes) {
        const known = typeof errorCode === 'string' && Object.hasOwn(responseErrors, errorCode);
        const dataShape = payload?.data === null ? 'null' : Array.isArray(payload?.data) ? 'array' : typeof payload?.data;
        const status = payload?.status === false ? 'reported failure' : payload?.status === true ? 'malformed success response' : 'invalid status';
        const diagnostic = `Angel One ${operationNames[operation]} ${status} (HTTP ${response.status}; ${known ? `code ${errorCode}` : noError ? 'no error code' : 'unrecognised error code'}; data ${dataShape}).`;
        throw new AppError(`${diagnostic} ${known ? responseErrors[errorCode] : 'Check account/data access and retry. No account or price data was substituted.'}`, authErrors.has(errorCode) ? 401 : 502, authErrors.has(errorCode) ? 'SMARTAPI_AUTH' : 'SMARTAPI_RESPONSE');
      }
      if (this.smartapi.session !== session) throw new AppError('SmartAPI session changed during data retrieval. Retry after signing in.', 401, 'SMARTAPI_AUTH');
      return emptyPortfolio ? [] : payload.data;
    }
  }
  async download(symbol, days, { interval = 'FIVE_MINUTE', schedules } = {}) {
    if (!isNseSymbol(symbol)) throw new AppError('Choose a valid NSE cash ticker.', 400, 'SMARTAPI_INSTRUMENT');
    if (!['FIVE_MINUTE', 'ONE_MINUTE'].includes(interval) || !Array.isArray(days) || !days.length ||
        days.some((day, index) => typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
          !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day ||
          (index > 0 && day <= days[index - 1]))) throw new AppError('Invalid historical interval or dates.', 400, 'SMARTAPI_RANGE');
    const span = (Date.parse(`${days.at(-1)}T00:00:00Z`) - Date.parse(`${days[0]}T00:00:00Z`)) / 86400000;
    if (interval === 'ONE_MINUTE' && (span > 6 || days[0] < istHistoryDay(this.now() - 6 * 86400000) || days.at(-1) > istHistoryDay(this.now()))) {
      throw new AppError('One-minute history is limited to the last seven IST calendar days.', 400, 'SMARTAPI_RANGE');
    }
    if (span > 99) throw new AppError('Five-minute history request exceeds the 100-day broker limit.', 400, 'SMARTAPI_RANGE');
    this.smartapi.expire();
    if (!this.smartapi.session) throw new AppError('Sign in with Angel One again in Broker connection before downloading history.', 401, 'SMARTAPI_AUTH');
    const metadata = await this.clientMetadata();
    const rows = await this.request('search', { exchange: 'NSE', searchscrip: symbol }, metadata);
    const matches = rows.filter(row => row?.exchange === 'NSE' && row.tradingsymbol === `${symbol}-EQ` && /^\d+$/.test(row.symboltoken));
    if (matches.length !== 1) throw new AppError('Angel One did not resolve one exact NSE cash-equity instrument. Backtest blocked.', 502, 'SMARTAPI_INSTRUMENT');
    const instrument = { exchange: 'NSE', symbol: matches[0].tradingsymbol, token: String(matches[0].symboltoken) };
    const request = {
      exchange: instrument.exchange, symboltoken: instrument.token, interval,
      fromdate: `${days[0]} ${schedules?.[days[0]]?.open ?? '09:15'}`, todate: `${days.at(-1)} ${schedules?.[days.at(-1)]?.sessionClose ?? sessionSchedule(days.at(-1)).sessionClose}`
    };
    const data = await this.request('candles', request, metadata);
    this.smartapi.session.historicalVerifiedAt = new Date(this.now()).toISOString();
    return { instrument, request, data, fetchedAt: new Date(this.now()).toISOString(), source: 'Angel One SmartAPI getCandleData' };
  }
}

  function istHistoryDay(now) { return new Date(now + 19800000).toISOString().slice(0, 10); }

  export async function downloadHistory(history, store, symbol, sessions) {
    const requested = new Set(sessions.all), byDay = new Map(), cachedSources = [];
    let instrument = null, fetchedAt = null;
    for (const saved of store.historyDatasets(symbol, sessions.from, sessions.through)) {
      if (!saved.sessions.all.some(day => requested.has(day) && !byDay.has(day))) continue;
      const rows = saved.dataset.candles.map(bar => [bar.at, bar.open, bar.high, bar.low, bar.close, bar.volume]);
      const prepared = prepareCandles(rows, saved.sessions);
      if (saved.sessions.intervalMinutes !== 1 || prepared.sha256 !== saved.dataset.sha256) {
        throw new AppError('Cached one-minute history checksum failed. Fetch fresh history using the downloadOnly API before retrying. No backtest was computed.', 422, 'BACKTEST_CANDLES');
      }
      if (prepared.unexpectedSessions.length) throw new AppError('Cached history contains unexpected trading sessions. No cached data was reused.', 422, 'BACKTEST_COVERAGE');
      const completeDays = prepared.coverage.filter(day => day.complete && requested.has(day.date) && !byDay.has(day.date)).map(day => day.date);
      if (!completeDays.length) continue;
      if (instrument && instrument.token !== saved.dataset.instrument.token) throw new AppError('Cached instrument tokens conflict. History cannot be safely combined.', 422, 'BACKTEST_INSTRUMENT');
      instrument = saved.dataset.instrument;
      fetchedAt ??= saved.dataset.fetchedAt;
      for (const day of completeDays) byDay.set(day, prepared.candles.filter(bar => bar.at.startsWith(day)).map(bar => [bar.at, bar.open, bar.high, bar.low, bar.close, bar.volume]));
      cachedSources.push({ id: saved.id, sha256: prepared.sha256, fetchedAt: saved.dataset.fetchedAt, sessions: completeDays });
      if (byDay.size === requested.size) break;
    }
    const reusedSessions = sessions.all.filter(day => byDay.has(day));
    const missing = sessions.all.filter(day => !byDay.has(day));
    const groups = [];
    for (const day of missing) {
      const last = groups.at(-1);
      if (last && sessions.all.indexOf(day) === sessions.all.indexOf(last.at(-1)) + 1) last.push(day);
      else groups.push([day]);
    }
    const downloads = [], downloadedRows = [];
    for (const days of groups) {
      const download = await history.download(symbol, days, { interval: 'ONE_MINUTE', schedules: sessions.schedules });
      if (download.request?.interval !== 'ONE_MINUTE' || download.instrument?.exchange !== 'NSE' ||
          download.instrument.symbol !== `${symbol}-EQ` || (instrument && instrument.token !== download.instrument.token)) {
        throw new AppError('Downloaded history does not match the cached NSE one-minute instrument. Data was not combined.', 422, 'BACKTEST_INSTRUMENT');
      }
      // Validate each actual response against its own range before combining it with local days.
      const window = { ...sessions, all: days, evaluated: days };
      prepareCandles(download.data, window);
      downloadedRows.push(...download.data);
      instrument = download.instrument;
      fetchedAt = download.fetchedAt;
      downloads.push({ request: download.request, fetchedAt: download.fetchedAt, sessions: days, source: download.source });
    }
    const fromdate = `${sessions.all[0]} ${sessions.schedules[sessions.all[0]].open}`;
    const todate = `${sessions.all.at(-1)} ${sessions.schedules[sessions.all.at(-1)].sessionClose}`;
    const from = Date.parse(fromdate.replace(' ', 'T') + ':00+05:30'), through = Date.parse(todate.replace(' ', 'T') + ':00+05:30');
    return {
      instrument, fetchedAt, source: reusedSessions.length ? 'Angel One SmartAPI getCandleData (local session cache)' : downloads[0].source,
      request: { exchange: instrument.exchange, symboltoken: instrument.token, interval: 'ONE_MINUTE', fromdate, todate },
      data: [...reusedSessions.flatMap(day => byDay.get(day)), ...downloadedRows].filter(row => Date.parse(row[0]) >= from && Date.parse(row[0]) <= through),
      cache: { reusedSessions, downloadedSessions: missing, cachedSources, downloads }
    };
  }
