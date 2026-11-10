import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import * as data from '../demo/data.js';
import * as engine from '../demo/engine.js';
import * as defaults from '../demo/defaults.js';

function fixture() {
  const elements = Object.fromEntries(Object.entries({
    datasetId: 'fixture', preset: 'sma', name: '', level: '', budget: '10000',
    stopPct: '1', targetPct: '2', exitPreset: 'protective', exitLevel: '90',
    exitSessions: '3', exitTime: '15:00', exitMinGainPct: '1',
    from: '2026-08-03', through: '2026-08-04', unverified: ''
  }).map(([name, value]) => [name, { value, checked: false }]));
  const nodes = {
    '#quick-form': { elements },
    '#quick-dataset': elements.datasetId,
    '#run-assumptions': {},
    '#calendar-warning': {}
  };
  const sample = { id: 'fixture', symbol: 'TEST-FIXTURE', from: '2026-08-03', through: '2026-08-04', bars: [[1785728700000, 100, 101, 99, 100, 1000]] };
  const context = createContext({
    ...data, ...engine, ...defaults, crypto, structuredClone, URL, File, AbortController, localBacktest: null,
    document: { querySelector: selector => nodes[selector] },
    sample
  });
  // Exercise the UI's actual functions without booting workers or IndexedDB.
  const source = readFileSync(new URL('../demo/app.js', import.meta.url), 'utf8');
  const functions = source.slice(0, source.indexOf("\ndocument.addEventListener('click'"))
    .replace(/^import .*;\n/gm, '')
    .replaceAll('import.meta.url', JSON.stringify(new URL('../demo/app.js', import.meta.url).href));
  runInContext(functions, context);
  const run = code => runInContext(code, context);
  run('metadata = [sample]; loaded.set(sample.id, sample)');
  return { elements, nodes, context, run };
}

function suggestionFixture() {
  const result = fixture(), { elements, nodes, context, run } = result;
  const form = nodes['#quick-form'];
  const note = { textContent: '', classList: { toggle() {} } }, reset = {};
  Object.assign(form, {
    getAttribute: () => 'quick-form', querySelectorAll: () => [],
    querySelector: selector => selector === '[data-defaults-note]' ? note : selector === '[data-action="suggest-inputs"]' ? reset : {}
  });
  for (const [name, element] of Object.entries(elements)) { element.name = name; element.form = form; element.dataset = {}; }
  nodes['#quick-entry-rule-editor'] = {}; nodes['#quick-exit-rule-editor'] = {};
  nodes['#run-backtest'] = {};
  context.form = form;
  run('refreshQuickForm = () => {}');
  return { ...result, form, note };
}

test('stock suggestions follow the selected stock/preset while retaining user edits per stock', async () => {
  const { elements, context, run } = suggestionFixture();
  elements.preset.value = 'breakout';
  await run('requestSuggestedInputs(form)');
  assert.equal(elements.level.value, '100.5');
  assert.equal(elements.targetPct.value, '2');
  elements.level.value = '105';
  await run('rememberSuggestedInput(form.elements.level)');
  elements.budget.value = '2500';
  run('rememberSuggestedInput(form.elements.budget)');
  elements.preset.value = 'dip';
  await run('requestSuggestedInputs(form)');
  assert.equal(elements.level.value, '99');
  elements.preset.value = 'breakout';
  context.other = { id: 'other', symbol: 'OTHER', from: '2026-08-03', through: '2026-08-04', bars: [[1785728700000, 1000, 1001, 999, 1000, 1000]] };
  run('metadata.push(other); loaded.set(other.id, other)');
  elements.datasetId.value = 'other';
  await run('requestSuggestedInputs(form)');
  assert.equal(elements.level.value, '1005');
  assert.equal(elements.budget.value, '2500');
  elements.datasetId.value = 'fixture';
  await run('requestSuggestedInputs(form)');
  assert.equal(elements.level.value, '105');
  elements.stopPct.value = '2';
  run('rememberSuggestedInput(form.elements.stopPct)');
  assert.equal(elements.targetPct.value, '4');
  elements.targetPct.value = '5';
  run('rememberSuggestedInput(form.elements.targetPct)');
  elements.stopPct.value = '1';
  run('rememberSuggestedInput(form.elements.stopPct)');
  assert.equal(elements.targetPct.value, '5');
});

