import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from './broker.js';

export const smartApiCallbackPath = '/auth/smartapi/callback';
export const smartApiCookie = 'tradegrok_smartapi_login';
export const smartApiCookiePath = '/auth/smartapi/';

export function smartApiOrigin(value, { local = false } = {}) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('SmartAPI origin must be a valid origin URL.'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (local ? url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
        Number(url.port) < 1024 || Number(url.port) > 65535 : url.protocol !== 'https:' || url.port)) {
    throw new Error(local ? 'Local return origin must be http://127.0.0.1:<PORT> with no path.' : 'SmartAPI relay origin must be a public HTTPS origin with no port or path.');
  }
  return url.origin;
}

export function smartApiTokens(params) {
  if (params.has('error') || params.has('errorcode')) {
    throw new AppError('Angel One login was not completed. Start a new login.', 400, 'SMARTAPI_LOGIN');
  }
  const token = name => {
    const values = params.getAll(name);
    if (values.length !== 1 || !values[0] || values[0].length > 8192 || /[\s\x00-\x1f\x7f]/.test(values[0])) {
      throw new AppError('SmartAPI callback is missing valid tokens. Start a new login.', 400, 'SMARTAPI_TOKENS');
    }
    return values[0];
  };
  return { authToken: token('auth_token'), feedToken: token('feed_token') };
}

const matches = (value, expected) => {
  const supplied = Buffer.from(value || '');
  const target = Buffer.from(expected);
  return supplied.length === target.length && timingSafeEqual(supplied, target);
};

export class SmartAPI {
  constructor({ apiKey = '', now = () => Date.now(), sessionStore = null } = {}) {
    this.apiKey = apiKey.trim();
    this.now = now;
    this.pending = null;
    this.sessionStore = sessionStore;
    this.session = this.sessionStore?.load() ?? null;
    this.restored = Boolean(this.session);
  }
  expire() {
    if (this.session && this.now() >= this.session.expiresAt) {
      this.session = null;
      this.restored = false;
      this.sessionStore?.clear();
    }
    if (this.pending && this.now() >= this.pending.expiresAt) this.pending = null;
  }
  status(callbackUrl) {
    this.expire();
    return {
      configured: Boolean(this.apiKey), callbackUrl,
      status: this.session ? 'callback_received' : this.pending ? 'awaiting_login' : this.apiKey ? 'ready' : 'not_configured',
      receivedAt: this.session ? new Date(this.session.receivedAt).toISOString() : null,
      expiresAt: this.session ? new Date(this.session.expiresAt).toISOString() : null,
      historicalVerifiedAt: this.session?.historicalVerifiedAt || null,
      persisted: Boolean(this.session && this.sessionStore), restored: Boolean(this.session && this.restored),
      message: this.session ? this.session.historicalVerifiedAt
        ? 'Angel One historical-data access verified. Verify the account below to use actual quotes for paper trading. Live orders remain unavailable.'
        : `${this.restored ? 'Saved SmartAPI session restored for today.' : 'SmartAPI callback received.'} Verify read-only account access below before using actual quotes. ${this.sessionStore ? 'Tokens are retained in a private local file until midnight IST.' : 'Tokens stay in server memory.'} Live orders remain unavailable.`
        : this.pending ? 'Complete login on Angel One within five minutes, in this browser.'
        : this.apiKey ? 'Register the callback URL in SmartAPI MyApps, then start login here.'
        : 'Set SMARTAPI_API_KEY in your local .env and restart. Register the callback URL in SmartAPI MyApps.'
    };
  }
  start(callbackUrl) {
    this.expire();
    if (!this.apiKey) throw new AppError('SmartAPI API key is not configured. Set SMARTAPI_API_KEY locally and restart.', 503, 'SMARTAPI_NOT_CONFIGURED');
    const state = randomBytes(32).toString('hex');
    const browser = randomBytes(32).toString('hex');
    this.pending = { state, browser, callbackUrl, expiresAt: this.now() + 300000 };
    const url = new URL('https://smartapi.angelone.in/publisher-login');
    url.search = new URLSearchParams({ api_key: this.apiKey, redirect_url: callbackUrl, state }).toString();
    return { loginUrl: url.toString(), browser };
  }
  receive(url, cookie) {
    this.expire();
    const pending = this.pending;
    const cookies = (cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${smartApiCookie}=`));
    const state = url.searchParams.getAll('state');
    if (!pending || this.now() >= pending.expiresAt || state.length !== 1 ||
        !matches(state[0], pending.state) || cookies.length !== 1 ||
        !matches(cookies[0].slice(smartApiCookie.length + 1), pending.browser) ||
        `${url.origin}${url.pathname}` !== pending.callbackUrl) {
      throw new AppError('SmartAPI callback is invalid or expired. Start a new login from Broker connection.', 403, 'SMARTAPI_STATE');
    }
    this.pending = null;
    const { authToken, feedToken } = smartApiTokens(url.searchParams);
    const receivedAt = this.now();
    // SmartAPI sessions end at midnight IST; these tokens are not verified here.
    const offset = 19800000;
    const expiresAt = (Math.floor((receivedAt + offset) / 86400000) + 1) * 86400000 - offset;
    const session = { authToken, feedToken, receivedAt, expiresAt };
    this.sessionStore?.save(session);
    this.session = session;
    this.restored = false;
  }
  receiveRelay(input, cookie, callbackUrl) {
    if (!input || !['state', 'auth_token', 'feed_token', 'error'].every(name =>
      input[name] === undefined || typeof input[name] === 'string')) {
      throw new AppError('SmartAPI relay payload is invalid.', 400, 'SMARTAPI_TOKENS');
    }
    const url = new URL(callbackUrl);
    for (const name of ['state', 'auth_token', 'feed_token', 'error']) {
      if (input[name] !== undefined) url.searchParams.set(name, input[name]);
    }
    this.receive(url, cookie);
  }
  clear({ keepSavedSession = false } = {}) {
    this.pending = null;
    this.session = null;
    this.restored = false;
    if (!keepSavedSession) this.sessionStore?.clear();
  }
}
