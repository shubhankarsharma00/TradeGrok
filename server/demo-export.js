import { mkdir, readFile, writeFile, rename, chmod, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseTimestamp, validateBars, coverage, checksum, candlesCsv, symbols } from '../demo/data.js';

export const exportScope = { from: '2026-08-01', through: '2026-10-31', symbols };
export const historyDocumentation = 'https://smartapi.angelone.in/docs/Historical';

export function exportChunks(from = exportScope.from, through = exportScope.through) {
  const chunks = [];
  for (let cursor = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${through}T00:00:00Z`); cursor <= end; cursor += 29 * 86400000) {
    chunks.push({ from: new Date(cursor).toISOString().slice(0, 10), through: new Date(Math.min(end, cursor + 28 * 86400000)).toISOString().slice(0, 10) });
  }
  return chunks;
}
async function privateWrite(path, body) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}
function normalize(rows, chunk) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Broker returned no candles. Historical access/retention cannot be assumed.');
  const parsed = validateBars(rows.map(row => {
    if (!Array.isArray(row) || row.length !== 6 || typeof row[0] !== 'string') throw new Error('Broker returned malformed candles.');
    return [parseTimestamp(row[0]), ...row.slice(1)];
  }));
  const start = Date.parse(`${chunk.from}T00:00:00+05:30`), end = Date.parse(`${chunk.through}T23:59:00+05:30`);
  if (parsed.bars.some(bar => bar[0] < start || bar[0] > end)) throw new Error('Broker returned candles outside the requested chunk.');
  return parsed.bars;
}
export async function exportDemoData(history, directory, { signal, probe = false, onProgress = console.log } = {}) {
  const checkCancelled = () => { if (signal?.aborted) throw new Error('Export cancelled. Completed private chunks are retained for resume.'); };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe private export directory. Use an owned, non-symlink directory.');
  await chmod(directory, 0o700);
  history.smartapi.expire();
  if (!history.smartapi.session) throw new Error('No current local Angel One session. Complete Broker connection login first.');
  const metadata = await history.clientMetadata();
  const published = [];
  for (const symbol of probe ? symbols.slice(0, 1) : symbols) {
    checkCancelled();
    onProgress(`${symbol}: resolving exact NSE equity instrument.`);
    const matches = (await history.request('search', { exchange: 'NSE', searchscrip: symbol }, metadata)).filter(row => row?.exchange === 'NSE' && row.tradingsymbol === `${symbol}-EQ` && /^\d+$/.test(row.symboltoken));
    if (matches.length !== 1) throw new Error(`${symbol}: expected one exact NSE -EQ instrument.`);
    const chunks = probe ? [{ from: '2026-08-03', through: '2026-08-03' }] : exportChunks();
    const all = [];
    for (const chunk of chunks) {
      checkCancelled();
      const path = resolve(directory, `${symbol}-${chunk.from}-${chunk.through}.chunk.json`);
      let cached;
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe cached chunk.');
        cached = JSON.parse(await readFile(path, { encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW }));
      }
      catch (error) { if (error.code !== 'ENOENT') throw new Error(`${symbol}: private chunk is unreadable/corrupt; inspect it before retrying.`); }
      let bars;
      if (cached) {
        if (cached.version !== 1 || cached.symbol !== symbol || cached.from !== chunk.from || cached.through !== chunk.through ||
            await checksum(cached.bars) !== cached.sha256) throw new Error(`${symbol}: cached chunk checksum/identity failed.`);
        bars = validateBars(cached.bars).bars;
        onProgress(`${symbol}: reused ${chunk.from} through ${chunk.through}.`);
      } else {
        onProgress(`${symbol}: downloading ${chunk.from} through ${chunk.through}.`);
        bars = normalize(await history.request('candles', { exchange: 'NSE', symboltoken: String(matches[0].symboltoken), interval: 'ONE_MINUTE', fromdate: `${chunk.from} 09:15`, todate: `${chunk.through} 15:35` }, metadata), chunk);
        checkCancelled();
        await privateWrite(path, JSON.stringify({ version: 1, symbol, ...chunk, bars, sha256: await checksum(bars) }));
      }
      all.push(...bars);
    }
    const bars = validateBars(all).bars;
    const range = probe ? chunks[0] : exportScope;
    const prepared = coverage(bars, { from: range.from, through: range.through });
    const record = { version: 1, symbol, from: range.from, through: range.through, source: 'Angel One SmartAPI getCandleData', adjustment: 'unadjusted', fetchedAt: new Date().toISOString(), sha256: await checksum(bars), count: bars.length, complete: prepared.issues.length === 0, issues: prepared.issues, excludedBars: prepared.outside, sessionCount: prepared.sessions.length, documentation: historyDocumentation, redistribution: 'NOT_APPROVED', file: `${symbol}.csv` };
    if (probe) {
      if (prepared.issues.length) throw new Error(`${symbol}: historical probe coverage failed: ${prepared.issues.slice(0, 3).join(' ')}`);
      onProgress(`${symbol}: historical access verified for one completed session. No public assets written.`);
      return record;
    }
    await privateWrite(resolve(directory, `${symbol}.csv`), candlesCsv(bars));
    await privateWrite(resolve(directory, `${symbol}.metadata.json`), JSON.stringify(record, null, 2));
    if (!record.complete) throw new Error(`${symbol}: private CSV saved, but coverage blocked: ${record.issues.slice(0, 3).join(' ')} No public bundle created.`);
    published.push(record);
    onProgress(`${symbol}: validated ${prepared.sessions.length} sessions, ${bars.length} rows. Private CSV saved.`);
  }
  await privateWrite(resolve(directory, 'manifest.json'), JSON.stringify({ version: 1, datasets: published, redistribution: 'NOT_APPROVED' }, null, 2));
  return published;
}
