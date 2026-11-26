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
  const NOTES = {
    phases: 'Nur die geprüfte Anzahl der tatsächlich zum Laden genutzten Phasen wählen. Unbekannt bleibt „Nicht festgelegt“.',
    meter_includes_wallbox: 'Ja: Die Haus-Netzleistung enthält die Wallbox. Nein: Der Zähler erfasst sie nicht. Bei unbekannter Verdrahtung offenlassen.',
    current_ma: 'Stromvorlage für manuelles Laden. Der Eintrag allein startet keinen Ladevorgang.',
    max_import_w: 'So viel Leistung darf beim geregelten Laden aus dem Netz bezogen werden. 0 W bedeutet kein geplanter Netzbezug.',
    max_current_ma: 'Obergrenze für dieses Profil. Geräte- und Installationsgrenzen gelten weiterhin.',
    adjust_seconds: 'So lange soll der geänderte Leistungsbedarf bestehen, bevor der Regler den Strom anpasst.',
    pause_seconds: 'Wartezeit vor einer regelbedingten Pause, wenn die nutzbare Leistung nicht ausreicht.',
    resume_seconds: 'Wartezeit, bis der Regler bei ausreichender Leistung wieder laden darf.',
    pv_enabled: 'Bezieht die Haus-Netzleistung und die eingestellte Netzbezugsgrenze in dieses Profil ein.',
    use_schedule: 'Beschränkt dieses Profil auf die gewählten Wochentage und Zeitfenster.',
    outside_window: 'Legt fest, was außerhalb der freigegebenen Zeitfenster gilt. „Manuell bedienen“ ist keine automatische Startfreigabe.'
  };
  const EXAMPLES = { current_ma: '8', max_current_ma: '9,5', max_import_w: '250', adjust_seconds: '20', pause_seconds: '45', resume_seconds: '90' };
  function number(value, milli = false) {
    if (value === '') return null;
    if (!/^\d+(?:\.\d{1,3})?$/.test(value)) throw new Error('invalid');
    const n = Number(value);
    const result = milli ? Math.round(n * 1000) : n;
    if (!Number.isSafeInteger(result)) throw new Error('invalid');
    return result;
  }
  function validConfig(config) {
    const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
    const bounded = (n, min, max) => n === null || Number.isInteger(n) && min <= n && n <= max;
    const nullableBool = v => v === null || typeof v === 'boolean';
    const keys = ['schema_version', 'timezone', 'manual', 'custom', 'pv'];
    if (!exact(config, keys) && !exact(config, [...keys, 'installation'])) return false;
    if (config.schema_version !== 1 || config.timezone !== 'Europe/Vienna' || !exact(config.manual, ['current_ma']) || !bounded(config.manual.current_ma, 6000, 32000)) return false;
    if ('installation' in config && (!exact(config.installation, ['phases', 'meter_includes_wallbox']) || !bounded(config.installation.phases, 1, 3) || !nullableBool(config.installation.meter_includes_wallbox))) return false;
    const base = NUMBERS.map(([key]) => key), c = config.custom;
    if (!exact(config.pv, base) || !exact(c, [...base, 'weekdays', 'windows', 'pv_enabled', 'use_schedule', 'outside_window'])) return false;
    for (const p of [config.pv, c]) for (const [key,,min,max] of NUMBERS) {
      const scale = key.endsWith('_ma') ? 1000 : 1; if (!bounded(p[key], min * scale, max * scale)) return false;
    }
    const time = s => typeof s === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s);
    return nullableBool(c.pv_enabled) && nullableBool(c.use_schedule) && [null, 'manual', 'pause'].includes(c.outside_window) &&
      Array.isArray(c.weekdays) && c.weekdays.length <= 7 && c.weekdays.every(d => Number.isInteger(d) && d >= 1 && d <= 7) && new Set(c.weekdays).size === c.weekdays.length &&
      Array.isArray(c.windows) && c.windows.length <= 16 && c.windows.every(w => exact(w, ['from', 'to']) && time(w.from) && time(w.to) && w.from !== w.to) &&
      new Set(c.windows.map(w => w.from + w.to)).size === c.windows.length;
  }
  function parseResponse(body) {
    if (!body || body.schema_version !== 1 || body.automation_available !== false ||
        !['ok', 'disabled', 'unavailable', 'conflict', 'busy', 'invalid', 'forbidden'].includes(body.status)) throw new Error('invalid');
    if (body.status === 'ok' && (typeof body.csrf !== 'string' || !/^[a-f0-9]{64}$/.test(body.csrf) ||
        !(body.revision === null || typeof body.revision === 'string' && /^[a-f0-9]{64}$/.test(body.revision)) ||
        !validConfig(body.config))) throw new Error('invalid');
    return body;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { number, parseResponse, validConfig };
  if (typeof document === 'undefined') return;
  const form = document.getElementById('charging-form'); if (!form) return;
  const byId = id => document.getElementById(id);
  const fields = byId('charging-fields'), status = byId('charging-status');
  function message(value) { if (status.textContent !== value) status.textContent = value; status.hidden = !value; }
  let baseline = null, nextWindow = 0;
  let revision = null, csrf = null, available = false, dirty = false, busy = false, active = null, activeSave = false, generation = 0;
  function element(tag, value) { const el = document.createElement(tag); if (value) el.textContent = value; return el; }
  function profile(name, title) {
    const el = element('details'); el.className = 'charging-profile'; el.append(element('summary', title));
    const grid = element('div'); grid.className = 'charging-profile-fields'; el.append(grid); fields.append(el);
    return { el, grid, name };
  }
  function place(parent, input, title, note) {
    const row = element('div'), heading = element('div'), label = element('label', title);
    row.className = 'setting-field'; heading.className = 'setting-heading'; label.htmlFor = input.id;
    heading.append(label, window.EvseSettingsUI.helpFor(title, note, input));
    const error = element('span'); error.id = input.id + '-error'; error.hidden = true; error.className = 'setting-error';
    input.setAttribute('aria-describedby', `${input.getAttribute('aria-describedby')} ${error.id}`);
    row.append(heading, input, error); parent.append(row);
  }
  function numeric(parent, key, title, min, max, step) {
    const input = element('input'); input.id = `charging-${parent.name}-${key}`; input.type = 'number';
    input.min = String(min); input.max = String(max); input.step = String(step);
    input.placeholder = 'z. B. ' + EXAMPLES[key];
    place(parent.grid, input, title, NOTES[key] + ` Bereich: ${min} bis ${max}. Leer = nicht festgelegt.`);
  }
  function select(parent, key, title, choices) {
    const input = element('select'); input.id = `charging-${parent.name}-${key}`;
    for (const [value, text] of choices) { const option = element('option', text); option.value = value; input.append(option); }
    place(parent.grid, input, title, NOTES[key]);
  }
  const manual = profile('manual', 'Manuell');
  const installation = { name: 'installation', grid: element('div') };
  installation.grid.className = 'charging-profile-fields charging-installation';
  fields.insertBefore(installation.grid, manual.el);
  const installTitle = element('h3', 'Grundlage der Regelung'); installTitle.className = 'settings-group-title';
  fields.insertBefore(installTitle, installation.grid);
  select(installation, 'phases', 'Ladephasen (geprüfte Konfiguration)', [['', 'Nicht festgelegt'], ['1', '1'], ['2', '2'], ['3', '3']]);
  select(installation, 'meter_includes_wallbox', 'Hauszähler erfasst die Wallbox mit', [['', 'Nicht festgelegt'], ['true', 'Ja'], ['false', 'Nein']]);
  numeric(manual, 'current_ma', 'Ladestromvorlage (A)', 6, 32, .001);
  const pv = profile('pv', 'PV-Regelung'), custom = profile('custom', 'Benutzerdefiniert');
  function groupCaption(parent, text) {
    const heading = element('h3', text); heading.className = 'settings-grid-caption'; parent.grid.append(heading);
  }
  for (const parent of [pv, custom]) {
    groupCaption(parent, 'Leistungsgrenzen');
    for (const item of NUMBERS) {
      if (item[0] === 'adjust_seconds') groupCaption(parent, 'Wartezeiten');
      numeric(parent, ...item);
    }
  }
  const bools = [['', 'Nicht festgelegt'], ['true', 'Ja'], ['false', 'Nein']];
  groupCaption(custom, 'Regeln kombinieren'); select(custom, 'pv_enabled', 'PV-Grenze berücksichtigen', bools);
  select(custom, 'use_schedule', 'Zeitfenster verwenden', bools);
  select(custom, 'outside_window', 'Außerhalb der Zeitfenster', [['', 'Nicht festgelegt'], ['pause', 'Pausieren'], ['manual', 'Manuell bedienen']]);
  const daysTitle = element('div'); daysTitle.className = 'setting-heading schedule-heading';
  daysTitle.append(element('strong', 'Wochentage'), window.EvseSettingsUI.helpFor('Wochentage', 'Wähle die Tage, an denen ein Zeitfenster beginnt. Die Zeiten gelten in Europe/Vienna.'));
  custom.el.append(daysTitle);
  const days = element('div'); days.className = 'charging-days'; days.setAttribute('role', 'group'); days.setAttribute('aria-label', 'Wochentage');
  days.setAttribute('aria-describedby', daysTitle.querySelector('.setting-tip').id);
  DAYS.forEach((text, i) => {
    const label = element('label'), input = element('input'); input.type = 'checkbox'; input.value = String(i + 1);
    input.id = `charging-day-${i + 1}`; label.append(input, document.createTextNode(text)); days.append(label);
  });
  custom.el.append(days);
  const windows = element('div'); windows.id = 'charging-windows'; custom.el.append(windows);
  const add = element('button', 'Zeitfenster hinzufügen'); add.id = 'charging-add-window'; add.type = 'button'; custom.el.append(add);
  function validateFields() {
    let ok = true;
    const seen = new Set();
    for (const input of fields.querySelectorAll('input[type=number],input[type=time]')) {
      let problem = '';
      input.setCustomValidity('');
      if (input.type === 'number') {
        try { number(input.value, input.id.endsWith('_ma')); } catch (_) { problem = 'Bitte eine gültige Dezimalzahl eingeben.'; }
        if (!input.validity.valid) problem = `Erlaubt: ${input.min} bis ${input.max}${input.step === '1' ? ' (ganze Zahlen)' : ' (bis zu drei Nachkommastellen)'}.`;
      } else {
        if (!input.validity.valid) problem = 'Uhrzeit fehlt oder ist ungültig.';
        if (input.dataset.time === 'to' && input.value) {
          const from = input.closest('.charging-window').querySelector('[data-time=from]').value;
          if (from === input.value) problem = 'Beginn und Ende müssen verschieden sein.';
          else if (from && seen.has(from + input.value)) problem = 'Dieses Zeitfenster ist bereits vorhanden.';
          seen.add(from + input.value);
        }
      }
      input.setCustomValidity(problem); input.setAttribute('aria-invalid', String(!!problem));
      const hint = byId(input.id + '-error'); if (hint.textContent !== problem) hint.textContent = problem; hint.hidden = !problem;
      if (problem) ok = false;
    }
    return ok;
  }
  function mark() {
    const ok = validateFields();
    dirty = !ok || JSON.stringify(collect()) !== baseline;
    message(!ok ? 'Ungespeichert. Markierte Eingaben prüfen.' : dirty ? 'Ungespeichert.' : ''); render();
  }
  function windowRow(value = { from: '', to: '' }) {
    if (windows.children.length >= 16) return;
    const row = element('div'); row.className = 'charging-window'; const seq = ++nextWindow;
    for (const [key, title] of [['from', 'Von'], ['to', 'Bis']]) {
      const input = element('input'); input.type = 'time'; input.required = true;
      input.id = `charging-time-${seq}-${key}`; input.dataset.time = key; input.value = value[key];
      place(row, input, title, key === 'from' ? 'Beginn am gewählten Wochentag (Ortszeit Wien).' : 'Liegt das Ende vor dem Beginn, endet das Zeitfenster am Folgetag.');
    }
    const remove = element('button', 'Entfernen'); remove.type = 'button';
    remove.addEventListener('click', () => { row.remove(); mark(); add.focus(); }); row.append(remove); windows.append(row);
  }
  function fill(config) {
    for (const [p, data] of Object.entries({ installation: config.installation || { phases: null, meter_includes_wallbox: null }, manual: config.manual, pv: config.pv, custom: config.custom })) {
      for (const [key, value] of Object.entries(data)) {
        const input = byId(`charging-${p}-${key}`); if (!input) continue;
        input.value = value === null ? '' : key.endsWith('_ma') ? String(value / 1000) : String(value);
      }
    }
    for (const input of days.querySelectorAll('input')) input.checked = config.custom.weekdays.includes(Number(input.value));
    windows.replaceChildren(); config.custom.windows.forEach(windowRow);
  }
  function collect() {
    const config = { schema_version: 1, timezone: 'Europe/Vienna', installation: {
      phases: number(byId('charging-installation-phases').value),
      meter_includes_wallbox: byId('charging-installation-meter_includes_wallbox').value === '' ? null : byId('charging-installation-meter_includes_wallbox').value === 'true'
    }, manual: {}, pv: {}, custom: {} };
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
    try { if (save) config = collect(); } catch (_) { message('Werte oder Zeitfenster ungültig.'); return; }
    busy = true; const controller = new AbortController(), token = ++generation; active = controller; activeSave = save;
    message(save ? 'Regeln werden gespeichert …' : 'Lade Einstellungen …'); render();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(ENDPOINT, { method: save ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        ...(save ? { headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ revision, config }) } : {}) });
      const body = parseResponse(await response.json()); if (token !== generation) return;
      if (body.status === 'conflict') { available = false; message('Zwischenzeitlich geändert. Bitte neu laden.'); return; }
      if (!response.ok || body.status !== 'ok') {
        if (!save || body.status === 'forbidden') available = false;
        message(body.status === 'disabled' ? 'Regelkonfiguration nicht freigegeben.' : body.status === 'invalid' ?
          'Werte oder Zeitfenster ungültig.' : 'Regelkonfiguration nicht verfügbar.');
        return;
      }
      revision = body.revision; csrf = body.csrf; available = true; dirty = false; fill(body.config);
      baseline = JSON.stringify(collect()); validateFields();
      message(save ? 'Gespeichert.' : '');
    } catch (_) {
      if (token === generation) {
        available = false;
        message(save ? 'Speicherstatus unklar. Bitte neu laden.' : 'Regelkonfiguration nicht erreichbar.');
      }
    } finally { clearTimeout(timeout); if (active === controller) { active = null; activeSave = false; } busy = false; render(); }
  }
  fields.addEventListener('input', mark); fields.addEventListener('change', mark);
  fields.addEventListener('invalid', event => {
    const section = event.target.closest('details.charging-profile');
    if (section) section.open = true;
  }, true);
  add.addEventListener('click', () => { windowRow(); mark(); windows.lastElementChild?.querySelector('input').focus(); });
  form.addEventListener('submit', event => { event.preventDefault(); void exchange(true); });
  byId('charging-reload').addEventListener('click', () => {
    if (dirty && !window.confirm('Ungespeicherte Profiländerungen verwerfen und neu laden?')) return;
    void exchange();
  });
  window.addEventListener('pagehide', () => {
    generation++;
    if (activeSave) { available = false; message('Speicherstatus unklar. Bitte neu laden.'); }
    if (active) active.abort();
  });
  window.addEventListener('pageshow', event => { if (event.persisted && !dirty && !busy) void exchange(); });
  render(); void exchange();
})();