test('saved strategy inputs remain explicit rather than being replaced by suggestions', async () => {
  const { elements, run } = suggestionFixture();
  elements.name.value = 'Saved example'; elements.preset.value = 'breakout'; elements.level.value = '123'; elements.stopPct.value = '2'; elements.targetPct.value = '5';
  const names = ['name', 'level', 'stopPct', 'targetPct', 'budget', 'preset', 'exitPreset', 'from', 'through'];
  const before = Object.fromEntries(names.map(name => [name, elements[name].value]));
  run('preserveSuggestedInputs(form)');
  await run('requestSuggestedInputs(form)');
  assert.deepEqual(Object.fromEntries(names.map(name => [name, elements[name].value])), before);
  elements.exitPreset.value = 'support';
  await run('requestSuggestedInputs(form)');
  assert.equal(elements.exitLevel.value, '121.16');
});

test('typed blanks remain user-controlled and editing never rewrites the active input', async () => {
  const { elements, run } = suggestionFixture();
  elements.preset.value = 'breakout';
  await run('requestSuggestedInputs(form)');
  Object.defineProperty(elements.level, 'value', { configurable: true, get: () => '105.5', set: () => { throw new Error('Rewriting the edited input loses its caret/partial decimal'); } });
  run('rememberSuggestedInput(form.elements.level)');
  assert.equal(run('suggestionState(form).error'), '');
  Object.defineProperty(elements.level, 'value', { configurable: true, value: '', writable: true });
  run('rememberSuggestedInput(form.elements.level)');
  elements.from.value = '2026-08-02';
  await run('requestSuggestedInputs(form)');
  assert.equal(elements.level.value, '');
});

test('custom defaults invert numeric-left comparisons and remove incompatible operand properties', async () => {
  const { context, run } = suggestionFixture();
  await run('requestSuggestedInputs(form)');
  context.control = { dataset: { ruleField: 'quick-entry.0:left:field' }, value: 'number', form: context.form };
  run('updateRuleControl(control)');
  assert.equal(run('quickEntryRule.rules[0].left.value'), 99);
  context.control.value = 'rsi';
  run('updateRuleControl(control)');
  assert.equal(run('quickEntryRule.rules[0].left.value'), undefined);
  assert.equal(run('quickEntryRule.rules[0].left.period'), 14);
  context.control.value = 'close';
  run('updateRuleControl(control)');
  assert.equal(run('quickEntryRule.rules[0].left.period'), undefined);
  run('validateRule(quickEntryRule)');
});

test('late dataset loads cannot overwrite a newer stock selection', async () => {
  const { elements, context, run, note } = suggestionFixture();
  let resolveFirst, resolveSecond;
  context.firstLoad = new Promise(resolve => { resolveFirst = resolve; });
  context.secondLoad = new Promise(resolve => { resolveSecond = resolve; });
  context.other = { id: 'other', symbol: 'OTHER', from: '2026-08-03', through: '2026-08-04', bars: [[1785728700000, 1000, 1001, 999, 1000, 1000]] };
  run('loaded.clear(); metadata.push(other); dataset = id => id === "fixture" ? firstLoad : secondLoad');
  elements.preset.value = 'breakout';
  const first = run('requestSuggestedInputs(form)');
  elements.datasetId.value = 'other';
  const second = run('requestSuggestedInputs(form)');
  resolveSecond(context.other); await second;
  assert.equal(elements.level.value, '1005');
  resolveFirst(context.sample); await first;
  assert.equal(elements.level.value, '1005');
  assert.match(note.textContent, /OTHER starter inputs/);
});

