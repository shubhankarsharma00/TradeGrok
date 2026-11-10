import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseCsv, checksum, coverage, symbols } from '../demo/data.js';

const args = process.argv.slice(2);
const synthetic = args[0] === '--synthetic';
if (synthetic && args.length !== 3) throw new Error('Usage: npm run demo:publish-data -- --synthetic /path/to/csvs "publication permission reference"');
const rightsReference = synthetic ? args[2] : args[0];
if (!rightsReference?.trim() || rightsReference.length > 500) throw new Error('Pass a verified redistribution-rights reference, not an API key: npm run demo:publish-data -- \"license/reference\". Do not publish without permission.');
const source = resolve(synthetic ? args[1] : 'data/demo-export'), output = resolve('demo/bundles');
const manifest = synthetic ? { version: 1, datasets: symbols.map(symbol => ({
  symbol, file: `${symbol}.csv`, from: '2026-08-01', through: '2026-10-31',
  synthetic: true, source: 'Synthetic demo data supplied by the publisher; not real market history',
  adjustment: 'unknown', complete: true
})) } : JSON.parse(await readFile(resolve(source, 'manifest.json'), 'utf8'));
if (manifest.version !== 1 || manifest.datasets?.length !== symbols.length) throw new Error('Expected the complete ten-stock private export.');
const verified = [];
for (const symbol of symbols) {
  const meta = manifest.datasets.find(d => d.symbol === symbol);
  if (!meta || meta.file !== `${symbol}.csv` || !meta.complete || meta.from !== '2026-08-01' || meta.through !== '2026-10-31') throw new Error(`Invalid bundle metadata for ${symbol}.`);
  const { bars, duplicates, reordered } = parseCsv(await readFile(resolve(source, meta.file), 'utf8'));
  const sha256 = await checksum(bars), prepared = coverage(bars, { from: meta.from, through: meta.through });
  if ((!synthetic && sha256 !== meta.sha256) || prepared.issues.length || (synthetic && (duplicates || reordered))) throw new Error(`${symbol}: coverage, ordering or checksum verification failed.`);
  verified.push({ ...meta, sha256, count: bars.length, sessionCount: prepared.sessions.length, excludedBars: prepared.outside, redistribution: rightsReference });
}
await mkdir(output, { recursive: true });
for (const meta of verified) await copyFile(resolve(source, meta.file), resolve(output, meta.file));
await writeFile(resolve(output, 'manifest.json'), JSON.stringify({ version: 1, datasets: verified }, null, 2));
console.log('Validated market CSVs added to demo/bundles. Review their redistribution reference before committing.');
