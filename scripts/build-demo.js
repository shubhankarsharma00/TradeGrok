import { mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, checksum, coverage, symbols } from '../demo/data.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist-demo');
const measurementId = process.env.DEMO_GA_MEASUREMENT_ID ?? '';
if (measurementId && !/^G-[A-Z0-9]+$/.test(measurementId)) throw new Error('Invalid GA4 measurement ID.');
if (measurementId && process.env.DEMO_GA_DEPLOYMENT_REVIEWED !== 'yes') throw new Error('Confirm applicable legal/Google requirements and disable enhanced measurement in GA4, then set DEMO_GA_DEPLOYMENT_REVIEWED=yes.');
await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, 'demo'), { recursive: true });
for (const name of ['index.html', 'rulebook.html']) await cp(resolve(root, 'demo', name), resolve(output, name));
for (const name of ['app.js', 'data.js', 'defaults.js', 'engine.js', 'worker.js', 'storage.js', 'analytics.js', 'demo.css']) await cp(resolve(root, 'demo', name), resolve(output, 'demo', name));
await writeFile(resolve(output, 'demo/config.js'), `export const analyticsConfig = ${JSON.stringify({ enabled: Boolean(measurementId), measurementId })};\n`);
await mkdir(resolve(output, 'shared'), { recursive: true });
await cp(resolve(root, 'shared/signals.js'), resolve(output, 'shared/signals.js'));
for (const name of ['theme.js', 'favicon.svg']) await cp(resolve(root, 'public', name), resolve(output, name));
await cp(resolve(root, 'public/fonts'), resolve(output, 'fonts'), { recursive: true });
const css = await readFile(resolve(root, 'public/styles.css'), 'utf8');
await writeFile(resolve(output, 'styles.css'), css.replaceAll('url("/fonts/', 'url("./fonts/'));
const manifest = JSON.parse(await readFile(resolve(root, 'demo/bundles/manifest.json'), 'utf8'));
if (manifest.version !== 1 || !Array.isArray(manifest.datasets)) throw new Error('Invalid static bundle manifest.');
if (manifest.localOnly) throw new Error('Private preview data must not be included in the public build.');
await mkdir(resolve(output, 'demo/bundles'), { recursive: true });
for (const meta of manifest.datasets) {
  if (!symbols.includes(meta.symbol) || meta.file !== `${meta.symbol}.csv` || !meta.redistribution || meta.redistribution === 'NOT_APPROVED') throw new Error('Only explicitly licensed allowlisted CSVs may be bundled.');
  const text = await readFile(resolve(root, 'demo/bundles', meta.file), 'utf8');
  const { bars } = parseCsv(text);
  if (await checksum(bars) !== meta.sha256 || coverage(bars, { from: meta.from, through: meta.through }).issues.length) throw new Error('Bundled dataset checksum or coverage failed.');
  await writeFile(resolve(output, 'demo/bundles', meta.file), text);
}
await writeFile(resolve(output, 'demo/bundles/manifest.json'), JSON.stringify(manifest));
console.log(`Static demo built in dist-demo/. Analytics ${measurementId ? 'configured for public deployment' : 'not configured (measurement ID required)'}. No server, credentials or private export data included.`);