test('suggestion loading failures are visible and prevent successful submission', async () => {
  const { run, nodes, note } = suggestionFixture();
  run('loaded.clear(); dataset = async () => { throw new Error("Dataset read failed"); }');
  await run('requestSuggestedInputs(form)');
  assert.match(note.textContent, /Dataset read failed/);
  assert.equal(nodes['#run-backtest'].disabled, true);
  await assert.rejects(run('quickConfig()'), /Dataset read failed/);
});

test('saving timed strategies retains default numeric inputs even when their controls are hidden', async () => {
  const source = readFileSync(new URL('../demo/app.js', import.meta.url), 'utf8');
  const listener = source.slice(source.indexOf("\ndocument.addEventListener('submit'"), source.indexOf('\ntry {\n  const [saved, data, runs]'));
  for (const exit of ['scheduled', 'max-hold', 'time-performance']) {
    const { elements, nodes, context, run, form } = suggestionFixture();
    form.getAttribute = () => 'bot-form';
    elements.id = { value: '' };
    elements.exitPreset.value = exit;
    nodes['#bot-form'] = form; nodes['#entry-rule-editor'] = {}; nodes['#exit-rule-editor'] = {};
    nodes['#bot-error'] = { textContent: '' }; nodes['#bot-dialog'] = { close() {} };
    context.FormData = class {
      constructor(form) { return new Map(Object.entries(form.elements).filter(([, field]) => !field.disabled).map(([name, field]) => [name, field.value])); }
    };
    context.document.addEventListener = (_, callback) => { context.submit = callback; };
    await run('requestSuggestedInputs(form)');
    elements.exitMinGainPct.disabled = exit !== 'time-performance';
    run('saveWorkspace = async () => true; render = () => {}; toast = message => { throw new Error(message); }');
    run(listener);
    run('submit({ preventDefault() {}, target: form })');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(nodes['#bot-error'].textContent, '');
    assert.equal(run('workspace.strategies.length'), 1);
    assert.equal(run('workspace.strategies[0].exitMinGainPct'), 1);
    assert.equal(run('workspace.strategies[0].exitSessions'), exit === 'scheduled' ? 1 : 3);
  }
});

test('automatic custom constants survive nested additions; manually edited values stay unchanged', async () => {
  const { context, run } = suggestionFixture();
  await run('requestSuggestedInputs(form)');
  context.control = { dataset: { ruleField: 'quick-entry.0:right:field' }, value: 'number', form: context.form };
  run('updateRuleControl(control)');
  assert.equal(run('quickEntryRule.rules[0].right.value'), 100.5);
  run("appendRule('quick-entry', 'condition', 'and')");
  run("updateAutomaticRuleValues(quickEntryRule, false, { levels: { breakout: 1005, dip: 990 } })");
  assert.equal(run('quickEntryRule.rules[0].right.value'), 1005);
  context.control = { dataset: { ruleField: 'quick-entry.0:right:value' }, value: '123', form: context.form };
  run('updateRuleControl(control)');
  run("updateAutomaticRuleValues(quickEntryRule, false, { levels: { breakout: 2005, dip: 1990 } })");
  assert.equal(run('quickEntryRule.rules[0].right.value'), 123);
  context.control = { dataset: { ruleField: 'quick-exit.0:left:field' }, value: 'rsi', form: context.form };
  run('updateRuleControl(control)');
  assert.equal(run('quickExitRule.rules[0].left.period'), 14);
  context.control = { dataset: { ruleField: 'quick-exit.0:right:field' }, value: 'number', form: context.form };
  run('updateRuleControl(control)');
  assert.equal(run('quickExitRule.rules[0].right.value'), 70);
});

