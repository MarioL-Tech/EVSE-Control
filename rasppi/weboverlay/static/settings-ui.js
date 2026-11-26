/* Presentation only: no fetch, persistence, commands or control enablement here. */
(() => {
  'use strict';
  const doc = document;
  let opened = null, pinned = false, serial = 0;
  const resize = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { if (opened?.isConnected) reserve(opened); }) : null;
  function reserve(help) {
    help.closest('.esp32-revoke').style.paddingBottom = help.querySelector('.setting-tip').getBoundingClientRect().height + 'px';
  }
  function close() {
    resize?.disconnect();
    if (opened) { opened.open = false; opened.closest('.esp32-revoke')?.style.removeProperty('padding-bottom'); }
    opened = null; pinned = false;
  }
  function show(help) {
    if (opened !== help) { close(); opened = help; }
    help.open = true;
    // Only the UID row borders the independent enrollment actions above it.
    // Reflowing every focused field moves form buttons between down and up.
    if (help.parentElement.dataset.settingInfo === 'esp32-uid') {
      reserve(help);
      resize?.observe(help.querySelector('.setting-tip'));
    }
  }
  function reveal(input) {
    requestAnimationFrame(() => {
      if (doc.activeElement !== input) return;
      const row = input.closest('.setting-field, .esp32-revoke') || input;
      row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }
  function helpFor(title, text, input) {
    const help = doc.createElement('details'), trigger = doc.createElement('summary'), tip = doc.createElement('span');
    // Unlike a meter endpoint, the reader's URL is a base origin, not a path.
    if (input?.id === 'env-key-WALLBOX_AUTOMATION_WEB_URL') {
      input.placeholder = 'z. B. http://weboverlay:8080';
      text += ' Nur die interne Website-Origin ohne Pfad eintragen.';
    }
    help.className = 'setting-help'; trigger.textContent = 'i'; trigger.setAttribute('aria-label', 'Info: ' + title);
    tip.className = 'setting-tip'; tip.id = 'setting-help-' + (++serial); tip.textContent = text; tip.setAttribute('role', 'tooltip');
    trigger.setAttribute('aria-describedby', tip.id);
    if (input) input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), tip.id].filter(Boolean).join(' '));
    help.append(trigger, tip);
    help.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') show(help); });
    help.addEventListener('pointerleave', () => { if (opened === help && !pinned && doc.activeElement !== trigger) close(); });
    trigger.addEventListener('focus', () => show(help));
    trigger.addEventListener('blur', () => { if (opened === help) close(); });
    trigger.addEventListener('click', e => {
      e.preventDefault();
      if (opened === help && pinned) close(); else { show(help); pinned = true; }
    });
    if (input) {
      input.addEventListener('focus', () => {
        if (input.getAttribute('aria-invalid') === 'true') close(); else show(help);
        reveal(input);
      });
      input.addEventListener('input', () => {
        // Validators run on the same event. Reveal their resulting inline
        // message, not merely the native input box at the viewport edge.
        requestAnimationFrame(() => {
          if (doc.activeElement === input && input.getAttribute('aria-invalid') === 'true') close();
          reveal(input);
        });
      });
      input.addEventListener('blur', () => { if (opened === help && !pinned) close(); });
      input.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') show(help); });
      input.addEventListener('pointerleave', () => {
        if (opened === help && !pinned && doc.activeElement !== input) close();
      });
    }
    return help;
  }
  doc.addEventListener('keydown', e => { if (e.key === 'Escape' && opened) { close(); e.preventDefault(); } });
  doc.addEventListener('pointerdown', e => { if (opened && !opened.contains(e.target)) close(); });
  // Enter in a data field should not implicitly POST the entire draft.
  // Native button activation and Enter/Space on disclosures remain intact.
  doc.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.matches('#charging-form input,#env-form input')) e.preventDefault();
  });
  window.EvseSettingsUI = { helpFor };
  for (const slot of doc.querySelectorAll('[data-setting-info]')) {
    const input = doc.getElementById(slot.dataset.settingInfo);
    slot.append(helpFor(slot.dataset.title, slot.dataset.help, input));
  }
  const uid = doc.getElementById('esp32-uid'), error = doc.getElementById('uid-format-error');
  if (uid && error) {
    const feedback = () => {
      const invalid = uid.value !== '' && !uid.validity.valid;
      uid.setAttribute('aria-invalid', String(invalid)); error.hidden = !invalid;
    };
    uid.addEventListener('input', feedback);
    const clearUid = () => {
      uid.value = '';
      // Also update the independent ESP32 client's revoke enablement.
      uid.dispatchEvent(new Event('input', { bubbles: true }));
    };
    window.addEventListener('pagehide', clearUid);
    doc.addEventListener('visibilitychange', () => { if (doc.hidden) clearUid(); });
  }
})();
