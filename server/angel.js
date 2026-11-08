import { AppError } from './broker.js';
import { SmartHistory } from './history.js';
import { isNseSymbol } from './store.js';

const numeric = value => (typeof value === 'number' || (typeof value === 'string' && value.trim())) ? Number(value) : NaN;

export function exchangeTime(value) {
  const match = typeof value === 'string' && value.match(/^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return NaN;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].findIndex(item => item.toLowerCase() === match[2].toLowerCase());
  const day = Number(match[1]), year = Number(match[3]), hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);
  if (month < 0 || hour > 23 || minute > 59 || second > 59) return NaN;
  const date = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return NaN;
  return date.getTime() - 19800000;
}

export class AngelOne extends SmartHistory {
  constructor(smartapi, options = {}) {
    super(smartapi, options);
    this.health = { status: 'unverified', message: 'Login with Angel One, then verify read-only account access.', checkedAt: null };
    this.account = null;
    this.accountFetchedAt = 0;
    this.verifiedSession = null;
    this.healthSession = null;
    this.tokens = new Map();
  }
  status() {
    this.smartapi.expire();
    if (this.smartapi.session !== this.healthSession) this.healthSession = null;
    if (!this.smartapi.session || this.smartapi.session !== this.verifiedSession) {
      this.account = null;
      this.accountFetchedAt = 0;
      this.verifiedSession = null;
      if (this.smartapi.session && this.smartapi.session === this.healthSession && this.health.status === 'error') {
        return { ...this.health, expiresAt: new Date(this.smartapi.session.expiresAt).toISOString() };
      }
      return {
        status: !this.smartapi.apiKey ? 'not_configured' : this.smartapi.session ? 'unverified' : 'awaiting_login',
        message: 'Login with Angel One and verify read-only access before selecting actual quotes.',
        checkedAt: null, expiresAt: this.smartapi.session ? new Date(this.smartapi.session.expiresAt).toISOString() : null
      };
    }
    return { ...this.health, expiresAt: new Date(this.verifiedSession.expiresAt).toISOString() };
  }
  async connect() {
    this.smartapi.expire();
    if (!this.smartapi.apiKey) throw new AppError('Angel One API key is not configured. Set SMARTAPI_API_KEY locally and restart.', 503, 'SMARTAPI_NOT_CONFIGURED');
    if (!this.smartapi.session) throw new AppError('Login with Angel One before verifying account access.', 401, 'SMARTAPI_AUTH');
    const session = this.smartapi.session;
    try {
      const metadata = await this.clientMetadata();
      const holdings = await this.request('holdings', undefined, metadata);
      const positions = await this.request('positions', undefined, metadata);
      if (this.smartapi.session !== session) throw new AppError('Angel One session changed during verification. Login again.', 401, 'SMARTAPI_AUTH');
      const project = (row, position) => {
        const quantity = numeric(position ? row?.netqty : row?.quantity);
        const averagePrice = numeric(position ? row?.netprice : row?.averageprice);
        const realisedPnl = position ? numeric(row?.realised) : null;
        if (!row || typeof row.tradingsymbol !== 'string' || !row.tradingsymbol ||
            !Number.isInteger(quantity) || (!position && quantity < 0) ||
            !Number.isFinite(averagePrice) || averagePrice < 0 ||
            (position && (!Number.isFinite(realisedPnl) || typeof row.producttype !== 'string'))) {
          throw new AppError('Angel One returned malformed portfolio rows. No account data was substituted.', 502, 'SMARTAPI_RESPONSE');
        }
        return { symbol: row.tradingsymbol, quantity, averagePrice, ...(position ? { realisedPnl, product: row.producttype } : {}) };
      };
      const checkedAt = new Date(this.now()).toISOString();
      if (positions.some(row => !row || typeof row.exchange !== 'string' || typeof row.tradingsymbol !== 'string')) {
        throw new AppError('Angel One returned malformed position identifiers.', 502, 'SMARTAPI_RESPONSE');
      }
      const account = { source: 'angel', checkedAt, holdings: holdings.map(row => project(row, false)), positions: positions.filter(row => row.exchange === 'NSE' && row.tradingsymbol.endsWith('-EQ')).map(row => project(row, true)) };
      this.account = account;
      this.accountFetchedAt = this.now();
      this.verifiedSession = session;
      this.healthSession = session;
      this.health = { status: 'connected', message: 'Angel One account verified. Actual quotes are available for paper execution only.', checkedAt };
      return account;
    } catch (error) {
      this.account = null;
      this.accountFetchedAt = 0;
      this.verifiedSession = null;
      this.health = { status: 'error', message: error instanceof AppError ? error.message : 'Angel One verification failed internally. No account data was substituted.', checkedAt: new Date(this.now()).toISOString() };
      this.healthSession = session;
      throw error;
    }
  }
  async quote(symbol) {
    if (this.status().status !== 'connected') throw new AppError('Verify Angel One account access before using actual quotes.', 409, 'SMARTAPI_AUTH');
    if (!isNseSymbol(symbol)) throw new AppError('Invalid NSE cash ticker.', 400, 'SMARTAPI_INSTRUMENT');
    const session = this.smartapi.session;
    try {
      const metadata = await this.clientMetadata();
      const token = await this.resolveSymbol(symbol);
      const data = await this.request('quotes', { mode: 'FULL', exchangeTokens: { NSE: [token] } }, metadata);
      if (!Array.isArray(data.fetched) || !Array.isArray(data.unfetched) || data.unfetched.length ||
          data.fetched.length !== 1 || data.fetched[0]?.exchange !== 'NSE' ||
          String(data.fetched[0].symbolToken) !== token || data.fetched[0].tradingSymbol !== `${symbol}-EQ`) {
        throw new AppError('Angel One returned missing, ambiguous or mismatched quotes. No substitute prices.', 502, 'SMARTAPI_RESPONSE');
      }
      const row = data.fetched[0], at = exchangeTime(row.exchFeedTime);
      if (typeof row.ltp !== 'number' || !Number.isFinite(row.ltp) || row.ltp <= 0 || !Number.isFinite(at)) {
        throw new AppError('Angel One quote is missing a valid price or exchange timestamp.', 502, 'SMARTAPI_RESPONSE');
      }
      if (this.smartapi.session !== session) throw new AppError('Angel One session changed during quote retrieval.', 401, 'SMARTAPI_AUTH');
      return { symbol, price: row.ltp, changePct: Number.isFinite(row.percentChange) ? row.percentChange : null, at: new Date(at).toISOString(), fetchedAt: new Date(this.now()).toISOString(), source: 'angel' };
    } catch (error) {
      if (error.code === 'SMARTAPI_AUTH') this.health = { status: 'error', message: error.message, checkedAt: new Date(this.now()).toISOString() };
      throw error;
    }
  }
  async searchSymbols(query) {
    this.smartapi.expire();
    if (!this.smartapi.session) throw new AppError('Login with Angel One to search NSE tickers.', 401, 'SMARTAPI_AUTH');
    if (!isNseSymbol(query)) throw new AppError('Enter a valid NSE ticker or ticker prefix.', 400, 'SMARTAPI_INSTRUMENT');
    const metadata = await this.clientMetadata();
    const rows = await this.request('search', { exchange: 'NSE', searchscrip: query }, metadata);
    const matches = new Map();
    for (const row of rows) {
      if (!row || typeof row.exchange !== 'string' || typeof row.tradingsymbol !== 'string') throw new AppError('Angel One returned malformed instrument search rows.', 502, 'SMARTAPI_INSTRUMENT');
      if (row.exchange !== 'NSE' || !row.tradingsymbol.endsWith('-EQ')) continue;
      const symbol = row.tradingsymbol.slice(0, -3);
      if (!isNseSymbol(symbol) || !/^\d+$/.test(row.symboltoken)) throw new AppError('Angel One returned malformed NSE instrument identifiers.', 502, 'SMARTAPI_INSTRUMENT');
      const token = String(row.symboltoken);
      if (matches.has(symbol) && matches.get(symbol).token !== token) throw new AppError('Angel One returned ambiguous NSE instrument tokens. Retry the search.', 502, 'SMARTAPI_INSTRUMENT');
      matches.set(symbol, { symbol, name: row.tradingsymbol, token });
    }
    return [...matches.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  }
  async resolveSymbol(symbol) {
    this.smartapi.expire();
    if (!this.smartapi.session) throw new AppError('Login with Angel One before resolving an NSE ticker.', 401, 'SMARTAPI_AUTH');
    if (!isNseSymbol(symbol)) throw new AppError('Invalid NSE cash ticker.', 400, 'SMARTAPI_INSTRUMENT');
    if (!this.tokens.has(symbol)) {
      const matches = (await this.searchSymbols(symbol)).filter(item => item.symbol === symbol);
      if (matches.length !== 1) throw new AppError('Angel One did not resolve one exact NSE -EQ instrument for this ticker. Choose a search result.', 422, 'SMARTAPI_INSTRUMENT');
      this.tokens.set(symbol, matches[0].token);
    }
    return this.tokens.get(symbol);
  }
}
