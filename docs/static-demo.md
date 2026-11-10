# Static research demo

The public demo is HTML/CSS/JavaScript, worker scripts and permitted CSV assets.
All strategy rules, backtests, portfolio replay, imports, charts and exports run in
the browser. No TradeGrok API, serverless function, database service or broker login
is deployed. The existing Node application remains separate and unchanged in use.

## Build and preview

```sh
npm run demo:build
npm run demo:serve
```

Open `http://127.0.0.1:4173/`. Deploy **only `dist-demo/`** to any static HTTPS host.
Node 24 is needed for local tooling, not for visitors. To preview a Pages-style
subpath, use `DEMO_BASE_PATH=/TradeGrok/ npm run demo:serve` and open that path.
`file://` is not supported (modules, fetch, workers and IndexedDB require hosting).
No install or third-party runtime dependency is needed. The build copies an explicit
allowlist; `.env`, the server, sessions and private downloads never enter the output.

## Bring your own data

The demo is a hands-on preview of the local trading desk, not a second dashboard.
The main flow is **dataset -> strategy -> backtest -> replay** on one screen.
Presets run without creating or saving a bot. Choose **Strategy options** for custom
exits, sizing, saved strategies, or capital/risk settings. Entry rules appear when
you select **Custom rules**. The local setup guide links to the full paper-trading
app with broker data and read-only holdings; neither version places broker orders.
The header's **Rulebook** link opens `rulebook.html` in a new tab so the current
draft stays intact. It defines every entry/exit preset, input defaults and limits,
and walks through a nested custom rule. The saved-strategy editor also links to
its custom-rule guide. This page ships in the same static build, including on
subpath deployments.

Use **Upload CSV** beside the dataset selector to choose a CSV, provide an NSE ticker/source and adjustment
status, map columns, validate/preview and commit the import. Each file contains one
ticker, at one-minute intervals, at most 100 MiB. Any date range is allowed.
Recognized columns are mapped automatically; expand the preview to change them.
Available bundled candles are loaded on demand from the same selector.

The public demo includes ten **Synthetic demo data** datasets covering August–October
2026. These publisher-supplied candles are not verified real market history.
Their source remains labeled in the selector, dataset notice and report provenance.
The original CSVs are retained unchanged; replay excludes bars outside its declared
continuous-session window.

To republish a complete set of synthetic CSVs with explicit publication permission:

```sh
npm run demo:publish-data -- --synthetic /path/to/csvs "publication permission reference"
npm run demo:build
```

This mode validates all ten allowlisted stocks before copying any files. It does
not bypass the separate real-export redistribution checks described below.

```csv
timestamp,open,high,low,close,volume
```

The downloadable template contains only headers, not invented market data.
Timestamps must be ISO dates/times, e.g. `2026-08-03 09:15:00` or
`2026-08-03T09:15:00+05:30`. Missing offsets mean Asia/Kolkata; explicit offsets
are normalized. OHLC must be finite/positive with consistent high/low bounds.
Volume must be a nonnegative integer. Empty fields, conflicting duplicates and
off-minute timestamps fail. Identical duplicates are reported and removed;
out-of-order rows are reported and sorted. Quoted CSV fields and CRLF are supported.

Verified 2026 sessions use the existing conservative NSE schedule: 09:15–15:30
before August 3, 09:15–15:15 afterward, excluding later prints/auctions. The declared
2026 holidays and special-session limitations are retained. For an unsupported
calendar, explicitly accept the previewed observed session boundaries; this cannot
detect entirely missing sessions or prove exchange-wide completeness. Missing or
zero-volume required candles block affected ranges. No bars are fabricated.

Candles are persisted in IndexedDB and loaded by selected dataset, not all at
startup. Strategies/settings and reports are saved separately. Quota/permission
failures display **UNSAVED**, retaining available work in the tab for export.
There is no cloud synchronization. Dataset deletion, report deletion, replacement
and reset require confirmation or an explicit removal action.

## Strategies and execution

Both the quick setup and saved-strategy editor fill editable **stock-aware starter
inputs** when the dataset, entry/exit preset or start date changes. A short note
identifies their price basis; **Use suggested inputs** resets preset inputs for
the current selection without changing custom rules. Typed values, including
intentional blanks, are preserved. Price/name edits follow their stock and entry
preset; budget/stop/target edits remain shared within that form. Loaded strategies
are treated as explicit inputs, not silently retuned.

