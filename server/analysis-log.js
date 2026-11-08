import { constants, openSync, closeSync, fstatSync, lstatSync, mkdirSync, chmodSync, fchmodSync, writeFileSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { open, lstat } from 'node:fs/promises';
import { AppError } from './broker.js';
import { istDay } from './engine.js';

export class AnalysisLog {
  constructor(directory) { this.directory = directory; }
  status(now) { return { enabled: true, file: `data/logs/analysis-${istDay(now)}.jsonl` }; }
  async read(botId, day, before = null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
      throw new AppError('Choose a valid log date (YYYY-MM-DD).', 400, 'ANALYSIS_DATE');
    }
    if (before !== null && (!Number.isSafeInteger(before) || before < 0)) throw new AppError('Invalid log page cursor.', 400, 'ANALYSIS_CURSOR');
    const result = { file: `data/logs/analysis-${day}.jsonl`, date: day, records: [], before: null, exists: false };
    let file;
    try {
      const directory = await lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink() || (process.getuid && directory.uid !== process.getuid())) throw new Error('Unsafe directory.');
      file = await open(join(this.directory, `analysis-${day}.jsonl`), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe file.');
      result.exists = true;
      if (before !== null && before > stat.size) throw new AppError('Log file changed. Refresh the viewer before loading older records.', 409, 'ANALYSIS_CURSOR');
      let position = before ?? stat.size, pending = Buffer.alloc(0), scanned = 0;
      if (position) {
        const end = Buffer.alloc(1);
        await file.read(end, 0, 1, position - 1);
        if (end[0] !== 10) throw new Error('Incomplete log line or unaligned cursor.');
      }
      while (position > 0 && scanned < 4 * 1024 * 1024) {
        const length = Math.min(position, 65536);
        position -= length;
        const chunk = Buffer.alloc(length);
        const { bytesRead } = await file.read(chunk, 0, length, position);
        if (bytesRead !== length) throw new Error('Log changed during read.');
        scanned += length;
        const data = Buffer.concat([chunk, pending]);
        let end = data.length - (data.at(-1) === 10 ? 1 : 0);
        while (end > 0) {
          const separator = data.lastIndexOf(10, end - 1);
          if (separator < 0 && position > 0) break;
          const start = separator + 1;
          if (end - start > 131072) throw new Error('Oversized log record.');
          const record = JSON.parse(data.subarray(start, end).toString('utf8'));
          if (record.version !== 1 || !['bot_analysis', 'runner_cycle'].includes(record.event) || !Number.isFinite(Date.parse(record.at)) ||
              !record.quote || typeof record.quote.fresh !== 'boolean' || !record.checks || typeof record.checks !== 'object' ||
              (record.event === 'bot_analysis' && typeof record.bot?.id !== 'string')) throw new Error('Unknown log format.');
          if (record.event === 'bot_analysis' && record.bot?.id === botId) result.records.push(record);
          if (result.records.length === 50) {
            result.before = position + start || null;
            return result;
          }
          end = separator;
        }
        pending = data.subarray(0, Math.max(0, end));
        if (pending.length > 131072) throw new Error('Oversized log record.');
      }
      if (position > 0) result.before = position + pending.length + 1;
      return result;
    } catch (error) {
      if (error.code === 'ENOENT') return result;
      if (error instanceof AppError) throw error;
      throw new AppError('Analysis file could not be read securely or contains an incomplete/malformed record. Check the local file and refresh.', 503, 'ANALYSIS_LOG');
    } finally { if (file) await file.close(); }
  }
  append(records) {
    if (!records.length) return;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const directory = lstatSync(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink() || (process.getuid && directory.uid !== process.getuid())) throw new Error('Unsafe analysis log directory.');
      chmodSync(this.directory, 0o700);
      const batches = new Map();
      for (const record of records) {
        const time = Date.parse(record.at);
        if (!Number.isFinite(time)) throw new Error('Invalid analysis timestamp.');
        const day = istDay(time);
        batches.set(day, (batches.get(day) || '') + JSON.stringify(record) + '\n');
      }
      for (const [day, content] of batches) {
        let fd;
        try {
          fd = openSync(join(this.directory, `analysis-${day}.jsonl`), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe analysis log file.');
          fchmodSync(fd, 0o600);
          writeFileSync(fd, content, 'utf8');
          fsyncSync(fd);
        } finally { if (fd !== undefined) closeSync(fd); }
      }
    } catch {
      throw new AppError('Analysis file could not be written securely. Check data/logs ownership, permissions and available disk space.', 503, 'ANALYSIS_LOG');
    }
  }
}
