import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { AngelOne } from './angel.js';
import { createApp } from './app.js';
import { SmartAPI, smartApiCallbackPath, smartApiOrigin } from './smartapi.js';
import { SessionFile } from './session-file.js';
import { AnalysisLog } from './analysis-log.js';

const port = Number(process.env.PORT || 3100);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer between 1024 and 65535.');
const relayOrigin = process.env.SMARTAPI_RELAY_ORIGIN ? smartApiOrigin(process.env.SMARTAPI_RELAY_ORIGIN) : '';
const store = new Store(fileURLToPath(new URL('../data/tradegrok.sqlite', import.meta.url)));
const apiKey = process.env.SMARTAPI_API_KEY || '';
const sessionStore = new SessionFile(fileURLToPath(new URL('../data/private/smartapi-session.json', import.meta.url)), apiKey);
const smartapi = new SmartAPI({ apiKey, sessionStore });
const broker = new AngelOne(smartapi);
const analysisLog = new AnalysisLog(fileURLToPath(new URL('../data/logs/', import.meta.url)));
const { server, engine } = createApp(store, broker, { smartapi, history: broker, smartapiRelayOrigin: relayOrigin, analysisLog });
let timer;
server.on('error', error => { console.error(`TradeGrok could not start (${error.code}).`); store.close(); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`TradeGrok: http://127.0.0.1:${port} | Paper execution only | Angel One credentials stay on the server`);
  console.log(`SmartAPI callback: ${relayOrigin || `http://127.0.0.1:${port}`}${smartApiCallbackPath}`);
  void engine.tick();
  timer = setInterval(() => { void engine.tick(); }, 5000);
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  const closed = new Promise(resolve => server.close(resolve));
  server.closeIdleConnections();
  while (engine.busy) await new Promise(resolve => setTimeout(resolve, 50));
  await closed;
  smartapi.clear({ keepSavedSession: true });
  store.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
