import { bundleManifest, columns, validSymbol, dayOf, sessionFor, coverage, candlesCsv, toCsv, checksum } from './data.js';
import { defaultRisk, defaultRule, entryPresets, exitPresets, validateStrategy, validateRisk, validateRule } from './engine.js';
import { stockDefaults, ruleConstant } from './defaults.js';
import { storageAction, saveDataset, removeDataset, saveReport, removeReport, reportMetadata } from './storage.js';
import { track } from './analytics.js';
import { analyticsConfig } from './config.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cash = value => Number.isFinite(value) ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(value) : 'N/A';
const pct = value => Number.isFinite(value) ? `${value.toFixed(2)}%` : 'N/A';
const date = value => value ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Not started';
const riskLabels = { initialCash: 'Initial simulated capital', maxTradeRisk: 'Maximum loss per trade', dailyLossLimit: 'Daily loss + open-risk limit', maxDailyTrades: 'Daily entry limit', maxPosition: 'Position cap' };
const options = (values, chosen) => Object.entries(values).map(([id, name]) => `<option value="${esc(id)}"${id === chosen ? ' selected' : ''}>${esc(name)}</option>`).join('');
let page = 'backtest', toastTimer, busy = false, importFile, pendingImport, importPreview, importRevision = 0;
let workspace = { id: 'current', version: 1, strategies: [], risk: { ...defaultRisk }, locked: false, replay: null };
let replayActions = [], bundles = bundleManifest;
let metadata = [], reports = [], latestReport = null, snapshot = null, replayConfig = null, playing = false, timer, replayWorker;
const loaded = new Map(), pendingWorkers = new Set();
const unsavedReports = new Map();
let entryRule = defaultRule(), exitRule = defaultRule(true);
let quickEntryRule = defaultRule(), quickExitRule = defaultRule(true);
let pendingRuleAddition = null;
const bundleRequests = new Map(), suggestions = new WeakMap(), automaticRuleValues = new WeakSet();
const defaultInputs = ['name', 'level', 'budget', 'stopPct', 'targetPct', 'exitLevel', 'exitSessions', 'exitTime', 'exitMinGainPct'];
let cancellation = 0;
let replaySpeed = 1;
function toast(message, error = false) {
  $('#toast').textContent = message; $('#toast').hidden = false; $('#toast').classList.toggle('error', error);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 7000);
}
function storageError(error) {
  $('#storage-status').hidden = false;
  $('#storage-status').textContent = `UNSAVED: ${error.message} Keep this tab open and export your data/configuration.`;
}
async function saveWorkspace() {
  try { await storageAction('workspace', 'put', workspace); return true; }
  catch (error) { storageError(error); return false; }
}
function worker() {
  const instance = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  pendingWorkers.add(instance);
  return instance;
}
function request(instance, action, input, onProgress) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const receive = event => {
      if (event.data.id !== id) return;
      if (event.data.progress) { onProgress?.(event.data.progress); return; }
      cleanup();
      event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result);
    };
    const fail = () => { cleanup(); reject(new Error('Background worker failed. No successful result was assumed.')); };
    const cancel = () => { cleanup(); reject(new Error('Operation cancelled. No partial result saved.')); };
    function cleanup() { instance.removeEventListener('message', receive); instance.removeEventListener('error', fail); instance.removeEventListener('cancelled', cancel); }
    instance.addEventListener('message', receive); instance.addEventListener('error', fail); instance.addEventListener('cancelled', cancel);
    instance.postMessage({ id, action, input });
  });
}
function terminate(instance) { instance.dispatchEvent(new Event('cancelled')); instance.terminate(); pendingWorkers.delete(instance); }
async function oneOff(action, input) {
  const instance = worker();
  try { return await request(instance, action, input, ({ cursor, total }) => { const p = $('#operation-progress'); if (p) { p.value = cursor; p.max = total; } }); }
  finally { terminate(instance); }
}
function download(name, body, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const jsonDownload = (name, value) => download(name, JSON.stringify(value, null, 2));
async function dataset(id) {
  if (!loaded.has(id)) {
    const value = await storageAction('datasets', 'get', id);
    if (!value) throw new Error('Dataset is missing from this browser. Import it again.');
    if (await checksum(value.bars) !== value.sha256) throw new Error('Dataset checksum mismatch. Re-import the original CSV.');
    loaded.set(id, value);
  }
  return loaded.get(id);
}
function heading(title, subtitle, create = false) {
  return `<div class="page-heading"><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div>${create ? '<button class="button secondary" data-action="create">New strategy</button>' : ''}</div>`;
}
const button = (action, text, id = '', secondary = true, help = '') => `<button type="button" class="button ${secondary ? 'secondary' : 'primary'} small" data-action="${action}" data-id="${esc(id)}"${help ? ` title="${esc(help)}" aria-description="${esc(help)}"` : ''}${['step', 'play', 'replay-report', 'close-position', 'replay-toggle', 'entry-lock'].includes(action) && (!replayWorker || busy) ? ' disabled' : ''}>${esc(text)}</button>`;
function table(headers, rows) {
  return rows.length ? `<div class="table-scroll"><table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<div class="empty compact"><p>No records yet.</p></div>';
}
function lineChart(points, label, drawdown = false) {
  if (!points?.length) return '<div class="empty compact">Run a backtest or step through historical replay to build this chart.</div>';
  let peak = points[0].value;
  const all = points.map(point => { peak = Math.max(peak, point.value); return drawdown ? (point.value / peak - 1) * 100 : point.value; });
  const stride = Math.max(1, Math.ceil(all.length / 600));
  const sampled = all.filter((_, i) => i % stride === 0); sampled.push(all.at(-1));
  const min = Math.min(...sampled), max = Math.max(...sampled), spread = max - min || 1;
  const coords = sampled.map((value, i) => `${20 + i / Math.max(1, sampled.length - 1) * 760},${155 - (value - min) / spread * 125}`).join(' ');
  return `<svg class="research-chart" viewBox="0 0 800 180" role="img" aria-label="${esc(label)}"><polyline points="${coords}"/><text x="20" y="175">${esc(drawdown ? pct(min) : cash(min))} to ${esc(drawdown ? pct(max) : cash(max))}</text></svg><p class="chart-caption">${esc(label)} · ${date(points[0].at)} to ${date(points.at(-1).at)} IST · overview sampled for display</p>`;
}
function candleChart(bars) {
  if (!bars?.length) return '';
  const lo = Math.min(...bars.map(b => b[3])), hi = Math.max(...bars.map(b => b[2]));
  const y = value => 155 - (value - lo) / (hi - lo || 1) * 130;
  return `<svg class="research-chart" viewBox="0 0 800 180" role="img" aria-label="Historical one-minute candlesticks">${bars.map((bar, i) => {
    const x = 20 + i / Math.max(1, bars.length - 1) * 760, width = Math.max(2, 500 / bars.length);
    return `<line class="wick" x1="${x}" x2="${x}" y1="${y(bar[2])}" y2="${y(bar[3])}"/><rect class="${bar[4] >= bar[1] ? 'up' : 'down'}" x="${x - width / 2}" width="${width}" y="${Math.min(y(bar[1]), y(bar[4]))}" height="${Math.max(1, Math.abs(y(bar[1]) - y(bar[4])))}"/>`;
  }).join('')}<text x="20" y="175">${esc(cash(lo))} to ${esc(cash(hi))}</text></svg><p class="chart-caption">Last ${bars.length} observed one-minute candles · ${date(bars[0][0])} to ${date(bars.at(-1)[0])} IST</p>`;
}
function stats(summary) {
  return `<div class="summary-grid">${[['Return', pct(summary.returnPct)], ['Net P/L', cash(summary.netPnl)], ['Max drawdown', pct(summary.maxDrawdownPct)], ['Trades', summary.trades]].map(([label, value]) => `<div><small>${label}</small><strong>${esc(value)}</strong></div>`).join('')}</div>`;
}
function journal(orders) {
  return table(['Bot / ticker', 'Side', 'Qty', 'Price', 'Fee', 'Net P/L', 'Time · IST', 'Reason'], orders.slice().reverse().slice(0, 100).map(o => [esc(`${o.bot} / ${o.symbol}`), esc(o.side), o.qty, cash(o.price), cash(o.fee), cash(o.pnl), date(o.at), esc(o.reason)]));
}
function botsPage() {
  return `${heading('Saved strategies', 'Saving is optional. Enable strategies only for a shared portfolio replay.', true)}
    ${table(['Strategy', 'Replay', 'Actions'], workspace.strategies.map(bot => [esc(`${bot.name} · ${bot.symbol}`), button('toggle', bot.enabled ? 'Enabled' : 'Paused', bot.id), `${button('edit', 'Edit', bot.id)} ${button('export-strategy', 'Export', bot.id)} ${button('bin', 'Archive', bot.id)}`]))}
    ${(workspace.bin ?? []).length ? `<details><summary>Archived strategies</summary><div class="actions">${workspace.bin.map(bot => button('restore', `Restore ${bot.name}`, bot.id)).join('')}</div></details>` : ''}
    <details><summary>Import strategy JSON</summary><label>Strategy file<input id="strategy-import" type="file" accept=".json,application/json"></label></details>
    ${workspace.strategies.some(bot => bot.enabled) ? `<div class="actions">${button('replay', 'Shared portfolio replay')}</div>` : ''}`;
}
function datasetPage() {
  return `${heading('Use your own data', 'One-minute OHLCV candles, up to 100 MiB. Files stay in this browser.')}
    <section>
    <label>CSV file<input id="csv-file" type="file" accept=".csv,text/csv" ${busy ? 'disabled' : ''}></label>
    <div class="form-grid"><label>NSE ticker<input id="import-symbol" placeholder="RELIANCE" maxlength="40" value="${esc(pendingImport?.symbol ?? '')}"></label><label>Data source<input id="import-source" placeholder="Your data provider" value="${esc(pendingImport?.source ?? '')}"></label></div>
    <details><summary>Data options</summary><label>Corporate-action adjustment<select id="import-adjustment"><option value="unknown">Unknown (splits/dividends may distort results)</option><option value="unadjusted">Unadjusted</option><option value="adjusted">Provider-adjusted</option></select></label><p class="form-help">Use ISO timestamps. Times without an offset are interpreted in IST.</p></details>
    <div id="mapping">${importPreview ? mappingView() : ''}</div>
    <div class="actions">${button('parse', 'Validate CSV', '', false)}${button('template', 'CSV template')}<span id="import-cancel" hidden>${button('cancel-operation', 'Cancel')}</span></div><div id="import-summary">${pendingImport ? importSummary() : ''}</div></section>
    ${metadata.length ? `<details><summary>Manage local datasets (${metadata.length})</summary>${table(['Ticker / source', 'Dates', 'Candles', 'Actions'], metadata.map(d => [`${esc(d.symbol)}<small>${esc(d.name)} · ${esc(d.source)}</small>`, `${d.from} to ${d.through}`, d.count, `${button('export-data', 'Export', d.id)} ${button('remove-data', 'Remove', d.id)}`]))}</details>` : ''}`;
}
function mappingView() {
  const aliases = { timestamp: ['timestamp', 'date', 'datetime', 'time'], open: ['open'], high: ['high'], low: ['low'], close: ['close'], volume: ['volume', 'vol'] };
  const mapped = columns.every(column => importPreview.headers.some(header => aliases[column].includes(header.trim().toLowerCase())));
  return `<details ${mapped ? '' : 'open'}><summary>${importPreview.rows} rows · ${mapped ? 'Review columns & preview' : 'Map CSV columns'}</summary><div class="form-grid">${columns.map(column => `<label>${column}<select data-column="${column}">${importPreview.headers.map(header => `<option value="${esc(header)}"${aliases[column].includes(header.trim().toLowerCase()) ? ' selected' : ''}>${esc(header)}</option>`).join('')}</select></label>`).join('')}</div><div class="dataset-preview">${table(importPreview.headers, importPreview.sample.map(row => row.map(esc)))}</div></details>`;
}
function importSummary() {
  return `<div class="notice subtle"><strong>${esc(pendingImport.symbol)} · ${esc(pendingImport.name)}</strong>${pendingImport.count} unique candles · ${pendingImport.from} to ${pendingImport.through} · ${pendingImport.duplicates} identical duplicates removed · ${pendingImport.reordered ? 'Sorted by timestamp' : 'Already sorted'}.</div><p class="form-help">Source: ${esc(pendingImport.source)} · Adjustment: ${esc(pendingImport.adjustment)}. ${esc(pendingImport.coverageText)} Zero/missing minutes block affected date ranges; no prices are invented. Adjust the run dates or repair the CSV.</p><div class="actions">${button('commit-import', 'Import into browser', '', false)}</div>`;
}
function runControls() {
  return `<form id="replay-form"><p class="muted">Enabled saved strategies share cash and risk limits.</p><div class="form-grid"><label>From (IST)<input name="from" type="date" required></label><label>Through (IST)<input name="through" type="date" required></label></div><label class="check"><input name="unverified" type="checkbox">Accept observed sessions for unsupported calendars; missing whole sessions cannot be verified.</label><div class="actions"><button class="button primary" ${busy ? 'disabled' : ''}>Start portfolio replay</button></div></form>`;
}
function backtestPage() {
  return `<div class="demo-intro"><h1>Try your trading rules.</h1><p>A hands-on preview of TradeGrok's local trading desk. Backtest a strategy, then replay its trades.</p></div>
    <form id="quick-form">
      <fieldset id="quick-inputs"><legend class="sr-only">Backtest setup</legend>
      <div class="setup-grid"><div><label for="quick-dataset">Stock / dataset</label><select id="quick-dataset" name="datasetId" required aria-describedby="data-note"></select><button type="button" class="text-button upload-link" data-action="datasets">Upload CSV</button></div>
      <label>Strategy<select name="preset">${options(entryPresets, 'sma')}</select></label>
      <label>From (IST)<input name="from" type="date" required></label><label>Through (IST)<input name="through" type="date" required></label></div>
      <p id="data-note" class="form-help"></p>
      <p data-defaults-note class="form-help" role="status" aria-live="polite"></p><button type="button" class="text-button" data-action="suggest-inputs" data-id="quick-form" hidden>Use suggested inputs</button>
      <label data-entry-level hidden>Entry level (INR)<input name="level" type="number" step=".01" min="1" max="1000000" placeholder="Choose a trigger price"></label>
      <div id="quick-entry-rule-editor"></div>
      <label id="calendar-warning" class="check" hidden><input name="unverified" type="checkbox">Accept observed sessions for this calendar. Missing whole sessions cannot be verified.</label>
      <details id="advanced-options"><summary>Strategy options</summary>
      <div class="form-grid"><label>Position budget (INR)<input name="budget" type="number" min="100" step=".01" value="${Math.min(10000, workspace.risk.maxPosition, workspace.risk.initialCash)}" required></label><label>Exit strategy<select name="exitPreset">${options(exitPresets, 'protective')}</select></label></div>
      <div class="form-grid"><label>Stop (%)<input name="stopPct" type="number" min=".2" max="10" step=".1" value="1" required></label><label>Target (%)<input name="targetPct" type="number" min=".2" max="30" step=".1" value="2" required></label></div>
      <label data-exit-field="support" hidden>Exit support level (INR)<input name="exitLevel" type="number" min="1" max="1000000" step=".01" placeholder="Choose a stock first"></label>
      <div data-exit-field="timed" class="form-grid" hidden><label>Exit on session<input name="exitSessions" type="number" min="1" max="60" value="3"></label><label>Exit time (IST)<input name="exitTime" type="time" min="09:15" max="15:14" value="15:00"></label></div>
      <label data-exit-field="performance" hidden>Minimum gain (%)<input name="exitMinGainPct" type="number" min="0" max="30" step=".1" value="1"></label><div id="quick-exit-rule-editor"></div>
      <div class="actions">${button('settings', 'Capital & risk limits')}${button('bots', 'Saved strategies')}</div>
      <label id="saved-strategy-label" hidden>Load a saved strategy<select name="saved"></select></label>
      <div class="form-grid"><label>Save as (optional)<input name="name" maxlength="60" placeholder="Strategy name"></label><div class="save-strategy-action">${button('save-quick', 'Save strategy')}</div></div>
      </details><p id="run-assumptions" class="form-help"></p>
      <div class="run-actions"><button id="run-backtest" class="button primary" disabled>Run backtest</button><span class="muted">Runs in your browser. No sign-in.</span></div>
      </fieldset>
      <p id="quick-error" class="form-error" role="alert" tabindex="-1" hidden></p>
      <div id="operation" hidden><p role="status">Processing in your browser…</p><progress id="operation-progress" aria-label="Operation progress"></progress>${button('cancel-operation', 'Cancel')}</div>
    </form>
    <section id="results" class="results" aria-labelledby="results-title" hidden></section>
    <details id="saved-runs" hidden><summary id="saved-runs-label">Previous runs</summary><div id="saved-runs-content"></div></details>
    <aside class="local-note" aria-label="Full local app"><p><strong>The full desk runs locally.</strong> Connect Angel One for market data and read-only holdings, run paper bots, and track their positions. Neither version places broker orders.</p><a href="https://github.com/shubhankarsharma00/TradeGrok#quick-start" target="_blank" rel="noopener noreferrer">Local setup guide ↗</a></aside>`;
}
function savedRuns() {
  return `${table(['Strategy', 'Ticker / dates', 'Return', 'Actions'], reports.map(report => [esc(report.strategies.map(b => b.name).join(', ')), report.datasets.map(d => `${esc(d.symbol)}<small>${d.from} to ${d.through}</small>`).join(''), pct(report.summary.returnPct), `${button('view-report', 'View', report.id)} ${button('delete-report', 'Remove', report.id)}`]))}${workspace.replay ? `<div class="actions">${button('resume', 'Resume saved replay')}</div>` : ''}`;
}
function replayPage() {
  if (!replayWorker) return `${runControls()}${workspace.replay ? `<div class="actions">${button('resume', 'Resume saved replay')}</div>` : ''}`;
  return `<p>${date(snapshot?.at)} IST · ${snapshot?.done ? 'End reached; open positions remain open.' : playing ? 'Playing' : 'Paused'}</p><div class="actions">${button('step', 'Step 1 minute')}${button('play', playing ? 'Pause' : 'Play')}<label>Speed<select id="replay-speed">${options({ 1: '1 minute / tick', 15: '15 minutes / tick', 60: '60 minutes / tick' }, String(replaySpeed))}</select></label>${button('entry-lock', workspace.locked ? 'Allow entries' : 'Pause entries')}</div>
    ${lineChart(snapshot?.equity, 'Replay close equity')}<div id="replay-candles"></div><h3>Open positions</h3>${table(['Strategy / ticker', 'Qty', 'Entry', 'Stop', 'Target', 'Actions'], (snapshot?.positions ?? []).map(p => [esc(`${p.bot} / ${p.symbol}`), p.qty, cash(p.entryPrice), cash(p.stop), cash(p.target), button('close-position', 'Close at historical close', String(p.key))]))}
    <details><summary>Replay controls & fills</summary><div class="actions">${(replayConfig?.strategies ?? []).map((bot, i) => button('replay-toggle', `${snapshot?.bots[i]?.enabled === false ? 'Enable' : 'Pause'} ${bot.name}`, String(i))).join('')}${button('replay-report', 'Export replay')}</div>
    <form id="seek-form" class="actions"><label>Completed minutes<input name="steps" type="number" min="0" step="1" value="${snapshot?.steps ?? 0}" required></label><button class="button secondary small">Rebuild at minute</button></form>
    <p class="form-help">Rebuilding clears manual closes and replay controls. Backtests never change this portfolio.</p>${journal(snapshot?.orders ?? [])}<h3>Decision records</h3>${table(['Time · IST', 'Strategy', 'Decision', 'Reason'], (snapshot?.logs ?? []).slice().reverse().map(log => [date(log.at), esc(log.bot), esc(log.decision), esc(log.reason)]))}</details>
    <details><summary>Start a different portfolio replay</summary>${runControls()}</details>`;
}
function settingsPage() {
  return `${heading('Risk & settings', 'Saved in this browser. Changes apply when starting a new run or replay.')}
    <div class="settings-grid"><form id="risk-form" class="panel"><h2>Shared risk limits</h2>${Object.entries(workspace.risk).map(([key, value]) => `<label>${esc(riskLabels[key] ?? key)}<input name="${key}" type="number" value="${value}" min="1" step="${key === 'maxDailyTrades' ? '1' : '.01'}" required></label>`).join('')}<div class="actions"><button class="button primary">Save limits</button></div></form>
    <section class="panel"><h2>Local portability</h2><p class="muted">No cloud sync. Clearing site data removes local datasets and reports. Export before resetting. Reports and CSVs have separate exports.</p><div class="actions">${button('export-workspace', 'Export configuration')}${button('reset', 'Reset workspace')}</div><label>Restore workspace configuration<input id="workspace-import" type="file" accept=".json,application/json"></label><p class="form-help">Restores risk settings and strategies, not raw candles or historical account data. Missing datasets must be reimported and selected.</p></section></div>`;
}
function privacyPage() {
  return `${heading('Privacy & assumptions', 'Browser-local trading research with an explicitly separated analytics integration.')}<div class="stack"><section class="panel"><h2>Your data</h2><p>Imported candles, filenames, strategy rules, trading settings and results are stored locally in IndexedDB. They are not uploaded or synchronized. Browser storage may be cleared or denied; failures are shown, never disguised as successful saves. Export files to retain your work.</p></section><section class="panel"><h2>Google Analytics</h2><p>${analyticsConfig.enabled ? 'This public deployment uses GA4 for allowlisted page views and generic feature actions, without an in-app consent prompt. Google receives analytics requests and associated network information. Uploaded data, trading details and broker information are excluded. This is not a claim of anonymous or offline operation.' : 'Analytics is not configured in this build. Production activation requires a GA4 measurement ID and confirmation of applicable legal/Google requirements.'} Local development and broker/export tools are untracked. Advertising signals and user IDs are not used.</p></section><section class="panel"><h2>Historical simulation</h2><p>One-minute bars cannot establish exact intrabar ordering. Stops can fill worse than their level. Costs are a model, not actual brokerage/taxes. Corporate actions and missing history can distort results. Verified 2026 schedules use conservative continuous windows; unsupported calendar years require acceptance of data-derived sessions, which cannot reveal missing whole sessions. No real orders, live quotes or forecasts.</p></section></div>`;
}
function render() {
  if (!$('#quick-form')) { $('#main').innerHTML = backtestPage(); renderRules($('#quick-form')); }
  refreshQuickForm();
  $('#saved-runs').hidden = !reports.length && !workspace.replay;
  $('#saved-runs-label').textContent = `Previous runs (${reports.length})`;
  $('#saved-runs-content').innerHTML = savedRuns();
  if (page !== 'backtest') {
    const samePanel = $('#tools-content').dataset.page === page;
    const openDetails = samePanel ? [...$('#tools-content').querySelectorAll('details[open]')].map(node => node.querySelector('summary')?.textContent) : [];
    const replayDates = samePanel && $('#replay-form') ? [...$('#replay-form').querySelectorAll('input')].map(node => [node.name, node.value, node.checked]) : [];
    $('#tools-title').textContent = { bots: 'Strategies', datasets: 'CSV import', replay: 'Historical replay', settings: 'Capital & risk', privacy: 'Privacy & assumptions' }[page];
    $('#tools-content').innerHTML = ({ bots: botsPage, datasets: datasetPage, replay: replayPage, settings: settingsPage, privacy: privacyPage }[page])();
    $('#tools-content').dataset.page = page;
    $('#tools-content').querySelectorAll('details').forEach(node => { if (openDetails.includes(node.querySelector('summary')?.textContent)) node.open = true; });
    if (page === 'replay') {
      setDates();
      for (const [name, value, checked] of replayDates) if ($('#replay-form')?.elements[name]) { $('#replay-form').elements[name].value = value; $('#replay-form').elements[name].checked = checked; }
      void renderReplayCandles().catch(error => toast(error.message, true));
    }
  }
}
function navigate(next) {
  pause(); page = next; render(); track('page_view', page);
  if (page !== 'backtest' && !$('#tools-dialog').open) $('#tools-dialog').showModal();
}
function setDates() {
  const form = $('#replay-form');
  if (!form) return;
  const bot = workspace.strategies.find(bot => bot.enabled);
  const data = metadata.find(d => d.id === bot?.datasetId);
  if (data) { form.elements.from.value = data.from; form.elements.through.value = data.through; }
}
function selectedData() {
  return formDataset($('#quick-form'));
}
function formDataset(form) {
  const value = form.elements.datasetId.value;
  return metadata.find(data => data.id === value) ?? bundles.find(data => `bundle:${data.symbol}` === value && data.status === 'available');
}
function suggestionState(form) {
  if (!suggestions.has(form)) suggestions.set(form, { overrides: new Map(), revision: 0, signature: '', data: null, profile: null, pending: null, loading: false, error: '' });
  return suggestions.get(form);
}
function suggestionKey(form, name) {
  const data = formDataset(form), stock = `${data?.symbol ?? ''}:${data?.sha256 ?? data?.id ?? ''}`;
  if (name === 'level' || name === 'name') return `${stock}:${form.elements.preset.value}:${name}`;
  if (name === 'exitLevel') return `${stock}:support`;
  if (['exitSessions', 'exitTime', 'exitMinGainPct'].includes(name)) return `${form.elements.preset.value === 'swing' ? 'swing' : 'day'}:${form.elements.exitPreset.value}:${name}`;
  return name;
}
function suggestionFeedback(form) {
  const state = suggestionState(form), info = formDataset(form), note = form.querySelector('[data-defaults-note]');
  if (note) {
    note.textContent = state.loading ? 'Loading stock candles for suggested inputs…' : state.error ? `Suggested inputs unavailable: ${state.error}`
      : state.profile ? `${info.symbol} starter inputs use the ${state.profile.basis}, ${cash(state.profile.price)}.${state.profile.volatilityBased ? '' : ' No prior volatility estimate: 1% baseline.'}${state.profile.canSize ? '' : ' Current risk/position limits cannot fund one share.'} Editable, not optimized.`
      : 'Choose a stock to fill in suggested strategy inputs.';
    note.classList.toggle('form-error', Boolean(state.error));
  }
  const reset = form.querySelector('[data-action="suggest-inputs"]');
  if (reset) {
    reset.hidden = state.loading || (!state.error && !defaultInputs.some(name => state.overrides.has(suggestionKey(form, name))));
    reset.textContent = state.error ? 'Retry suggested inputs' : 'Use suggested inputs';
  }
  form.querySelectorAll('fieldset.rule-group').forEach(group => { group.disabled = state.loading; });
  const submit = form.getAttribute('id') === 'quick-form' ? $('#run-backtest') : form.querySelector('button[type="submit"]');
  if (submit) submit.disabled = busy || !info || state.loading || Boolean(state.error);
}
function applySuggestedInputs(form) {
  const state = suggestionState(form);
  if (!state.data) return;
  const overriddenNumber = name => {
    const value = state.overrides.get(suggestionKey(form, name));
    return value === undefined || value === '' ? undefined : +value;
  };
  const info = formDataset(form);
  const profile = stockDefaults(state.data, {
    from: form.elements.from?.value || info.from, through: form.elements.through?.value || info.through,
    preset: form.elements.preset.value, exitPreset: form.elements.exitPreset.value, risk: workspace.risk,
    level: overriddenNumber('level'), stopPct: overriddenNumber('stopPct'), targetPct: overriddenNumber('targetPct'), exitLevel: overriddenNumber('exitLevel')
  });
  state.profile = profile; state.error = '';
  const values = { ...profile.values, name: `${info.symbol} ${entryPresets[form.elements.preset.value]}`.slice(0, 60) };
  for (const name of defaultInputs) {
    const key = suggestionKey(form, name);
    const value = state.overrides.has(key) ? state.overrides.get(key) : String(values[name]);
    if (form.elements[name].value !== value) form.elements[name].value = value;
  }
  const quick = form.getAttribute('id') === 'quick-form';
  updateAutomaticRuleValues(quick ? quickEntryRule : entryRule, false, profile);
  updateAutomaticRuleValues(quick ? quickExitRule : exitRule, true, profile);
  renderRules(form);
  if (quick) updateQuickSummary();
}
function rememberSuggestedInput(node) {
  if (!defaultInputs.includes(node.name) || !['quick-form', 'bot-form'].includes(node.form?.getAttribute('id'))) return;
  const form = node.form, state = suggestionState(form), key = suggestionKey(form, node.name);
  if (state.overrides.get(key) === node.value) return;
  state.overrides.set(key, node.value);
  if (state.data && !state.loading) {
    try { applySuggestedInputs(form); }
    catch (error) { state.error = error.message; }
  }
  suggestionFeedback(form);
}
function preserveSuggestedInputs(form) {
  const state = suggestionState(form), preset = form.elements.preset.value, exit = form.elements.exitPreset.value;
  const names = ['name', 'budget', 'stopPct', 'targetPct'];
  if (['breakout', 'dip', 'swing'].includes(preset)) names.push('level');
  if (exit === 'support') names.push('exitLevel');
  if (['max-hold', 'scheduled', 'time-performance'].includes(exit)) names.push('exitSessions', 'exitTime');
  if (exit === 'time-performance') names.push('exitMinGainPct');
  for (const name of names) state.overrides.set(suggestionKey(form, name), form.elements[name].value);
  state.signature = '';
}
function requestSuggestedInputs(form) {
  const state = suggestionState(form), info = formDataset(form);
  const signature = JSON.stringify([info?.symbol, info?.sha256 ?? info?.id, form.elements.from?.value, form.elements.through?.value,
    form.elements.preset.value, form.elements.exitPreset.value, workspace.risk]);
  if (state.signature === signature) return state.pending;
  state.signature = signature; state.revision++;
  state.error = ''; state.profile = null; state.data = null;
  if (!info) { state.loading = false; state.pending = null; suggestionFeedback(form); return; }
  const cached = loaded.get(info.id ?? `${info.symbol}-${info.sha256}`);
  if (cached) {
    state.data = cached; state.loading = false; state.pending = null;
    try { applySuggestedInputs(form); }
    catch (error) { state.error = error.message; }
    suggestionFeedback(form); return;
  }
  state.loading = true; suggestionFeedback(form);
  const revision = state.revision, value = form.elements.datasetId.value;
  const current = () => suggestions.get(form) === state && state.revision === revision;
  const pending = (async () => {
    try {
      const data = value.startsWith('bundle:') ? await loadBundle(info.symbol) : await dataset(value);
      if (!current()) return;
      state.data = data; applySuggestedInputs(form);
    } catch (error) {
      if (!current()) { console.warn('Superseded stock-default request failed:', error.message); return; }
      state.error = error.message;
    } finally {
      if (current()) {
        state.loading = false; state.pending = null; suggestionFeedback(form);
        if (form.getAttribute('id') === 'quick-form') refreshQuickForm();
      }
    }
  })();
  state.pending = pending;
  return pending;
}
async function waitForSuggestedInputs(form) {
  const state = suggestions.get(form);
  while (state?.pending) await state.pending;
  if (state?.error) throw new Error(state.error);
}
function availableBundles(manifest) {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.datasets) ||
      (manifest.localOnly !== undefined && typeof manifest.localOnly !== 'boolean')) throw new Error('Invalid bundled dataset manifest.');
  const localOnly = manifest.localOnly === true;
  if (localOnly && !['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('Private candles are only available in a loopback preview.');
  return bundleManifest.map(missing => {
    const found = manifest.datasets.find(data => data.symbol === missing.symbol);
    if (!found) return missing;
    if (found.file !== `${found.symbol}.csv` || !/^[a-f0-9]{64}$/.test(found.sha256) ||
        (!localOnly && (found.redistribution === 'NOT_APPROVED' || !found.redistribution))) throw new Error('Invalid/unlicensed bundled dataset.');
    return { ...found, localOnly, status: 'available' };
  });
}
function refreshQuickForm() {
  const select = $('#quick-dataset'), previous = select.value, previousData = selectedData();
  const available = bundles.filter(data => data.status === 'available' && !metadata.some(local => local.sha256 === data.sha256 && local.symbol === data.symbol));
  const markup = metadata.map(data => `<option value="${esc(data.id)}">${esc(data.symbol)} · ${esc(data.name)}</option>`).join('') + available.map(data => `<option value="bundle:${esc(data.symbol)}">${esc(data.symbol)} · ${data.synthetic ? 'Synthetic demo data · Aug–Oct 2026' : data.localOnly ? 'local snapshot' : 'bundled'}</option>`).join('');
  if (select.dataset.options !== markup) {
    select.innerHTML = markup || '<option value="">Upload a CSV to start</option>'; select.dataset.options = markup;
    const equivalent = metadata.find(data => data.symbol === previousData?.symbol && data.sha256 === previousData?.sha256);
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
    else if (equivalent) select.value = equivalent.id;
    if (select.value !== previous && !equivalent) setQuickDates();
  }
  const form = $('#quick-form'), saved = form.elements.saved, selected = saved.value;
  const savedMarkup = `<option value="">Choose a saved strategy</option>${workspace.strategies.map(bot => `<option value="${esc(bot.id)}">${esc(bot.name)} · ${esc(bot.symbol)}</option>`).join('')}`;
  if (saved.dataset.options !== savedMarkup) { saved.innerHTML = savedMarkup; saved.dataset.options = savedMarkup; saved.value = selected; }
  $('#saved-strategy-label').hidden = !workspace.strategies.length;
  const data = selectedData();
  $('#data-note').textContent = data ? `${data.synthetic ? 'Synthetic demo data; not real market history · ' : data.localOnly ? 'Private local snapshot · ' : ''}${data.from} to ${data.through} · One-minute candles${data.adjustment === 'adjusted' ? '' : ` · ${data.adjustment === 'unadjusted' ? 'Unadjusted' : 'Adjustments unknown'}; splits/dividends may affect results`}` : 'Bundled candles are not available yet. Upload your own CSV to start.';
  for (const name of ['from', 'through']) form.elements[name].disabled = !data;
  $('#run-backtest').disabled = busy || !selectedData();
  $('#quick-inputs').disabled = busy;
  $('#operation').hidden = !busy;
  updateQuickSummary();
  requestSuggestedInputs(form);
  suggestionFeedback(form);
}
function setQuickDates() {
  const form = $('#quick-form'), data = selectedData();
  form.elements.from.value = data?.from ?? ''; form.elements.through.value = data?.through ?? '';
  for (const name of ['from', 'through']) { form.elements[name].min = data?.from ?? ''; form.elements[name].max = data?.through ?? ''; }
  form.elements.unverified.checked = false;
  updateQuickSummary();
}
function updateQuickSummary() {
  const form = $('#quick-form');
  $('#run-assumptions').textContent = `${cash(workspace.risk.initialCash)} capital · ${cash(+form.elements.budget.value)} position budget · ${form.elements.stopPct.value}% stop / ${form.elements.targetPct.value}% target · 0.05% fee + 0.05% slippage per side`;
  let unsupported = false;
  for (let time = Date.parse(form.elements.from.value); time <= Date.parse(form.elements.through.value); time += 86400000) {
    if (sessionFor(new Date(time).toISOString().slice(0, 10)) === null) { unsupported = true; break; }
  }
  $('#calendar-warning').hidden = !unsupported;
  form.elements.unverified.required = unsupported;
}
async function renderReplayCandles() {
  if (!snapshot?.at || !replayConfig) return;
  const id = replayConfig.strategies[0]?.datasetId, data = id && await dataset(id);
  if (!data || page !== 'replay') return;
  const bars = data.bars.filter(bar => bar[0] < Date.parse(snapshot.at) && (!replayConfig.from || dayOf(bar[0]) >= replayConfig.from)).slice(-60);
  if ($('#replay-candles')) $('#replay-candles').innerHTML = candleChart(bars);
}
function operandView(operand, path, side, opposite) {
  const time = operand.field === 'number' && opposite.field === 'time';
  const minutes = operand.value, timeValue = Number.isFinite(minutes) ? `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` : '';
  const value = time ? `<label>Time (IST)<input data-rule-time="${path}:${side}" type="time" required value="${timeValue}"></label>` : `<label>Value<input data-rule-field="${path}:${side}:value" type="number" min="0" step="any" required value="${Number.isFinite(operand.value) ? operand.value : ''}" placeholder="Choose a stock first"></label>`;
  return `<div><label>${side === 'left' ? 'When' : 'Compare with'}<select data-rule-field="${path}:${side}:field">${options({ close: 'Close', open: 'Open', high: 'High', low: 'Low', volume: 'Volume', sma: 'SMA', ema: 'EMA', rsi: 'RSI', time: 'Time (IST)', number: 'Fixed value' }, operand.field)}</select></label>${['sma', 'ema', 'rsi'].includes(operand.field) ? `<label>Period<input data-rule-field="${path}:${side}:period" type="number" min="1" max="500" required value="${Number.isFinite(operand.period) ? operand.period : ''}"></label>` : operand.field === 'number' ? value : ''}</div>`;
}
function ruleView(rule, path) {
  if (['and', 'or'].includes(rule.op)) {
    const conditionHelp = 'Add one check, such as Close above SMA(20). Choose AND or OR in the overlay to join it to the current checks.';
    const groupHelp = 'Add a nested set of checks with its own AND/OR logic. Choose AND or OR in the overlay to join the group to the current checks. Example: Close above 100 AND (RSI below 30 OR Volume above 1000).';
    const nested = path.includes('.');
    const label = nested ? 'Nested group' : path.endsWith('entry') ? 'Entry conditions' : 'Exit conditions';
    return `<fieldset class="rule-group" data-rule-path="${path}"><legend>${label}</legend>
      ${nested ? `<div class="rule-controls">${button('rule-remove', 'Remove group', path)}</div>` : ''}
      <div class="rule-children">${rule.rules.map((r, i) => `${i ? `<div class="rule-connector">${rule.op.toUpperCase()}</div>` : ''}${ruleView(r, `${path}.${i}`)}`).join('')}</div>
      <div class="rule-actions"><span>Add to this group:</span>${button('rule-add', 'Add condition', path, true, conditionHelp)}${button('rule-group-add', 'Add nested group', path, true, groupHelp)}</div>
      </fieldset>`;
  }
  return `<div class="rule-condition">${operandView(rule.left, path, 'left', rule.right)}<label>Condition<select data-rule-op="${path}">${options({ above: 'Is above', below: 'Is below', 'crosses-above': 'Crosses above', 'crosses-below': 'Crosses below' }, rule.op)}</select></label>${operandView(rule.right, path, 'right', rule.left)}${button('rule-remove', 'Remove condition', path)}</div>`;
}
function ruleText(rule, nested = false) {
  if (['and', 'or'].includes(rule.op)) {
    const text = rule.rules.map(child => ruleText(child, true)).join(` ${rule.op.toUpperCase()} `);
    return nested ? `(${text})` : text;
  }
  function operandText(operand, opposite) {
    if (operand.field === 'number') {
      if (!Number.isFinite(operand.value)) return '…';
      return opposite.field === 'time' ? `${String(Math.floor(operand.value / 60)).padStart(2, '0')}:${String(operand.value % 60).padStart(2, '0')} IST` : String(operand.value);
    }
    if (['sma', 'ema', 'rsi'].includes(operand.field)) return `${operand.field.toUpperCase()}(${Number.isFinite(operand.period) ? operand.period : '…'})`;
    return { close: 'Close', open: 'Open', high: 'High', low: 'Low', volume: 'Volume', time: 'Time (IST)' }[operand.field];
  }
  return `${operandText(rule.left, rule.right)} ${{ above: '>', below: '<', 'crosses-above': 'crosses above', 'crosses-below': 'crosses below' }[rule.op]} ${operandText(rule.right, rule.left)}`;
}
function ruleEditor(rule, path, title) {
  return `<h3>${title}</h3><div class="rule-preview"><span>Rule reads as</span><p data-rule-preview="${path}" aria-live="polite" aria-atomic="true">${esc(ruleText(rule))}</p></div>${ruleView(rule, path)}`;
}
function updateRuleControl(node) {
  if (node.dataset.ruleField) {
    const [path, side, field] = node.dataset.ruleField.split(':'), condition = ruleNode(path), operand = condition[side];
    operand[field] = field === 'field' ? node.value : node.value === '' ? NaN : +node.value;
    if (field === 'value') automaticRuleValues.delete(operand);
    if (field === 'field') {
      if (['sma', 'ema', 'rsi'].includes(operand.field)) operand.period = operand.field === 'rsi' ? 14 : 20;
      else delete operand.period;
      if (operand.field === 'number') automaticRuleValues.add(operand);
      else { delete operand.value; automaticRuleValues.delete(operand); }
      updateAutomaticRuleValues(condition, path.split('.')[0].endsWith('exit'), suggestions.get(node.form)?.profile);
    }
  }
  if (node.dataset.ruleTime) {
    const [path, side] = node.dataset.ruleTime.split(':'), [hours, minutes] = node.value.split(':').map(Number);
    ruleNode(path)[side].value = hours * 60 + minutes;
    automaticRuleValues.delete(ruleNode(path)[side]);
  }
  if (node.dataset.ruleOp) {
    const path = node.dataset.ruleOp, condition = ruleNode(path);
    condition.op = node.value;
    updateAutomaticRuleValues(condition, path.split('.')[0].endsWith('exit'), suggestions.get(node.form)?.profile);
  }
  node.form.querySelectorAll('[data-rule-preview]').forEach(preview => { preview.textContent = ruleText(ruleNode(preview.dataset.rulePreview)); });
}
function updateAutomaticRuleValues(rule, exit, profile) {
  if (rule.rules) { rule.rules.forEach(child => updateAutomaticRuleValues(child, exit, profile)); return; }
  for (const side of ['left', 'right']) {
    const operand = rule[side], opposite = rule[side === 'left' ? 'right' : 'left'];
    const op = side === 'right' ? rule.op : { above: 'below', below: 'above', 'crosses-above': 'crosses-below', 'crosses-below': 'crosses-above' }[rule.op];
    if (operand.field === 'number' && automaticRuleValues.has(operand)) operand.value = ruleConstant(opposite.field, op, exit, profile);
  }
}
function cloneEditableRule(rule) {
  const copy = structuredClone(rule);
  function transfer(source, target) {
    if (source.rules) source.rules.forEach((child, i) => transfer(child, target.rules[i]));
    else for (const side of ['left', 'right']) if (automaticRuleValues.has(source[side])) automaticRuleValues.add(target[side]);
  }
  transfer(rule, copy);
  return copy;
}
function ruleNode(path) {
  const [root, ...indices] = path.split('.');
  return indices.reduce((node, i) => node.rules[+i], { entry: entryRule, exit: exitRule, 'quick-entry': quickEntryRule, 'quick-exit': quickExitRule }[root]);
}
function appendRule(path, kind, join) {
  if (!['and', 'or'].includes(join) || !['condition', 'group'].includes(kind)) throw new Error('Choose AND or OR before adding a condition or group.');
  const [root, ...indices] = path.split('.');
  const candidate = cloneEditableRule(ruleNode(root));
  const group = indices.reduce((node, i) => node.rules[+i], candidate);
  if (!group || !['and', 'or'].includes(group.op) || !Array.isArray(group.rules)) throw new Error('Choose a condition group to add to.');
  const addition = kind === 'group' ? defaultRule(root.endsWith('exit')) : defaultRule(root.endsWith('exit')).rules[0];
  if (group.op !== join && group.rules.length > 1) group.rules = [{ op: group.op, rules: group.rules }];
  group.op = join;
  group.rules.push(addition);
  validateRule(candidate);
  Object.assign(ruleNode(root), candidate);
  return `${path}.${group.rules.length - 1}`;
}
function openRuleJoin(path, kind, trigger) {
  pendingRuleAddition = { path, kind, trigger };
  $('#rule-join-title').textContent = kind === 'group' ? 'Add a group: AND or OR?' : 'Add a condition: AND or OR?';
  $('#rule-join-description').textContent = kind === 'group'
    ? 'How should the new group join these checks? Inside it, use Add condition to build its rules.'
    : 'How should the new condition join these checks?';
  $('#rule-join-current').textContent = ruleText(ruleNode(path));
  $('#rule-join-error').textContent = '';
  $('#rule-join-dialog').showModal();
  $('#rule-join-dialog [data-id="and"]').focus();
}
function closeRuleJoin() {
  if ($('#rule-join-dialog').open) return;
  const trigger = pendingRuleAddition?.trigger;
  pendingRuleAddition = null;
  if (trigger?.isConnected) trigger.focus({ preventScroll: true });
}
function renderRules(form = $('#bot-form')) {
  const quick = form.getAttribute('id') === 'quick-form', prefix = quick ? 'quick-' : '';
  const active = document.activeElement;
  const focusAttribute = ['data-rule-field', 'data-rule-op', 'data-rule-time'].find(attribute => active?.hasAttribute(attribute));
  const focusValue = focusAttribute && active.getAttribute(focusAttribute);
  $(`#${prefix}entry-rule-editor`).innerHTML = form.elements.preset.value === 'rules' ? ruleEditor(quick ? quickEntryRule : entryRule, `${prefix}entry`, 'Entry rules') : '';
  $(`#${prefix}exit-rule-editor`).innerHTML = form.elements.exitPreset.value === 'rules' ? ruleEditor(quick ? quickExitRule : exitRule, `${prefix}exit`, 'Exit rules') : '';
  const level = ['breakout', 'dip', 'swing'].includes(form.elements.preset.value);
  form.querySelector('[data-entry-level]').hidden = !level;
  form.elements.level.disabled = !level; form.elements.level.required = level;
  const exit = form.elements.exitPreset.value;
  form.querySelectorAll('[data-exit-field]').forEach(node => {
    const field = node.dataset.exitField, show = field === 'support' ? exit === 'support' : field === 'performance' ? exit === 'time-performance' : ['scheduled', 'max-hold', 'time-performance'].includes(exit);
    node.hidden = !show;
    node.querySelectorAll('input').forEach(input => { input.disabled = !show; input.required = show; });
  });
  if (focusAttribute) form.querySelector(`[${focusAttribute}="${CSS.escape(focusValue)}"]`)?.focus({ preventScroll: true });
}
function editBot(id) {
  pause();
  if (!metadata.length) { navigate('datasets'); toast('Import candles before creating a bot.'); return; }
  const bot = workspace.strategies.find(b => b.id === id);
  const form = $('#bot-form'); form.reset();
  suggestions.delete(form);
  form.elements.datasetId.innerHTML = metadata.map(d => `<option value="${esc(d.id)}">${esc(d.symbol)} · ${esc(d.name)}</option>`).join('');
  form.elements.preset.innerHTML = options(entryPresets, bot?.preset ?? 'sma');
  form.elements.exitPreset.innerHTML = options(exitPresets, bot?.exitPreset ?? 'protective');
  form.elements.id.value = bot?.id ?? '';
  if (bot) for (const [key, value] of Object.entries(bot)) if (form.elements.namedItem(key)) form.elements.namedItem(key).value = value;
  entryRule = structuredClone(bot?.entryRule ?? defaultRule()); exitRule = structuredClone(bot?.exitRule ?? defaultRule(true));
  if (bot) preserveSuggestedInputs(form);
  $('#bot-error').textContent = ''; renderRules(); $('#bot-dialog').showModal();
  requestSuggestedInputs(form);
}
async function configFromForm(form) {
  if (busy) throw new Error('Wait for the current operation or cancel it first.');
  const strategies = workspace.strategies.filter(b => b.enabled).map(bot => structuredClone(bot));
  if (!strategies.length) throw new Error('Create and enable at least one strategy first.');
  if (form.elements.from.value > form.elements.through.value) throw new Error('From date must not follow through date.');
  const data = await Promise.all([...new Set(strategies.map(b => b.datasetId))].map(dataset));
  return { datasets: data, strategies, risk: { ...workspace.risk }, from: form.elements.from.value, through: form.elements.through.value, unverified: form.elements.unverified.checked };
}
async function loadBundle(symbol) {
  const meta = bundles.find(data => data.symbol === symbol && data.status === 'available');
  if (!meta) throw new Error('Bundled candles are not available. Upload a CSV instead.');
  const id = `${meta.symbol}-${meta.sha256}`;
  if (loaded.has(id)) return loaded.get(id);
  if (bundleRequests.has(symbol)) return bundleRequests.get(symbol).pending;
  const controller = new AbortController();
  const pending = (async () => {
    const response = await fetch(new URL(`./bundles/${meta.symbol}.csv`, import.meta.url), { signal: controller.signal });
    if (!response.ok) throw new Error('Bundled CSV could not be loaded. Try again or upload your own CSV.');
    const file = new File([await response.blob()], `${meta.symbol}.csv`, { type: 'text/csv' });
    controller.signal.throwIfAborted();
    const parsed = await oneOff('parse', { file });
    controller.signal.throwIfAborted();
    if (parsed.sha256 !== meta.sha256) throw new Error('Bundled CSV checksum mismatch.');
    const check = coverage(parsed.bars, { from: meta.from, through: meta.through });
    if (check.issues.length) throw new Error(`Bundled CSV coverage blocked: ${check.issues[0]}`);
    const value = { ...meta, ...parsed, id, name: `${meta.symbol}${meta.synthetic ? ' · Synthetic demo data · Aug–Oct 2026' : '.csv'}`, count: parsed.bars.length };
    loaded.set(value.id, value);
    const { bars, ...info } = value; metadata = metadata.filter(data => data.id !== info.id).concat(info);
    try { await saveDataset(value); } catch (error) { storageError(error); }
    return value;
  })();
  bundleRequests.set(symbol, { controller, pending });
  try { return await pending; }
  finally { bundleRequests.delete(symbol); }
}
async function quickConfig() {
  const form = $('#quick-form');
  await waitForSuggestedInputs(form);
  const values = Object.fromEntries(['datasetId', 'preset', 'name', 'level', 'budget', 'stopPct', 'targetPct', 'exitPreset', 'exitLevel', 'exitSessions', 'exitTime', 'exitMinGainPct', 'from', 'through'].map(key => [key, form.elements[key].value]));
  if (!selectedData()) throw new Error('Choose a dataset or upload a CSV first.');
  if (!values.from || !values.through || values.from > values.through) throw new Error('Choose a valid date range within your dataset.');
  const rules = { entryRule: structuredClone(quickEntryRule), exitRule: structuredClone(quickExitRule) };
  const risk = { ...workspace.risk }, unverified = form.elements.unverified.checked;
  const data = values.datasetId.startsWith('bundle:') ? await loadBundle(values.datasetId.slice(7)) : await dataset(values.datasetId);
  const strategy = { ...values, ...rules, id: crypto.randomUUID(), datasetId: data.id, symbol: data.symbol, enabled: true, name: values.name.trim() || `${data.symbol} ${entryPresets[values.preset]}`.slice(0, 60) };
  delete strategy.from; delete strategy.through;
  for (const key of ['level', 'budget', 'stopPct', 'targetPct', 'exitLevel', 'exitSessions', 'exitMinGainPct']) strategy[key] = +strategy[key];
  validateStrategy(strategy, risk);
  return { datasets: [data], strategies: [strategy], risk, from: values.from, through: values.through, unverified };
}
function loadQuickStrategy(id) {
  const bot = workspace.strategies.find(strategy => strategy.id === id);
  if (!bot) return;
  const form = $('#quick-form');
  for (const [key, value] of Object.entries(bot)) if (form.elements.namedItem(key)) form.elements.namedItem(key).value = value;
  quickEntryRule = structuredClone(bot.entryRule ?? defaultRule()); quickExitRule = structuredClone(bot.exitRule ?? defaultRule(true));
  preserveSuggestedInputs(form);
  setQuickDates(); renderRules(form); refreshQuickForm();
  if (!selectedData()) toast('This saved strategy needs its dataset. Upload the original CSV or select another dataset.', true);
}
function reportView(report) {
  return `<div class="result-heading"><div><h2 id="results-title" tabindex="-1">Backtest results</h2><p class="muted">${esc(report.strategies.map(strategy => strategy.name).join(', '))} · ${report.datasets.map(data => `${esc(data.symbol)} ${data.from} to ${data.through}`).join(' · ')}</p></div>${button('replay-result', 'Replay these trades')}</div>
    ${stats(report.summary)}${lineChart(report.equity, 'Portfolio equity after costs')}
    <details><summary>Trades & exports</summary>${journal(report.orders)}<div class="actions">${button('export-trades', 'Trades CSV')}${button('export-report', 'Full report JSON')}</div></details>
    <details><summary>More metrics & assumptions</summary><p class="form-help">Win rate ${pct(report.summary.winRatePct)} · Fees ${cash(report.summary.fees)} · Initial capital ${cash(report.risk.initialCash)}</p>${lineChart(report.equity, 'Drawdown from close-equity peak', true)}
    <h3>Monthly performance</h3>${table(['Month', 'P/L', 'Return'], report.months.map(m => [m.month, cash(m.pnl), pct(m.returnPct)]))}
    <h3>Buy-and-hold benchmarks</h3>${table(['Ticker', 'Final equity', 'Return', 'Basis'], report.benchmarks.map(b => [esc(b.symbol), cash(b.finalCapital), pct(b.returnPct), esc(b.label)]))}
    <h3>Dataset identity & coverage</h3>${table(['Ticker', 'Dates', 'Source / adjustments', 'SHA-256', 'Calendar'], report.datasets.map(d => [esc(d.symbol), `${d.from} to ${d.through}`, `${esc(d.source)} / ${esc(d.adjustment)}`, `<small>${esc(d.sha256)}</small>`, d.verifiedCalendar ? 'Verified 2026 schedule' : 'User-accepted observed sessions']))}
    <h3>Assumptions</h3><ul>${report.assumptions.map(a => `<li>${esc(a)}</li>`).join('')}</ul></details>`;
}
function showReport(report) {
  latestReport = report; $('#results').innerHTML = reportView(report); $('#results').hidden = false;
  $('#results-title').focus();
}
async function startReplay(config) {
  if (replayWorker) terminate(replayWorker);
  replayWorker = worker(); replayConfig = config; workspace.locked = false; replayActions = [];
  try { snapshot = await request(replayWorker, 'init', config); }
  catch (error) { terminate(replayWorker); replayWorker = null; snapshot = null; replayConfig = null; throw error; }
  await persistReplay();
}
function pause() { playing = false; clearTimeout(timer); }
async function persistReplay() {
  if (!replayConfig || !snapshot) return;
  const { datasets, ...config } = replayConfig;
  workspace.replay = { config, steps: snapshot.steps, actions: replayActions };
  await saveWorkspace();
}
async function advance(count) {
  if (!replayWorker) throw new Error('Initialize or resume a historical replay first.');
  snapshot = await request(replayWorker, 'step', { count });
  await persistReplay();
  if (snapshot.done) pause();
  render();
}
async function tick() {
  const speed = replaySpeed;
  try { await advance(speed); if (playing) timer = setTimeout(tick, 300); }
  catch (error) { pause(); toast(error.message, true); }
}
async function handleClick(target) {
  const action = target.dataset.action, id = target.dataset.id;
  if (!action) return;
  if (busy && action !== 'cancel-operation') throw new Error('Wait for the current operation or cancel it first.');
  if (['datasets', 'replay', 'bots', 'settings', 'privacy'].includes(action)) { navigate(action); return; }
  if (action === 'create' || action === 'edit') { editBot(id); return; }
  if (action === 'suggest-inputs') {
    const form = id === 'quick-form' ? $('#quick-form') : $('#bot-form'), state = suggestionState(form);
    if (!state.error) for (const name of defaultInputs) state.overrides.delete(suggestionKey(form, name));
    state.signature = ''; requestSuggestedInputs(form); return;
  }
  if (action === 'rule-add' || action === 'rule-group-add') {
    openRuleJoin(id, action === 'rule-group-add' ? 'group' : 'condition', target); return;
  }
  if (action === 'rule-join') {
    if (!pendingRuleAddition) throw new Error('Choose Add condition or Add nested group first.');
    const { path, kind } = pendingRuleAddition;
    let newPath;
    try { newPath = appendRule(path, kind, id); }
    catch (error) { $('#rule-join-error').textContent = error.message; $('#rule-join-error').focus(); return; }
    pendingRuleAddition = null; $('#rule-join-dialog').close();
    const form = path.startsWith('quick-') ? $('#quick-form') : $('#bot-form');
    renderRules(form);
    const selector = `[data-rule-field="${newPath}${kind === 'group' ? '.0' : ''}:left:field"]`;
    form.querySelector(selector)?.focus(); return;
  }
  if (action === 'rule-remove') {
    const parts = id.split('.'), last = +parts.pop();
    const parentPath = parts.join('.'), parent = ruleNode(parentPath);
    if (parent.rules.length === 1) throw new Error('A group needs at least one condition.');
    parent.rules.splice(last, 1);
    const form = id.startsWith('quick-') ? $('#quick-form') : $('#bot-form');
    renderRules(form); form.querySelector(`[data-action="rule-add"][data-id="${parentPath}"]`)?.focus(); return;
  }
  if (action === 'cancel-operation') {
    pause(); importRevision++; cancellation++; pendingImport = null;
    for (const request of bundleRequests.values()) request.controller.abort();
    for (const w of [...pendingWorkers]) terminate(w);
    replayWorker = null;
    if ($('#import-summary')) $('#import-summary').textContent = 'Cancelled. No partial import saved.';
    toast('Cancelled. No partial result saved.'); return;
  }
  if (action === 'template') { download('tradegrok-candles-template.csv', 'timestamp,open,high,low,close,volume\n', 'text/csv'); return; }
  if (action === 'parse') {
    if (!importFile || !importPreview) throw new Error('Choose a CSV file first.');
    const symbol = $('#import-symbol').value.trim().toUpperCase(), source = $('#import-source').value.trim();
    if (!validSymbol(symbol) || !source) throw new Error('Enter a valid NSE ticker and source/provenance.');
    const mapping = Object.fromEntries([...document.querySelectorAll('[data-column]')].map(node => [node.dataset.column, node.value]));
    const adjustment = $('#import-adjustment').value;
    const revision = ++importRevision, file = importFile;
    pendingImport = null;
    $('#import-summary').innerHTML = '<p role="status">Validating candles in a background worker...</p>';
    let parsed; busy = true; refreshQuickForm(); $('#import-cancel').hidden = false;
    try { parsed = await oneOff('parse', { file, mapping }); }
    catch (error) {
      if (revision === importRevision && $('#import-summary')) $('#import-summary').innerHTML = `<p class="form-error" role="alert">Validation failed: ${esc(error.message)}</p>`;
      throw error;
    } finally { busy = false; refreshQuickForm(); if ($('#import-cancel')) $('#import-cancel').hidden = true; }
    if (revision !== importRevision || file !== importFile) return;
    const from = dayOf(parsed.bars[0][0]), through = dayOf(parsed.bars.at(-1)[0]);
    let coverageText;
    try { const check = coverage(parsed.bars, { unverified: true }); coverageText = `${check.verified ? 'Verified 2026 calendar' : 'Unverified data-derived sessions'}; ${check.sessions.length} sessions; ${check.outside} excluded bars. ${check.issues.slice(0, 5).join(' ') || 'No minute gaps/zero-volume bars found in expected sessions.'}`; }
    catch (error) { coverageText = error.message; }
    pendingImport = { id: `${symbol}-${parsed.sha256}`, symbol, name: file.name, source, adjustment, ...parsed, from, through, count: parsed.bars.length, coverageText, version: 1 };
    if ($('#import-summary')) $('#import-summary').innerHTML = importSummary(); return;
  }
  if (action === 'commit-import') {
    if (!pendingImport) throw new Error('Validate a CSV first.');
    const { bars, ...meta } = pendingImport;
    loaded.set(meta.id, pendingImport);
    metadata = metadata.filter(d => d.id !== meta.id).concat(meta);
    try { await saveDataset(pendingImport); toast('Candles saved in this browser.'); }
    catch (error) { storageError(error); }
    pendingImport = null; importPreview = null; importFile = null;
    $('#tools-dialog').close(); page = 'backtest'; render();
    $('#quick-dataset').value = meta.id; setQuickDates(); refreshQuickForm(); $('#run-backtest').focus();
    track('csv_import_completed'); return;
  }
  if (action === 'save-quick') {
    const form = $('#quick-form');
    if (!form.reportValidity()) return;
    const selected = form.elements.saved.value, revision = cancellation;
    busy = true; refreshQuickForm();
    try {
      const { strategies: [strategy] } = await quickConfig();
      if (revision !== cancellation) throw new Error('Saving cancelled.');
      if (!selected && workspace.strategies.length >= 20) throw new Error('At most 20 saved strategies. Archive one first.');
      strategy.id = selected || strategy.id;
      strategy.enabled = workspace.strategies.find(bot => bot.id === selected)?.enabled ?? true;
      workspace.strategies = workspace.strategies.filter(bot => bot.id !== strategy.id).concat(strategy);
      toast(await saveWorkspace() ? 'Strategy saved.' : 'Strategy is available in this tab only; storage failed.', !$('#storage-status').hidden);
      refreshQuickForm(); form.elements.saved.value = strategy.id;
    } finally { busy = false; refreshQuickForm(); }
    return;
  }
  if (action === 'export-data') { download('tradegrok-candles.csv', candlesCsv((await dataset(id)).bars), 'text/csv'); return; }
  if (action === 'remove-data') {
    if (workspace.strategies.some(b => b.datasetId === id) || (workspace.bin ?? []).some(b => b.datasetId === id)) throw new Error('Dataset is referenced by a bot. Export/reset the workspace before removing it.');
    if (!confirm('Remove this dataset from this browser? Export it first if you need a backup.')) return;
    await removeDataset(id);
    loaded.delete(id); metadata = metadata.filter(d => d.id !== id); render(); return;
  }
  if (action === 'toggle' || action === 'bin' || action === 'restore') {
    pause();
    if (action === 'restore') {
      if (workspace.strategies.length >= 20) throw new Error('At most 20 active strategies. Move one to the bin first.');
      const bot = workspace.bin.find(b => b.id === id); workspace.strategies.push({ ...bot, enabled: false }); workspace.bin = workspace.bin.filter(b => b.id !== id);
    } else {
      const bot = workspace.strategies.find(b => b.id === id);
      if (action === 'toggle') bot.enabled = !bot.enabled;
      else { (workspace.bin ??= []).push({ ...bot, enabled: false }); workspace.strategies = workspace.strategies.filter(b => b.id !== id); }
    }
    await saveWorkspace(); render(); return;
  }
  if (action === 'export-strategy') { jsonDownload('tradegrok-strategy.json', { version: 1, strategy: workspace.strategies.find(b => b.id === id) }); return; }
  if (action === 'view-report') {
    const report = unsavedReports.get(id) ?? await storageAction('reports', 'get', id);
    if (!report) throw new Error('Saved report is missing.');
    showReport(report); return;
  }
  if (action === 'export-report') { jsonDownload('tradegrok-report.json', latestReport); track('report_exported'); return; }
  if (action === 'export-trades') {
    const keys = ['bot', 'symbol', 'entryAt', 'exitAt', 'qty', 'entryPrice', 'exitPrice', 'fees', 'pnl', 'reason'];
    download('tradegrok-trades.csv', toCsv([keys, ...latestReport.trades.map(t => keys.map(k => t[k]))]), 'text/csv'); return;
  }
  if (action === 'delete-report') {
    if (!confirm('Remove this saved report from this browser?')) return;
    await removeReport(id); unsavedReports.delete(id); reports = reports.filter(r => r.id !== id); render(); return;
  }
  if (action === 'replay-result') {
    if (!latestReport) throw new Error('Run or open a backtest first.');
    pause(); busy = true; refreshQuickForm();
    const report = latestReport, revision = cancellation;
    try {
      const datasets = await Promise.all([...new Set(report.strategies.map(bot => bot.datasetId))].map(dataset));
      if (revision !== cancellation) throw new Error('Replay cancelled.');
      const dates = report.datasets;
      await startReplay({ datasets, strategies: structuredClone(report.strategies), risk: { ...report.risk }, from: dates.map(data => data.from).sort()[0], through: dates.map(data => data.through).sort().at(-1), unverified: dates.some(data => !data.verifiedCalendar) });
      navigate('replay');
    } finally { busy = false; render(); }
    return;
  }
  if (action === 'step') { pause(); await advance(1); return; }
  if (action === 'play') { if (playing) { pause(); render(); } else { if (!replayWorker || snapshot.done) throw new Error('Initialize/resume a replay with remaining candles.'); playing = true; track('replay_started'); await tick(); } return; }
  if (action === 'resume') {
    if (!workspace.replay) throw new Error('No saved replay. Initialize one first.');
    pause(); busy = true; refreshQuickForm(); const revision = cancellation;
    try {
      if (replayWorker) terminate(replayWorker); replayWorker = null;
      replayConfig = { ...workspace.replay.config, datasets: await Promise.all([...new Set(workspace.replay.config.strategies.map(b => b.datasetId))].map(dataset)) };
      if (revision !== cancellation) throw new Error('Replay cancelled.');
      replayActions = workspace.replay.actions ?? [];
      replayWorker = worker(); snapshot = await request(replayWorker, 'seek', { config: replayConfig, steps: workspace.replay.steps, actions: replayActions });
      workspace.locked = snapshot.locked; await saveWorkspace(); navigate('replay');
    } catch (error) {
      if (replayWorker) terminate(replayWorker); replayWorker = null; snapshot = null;
      throw error;
    } finally { busy = false; render(); }
    return;
  }
  if (action === 'entry-lock') {
    if (!replayWorker) throw new Error('Start a replay first.');
    pause(); const input = { active: !workspace.locked };
    snapshot = await request(replayWorker, 'lock', input); workspace.locked = snapshot.locked;
    replayActions.push({ step: snapshot.steps, action: 'lock', input }); await persistReplay(); render(); return;
  }
  if (action === 'replay-toggle') {
    if (!replayWorker) throw new Error('Initialize a replay first.');
    pause(); const input = { key: +id, enabled: snapshot.bots[+id].enabled === false };
    snapshot = await request(replayWorker, 'enable', input);
    replayActions.push({ step: snapshot.steps, action: 'enable', input });
    await persistReplay(); render(); return;
  }
  if (action === 'close-position') {
    if (!replayWorker) throw new Error('Initialize a replay first.');
    pause(); const input = { key: +id }; snapshot = await request(replayWorker, 'close', input);
    replayActions.push({ step: snapshot.steps, action: 'close', input }); await persistReplay(); render(); return;
  }
  if (action === 'replay-report') { if (!replayWorker) throw new Error('Initialize a replay first.'); jsonDownload('tradegrok-replay.json', { ...await request(replayWorker, 'report'), replayActions }); return; }
  if (action === 'export-workspace') { jsonDownload('tradegrok-workspace.json', { version: 1, risk: workspace.risk, strategies: workspace.strategies, bin: workspace.bin ?? [] }); return; }
  if (action === 'reset') {
    if (!confirm('Reset strategies, replay and risk settings? Datasets and saved backtest reports remain. Export configuration first.')) return;
    pause(); if (replayWorker) terminate(replayWorker); replayWorker = null; snapshot = null; replayConfig = null;
    workspace = { id: 'current', version: 1, strategies: [], bin: [], risk: { ...defaultRisk }, locked: false, replay: null };
    await saveWorkspace(); render(); return;
  }
}
document.addEventListener('click', event => {
  const dismiss = event.target.closest('[data-dismiss]');
  if (dismiss) { dismiss.closest('dialog').close(); return; }
  const target = event.target.closest('[data-action]');
  if (target) { event.preventDefault(); void handleClick(target).catch(error => toast(error.message, true)); }
});
$('#tools-dialog').addEventListener('close', () => { pause(); page = 'backtest'; refreshQuickForm(); });
$('#rule-join-dialog').addEventListener('close', closeRuleJoin);
document.addEventListener('invalid', event => {
  for (let node = event.target.parentElement; node; node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true;
}, true);
document.addEventListener('input', event => {
  const node = event.target;
  rememberSuggestedInput(node);
  if (node.form?.getAttribute('id') === 'quick-form') updateQuickSummary();
  if (node.matches('input[data-rule-field],input[data-rule-time]')) updateRuleControl(node);
});
document.addEventListener('change', event => {
  void (async () => {
    const node = event.target;
    if (node.id === 'replay-speed') replaySpeed = +node.value;
    if (node.id === 'csv-file') {
      const revision = ++importRevision;
      importFile = node.files[0]; pendingImport = null; importPreview = null;
      $('#mapping').innerHTML = ''; $('#import-summary').innerHTML = '';
      if (!importFile) return;
      if (importFile.size > 100 * 1024 * 1024) throw new Error('CSV exceeds 100 MiB.');
      const preview = await oneOff('preview', { file: importFile });
      if (revision !== importRevision) return;
      importPreview = preview;
      if ($('#mapping')) $('#mapping').innerHTML = mappingView();
    }
    if (['bot-form', 'quick-form'].includes(node.form?.getAttribute('id'))) {
      rememberSuggestedInput(node);
      updateRuleControl(node);
      if (node.dataset.ruleField?.endsWith(':field') || node.dataset.ruleOp || ['preset', 'exitPreset'].includes(node.name)) renderRules(node.form);
    }
    if (node.id === 'quick-dataset') { setQuickDates(); refreshQuickForm(); }
    if (node.name === 'saved' && node.form?.getAttribute('id') === 'quick-form') loadQuickStrategy(node.value);
    if (['bot-form', 'quick-form'].includes(node.form?.getAttribute('id')) &&
        ['datasetId', 'preset', 'exitPreset', 'from', 'through'].includes(node.name)) requestSuggestedInputs(node.form);
    if (node.id === 'strategy-import' || node.id === 'workspace-import') {
      const file = node.files[0]; if (!file) return;
      if (file.size > 1024 * 1024) throw new Error('Configuration exceeds 1 MiB.');
      const input = JSON.parse(await file.text());
      if (input.version !== 1) throw new Error('Unsupported configuration version.');
      if (node.id === 'strategy-import') {
        const bot = { ...input.strategy, id: crypto.randomUUID(), enabled: false };
        validateStrategy(bot, workspace.risk); workspace.strategies.push(bot);
      } else {
        validateRisk(input.risk);
        if (!Array.isArray(input.strategies) || input.strategies.length > 20 || !Array.isArray(input.bin ?? [])) throw new Error('Invalid workspace strategies.');
        const all = [...input.strategies, ...(input.bin ?? [])];
        all.forEach(bot => validateStrategy(bot, input.risk));
        if (all.some(bot => typeof bot.id !== 'string' || !bot.id || bot.id.length > 160) || new Set(all.map(bot => bot.id)).size !== all.length) throw new Error('Workspace strategy IDs must be unique nonempty strings.');
        if (!confirm('Replace risk settings and strategy configuration? Candles and reports are unchanged.')) return;
        pause(); if (replayWorker) terminate(replayWorker); replayWorker = null; snapshot = null;
        workspace = { id: 'current', version: 1, risk: input.risk, strategies: input.strategies.map(b => ({ ...b, enabled: false })), bin: input.bin ?? [], replay: null, locked: false };
      }
      await saveWorkspace(); render(); toast('Configuration imported. Select a dataset in each bot before running.');
    }
  })().catch(error => toast(error.message, true));
});
document.addEventListener('submit', event => {
  event.preventDefault(); const form = event.target;
  void (async () => {
    if (form.getAttribute('id') === 'bot-form') {
      try {
        await waitForSuggestedInputs(form);
        const values = Object.fromEntries(new FormData(form)), data = metadata.find(d => d.id === values.datasetId);
        if (!data) throw new Error('Select a local dataset.');
        const bot = { ...values, id: values.id || crypto.randomUUID(), symbol: data.symbol, enabled: workspace.strategies.find(b => b.id === values.id)?.enabled ?? true, entryRule, exitRule };
        for (const key of ['level', 'budget', 'stopPct', 'targetPct', 'exitLevel', 'exitSessions', 'exitMinGainPct']) bot[key] = +form.elements[key].value;
        validateStrategy(bot, workspace.risk);
        if (!values.id && workspace.strategies.length >= 20) throw new Error('At most 20 active strategies.');
        workspace.strategies = workspace.strategies.filter(b => b.id !== bot.id).concat(structuredClone(bot)); await saveWorkspace();
        $('#bot-dialog').close(); render();
      } catch (error) { $('#bot-error').textContent = error.message; }
    } else if (form.getAttribute('id') === 'risk-form') {
      const risk = Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, +v]));
      validateRisk(risk); workspace.risk = risk;
      toast(await saveWorkspace() ? 'Risk limits saved for subsequent runs.' : 'Risk limits changed in this tab only; storage failed.', !$('#storage-status').hidden);
      refreshQuickForm();
    } else if (form.getAttribute('id') === 'quick-form') {
      if (busy) throw new Error('Wait for the current operation or cancel it first.');
      pause(); const revision = cancellation;
      busy = true; $('#quick-error').hidden = true; refreshQuickForm();
      try {
        const config = await quickConfig();
        if (revision !== cancellation) throw new Error('Backtest cancelled.');
        const report = { id: crypto.randomUUID(), ...await oneOff('run', config) };
        reports.unshift(reportMetadata(report)); latestReport = report;
        try { await saveReport(report); } catch (error) { unsavedReports.set(report.id, report); storageError(error); }
        showReport(report); track('backtest_completed');
      } catch (error) {
        $('#quick-error').hidden = false; $('#quick-error').textContent = error.message; $('#quick-error').focus();
      } finally { busy = false; render(); }
    } else if (form.getAttribute('id') === 'replay-form') {
      pause(); const config = await configFromForm(form);
      busy = true; refreshQuickForm();
      try { await startReplay(config); }
      finally { busy = false; render(); }
    } else if (form.getAttribute('id') === 'seek-form') {
      if (!replayConfig || !replayWorker) throw new Error('Initialize a replay first.');
      pause(); const steps = +form.elements.steps.value;
      if (!Number.isSafeInteger(steps) || steps < 0 || steps > (snapshot?.total ?? 0)) throw new Error('Invalid seek step.');
      snapshot = await request(replayWorker, 'seek', { config: replayConfig, steps }); workspace.locked = false; replayActions = [];
      await persistReplay(); render();
    }
  })().catch(error => toast(error.message, true));
});
try {
  const [saved, data, runs] = await Promise.all([storageAction('workspace', 'get', 'current'), storageAction('datasetMeta', 'getAll'), storageAction('reportMeta', 'getAll')]);
  if (saved) { validateRisk(saved.risk); workspace = saved; }
  metadata = data; reports = runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
} catch (error) { storageError(error); }
render(); track('page_view', page);
try {
  const response = await fetch(new URL('./bundles/manifest.json', import.meta.url));
  if (!response.ok) throw new Error('Bundled dataset manifest could not be loaded.');
  bundles = availableBundles(await response.json());
  refreshQuickForm();
} catch (error) { toast(error.message, true); }
