(function () {
  'use strict';
  const STORAGE_KEY = 'evse-theme-v1';
  const MODES = Object.freeze(['system', 'light', 'dark']);
  const normalize = value => MODES.includes(value) ? value : 'system';

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
    module.exports = { STORAGE_KEY, MODES, normalize, createController };
  }
  if (typeof document === 'undefined') return;
  let storage = null;
  try { storage = window.localStorage; } catch (_) { /* System default without readable storage. */ }
  const controller = createController(storage, mode => {
    if (mode === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    const select = document.getElementById('theme-mode');
    if (select) select.value = mode;
  });
  // This script runs before the stylesheet to avoid painting a saved light choice dark.
  function bind() {
    const select = document.getElementById('theme-mode');
    if (!select) return;
    select.value = controller.getMode();
    select.disabled = false;
    select.addEventListener('change', () => controller.setMode(select.value));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
  window.addEventListener('pageshow', () => controller.restore());
  window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY || event.key === null) controller.restore();
  });
})();