test('a preset backtest needs only a dataset, not a saved bot or replay', async () => {
  const { run } = fixture();
  const config = await run('quickConfig()');
  assert.equal(config.strategies.length, 1);
  assert.equal(config.strategies[0].preset, 'sma');
  assert.equal(config.strategies[0].enabled, true);
  assert.equal(config.strategies[0].datasetId, 'fixture');
  assert.equal(config.strategies[0].name, 'TEST-FIXTURE Moving-average cross');
  assert.equal(config.strategies[0].budget, 10000);
  assert.equal(config.from, '2026-08-03');
  assert.equal(config.through, '2026-08-04');
  assert.equal(run('workspace.strategies.length'), 0);
  assert.equal(run('workspace.replay'), null);
});

test('quick runs snapshot custom rules and preserve existing strategy validation', async () => {
  const { elements, run } = fixture();
  elements.preset.value = 'rules';
  elements.name.value = 'My custom entry';
  const config = await run('quickConfig()');
  run('quickEntryRule.rules[0].right.period = 30');
  assert.equal(config.strategies[0].entryRule.rules[0].right.period, 20);
  assert.equal(config.strategies[0].name, 'My custom entry');
  elements.targetPct.value = '.5';
  await assert.rejects(run('quickConfig()'), /Target must be at least/);
  elements.targetPct.value = '2';
  elements.preset.value = 'breakout';
  await assert.rejects(run('quickConfig()'), /Entry level/);
  elements.level.value = '105';
  assert.equal((await run('quickConfig()')).strategies[0].level, 105);
  elements.from.value = '2026-08-05';
  await assert.rejects(run('quickConfig()'), /valid date range/);
});

test('a bundled stock is loaded and selected on demand without creating a bot', async () => {
  const { elements, context, run } = fixture();
  const bars = Array.from({ length: 360 }, (_, minute) => [data.atMinute('2026-08-03', 555 + minute), 100, 101, 99, 100, 1000]);
  const sha256 = await data.checksum(bars);
  const requests = [], saved = [];
  context.fetch = async url => { requests.push(String(url)); return new Response(data.candlesCsv(bars)); };
  context.saveDataset = async value => saved.push(value);
  context.parsed = { bars, sha256 };
  context.bundle = { symbol: 'RELIANCE', from: '2026-08-03', through: '2026-08-03', status: 'available', sha256 };
  run('metadata = []; loaded.clear(); bundles = [bundle]; oneOff = async () => parsed');
  elements.datasetId.value = 'bundle:RELIANCE';
  elements.through.value = '2026-08-03';
  const [config, concurrent] = await run('Promise.all([quickConfig(), quickConfig()])');
  assert.equal(config.datasets[0].bars.length, 360);
  assert.deepEqual(config.datasets[0], concurrent.datasets[0]);
  assert.equal(config.strategies[0].datasetId, `RELIANCE-${sha256}`);
  assert.equal(config.strategies[0].symbol, 'RELIANCE');
  assert.equal(saved.length, 1);
  assert.equal(run('workspace.strategies.length'), 0);
  assert.equal(requests.length, 1);
  assert.match(requests[0], /demo\/bundles\/RELIANCE\.csv$/);
  await run('Promise.all([loadBundle("RELIANCE"), loadBundle("RELIANCE")])');
  assert.equal(requests.length, 1);
});

test('quick setup surfaces calendar exceptions, including within a supported year', () => {
  const { elements, nodes, run } = fixture();
  run('updateQuickSummary()');
  assert.equal(nodes['#calendar-warning'].hidden, true);
  elements.from.value = '2026-01-30';
  elements.through.value = '2026-02-02';
  run('updateQuickSummary()');
  assert.equal(nodes['#calendar-warning'].hidden, false);
  assert.equal(elements.unverified.required, true);
  elements.from.value = '2025-08-01';
  elements.through.value = '2025-08-05';
  run('updateQuickSummary()');
  assert.equal(nodes['#calendar-warning'].hidden, false);
  elements.from.value = '2026-08-03';
  elements.through.value = '2026-08-04';
  run('updateQuickSummary()');
  assert.equal(nodes['#calendar-warning'].hidden, true);
  assert.equal(elements.unverified.required, false);
});

