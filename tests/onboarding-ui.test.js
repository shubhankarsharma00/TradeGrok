import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

function fixture({ search = '', hash = '#broker', configured = false, relay = false } = {}) {
  const listeners = {};
  const nodes = {
    '#main': { innerHTML: '' }, '#page-label': {}, '#clock': {},
    '#toast': { classList: { toggle() {} } },
    '#bot-form': { addEventListener() {} },
    '#setup-title': { focus() { this.focused = true; } }
  };
  const context = createContext({
    document: {
      querySelector: selector => nodes[selector],
      querySelectorAll: () => [],
      addEventListener: (name, listener) => { listeners[name] = listener; }
    },
    location: { search, hash, origin: 'http://127.0.0.1:3101' },
    history: { replaceState() {} }, window: { scrollTo() {} },
    URL, URLSearchParams, setInterval() {}, setTimeout() {}, clearTimeout() {},
    fetch: () => new Promise(() => {})
  });
  runInContext(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  context.snapshot = {
    smartapi: {
      configured, callbackUrl: relay ? 'https://my-relay.workers.dev/auth/smartapi/callback' : 'http://127.0.0.1:3101/auth/smartapi/callback',
      status: configured ? 'ready' : 'not_configured', message: 'Not connected'
    },
    connection: { status: 'disconnected', message: 'Not verified' }, account: null,
    smartapiConfigWritable: true
  };
  const run = code => runInContext(code, context);
  run('state = snapshot');
  const click = dataset => listeners.click({ target: { closest: () => ({ dataset }) } });
  const submit = form => listeners.submit({ target: form, preventDefault() {} });
  return { context, nodes, run, click, submit };
}

test('broker deep link starts an account-first guide with official KYC links and no credential inputs', () => {
  const f = fixture();
  assert.equal(f.run('page'), 'broker');
  const html = f.run('brokerOnboarding()');
  assert.match(html, /STEP 1 OF 4/);
  assert.match(html, /data-setup-step="0" aria-current="step"/);
  assert.match(html, /PAN, Aadhaar/);
  assert.match(html, /how-to-open-demat-account/);
  assert.match(html, /how-to-complete-kyc-easily/);
  assert.doesNotMatch(html, /<input|<textarea|<form/);
});

test('step navigation moves focus and preserves the chosen step across refreshes and pages', async () => {
  const f = fixture();
  await f.click({ setupStep: '1' });
  assert.equal(f.run('onboardingStep'), 1);
  assert.equal(f.nodes['#setup-title'].focused, true);
  assert.match(f.nodes['#main'].innerHTML, /STEP 2 OF 4/);
  assert.match(f.nodes['#main'].innerHTML, /LOCAL_RETURN_ORIGIN/);
  assert.match(f.nodes['#main'].innerHTML, /http:\/\/127.0.0.1:3101/);
  assert.match(f.nodes['#main'].innerHTML, /deploy --dry-run/);
  assert.match(f.nodes['#main'].innerHTML, /Never tunnel this local dashboard/);
  f.run('renderPage()');
  f.run('page = "orders"; state.settings = { emergency: false }; state.engine = {}; state.metrics = {}; state.orders = []; renderPage()');
  await f.click({ page: 'broker' });
  assert.equal(f.run('onboardingStep'), 1);
  await f.click({ setupStep: '2' });
  await f.click({ setupStep: '1' });
  assert.equal(f.run('onboardingStep'), 1);
  for (const value of ['-1', '4', 'NaN', '1.5']) await f.click({ setupStep: value });
  assert.equal(f.run('onboardingStep'), 1);
});

test('configuration uses the actual relay origin, correct callback path and current local port without revealing keys', () => {
  const f = fixture({ configured: true, relay: true });
  f.context.snapshot.smartapi.apiKey = 'private-key-must-not-render';
  f.run('onboardingStep = 2');
  const html = f.run('brokerOnboarding()');
  assert.match(html, /https:\/\/my-relay\.workers\.dev\/auth\/smartapi\/callback/);
  assert.match(html, /SMARTAPI_RELAY_ORIGIN=https:\/\/my-relay\.workers\.dev<\/code>/);
  assert.match(html, /PORT=3101/);
  assert.match(html, /SMARTAPI_API_KEY=REPLACE_WITH_YOUR_OWN_API_KEY/);
  assert.match(html, /API KEY: LOADED/);
  assert.match(html, /HTTPS RELAY: CONFIGURED/);
  assert.match(html, /Cloudflare HTTPS does not provide a static outbound IP/);
  assert.match(html, /no order-postback endpoint/);
  assert.doesNotMatch(html, /private-key-must-not-render|YOUR_SUBDOMAIN/);
});

test('unconfigured setup shows placeholders and missing state rather than claiming readiness', () => {
  const f = fixture();
  f.run('onboardingStep = 2');
  const html = f.run('brokerOnboarding()');
  assert.match(html, /replace YOUR_SUBDOMAIN/);
  assert.match(html, /API KEY: MISSING/);
  assert.match(html, /HTTPS RELAY: MISSING/);
  assert.match(html, /not deployment health/);
  const page = f.run('brokerPage()');
  assert.match(page, /data-action="smartapi-login" disabled/);
});

test('hosted login returns open verification without equating callback receipt with verified access', () => {
  const f = fixture({ search: '?smartapi=success', hash: '' });
  assert.equal(f.run('page'), 'broker');
  assert.equal(f.run('onboardingStep'), 3);
  assert.match(f.run('brokerOnboarding()'), /ACCOUNT NOT VERIFIED/);
  assert.match(f.run('brokerOnboarding()'), /not that the account was verified/);
  f.context.snapshot.connection.status = 'connected';
  assert.match(f.run('brokerOnboarding()'), /READ-ONLY ACCOUNT VERIFIED/);
  assert.match(f.run('brokerPage()'), /data-action="connect"/);
});

test('guide starts collapsed and preserves disclosure state across refresh and navigation', async () => {
  const f = fixture();
  assert.match(f.run('brokerOnboarding()'), /<details id="broker-onboarding" class="panel onboarding-panel">/);
  assert.match(f.run('brokerOnboarding()'), /<summary class="setup-summary">/);
  f.nodes['#broker-onboarding'] = { open: false };
  f.run('renderPage()');
  assert.doesNotMatch(f.nodes['#main'].innerHTML, /class="panel onboarding-panel" open/);
  f.run('page = "orders"; state.settings = { emergency: false }; state.engine = {}; state.metrics = {}; state.orders = []; renderPage()');
  delete f.nodes['#broker-onboarding'];
  await f.click({ page: 'broker' });
  assert.equal(f.run('onboardingOpen'), false);
  f.nodes['#broker-onboarding'] = { open: true };
  f.run('renderPage()');
  assert.equal(f.run('onboardingOpen'), true);
});

test('inline login test requires both API key and HTTPS relay and links the current local dashboard', () => {
  for (const [configured, relay] of [[false, false], [true, false], [false, true], [true, true]]) {
    const f = fixture({ configured, relay });
    f.run('onboardingStep = 3');
    const html = f.run('brokerOnboarding()');
    assert.match(html, /href="http:\/\/127\.0\.0\.1:3101\/#broker"/);
    const disabled = /data-action="smartapi-login" disabled/.test(html);
    assert.equal(disabled, !(configured && relay));
    assert.match(html, /Click here to test Angel One login/);
  }
});

test('inline login uses the existing protected POST to create browser binding before redirecting', async () => {
  const f = fixture({ configured: true, relay: true });
  f.context.snapshot.csrf = 'test-csrf';
  let request, destination;
  f.context.fetch = async (path, options) => {
    request = { path, options };
    return { ok: true, json: async () => ({ loginUrl: 'https://smartapi.angelone.in/publisher-login?state=test' }) };
  };
  f.context.location.assign = url => { destination = url; };
  await f.click({ action: 'smartapi-login' });
  assert.equal(request.path, '/api/smartapi/login');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['X-Tradegrok-CSRF'], 'test-csrf');
  assert.equal(destination, 'https://smartapi.angelone.in/publisher-login?state=test');
});

