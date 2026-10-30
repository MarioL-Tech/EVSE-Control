(function () {
  'use strict';
  const ENDPOINT = '/api/charging-settings';
  const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const NUMBERS = [
    ['max_import_w', 'Erlaubter Netzbezug (W)', 0, 100000, 1],
    ['max_current_ma', 'Maximaler Ladestrom (A)', 6, 32, .001],
    ['adjust_seconds', 'Stromanpassung nach (s)', 0, 3600, 1],
    ['pause_seconds', 'Pausieren nach (s)', 0, 3600, 1],
    ['resume_seconds', 'Wiederaufnahme nach (s)', 0, 3600, 1]
  ];
  function number(value, milli = false) {
    if (value === '') return null;
    if (!/^\d+(?:\.\d{1,3})?$/.test(value)) throw new Error('invalid');
    const n = Number(value);
    const result = milli ? Math.round(n * 1000) : n;
    if (!Number.isSafeInteger(result)) throw new Error('invalid');
    return result;
  }
  function parseResponse(body) {
    if (!body || body.schema_version !== 1 || body.automation_available !== false ||
        !['ok', 'disabled', 'unavailable', 'conflict', 'busy', 'invalid', 'forbidden'].includes(body.status)) throw new Error('invalid');
    if (body.status === 'ok' && (typeof body.csrf !== 'string' || !/^[a-f0-9]{64}$/.test(body.csrf) ||
        !(body.revision === null || typeof body.revision === 'string' && /^[a-f0-9]{64}$/.test(body.revision)) ||
        body.config?.schema_version !== 1 || body.config.timezone !== 'Europe/Vienna' ||
        !body.config.manual || !body.config.pv || !body.config.custom ||
        !Array.isArray(body.config.custom.windows) || body.config.custom.windows.length > 16 ||
        !Array.isArray(body.config.custom.weekdays) || body.config.custom.weekdays.length > 7)) throw new Error('invalid');
    return body;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { number, parseResponse };
  if (typeof document === 'undefined') return;
  const form = document.getElementById('charging-form'); if (!form) return;
  const byId = id => document.getElementById(id);
  const fields = byId('charging-fields'), status = byId('charging-status');
  let revision = null, csrf = null, available = false, dirty = false, busy = false, active = null, activeSave = false, generation = 0;
  function element(tag, value) { const el = document.createElement(tag); if (value) el.textContent = value; return el; }
  function profile(name, title) {
    const el = element('fieldset'); el.className = 'charging-profile'; el.append(element('legend', title));
    const grid = element('div'); grid.className = 'charging-profile-fields'; el.append(grid); fields.append(el);
    return { el, grid, name };
  }
  function numeric(parent, key, title, min, max, step) {
    const label = element('label', title), input = element('input');
    input.id = `charging-${parent.name}-${key}`; input.type = 'number';
    input.min = String(min); input.max = String(max); input.step = String(step);
    label.htmlFor = input.id; label.append(input); parent.grid.append(label);
  }
  function select(parent, key, title, choices) {
    const label = element('label', title), input = element('select'); input.id = `charging-${parent.name}-${key}`;
    for (const [value, text] of choices) { const option = element('option', text); option.value = value; input.append(option); }
    label.htmlFor = input.id; label.append(input); parent.grid.append(label);
  }
  const manual = profile('manual', 'Manuell');
  numeric(manual, 'current_ma', 'Ladestromvorlage (A)', 6, 32, .001);
  const pv = profile('pv', 'PV-Regelung'), custom = profile('custom', 'Benutzerdefiniert');
  for (const parent of [pv, custom]) for (const item of NUMBERS) numeric(parent, ...item);
  const bools = [['', 'Nicht festgelegt'], ['true', 'Ja'], ['false', 'Nein']];
  select(custom, 'pv_enabled', 'PV-Grenze berücksichtigen', bools);
  select(custom, 'use_schedule', 'Zeitfenster verwenden', bools);
  select(custom, 'outside_window', 'Außerhalb der Zeitfenster', [['', 'Nicht festgelegt'], ['pause', 'Pausieren'], ['manual', 'Manuell bedienen']]);
  custom.el.append(element('p', 'Europe/Vienna · Ein Zeitfenster über Mitternacht endet am Folgetag.'));
  const days = element('div'); days.className = 'charging-days'; days.setAttribute('role', 'group'); days.setAttribute('aria-label', 'Wochentage');
  DAYS.forEach((text, i) => {
    const label = element('label'), input = element('input'); input.type = 'checkbox'; input.value = String(i + 1);
    input.id = `charging-day-${i + 1}`; label.append(input, document.createTextNode(text)); days.append(label);
  });
  custom.el.append(days);
  const windows = element('div'); windows.id = 'charging-windows'; custom.el.append(windows);
  const add = element('button', 'Zeitfenster hinzufügen'); add.id = 'charging-add-window'; add.type = 'button'; custom.el.append(add);
  function mark() { dirty = true; status.textContent = 'Ungespeichert · noch keine aktive Regelung.'; render(); }
  function windowRow(value = { from: '', to: '' }) {
    if (windows.children.length >= 16) return;
    const row = element('div'); row.className = 'charging-window';
    for (const [key, title] of [['from', 'Von'], ['to', 'Bis']]) {
      const label = element('label', title), input = element('input'); input.type = 'time'; input.required = true;
      input.dataset.time = key; input.value = value[key]; label.append(input); row.append(label);
    }
    const remove = element('button', 'Entfernen'); remove.type = 'button';
    remove.addEventListener('click', () => { row.remove(); mark(); }); row.append(remove); windows.append(row);
  }
  function fill(config) {
    for (const [p, data] of Object.entries({ manual: config.manual, pv: config.pv, custom: config.custom })) {
      for (const [key, value] of Object.entries(data)) {
        const input = byId(`charging-${p}-${key}`); if (!input) continue;
        input.value = value === null ? '' : key.endsWith('_ma') ? String(value / 1000) : String(value);
      }
    }
    for (const input of days.querySelectorAll('input')) input.checked = config.custom.weekdays.includes(Number(input.value));
    windows.replaceChildren(); config.custom.windows.forEach(windowRow);
  }
  function collect() {
    const config = { schema_version: 1, timezone: 'Europe/Vienna', manual: {}, pv: {}, custom: {} };
    config.manual.current_ma = number(byId('charging-manual-current_ma').value, true);
    for (const p of ['pv', 'custom']) for (const [key] of NUMBERS)
      config[p][key] = number(byId(`charging-${p}-${key}`).value, key.endsWith('_ma'));
    for (const key of ['pv_enabled', 'use_schedule']) {
      const value = byId(`charging-custom-${key}`).value; config.custom[key] = value === '' ? null : value === 'true';
    }
    config.custom.outside_window = byId('charging-custom-outside_window').value || null;
    config.custom.weekdays = [...days.querySelectorAll('input:checked')].map(input => Number(input.value));
    config.custom.windows = [...windows.children].map(row => Object.fromEntries([...row.querySelectorAll('input')].map(input => [input.dataset.time, input.value])));
    if (config.custom.windows.some(w => w.from === w.to)) throw new Error('invalid');
    return config;
  }
  function render() {
    fields.disabled = !available || busy;
    byId('charging-save').disabled = !available || !dirty || busy;
    byId('charging-reload').disabled = busy;
    add.disabled = !available || busy || windows.children.length >= 16;
  }
  async function exchange(save = false) {
    if (busy || save && (!available || !dirty || !form.reportValidity())) return;
    let config;
    try { if (save) config = collect(); } catch (_) { status.textContent = 'Werte oder Zeitfenster ungültig.'; return; }
    busy = true; const controller = new AbortController(), token = ++generation; active = controller; activeSave = save; render();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(ENDPOINT, { method: save ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        ...(save ? { headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ revision, config }) } : {}) });
      const body = parseResponse(await response.json()); if (token !== generation) return;
      if (body.status === 'conflict') { status.textContent = 'Zwischenzeitlich geändert. Neu laden; Entwurf bleibt erhalten.'; return; }
      if (!response.ok || body.status !== 'ok') {
        if (!save || body.status === 'forbidden') available = false;
        status.textContent = body.status === 'disabled' ? 'Regelkonfiguration nicht freigegeben.' : body.status === 'invalid' ?
          'Werte oder Zeitfenster ungültig.' : 'Regelkonfiguration nicht verfügbar. Settings-Dateibereitstellung prüfen.';
        return;
      }
      revision = body.revision; csrf = body.csrf; available = true; dirty = false; fill(body.config);
      status.textContent = save ? 'Vorlagen gespeichert · Automatik noch nicht aktiv.' : 'Regelvorlagen · noch keine aktive Regelung.';
    } catch (_) {
      if (token === generation) {
        available = false;
        status.textContent = save ? 'Speicherstatus unklar. Vor erneutem Speichern neu laden.' : 'Regelkonfiguration nicht erreichbar.';
      }
    } finally { clearTimeout(timeout); if (active === controller) { active = null; activeSave = false; } busy = false; render(); }
  }
  fields.addEventListener('input', mark); fields.addEventListener('change', mark);
  add.addEventListener('click', () => { windowRow(); mark(); });
  form.addEventListener('submit', event => { event.preventDefault(); void exchange(true); });
  byId('charging-reload').addEventListener('click', () => { void exchange(); });
  window.addEventListener('pagehide', () => {
    generation++;
    if (activeSave) { available = false; status.textContent = 'Speicherstatus unklar. Vor erneutem Speichern neu laden.'; }
    if (active) active.abort();
  });
  window.addEventListener('pageshow', event => { if (event.persisted && !dirty && !busy) void exchange(); });
  render(); void exchange();
})();