test('private snapshots require an explicit local manifest and a loopback host', () => {
  const { context, run } = fixture();
  context.manifest = {
    version: 1, localOnly: true,
    datasets: [{ symbol: 'RELIANCE', file: 'RELIANCE.csv', sha256: 'a'.repeat(64), redistribution: 'NOT_APPROVED' }]
  };
  for (const hostname of ['127.0.0.1', 'localhost']) {
    context.location = { hostname };
    const result = run('availableBundles(manifest)');
    assert.equal(result[0].status, 'available');
    assert.equal(result[0].localOnly, true);
    assert.equal(result[0].redistribution, 'NOT_APPROVED');
  }
  for (const hostname of ['demo.pages.dev', 'example.com', '192.168.1.10']) {
    context.location = { hostname };
    assert.throws(() => run('availableBundles(manifest)'), /loopback preview/);
  }
  context.location = { hostname: '127.0.0.1' };
  delete context.manifest.localOnly;
  assert.throws(() => run('availableBundles(manifest)'), /unlicensed/);
  context.manifest.datasets[0].redistribution = 'Test permission reference';
  context.location = { hostname: 'demo.pages.dev' };
  assert.equal(run('availableBundles(manifest)[0].localOnly'), false);
  assert.equal(run('availableBundles(manifest)[0].status'), 'available');
});

test('the main demo is a local-app preview with a direct run and secondary tools', () => {
  const { run } = fixture();
  const html = run('backtestPage()');
  assert.match(html, /hands-on preview of TradeGrok/);
  assert.match(html, /id="quick-form"/);
  assert.match(html, /id="advanced-options"><summary>Strategy options/);
  assert.match(html, /id="results"[^>]+hidden/);
  assert.match(html, /id="saved-runs" hidden/);
  assert.match(html, /TradeGrok#quick-start/);
  assert.doesNotMatch(html, /data-action="create"|data-page=|SIMULATED PORTFOLIO|Order journal/);
});

test('time rules render ordinary time inputs while retaining numeric rule storage', () => {
  const { run } = fixture();
  const html = run("ruleView({ left: { field: 'time' }, op: 'above', right: { field: 'number', value: 600 } }, 'quick-entry.0')");
  assert.match(html, /type="time" required value="10:00"/);
  assert.doesNotMatch(html, /Left operand|Right operand|minutes since midnight/);
});

test('condition and group buttons explain their difference on hover and to screen readers', () => {
  const { run } = fixture();
  for (const path of ['entry', 'exit', 'quick-entry', 'quick-exit']) {
    const html = run(`ruleView({ op: 'and', rules: [defaultRule()] }, '${path}')`);
    const actions = [...html.matchAll(/<button[^>]+data-action="(rule-add|rule-group-add)"[^>]+>/g)];
    assert.equal(actions.length, 4);
    for (const [markup, action] of actions) {
      const title = markup.match(/title="([^"]+)"/)?.[1];
      assert.ok(title);
      assert.equal(markup.match(/aria-description="([^"]+)"/)?.[1], title);
      if (action === 'rule-add') {
        assert.match(title, /Add one check.*Close above SMA\(20\)/);
        assert.match(title, /Choose AND or OR in the overlay/);
      } else {
        assert.match(title, /nested set of checks with its own AND\/OR/);
        assert.match(title, /\(RSI below 30 OR Volume above 1000\)/);
      }
    }
  }
});

function nestedRule() {
  return {
    op: 'and',
    rules: [
      { left: { field: 'close' }, op: 'above', right: { field: 'number', value: 100 } },
      {
        op: 'or',
        rules: [
          { left: { field: 'rsi', period: 14 }, op: 'below', right: { field: 'number', value: 30 } },
          { left: { field: 'volume' }, op: 'above', right: { field: 'number', value: 1000 } }
        ]
      }
    ]
  };
}