Suggestions are transparent heuristics, not optimization or predicted returns:
breakout uses the prior session high plus a small buffer, dip uses the prior close
minus half the estimated daily range, and swing uses the high of up to 20 earlier
complete sessions. Stops use the average true range of up to 14 earlier complete
sessions (1.5 times for swing), constrained to the supported 0.2–10%; targets start
at 2R. Support stays between the planned entry and protective stop when possible.
Without earlier complete sessions, defaults use the first selected session's open
and a labelled 1% baseline, never its future high/low/close or later returns.
Levels remain fixed throughout the run; they are not recalculated with hindsight.

Suggested budgets start near 10% of capital and fit estimated whole shares within
position and per-trade risk limits; those shared limits are never increased.
Actual fills, gaps, costs and portfolio risk still determine execution. A warning
appears when the limits cannot fund one share. Scheduled exits start at one session;
other timed exits use three sessions, or five for swing, at 15:00 IST (earlier on
short sessions). Time/performance exits initially require a 1R gain.

New custom checks use SMA/EMA period 20 or RSI period 14. Numeric defaults use stock
prices, RSI 30/70 for entry/exit, 1.5x/0.5x average prior-session minute volume, or
09:30/15:00 IST as appropriate. With no prior session, the volume baseline is the
first completed candle, available before the earliest possible next-open fill.
Automatically suggested constants follow context changes; edited/saved constants
are retained. New exit rules default to crossing **below** the moving average.

All four existing entry presets and six exit presets are available. Custom rules
support nested AND/OR groups (maximum depth 5, 64 nodes), OHLCV, SMA/EMA, Wilder RSI,
price constants and IST time, using above/below/crosses-above/crosses-below.
AND/OR connectors separate each group's children; a nested group's
border shows which checks it contains. The **Add to this group** buttons sit inside
that boundary. **Add condition** adds one check; **Add nested group** creates a
subgroup with its own AND/OR logic. Both buttons retain hover and screen-reader
help. **Rule reads as** previews the full expression with parentheses as you edit.
Adding a condition or nested group first opens an **AND / OR** overlay: choose
how the new item joins the current checks. Cancel, close or Escape makes no change.
If the chosen connector differs, existing checks stay grouped with their original
logic instead of being silently changed. Add checks inside a subgroup with its own
add buttons and AND/OR overlay, independently of its connection to the parent.
There is no separate group-matching dropdown.
Invalid or oversized rules show an error in the overlay without adding anything.
New checks receive keyboard focus, including the first check in a new group.
Changing a field preserves focus.
Indicator periods are 1–500. The rule editor uses time pickers; exported rule JSON
stores time constants as minutes since midnight (09:15 = 555).
Indicators use selected history only, warm up explicitly and never look ahead.
This is not arbitrary script execution or support for every imaginable strategy.

Simulation is long-only, whole shares, one entry per bot per IST day. A completed
close signals; its earliest fill is the next actual same-session open. Protective
stops and targets use gaps/extremes, stop first if both touch. Costs are 0.05% adverse
slippage and 0.05% fees per side, not actual brokerage/taxes. Corporate actions are
not repaired automatically; unknown/unadjusted data can distort returns.

Batch backtests use fresh configured capital, do not change the interactive
portfolio, and liquidate remaining positions at the final continuous close.
Results appear below the setup, with trades/exports and extra metrics collapsed.
**Replay these trades** starts an interactive simulation of the report's original
strategy, dataset, dates and risk settings, not the current form.
Previous runs remain available beneath the results. Existing browser datasets,
strategies, archived bots, reports and saved replays are preserved.

Historical replay shares cash and daily/open-risk limits between enabled bots,
processing equal timestamps by stable dataset ID then configured bot order.
Pause stops time; the entry lock prevents new entries without disabling protection.
Manual closes use the current observed historical close only. Resume rebuilds the
saved replay and its control/manual-close action log. Explicit seek resets to the
starting configuration (clearing replay-time actions), never carrying future fills
backward. Changes to risk/bot configuration apply to subsequent runs.

Equity/drawdown charts use close equity, not tick excursions; overview charts are
sampled for rendering. Reports retain full equity/trades, bounded signal/fill/block
logs (last 2,000 records), monthly returns, dataset hashes/provenance and assumptions.
Win rate is N/A for no trades. Buy-and-hold uses the same dates, initial capital and
cost model, independent per ticker. The separate comparison workspace, empty
overview, market watch and order-journal pages are no longer part of the demo's
navigation. Their useful information lives in results/replay instead; shared
portfolio replay is available through **Strategy options -> Saved strategies**.
Comparing separate exported runs is not portfolio analysis.
No optimization, live trading, shorting, derivatives, alternate source intervals or
promises of future performance are included.