test('broker page keeps controls visible and routine information collapsed, with errors expanded', () => {
  const f = fixture();
  const html = f.run('brokerPage()');
  for (const id of ['broker-login-info', 'broker-session-info', 'broker-verification-info', 'broker-safety-info']) {
    assert.match(html, new RegExp(`data-notice-id="${id}"><summary>`));
  }
  assert.match(html, /data-action="smartapi-login"/);
  assert.match(html, /data-action="smartapi-disconnect"/);
  assert.match(html, /data-action="connect"/);
  assert.doesNotMatch(html, /Keep your connection local|Your account\. Your keys\./);
  f.context.snapshot.connection = { status: 'error', message: '<bad> Broker rejected access' };
  const errorHtml = f.run('brokerPage()');
  assert.match(errorHtml, /data-notice-id="broker-verification-info" open><summary>Verification failed/);
  assert.match(errorHtml, /role="alert">&lt;bad&gt; Broker rejected access/);
});

test('trimmed guide retains setup actions without repeated strategy and background explanations', () => {
  const f = fixture();
  for (const step of [0, 3]) {
    f.run(`onboardingStep = ${step}`);
    const html = f.run('brokerOnboarding()');
    assert.equal((html.match(/<li>/g) ?? []).length, 2);
    assert.doesNotMatch(html, /Review your paper strategy|Navigation is a guide|Approval timing|rejected callbacks/);
  }
  f.run('onboardingStep = 1');
  const cloudflare = f.run('brokerOnboarding()');
  assert.match(cloudflare, /observability\.enabled: false/);
  assert.match(cloudflare, /logpush: false/);
  assert.match(cloudflare, /preview_urls: false/);
  assert.match(cloudflare, /\/healthz/);
  assert.doesNotMatch(cloudflare, /provider-internal retention|Free-plan limits|workers\.dev HTTPS/);
  f.run('onboardingStep = 2');
  assert.match(f.run('brokerOnboarding()'), /Restart with <code>npm start<\/code>/);
});

