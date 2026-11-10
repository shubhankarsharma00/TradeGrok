import { createServer } from 'node:http';
import { readFile, lstat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { bundleManifest, parseCsv, checksum, coverage } from '../demo/data.js';
const root = resolve('dist-demo');
const port = Number(process.env.DEMO_PORT ?? 4173);
const base = process.env.DEMO_BASE_PATH ?? '/';
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--private-data')) throw new Error('Usage: npm run demo:serve -- [--private-data]');
if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base)) throw new Error('DEMO_BASE_PATH must be a slash-delimited path ending in /.');
const privateData = args.includes('--private-data'), privateAssets = new Map();
if (privateData) {
  const directory = resolve('data/demo-export');
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Private preview requires a regular data/demo-export directory.');
  async function privateFile(name) {
    const path = resolve(directory, name), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 100 * 1024 * 1024 ||
        (process.getuid && stat.uid !== process.getuid())) throw new Error(`Unsafe private export: ${name}.`);
    return readFile(path, 'utf8');
  }
  const manifest = JSON.parse(await privateFile('manifest.json'));
  if (manifest.version !== 1 || !Array.isArray(manifest.datasets) || manifest.datasets.length !== bundleManifest.length) throw new Error('Private preview requires the complete ten-stock export.');
  const datasets = [];
  for (const expected of bundleManifest) {
    const meta = manifest.datasets.find(item => item.symbol === expected.symbol);
    if (!meta || meta.file !== `${expected.symbol}.csv` || !meta.complete ||
        meta.from !== expected.from || meta.through !== expected.through) throw new Error(`Invalid private export metadata for ${expected.symbol}.`);
    const text = await privateFile(meta.file), { bars } = parseCsv(text);
    if (await checksum(bars) !== meta.sha256 || bars.length !== meta.count ||
        coverage(bars, { from: meta.from, through: meta.through }).issues.length) throw new Error(`Private export validation failed for ${expected.symbol}.`);
    privateAssets.set(`demo/bundles/${meta.file}`, text);
    datasets.push(Object.fromEntries(['symbol', 'file', 'from', 'through', 'source', 'adjustment', 'sha256', 'count', 'redistribution'].map(key => [key, meta[key]])));
  }
  privateAssets.set('demo/bundles/manifest.json', JSON.stringify({ version: 1, localOnly: true, datasets }));
}
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.csv': 'text/csv', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };
const server = createServer(async (req, res) => {
  try {
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' || !url.pathname.startsWith(base)) { res.writeHead(404).end(); return; }
    const relative = decodeURIComponent(url.pathname.slice(base.length)) || 'index.html';
    const path = resolve(root, relative);
    if (!path.startsWith(root + sep)) { res.writeHead(404).end(); return; }
    if (privateAssets.has(relative) && (req.headers['sec-fetch-site'] === 'cross-site' ||
        (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`))) { res.writeHead(403).end(); return; }
    const body = privateAssets.has(relative) ? privateAssets.get(relative) : await readFile(path);
    res.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...(privateData ? { 'Cache-Control': 'no-store' } : {}) }).end(body);
  } catch (error) {
    if (['ENOENT', 'EISDIR'].includes(error.code) || error instanceof URIError) res.writeHead(404).end();
    else { console.error('Static preview read failed:', error.code ?? error.name); res.writeHead(500).end(); }
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Static preview: http://127.0.0.1:${server.address().port}${base}`);
  if (privateData) console.log('Private local candles enabled. No files copied into dist-demo/ or approved for public redistribution.');
});
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => server.close());
