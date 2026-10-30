(function () {
  'use strict';
  const MODES = ['manual', 'pv', 'custom'];
  const STATES = ['awaiting_activation', 'manual', 'manual_override', 'frozen', 'invalid_configuration',
    'source_unavailable', 'manual_handling', 'unplugged', 'adjusting', 'pausing', 'resuming',
    'awaiting_start', 'awaiting_stop', 'charging', 'vehicle_finished'];
  const HTTP = ['waiting', 'ok', 'transport_unavailable', 'invalid_response', 'disabled', 'clock_error', 'invalid_base'];
  const LABEL = { manual: 'Manuell', pv: 'PV-Regelung', custom: 'Benutzerdefiniert' };
  const STATE = { manual: 'Manuell', manual_override: 'Manuell – Automatik durch manuellen Eingriff gesperrt',
    frozen: 'Automatik gesperrt – Voraussetzungen prüfen und bewusst erneut wählen',
    awaiting_activation: 'Neue Aktivierung erforderlich – Modus erneut wählen',
    invalid_configuration: 'Konfiguration ungültig – Settings prüfen', source_unavailable: 'Messquelle nicht verfügbar',
    manual_handling: 'Manueller Eingriff erforderlich', unplugged: 'Kein Fahrzeug angeschlossen',
    adjusting: 'Regelung passt Strom an', pausing: 'Regler sieht eine Ladepause vor', resuming: 'Regler sieht eine Wiederaufnahme vor',
    awaiting_start: 'Start-ACK erhalten – neuer Ladestatus ausstehend', awaiting_stop: 'Stop-ACK erhalten – neuer Ladestatus ausstehend',
    charging: 'Regler meldet Ladebetrieb (Live-Ladestatus separat)', vehicle_finished: 'Regler meldet Ladevorgang beendet' };
  const REQUIRED = { 'installation.phases': 'Phasenanzahl', 'installation.meter_includes_wallbox': 'Wallbox im Hauszähler' };
  for (const mode of ['pv', 'custom']) for (const [key, label] of Object.entries({ max_import_w: 'Netzbezugsgrenze',
    max_current_ma: 'Maximaler Ladestrom', adjust_seconds: 'Anpassungsverzögerung', pause_seconds: 'Pausenverzögerung',
    resume_seconds: 'Wiederaufnahmeverzögerung', use_schedule: 'Zeitplan verwenden', pv_enabled: 'PV berücksichtigen',
    weekdays: 'Wochentage', windows: 'Zeitfenster', outside_window: 'Verhalten außerhalb der Zeitfenster' })) {
    if (mode === 'custom' || ['max_import_w', 'max_current_ma', 'adjust_seconds', 'pause_seconds', 'resume_seconds'].includes(key))
      REQUIRED[`${mode}.${key}`] = label;
  }
  const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const hex = (v, n) => typeof v === 'string' && new RegExp(`^[a-f0-9]{${n}}$`).test(v);
  const keys = (v, list) => object(v) && Object.keys(v).sort().join('|') === list.slice().sort().join('|');
  function automation(v) {
    if (!keys(v, ['schema_version', 'guard', 'requested_mode', 'activation_id', 'config_revision', 'state', 'plan', 'house']) ||
        v.schema_version !== 1 || !hex(v.guard, 32) || !MODES.includes(v.requested_mode) ||
        !(v.activation_id === null || hex(v.activation_id, 32)) || !(v.config_revision === null || hex(v.config_revision, 64)) ||
        !STATES.includes(v.state) || !HTTP.includes(v.plan) || !HTTP.includes(v.house)) return null;
    return { ...v };
  }
  // Bounded, duplicate-key rejecting JSON grammar; JSON.parse alone hides duplicate members.
  function strictJSON(source) {
    if (typeof source !== 'string' || new TextEncoder().encode(source).length > 16384) throw Error('invalid');
    let i = 0;
    const ws = () => { while (/[\x20\t\r\n]/.test(source[i] || '\0')) i++; };
    function string() {
      const start = i++;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i++] === '"') return JSON.parse(source.slice(start, i));
      }
      throw Error('invalid');
    }
    function value(depth) {
      if (depth > 24) throw Error('invalid');
      ws(); const c = source[i];
      if (c === '"') return string();
      if (c === '{' || c === '[') {
        const end = c === '{' ? '}' : ']', seen = new Set(); i++; ws();
        if (source[i] === end) { i++; return; }
        for (;;) {
          ws();
          if (c === '{') {
            if (source[i] !== '"') throw Error('invalid');
            const k = string(); if (seen.has(k)) throw Error('invalid'); seen.add(k);
            ws(); if (source[i++] !== ':') throw Error('invalid');
          }
          value(depth + 1); ws();
          if (source[i] === end) { i++; return; }
          if (source[i++] !== ',') throw Error('invalid');
        }
      }
      const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(i));
      if (!match || (match[0] !== 'null' && !['true', 'false'].includes(match[0]) && !Number.isFinite(Number(match[0])))) throw Error('invalid');
      i += match[0].length;
    }
    value(0); ws(); if (i !== source.length) throw Error('invalid');
    return JSON.parse(source);
  }
  function modeResponse(v) {
    if (!object(v) || v.schema_version !== 1 || !['ok', 'invalid', 'conflict', 'forbidden', 'disabled', 'unavailable', 'busy'].includes(v.status) ||
        v.automation_available !== true || v.semantics !== 'activation_requested' || !(v.csrf === null || hex(v.csrf, 64))) throw Error('invalid');
    if (v.status === 'ok' && (!(v.mode_revision === null || hex(v.mode_revision, 64)) || !hex(v.config_revision, 64) ||
        !keys(v.activation, ['mode', 'id', 'guard']) || !MODES.includes(v.activation.mode) || !hex(v.activation.id, 32) ||
        !hex(v.activation.guard, 32) || !Array.isArray(v.required) || v.required.length)) throw Error('invalid');
    if (v.reason === 'missing_configuration' && (!Array.isArray(v.required) || !v.required.length ||
        v.required.length > 20 || !v.required.every(k => Object.hasOwn(REQUIRED, k)))) throw Error('invalid');
    return v;
  }
  function controlResponse(v) {
    const r = v?.inspection;
    if (!object(v) || v.status !== 'ok' || v.command_sent !== false || v.command !== null ||
        !(v.csrf === null || typeof v.csrf === 'string' && v.csrf.length <= 1024) ||
        !object(r) || r.schema_version !== 1 || r.status !== 'ok' || r.operation !== 'inspect' ||
        r.read_only !== true || r.reason !== 'inspection_complete' && r.reason !== 'read_only_inspection' ||
        !hex(r.id, 32) || !hex(r.session, 32) || !hex(r.lease, 32) || r.fresh_for_seconds !== 8 ||
        r.minimum_ma !== 6000 || r.software_max_ma !== 32000 || r.write !== null || r.preparation !== null ||
        !['hardware_max_ma', 'installation_max_ma', 'effective_max_ma', 'firmware_raw'].every(k =>
          r[k] === null || Number.isSafeInteger(r[k]) && r[k] >= 0 && r[k] <= 4294967295)) throw Error('invalid');
    return automation(r.automation);
  }
  async function readBody(response) {
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '') ||
        Number(response.headers.get('content-length') || 0) > 16384) throw Error('invalid');
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '', size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 16384) throw Error('invalid');
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode(); return strictJSON(text);
    } finally { await reader.cancel().catch(() => {}); }
  }
  function mount(win, doc, fetcher) {
    const root = doc.getElementById('wallbox-control'), status = doc.getElementById('automation-status');
    if (!root || !status) return null;
    const radios = MODES.map(m => doc.getElementById(`control-mode-${m}`));
    if (radios.some(r => !r)) return null;
    const navigation = [...root.querySelectorAll('input[name="charging-mode"]')].filter(r => radios.includes(r));
    if (navigation.length !== 3) return null;
    let observed = null, desired = null, message = '', uncertain = false, busy = false, active = null, generation = 0;
    let pendingFrom; // At most two exact pre-POST observations, never random-ID ordering.
    let suspended = doc.hidden, clock = Date.now(), monotonic = win.performance.now();
    const emit = (name, detail) => win.dispatchEvent(new win.CustomEvent(name, { detail }));
    const awaitingDesired = () => !!(observed && desired && desired.activation.guard === observed.guard &&
      pendingFrom !== undefined && pendingFrom.includes(observed.activation_id) && observed.activation_id !== desired.activation.id);
    const effective = () => !observed ? 'manual' : awaitingDesired() ? desired.activation.mode :
      observed.state === 'manual_override' ? 'manual' : observed.requested_mode;
    function render() {
      const mode = effective(), supported = !!observed && !['disabled', 'invalid_base'].includes(observed.plan);
      radios.forEach((r, index) => { r.checked = mode === MODES[index]; r.disabled = !!active || busy || suspended || (!supported && MODES[index] !== 'manual'); });
      let feedback = message;
      if (!feedback) {
        if (!observed) feedback = 'Manuell – Automatik benötigt einen aktualisierten Reader.';
        else if (!supported) feedback = 'Reglerquelle nicht eingerichtet – Reader-Konfiguration prüfen.';
        else if (awaitingDesired()) feedback = `${observed.state === 'frozen' ? STATE.frozen + ' · ' : ''}${LABEL[mode]} angefordert – Readerbestätigung ausstehend.`;
        else if (['manual_override', 'awaiting_activation', 'frozen'].includes(observed.state)) feedback = STATE[observed.state];
        else feedback = STATE[observed.state];
      }
      if (status.textContent !== feedback) status.textContent = feedback;
      if (status.hidden !== !feedback) status.hidden = !feedback;
      emit('evse:automation-mode', { mode, supported, pending: !!active });
    }
    function cancel() {
      generation++;
      if (active?.posted) { uncertain = true; message = 'Aktivierungsausgang unbekannt – nicht automatisch wiederholt. Erneute Wahl nur bewusst.'; }
      else if (active) message = 'Auswahl abgebrochen – keine Aktivierung gesendet.';
      active?.controller.abort(); active = null; render();
    }
    async function request(path, timeout, options = {}) {
      const task = active;
      let timer;
      try {
        return await Promise.race([
          (async () => {
            const response = await fetcher(path, { credentials: 'same-origin', cache: 'no-store', signal: task.controller.signal, ...options });
            return { response, body: await readBody(response) };
          })(),
          new Promise((_, reject) => { timer = win.setTimeout(() => { task.controller.abort(); reject(Error('timeout')); }, timeout); })
        ]);
      } finally { win.clearTimeout(timer); }
    }
    function check(token) {
      if (token !== generation || !active || active.controller.signal.aborted || suspended) throw Error('cancelled');
      const now = Date.now(), mono = win.performance.now();
      if (now < clock || Math.abs((now - clock) - (mono - monotonic)) > 2000) {
        const posted = active.posted;
        cancel(); clock = now; monotonic = mono;
        if (!posted) message = 'Zeitfehler – Auswahl verworfen. Bitte erneut bewusst wählen.';
        render(); throw Error('clock');
      }
      clock = now; monotonic = mono;
    }
    async function run(mode = null) {
      if (active || busy || suspended || (mode && !MODES.includes(mode))) return;
      if (mode && !observed) { message = 'Kein frischer Automatik-Guard verfügbar – Reader prüfen.'; render(); return; }
      const token = ++generation;
      const focus = radios.includes(doc.activeElement) ? doc.activeElement : null;
      active = { controller: new win.AbortController(), posted: false, guard: null };
      if (mode) { uncertain = false; message = 'Moduswahl wird geprüft …'; }
      render();
      try {
        let guard, baseline;
        if (mode) {
          const control = await request('/api/wallbox-control', 12000); check(token);
          if (!control.response.ok) throw Error('control');
          const a = controlResponse(control.body); if (!a) { observed = null; throw Error('legacy'); }
          observed = a; guard = a.guard; baseline = a.activation_id; active.guard = guard;
        }
        const get = await request('/api/charging-mode', 4000); check(token);
        const draft = modeResponse(get.body);
        if (!get.response.ok || draft.status !== 'ok' || !draft.csrf) throw Error('get');
        if (!mode) {
          if (!desired || desired.activation.id !== draft.activation.id || desired.activation.guard !== draft.activation.guard) pendingFrom = undefined;
          desired = draft; if (!uncertain) message = ''; return;
        }
        active.posted = true;
        const post = await request('/api/charging-mode', 5000, { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': draft.csrf },
          body: JSON.stringify({ mode, revision: draft.mode_revision, config_revision: draft.config_revision, guard }) });
        check(token);
        const result = modeResponse(post.body);
        if (!post.response.ok || result.status !== 'ok') {
          if ([400, 403, 409].includes(post.response.status)) {
            active.posted = false;
            message = post.response.status === 409 ? 'Konflikt – Konfiguration prüfen und bewusst erneut wählen.' :
              post.response.status === 403 ? 'Moduswahl nicht erlaubt – Seite und Zugriff prüfen.' :
              result.reason === 'missing_configuration' ? `In Settings ergänzen: ${result.required.map(k => REQUIRED[k]).join(', ')}.` : 'Moduswahl abgelehnt – Settings prüfen.';
            return;
          }
          throw Error('post');
        }
        if (result.activation.mode !== mode || result.activation.guard !== guard || result.config_revision !== draft.config_revision ||
            result.activation.id === draft.activation.id || !hex(result.mode_revision, 64)) throw Error('mismatch');
        desired = result; pendingFrom = [baseline, draft.activation.id]; active.posted = false; message = '';
      } catch (_) {
        if (token === generation) {
          if (active?.posted) { uncertain = true; message = 'Aktivierungsausgang unbekannt – nicht automatisch wiederholt. Erneute Wahl nur bewusst.'; }
          else if (mode) message = 'Keine Aktivierung gesendet – Verbindung und Reader prüfen.';
          else if (!uncertain) message = 'Modusstatus nicht verfügbar – keine Aktivierung gesendet.';
        }
      } finally {
        if (token === generation) {
          const posted = !!mode; active = null; render();
          if (focus && !focus.disabled && !doc.hidden && doc.activeElement === doc.body) focus.focus();
          if (posted) emit('evse:refresh-control', {});
        }
      }
    }
    // Radio arrows synthesize click in browsers. Prevent native arrow selection and
    // invoke exactly the same explicit operation once; repeated clicks also activate.
    radios.forEach((radio, index) => {
      radio.addEventListener('click', () => { if (!radio.disabled) void run(MODES[index]); render(); });
      radio.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        if (event.repeat || active || busy || suspended) return;
        const step = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1;
        for (let n = 1; n <= 3; n++) {
          const next = (navigation.indexOf(radio) + step * n + 3) % 3, target = navigation[next];
          if (!target.disabled) { target.focus(); void run(MODES[radios.indexOf(target)]); break; }
        }
      });
    });
    win.addEventListener('evse:automation-observation', event => {
      const next = automation(event.detail?.automation);
      if (active?.guard && (!next || next.guard !== active.guard)) cancel();
      observed = next;
      if (!next || !desired || next.guard !== desired.activation.guard || next.activation_id === desired.activation.id ||
          pendingFrom !== undefined && !pendingFrom.includes(next.activation_id)) pendingFrom = undefined;
      if (!uncertain && !active) message = '';
      render();
    });
    win.addEventListener('evse:wallbox-busy', event => {
      busy = event.detail?.busy === true;
      if (busy && active) cancel();
      render();
    });
    doc.addEventListener('visibilitychange', () => { suspended = doc.hidden; cancel(); if (!suspended) void run(); });
    win.addEventListener('pagehide', () => { suspended = true; cancel(); });
    win.addEventListener('pageshow', () => { suspended = doc.hidden; if (!suspended) void run(); });
    render(); if (!suspended) void run();
    return { refresh: () => run() };
  }
  const api = { MODES, STATES, HTTP, REQUIRED, automation, strictJSON, modeResponse, controlResponse, readBody, mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined' && typeof document !== 'undefined') mount(window, document, window.fetch.bind(window));
}());
