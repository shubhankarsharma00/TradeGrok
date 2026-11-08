const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const rupees = value => Number.isFinite(value) ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(value) : 'Unavailable';
const integer = value => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value);
const date = value => value ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) : 'Not checked yet';
let state;
const smartApiResult = new URLSearchParams(location.search).get('smartapi');
let page = smartApiResult || location.hash === '#broker' ? 'broker' : 'overview';
if (smartApiResult) history.replaceState(null, '', '/');
let refreshing = null;
let toastTimer;
let symbolSearchTimer;
let symbolSearchRevision = 0;
let logView = null;
let logRevision = 0;
const noticeStates = new Map();
let onboardingStep = smartApiResult ? 3 : 0;
let onboardingOpen = false;
const pages = { overview: 'Overview', bots: 'My bots', bin: 'Bot bin', orders: 'Order journal', broker: 'Broker connection', settings: 'Risk & settings', logs: 'Bot logs' };

async function api(path, input) {
  const response = await fetch(path, input === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tradegrok-CSRF': state?.csrf || '' }, body: JSON.stringify(input)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}
function toast(message, error = false) {
  const el = $('#toast');
  el.textContent = message; el.classList.toggle('error', error); el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}
async function refresh(render = true) {
  if (refreshing) {
    if (!render) return;
    await refreshing;
  }
  const pending = (async () => {
    try {
      state = await api('/api/state');
      $('#bot-count').textContent = state.bots.length;
      $('#emergency').textContent = state.settings.emergency ? 'Release entry lock' : 'Pause all entries';
      $('#emergency').classList.toggle('locked', state.settings.emergency);
      if (render) renderPage();
    } catch (error) {
      if (!state) $('#main').innerHTML = `<div class="empty"><h2>Workspace unavailable</h2><p>${escape(error.message)}</p><button class="button primary" data-action="retry">Try again</button></div>`;
      else toast(`Dashboard refresh failed: ${error.message}`, true);
    }
  })();
  refreshing = pending;
  try { await pending; } finally { if (refreshing === pending) refreshing = null; }
}
function heading(title, subtitle, action = true) {
  return `<div class="page-heading"><div><span class="eyebrow">YOUR PERSONAL TRADING DESK</span><h1>${title}</h1><p>${subtitle}</p></div>${action ? '<button class="button primary" data-action="create"><span>+</span> Create bot</button>' : ''}</div>`;
}
function collapsibleNotice(id, tone, title, content, alert = false) {
  const signature = JSON.stringify([tone, title, content]);
  if (noticeStates.get(id)?.signature !== signature) noticeStates.set(id, { signature, open: tone === 'danger' });
  return `<details class="notice collapsible-notice ${tone}" data-notice-id="${escape(id)}"${noticeStates.get(id).open ? ' open' : ''}><summary>${title}</summary><div class="notice-content"${alert ? ' role="alert"' : ''}>${content}</div></details>`;
}
function banners() {
  return `${state.settings.emergency ? collapsibleNotice('entry-lock', 'danger', 'Entry lock active.', 'All bots paused. Existing paper exit strategies, stops and targets are still monitored; positions were not flattened.') : ''}
    ${state.engine.error ? collapsibleNotice('market-data', 'danger', 'Market data unavailable.', `${escape(state.engine.error)} Last successful cycle: ${date(state.engine.lastTick)}.`) : ''}
    ${state.engine.analysisLog?.error ? collapsibleNotice('analysis-log', 'danger', 'Analysis log incomplete.', escape(state.engine.analysisLog.error), true) : ''}
    ${(state.engine.marketWindows ?? []).filter(window => window.specialSession).map(window => collapsibleNotice(`market-window:${window.symbol}`, window.open ? 'subtle' : 'warning', `NSE:${escape(window.symbol)} Muhurat paper window ${window.open ? 'open' : 'closed'}.`, `${escape(window.description)} No automatic liquidation at close; existing exit rules remain unchanged.`)).join('')}
    ${state.metrics.unavailablePositions ? collapsibleNotice('stale-positions', 'warning', 'Some open positions have no saved valid SmartAPI quote.', 'Equity and unrealised P&amp;L are unavailable until prices are received. No fills on stale prices.') : state.metrics.stalePositions ? collapsibleNotice('stale-positions', 'warning', 'Equity and unrealised P&amp;L use last known SmartAPI prices.', `Oldest position quote: ${date(state.metrics.valuationAt)} IST. These are not live values. No fills on stale prices.`) : ''}`;
}
function sourcePill() { return '<span class="pill mint">SMARTAPI MARKET DATA</span>'; }
function exitWindowOpen(symbol) {
  const window = state.engine.marketWindows?.find(item => item.symbol === symbol);
  if (window) return window.open;
  const now = new Date(Date.now() + 19800000);
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  return now.getUTCDay() >= 1 && now.getUTCDay() <= 5 && minute >= 555 && minute < 920;
}
function chart(points, className = '', height = 130) {
  if (points.length < 2) return '<div class="chart-empty">Your equity curve will appear as the runner records observations.</div>';
  const values = points.map(item => item.value);
  const lo = Math.min(...values), hi = Math.max(...values), spread = Math.max(hi - lo, 20);
  const coordinates = values.map((value, index) => `${(index / (values.length - 1) * 640).toFixed(1)},${(height - 12 - (value - lo) / spread * (height - 35)).toFixed(1)}`);
  return `<svg class="equity-chart ${className}" viewBox="0 0 640 ${height}" role="img" aria-label="Recorded paper equity curve"><path class="chart-grid" d="M0 25H640M0 65H640M0 105H640"/><path class="chart-area" d="M0 ${height} L${coordinates.join(' L')} L640 ${height} Z"/><polyline class="chart-line" points="${coordinates.join(' ')}"/></svg>`;
}
function botCard(bot) {
  const preset = state.presets.find(item => item.id === bot.preset);
  const exitPreset = state.exitPresets.find(item => item.id === (bot.exitPreset ?? 'protective'));
  const position = bot.position;
  const quote = state.quotes.find(item => item.symbol === bot.symbol);
  const hasFreshQuote = quote?.source === state.settings.mode && Number.isFinite(quote.price) && quote.price > 0 && Date.now() - Date.parse(quote.at) <= 60000 && Date.now() - Date.parse(quote.at) >= -5000;
  return `<article class="bot-card">
    <div class="bot-card-head"><span class="bot-icon">${bot.preset === 'sma' ? '⌁' : bot.preset === 'dip' ? '↘' : '↗'}</span><span class="pill ${bot.status === 'running' ? 'mint' : 'gray'}"><span class="status-dot"></span>${bot.status === 'running' ? 'Running' : 'Paused'}</span></div>
    <h3>${escape(bot.name)}</h3><p class="bot-sub">${escape(preset.name)} <span>·</span> NSE:${escape(bot.symbol)}</p>
    <div class="bot-rule">${bot.preset === 'sma' ? '5 / 12 sample crossover' : `${bot.preset === 'swing' ? 'Daily-chart level · Cross above' : bot.preset === 'dip' ? 'Buy at or below' : 'Cross above'} <strong>${Number.isFinite(bot.level) ? rupees(bot.level) : 'Configure entry level'}</strong>`}</div>
    <p class="form-help">Exit: ${escape(exitPreset.name)}${bot.exitPreset === 'support' ? ` at ${rupees(bot.exitLevel)}` : ''}${exitPreset.defaults ? ` · Session ${bot.exitSessions}, ${escape(bot.exitTime)} IST${bot.exitPreset === 'time-performance' ? ` · Below ${bot.exitMinGainPct}% price gain` : ''}` : ''}. Same-day exits allowed.</p>
    <div class="bot-stats"><div><span>Budget</span><strong>${rupees(bot.budget)}</strong></div><div><span>Stop / target</span><strong>${bot.stopPct}% / ${bot.targetPct}%</strong></div></div>
    ${position ? `<div class="position-box"><strong>${position.qty} shares · Entry ${rupees(position.entry)}</strong><span>Stop ${rupees(position.stop)} / Target ${rupees(position.target)}</span><span>Modelled paper risk ${rupees(position.maxLoss)} · SmartAPI prices</span></div>` : ''}
    ${bot.preset === 'swing' ? '<p class="form-help">Can carry overnight. Gaps can exceed stop risk; keep the server running for monitoring.</p>' : ''}
    <p class="bot-message">${escape(bot.message)}</p>
    <div class="bot-actions"><button class="button ${bot.status === 'running' ? 'secondary' : 'primary'} small" data-action="${bot.status === 'running' ? 'pause' : 'start'}" data-id="${bot.id}" ${state.settings.emergency && bot.status !== 'running' ? 'disabled' : ''}>${bot.status === 'running' ? 'Ⅱ Pause' : '▷ Start bot'}</button>
    ${position ? `<button class="button secondary small" data-action="close" data-id="${bot.id}" ${hasFreshQuote && exitWindowOpen(bot.symbol) ? '' : 'disabled'} title="${hasFreshQuote ? escape(state.engine.marketWindows?.find(item => item.symbol === bot.symbol)?.description ?? 'Manual close: weekdays 09:15-15:20 IST, including entry day.') : 'A fresh SmartAPI quote is required.'}">Close paper position</button>` : `<button class="button secondary small" data-action="edit" data-id="${bot.id}" ${bot.status === 'running' ? 'disabled' : ''}>Configure</button>`}
    <button class="button secondary small" data-action="logs" data-id="${bot.id}" aria-label="View logs for ${escape(bot.name)}">Logs</button>
    ${bot.status === 'paused' ? `<button class="button secondary small" data-action="delete" data-id="${bot.id}" ${position ? 'disabled title="Close the paper position before moving this bot to the bin."' : ''}>Move to bin</button>` : ''}</div>
  </article>`;
}
function ordersTable(limit = 100) {
  const orders = state.orders.slice(0, limit);
  if (!orders.length) return '<div class="empty compact"><span class="empty-symbol">⇄</span><h3>Your journal starts with your first fill</h3><p>Start a paper bot and let its rule trigger. Every fill and its data source will be recorded here.</p></div>';
  return `<div class="table-scroll"><table><thead><tr><th>Instrument / bot</th><th>Side</th><th>Quantity</th><th>Fill price</th><th>Net exit P&amp;L</th><th>Feed / execution</th><th>Time · IST</th></tr></thead><tbody>${orders.map(order => `<tr><td><strong>${escape(order.symbol)}</strong><small>${escape(order.botName)} · ${escape(order.reason)}</small></td><td><span class="side ${order.side.toLowerCase()}">${order.side}</span></td><td>${order.qty}</td><td>${rupees(order.price)}<small>Fee ${rupees(order.fee)}</small></td><td class="${order.pnl > 0 ? 'positive' : order.pnl < 0 ? 'negative' : ''}">${order.pnl === null ? '—' : rupees(order.pnl)}</td><td>${sourcePill(order.source)}<small>Paper fill · Never broker-submitted</small></td><td class="nowrap">${date(order.at)}</td></tr>`).join('')}</tbody></table></div>`;
}
function overview() {
  const m = state.metrics;
  const points = state.equity.filter(point => point.source === state.settings.mode && !point.stale);
  const riskUsed = Math.min(100, (m.dayLoss + m.openRisk) / state.settings.dailyLossLimit * 100);
  const recentBots = state.bots.slice(0, 3);
  return `${heading('Your rules. Your trades.', 'A clear view of your bots, capital, and the risk you control.')}
    ${banners()}
    <div class="overview-grid"><section class="portfolio-hero">
      <div class="hero-top"><span><span class="status-dot"></span> PAPER PORTFOLIO</span>${sourcePill()}</div>
      <p class="hero-label">Total paper equity · Simulated capital</p><div class="hero-value">${rupees(m.equity)}${m.totalPnl !== null ? `<span class="hero-growth ${m.totalPnl < 0 ? 'loss' : ''}">${m.totalPnl >= 0 ? '+' : ''}${rupees(m.totalPnl)} <small>since start</small></span>` : ''}</div>
      ${m.stalePositions && !m.unavailablePositions ? `<p class="hero-label">Last known prices · Oldest quote ${date(m.valuationAt)} IST</p>` : ''}
      ${chart(points)}
      <div class="hero-bottom"><div><span>Available cash</span><strong>${rupees(m.cash)}</strong></div><div><span>Invested at cost</span><strong>${rupees(m.invested)}</strong></div><div><span>Starting capital</span><strong>${rupees(state.settings.initialCash)}</strong></div></div>
    </section><section class="panel risk-panel"><div class="section-heading"><h2>Risk comes first</h2><span class="shield">◇</span></div><p class="muted">Today's realised loss + open modelled risk</p><div class="risk-number">${rupees(m.dayLoss + m.openRisk)} <span>/ ${rupees(state.settings.dailyLossLimit)}</span></div><progress class="risk-progress" max="100" value="${riskUsed}">${riskUsed}%</progress><div class="risk-legend"><span>Daily risk budget used</span><strong>${riskUsed.toFixed(0)}%</strong></div><div class="risk-row"><span>Max risk per trade</span><strong>${rupees(state.settings.maxTradeRisk)}</strong></div><div class="risk-row"><span>Entries today</span><strong>${m.entriesToday} / ${state.settings.maxDailyTrades}</strong></div><div class="risk-row"><span>Position cap</span><strong>${rupees(state.settings.maxPosition)}</strong></div><button class="text-button" data-page="settings">Manage risk controls <span>↗</span></button></section></div>
    <div class="metric-grid"><div class="metric-card"><span class="metric-icon">⌘</span><div><span>Active bots</span><strong>${m.running}<small> / ${state.bots.length} deployed</small></strong></div></div><div class="metric-card"><span class="metric-icon">▤</span><div><span>Open positions</span><strong>${m.positions}<small> paper only</small></strong></div></div><div class="metric-card"><span class="metric-icon">↗</span><div><span>Unrealised P&amp;L</span><strong class="${m.unrealised < 0 ? 'negative' : ''}">${rupees(m.unrealised)}</strong></div></div><div class="metric-card"><span class="metric-icon">◇</span><div><span>Angel One account</span><strong class="connection-value">${state.connection.status === 'connected' ? 'Connected' : 'Not connected'}</strong><button class="text-button mini" data-page="broker">Read-only connection ↗</button></div></div></div>
    <div class="section-heading bot-section-heading"><div><h2>Your bots <span class="count">${state.bots.length}</span></h2><p class="muted">Defined rules. No black boxes.</p></div><button class="text-button" data-page="bots">View all bots ↗</button></div>
    <div class="bot-grid">${recentBots.map(botCard).join('')}${state.bots.length < 3 ? '<button class="new-bot-card" data-action="create"><span>+</span><strong>Make your next move</strong><p>Turn a trading rule into a bot.</p><small>Create paper bot ↗</small></button>' : ''}</div>
    <div class="bottom-grid"><section class="panel watch-panel"><div class="section-heading"><h2>Market watch</h2>${sourcePill()}</div><p class="muted">Actual SmartAPI quotes for configured instruments · Exchange timestamps below</p>
    ${state.quotes.length ? `<div class="watch-list">${state.quotes.map(quote => `<div class="watch-item"><span class="ticker-avatar">${escape(quote.symbol.slice(0, 2))}</span><div><strong>${escape(quote.symbol)}</strong><small>NSE · ${date(quote.at)}</small></div><div><strong>${rupees(quote.price)}</strong><small class="${quote.changePct < 0 ? 'negative' : 'positive'}">${quote.changePct === null ? 'Change unavailable' : `${quote.changePct >= 0 ? '+' : ''}${quote.changePct}%`}</small></div></div>`).join('')}</div>` : '<div class="empty compact"><h3>SmartAPI quotes unavailable</h3><p>Login with Angel One and verify the connection. Prices appear only after SmartAPI returns actual data.</p><button class="button secondary" data-page="broker">Connect Angel One</button></div>'}</section>
    <section class="panel"><div class="section-heading"><h2>Workspace activity</h2><span class="pill gray">AUDIT LOG</span></div><div class="activity-list">${state.events.slice(0, 6).map(event => `<div class="activity-item"><span class="activity-dot ${event.level}"></span><div><p>${escape(event.message)}</p><small>${date(event.at)} IST</small></div></div>`).join('')}</div></section></div>
    <section class="panel journal-preview"><div class="section-heading"><h2>Recent paper orders</h2><button class="text-button" data-page="orders">Full journal ↗</button></div>${ordersTable(5)}</section>
    <p class="feed-note">SmartAPI is the only price source. Polling runs while this server is awake, including for paused bots. Regular entries: weekdays 09:15-15:20 IST; today's verified Muhurat window is shown above when applicable. Quotes older than 60 seconds are blocked. Last cycle: ${date(state.engine.lastTick)} IST.</p>`;
}
function botsPage() {
  return `${heading('Rules into action.', 'Configure, start, and monitor your predefined paper strategies.')}
    <div class="section-heading"><p class="muted">Paused bots without open positions can be moved to the bin.</p><button class="text-button" data-page="bin">Bot bin (${(state.deletedBots ?? []).length})</button></div>
    ${banners()}${collapsibleNotice('paper-data', 'subtle', sourcePill(), 'Every market price comes from Angel One. Paper cash and fills are simulated and kept separate from your actual account.')}
    <div class="bot-grid">${state.bots.map(botCard).join('')}<button class="new-bot-card" data-action="create"><span>+</span><strong>A rule worth testing?</strong><p>Give it a name, a level, and a risk limit.</p><small>Create paper bot ↗</small></button></div>
    ${backtestPanel()}
    <section class="panel preset-panel"><div class="section-heading"><h2>Entry strategies</h2><span class="pill gray">LONG-ONLY · NSE CASH</span></div><div class="preset-grid">${state.presets.map(preset => `<div><h3>${escape(preset.name)}</h3><p>${escape(preset.description)}</p>${(preset.sources ?? []).map(source => `<p><a href="${escape(source.url)}" target="_blank" rel="noopener noreferrer">${escape(source.name)}</a></p>`).join('')}</div>`).join('')}</div><p class="feed-note">Breakouts use sampled prices; moving averages use polling samples, not exchange candles. No averaging down, leverage, shorts, or derivatives. Swing defaults are illustrative, not a backtested edge.</p></section>
    <section class="panel preset-panel"><div class="section-heading"><h2>Exit strategies</h2><span class="pill gray">SAME-DAY EXITS ALLOWED</span></div><div class="preset-grid">${state.exitPresets.map(preset => `<div><h3>${escape(preset.name)}</h3><p>${escape(preset.description)}</p></div>`).join('')}</div><p class="feed-note">Choose independently of entry. Stop loss and take profit remain active with eligible fresh quotes; no Muhurat auction/post-close fills. Timers count entry day as session 1, skipping weekends and verified NSE holidays except the verified 8 November 2026 Muhurat session. Other unsupported special sessions/years produce an explicit alert. Missed deadlines use the next eligible fresh quote, not a historical fill. Performance means price gain from entry before fees and exit slippage. Without a timed rule, positions may carry overnight. No broker-side orders; keep the app running.</p></section>`;
}
function binPage() {
  const bots = state.deletedBots ?? [];
  return `<button class="text-button" data-page="bots">Back to my bots</button>
    ${heading('Bot bin', 'Removed bots no longer run or count toward your bot limit. Their saved logs and order journal remain available.', false)}
    ${banners()}
    ${bots.length ? `<div class="bot-grid">${bots.map(bot => `<article class="bot-card"><span class="pill gray">In bin</span><h3>${escape(bot.name)}</h3><p class="bot-sub">NSE:${escape(bot.symbol)}</p><p class="bot-message">Removed ${date(bot.deletedAt)} IST</p><div class="bot-actions"><button class="button secondary small" data-action="logs" data-id="${bot.id}" aria-label="View logs for ${escape(bot.name)}">Logs</button><button class="button secondary small" data-page="orders">Order journal</button></div></article>`).join('')}</div>` : '<div class="empty compact"><h2>The bot bin is empty</h2><p>Bots moved to the bin will appear here with their saved logs.</p></div>'}`;
}
function backtestPanel() {
  const run = state.backtest, summary = run?.summary;
  const matchingBots = state.bots.filter(bot => bot.name.toLowerCase() === 'safe play');
  const supported = matchingBots.length === 1 && matchingBots[0].preset === 'sma' && matchingBots[0].symbol === 'RELIANCE' && (matchingBots[0].exitPreset ?? 'protective') === 'protective';
  return `<section class="panel"><h2>safe play historical backtest</h2><p>Last seven completed NSE sessions, real Angel One five-minute candles. Saved SMA 5/12 polling samples interpreted as completed five-minute closes; next-bar-open fills, 0.05% adverse slippage and 0.05% fee per side. No changes or orders in your paper bots.</p>
    <button class="button primary" data-action="backtest" ${!supported || state.smartapi.status !== 'callback_received' || state.backtestReplaySupported !== true ? 'disabled' : ''}>Download &amp; backtest safe play</button>
    ${!supported ? '<p class="form-help">Requires exactly one safe play SMA bot on RELIANCE with Stop loss / take profit exits. Custom and timed exits are not supported by this historical replay.</p>' : ''}
    ${state.backtestReplaySupported !== true ? '<p class="form-help">Restart TradeGrok before a new download/replay to load the corrected session schedule. Today’s saved login can be restored; saved results remain available below.</p>' : ''}
    <p class="form-help">Downloads require a current Angel One session; today’s saved login survives restarts. RELIANCE requires 72 continuous bars/day (09:15–15:15 IST) plus two prior sessions; continuous gaps or zero volume block results. The 15:15–15:35 closing auction is excluded, not mistaken for missing continuous candles.</p>
    ${run ? `<p>Latest run: ${escape(run.status)}. Evaluated: ${run.evaluated.map(escape).join(', ')}.</p>
    ${summary ? `<div class="risk-row"><span>Trades / net P&amp;L</span><strong>${summary.trades} / ${rupees(summary.netPnl)}</strong></div><div class="risk-row"><span>Fees / modelled slippage</span><strong>${rupees(summary.fees)} / ${rupees(summary.slippage)}</strong></div><div class="risk-row"><span>Close-equity max drawdown</span><strong>${rupees(summary.maxDrawdown)} (${summary.maxDrawdownPct}%)</strong></div>` : '<div class="notice danger">Coverage blocked this run. No performance result was fabricated.</div>'}
    <a href="/api/backtests/latest" download="safe-play-backtest.json">Download complete dataset, trades and assumptions</a>` : ''}
    ${run && state.backtestReplaySupported === true ? '<button class="button secondary" data-action="backtest-replay">Replay saved candles and original settings</button>' : ''}
    <p class="form-help">Standalone replay funded by saved initial paper capital, not real account buying power. SMA resets each day; overnight positions carry through the excluded auction, then any remainder is simulated closed at the final continuous close (15:15 IST), not the official auction close. Same-bar conflicts choose the stop. Not a tick-level replay or prediction.</p></section>`;
}
function brokerOnboarding() {
  const labels = ['Angel One account', 'Cloudflare HTTPS', 'SmartAPI & .env', 'Login & verify'];
  const relayConfigured = state.smartapi.callbackUrl.startsWith('https://');
  const relayOrigin = relayConfigured ? new URL(state.smartapi.callbackUrl).origin : 'https://tradegrok-smartapi.YOUR_SUBDOMAIN.workers.dev';
  const localOrigin = location.origin || 'http://127.0.0.1:3100';
  const localPort = new URL(localOrigin).port || '3100';
  const reference = (url, text) => `<a href="${url}" target="_blank" rel="noreferrer">${text} ↗</a>`;
  const snippet = (title, content) => `<div class="setup-code"><span>${title}</span><pre tabindex="0" aria-label="${title}"><code>${escape(content)}</code></pre></div>`;
  const steps = [
    `<h3 id="setup-title" tabindex="-1">Set up your Angel One account</h3>
    <p class="muted">Already have an active account? Skip to step 2.</p>
    <ol class="setup-steps">
      <li><strong>Sign up with Angel One</strong><p>Choose Open Demat Account on the website or app. Verify your mobile and email, then complete KYC with PAN, Aadhaar / accepted address proof and bank details. Follow the video verification and e-sign prompts.</p></li>
      <li><strong>Wait for activation</strong><p>Confirm you can sign in and have your client ID ready. Follow Angel One's OTP / TOTP setup if prompted.</p></li>
    </ol><p class="feed-note">${reference('https://www.angelone.in/', 'Open Angel One')} · ${reference('https://www.angelone.in/knowledge-center/demat-account/how-to-open-demat-account', 'Official account-opening guide')} · ${reference('https://www.angelone.in/knowledge-center/demat-account/how-to-complete-kyc-easily', 'KYC documents & verification')}</p>`,
    `<h3 id="setup-title" tabindex="-1">Deploy the Cloudflare HTTPS relay</h3>
    <ol class="setup-steps">
      <li><strong>Sign in to Cloudflare</strong><p>In Workers &amp; Pages, choose a workers.dev subdomain on Workers Free. No domain purchase or tunnel needed.</p></li>
      <li><strong>Edit wrangler.jsonc in this repository</strong><p>Replace YOUR_SUBDOMAIN below. Keep <code>main: server/cloudflare.js</code> and match LOCAL_RETURN_ORIGIN to your local dashboard port.</p>${snippet('Worker variables (inside vars)', `"PUBLIC_ORIGIN": "${relayOrigin}",\n"LOCAL_RETURN_ORIGIN": "${localOrigin}"`)}</li>
      <li><strong>Deploy from the repository root</strong><p>Keep <code>observability.enabled: false</code>, <code>logpush: false</code> and <code>preview_urls: false</code>. Disable Workers Logs and request tracing; do not use live logs during login.</p>${snippet('Deploy the existing relay', 'npx wrangler@4 login\nnpx wrangler@4 deploy --dry-run\nnpx wrangler@4 deploy')}</li>
      <li><strong>Check HTTPS</strong><p>Use your actual deployed hostname. Expect <code>{"status":"ok"}</code>; <code>/</code> and <code>/api/state</code> must return 404.</p>${snippet('Check HTTPS health', `curl --fail ${relayOrigin}/healthz`)}</li>
    </ol><div class="notice warning">Deploy only the included relay, never .env or the dashboard. Never tunnel this local dashboard.</div>
    <p class="feed-note">${reference('https://dash.cloudflare.com/', 'Cloudflare dashboard')} · ${reference('https://developers.cloudflare.com/workers/get-started/guide/', 'Deployment docs')}</p>`,
    `<h3 id="setup-title" tabindex="-1">Create your SmartAPI app and configure .env</h3>
    <ol class="setup-steps">
      <li><strong>Create an app in SmartAPI</strong><p>Sign in → MyApps → Create App. Select access for account data, quotes and historical candles.</p></li>
      <li><strong>Set the Redirect URL</strong><p>Use your deployed hostname below. TradeGrok has no order-postback endpoint; do not use this callback as a postback.</p>${snippet(relayConfigured ? 'Configured Redirect URL' : 'Redirect URL template — replace YOUR_SUBDOMAIN', `${relayOrigin}/auth/smartapi/callback`)}</li>
      <li><strong>Edit your local .env</strong><p>In the repository root, copy <code>.env.example</code> to <code>.env</code> only if .env is missing. Add your app's API key, not its secret key. Use the relay origin without the callback path.</p>${snippet('Local .env — replace placeholders', `PORT=${localPort}\nSMARTAPI_API_KEY=REPLACE_WITH_YOUR_OWN_API_KEY\nSMARTAPI_RELAY_ORIGIN=${relayOrigin}`)}<p>Keep .env private and out of Git. Do not add passwords or TOTP secrets.</p></li>
      <li><strong>Check any IP allowlist and restart</strong><p>If required by your SmartAPI app, allowlist this computer's static public IPv4 (ask your ISP). Cloudflare HTTPS does not provide a static outbound IP. This command reports your current IP only:</p>${snippet('Check current public IPv4', 'curl --fail --silent --show-error --ipv4 https://api.ipify.org')}<p>Restart with <code>npm start</code>. PORT must match the relay's LOCAL_RETURN_ORIGIN. After a network change, recheck the allowlist and restart.</p></li>
    </ol><div class="setup-checks" aria-label="Detected local configuration"><span class="pill ${state.smartapi.configured ? 'mint' : 'amber'}">API KEY: ${state.smartapi.configured ? 'LOADED' : 'MISSING'}</span><span class="pill ${relayConfigured ? 'mint' : 'amber'}">HTTPS RELAY: ${relayConfigured ? 'CONFIGURED' : 'MISSING'}</span><button class="text-button" data-action="retry">Recheck local configuration</button></div>
    <p class="form-help">Checks show local configuration, not deployment health or broker access.</p>
    <p class="feed-note">${reference('https://smartapi.angelone.in/', 'Open SmartAPI')} · ${reference('https://smartapi.angelone.in/docs', 'SmartAPI docs')}</p>`,
    `<h3 id="setup-title" tabindex="-1">Sign in, then verify read-only access</h3>
    <ol class="setup-steps">
      <li><strong>Login with Angel One</strong><p>Open <a href="${escape(localOrigin)}/#broker">${escape(localOrigin)}</a> (not localhost). <button class="text-button" data-action="smartapi-login" ${state.smartapi.configured && relayConfigured ? '' : 'disabled'}>Click here to test Angel One login</button>. Keep the server running; finish in this browser within five minutes. Enter credentials and OTP / TOTP only on Angel One.</p>${state.smartapi.configured && relayConfigured ? '' : '<p>Complete step 3 to enable login.</p>'}</li>
      <li><strong>Verify the connection</strong><p>On return, choose Verify read-only connection below. Callback received means tokens arrived, not that the account was verified.</p></li>
    </ol><div class="setup-checks"><span class="pill ${state.connection.status === 'connected' ? 'mint' : 'amber'}">${state.connection.status === 'connected' ? 'READ-ONLY ACCOUNT VERIFIED' : 'ACCOUNT NOT VERIFIED'}</span></div>`
  ];
  return `<details id="broker-onboarding" class="panel onboarding-panel"${onboardingOpen ? ' open' : ''}>
    <summary class="setup-summary"><div><h2 id="onboarding-title">Broker setup guide</h2><p class="muted">Account, HTTPS and API configuration.</p></div><span class="setup-disclosure">Show / hide guide</span></summary>
    <div class="setup-progress"><span class="pill outlined">STEP ${onboardingStep + 1} OF 4</span></div>
    <nav class="setup-nav" aria-label="Broker setup steps">${labels.map((label, index) => `<button class="setup-step ${index === onboardingStep ? 'active' : ''}" data-setup-step="${index}"${index === onboardingStep ? ' aria-current="step"' : ''}><span>${index + 1}</span>${label}</button>`).join('')}</nav>
    <div class="setup-content">${steps[onboardingStep]}</div>
    <div class="setup-actions"><button class="button secondary" data-setup-step="${onboardingStep - 1}" ${onboardingStep === 0 ? 'disabled' : ''}>Back</button>${onboardingStep < 3 ? `<button class="button primary" data-setup-step="${onboardingStep + 1}">Next: ${labels[onboardingStep + 1]} <span>→</span></button>` : '<button class="button secondary" data-setup-step="0">Review from the start</button>'}</div>
  </details>`;
}
function brokerPage() {
  const c = state.connection;
  const account = state.account;
  const relayConfigured = state.smartapi.callbackUrl.startsWith('https://');
  const table = (items, kind) => `<div class="table-scroll"><table><thead><tr><th>Instrument</th><th>Quantity</th><th>Average cost</th>${kind === 'positions' ? '<th>Realised P&amp;L</th>' : ''}</tr></thead><tbody>${items.map(row => `<tr><td><strong>${escape(row.symbol)}</strong></td><td>${escape(row.quantity)}</td><td>${typeof row.averagePrice === 'number' ? rupees(row.averagePrice) : 'Unavailable'}</td>${kind === 'positions' ? `<td>${typeof row.realisedPnl === 'number' ? rupees(row.realisedPnl) : 'Unavailable'}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
  return `${heading('Broker connection', 'Connect Angel One for real market data. Execution stays paper-only.', false)}
    ${brokerOnboarding()}
    ${smartApiResult === 'error' ? '<div class="notice danger" role="alert">SmartAPI callback rejected or login incomplete. Start a new Angel One login below; complete it within five minutes in this browser.</div>' : ''}
    <div class="broker-grid"><section class="panel connection-panel"><div class="section-heading"><h2>Angel One SmartAPI</h2><span class="pill ${state.smartapi.status === 'callback_received' ? 'mint' : 'amber'}">${escape(state.smartapi.status.replaceAll('_', ' '))}</span></div>
    <p class="form-help">${relayConfigured ? 'SmartAPI Redirect URL' : 'Local callback (HTTPS setup required)'}: <code>${escape(state.smartapi.callbackUrl)}</code></p>
    ${collapsibleNotice('broker-login-info', relayConfigured ? 'subtle' : 'warning', relayConfigured ? 'Login instructions' : 'Setup required', `<p>${escape(state.smartapi.message)}</p><p>${relayConfigured ? 'Keep TradeGrok running and finish login in this browser within five minutes. Enter credentials only on Angel One.' : 'Set SMARTAPI_API_KEY and SMARTAPI_RELAY_ORIGIN in your local .env, then restart. Use the setup guide above; never expose this dashboard publicly.'}</p><p>After login, verify read-only account access. Callback receipt alone does not verify your account.</p>`)}
    <button class="button primary" data-action="smartapi-login" ${state.smartapi.configured ? '' : 'disabled'}>${relayConfigured ? 'Login with Angel One' : 'Local development login'}</button>
    <button class="button secondary" data-action="smartapi-disconnect">Clear local SmartAPI session</button>
    ${collapsibleNotice('broker-session-info', 'subtle', 'Local session details', `<p>Received: ${date(state.smartapi.receivedAt)}. ${state.smartapi.persisted ? 'Saved locally for today; survives restarts. ' : ''}${state.smartapi.restored ? 'Restored after restart; verify account access again. ' : ''}Expires at midnight IST.</p><p>Clearing the local session deletes its saved file, but does not log out or revoke tokens at Angel One.</p>`)}</section>
    <section class="panel connection-panel"><div class="section-heading"><div class="broker-brand"><span class="broker-mark" aria-hidden="true">↗</span><div><h2>Account verification</h2><p class="muted">Read-only access</p></div></div><span class="pill ${c.status === 'connected' ? 'mint' : 'amber'}">${escape(c.status.replaceAll('_', ' '))}</span></div>
    ${collapsibleNotice('broker-verification-info', c.status === 'error' ? 'danger' : c.status === 'connected' ? 'subtle' : 'warning', c.status === 'error' ? 'Verification failed' : 'Verification details', escape(c.message), c.status === 'error')}
    <div class="risk-row"><span>Last verified</span><strong>${date(c.checkedAt)} IST</strong></div><div class="risk-row"><span>Session expiry</span><strong>${c.expiresAt ? `${date(c.expiresAt)} IST` : 'Midnight IST'}</strong></div><div class="risk-row"><span>Execution</span><strong>Paper fills only</strong></div>
    <button class="button primary" data-action="connect">${c.status === 'connected' ? 'Refresh real account' : 'Verify read-only connection'} ↗</button></section></div>
    ${collapsibleNotice('broker-safety-info', 'warning', 'Paper execution only', 'Angel One provides holdings, cash-segment positions, quotes and historical candles. No broker order is placed, changed or cancelled. Real account snapshots are separate from paper cash. Start each paper bot explicitly after reviewing risk settings.')}
    ${account ? `<section class="panel account-panel"><div class="section-heading"><h2>Real Angel One holdings</h2><span class="pill mint">REAL ACCOUNT SNAPSHOT</span></div><p class="muted">Fetched ${date(account.checkedAt)} IST. ${c.status !== 'connected' ? 'Connection is not currently verified; this is a historical snapshot.' : 'Refresh explicitly to update.'} Separate from your paper portfolio.</p>${account.holdings.length ? table(account.holdings, 'holdings') : '<div class="empty compact"><p>Angel One returned no holdings for this account.</p></div>'}</section>
    <section class="panel account-panel"><div class="section-heading"><h2>Real cash-segment positions</h2><span class="pill mint">REAL ACCOUNT SNAPSHOT</span></div>${account.positions.length ? table(account.positions, 'positions') : '<div class="empty compact"><p>Angel One returned no cash-segment positions.</p></div>'}</section>` : '<section class="panel empty"><span class="empty-symbol">◇</span><h3>No account data yet</h3><p>Login and verify to see your holdings and positions.</p></section>'}
    <p class="feed-note">Official reference: <a href="https://smartapi.angelone.in/docs" target="_blank" rel="noreferrer">Angel One SmartAPI documentation ↗</a></p>`;
}
function settingsPage() {
  const s = state.settings;
  return `${heading('Guardrails, not guesswork.', 'Define the boundaries every bot must operate within.', false)}
    ${banners()}<div class="settings-grid"><section class="panel"><h2>Paper risk controls</h2><p class="muted">Shared by all bots. These limits never grant live-trading permission.</p><form id="risk-form">
    <input type="hidden" name="mode" value="angel">
    <p class="form-help">Market data: Angel One SmartAPI only. Paper cash is simulated; actual broker balances and holdings are never used as paper capital.</p>
    <div class="form-grid"><label>Max modelled loss per trade (₹)<input name="maxTradeRisk" type="number" step="0.01" min="1" max="10000" value="${s.maxTradeRisk}" required></label><label>Daily loss + open risk limit (₹)<input name="dailyLossLimit" type="number" step="0.01" min="1" max="50000" value="${s.dailyLossLimit}" required></label></div>
    <div class="form-grid"><label>Max position notional (₹)<input name="maxPosition" type="number" step="0.01" min="100" max="${s.initialCash}" value="${s.maxPosition}" required></label><label>Max entries per IST day<input name="maxDailyTrades" type="number" step="1" min="1" max="50" value="${s.maxDailyTrades}" required></label></div>
    <p id="risk-error" class="form-error" role="alert"></p><button class="button primary" type="submit">Save risk controls ↗</button></form></section>
    <section class="panel safety-panel"><span class="eyebrow">THE SAFETY CONTRACT</span><h2>What this app will not do</h2><div class="safety-list"><div><span>✓</span><p><strong>No live transactions</strong>The broker adapter has only allowlisted read endpoints. There is no live-enable switch or order submission endpoint.</p></div><div><span>✓</span><p><strong>No hidden leverage</strong>Cash-funded, whole-share, long-only NSE equity simulations. One position per bot and one entry per bot per IST day.</p></div><div><span>✓</span><p><strong>No stale-data fills</strong>Quotes older than 60 seconds are blocked. SmartAPI failures block fills; no substitute prices are used.</p></div><div><span>✓</span><p><strong>No guaranteed stops or returns</strong>Simulated fills apply 0.05% adverse slippage and a 0.05% fee per side. Actual taxes, brokerage and execution can differ. Gaps can exceed modelled risk.</p></div></div>
    <div class="notice subtle">Entry lock pauses new entries, not exit monitoring. Limits apply to new entries; lowering limits does not resize or close existing positions. Runs only while the local server is awake.</div></section></div>`;
}
function renderPage() {
  const guide = $('#broker-onboarding');
  if (guide) onboardingOpen = guide.open;
  document.querySelectorAll('details[data-notice-id]').forEach(notice => {
    const saved = noticeStates.get(notice.dataset.noticeId);
    if (saved) saved.open = notice.open;
  });
  $('#page-label').textContent = pages[page];
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.page === page));
  $('#main').innerHTML = page === 'logs' ? logsPage() : page === 'overview' ? overview() : page === 'bots' ? botsPage() : page === 'bin' ? binPage() : page === 'broker' ? brokerPage() : page === 'settings' ? settingsPage() :
    `${heading('Every fill, accounted for.', 'An immutable journal of simulated entries and exits. Prices and fees in INR.', false)}${banners()}<div class="notice subtle">Every row is a paper fill, never an Angel One order. Net exit P&amp;L excludes entry fees; total portfolio P&amp;L includes both sides. Feed labels remain attached to historical fills.</div><section class="panel">${ordersTable()}</section>`;
}
function logsPage() {
  const view = logView;
  if (!view) return '<button class="button secondary" data-page="bots">Back to my bots</button>';
  const decisions = { no_action: 'No action', blocked: 'Blocked', holding: 'Holding', buy: 'Paper buy', sell: 'Paper sell', rolled_back: 'Rolled back', skipped: 'Skipped' };
  const today = new Date(Date.parse(state.serverTime) + 19800000).toISOString().slice(0, 10);
  const inBin = (state.deletedBots ?? []).some(bot => bot.id === view.id);
  return `<button class="text-button" data-page="${inBin ? 'bin' : 'bots'}">← Back to ${inBin ? 'bot bin' : 'my bots'}</button>
    <div class="page-heading logs-heading"><div><h1 id="logs-title" tabindex="-1">${escape(view.name)} logs</h1><p>NSE:${escape(view.symbol)} · Every saved analysis, including checks that did not trade.</p></div></div>
    ${banners()}
    <section class="panel logs-panel" aria-busy="${view.loading}">
    <div class="logs-toolbar"><label>Log date · IST<input id="log-date" type="date" value="${escape(view.date)}" max="${today}" ${view.loading ? 'disabled' : ''}></label><button class="button secondary small" data-action="logs-refresh" ${view.loading ? 'disabled' : ''}>Refresh logs</button></div>
    <p class="form-help">Local file: <code>${escape(view.file || `data/logs/analysis-${view.date}.jsonl`)}</code>. Filtered to this bot, newest first. Refresh to see new checks; expand a record to view the exact saved JSON.</p>
    ${view.error ? `<div class="notice danger log-status" role="alert">${escape(view.error)} Use Refresh logs to retry.</div>` : ''}
    <p class="log-status muted" role="status">${view.loading ? 'Reading saved analysis records…' : `${view.records.length} records loaded${view.before !== null ? '; older records available' : ''}.`}</p>
    ${!view.loading && !view.error && !view.records.length ? `<div class="empty compact"><h2>${view.before !== null ? 'No matching records in this part of the file' : 'No saved analyses for this date'}</h2><p>${view.before !== null ? 'Load older records to continue searching this bot’s local history.' : 'Logging begins with this update; earlier checks cannot be reconstructed. Keep the server running, then refresh. Paused and blocked bot cycles are recorded too.'}</p></div>` : ''}
    <div class="analysis-list">${view.records.map(record => `<details class="analysis-entry"><summary><time>${date(record.at)} IST</time><strong>${escape(decisions[record.decision] ?? record.decision)}</strong><span>${record.quote?.available ? `${rupees(record.quote.latestPrice)}${record.quote.fresh ? '' : ' · stale/unusable'}` : 'No latest price'}</span></summary><p>${escape(record.reason)}</p><p class="muted">Bot entry window: ${record.market?.entryWindowOpen ? 'open' : 'closed'} · Fresh quote: ${record.quote?.fresh ? 'yes' : 'no'} · ${record.committed ? 'Paper transaction committed' : 'No committed transaction'}</p><pre tabindex="0" aria-label="Saved analysis JSON">${escape(JSON.stringify(record, null, 2))}</pre></details>`).join('')}</div>
    ${view.before !== null ? `<button class="button secondary log-status" data-action="logs-older" ${view.loading ? 'disabled' : ''}>Load older records</button>` : ''}
    </section>`;
}
async function loadLogs(older = false) {
  const view = logView, revision = ++logRevision;
  if (!view) return;
  const before = older ? view.before : null;
  if (!older) { view.records = []; view.before = null; }
  view.loading = true; view.error = null; renderPage();
  try {
    const result = await api(`/api/bots/${encodeURIComponent(view.id)}/logs?date=${encodeURIComponent(view.date)}${before === null ? '' : `&before=${before}`}`);
    if (revision !== logRevision || page !== 'logs' || view !== logView) return;
    view.records = older ? [...view.records, ...result.records] : result.records;
    view.file = result.file; view.before = result.before;
  } catch (error) {
    if (revision !== logRevision || page !== 'logs' || view !== logView) return;
    view.error = error.message;
  } finally {
    if (revision === logRevision && page === 'logs' && view === logView) { view.loading = false; renderPage(); }
  }
}
function openLogs(bot) {
  if (!bot) { toast('Bot no longer exists. Refresh the workspace.', true); return; }
  logView = { id: bot.id, name: bot.name, symbol: bot.symbol, date: new Date(Date.parse(state.serverTime) + 19800000).toISOString().slice(0, 10), records: [], before: null, file: null, error: null, loading: false };
  page = 'logs';
  void loadLogs();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function openBot(bot = null) {
  const form = $('#bot-form');
  form.reset();
  form.elements.id.value = bot?.id || '';
  clearTimeout(symbolSearchTimer); symbolSearchRevision++;
  const options = [...state.instruments];
  if (bot && !options.some(item => item.symbol === bot.symbol)) options.push({ symbol: bot.symbol, name: 'Saved NSE ticker' });
  $('#symbol-options').innerHTML = options.map(item => `<option value="${escape(item.symbol)}">${escape(item.name)}</option>`).join('');
  form.elements.symbol.value = bot?.symbol ?? state.instruments[0].symbol;
  $('#symbol-help').textContent = 'Type at least two ticker characters for SmartAPI search, then choose a result. Login required for search; NSE -EQ instruments only.';
  form.elements.preset.innerHTML = state.presets.map(item => `<option value="${item.id}">${escape(item.name)}</option>`).join('');
  form.elements.exitPreset.innerHTML = state.exitPresets.map(item => `<option value="${item.id}">${escape(item.name)}</option>`).join('');
  form.elements.exitPreset.value = bot?.exitPreset ?? 'protective';
  form.elements.budget.max = Math.min(state.settings.maxPosition, state.settings.initialCash);
  if (bot) for (const key of ['name', 'symbol', 'preset', 'level', 'budget', 'stopPct', 'targetPct', 'exitLevel', 'exitSessions', 'exitTime', 'exitMinGainPct']) form.elements[key].value = bot[key] ?? '';
  else form.elements.budget.value = Math.min(10000, state.settings.maxPosition);
  $('#bot-dialog-title').textContent = bot ? 'Configure paper bot' : 'Create a paper bot';
  $('#bot-error').textContent = '';
  presetHelp(!bot, !bot);
  exitPresetHelp(!bot);
  $('#bot-dialog').showModal();
}
async function searchSymbols(query, revision) {
  try {
    const result = await api(`/api/instruments?search=${encodeURIComponent(query)}`);
    if (revision !== symbolSearchRevision || !$('#bot-dialog').open) return;
    $('#symbol-options').innerHTML = result.instruments.map(item => `<option value="${escape(item.symbol)}">${escape(item.name)}</option>`).join('');
    $('#symbol-help').textContent = result.instruments.length
      ? `${result.instruments.length} SmartAPI NSE matches${result.more ? '; narrow the ticker prefix for more' : ''}. Choose from the dropdown.`
      : 'SmartAPI returned no matching NSE -EQ tickers. Check the ticker and try again.';
  } catch (error) {
    if (revision === symbolSearchRevision && $('#bot-dialog').open) $('#symbol-help').textContent = `Ticker search unavailable: ${error.message}`;
  }
}
function presetHelp(setLevel, applyDefaults = false) {
  const form = $('#bot-form'), preset = state.presets.find(item => item.id === form.elements.preset.value);
  $('#preset-help').textContent = preset.description;
  const sma = preset.id === 'sma';
  $('#level-label').hidden = sma;
  form.elements.level.required = !sma;
  form.elements.level.disabled = sma;
  form.elements.level.placeholder = preset.id === 'swing' ? 'Daily-chart resistance' : '';
  if (applyDefaults) {
    form.elements.stopPct.value = preset.defaults.stopPct;
    form.elements.targetPct.value = preset.defaults.targetPct;
  }
  form.elements.targetPct.min = Math.max(0.2, Number(form.elements.stopPct.value) * (preset.minRewardRisk ?? 1));
  if (setLevel) {
    if (preset.id === 'swing') {
      form.elements.level.value = '';
      return;
    }
    const quote = state.quotes.find(item => item.symbol === form.elements.symbol.value);
    const fresh = quote?.source === 'angel' && Number.isFinite(quote.price) && quote.price > 0 &&
      Date.now() - Date.parse(quote.at) <= 60000 && Date.now() - Date.parse(quote.at) >= -5000;
    form.elements.level.value = fresh ? (quote.price * (preset.id === 'dip' ? 0.99 : 1.01)).toFixed(2) : '';
  }
}
function exitPresetHelp(applyDefaults = false) {
  const form = $('#bot-form'), preset = state.exitPresets.find(item => item.id === form.elements.exitPreset.value);
  $('#exit-preset-help').textContent = preset.description;
  const timed = Boolean(preset.defaults), support = preset.id === 'support', performance = preset.id === 'time-performance';
  $('#exit-level-label').hidden = !support;
  $('#exit-time-fields').hidden = !timed;
  $('#exit-time-help').hidden = !timed;
  $('#exit-gain-label').hidden = !performance;
  for (const [name, active] of [['exitLevel', support], ['exitSessions', timed], ['exitTime', timed], ['exitMinGainPct', performance]]) {
    form.elements[name].disabled = !active;
    form.elements[name].required = active;
  }
  if (applyDefaults && timed) for (const [key, value] of Object.entries(preset.defaults)) form.elements[key].value = value;
}
document.addEventListener('click', async event => {
  const target = event.target.closest('button');
  if (!target) return;
  if (target.dataset.dismiss !== undefined) return $('#bot-dialog').close();
  if (target.dataset.setupStep !== undefined) {
    const step = Number(target.dataset.setupStep);
    if (!Number.isInteger(step) || step < 0 || step > 3) return;
    onboardingStep = step; renderPage();
    $('#setup-title').focus();
    return;
  }
  if (target.dataset.page) {
    page = target.dataset.page; renderPage(); window.scrollTo({ top: 0, behavior: 'instant' }); return;
  }
  const action = target.dataset.action;
  if (action === 'create') return openBot();
  if (action === 'edit') return openBot(state.bots.find(bot => bot.id === target.dataset.id));
  if (action === 'logs') return openLogs([...state.bots, ...(state.deletedBots ?? [])].find(bot => bot.id === target.dataset.id));
  if (action === 'logs-refresh' || action === 'logs-older') return loadLogs(action === 'logs-older');
  if (action === 'retry') return refresh();
  if (action === 'backtest' || action === 'backtest-replay') {
    target.disabled = true;
    target.textContent = 'Downloading real candles...';
    try { await api('/api/backtest/safe-play', action === 'backtest-replay' ? { reuseLatest: true } : {}); await refresh(); toast('Historical backtest saved. No bot settings or paper orders changed.'); }
    catch (error) { toast(error.message, true); await refresh(); }
    finally { target.disabled = false; }
    return;
  }
  if (action === 'smartapi-login' || action === 'smartapi-disconnect') {
    target.disabled = true;
    try {
      const result = await api(`/api/smartapi/${action === 'smartapi-login' ? 'login' : 'disconnect'}`, {});
      if (action === 'smartapi-login') location.assign(result.loginUrl);
      else { await refresh(); toast('Local SmartAPI session cleared. Angel One account settings were not changed.'); }
    } catch (error) { toast(error.message, true); }
    finally { target.disabled = false; }
    return;
  }
  if (target.id === 'emergency') {
    target.disabled = true;
    try { await api('/api/emergency', { active: !state.settings.emergency }); await refresh(); toast(state.settings.emergency ? 'Entry lock enabled. Existing positions were not flattened.' : 'Entry lock released. Start bots individually when ready.'); }
    catch (error) { toast(error.message, true); }
    finally { target.disabled = false; }
    return;
  }
  if (!['start', 'pause', 'close', 'connect', 'delete'].includes(action)) return;
  if (action === 'delete') {
    const bot = state.bots.find(bot => bot.id === target.dataset.id);
    if (!bot || bot.status !== 'paused' || bot.position) { toast('Only paused bots without an open paper position can be moved to the bin.', true); return; }
    if (!window.confirm(`Move "${bot.name}" to the bot bin? Saved logs and paper order history will be kept.`)) return;
  }
  target.disabled = true;
  try {
    await api(action === 'connect' ? '/api/broker/connect' : `/api/bots/${target.dataset.id}/${action}`, {});
    await refresh();
    toast(action === 'delete' ? 'Bot moved to the bin. Review its saved logs from My bots > Bot bin.' : action === 'connect' ? 'Real Angel One account verified. No orders sent.' : action === 'close' ? 'Paper position closed using a fresh quote.' : `Paper bot ${action === 'start' ? 'started' : 'paused'}.`);
  } catch (error) { toast(error.message, true); await refresh(); }
  finally { target.disabled = false; }
});
document.addEventListener('change', event => {
  if (event.target.id !== 'log-date' || !logView || !event.target.value) return;
  logView.date = event.target.value; logView.file = null;
  void loadLogs();
});
$('#bot-form').addEventListener('change', event => {
  if (['preset', 'symbol'].includes(event.target.name)) {
    presetHelp(true, event.target.name === 'preset');
    if (event.target.name === 'symbol') $('#bot-form').elements.exitLevel.value = '';
  }
  else if (event.target.name === 'stopPct') presetHelp(false);
  else if (event.target.name === 'exitPreset') exitPresetHelp(true);
});
$('#bot-form').addEventListener('input', event => {
  if (event.target.name !== 'symbol') return;
  const field = event.target;
  field.value = field.value.toUpperCase();
  $('#bot-form').elements.level.value = '';
  $('#bot-form').elements.exitLevel.value = '';
  clearTimeout(symbolSearchTimer);
  const revision = ++symbolSearchRevision;
  $('#symbol-options').innerHTML = '';
  const query = field.value.trim();
  if (query.length < 2 || !/^[A-Z0-9][A-Z0-9&._-]{0,39}$/.test(query)) {
    $('#symbol-help').textContent = 'Type at least two ticker characters (without NSE: or -EQ) to search.';
    return;
  }
  $('#symbol-help').textContent = 'Searching SmartAPI NSE tickers…';
  symbolSearchTimer = setTimeout(() => { void searchSymbols(query, revision); }, 600);
});
$('#bot-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target, button = form.querySelector('[type=submit]');
  const data = Object.fromEntries(new FormData(form));
  data.symbol = String(data.symbol || '').trim().toUpperCase();
  for (const name of ['level', 'budget', 'stopPct', 'targetPct', 'exitLevel', 'exitSessions', 'exitMinGainPct']) data[name] = Number(data[name] || 0);
  button.disabled = true; $('#bot-error').textContent = '';
  try {
    await api(data.id ? `/api/bots/${data.id}/configure` : '/api/bots', data);
    $('#bot-dialog').close(); await refresh(); toast('Paper bot saved. Start it when you are ready.');
  } catch (error) { $('#bot-error').textContent = error.message; }
  finally { button.disabled = false; }
});
document.addEventListener('submit', async event => {
  if (event.target.id !== 'risk-form') return;
  event.preventDefault();
  const form = event.target, button = form.querySelector('[type=submit]');
  const data = Object.fromEntries(new FormData(form));
  for (const key of ['maxTradeRisk', 'dailyLossLimit', 'maxPosition', 'maxDailyTrades']) data[key] = Number(data[key]);
  button.disabled = true;
  try { await api('/api/settings', data); await refresh(); toast('Risk controls saved. Execution remains paper only.'); }
  catch (error) {
    if ($('#risk-error')) $('#risk-error').textContent = error.message;
    else toast(error.message, true);
  }
  finally { button.disabled = false; }
});
function clock() { $('#clock').textContent = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }).format(new Date()) + ' IST'; }
clock(); setInterval(clock, 1000);
void refresh();
setInterval(() => {
  // Never replace a form the user is editing or a button with an in-flight action.
  const editing = page === 'settings' || page === 'logs' || $('#bot-dialog').open || document.activeElement?.closest('#main');
  void refresh(!editing);
}, 5000);