## Prepare the bundled real snapshot locally

The agreed universe is RELIANCE, TCS, INFY, HDFCBANK, ICICIBANK, SBIN, ITC, LT,
BHARTIARTL and HINDUNILVR, August 1–October 31, 2026. Until exported, verified and
licensed, these bundles are explicitly unavailable in public builds. Local imports
and the private preview below do not require publishing the data.

The exporter is a **local preparation tool only**, never deployed with the demo.
After being notified that the exporter is ready, configure this checkout's own
local `.env` and complete the existing app's hosted **Broker connection** login.
Do not paste credentials/tokens in chat. The exporter restores the existing private
session file; it never fetches holdings or submits broker orders.

```sh
# After local hosted login, verify one completed historical session:
npm run demo:export -- --probe
# Then retrieve the agreed snapshot, with resumable private chunks:
npm run demo:export
```

Output is in ignored `data/demo-export/`, with owner-only permissions. Ctrl+C
cancels between bounded requests and retains completed chunks. SHA-256 checks
prevent reuse of corrupted chunks. Each symbol's CSV is validated for expected
sessions, gaps and zero volume; errors stop the export rather than inventing data.
The existing seven-day backtest API is not widened.

After a complete private export, make all ten stocks selectable in the local demo:

```sh
npm run demo:build
npm run demo:serve -- --private-data
```

This opt-in preview validates the exported CSVs and serves only their market data
and a limited manifest from `data/demo-export/`, bound to `127.0.0.1`. It labels
them **Private local snapshot**, rejects cross-origin requests for private data, and does not copy
them into `demo/bundles/` or `dist-demo/`. The private manifest is rejected on
non-loopback hosts. No credentials, account files or resumable chunks are served.
The normal static build and Cloudflare deployment remain separate: private preview
does not grant or record public redistribution permission.

The official [Historical API](https://smartapi.angelone.in/docs/Historical) currently
lists 30 days per ONE_MINUTE request; this exporter uses at most 29 calendar days.
The official [rate table](https://smartapi.angelone.in/docs/RateLimit) lists
getCandleData at 2/second, 80/minute and 5,000/hour; the existing history client
serializes calls at least 1.1 seconds apart and uses bounded retries.
The official FAQ states historical data is unadjusted for corporate actions.
Request-window limits are not retention guarantees: the authenticated historical
probe must succeed before claiming availability.

**Broker access does not grant public redistribution rights.** Confirm terms or
obtain permission before running:

```sh
npm run demo:publish-data -- "verified license or permission reference"
npm run demo:build
```

Publication validates all ten CSVs/hashes/coverage, then copies only market CSVs and
provenance into `demo/bundles/`. Review those files before committing. Without
redistribution permission, keep the exports private and obtain a licensed source.
Changing the bundled snapshot requires a new explicit export and redeployment;
visitors never sign into Angel One.

## Google Analytics 4

The public-demo integration sends only allowlisted page names and generic events:
CSV import completed, backtest completed, replay started and report exported.
It excludes filenames, raw/imported prices, tickers, strategy names/rules, settings,
results, account data, credentials, query strings, hashes and full referrers.
Advertising signals, personalization and user IDs are disabled.

The requested product behavior is mandatory GA4 without an in-app consent prompt.
This does not waive applicable consent/Google policy obligations. Before production
activation, review those obligations and **disable enhanced measurement in the GA4
property** (including forms, search, outbound links and file downloads). Never
falsely signal consent. Provide an existing GA4 measurement ID:

```sh
DEMO_GA_MEASUREMENT_ID=G-YOURID \
DEMO_GA_DEPLOYMENT_REVIEWED=yes npm run demo:build
```

Without both a valid ID and deployment confirmation, production collection is not
enabled. No analytics property is created automatically. Google processes analytics
requests and network information; this is not anonymous or fully offline operation.
Analytics is excluded on localhost and from local broker/export tools; blocked or
unavailable analytics never prevents research features from functioning.

## Checks

```sh
npm run test:demo
npm run check
npm run check:demo
npm test
```

Test fixtures are clearly synthetic and never bundled as real market data.
Public synthetic bundles are explicitly labeled and separate from test fixtures.
