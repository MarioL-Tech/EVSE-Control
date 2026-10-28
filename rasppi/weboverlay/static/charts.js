(function (root) {
  'use strict';
  const RETENTION_MS = 15 * 60 * 1000, MAX_POINTS = 1200, MAX_GAP_MS = 10000;
  const STORAGE_KEY = 'evse-display-v1';
  const metric = (id, label, field, group, index = null, divisor = 1, boolean = false) =>
    ({ id, label, field, group, index, divisor, boolean });
  const METRICS = [
    metric('power', 'Wirkleistung', 'active_power_w', 'power', null, 1000),
    metric('energy', 'Sessionenergie', 'session_energy_wh', 'energy', null, 1000),
    metric('limit', 'Wallbox-Stromlimit', 'current_limit_a', 'current'),
    ...[0, 1, 2].map(i => metric(`current-${i}`, `Strom L${i + 1}`, 'current_a', 'current', i)),
    ...[0, 1, 2].map(i => metric(`voltage-${i}`, `Spannung L${i + 1}`, 'voltage_v', 'voltage', i)),
    metric('plugged', 'Fahrzeug angesteckt', 'plugged_in', 'flags', null, 1, true),
    metric('charging', 'Lädt tatsächlich', 'charging', 'flags', null, 1, true),
    metric('below', 'Unter Sollstrom', 'below_commanded_current', 'flags', null, 1, true),
    metric('wallbox-error', 'Wallbox-Fehlercode', 'error_code', 'error'),
    metric('charging-state', 'Ladezustand', 'charging_state', 'state'),
    metric('charging-raw', 'Ladezustand (Rohwert)', 'charging_state_raw', 'raw'),
    metric('lock', 'Buchsenverriegelung (Rohwert)', 'socket_lock_state', 'lock')
  ];
  const GROUPS = [
    { id: 'power', label: 'Wirkleistung', unit: 'kW', zero: true },
    { id: 'current', label: 'Phasenströme und Wallbox-Limit', unit: 'A', zero: true },
    { id: 'voltage', label: 'Phasenspannungen', unit: 'V' },
    { id: 'energy', label: 'Sessionenergie', unit: 'kWh', zero: true },
    { id: 'flags', label: 'Anschluss und Ladestatus', unit: 'Nein / Ja', step: true, boolean: true },
    { id: 'error', label: 'Wallbox-Fehlercode', unit: 'Code', step: true, zero: true },
    { id: 'state', label: 'Ladezustand', unit: 'Code', step: true, zero: true },
    { id: 'raw', label: 'Ladezustand (Rohwert)', unit: 'Rohwert', step: true, zero: true },
    { id: 'lock', label: 'Buchsenverriegelung (Rohwert)', unit: 'Rohwert', step: true, zero: true }
  ];
  const defaults = () => ({ minutes: 5, selected: Object.fromEntries(METRICS.map(m => [m.id, true])) });
  function normalizePreferences(value) {
    const result = defaults();
    if (!value || typeof value !== 'object') return result;
    if ([1, 5, 15].includes(value.minutes)) result.minutes = value.minutes;
    for (const m of METRICS) {
      if (value.selected && Object.hasOwn(value.selected, m.id) && typeof value.selected[m.id] === 'boolean')
        result.selected[m.id] = value.selected[m.id];
    }
    return result;
  }
  function loadPreferences(storage) {
    try { return normalizePreferences(JSON.parse(storage.getItem(STORAGE_KEY))); }
    catch (_) { return defaults(); }
  }
  function savePreferences(storage, prefs) {
    try { storage.setItem(STORAGE_KEY, JSON.stringify(normalizePreferences(prefs))); return true; }
    catch (_) { return false; }
  }
  function readings(values) {
    return Object.fromEntries(METRICS.map(m => {
      const raw = m.index === null ? values[m.field] : values[m.field]?.[m.index];
      const value = m.boolean ? (typeof raw === 'boolean' ? Number(raw) : null) : raw;
      return [m.id, typeof value === 'number' && Number.isFinite(value) && value >= 0 &&
        value <= Number.MAX_SAFE_INTEGER ? value / m.divisor : null];
    }));
  }
  function createHistory() {
    let points = [], edges = [], barriers = [], lastStamp = null, lastClock = null, broken = true, revision = 0;
    let hardGap = false;
    const overlaps = (a, b, c, d) => a < d && b > c;
    function edge(from, to, blocked = false) {
      if (from === null || to <= from) return;
      const list = blocked ? barriers : edges;
      if (!list.some(e => e[0] === from && e[1] === to)) list.push([from, to]);
    }
    function prune(now) {
      const retained = points.filter(p => p.t >= now - RETENTION_MS).slice(-MAX_POINTS);
      if (retained.length !== points.length) { points = retained; revision++; }
      edges = edges.filter(e => e[1] >= now - RETENTION_MS).slice(-MAX_POINTS * 2);
      barriers = barriers.filter(e => e[1] >= now - RETENTION_MS).slice(-MAX_POINTS * 2);
    }
    function gap(hard = true) {
      hardGap ||= hard;
      if (!broken) { broken = true; revision++; }
    }
    function clear() { points = []; edges = []; barriers = []; lastStamp = null; lastClock = null; broken = true; hardGap = false; revision++; }
    return {
      gap, clear,
      importHistory(batch, now = Date.now()) {
        const incoming = validateHistory(batch, now);
        if (!incoming) return false;
        if (batch.status !== 'ok') return true;
        // Validation finishes before touching any retained state or live anchors.
        const signature = () => JSON.stringify({ points: points.map(({ t, values, source, seriesBreak }) =>
          ({ t, values, source, seriesBreak })), edges, barriers });
        const before = signature(), oldRevision = revision;
        for (let i = 1; i < incoming.length; i++) {
          const a = incoming[i - 1], b = incoming[i];
          edge(a.t, b.t, b.breakBefore || a.error || b.error);
        }
        for (const row of incoming) {
          const old = points.find(p => p.t === row.t);
          if (!old) {
            if (row.t < now - RETENTION_MS || (points.length === MAX_POINTS && row.t < points[0].t)) continue;
            if (points.length === MAX_POINTS) points.shift();
            points.push(row); points.sort((a, b) => a.t - b.t); continue;
          }
          for (const m of METRICS) old.seriesBreak[m.id] ||= row.seriesBreak[m.id];
          if (old.source === 'sql' && compareReceipt(old, row) < 0) {
            old.values = row.values; old.received = row.received; old.id = row.id;
          }
        }
        points.sort((a, b) => a.t - b.t);
        prune(now);
        revision = oldRevision + (signature() !== before ? 1 : 0);
        return true;
      },
      observe(view, now = Date.now()) {
        if (lastClock !== null && now < lastClock) {
          clear();
        } else if (lastClock !== null && now - lastClock > MAX_GAP_MS) gap(false);
        lastClock = now;
        prune(now);
        const t = utc(view.envelope?.timestamp);
        if (view.status !== 'live' || !view.values || !Number.isFinite(t) ||
            t > now + 5000 || t < now - RETENTION_MS) {
          const transportOnly = ['waiting', 'stale'].includes(view.status) ||
            (view.status === 'read_error' && view.envelope == null);
          gap(!transportOnly); return;
        }
        if (lastStamp !== null && t < lastStamp) { gap(); return; }
        const values = readings(view.values);
        if (t === lastStamp) {
          // Repeated HTTP polls don't create new measurements. At subsecond
          // reader intervals, schema-v1 timestamps only distinguish seconds:
          // keep the last values for that second, never fill an outage with them.
          const last = points.find(p => p.t === lastStamp && p.source === 'live');
          if (!broken && last && JSON.stringify(last.values) !== JSON.stringify(values)) {
            for (const m of METRICS) {
              if (last.values[m.id] === null || values[m.id] === null) last.seriesBreak[m.id] = true;
            }
            last.values = values; revision++;
          }
          return;
        }
        const old = points.find(p => p.t === t);
        if (hardGap) edge(lastStamp, t, true);
        else if (!broken && lastStamp !== null && t - lastStamp <= MAX_GAP_MS) edge(lastStamp, t);
        if (old) points.splice(points.indexOf(old), 1);
        if (points.length < MAX_POINTS || t >= points[0].t) {
          if (points.length === MAX_POINTS) points.shift();
          points.push({ t, values, source: 'live', seriesBreak: Object.fromEntries(METRICS.map(m =>
            [m.id, values[m.id] === null || !!old?.seriesBreak[m.id]])),
            breakBefore: broken || (lastStamp !== null && t - lastStamp > MAX_GAP_MS) });
        }
        points.sort((a, b) => a.t - b.t); prune(now);
        lastStamp = t; broken = false; hardGap = false; revision++;
      },
      get revision() { return revision; },
      get size() { return points.length; },
      window(now, minutes) {
        const duration = [1, 5, 15].includes(minutes) ? minutes * 60000 : 300000;
        return points.filter(p => p.t >= now - duration && p.t <= now).map((p, i, list) =>
          ({ ...p, breakBefore: i === 0 || (() => {
            const a = list[i - 1].t, b = p.t;
            return b - a > MAX_GAP_MS || !edges.some(e => e[0] <= a && e[1] >= b) ||
              barriers.some(e => overlaps(a, b, e[0], e[1])) ||
              (hardGap && lastStamp !== null && b > lastStamp);
          })(),
            values: { ...p.values }, seriesBreak: { ...p.seriesBreak } }));
      }
    };
  }
  function compareReceipt(a, b) {
    return (a.received < b.received ? -1 : a.received > b.received ? 1 : 0) ||
      a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  function utc(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)) return NaN;
    const t = Date.parse(value);
    if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 19) !== value.slice(0, 19)) return NaN;
    return t + Number((value.match(/\.(\d+)/)?.[1] || '').slice(3).padEnd(3, '0')) / 1000;
  }
  function validateHistory(batch, now) {
    const object = v => v && typeof v === 'object' && !Array.isArray(v);
    const keys = (v, names) => object(v) && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
    if (!Number.isFinite(now) || !keys(batch, ['schema_version', 'read_only', 'status', 'reason', 'generated_at', 'minutes', 'range', 'complete', 'samples']) ||
        batch.schema_version !== 1 || batch.read_only !== true || !['ok', 'disabled', 'unavailable'].includes(batch.status) ||
        typeof batch.reason !== 'string' || batch.reason.length > 1024 || batch.minutes !== 15 || typeof batch.complete !== 'boolean' ||
        !Array.isArray(batch.samples) || batch.samples.length > MAX_POINTS || !keys(batch.range, ['from', 'to'])) return null;
    const generated = utc(batch.generated_at), from = utc(batch.range.from), to = utc(batch.range.to);
    if (![generated, from, to].every(Number.isFinite) || generated > now + 5000 || generated < now - RETENTION_MS ||
        to > now + 5000 || to < now - RETENTION_MS || to - from !== RETENTION_MS || from < now - RETENTION_MS - 5000 ||
        (batch.status !== 'ok' && batch.samples.length)) return null;
    const result = [];
    for (const s of batch.samples) {
      if (!keys(s, ['id', 'timestamp', 'received_at', 'status', 'values', 'break_before']) ||
          typeof s.id !== 'string' || !/^(?:0|[1-9]\d{0,19})$/.test(s.id) ||
          (s.id.length === 20 && s.id > '18446744073709551615') || typeof s.break_before !== 'boolean' ||
          !['ok', 'error'].includes(s.status)) return null;
      const t = utc(s.timestamp), received = utc(s.received_at);
      if (![t, received].every(Number.isFinite) || t < from || t > to || t > now + 5000 || received > now + 5000) return null;
      const v = s.values;
      if (s.status === 'error') { if (v !== null) return null; }
      else {
        const fields = [...new Set(METRICS.map(m => m.field))];
        if (!keys(v, fields)) return null;
        for (const m of METRICS) {
          const value = v[m.field];
          const valid = n => n === null || (m.boolean ? typeof n === 'boolean' :
            typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER &&
              (!['error', 'state', 'raw', 'lock'].includes(m.group) || (Number.isInteger(n) && n <= 4294967295)));
          if (m.index !== null ? !Array.isArray(value) || value.length !== 3 || !value.every(valid) : !valid(value)) return null;
        }
      }
      const values = readings(v || {});
      const receiptOrder = s.received_at.slice(0, 19) + '.' +
        (s.received_at.match(/\.(\d+)/)?.[1] || '').padEnd(6, '0') + 'Z';
      const row = { t, received: receiptOrder, id: s.id, source: 'sql', values,
        breakBefore: s.break_before || s.status === 'error', error: s.status === 'error',
        seriesBreak: Object.fromEntries(METRICS.map(m => [m.id, values[m.id] === null])) };
      const previous = result.at(-1);
      if (previous && (t < previous.t || (t === previous.t && compareReceipt(previous, row) > 0))) return null;
      if (!previous && !s.break_before) return null;
      if (previous && t === previous.t) {
        row.breakBefore ||= previous.breakBefore;
        for (const m of METRICS) row.seriesBreak[m.id] ||= previous.seriesBreak[m.id];
        result[result.length - 1] = row;
      } else result.push(row);
    }
    return result;
  }
  function buildPlot(points, group, selected, start, end, geometry = { width: 500, height: 225, left: 62, right: 482, top: 25, bottom: 180 }) {
    const metrics = METRICS.filter(m => m.group === group.id && selected[m.id]);
    const numbers = points.flatMap(p => metrics.map(m => p.values[m.id])).filter(v => v !== null);
    let lo = group.zero || group.boolean ? 0 : numbers.length ? Math.min(...numbers) : 0;
    let hi = group.boolean ? 1 : numbers.length ? Math.max(...numbers) : 1;
    if (hi <= lo) { lo = Math.max(0, lo - 1); hi += 1; }
    if (!group.boolean) {
      const padding = (hi - lo) * 0.08;
      if (!group.zero) lo = Math.max(0, lo - padding);
      hi += padding;
    }
    const x = t => geometry.left + (t - start) / Math.max(1, end - start) * (geometry.right - geometry.left);
    const y = v => geometry.bottom - (v - lo) / (hi - lo) * (geometry.bottom - geometry.top);
    const paths = metrics.map(m => {
      let path = '', previous = null, last = null, segmentLast = null, segmentLength = 0;
      const markers = [];
      for (const p of points) {
        const value = p.values[m.id];
        if (value === null) {
          if (segmentLength === 1) markers.push(segmentLast);
          previous = null; segmentLength = 0; continue;
        }
        const px = x(p.t).toFixed(2), py = y(value).toFixed(2);
        const connect = previous && !p.breakBefore && !p.seriesBreak?.[m.id] &&
          !previous.seriesBreak?.[m.id] && p.t - previous.t <= MAX_GAP_MS;
        if (!connect) {
          if (segmentLength === 1) markers.push(segmentLast);
          segmentLength = 1;
        } else segmentLength++;
        path += !connect ? `M${px},${py}` : group.step ? `H${px}V${py}` : `L${px},${py}`;
        previous = p; last = { x: px, y: py, value, t: p.t }; segmentLast = last;
      }
      if (segmentLength === 1) markers.push(segmentLast);
      if (last && !markers.includes(last)) markers.push(last);
      // Thin isolated-point markers only after segmentation; never heal a gap
      // to make a flat series prettier. Pixel spacing prevents marker pills.
      const sparse = [];
      for (let i = markers.length - 1; i >= 0; i--) {
        const p = markers[i];
        if (!sparse.some(q => Math.abs(Number(q.x) - Number(p.x)) < 7 && Math.abs(Number(q.y) - Number(p.y)) < 5)) sparse.push(p);
      }
      return { metric: m, path, last, markers: sparse.reverse() };
    });
    return { lo, hi, paths, metrics, count: points.length, geometry };
  }
  const api = { METRICS, GROUPS, RETENTION_MS, MAX_POINTS, MAX_GAP_MS, STORAGE_KEY,
    defaults, normalizePreferences, loadPreferences, savePreferences, readings, createHistory, buildPlot };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OverlayCharts = api;

  api.mount = function () {
    const chartGrid = document.getElementById('chart-grid');
    // Diagram preferences never hide values on the overview, which has no
    // selection controls and must remain fully readable.
    if (!chartGrid) return { update() {}, restore() {} };
    const history = createHistory();
    let storage;
    try { storage = root.localStorage; } catch (_) { storage = null; }
    let prefs = loadPreferences(storage), lastDraw = 0, lastRevision = -1, lastArchiveDraw = null;
    const controls = new Map(), figures = new Map();
    const svgNS = 'http://www.w3.org/2000/svg';
    const fmt = new Intl.NumberFormat('de-DE', { maximumSignificantDigits: 4, notation: 'compact' });
    const valueFmt = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 3 });
    const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const node = (tag, text, attributes = {}, svg = false) => {
      const element = svg ? document.createElementNS(svgNS, tag) : document.createElement(tag);
      if (text !== null) element.textContent = text;
      for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
      return element;
    };
    const colorClass = (m, g) => `series-${(m.index !== null ? m.index : m.id === 'limit' ? 3
      : METRICS.filter(item => item.group === g.id).findIndex(item => item.id === m.id)) % 4}`;
    for (const g of chartGrid ? GROUPS : []) {
      const figure = node('figure', null, { class: 'card chart-card', id: `chart-${g.id}` });
      figure.append(node('figcaption', `${g.label} · ${g.unit}`));
      const svg = node('svg', null, { viewBox: '0 0 500 225', role: 'img', 'aria-label': g.label }, true);
      const legend = node('ul', null, { class: 'chart-legend chart-options', 'aria-label': `Kurven auswählen · ${g.label}` });
      for (const m of METRICS.filter(item => item.group === g.id)) {
        const li = node('li', null), label = node('label', null, { class: colorClass(m, g) });
        const checkbox = node('input', null, { type: 'checkbox', id: `show-${m.id}` });
        checkbox.checked = prefs.selected[m.id]; controls.set(m.id, checkbox);
        checkbox.addEventListener('change', () => { prefs.selected[m.id] = checkbox.checked; apply(); });
        label.append(checkbox, node('span', m.label)); li.append(label); legend.append(li);
      }
      const description = node('p', 'Warte auf erste Messwerte.', { class: 'chart-description' });
      const grid = ['power', 'current', 'voltage', 'energy'].includes(g.id) ? chartGrid : document.getElementById('chart-diagnostics-grid');
      figure.append(legend, svg, description); (grid || chartGrid).append(figure);
      figures.set(g.id, { figure, svg, legend, description });
    }
    const source = document.getElementById('history-source'), detail = document.getElementById('history-detail');
    const browserNote = { source: source?.textContent, detail: detail?.textContent };
    const archive = root.OverlayCalendar?.createArchiveStore();
    let calendar = null;
    const loader = figures.size && root.OverlayHistory ? root.OverlayHistory.createHistoryLoader({
      importHistory: (batch, now) => history.importHistory(batch, now),
      importArchive: (batch, now, selection) => {
        if (!archive?.importHistory(batch, now, selection)) return false;
        calendar?.loaded(batch);
        // Archive completion is its own rendering event, independent of MQTT
        // ticks (including a paused clock or currently unavailable live API).
        draw(Date.now()); return true;
      },
      onReset: () => { history.clear(); archive?.clear(); calendar?.reset(); },
      onState: state => {
        if (!source || !detail) return;
        source.dataset.historyStatus = state.status;
        if (calendar?.selection) {
          const snapshot = archive?.snapshot();
          source.textContent = snapshot ? `Kalenderarchiv · ${snapshot.buckets.reduce((n, b) => n + b.samples, 0)} Messwerte` : 'Kalenderarchiv';
          detail.textContent = `${state.status === 'ok' ? state.complete ? 'Archiv geladen.' : 'Archiv enthält Lücken oder ist noch nicht vollständig verdichtet.'
            : state.status === 'browser' ? 'Zeitraum wird geladen.' : snapshot ? 'Archiv derzeit nicht verfügbar; geladene Daten bleiben erhalten.' : 'Archiv derzeit nicht verfügbar.'} Historisch, nicht live. Stichprobenmittel / Min–Max; Sessionenergie ist der letzte Sessionzähler, kein Zeitraumverbrauch.`;
        } else if (!state.loaded && ['browser', 'disabled'].includes(state.status)) {
          source.textContent = browserNote.source; detail.textContent = browserNote.detail;
        } else {
          source.textContent = state.loaded ? 'Wallbox-Archiv' : 'Live-Verlauf';
          detail.textContent = state.loaded
            ? `Historisch, nicht live. ${state.status === 'ok'
              ? state.complete ? 'Archiv geladen.' : 'Archiv unvollständig.'
              : 'Archiv derzeit nicht verfügbar; geladene Daten bleiben erhalten.'} Ausfälle bleiben Lücken.`
            : 'Archiv derzeit nicht verfügbar. Verlauf nur im Browser-RAM seit Seitenöffnung; historisch, nicht live. Ausfälle bleiben Lücken.';
        }
        lastRevision = -1;
      }
    }) : null;
    if (loader) {
      loader.setVisible(!document.hidden);
      document.addEventListener('visibilitychange', () => loader.setVisible(!document.hidden));
      root.addEventListener('pagehide', () => loader.setVisible(false));
      root.addEventListener('pageshow', () => loader.setVisible(!document.hidden));
    }
    const range = document.getElementById('chart-range');
    if (loader && archive) calendar = root.OverlayCalendar.mount({ document, loader, archive, storage,
      onChange: () => { lastRevision = -1; draw(Date.now()); } });
    if (range) {
      range.value = String(prefs.minutes);
      range.addEventListener('change', () => { prefs.minutes = Number(range.value); loader?.invalidate(); apply(); });
    }
    document.getElementById('reset-display')?.addEventListener('click', () => {
      prefs = defaults(); if (range) range.value = String(prefs.minutes);
      for (const m of METRICS) document.getElementById(`show-${m.id}`).checked = true;
      apply();
    });
    function apply() {
      for (const element of document.querySelectorAll('[data-metric]')) element.hidden = !prefs.selected[element.dataset.metric];
      for (const element of document.querySelectorAll('[data-metrics]'))
        element.hidden = !element.dataset.metrics.split(' ').some(id => prefs.selected[id]);
      for (const type of ['current', 'voltage']) {
        const hidden = ![0, 1, 2].some(i => prefs.selected[`${type}-${i}`]);
        for (const element of document.querySelectorAll(`.phase-${type}`)) element.hidden = hidden;
      }
      const empty = document.getElementById('display-empty');
      if (empty) empty.hidden = Object.values(prefs.selected).some(Boolean);
      savePreferences(storage, prefs);
      lastRevision = -1; draw(Date.now());
    }
    function draw(now) {
      const archiveMode = !!calendar?.selection;
      const archiveKey = archiveMode ? `${archive?.revision}:${JSON.stringify(calendar.selection)}:${JSON.stringify(prefs.selected)}` : null;
      if (archiveMode && archiveKey === lastArchiveDraw) { lastDraw = now; lastRevision = history.revision; return; }
      lastArchiveDraw = archiveKey;
      const archived = archiveMode ? archive?.snapshot() : null;
      const points = archiveMode ? [] : history.window(now, prefs.minutes);
      const start = archived ? Date.parse(archived.range.from) : now - prefs.minutes * 60000;
      const end = archived ? Date.parse(archived.range.to) : now;
      for (const g of GROUPS.filter(g => figures.has(g.id))) {
        const { figure, svg, legend, description } = figures.get(g.id);
        const width = Math.max(240, Math.round(figure.getBoundingClientRect().width - 40));
        const height = Math.max(230, Math.min(280, Math.round(width * .5)));
        const geometry = { width, height, left: 54, right: width - 18, top: 20, bottom: height - 42 };
        const plot = archived ? root.OverlayCalendar.buildSummaryPlot(archived, g, prefs.selected, api, geometry)
          : buildPlot(points, g, prefs.selected, start, end, geometry);
        // Keep the card/checkboxes reachable even if every series is off.
        svg.hidden = plot.metrics.length === 0;
        svg.toggleAttribute('hidden', plot.metrics.length === 0);
        figure.hidden = false;
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.replaceChildren();
        svg.append(node('title', `${g.label}: historischer Verlauf, ${plot.count} Messzeitpunkte`, {}, true));
        for (let tick = 0; tick <= 4; tick++) {
          const value = plot.lo + (plot.hi - plot.lo) * tick / 4;
          if (g.boolean && tick !== 0 && tick !== 4) continue;
          const yPos = geometry.bottom - (geometry.bottom - geometry.top) * tick / 4;
          svg.append(node('line', null, { x1: geometry.left, x2: geometry.right, y1: yPos, y2: yPos, class: 'chart-gridline' }, true));
          svg.append(node('text', g.boolean ? (value === 0 ? 'Nein' : 'Ja') : fmt.format(value),
            { x: geometry.left - 9, y: yPos + 4, 'text-anchor': 'end', class: 'chart-axis' }, true));
        }
        for (const [t, px, anchor] of [[start, geometry.left, 'start'], [end, geometry.right, 'end']])
          svg.append(node('text', archived ? root.OverlayCalendar.axisLabel(t, archived.selection.period, archived.range.timezone, true) : timeFmt.format(t),
            { x: px, y: height - 12, 'text-anchor': anchor, class: 'chart-axis' }, true));
        plot.paths.forEach(series => {
          const css = colorClass(series.metric, g);
          svg.append(node('path', null, { d: series.path, class: `chart-line ${css}`, 'data-series': series.metric.id }, true));
          for (const glyph of series.glyphs || []) {
            const path = node('path', null, { d: glyph.path, class: `summary-glyph summary-${glyph.kind || 'range'} ${css}${glyph.gap ? ' summary-gap' : ''}`,
              'data-summary-series': series.metric.id }, true);
            path.append(node('title', glyph.label, {}, true)); svg.append(path);
          }
          for (const marker of series.markers) {
            const dot = node('circle', null, { cx: marker.x, cy: marker.y, r: 3, class: `chart-dot ${css}`,
              'data-series-marker': series.metric.id }, true);
            const valueText = g.boolean ? (marker.value ? 'Ja' : 'Nein') : `${valueFmt.format(marker.value)} ${g.unit}`;
            dot.append(node('title', `${series.metric.label}: ${valueText} · ${timeFmt.format(marker.t)}`, {}, true));
            svg.append(dot);
          }
        });
        description.textContent = !plot.metrics.length ? 'Keine Kurve ausgewählt. Oben wieder einschalten.' : archiveMode ? archived
          ? `${plot.count} Messwerte · ${archived.buckets.length} Intervalle · ${g.id === 'energy' ? 'Letzter Sessionzähler, kein Zeitraumverbrauch' : g.step ? 'Spanne / letzter Zustand; gemischt bleibt sichtbar' : 'Mittelwertmarke / Min–Max-Spanne'} · gestrichelte Spanne: Lücken / unvollständig.`
          : 'Keine Archivmesswerte geladen. Live-Anzeige bleibt unabhängig.'
          : plot.count ? `${plot.count} Messzeitpunkte im Fenster · Lücken bleiben unverbunden.`
            : 'Noch keine Messwerte in diesem Zeitfenster. Verlauf beginnt mit Seitenöffnung.';
      }
      lastDraw = now; lastRevision = history.revision;
    }
    apply();
    function resize() { lastRevision = -1; lastArchiveDraw = null; draw(Date.now()); }
    root.addEventListener('resize', resize);
    document.querySelector('.history-diagnostics')?.addEventListener('toggle', resize);
    return {
      restore() {
        // Another page may have changed the shared settings while this page
        // was frozen in the back/forward cache. Preserve session-only choices
        // if storage cannot be read, rather than resetting them silently.
        let raw;
        try { raw = storage.getItem(STORAGE_KEY); } catch (_) { /* session-only */ }
        if (raw !== undefined) {
          try { prefs = normalizePreferences(JSON.parse(raw)); } catch (_) { prefs = defaults(); }
        }
        if (range) range.value = String(prefs.minutes);
        for (const m of METRICS) document.getElementById(`show-${m.id}`).checked = prefs.selected[m.id];
        history.clear(); loader?.restore(); apply();
      },
      update(view, now = Date.now()) {
        loader?.tick();
        if (figures.size) history.observe(view, now);
        if (history.revision !== lastRevision || now - lastDraw >= 1000 || now < lastDraw) draw(now);
      }
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
