import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8');

function fixture({ saved = null, dark = false, blocked = false, writeBlocked = false, buttonPresent = true } = {}) {
  const listeners = {};
  const writes = [];
  const warnings = [];
  const root = { dataset: {} };
  const meta = {};
  const status = { hidden: true };
  const button = { hidden: true, setAttribute(name, value) { this[name] = value; },
    addEventListener(name, callback) { listeners[name] = callback; } };
  const storage = {
    getItem() { return saved; },
    setItem(key, value) {
      if (writeBlocked) throw new Error('Storage is full');
      writes.push([key, value]);
    }
  };
  const media = { matches: dark, addEventListener(name, callback) { listeners.system = callback; } };
  const window = {
    matchMedia: () => media,
    get localStorage() {
      if (blocked) throw new Error('Storage is disabled');
      return storage;
    },
    addEventListener(name, callback) { listeners[name] = callback; }
  };
  const document = {
    documentElement: root,
    querySelector(selector) {
      if (selector === 'meta[name="theme-color"]') return meta;
      if (selector === '#theme-status') return status;
      if (selector === '#theme-toggle') return buttonPresent ? button : null;
    },
    addEventListener(name, callback) { listeners[name] = callback; }
  };
  runInContext(source, createContext({ window, document, console: { warn: (...args) => warnings.push(args) } }));
  return { root, meta, status, button, storage, media, listeners, writes, warnings };
}

test('system appearance applies before DOM readiness and tracks changes without saving', () => {
  const f = fixture({ dark: true });
  assert.equal(f.root.dataset.theme, 'dark');
  assert.equal(f.meta.content, '#191820');
  assert.equal(f.button.hidden, true);
  f.listeners.DOMContentLoaded();
  assert.equal(f.button.hidden, false);
  assert.equal(f.button['aria-pressed'], 'true');
  f.media.matches = false;
  f.listeners.system();
  assert.equal(f.root.dataset.theme, 'light');
  assert.equal(f.meta.content, '#ede9de');
  assert.equal(f.button['aria-pressed'], 'false');
  assert.deepEqual(f.writes, []);
});

test('both saved themes override system appearance and toggle persistently', () => {
  for (const saved of ['dark', 'light']) {
    const f = fixture({ saved, dark: saved !== 'dark' });
    assert.equal(f.root.dataset.theme, saved);
    f.listeners.DOMContentLoaded();
    f.listeners.system();
    assert.equal(f.root.dataset.theme, saved);
    f.listeners.click();
    const next = saved === 'dark' ? 'light' : 'dark';
    assert.equal(f.root.dataset.theme, next);
    assert.equal(f.button['aria-pressed'], String(next === 'dark'));
    assert.deepEqual(f.writes, [['tradegrok-theme', next]]);
    f.listeners.click();
    assert.equal(f.root.dataset.theme, saved);
    assert.equal(fixture({ saved: f.writes.at(-1)[1] }).root.dataset.theme, saved);
  }
});

test('invalid preferences use the system and other tabs synchronize changes or cleared storage', () => {
  const f = fixture({ saved: 'invalid', dark: true });
  f.listeners.DOMContentLoaded();
  assert.equal(f.root.dataset.theme, 'dark');
  f.listeners.storage({ storageArea: f.storage, key: 'unrelated', newValue: 'light' });
  f.listeners.storage({ storageArea: {}, key: 'tradegrok-theme', newValue: 'light' });
  assert.equal(f.root.dataset.theme, 'dark');
  f.listeners.storage({ storageArea: f.storage, key: 'tradegrok-theme', newValue: 'light' });
  assert.equal(f.root.dataset.theme, 'light');
  f.listeners.storage({ storageArea: f.storage, key: 'tradegrok-theme', newValue: null });
  assert.equal(f.root.dataset.theme, 'dark');
  f.listeners.storage({ storageArea: f.storage, key: 'tradegrok-theme', newValue: 'light' });
  f.listeners.storage({ storageArea: f.storage, key: null, newValue: null });
  assert.equal(f.root.dataset.theme, 'dark');
  assert.deepEqual(f.writes, []);
});

test('blocked reads and failed writes still allow toggling and visibly report persistence failure', () => {
  for (const options of [{ blocked: true }, { writeBlocked: true }]) {
    const f = fixture(options);
    f.listeners.DOMContentLoaded();
    f.listeners.click();
    assert.equal(f.root.dataset.theme, 'dark');
    assert.equal(f.button['aria-pressed'], 'true');
    assert.equal(f.status.hidden, false);
    assert.match(f.status.textContent, /cannot be saved.*this page only/);
    assert.ok(f.warnings.length > 0);
    f.media.matches = false;
    f.listeners.system();
    assert.equal(f.root.dataset.theme, 'dark');
  }
});

test('broker handoff applies appearance without requiring dashboard controls', () => {
  const f = fixture({ saved: 'dark', buttonPresent: false });
  f.listeners.DOMContentLoaded();
  assert.equal(f.root.dataset.theme, 'dark');
  assert.equal(f.listeners.click, undefined);
  for (const path of ['index.html', 'smartapi-return.html']) {
    const html = readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');
    assert.ok(html.indexOf('<script src="/theme.js"></script>') < html.indexOf('<link rel="stylesheet"'));
  }
});
