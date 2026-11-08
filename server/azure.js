import { azureConfig, createAzureCallback } from './azure-callback.js';
import { smartApiCallbackPath } from './smartapi-relay.js';

const config = azureConfig(process.env);
const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer between 1024 and 65535.');
const server = createAzureCallback(config);
server.on('error', error => {
  console.error(`Azure callback service could not start (${error.code}).`);
  process.exitCode = 1;
});
server.listen(port, '0.0.0.0', () => {
  console.log(`SmartAPI callback relay: ${config.publicOrigin}${smartApiCallbackPath} | Fixed loopback return; no token storage or trading dashboard`);
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const closed = new Promise(resolve => server.close(resolve));
  server.closeIdleConnections();
  await closed;
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
