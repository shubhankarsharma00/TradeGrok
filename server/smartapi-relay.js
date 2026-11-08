import { AppError } from './broker.js';

export const smartApiCallbackPath = '/auth/smartapi/callback';

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

export function smartApiRelayDestination(url, returnOrigin) {
  const states = url.searchParams.getAll('state');
  if (states.length !== 1 || !/^[a-f0-9]{64}$/.test(states[0])) throw new AppError('Invalid SmartAPI relay state.', 400, 'SMARTAPI_STATE');
  const fragment = new URLSearchParams({ state: states[0] });
  try {
    const { authToken, feedToken } = smartApiTokens(url.searchParams);
    fragment.set('auth_token', authToken);
    fragment.set('feed_token', feedToken);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    fragment.set('error', 'login_incomplete');
  }
  // Top-level navigation; fragments never enter the local GET request.
  const destination = new URL('/auth/smartapi/return', smartApiOrigin(returnOrigin, { local: true }));
  destination.hash = fragment.toString();
  return destination.toString();
}