test('nested groups have explicit boundaries, local add controls and AND/OR connectors', () => {
  const { context, run } = fixture();
  context.example = nestedRule();
  const html = run("ruleEditor(example, 'quick-entry', 'Entry rules')");
  assert.equal((html.match(/<fieldset class="rule-group"/g) ?? []).length, 2);
  assert.match(html, /<legend>Entry conditions<\/legend>/);
  assert.match(html, /data-rule-path="quick-entry\.1"><legend>Nested group<\/legend>/);
  assert.match(html, /class="rule-connector">AND<\/div>/);
  assert.match(html, /class="rule-connector">OR<\/div>/);
  assert.equal((html.match(/Add to this group:/g) ?? []).length, 2);
  assert.match(html, /data-action="rule-group-add" data-id="quick-entry\.1"[^>]*>Add nested group/);
  assert.match(html, /aria-live="polite" aria-atomic="true">Close &gt; 100 AND \(RSI\(14\) &lt; 30 OR Volume &gt; 1000\)/);
});

test('all rule editors omit group-matching dropdowns but retain nested remove controls', () => {
  const { context, run } = fixture();
  context.example = nestedRule();
  for (const root of ['entry', 'exit', 'quick-entry', 'quick-exit']) {
    const html = run(`ruleEditor(example, '${root}', 'Rules')`);
    assert.doesNotMatch(html, /data-rule-group|All of these|Any of these|<label>Match/);
    assert.equal((html.match(/class="rule-controls"/g) ?? []).length, 1);
    assert.match(html, /Remove group/);
    assert.match(html, /class="rule-connector">AND/);
    assert.match(html, /class="rule-connector">OR/);
  }
});

test('rule previews preserve parentheses and update values and comparison operators', () => {
  const { context, run } = fixture();
  context.example = nestedRule();
  run('quickEntryRule = example');
  context.preview = { dataset: { rulePreview: 'quick-entry' }, textContent: '' };
  const form = { querySelectorAll: () => [context.preview] };
  context.control = { dataset: { ruleOp: 'quick-entry.1.1' }, value: 'below', form };
  run('updateRuleControl(control)');
  assert.equal(context.preview.textContent, 'Close > 100 AND (RSI(14) < 30 OR Volume < 1000)');
  context.control = { dataset: { ruleField: 'quick-entry.1.1:right:value' }, value: '2000', form };
  run('updateRuleControl(control)');
  assert.equal(context.preview.textContent, 'Close > 100 AND (RSI(14) < 30 OR Volume < 2000)');
  context.control.value = '';
  run('updateRuleControl(control)');
  assert.match(context.preview.textContent, /Volume < …\)/);
  assert.ok(Number.isNaN(run('quickEntryRule.rules[1].rules[1].right.value')));
});

test('rule previews use readable times and preserve deeper grouping', () => {
  const { run } = fixture();
  assert.equal(run("ruleText({ left: { field: 'time' }, op: 'above', right: { field: 'number', value: 600 } })"), 'Time (IST) > 10:00 IST');
  assert.equal(run("ruleText({ op: 'or', rules: [{ op: 'and', rules: [defaultRule()] }, defaultRule()] })"), '((Close crosses above SMA(20))) OR (Close crosses above SMA(20))');
});

