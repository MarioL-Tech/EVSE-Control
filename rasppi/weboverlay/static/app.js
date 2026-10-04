(function () {
  'use strict';
  const TIMEOUT_MS = 3000;
  const statuses = {
    live: 'Live', waiting: 'Warten auf Daten', offline: 'Offline',
    stale: 'Daten veraltet', clock_error: 'Zeitfehler', invalid: 'Ungültige Daten',
    read_error: 'Lesefehler'
  };
  const number = (value, digits = 1) => new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: digits, maximumFractionDigits: digits
  }).format(value);
  const flag = value => value === true ? 'Ja' : value === false ? 'Nein' : 'Unbekannt';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)) : '—';
  function validValues(v) {
    return v && ['error_code', 'socket_lock_state', 'charging_state_raw', 'charging_state'].every(k => Number.isInteger(v[k]))
      && ['current_limit_a', 'active_power_w', 'session_energy_wh'].every(k => finite(v[k]))
      && ['current_a', 'voltage_v'].every(k => Array.isArray(v[k]) && v[k].length === 3 && v[k].every(finite))
      && ['plugged_in', 'charging'].every(k => v[k] === null || typeof v[k] === 'boolean')
      && typeof v.below_commanded_current === 'boolean';
  }
  function createViewState(clock = () => ({ mono: performance.now(), wall: Date.now() })) {
    let generation = 0, request = null, envelope = null, anchor = null, budget = 0;
    let status = 'waiting', reason = 'Verbindung zur Anzeige wird hergestellt.';
    const elapsed = (start, end) => end.wall < start.wall || end.mono < start.mono
      ? Infinity : Math.max(end.mono - start.mono, end.wall - start.wall);
    function clear(nextStatus, nextReason) {
      envelope = null; anchor = null; budget = 0; status = nextStatus; reason = nextReason;
    }
    function reset(nextStatus = 'waiting', nextReason = 'Neue Messwerte werden angefordert.') {
      generation++; request = null; clear(nextStatus, nextReason);
    }
    function snapshot() {
      const now = clock();
      if (request && elapsed(request.started, now) >= TIMEOUT_MS) {
        reset('read_error', 'Zeitüberschreitung beim Abrufen der Messwerte.');
      }
      let remaining = anchor ? Math.max(0, budget - elapsed(anchor, now)) : 0;
      if (status === 'live' && remaining <= 0) {
        clear('stale', 'Das Frischebudget ist abgelaufen. Neue Messwerte werden erwartet.');
        remaining = 0;
      }
      return { status, reason, envelope, values: status === 'live' ? envelope.values : null, remaining };
    }
    return {
      begin() { const token = ++generation; request = { token, started: clock() }; return token; },
      receive(token, data) {
        snapshot();
        if (!request || request.token !== token) return false;
        const now = clock(), roundtrip = elapsed(request.started, now);
        request = null;
        if (!data || data.schema_version !== 1 || data.read_only !== true
          || !Object.hasOwn(statuses, data.status) || !finite(data.fresh_for_seconds) || data.fresh_for_seconds < 0
          || (data.status === 'live' && !validValues(data.values))) {
          clear('invalid', 'Die empfangenen Daten sind ungültig.'); return false;
        }
        envelope = data; status = data.status;
        reason = typeof data.reason === 'string' ? data.reason : '';
        budget = data.status === 'live' ? Math.max(0, data.fresh_for_seconds * 1000 - roundtrip) : 0;
        anchor = now;
        snapshot();
        return status === 'live';
      },
      fail(token, message = 'Die Messwerte konnten nicht abgerufen werden.') {
        if (request && request.token === token) reset('read_error', message);
      },
      reset, snapshot
    };
  }
  function present(view) {
    const v = view.values, e = view.envelope;
    const result = {
      status: statuses[view.status] || statuses.invalid, reason: view.reason,
      broker: flag(e ? e.broker_connected : null),
      availability: e && e.availability === 'online' ? 'Online' : e && e.availability === 'offline' ? 'Offline' : 'Unbekannt',
      freshness: v ? `${number(view.remaining / 1000, 1)} s` : '—',
      plugged: flag(v ? v.plugged_in : null), charging: flag(v ? v.charging : null),
      below: flag(v ? v.below_commanded_current : null),
      power: v ? `${number(v.active_power_w / 1000, 2)} kW` : '—',
      energy: v ? `${number(v.session_energy_wh / 1000, 2)} kWh` : '—',
      limit: v ? `${number(v.current_limit_a)} A` : '—',
      'charging-state': v ? String(v.charging_state) : '—',
      'charging-raw': v ? String(v.charging_state_raw) : '—', lock: v ? String(v.socket_lock_state) : '—',
      'wallbox-error': v ? v.error_code === 0 ? 'Kein Wallbox-Fehler · Code 0' : `Wallbox-Fehler · Code ${v.error_code}` : '—',
      timestamp: e ? date(e.timestamp) : '—', 'last-success': e ? date(e.last_success_at) : '—',
      age: v && finite(e.age_seconds) ? `${number(e.age_seconds + Math.max(0, e.fresh_for_seconds - view.remaining / 1000))} s` : '—',
      'read-error': e && typeof e.error === 'string' ? e.error : '—'
    };
    for (let i = 0; i < 3; i++) {
      result[`current-${i}`] = v ? `${number(v.current_a[i])} A` : '—';
      result[`voltage-${i}`] = v ? `${number(v.voltage_v[i])} V` : '—';
    }
    return result;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createViewState, present, flag, TIMEOUT_MS };
  if (typeof document === 'undefined') return;
  const state = createViewState();
  const charts = window.OverlayCharts.mount();
  let active = null, pollTimer = null;
  function render() {
    const view = state.snapshot();
    for (const [id, value] of Object.entries(present(view))) {
      const element = document.getElementById(id);
      // Avoid repeating unchanged live-region text on every countdown tick.
      if (element && element.textContent !== value) element.textContent = value;
    }
    document.getElementById('status').dataset.tone = view.status === 'live' ? 'good' : view.status === 'waiting' ? 'muted' : 'warning';
    const error = document.getElementById('wallbox-error');
    if (error) error.dataset.tone = view.values && view.values.error_code !== 0 ? 'warning' : 'muted';
    const warning = document.getElementById('wallbox-warning');
    const message = view.values && view.values.error_code !== 0 ? `Wallbox meldet Fehlercode ${view.values.error_code}.` : '';
    warning.hidden = !message;
    if (warning.textContent !== message) warning.textContent = message;
    charts.update(view);
  }
  async function poll() {
    if (active || document.hidden) return;
    clearTimeout(pollTimer);
    const controller = new AbortController(), token = state.begin(), started = performance.now();
    active = controller;
    const timeout = setTimeout(() => {
      state.fail(token, 'Zeitüberschreitung beim Abrufen der Messwerte.');
      controller.abort(); render();
    }, TIMEOUT_MS);
    try {
      const response = await fetch('/api/state', { method: 'GET', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('HTTP');
      const data = await response.json();
      state.receive(token, data);
    } catch (_) {
      state.fail(token);
    } finally {
      clearTimeout(timeout); active = null; render();
      if (!document.hidden) pollTimer = setTimeout(poll, Math.max(0, 1000 - (performance.now() - started)));
    }
  }
  function resetView() {
    clearTimeout(pollTimer);
    state.reset('waiting', 'Ansicht gewechselt. Neue Messwerte werden angefordert.');
    if (active) active.abort();
    render();
    if (!document.hidden) poll();
  }
  document.addEventListener('visibilitychange', resetView);
  window.addEventListener('pageshow', event => {
    if (event.persisted) { charts.restore(); resetView(); }
  });
  // This clock is independent of HTTP; a hung request cannot preserve live values.
  setInterval(render, 100);
  render(); poll();
})();
