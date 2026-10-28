(function () {
  'use strict';
  const TIMEOUT_MS = 3000;
  const labels = { disabled: 'Nicht eingerichtet', waiting: 'Warten', live: 'Live', stale: 'Veraltet',
    offline: 'Offline', read_error: 'Lesefehler', clock_error: 'Zeitfehler' };
  const reasons = { disabled: 'Der Hauszähler ist nicht eingerichtet.', waiting: 'Neue Hauszählerwerte werden angefordert.',
    live: 'Aktuelle Netzaustauschleistung.', stale: 'Der letzte Abruf ist veraltet.', offline: 'Der Hauszähler ist nicht erreichbar.',
    read_error: 'Die Hauszählerwerte konnten nicht gelesen werden.', clock_error: 'Die Zeitangaben sind nicht verlässlich.' };
  const keys = ['schema_version', 'read_only', 'status', 'reason', 'power_w', 'fetched_at', 'age_seconds', 'fresh_for_seconds'];
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const number = (value, digits) => new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: digits, maximumFractionDigits: digits
  }).format(value);
  function utc(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19) ? ms : null;
  }
  function createViewState(clock = () => ({ wall: Date.now(), mono: performance.now() })) {
    let generation = 0, request = null, anchor = null, envelope = null, budget = 0, status = 'waiting', observed = null;
    const elapsed = (start, end) => end.wall < start.wall || end.mono < start.mono ? Infinity
      : Math.max(end.wall - start.wall, end.mono - start.mono);
    function clear(next) { status = next; anchor = null; envelope = null; budget = 0; }
    function reset(next = 'waiting') { generation++; request = null; clear(next); }
    function observe(now) {
      if (observed && (now.wall < observed.wall || now.mono < observed.mono)) reset('clock_error');
      observed = now;
    }
    function snapshot() {
      const now = clock();
      observe(now);
      if (request && elapsed(request.started, now) >= TIMEOUT_MS) reset('read_error');
      const delta = anchor ? elapsed(anchor, now) : 0;
      if (anchor && !Number.isFinite(delta)) reset('clock_error');
      const remaining = anchor ? Math.max(0, budget - delta) : 0;
      if (status === 'live' && remaining <= 0) status = 'stale';
      return { status, envelope, remaining, power_w: status === 'live' ? envelope.power_w : null,
        age_seconds: envelope && envelope.age_seconds !== null ? envelope.age_seconds + delta / 1000 : null };
    }
    return {
      begin() { const now = clock(); observe(now); const token = ++generation; request = { token, started: now }; return token; },
      receive(token, data) {
        snapshot();
        if (!request || request.token !== token) return false;
        const now = clock(); observe(now);
        if (!request || request.token !== token) return false;
        const rtt = elapsed(request.started, now);
        request = null;
        const timestamp = data ? utc(data.fetched_at) : null;
        const valid = data && typeof data === 'object' && !Array.isArray(data)
          && Object.keys(data).length === keys.length && keys.every(key => Object.hasOwn(data, key))
          && data.schema_version === 1 && data.read_only === true && Object.hasOwn(labels, data.status)
          && typeof data.reason === 'string' && data.reason.length <= 1024
          && (data.fetched_at === null || timestamp !== null)
          && (data.age_seconds === null || finite(data.age_seconds) && data.age_seconds >= 0)
          && (data.fetched_at === null) === (data.age_seconds === null)
          && finite(data.fresh_for_seconds)
          && (data.status === 'live'
            ? finite(data.power_w) && timestamp !== null && data.age_seconds !== null
              && data.fresh_for_seconds > 0 && data.age_seconds + data.fresh_for_seconds >= 3 - 1e-6
              && data.age_seconds + data.fresh_for_seconds <= 120 + 1e-6
            : data.power_w === null && data.fresh_for_seconds === 0);
        if (!valid) { clear('read_error'); return false; }
        if (!Number.isFinite(rtt) || timestamp !== null && timestamp > now.wall + 5000) { clear('clock_error'); return false; }
        envelope = { ...data }; status = data.status; anchor = now;
        // Subtract both the entire round trip and timestamp-derived age: neither
        // slow responses nor an inconsistent server budget may extend freshness.
        const age = timestamp === null ? null : Math.max(data.age_seconds + rtt / 1000, (now.wall - timestamp) / 1000);
        envelope.age_seconds = age;
        budget = data.status === 'live' ? Math.max(0, Math.min(data.fresh_for_seconds * 1000 - rtt,
          (data.age_seconds + data.fresh_for_seconds - age) * 1000)) : 0;
        return snapshot().status === 'live';
      },
      fail(token) { if (request && request.token === token) reset('read_error'); },
      reset, snapshot
    };
  }
  function present(view) {
    const power = view.power_w, live = view.status === 'live' && finite(power);
    const fetched = view.envelope && utc(view.envelope.fetched_at);
    return { 'grid-power': live ? `${power > 0 ? '+' : ''}${number(Object.is(power, -0) ? 0 : power / 1000, 2)} kW` : '—',
      'grid-direction': live ? power > 0 ? 'Netzbezug' : power < 0 ? 'Einspeisung' : 'Ausgeglichen' : 'Unbekannt',
      'grid-status': labels[view.status] || labels.read_error, 'grid-reason': reasons[view.status] || reasons.read_error,
      'grid-fetched': fetched !== null && fetched !== undefined ? new Intl.DateTimeFormat('de-DE', {
        dateStyle: 'short', timeStyle: 'medium' }).format(new Date(fetched)) : '—',
      'grid-age': finite(view.age_seconds) ? `${number(view.age_seconds, 1)} s` : '—' };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createViewState, present, TIMEOUT_MS };
  if (typeof document === 'undefined' || !document.getElementById('smartmeter')) return;
  const state = createViewState();
  let active = null, timer = null;
  function render() {
    const view = state.snapshot();
    window.OverlayHouseChart?.observe(view);
    for (const [id, value] of Object.entries(present(view))) {
      const element = document.getElementById(id);
      if (element && element.textContent !== value) element.textContent = value;
    }
    const badge = document.getElementById('grid-status');
    if (badge) badge.dataset.tone = view.status === 'live' ? 'good'
      : ['disabled', 'waiting'].includes(view.status) ? 'muted' : 'warning';
  }
  async function poll() {
    if (active || document.hidden) return;
    clearTimeout(timer);
    const controller = new AbortController(), token = state.begin(), started = performance.now();
    active = controller;
    const timeout = setTimeout(() => { state.fail(token); controller.abort(); render(); }, TIMEOUT_MS);
    try {
      const response = await fetch('/api/smartmeter', { method: 'GET', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('HTTP');
      state.receive(token, await response.json());
    } catch (_) { state.fail(token); }
    finally {
      clearTimeout(timeout); active = null; render();
      if (!document.hidden) timer = setTimeout(poll, Math.max(0, 1000 - (performance.now() - started)));
    }
  }
  function resume() {
    clearTimeout(timer); state.reset();
    if (active) active.abort();
    render();
    if (!document.hidden) poll();
  }
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('pageshow', resume);
  window.addEventListener('pagehide', () => {
    clearTimeout(timer); state.reset();
    if (active) active.abort();
    render();
  });
  setInterval(render, 250);
  render(); poll();
})();