test('adding either item opens the AND/OR overlay without changing the rule; cancel restores focus', async () => {
  const { nodes, context, run } = fixture();
  const dialog = { open: false, showModal() { this.open = true; } };
  nodes['#rule-join-dialog'] = dialog;
  for (const id of ['title', 'description', 'current', 'error']) nodes[`#rule-join-${id}`] = { textContent: '' };
  let choiceFocused = false, triggerFocused = false;
  nodes['#rule-join-dialog [data-id="and"]'] = { focus() { choiceFocused = true; } };
  for (const action of ['rule-add', 'rule-group-add']) {
    context.trigger = { dataset: { action, id: 'quick-entry' }, isConnected: true, focus() { triggerFocused = true; } };
    const before = run('JSON.stringify(quickEntryRule)');
    await run('handleClick(trigger)');
    assert.equal(dialog.open, true);
    assert.equal(choiceFocused, true);
    assert.match(nodes['#rule-join-title'].textContent, /AND or OR/);
    assert.equal(nodes['#rule-join-current'].textContent, 'Close crosses above SMA(20)');
    assert.equal(run('JSON.stringify(quickEntryRule)'), before);
    run('closeRuleJoin()');
    assert.ok(run('pendingRuleAddition'), 'a late close event must not clear a reopened chooser');
    dialog.open = false;
    run('closeRuleJoin()');
    assert.equal(run('pendingRuleAddition'), null);
    assert.equal(triggerFocused, true);
    assert.equal(run('JSON.stringify(quickEntryRule)'), before);
    choiceFocused = false; triggerFocused = false;
  }
});

test('matching connectors append directly; a different connector preserves earlier logic', () => {
  const { run } = fixture();
  assert.equal(run("appendRule('quick-entry', 'condition', 'and')"), 'quick-entry.1');
  assert.equal(run('quickEntryRule.rules.length'), 2);
  const before = run('JSON.stringify(quickEntryRule)');
  assert.equal(run("appendRule('quick-entry', 'condition', 'or')"), 'quick-entry.1');
  assert.equal(run('quickEntryRule.op'), 'or');
  assert.equal(run('quickEntryRule.rules.length'), 2);
  assert.equal(run('JSON.stringify(quickEntryRule.rules[0])'), before);
  assert.equal(run('ruleText(quickEntryRule)'), '(Close crosses above SMA(20) AND Close crosses above SMA(20)) OR Close crosses above SMA(20)');
});

test('confirming either addition focuses its first condition in every rule editor', async () => {
  for (const root of ['entry', 'exit', 'quick-entry', 'quick-exit']) {
    for (const kind of ['condition', 'group']) {
      const { elements, nodes, run } = fixture();
      const quick = root.startsWith('quick-'), prefix = quick ? 'quick-' : '';
      let focused;
      elements.preset.value = 'rules'; elements.exitPreset.value = 'rules';
      nodes[`#${prefix}entry-rule-editor`] = { innerHTML: '' };
      nodes[`#${prefix}exit-rule-editor`] = { innerHTML: '' };
      nodes[quick ? '#quick-form' : '#bot-form'] = {
        elements, getAttribute: () => quick ? 'quick-form' : 'bot-form',
        querySelectorAll: () => [],
        querySelector: selector => ({ focus() { focused = selector; } })
      };
      nodes['#rule-join-dialog'] = { close() {} };
      run(`pendingRuleAddition = { path: '${root}', kind: '${kind}' }`);
      await run("handleClick({ dataset: { action: 'rule-join', id: 'or' } })");
      const field = `${root}.1${kind === 'group' ? '.0' : ''}:left:field`;
      assert.equal(focused, `[data-rule-field="${field}"]`);
      assert.ok(nodes[`#${root}-rule-editor`].innerHTML.includes(`data-rule-field="${field}"`));
      assert.equal(run('pendingRuleAddition'), null);
    }
  }
});

test('a chosen connector applies only within the target group, including saved entry and exit editors', () => {
  const { context, run } = fixture();
  for (const root of ['entry', 'exit', 'quick-entry', 'quick-exit']) {
    context.example = nestedRule();
    run(`Object.assign(ruleNode('${root}'), example)`);
    const sibling = run(`JSON.stringify(ruleNode('${root}.0'))`);
    const nested = run(`JSON.stringify(ruleNode('${root}.1'))`);
    assert.equal(run(`appendRule('${root}.1', 'condition', 'and')`), `${root}.1.1`);
    assert.equal(run(`JSON.stringify(ruleNode('${root}.0'))`), sibling);
    assert.equal(run(`JSON.stringify(ruleNode('${root}.1.0'))`), nested);
    assert.equal(run(`ruleNode('${root}.1').op`), 'and');
  }
});