function configForm(f) {
  const button = { disabled: false };
  const form = {
    id: 'broker-config-form', dataset: {},
    elements: {
      apiKey: { value: 'synthetic-ui-key' },
      relayOrigin: { value: 'https://new-relay.workers.dev', defaultValue: '' }
    },
    querySelector: () => button
  };
  f.nodes['#broker-config-form'] = form;
  f.nodes['#broker-config-error'] = { textContent: '' };
  f.nodes['#broker-config-status'] = { textContent: '' };
  return { form, button };
}

test('setup exposes a masked key field, local-save privacy notice and optional manual .env instructions', () => {
  const f = fixture({ relay: true });
  f.run('onboardingStep = 2');
  const html = f.run('brokerOnboarding()');
  assert.match(html, /<form id="broker-config-form" aria-describedby="broker-config-privacy">/);
  assert.match(html, /name="apiKey" type="password" required/);
  assert.doesNotMatch(html, /name="apiKey"[^>]*value=/);
  assert.match(html, /name="relayOrigin" type="url"/);
  assert.match(html, /not uploaded to a cloud service by this form/);
  assert.match(html, /Your API key is sent to Angel One/);
  assert.match(html, /Edit .env directly instead/);
  assert.match(html, /Save to local .env/);
});

test('local save uses the protected endpoint, clears the key and leaves active configuration unchanged', async () => {
  const f = fixture();
  const { form, button } = configForm(f);
  f.context.snapshot.csrf = 'test-csrf';
  let request;
  f.context.fetch = async (path, options) => {
    request = { path, options };
    return { ok: true, json: async () => ({ saved: true, restartRequired: true }) };
  };
  await f.submit(form);
  assert.equal(request.path, '/api/smartapi/config');
  assert.equal(request.options.headers['X-Tradegrok-CSRF'], 'test-csrf');
  assert.deepEqual(JSON.parse(request.options.body), { apiKey: 'synthetic-ui-key', relayOrigin: 'https://new-relay.workers.dev' });
  assert.equal(form.elements.apiKey.value, '');
  assert.equal(f.run('brokerConfigDirty()'), false);
  assert.equal(f.context.snapshot.smartapi.configured, false);
  assert.equal(f.run('brokerConfigSaved'), true);
  assert.match(f.nodes['#broker-config-status'].textContent, /Restart TradeGrok/);
  assert.equal(button.disabled, false);
});

test('failed saves show a retryable error rather than success and keep entered fields', async () => {
  const f = fixture();
  const { form, button } = configForm(f);
  f.context.fetch = async () => ({ ok: false, json: async () => ({ error: 'Could not securely save the local .env.' }) });
  await f.submit(form);
  assert.match(f.nodes['#broker-config-error'].textContent, /Could not securely save/);
  assert.equal(f.run('brokerConfigSaved'), false);
  assert.equal(form.elements.apiKey.value, 'synthetic-ui-key');
  assert.equal(button.disabled, false);
});

test('unsaved settings are detected after blur and navigation needs confirmation; pending saves cannot navigate', async () => {
  const f = fixture();
  const { form } = configForm(f);
  f.run('page = "broker"; onboardingStep = 2');
  f.context.window.confirm = () => false;
  assert.equal(f.run('brokerConfigDirty()'), true);
  await f.click({ setupStep: '3' });
  assert.equal(f.run('onboardingStep'), 2);
  await f.click({ page: 'orders' });
  assert.equal(f.run('page'), 'broker');
  let resolve;
  f.context.fetch = () => new Promise(done => { resolve = done; });
  const pending = f.submit(form);
  assert.equal(form.elements.apiKey.disabled, true);
  assert.equal(form.elements.relayOrigin.disabled, true);
  f.context.window.confirm = () => { throw new Error('Should not prompt during save'); };
  await f.click({ page: 'orders' });
  assert.equal(f.run('page'), 'broker');
  resolve({ ok: true, json: async () => ({ saved: true, restartRequired: true }) });
  await pending;
  assert.equal(form.elements.apiKey.disabled, false);
});
