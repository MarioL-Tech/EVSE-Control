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
    let points = [], lastStamp = null, lastClock = null, broken = true, revision = 0;
    function gap() { if (!broken) { broken = true; revision++; } }
    return {
      gap,
      clear() { points = []; lastStamp = null; lastClock = null; broken = true; revision++; },
      observe(view, now = Date.now()) {
        if (lastClock !== null && now < lastClock) {
          points = []; lastStamp = null; broken = true; revision++;
        } else if (lastClock !== null && now - lastClock > MAX_GAP_MS) gap();
        lastClock = now;
        const retained = points.filter(p => p.t >= now - RETENTION_MS);
        if (retained.length !== points.length) { points = retained; revision++; }
        const t = Date.parse(view.envelope?.timestamp);
        if (view.status !== 'live' || !view.values || !Number.isFinite(t) ||
            t > now + 5000 || t < now - RETENTION_MS) { gap(); return; }
        if (lastStamp !== null && t < lastStamp) { gap(); return; }
        const values = readings(view.values);
        if (t === lastStamp) {
          // Repeated HTTP polls don't create new measurements. At subsecond
          // reader intervals, schema-v1 timestamps only distinguish seconds:
          // keep the last values for that second, never fill an outage with them.
          if (!broken && points.length && JSON.stringify(points.at(-1).values) !== JSON.stringify(values)) {
            const last = points.at(-1);
            for (const m of METRICS) {
              if (last.values[m.id] === null || values[m.id] === null) last.seriesBreak[m.id] = true;
            }
            last.values = values; revision++;
          }
          return;
        }
        points.push({ t, values, seriesBreak: Object.fromEntries(METRICS.map(m => [m.id, values[m.id] === null])),
          breakBefore: broken || (lastStamp !== null && t - lastStamp > MAX_GAP_MS) });
        if (points.length > MAX_POINTS) points.splice(0, points.length - MAX_POINTS);
        lastStamp = t; broken = false; revision++;
      },
      get revision() { return revision; },
      get size() { return points.length; },
      window(now, minutes) {
        const duration = [1, 5, 15].includes(minutes) ? minutes * 60000 : 300000;
        return points.filter(p => p.t >= now - duration && p.t <= now).map(p =>
          ({ ...p, values: { ...p.values }, seriesBreak: { ...p.seriesBreak } }));
      }
    };
  }
  function buildPlot(points, group, selected, start, end) {
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
    const x = t => 62 + (t - start) / Math.max(1, end - start) * 420;
    const y = v => 180 - (v - lo) / (hi - lo) * 155;
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
      return { metric: m, path, last, markers };
    });
    return { lo, hi, paths, metrics, count: points.length };
  }
  const api = { METRICS, GROUPS, RETENTION_MS, MAX_POINTS, MAX_GAP_MS, STORAGE_KEY,
    defaults, normalizePreferences, loadPreferences, savePreferences, readings, createHistory, buildPlot };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OverlayCharts = api;

  api.mount = function () {
    const history = createHistory();
    let storage;
    try { storage = root.localStorage; } catch (_) { storage = null; }
    let prefs = loadPreferences(storage), lastDraw = 0, lastRevision = -1;
    const controls = document.getElementById('metric-options'), figures = new Map();
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
    for (const m of METRICS) {
      const label = node('label', null), checkbox = node('input', null, { type: 'checkbox', id: `show-${m.id}` });
      checkbox.checked = prefs.selected[m.id];
      checkbox.addEventListener('change', () => { prefs.selected[m.id] = checkbox.checked; apply(); });
      label.append(checkbox, node('span', m.label)); controls.append(label);
    }
    const chartGrid = document.getElementById('chart-grid');
    for (const g of chartGrid ? GROUPS : []) {
      const figure = node('figure', null, { class: 'card chart-card', id: `chart-${g.id}` });
      figure.append(node('figcaption', `${g.label} · ${g.unit}`));
      const svg = node('svg', null, { viewBox: '0 0 500 225', role: 'img', 'aria-label': g.label }, true);
      const legend = node('ul', null, { class: 'chart-legend', 'aria-label': 'Angezeigte Kurven' });
      const description = node('p', 'Warte auf erste Messwerte.', { class: 'chart-description' });
      const grid = ['power', 'current', 'voltage', 'energy'].includes(g.id) ? chartGrid : document.getElementById('chart-diagnostics-grid');
      figure.append(svg, legend, description); (grid || chartGrid).append(figure);
      figures.set(g.id, { figure, svg, legend, description });
    }
    const range = document.getElementById('chart-range');
    if (range) {
      range.value = String(prefs.minutes);
      range.addEventListener('change', () => { prefs.minutes = Number(range.value); apply(); });
    }
    document.getElementById('reset-display').addEventListener('click', () => {
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
      document.getElementById('display-empty').hidden = Object.values(prefs.selected).some(Boolean);
      document.getElementById('display-storage').textContent = savePreferences(storage, prefs)
        ? 'Auswahl wird in diesem Browser gespeichert.' : 'Auswahl gilt nur hier; Browserspeicher nicht verfügbar.';
      lastRevision = -1; draw(Date.now());
    }
    function draw(now) {
      const points = history.window(now, prefs.minutes), start = now - prefs.minutes * 60000;
      for (const g of GROUPS.filter(g => figures.has(g.id))) {
        const { figure, svg, legend, description } = figures.get(g.id);
        const plot = buildPlot(points, g, prefs.selected, start, now);
        figure.hidden = plot.metrics.length === 0;
        if (figure.hidden) continue;
        svg.replaceChildren(); legend.replaceChildren();
        svg.append(node('title', `${g.label}: historischer Verlauf, ${plot.count} Messzeitpunkte`, {}, true));
        for (const [value, yPos] of [[plot.lo, 180], [plot.hi, 25]]) {
          svg.append(node('line', null, { x1: 62, x2: 482, y1: yPos, y2: yPos, class: 'chart-gridline' }, true));
          svg.append(node('text', g.boolean ? (value === 0 ? 'Nein' : 'Ja') : fmt.format(value),
            { x: 55, y: yPos + 4, 'text-anchor': 'end', class: 'chart-axis' }, true));
        }
        for (const [t, px, anchor] of [[start, 62, 'start'], [now, 482, 'end']])
          svg.append(node('text', timeFmt.format(t), { x: px, y: 211, 'text-anchor': anchor, class: 'chart-axis' }, true));
        plot.paths.forEach(series => {
          const color = series.metric.index !== null ? series.metric.index : series.metric.id === 'limit' ? 3
            : METRICS.filter(m => m.group === g.id).findIndex(m => m.id === series.metric.id);
          const css = `series-${color % 4}`;
          svg.append(node('path', null, { d: series.path, class: `chart-line ${css}`, 'data-series': series.metric.id }, true));
          for (const marker of series.markers) {
            const dot = node('circle', null, { cx: marker.x, cy: marker.y, r: 3, class: `chart-dot ${css}`,
              'data-series-marker': series.metric.id }, true);
            const valueText = g.boolean ? (marker.value ? 'Ja' : 'Nein') : `${valueFmt.format(marker.value)} ${g.unit}`;
            dot.append(node('title', `${series.metric.label}: ${valueText} · ${timeFmt.format(marker.t)}`, {}, true));
            svg.append(dot);
          }
          legend.append(node('li', series.metric.label, { class: css, 'data-legend': series.metric.id }));
        });
        description.textContent = plot.count ? `${plot.count} Messzeitpunkte im Fenster · Lücken bleiben unverbunden.`
          : 'Noch keine Messwerte in diesem Zeitfenster. Verlauf beginnt mit Seitenöffnung.';
      }
      lastDraw = now; lastRevision = history.revision;
    }
    apply();
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
        history.clear(); apply();
      },
      update(view, now = Date.now()) {
        if (figures.size) history.observe(view, now);
        if (history.revision !== lastRevision || now - lastDraw >= 1000 || now < lastDraw) draw(now);
      }
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