test('new groups keep their own matching setting separate from their parent connector', () => {
  const { run } = fixture();
  assert.equal(run("appendRule('quick-exit', 'group', 'or')"), 'quick-exit.1');
  assert.equal(run('quickExitRule.op'), 'or');
  assert.equal(run('quickExitRule.rules[1].op'), 'and');
  assert.equal(run('quickExitRule.rules[1].rules.length'), 1);
  const before = run('JSON.stringify(quickExitRule)');
  assert.throws(() => run("appendRule('quick-exit', 'group', 'invalid')"), /Choose AND or OR/);
  assert.equal(run('JSON.stringify(quickExitRule)'), before);
});

test('joins reject excessive depth and node counts without partially changing existing rules', () => {
  const { run } = fixture();
  run("for (let i = 0; i < 4; i++) quickEntryRule = { op: 'and', rules: [quickEntryRule] }; quickEntryRule.rules.push(defaultRule().rules[0])");
  run('validateRule(quickEntryRule)');
  const deep = run('JSON.stringify(quickEntryRule)');
  assert.throws(() => run("appendRule('quick-entry', 'condition', 'or')"), /at most 5 nested groups/);
  assert.equal(run('JSON.stringify(quickEntryRule)'), deep);
  assert.throws(() => run("appendRule('quick-entry.0.0.0.0', 'group', 'and')"), /at most 5 nested groups/);
  assert.equal(run('JSON.stringify(quickEntryRule)'), deep);
  run("quickExitRule.rules = Array.from({ length: 62 }, () => defaultRule().rules[0])");
  run("appendRule('quick-exit', 'condition', 'and')");
  assert.equal(run('quickExitRule.rules.length'), 63);
  const full = run('JSON.stringify(quickExitRule)');
  for (const join of ['and', 'or']) {
    assert.throws(() => run(`appendRule('quick-exit', 'condition', '${join}')`), /64 nodes/);
    assert.equal(run('JSON.stringify(quickExitRule)'), full);
  }
});

test('invalid additions keep the chooser open and display the validation error', async () => {
  const { nodes, run } = fixture();
  let errorFocused = false;
  nodes['#rule-join-error'] = { textContent: '', focus() { errorFocused = true; } };
  nodes['#rule-join-dialog'] = { open: true };
  run("quickEntryRule.rules = Array.from({ length: 63 }, () => defaultRule().rules[0]); pendingRuleAddition = { path: 'quick-entry', kind: 'condition' }");
  const before = run('JSON.stringify(quickEntryRule)');
  await run("handleClick({ dataset: { action: 'rule-join', id: 'and' } })");
  assert.match(nodes['#rule-join-error'].textContent, /64 nodes/);
  assert.equal(nodes['#rule-join-dialog'].open, true);
  assert.equal(errorFocused, true);
  assert.ok(run('pendingRuleAddition'));
  assert.equal(run('JSON.stringify(quickEntryRule)'), before);
});

test('report details and exports are secondary to the inline result and replay action', () => {
  const { context, run } = fixture();
  context.report = {
    strategies: [{ name: 'Test strategy' }], datasets: [], summary: { returnPct: 0, netPnl: 0, maxDrawdownPct: 0, trades: 0 },
    equity: [], orders: [], months: [], benchmarks: [], assumptions: [], risk: engine.defaultRisk
  };
  const html = run('reportView(report)');
  assert.match(html, /id="results-title" tabindex="-1"/);
  assert.match(html, /data-action="replay-result"/);
  assert.match(html, /<details><summary>Trades & exports/);
  assert.match(html, /<details><summary>More metrics & assumptions/);
  assert.doesNotMatch(html, /<dialog|<details open/);
});
