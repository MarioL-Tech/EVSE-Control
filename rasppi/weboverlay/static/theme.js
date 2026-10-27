(function () {
  'use strict';
  const STORAGE_KEY = 'evse-theme-v1';
  const MODES = Object.freeze(['system', 'light', 'dark']);
  const normalize = value => MODES.includes(value) ? value : 'system';
  const effectiveMode = (mode, systemDark) => normalize(mode) === 'system'
    ? (systemDark ? 'dark' : 'light') : normalize(mode);

  function createController(storage, onChange = () => {}) {
    let mode = 'system', sessionOnly = false;
    function apply() { onChange(mode); return mode; }
    function restore() {
      if (!sessionOnly && storage) {
        try { mode = normalize(storage.getItem(STORAGE_KEY)); } catch (_) { /* Keep session choice. */ }
      }
      return apply();
    }
    function setMode(value) {
      mode = normalize(value);
      sessionOnly = true;
      if (storage) {
        try {
          if (mode === 'system') storage.removeItem(STORAGE_KEY);
          else storage.setItem(STORAGE_KEY, mode);
          sessionOnly = false;
        } catch (_) { /* A denied write must not undo the choice on pageshow. */ }
      }
      return apply();
    }
    restore();
    return { getMode: () => mode, setMode, restore };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { STORAGE_KEY, MODES, normalize, effectiveMode, createController };
  }
  if (typeof document === 'undefined') return;
  let storage = null;
  try { storage = window.localStorage; } catch (_) { /* System default without readable storage. */ }
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  function updateControl(mode) {
    const dark = effectiveMode(mode, system.matches) === 'dark';
    document.documentElement.setAttribute('data-effective-theme', dark ? 'dark' : 'light');
    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
      toggle.setAttribute('aria-checked', String(dark));
      toggle.title = dark ? 'Helles Design aktivieren' : 'Dunkles Design aktivieren';
    }
  }
  const controller = createController(storage, mode => {
    if (mode === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    updateControl(mode);
  });
  // This script runs before the stylesheet to avoid painting a saved light choice dark.
  function bind() {
    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
      toggle.disabled = false;
      toggle.addEventListener('click', () => controller.setMode(
        effectiveMode(controller.getMode(), system.matches) === 'dark' ? 'light' : 'dark'));
    }
    const reset = document.getElementById('theme-system');
    if (reset) {
      reset.disabled = false;
      reset.addEventListener('click', () => controller.setMode('system'));
    }
    updateControl(controller.getMode());
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
  window.addEventListener('pageshow', () => controller.restore());
  system.addEventListener('change', () => updateControl(controller.getMode()));
  window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY || event.key === null) controller.restore();
  });
})();
