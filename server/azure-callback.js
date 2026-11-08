import { createServer } from 'node:http';
import { AppError } from './broker.js';
import { securityHeaders } from './http.js';
import { smartApiCallbackPath, smartApiOrigin, smartApiRelayDestination } from './smartapi-relay.js';

export function azureConfig(env) {
  const publicOrigin = smartApiOrigin(env.PUBLIC_ORIGIN);
  if (!env.WEBSITE_SITE_NAME || new URL(publicOrigin).hostname !== env.WEBSITE_HOSTNAME) {
    throw new Error('Azure relay requires App Service and PUBLIC_ORIGIN matching its WEBSITE_HOSTNAME.');
  }
  return {
    publicOrigin,
    localReturnOrigin: smartApiOrigin(env.LOCAL_RETURN_ORIGIN || 'http://127.0.0.1:3100', { local: true })
  };
}

export function createAzureCallback(config) {
  const returnOrigin = smartApiOrigin(config.localReturnOrigin, { local: true });
  const publicOrigin = smartApiOrigin(config.publicOrigin);
  return createServer((req, res) => {
    securityHeaders(res);
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      if (req.headers.host !== new URL(publicOrigin).host || !req.url.startsWith('/') || req.url.startsWith('//')) {
        throw new AppError('Unexpected request host or URL.', 403, 'AZURE_HOST');
      }
      const url = new URL(req.url, publicOrigin);
      if (req.method === 'GET' && url.pathname === '/healthz') return json(200, { status: 'ok' });
      if (url.pathname !== smartApiCallbackPath) throw new AppError('Endpoint not found.', 404, 'NOT_FOUND');
      if (req.method !== 'GET') throw new AppError('SmartAPI relay requires GET.', 405);
      if (req.headers['x-forwarded-proto'] !== 'https') throw new AppError('HTTPS through Azure App Service is required.', 403, 'AZURE_HTTPS');
      res.writeHead(303, { Location: smartApiRelayDestination(url, returnOrigin) });
      res.end();
    } catch (error) {
      const known = error instanceof AppError;
      if (!known) console.error('Azure relay request failed:', error.name);
      json(known ? error.status : 500, { error: known ? error.message : 'The relay operation did not complete.', code: known ? error.code : 'INTERNAL' });
    }
  });
}
