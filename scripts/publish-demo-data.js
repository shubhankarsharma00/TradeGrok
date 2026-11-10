import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseCsv, checksum, coverage, symbols } from '../demo/data.js';

const [rightsReference] = process.argv.slice(2);
if (!rightsReference?.trim() || rightsReference.length > 500) throw new Error('Pass a verified redistribution-rights reference, not an API key: npm run demo:publish-data -- \"license/reference\". Do not publish without permission.');
const source = resolve('data/demo-export'), output = resolve('demo/bundles');
const manifest = JSON.parse(await readFile(resolve(source, 'manifest.json'), 'utf8'));
if (manifest.version !== 1 || manifest.datasets?.length !== symbols.length) throw new Error('Expected the complete ten-stock private export.');
const verified = [];
for (const symbol of symbols) {
  const meta = manifest.datasets.find(d => d.symbol === symbol);
  if (!meta || meta.file !== `${symbol}.csv` || !meta.complete || meta.from !== '2026-08-01' || meta.through !== '2026-10-31') throw new Error(`Invalid bundle metadata for ${symbol}.`);
  const { bars } = parseCsv(await readFile(resolve(source, meta.file), 'utf8'));
  if (await checksum(bars) !== meta.sha256 || coverage(bars, { from: meta.from, through: meta.through }).issues.length) throw new Error(`${symbol}: coverage or checksum verification failed.`);
  verified.push({ ...meta, redistribution: rightsReference });
}
await mkdir(output, { recursive: true });
for (const meta of verified) await copyFile(resolve(source, meta.file), resolve(output, meta.file));
await writeFile(resolve(output, 'manifest.json'), JSON.stringify({ version: 1, datasets: verified }, null, 2));
console.log('Validated market CSVs added to demo/bundles. Review their redistribution reference before committing.');
