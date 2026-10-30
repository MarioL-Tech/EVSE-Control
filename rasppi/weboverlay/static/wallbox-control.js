(function () {
  'use strict';
  const ENDPOINT = '/api/wallbox-control';
  const GET_TIMEOUT_MS = 12000, POST_TIMEOUT_MS = 15000, REFRESH_MS = 15000;
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const nullableInteger = value => value === null || integer(value);
  const ampFormat = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 3 });
  const amp = value => integer(value) ? `${ampFormat.format(value / 1000)} A` : 'Unbekannt';
  function bounds(inspection) {
    if (!inspection || !integer(inspection.hardware_max_ma) || inspection.hardware_max_ma < 6000 ||
        !integer(inspection.installation_max_ma) || inspection.installation_max_ma < 6000 || inspection.installation_max_ma > 32000 ||
        inspection.minimum_ma !== 6000 || inspection.software_max_ma !== 32000) return null;
    const maximum = Math.min(inspection.hardware_max_ma, inspection.installation_max_ma, 32000);
    if (inspection.effective_max_ma !== maximum) return null;
    return { min: 6, max: Math.floor(maximum / 1000), effective_ma: maximum };
  }
  function draftAmps(value, limits) {
    return limits && Number.isInteger(value) && value >= limits.min && value <= limits.max ? value : null;
  }
  function draftBounds(inspection) {
    const approved = bounds(inspection);
    if (approved) return { min: approved.min, max: approved.max };
    const hardware = inspection?.hardware_max_ma;
    // Local editing range only, NEVER permission to publish. The command path
    // still requires bounds() with a valid explicit installation maximum.
    return { min: 6, max: Math.floor(integer(hardware) && hardware >= 6000 && hardware <= 32000 ? hardware / 1000 : 32) };
  }
  function limitReason(inspection) {
    if (!inspection) return 'Stromgrenzen noch nicht geprüft.';
    if (inspection.installation_max_ma === null) return 'Installationsmaximum fehlt.';
    if (!integer(inspection.installation_max_ma) || inspection.installation_max_ma < 6000 || inspection.installation_max_ma > 32000)
      return 'Installationsmaximum ungültig.';
    if (inspection.hardware_max_ma === null) return 'Wallboxmaximum unbekannt.';
    if (!integer(inspection.hardware_max_ma) || inspection.hardware_max_ma < 6000 || inspection.hardware_max_ma > 32000)
      return 'Wallboxmaximum ungültig.';
    return bounds(inspection) ? '' : 'Stromgrenzen nicht bestätigt.';
  }
  function commandBody(operation, draft, limits) {
    if (operation === 'stop') return { operation, current_ma: 0 };
    if (!['start', 'set_current'].includes(operation) || draftAmps(draft, limits) === null) return null;
    return { operation, current_ma: draft * 1000 };
  }
  function parseResponse(body) {
    if (!body || !['ok', 'unavailable', 'outcome_unknown', 'invalid_request', 'invalid', 'forbidden', 'rejected', 'disabled', 'busy'].includes(body.status) ||
        !(body.csrf === null || (typeof body.csrf === 'string' && body.csrf.length > 0 && body.csrf.length <= 1024)) ||
        typeof body.command_sent !== 'boolean' || !Object.hasOwn(body, 'inspection') || !Object.hasOwn(body, 'command')) throw new Error('invalid_response');
    for (const item of [body.inspection, body.command]) {
      if (item === null) continue;
      if (!item || item.schema_version !== 1 || typeof item.status !== 'string' ||
          !['hardware_max_ma', 'installation_max_ma', 'effective_max_ma', 'firmware_raw'].every(key => nullableInteger(item[key]))) throw new Error('invalid_result');
      for (const step of [item.write, item.preparation]) {
        if (step === null) continue;
        if (!step || typeof step.status !== 'string' || typeof step.attempted !== 'boolean' || typeof step.acknowledged !== 'boolean') throw new Error('invalid_step');
      }
    }
    return body;
  }
  function stepText(step) {
    if (!step) return 'Nicht gesendet';
    if (step.status === 'acknowledged' && step.acknowledged === true) return 'Protokoll-ACK erhalten (keine Ladebestätigung)';
    if (step.status === 'outcome_unknown' || (step.attempted && !step.acknowledged && step.status !== 'rejected_by_device')) return 'Ausgang unbekannt – nicht automatisch wiederholt';
    if (step.status === 'rejected_by_device') return 'Vom Gerät abgelehnt';
    return step.attempted ? 'Keine bestätigte Ausführung' : 'Nicht gesendet / technisch abgelehnt';
  }
  function resultText(body) {
    if (body.status === 'outcome_unknown') return 'Ausgang unbekannt – nicht automatisch wiederholt. Livewerte prüfen; Browserabbruch ist kein Hardware-Storno.';
    if (!body.command_sent) return 'Kein Schreibauftrag versendet. Verbindung und technische Voraussetzungen prüfen.';
    const c = body.command;
    if (!c) return 'Auftrag versendet, Ergebnis unbekannt – nicht automatisch wiederholt.';
    const prep = c.operation === 'start' ? `Stromvorbereitung: ${stepText(c.preparation)}. ` : '';
    return `${prep}${c.operation === 'start' ? 'Start' : c.operation === 'stop' ? 'Stop' : 'Stromvorgabe'}: ${stepText(c.write)}.`;
  }
  const api = { bounds, draftBounds, limitReason, draftAmps, commandBody, parseResponse, stepText, resultText, GET_TIMEOUT_MS, POST_TIMEOUT_MS, REFRESH_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;
  const root = document.getElementById('wallbox-control');
  if (!root) return;
  const get = id => document.getElementById(`control-${id}`);
  const text = (id, value) => {
    const el = get(id);
    if (el && el.textContent !== value) el.textContent = value;
    if (el && id === 'result') el.hidden = !value;
  };
  const disabled = (id, value) => { const el = get(id); if (el.disabled !== value) el.disabled = value; };
  let inspection = null, csrf = null, ready = false, draft = null, busy = false;
  let mode = 'manual'; // UI selection only; no controller handover or persistence.
  let activeGet = null, activePost = null, timer = null, generation = 0, suspended = document.hidden;
  let lastActual = undefined;
  function render() {
    const limits = bounds(inspection), usable = ready && !!csrf && !busy && !document.hidden && !suspended;
    const editing = draftBounds(inspection);
    const range = get('current');
    if (draftAmps(draft, editing) === null) draft = editing.min;
    if (range.max !== String(editing.max)) range.max = String(editing.max);
    if (range.value !== String(draft)) range.value = String(draft);
    const fill = `${editing.max > editing.min ? (draft - editing.min) / (editing.max - editing.min) * 100 : 0}%`;
    if (range.style.getPropertyValue('--control-fill') !== fill) range.style.setProperty('--control-fill', fill);
    disabled('current', busy || document.hidden || suspended);
    disabled('apply', !usable || !limits || mode !== 'manual');
    disabled('start', !usable || !limits || mode !== 'manual');
    for (const id of ['pv', 'manual', 'custom']) {
      const radio = get(`mode-${id}`);
      radio.disabled = busy || document.hidden || suspended;
      radio.checked = mode === id;
    }
    // A configured installation maximum is intentionally NOT a Stop condition.
    disabled('stop', !usable);
    text('draft', limits ? `${draft} A` : `${draft} A · Entwurf`);
    text('hardware-max', amp(inspection?.hardware_max_ma));
    text('installation-max', amp(inspection?.installation_max_ma));
    text('effective-max', amp(inspection?.effective_max_ma));
    text('firmware', integer(inspection?.firmware_raw) ? String(inspection.firmware_raw) : 'Unbekannt');
    const blocked = busy ? 'Auftrag läuft.' : document.hidden || suspended ? 'Bedienung pausiert.' :
      mode !== 'manual' ? `${mode === 'pv' ? 'PV-Regelung' : 'Benutzerdefiniert'}: Automatik noch nicht verfügbar.` :
      !ready || !csrf ? 'Keine geprüfte Bedienverbindung.' : limits ? '' : limitReason(inspection);
    text('hint', blocked || (limits?.max === 6 ? 'Nur 6 A zulässig (1-A-Schritte).' : `6–${limits.max} A`));
    for (const id of ['apply', 'start']) {
      const button = get(id);
      if (button.title !== blocked) button.title = blocked;
    }
  }
  function accept(body) {
    inspection = body.inspection;
    csrf = body.csrf;
    ready = body.status === 'ok' && inspection?.status === 'ok';
    text('status', ready ? 'Verbindung geprüft.' : 'Bedienverbindung nicht verfügbar.');
  }
  async function inspect() {
    if (document.hidden || suspended || busy || activeGet) return;
    clearTimeout(timer);
    const controller = new AbortController(), token = generation;
    activeGet = controller;
    const timeout = setTimeout(() => controller.abort(), GET_TIMEOUT_MS);
    try {
      const response = await fetch(ENDPOINT, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const body = parseResponse(await response.json());
      if (token !== generation || controller.signal.aborted) return;
      if (!response.ok) throw new Error('http');
      accept(body);
    } catch (_) {
      if (token === generation) { ready = false; csrf = null; text('status', 'Bedienprüfung fehlgeschlagen. Letztes Auftragsergebnis bleibt erhalten.'); }
    } finally {
      clearTimeout(timeout);
      if (activeGet === controller) activeGet = null;
      render();
      if (token === generation && !document.hidden && !suspended && !busy) timer = setTimeout(inspect, REFRESH_MS);
    }
  }
  async function send(operation) {
    if (busy || document.hidden || suspended || !ready || !csrf) return;
    if (mode !== 'manual' && operation !== 'stop') return;
    const payload = commandBody(operation, draft, bounds(inspection));
    if (!payload) return;
    busy = true;
    clearTimeout(timer);
    generation++;
    if (activeGet) activeGet.abort();
    const controller = new AbortController();
    activePost = controller;
    const token = generation;
    text('requested', operation === 'stop' ? 'Stop' : `${operation === 'start' ? 'Start mit' : 'Stromvorgabe'} ${amp(payload.current_ma)}`);
    text('ack', 'Antwort ausstehend'); text('preparation', 'Antwort ausstehend'); text('write', 'Antwort ausstehend');
    text('result', 'Auftrag wird angefragt. Ein Browserabbruch storniert keinen Hardwareauftrag.');
    render();
    const timeout = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    try {
      const response = await fetch(ENDPOINT, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(payload), signal: controller.signal });
      const body = parseResponse(await response.json());
      if (token !== generation || controller.signal.aborted) return;
      accept(body);
      text('result', resultText(body));
      text('preparation', stepText(body.command?.preparation));
      text('write', stepText(body.command?.write));
      text('ack', body.status === 'outcome_unknown' || (body.command_sent && !body.command) ? 'Ausgang unbekannt – nicht automatisch wiederholt' :
        body.command_sent ? stepText(body.command?.write) : 'Kein Auftrag versendet');
    } catch (_) {
      if (token === generation) {
        text('result', 'Ausgang unbekannt – nicht automatisch wiederholt. Livewerte prüfen; Browserabbruch ist kein Hardware-Storno.');
        text('ack', 'Ausgang unbekannt – nicht automatisch wiederholt');
        text('preparation', 'Unbekannt'); text('write', 'Unbekannt');
      }
    } finally {
      clearTimeout(timeout);
      if (activePost === controller) activePost = null;
      busy = false; ready = false; csrf = null;
      render();
      if (!document.hidden && !suspended) void inspect();
    }
  }
  get('current').addEventListener('input', event => {
    const value = Number(event.target.value);
    if (draftAmps(value, draftBounds(inspection)) !== null) { draft = value; render(); }
  });
  for (const id of ['pv', 'manual', 'custom']) get(`mode-${id}`).addEventListener('change', event => {
    if (!event.target.checked || busy || document.hidden || suspended) return;
    mode = id; render();
  });
  for (const [id, op] of [['apply', 'set_current'], ['start', 'start'], ['stop', 'stop']]) get(id).addEventListener('click', () => { void send(op); });
  window.addEventListener('evse:state', event => {
    const v = event.detail?.values;
    if (v === lastActual) return;
    lastActual = v;
    text('actual', v ? `Limit ${amp(Math.round(v.current_limit_a * 1000))} · L1/L2/L3 ${v.current_a.map(a => amp(Math.round(a * 1000))).join(' / ')} · Lädt: ${v.charging === true ? 'Ja' : v.charging === false ? 'Nein' : 'Unbekannt'}` : 'Unbekannt – keine frischen Livewerte');
  });
  function reset(hiding = false) {
    suspended = hiding || document.hidden;
    generation++; clearTimeout(timer); ready = false; csrf = null;
    text('status', suspended ? 'Bedienprüfung pausiert.' : 'Bedienverbindung wird neu geprüft.');
    if (activeGet) { activeGet.abort(); activeGet = null; }
    if (activePost) {
      activePost.abort();
      text('result', 'Ausgang unbekannt – nicht automatisch wiederholt. Browserabbruch ist kein Hardware-Storno.');
      text('ack', 'Ausgang unbekannt – nicht automatisch wiederholt');
      text('preparation', 'Unbekannt'); text('write', 'Unbekannt');
    }
    render();
    if (!document.hidden && !suspended && !busy) void inspect();
  }
  document.addEventListener('visibilitychange', () => reset(document.hidden));
  window.addEventListener('pagehide', () => reset(true));
  window.addEventListener('pageshow', event => { if (event.persisted) reset(); });
  render(); void inspect();
})();
