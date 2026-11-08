import { AppError } from './broker.js';
import { securityHeaders } from './http.js';
import { smartApiCallbackPath, smartApiOrigin, smartApiRelayDestination } from './smartapi-relay.js';

function cloudflareConfig(env) {
  return {
    publicOrigin: smartApiOrigin(env.PUBLIC_ORIGIN),
    localReturnOrigin: smartApiOrigin(env.LOCAL_RETURN_ORIGIN || 'http://127.0.0.1:3100', { local: true })
  };
}

export default {
  fetch(request, env) {
    const headers = new Headers();
    securityHeaders({ setHeader: (name, value) => headers.set(name, value) });
    headers.set('Strict-Transport-Security', 'max-age=31536000');
    const json = (status, data) => {
      headers.set('Content-Type', 'application/json');
      return new Response(JSON.stringify(data), { status, headers });
    };
    try {
      const config = cloudflareConfig(env);
      const url = new URL(request.url);
      if (url.origin !== config.publicOrigin) throw new AppError('Unexpected request host or transport.', 403, 'CLOUDFLARE_ORIGIN');
      if (request.method === 'GET' && url.pathname === '/healthz') return json(200, { status: 'ok' });
      if (url.pathname !== smartApiCallbackPath) throw new AppError('Endpoint not found.', 404, 'NOT_FOUND');
      if (request.method !== 'GET') throw new AppError('SmartAPI relay requires GET.', 405);
      headers.set('Location', smartApiRelayDestination(url, config.localReturnOrigin));
      return new Response(null, { status: 303, headers });
    } catch (error) {
      const known = error instanceof AppError;
      if (!known) console.error('Cloudflare relay request failed:', error.name);
      return json(known ? error.status : 500, {
        error: known ? error.message : 'The relay operation did not complete.',
        code: known ? error.code : 'INTERNAL'
      });
    }
  }
};
