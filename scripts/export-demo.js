import { resolve } from 'node:path';
import { SmartAPI } from '../server/smartapi.js';
import { SessionFile } from '../server/session-file.js';
import { SmartHistory } from '../server/history.js';
import { exportDemoData } from '../server/demo-export.js';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--probe')) throw new Error('Usage: npm run demo:export -- [--probe]. Output is private data/demo-export/.');
const apiKey = process.env.SMARTAPI_API_KEY ?? '';
if (!apiKey) throw new Error('Configure SMARTAPI_API_KEY in local .env, then log in through the existing local app. Never paste credentials into chat.');
const dataDir = resolve(process.env.TRADEGROK_DATA_DIR ?? 'data');
const smartapi = new SmartAPI({ apiKey, sessionStore: new SessionFile(resolve(dataDir, 'private/smartapi-session.json'), apiKey) });
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());
try {
  await exportDemoData(new SmartHistory(smartapi), resolve('data/demo-export'), { signal: controller.signal, probe: args.includes('--probe') });
  console.log(args.includes('--probe') ? 'Historical probe passed. Ready for the full private export.' : 'Private export complete. Publication requires confirmed redistribution rights.');
} catch (error) { console.error(`Export stopped: ${error.message}`); process.exitCode = 1; }
finally { smartapi.clear({ keepSavedSession: true }); }
