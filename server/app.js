import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from './broker.js';
import { Engine, metrics, validateBot, validateRisk, istDay } from './engine.js';
import { presets, exitPresets, instruments, isNseSymbol } from './store.js';
import { SmartAPI, smartApiCallbackPath, smartApiCookie, smartApiCookiePath, smartApiOrigin } from './smartapi.js';
import { body, securityHeaders } from './http.js';
import { SmartHistory } from './history.js';
import { createBacktest, sessionDates } from './backtest.js';
import { executionWindow } from './market-calendar.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const assets = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/styles.css', ['styles.css', 'text/css']], ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]]);
assets.set('/theme.js', ['theme.js', 'text/javascript']);
assets.set('/fonts/Silkscreen-Regular.ttf', ['fonts/Silkscreen-Regular.ttf', 'font/ttf']);
assets.set('/fonts/OFL.txt', ['fonts/OFL.txt', 'text/plain']);
assets.set('/auth/smartapi/return', ['smartapi-return.html', 'text/html']);
assets.set('/smartapi-return.js', ['smartapi-return.js', 'text/javascript']);

export function createApp(store, broker, { now = () => Date.now(), smartapi = new SmartAPI({ now }), smartapiRelayOrigin = '', history = new SmartHistory(smartapi, { now }), analysisLog = null, configFile = null } = {}) {
  const relayOrigin = smartapiRelayOrigin ? smartApiOrigin(smartapiRelayOrigin) : '';
  const engine = new Engine(store, broker, { now, analysisLog });
  const csrf = randomBytes(32).toString('hex');
  let connecting = false;
  let backtesting = false;
  let searching = false;
  let lastSearch = null;
  const server = createServer(async (req, res) => {
    securityHeaders(res);
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) throw new AppError('Only localhost access is allowed.', 403);
      const origin = `http://${req.headers.host}`;
      const url = new URL(req.url, origin);
      const localOrigin = `http://127.0.0.1:${server.address().port}`;
      const callbackUrl = `${relayOrigin || localOrigin}${smartApiCallbackPath}`;
      if (url.pathname === smartApiCallbackPath) {
        if (req.method === 'POST' && relayOrigin) {
          if (origin !== localOrigin || req.headers.origin !== localOrigin || req.headers['sec-fetch-site'] === 'cross-site') {
            throw new AppError('SmartAPI handoff must come from the local return page.', 403, 'SMARTAPI_ORIGIN');
          }
          if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('Content-Type must be application/json.', 415);
          const input = await body(req);
          try { smartapi.receiveRelay(input, req.headers.cookie, callbackUrl); }
          finally { res.setHeader('Set-Cookie', `${smartApiCookie}=; HttpOnly; SameSite=Lax; Path=${smartApiCookiePath}; Max-Age=0`); }
          return json(200, { status: 'callback_received' });
        }
        if (req.method !== 'GET') throw new AppError('SmartAPI callback requires GET.', 405);
        let result = 'received';
        try { smartapi.receive(url, req.headers.cookie); }
        catch (error) {
          if (!(error instanceof AppError)) throw error;
          result = 'error';
        }
        res.setHeader('Set-Cookie', `${smartApiCookie}=; HttpOnly; SameSite=Lax; Path=${smartApiCookiePath}; Max-Age=0`);
        res.writeHead(303, { Location: `/?smartapi=${result}` });
        return res.end();
      }
      if (url.pathname.startsWith('/api/') &&
          ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site')) {
        throw new AppError('Cross-origin access is blocked.', 403);
      }
      if (url.pathname.startsWith('/api/') && req.method !== 'GET') {
        const supplied = Buffer.from(req.headers['x-tradegrok-csrf'] || '');
        const expected = Buffer.from(csrf);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new AppError('Refresh the dashboard before making changes.', 403, 'CSRF');
        if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('Content-Type must be application/json.', 415);
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const settings = store.settings();
        const latest = store.latestBacktest();
        return json(200, {
          csrf, settings, bots: store.bots(), deletedBots: store.deletedBots(), orders: store.orders().slice(0, 100), events: store.events(),
          equity: store.equity(), quotes: [...engine.quotes.values()], presets, exitPresets, instruments,
          metrics: metrics(store, engine.quotes, now()), connection: broker.status(), smartapi: smartapi.status(callbackUrl), smartapiConfigWritable: Boolean(configFile),
          account: broker.account, engine: { busy: engine.busy, lastTick: engine.lastTick, error: engine.error, marketWindows: [...new Set(store.bots().map(bot => bot.symbol))].map(symbol => executionWindow(now(), symbol)), analysisLog: { ...(analysisLog ? analysisLog.status(now()) : { enabled: false }), error: engine.loggingError } },
          backtest: latest ? { id: latest.id, createdAt: latest.createdAt, status: latest.status, evaluated: latest.sessions.evaluated, summary: latest.result?.summary || null, coverage: latest.coverage } : null,
          backtestReplaySupported: true,
          execution: 'paper', liveEnabled: false, serverTime: new Date(now()).toISOString()
        });
      }
      const logsMatch = url.pathname.match(/^\/api\/bots\/([a-f0-9-]+)\/logs$/);
      if (req.method === 'GET' && logsMatch) {
        if (!store.bot(logsMatch[1], true)) throw new AppError('Bot not found.', 404);
        if (!analysisLog) throw new AppError('Local analysis logging is not enabled for this server.', 503, 'ANALYSIS_LOG');
        const cursor = url.searchParams.get('before');
        if (cursor !== null && !/^\d{1,16}$/.test(cursor)) throw new AppError('Invalid log page cursor.', 400, 'ANALYSIS_CURSOR');
        return json(200, await analysisLog.read(logsMatch[1], url.searchParams.get('date') ?? istDay(now()), cursor === null ? null : Number(cursor)));
      }
      if (req.method === 'GET' && url.pathname === '/api/backtests/latest') {
        const latest = store.latestBacktest();
        if (!latest) throw new AppError('No historical backtest has been downloaded yet.', 404, 'BACKTEST_NOT_FOUND');
        return json(200, latest);
      }
      if (req.method === 'GET' && url.pathname === '/api/instruments') {
        const query = (url.searchParams.get('search') || '').trim().toUpperCase();
        if (query.length < 2 || !isNseSymbol(query)) throw new AppError('Type at least two characters of an NSE ticker to search.', 400, 'SMARTAPI_INSTRUMENT');
        if (searching || (lastSearch !== null && now() - lastSearch < 1100)) throw new AppError('Ticker search is busy. Wait a moment and retry.', 429, 'SMARTAPI_RATE_LIMIT');
        searching = true; lastSearch = now();
        try {
          const matches = await broker.searchSymbols(query);
          return json(200, { instruments: matches.slice(0, 50).map(({ symbol, name }) => ({ symbol, name })), more: matches.length > 50 });
        } finally { searching = false; }
      }
      if (req.method === 'POST' && url.pathname === '/api/backtest/safe-play') {
        const input = await body(req);
        if (Object.keys(input).some(key => key !== 'reuseLatest') || (Object.hasOwn(input, 'reuseLatest') && typeof input.reuseLatest !== 'boolean')) throw new AppError('This backtest supports only saved safe play, seven completed sessions and five-minute candles; reuseLatest must be boolean.', 400, 'BACKTEST_SCOPE');
        if (backtesting) throw new AppError('A historical backtest is already running.', 409, 'BACKTEST_BUSY');
        const cached = input.reuseLatest ? store.latestBacktest() : null;
        if (input.reuseLatest && !cached) throw new AppError('No saved historical dataset exists to replay.', 404, 'BACKTEST_NOT_FOUND');
        const bots = store.bots().filter(bot => bot.name.toLowerCase() === 'safe play');
        if (bots.length !== 1 || bots[0].preset !== 'sma' || bots[0].symbol !== 'RELIANCE') throw new AppError('Exactly one saved safe play SMA bot on RELIANCE is required; other instruments need verified session schedules.', 422, 'BACKTEST_BOT');
        if (!input.reuseLatest && (bots[0].exitPreset ?? 'protective') !== 'protective') throw new AppError('The safe play historical backtest supports protective stop/target exits only, not the selected exit strategy.', 422, 'BACKTEST_EXIT');
        if (cached && cached.snapshot.bot.id !== bots[0].id) throw new AppError('Saved dataset belongs to a different bot. Download history for current safe play.', 409, 'BACKTEST_BOT');
        const bot = cached ? cached.snapshot.bot : bots[0], settings = cached ? cached.snapshot.settings : store.settings(), sessions = cached ? cached.sessions : sessionDates(now());
        backtesting = true;
        try {
          const download = cached ? {
            ...cached.dataset,
            data: cached.dataset.candles.map(bar => [bar.at, bar.open, bar.high, bar.low, bar.close, bar.volume])
          } : await history.download(bot.symbol, sessions.all);
          const run = createBacktest(download, bot, settings, sessions, { createdAt: new Date(now()).toISOString(), replayedFrom: cached?.id, expectedSha256: cached?.dataset.sha256 });
          store.transaction(() => store.saveBacktest(run));
          if (run.status === 'blocked') return json(422, { error: 'Coverage incomplete or zero-volume/unexpected sessions found. Dataset saved; no result computed and no older sessions substituted.', code: 'BACKTEST_COVERAGE', backtest: run });
          return json(200, run);
        } finally { backtesting = false; }
      }
      if (req.method === 'POST' && url.pathname === '/api/smartapi/config') {
        const input = await body(req);
        if (origin !== localOrigin || req.headers.origin !== localOrigin) throw new AppError('Save broker settings from the local 127.0.0.1 dashboard only.', 403, 'SMARTAPI_ORIGIN');
        if (!configFile) throw new AppError('Local configuration saving is not enabled. Edit .env directly.', 503, 'SMARTAPI_CONFIG_FILE');
        return json(200, configFile.save(input, { port: server.address().port }));
      }
      if (req.method === 'POST' && url.pathname === '/api/smartapi/login') {
        await body(req);
        if (origin !== localOrigin) throw new AppError(`Open ${localOrigin} before starting SmartAPI login.`, 409, 'SMARTAPI_ORIGIN');
        const { loginUrl, browser } = smartapi.start(callbackUrl);
        res.setHeader('Set-Cookie', `${smartApiCookie}=${browser}; HttpOnly; SameSite=Lax; Path=${smartApiCookiePath}; Max-Age=300`);
        return json(200, { loginUrl });
      }
      if (req.method === 'POST' && url.pathname === '/api/smartapi/disconnect') {
        await body(req);
        smartapi.clear();
        res.setHeader('Set-Cookie', `${smartApiCookie}=; HttpOnly; SameSite=Lax; Path=${smartApiCookiePath}; Max-Age=0`);
        return json(200, smartapi.status(callbackUrl));
      }
      if (req.method === 'POST' && url.pathname === '/api/broker/connect') {
        await body(req);
        if (connecting) throw new AppError('A connection check is already running.', 409);
        if (broker.accountFetchedAt && now() - broker.accountFetchedAt < 15000) throw new AppError('Wait 15 seconds between account refreshes.', 429);
        connecting = true;
        try { return json(200, await broker.connect()); }
        finally { connecting = false; }
      }
      if (req.method === 'POST' && url.pathname === '/api/bots') {
        const input = await body(req);
        if (store.bots().length >= 12) throw new AppError('This personal workspace supports up to 12 bots.');
        const config = validateBot(input, store.settings());
        if (!instruments.some(item => item.symbol === config.symbol)) await broker.resolveSymbol(config.symbol);
        const bot = { ...config, id: randomUUID(), status: 'paused', position: null, samples: [], exitSamples: [], previous: null, lastEntryDay: null, message: 'Configured. Start to watch for your entry rule; exit strategy and protection monitor held positions.', revision: 0, createdAt: new Date(now()).toISOString() };
        store.transaction(() => {
          if (store.bots().length >= 12) throw new AppError('This personal workspace supports up to 12 bots.');
          Object.assign(bot, validateBot(input, store.settings()));
          store.saveBot(bot); store.event('info', `${bot.name} created in paper mode.`, bot.id);
        });
        return json(201, bot);
      }
      const match = url.pathname.match(/^\/api\/bots\/([a-f0-9-]+)\/(start|pause|close|configure|delete)$/);
      if (req.method === 'POST' && match) {
        const input = await body(req);
        let bot = store.bot(match[1]);
        if (!bot) throw new AppError('Bot not found.', 404);
        const action = match[2];
        if (action === 'configure') {
          if (bot.status === 'running' || bot.position) throw new AppError('Pause the bot and close its paper position before editing.', 409);
          const config = validateBot(input, store.settings());
          if (!instruments.some(item => item.symbol === config.symbol)) await broker.resolveSymbol(config.symbol);
          bot = store.bot(match[1]);
          if (!bot) throw new AppError('Bot not found.', 404);
        }
        const analysis = action === 'close' ? engine.analysisRecord(bot, engine.quotes.get(bot.symbol)) : null;
        if (analysis) analysis.trigger = 'manual_close';
        try { store.transaction(() => {
          if (action === 'start') {
            const settings = store.settings();
            if (settings.emergency) throw new AppError('Release the emergency entry lock before starting bots.', 409);
            if (broker.status().status !== 'connected') throw new AppError('Verify your Angel One read-only connection first.', 409);
            validateBot(bot, settings);
            if (bot.status !== 'running') { bot.samples = []; bot.previous = null; }
            bot.status = 'running'; bot.message = 'Watching for your entry rule.';
          } else if (action === 'pause') {
            bot.status = 'paused'; bot.message = bot.position ? 'Entries paused. Exit strategy, stops and targets still monitored.' : 'Paused. No new entries.';
          } else if (action === 'configure') {
            if (bot.status === 'running' || bot.position) throw new AppError('Pause the bot and close its paper position before editing.', 409);
            Object.assign(bot, validateBot(input, store.settings()), { samples: [], exitSamples: [], previous: null, message: 'Entry and exit configuration updated.' });
          } else if (action === 'delete') {
            if (bot.status !== 'paused' || bot.position) throw new AppError('Pause the bot and close its paper position before moving it to the bin.', 409);
            bot.deletedAt = new Date(now()).toISOString();
            bot.message = 'Moved to the bin. Saved logs and paper order history are retained.';
          } else {
            engine.exit(bot, engine.quotes.get(bot.symbol), 'Manual paper close', analysis);
          }
          bot.revision = (bot.revision ?? 0) + 1;
          store.saveBot(bot);
          store.event('info', `${bot.name}: ${action}. Paper mode only.`, bot.id);
        }); }
        catch (error) {
          if (analysis) {
            if (analysis.fill) { analysis.proposedFill = analysis.fill; delete analysis.fill; }
            Object.assign(analysis, { decision: 'blocked', reason: 'Manual close was rejected or rolled back; no paper sell committed.', errorCode: error instanceof AppError ? error.code : 'INTERNAL' });
            engine.logAnalysis([analysis]);
          }
          throw error;
        }
        if (analysis) { analysis.committed = true; engine.logAnalysis([analysis]); }
        return json(200, bot);
      }
      if (req.method === 'POST' && url.pathname === '/api/settings') {
        const input = await body(req);
        if (input.liveEnabled === true || (input.execution && input.execution !== 'paper')) throw new AppError('Live execution is not implemented and cannot be enabled.', 403, 'LIVE_DISABLED');
        const previous = store.settings();
        const next = validateRisk(input, previous);
        if (input.mode !== undefined && input.mode !== 'angel') throw new AppError('SmartAPI is the only market-data source.', 400, 'PRICE_SOURCE');
        next.mode = 'angel';
        store.transaction(() => {
          store.saveSettings(next);
          store.event('info', 'Risk controls saved. SmartAPI market data only; execution remains paper.');
        });
        return json(200, next);
      }
      if (req.method === 'POST' && url.pathname === '/api/emergency') {
        const input = await body(req);
        if (typeof input.active !== 'boolean') throw new AppError('active must be a boolean.');
        store.transaction(() => {
          const settings = store.settings(); settings.emergency = input.active; store.saveSettings(settings);
          if (input.active) for (const bot of store.bots()) { bot.status = 'paused'; bot.revision = (bot.revision ?? 0) + 1; bot.message = 'Emergency entry lock. Existing paper exit strategies, stops and targets remain monitored.'; store.saveBot(bot); }
          store.event('warn', input.active ? 'Emergency entry lock enabled. Existing positions were NOT flattened.' : 'Entry lock released. Bots remain paused until you start them.');
        });
        return json(200, { active: input.active });
      }
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [file, mime] = assets.get(url.pathname);
        res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` });
        return res.end(await readFile(`${publicDir}${file}`));
      }
      throw new AppError('Endpoint not found.', 404, 'NOT_FOUND');
    } catch (error) {
      const known = error instanceof AppError;
      if (!known) console.error('Request failed:', error.name);
      json(known ? error.status : 500, { error: known ? error.message : 'Internal error. The operation did not complete.', code: known ? error.code : 'INTERNAL' });
    }
  });
  return { server, engine };
}
