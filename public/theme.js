(() => {
  const storageKey = 'tradegrok-theme';
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = null;
  let storage = null;
  let storageError = '';

  function reportStorageError(error) {
    storageError = 'Theme preference cannot be saved in this browser. Your choice applies to this page only.';
    console.warn(storageError, error);
    const status = document.querySelector('#theme-status');
    if (status) {
      status.textContent = storageError;
      status.hidden = false;
    }
  }

  try {
    storage = window.localStorage;
    const saved = storage.getItem(storageKey);
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch (error) {
    reportStorageError(error);
  }

  function applyTheme() {
    const theme = preference ?? (systemTheme.matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#191820' : '#ede9de';
    const button = document.querySelector('#theme-toggle');
    if (button) button.setAttribute('aria-pressed', String(theme === 'dark'));
  }

  applyTheme();
  systemTheme.addEventListener('change', () => {
    if (preference === null) applyTheme();
  });
  window.addEventListener('storage', event => {
    if (!storage || event.storageArea !== storage || (event.key !== storageKey && event.key !== null)) return;
    preference = event.newValue === 'light' || event.newValue === 'dark' ? event.newValue : null;
    applyTheme();
  });
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme();
    if (storageError) {
      const status = document.querySelector('#theme-status');
      if (status) {
        status.textContent = storageError;
        status.hidden = false;
      }
    }
    const button = document.querySelector('#theme-toggle');
    if (!button) return;
    button.hidden = false;
    button.addEventListener('click', () => {
      preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
      try {
        storage = window.localStorage;
        storage.setItem(storageKey, preference);
      } catch (error) {
        reportStorageError(error);
      }
    });
  });
})();
