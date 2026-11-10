export const symbols = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'ITC', 'LT', 'BHARTIARTL', 'HINDUNILVR'];
export const bundleManifest = symbols.map(symbol => ({
  symbol, from: '2026-08-01', through: '2026-10-31', status: 'unavailable',
  reason: 'Awaiting local Angel One export, coverage validation and redistribution permission.'
}));

export const template = 'timestamp,open,high,low,close,volume\n';
export const columns = ['timestamp', 'open', 'high', 'low', 'close', 'volume'];
export const validSymbol = value => typeof value === 'string' && /^[A-Z0-9][A-Z0-9&._-]{0,39}$/.test(value);
const holidays2026 = new Set(['2026-01-15', '2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31', '2026-04-03', '2026-04-14', '2026-05-01', '2026-05-28', '2026-06-26', '2026-09-14', '2026-10-02', '2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25']);
export const dayOf = time => new Date(time + 19800000).toISOString().slice(0, 10);
export const minuteOf = time => {
  const date = new Date(time + 19800000);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
};
export const atMinute = (day, minute) => Date.parse(`${day}T00:00:00+05:30`) + minute * 60000;

export function sessionFor(day) {
  if (!day.startsWith('2026-')) return null;
  if (day === '2026-02-01') return null;
  if (day === '2026-11-08') return { open: 860, close: 915 };
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6 || holidays2026.has(day)) return false;
  return { open: 555, close: day >= '2026-08-03' ? 915 : 930 };
}

export function csvRows(text) {
  if (typeof text !== 'string' || text.length > 100 * 1024 * 1024) throw new Error('CSV must be text no larger than 100 MiB. Split larger files by ticker/date.');
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', quoted = false, ended = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; ended = true; }
      else field += char;
    } else if (char === ',' || char === '\n' || char === '\r') {
      row.push(field); field = ''; ended = false;
      if (char !== ',') {
        if (row.some(value => value.trim())) rows.push(row);
        row = [];
        if (char === '\r' && text[i + 1] === '\n') i++;
      }
    } else if (char === '"' && field === '' && !ended) quoted = true;
    else {
      if (ended) throw new Error('Unexpected text after a closing CSV quote.');
      if (char === '"') throw new Error('Quote inside an unquoted CSV field.');
      field += char;
    }
  }
  if (quoted) throw new Error('Unterminated quoted CSV field.');
  row.push(field);
  if (row.some(value => value.trim())) rows.push(row);
  if (rows.length < 2) throw new Error('CSV needs a header and at least one candle.');
  rows[0][0] = rows[0][0].replace(/^\uFEFF/, '');
  if (new Set(rows[0]).size !== rows[0].length) throw new Error('CSV headers must be unique.');
  return rows;
}

export function parseTimestamp(value) {
  const input = value.trim().replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::00(?:\.000)?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(input)) {
    throw new Error('Use ISO timestamps at minute boundaries, for example 2026-08-03 09:15:00 or 2026-08-03T09:15:00+05:30.');
  }
  const day = input.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day || +input.slice(11, 13) > 23 || +input.slice(14, 16) > 59) throw new Error('Invalid timestamp date/time.');
  const time = Date.parse(/[Z]|[+-]\d\d:\d\d$/.test(input) ? input : `${input}+05:30`);
  if (!Number.isFinite(time) || time % 60000) throw new Error('Invalid or non-minute timestamp.');
  return time;
}

export function validateBars(bars) {
  if (!Array.isArray(bars) || !bars.length) throw new Error('No candles supplied.');
  const unique = new Map();
  let duplicates = 0, reordered = false, previous = -Infinity;
  for (const bar of bars) {
    if (!Array.isArray(bar) || bar.length !== 6) throw new Error('Each candle needs timestamp, open, high, low, close and volume.');
    const [time, open, high, low, close, volume] = bar;
    if (!Number.isSafeInteger(time) || time % 60000 || ![open, high, low, close].every(n => Number.isFinite(n) && n > 0) ||
        high < Math.max(open, close, low) || low > Math.min(open, close, high) || !Number.isSafeInteger(volume) || volume < 0) throw new Error('Invalid timestamp/OHLCV candle.');
    if (unique.has(time)) {
      if (unique.get(time).some((n, i) => n !== bar[i])) throw new Error('Conflicting duplicate timestamps. Fix the source CSV.');
      duplicates++;
    } else unique.set(time, bar);
    if (time < previous) reordered = true;
    previous = time;
  }
  return { bars: [...unique.values()].sort((a, b) => a[0] - b[0]), duplicates, reordered };
}

export function parseCsv(text, mapping) {
  const rows = csvRows(text), headers = rows.shift();
  const indices = columns.map(column => headers.indexOf(mapping?.[column] ?? column));
  if (indices.some(i => i < 0) || new Set(indices).size !== 6) throw new Error('Map six distinct CSV columns to timestamp, open, high, low, close and volume.');
  return validateBars(rows.map((row, i) => {
    if (row.length !== headers.length) throw new Error(`CSV row ${i + 2} has the wrong number of columns.`);
    const values = indices.map(index => row[index].trim());
    if (values.some(value => value === '')) throw new Error(`CSV row ${i + 2} has an empty required value.`);
    try { return [parseTimestamp(values[0]), ...values.slice(1).map(Number)]; }
    catch (error) { throw new Error(`CSV row ${i + 2}: ${error.message}`); }
  }));
}

export async function checksum(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
}

export function coverage(bars, { from, through, unverified = false } = {}) {
  if (!bars.length) throw new Error('No candles inside the requested dates.');
  const byTime = new Map(bars.map(bar => [bar[0], bar]));
  const observed = new Map();
  for (const bar of bars) {
    const day = dayOf(bar[0]), minute = minuteOf(bar[0]);
    const window = observed.get(day) ?? { open: minute, close: minute + 1 };
    window.open = Math.min(window.open, minute); window.close = Math.max(window.close, minute + 1);
    observed.set(day, window);
  }
  const sessions = [], selected = [], issues = [];
  let verified = true, outside = 0;
  const start = from ?? dayOf(bars[0][0]), end = through ?? dayOf(bars.at(-1)[0]);
  for (let time = Date.parse(`${start}T00:00:00Z`); time <= Date.parse(`${end}T00:00:00Z`); time += 86400000) {
    const day = new Date(time).toISOString().slice(0, 10);
    let window = sessionFor(day);
    if (window === null) {
      verified = false;
      if (!unverified) throw new Error(`No verified NSE calendar for ${day}. Review and explicitly accept data-derived sessions to run this import.`);
      window = observed.get(day);
    }
    if (!window) continue;
    let missing = 0, zero = 0, received = 0;
    for (let minute = window.open; minute < window.close; minute++) {
      const bar = byTime.get(atMinute(day, minute));
      if (!bar) missing++;
      else { received++; selected.push(bar); if (bar[5] === 0) zero++; }
    }
    sessions.push({ day, ...window, received, missing, zero });
    if (missing || zero) issues.push(`${day}: ${missing} missing minutes; ${zero} zero-volume minutes.`);
  }
  outside = bars.length - selected.length;
  if (!sessions.length || !selected.length) issues.push('No eligible continuous-session candles.');
  return { sessions, bars: selected, issues, verified, outside, from: start, through: end };
}

export const csvCell = value => {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
export const toCsv = rows => rows.map(row => row.map(csvCell).join(',')).join('\r\n');
export const candlesCsv = bars => toCsv([columns, ...bars.map(([time, ...values]) => [new Date(time + 19800000).toISOString().replace('.000Z', '+05:30'), ...values])]);
