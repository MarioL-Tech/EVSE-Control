(function (root) {
  'use strict';
  const RETENTION_MS = 900000, MAX_POINTS = 1200, MAX_GAP_MS = 10000;
  function timestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)) return NaN;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) return NaN;
    return ms + Number((value.match(/\.(\d+)/)?.[1] || '').slice(3).padEnd(3, '0')) / 1000;
  }
  function createHistory() {
    let points = [], lastStamp = null, lastClock = null, broken = true, revision = 0;
    function gap() { broken = true; }
    function prune(now) {
      const next = points.filter(p => p.t >= now - RETENTION_MS).slice(-MAX_POINTS);
      if (next.length !== points.length) revision++;
      points = next;
    }
    return {
      gap,
      observe(view, now = Date.now()) {
        if (!Number.isFinite(now)) { gap(); return; }
        if (lastClock !== null && now < lastClock) { points = []; lastStamp = null; revision++; gap(); }
        else if (lastClock !== null && now - lastClock > MAX_GAP_MS) gap();
        lastClock = now; prune(now);
        const t = timestamp(view?.envelope?.fetched_at), power = view?.power_w;
        if (view?.status !== 'live' || typeof power !== 'number' || !Number.isFinite(power) ||
            !Number.isFinite(t) || t > now + 5000 || t < now - RETENTION_MS ||
            !(view.remaining > 0)) { gap(); return; }
        // A repeated receipt is not a new measurement, including after an outage.
        // Keep the pending gap until a genuinely newer fetch arrives.
        if (lastStamp !== null && t <= lastStamp) { if (t < lastStamp) gap(); return; }
        points.push({ t, power_w: Object.is(power, -0) ? 0 : power,
          breakBefore: broken || lastStamp === null || t - lastStamp > MAX_GAP_MS });
        revision++;
        lastStamp = t; broken = false; prune(now);
      },
      get size() { return points.length; },
      get revision() { return revision; },
      clear() { points = []; lastStamp = null; lastClock = null; revision++; gap(); },
      window(now, minutes = 5) {
        prune(now);
        const span = ([1, 5, 15].includes(minutes) ? minutes : 5) * 60000;
        return points.filter(p => p.t >= now - span && p.t <= now).map((p, i) => ({ ...p, breakBefore: i === 0 || p.breakBefore }));
      }
    };
  }
  function buildPlot(points, start, end, geometry = { width: 500, height: 225, left: 62, right: 482, top: 25, bottom: 180 }) {
    const isValid = p => Number.isFinite(p.t) && typeof p.power_w === 'number' && Number.isFinite(p.power_w);
    const valid = points.filter(isValid);
    const values = valid.map(p => p.power_w / 1000);
    let lo = Math.min(0, ...values), hi = Math.max(0, ...values);
    if (lo === hi) { lo -= 1; hi += 1; }
    const padding = (hi - lo) * .08; lo -= padding; hi += padding;
    const x = t => geometry.left + (t - start) / Math.max(1, end - start) * (geometry.right - geometry.left);
    const y = v => geometry.bottom - (v - lo) / (hi - lo) * (geometry.bottom - geometry.top);
    let path = '', previous = null, last = null, segmentLength = 0;
    const markers = [];
    // Invalid input is a barrier too: never filter NULL into a connecting edge.
    for (const p of points) {
      if (!isValid(p)) { if (segmentLength === 1) markers.push(last); previous = null; segmentLength = 0; continue; }
      const px = x(p.t).toFixed(2), py = y(p.power_w / 1000).toFixed(2);
      const connect = previous && !p.breakBefore && p.t > previous.t && p.t - previous.t <= MAX_GAP_MS;
      if (!connect) { if (segmentLength === 1) markers.push(last); segmentLength = 1; }
      else segmentLength++;
      path += `${connect ? 'L' : 'M'}${px},${py}`;
      last = { x: px, y: py }; previous = p;
    }
    if (last && !markers.includes(last)) markers.push(last);
    return { path, markers, lo, hi, zeroY: y(0), count: valid.length };
  }
  function buildArchivePlot(batch, geometry = { width: 500, height: 225, left: 62, right: 482, top: 25, bottom: 180 }) {
    const bins = batch.buckets, start = timestamp(batch.range.from), end = timestamp(batch.range.to);
    const bounds = bins.flatMap(b => [b.metrics.power_w.min, b.metrics.power_w.max])
      .filter(v => typeof v === 'number' && Number.isFinite(v));
    const scale = buildPlot(bounds.map((v, i) => ({ t: start + i, power_w: v })), start, end, geometry);
    const x = t => geometry.left + (t - start) / (end - start) * (geometry.right - geometry.left);
    const y = v => geometry.bottom - (v / 1000 - scale.lo) / (scale.hi - scale.lo) * (geometry.bottom - geometry.top);
    const coord = (t, v) => `${x(t).toFixed(2)},${y(v).toFixed(2)}`;
    let path = '', band = '', count = 0, run = [];
    const local = point => {
      const half = Math.max(.75, Math.min(4, (x(point.to) - x(point.from)) * .35));
      const middle = x(point.mid), py = y(point.mean).toFixed(2);
      path += `M${(middle - half).toFixed(2)},${py}H${(middle + half).toFixed(2)}`;
      if (point.proven) {
        const left = (middle - half).toFixed(2), right = (middle + half).toFixed(2);
        band += `M${left},${y(point.min).toFixed(2)}H${right}V${y(point.max).toFixed(2)}H${left}Z`;
      }
    };
    const finish = () => {
      if (!run.length) return;
      if (run.length === 1) local(run[0]);
      else {
        path += `M${run.map(p => coord(p.mid, p.mean)).join('L')}`;
        band += `M${run.map(p => coord(p.mid, p.min)).join('L')}L${run.slice().reverse().map(p => coord(p.mid, p.max)).join('L')}Z`;
      }
      run = [];
    };
    for (const b of bins) {
      const m = b.metrics.power_w, a = timestamp(b.from), z = timestamp(b.to), mid = (a + z) / 2;
      const proven = b.complete && !b.has_gap && !m.nulls && !m.mixed &&
        b.coverage_seconds >= (z - a) / 1000 && m.last !== null;
      if (!m.count || m.mean === null) { finish(); continue; }
      count += m.count;
      const point = { proven, from: a, to: z, mid, mean: m.mean, min: m.min, max: m.max };
      if (!proven) { finish(); local(point); continue; }
      if (run.length && run.at(-1).to !== a) finish();
      run.push(point);
    }
    finish();
    return { ...scale, path, band, markers: [], count };
  }
  const api = { RETENTION_MS, MAX_POINTS, MAX_GAP_MS, timestamp, createHistory, buildPlot, buildArchivePlot };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined' || root.location?.pathname !== '/diagramme') return;
  const figure = document.getElementById('chart-house'), svg = document.getElementById('house-chart-svg');
  const description = document.getElementById('house-chart-description'), checkbox = document.getElementById('show-house-power');
  if (!figure || !svg || !description || !checkbox) return;
  const history = createHistory(), range = document.getElementById('chart-range'), mode = document.getElementById('calendar-mode');
  const persistence = root.OverlayHouseHistory, store = persistence?.createStore();
  let selection = root.OverlayCalendar?.currentSelection || null, selectedRange = root.OverlayCalendar?.currentRange || null;
  let lastDraw = '', pending = false, archiveQuery = null;
  const defer = typeof root.queueMicrotask === 'function' ? root.queueMicrotask.bind(root) : callback => Promise.resolve().then(callback);
  const schedule = () => {
    if (pending || document.hidden) return;
    pending = true;
    root.requestAnimationFrame(() => { pending = false; draw(); });
  };
  const loader = persistence?.createLoader({
    importHistory(batch, now) {
      const revision = store.revision, ok = store.importHistory(batch, now);
      if (ok && store.revision !== revision) schedule();
      return ok;
    },
    importArchive(batch, now, requested) {
      const revision = store.revision, previousQuery = archiveQuery;
      const ok = store.importHistory(batch, now, requested);
      if (ok && batch.status === 'ok') {
        const query = root.OverlayHistory.calendarQuery(requested), snapshot = store.archive();
        archiveQuery = query;
        // Metadata only, and only after strict HOUSE validation. Wallbox may
        // be disabled; its loader is never a prerequisite for this request.
        // Defer the event until the loader has released its current request;
        // an anchored date=now publication may synchronously select again.
        defer(() => {
          if (archiveQuery !== query || api.selectionQuery !== query || !snapshot) return;
          root.dispatchEvent(new CustomEvent('evse:calendar-range', { detail: { query,
            metadata: { range: snapshot.range, selection: snapshot.selection, navigation: snapshot.navigation }
          } }));
        });
      }
      if (ok && (store.revision !== revision || archiveQuery !== previousQuery)) schedule();
      return ok;
    },
    onReset() { history.clear(); store?.clear(); archiveQuery = null; schedule(); }
  });
  const ns = 'http://www.w3.org/2000/svg';
  function node(tag, attrs, text) {
    const el = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    if (text !== undefined) el.textContent = text;
    return el;
  }
  svg.setAttribute('viewBox', '0 0 500 225'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Haus-Netzleistung in kW: Bezug positiv, Einspeisung negativ');
  svg.setAttribute('aria-describedby', description.id);
  // Page-local preference only. Never persist measurements or alter wallbox preferences.
  checkbox.checked = true;
  function draw(now = Date.now()) {
    const archive = selection !== null || (mode && mode.value !== 'live'), minutes = Number(range?.value || 5);
    const live = history.window(now, minutes);
    const batch = archive ? store?.archive() : null;
    const matches = !!(selection && batch && root.OverlayHistory?.calendarQuery(selection) === archiveQuery &&
      batch.selection.period === selection.period && batch.range.timezone === selection.tz &&
      (!selection.date || selection.date === 'now' || batch.selection.date === selection.date) &&
      (!selection.at || (timestamp(selection.at) >= timestamp(batch.range.from) && timestamp(selection.at) < timestamp(batch.range.to))) &&
      (!selection.from || (selection.from === batch.range.from && selection.to === batch.range.to)) &&
      (!selectedRange || (timestamp(selectedRange.from) === timestamp(batch.range.from) && timestamp(selectedRange.to) === timestamp(batch.range.to))));
    const points = store ? store.points(live, now, minutes) : live;
    const width = Math.max(240, Math.round(figure.getBoundingClientRect().width - 32 || 500)), height = 250;
    const signature = JSON.stringify([archive ? null : history.revision, store?.revision, archiveQuery, minutes, selection,
      selectedRange, checkbox.checked, width, archive ? null : [points.length, points[0]?.t]]);
    if (signature === lastDraw) return;
    lastDraw = signature;
    svg.hidden = !checkbox.checked || (archive && !matches);
    svg.toggleAttribute('hidden', svg.hidden);
    svg.setAttribute('display', svg.hidden ? 'none' : 'block');
    const geometry = { width, height, left: 62, right: width - 18, top: 24, bottom: height - 38 };
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const plot = archive && matches ? buildArchivePlot(batch, geometry)
      : buildPlot(points, now - ([1, 5, 15].includes(minutes) ? minutes : 5) * 60000, now, geometry);
    description.textContent = archive && !matches ? 'Keine Haus-Archivdaten verfügbar.'
      : !checkbox.checked ? 'Kurve ausgeblendet.'
        : `${plot.count} Messpunkte · Bezug (+) / Einspeisung (−)`;
    svg.replaceChildren();
    if (svg.hidden) return;
    svg.append(node('path', { d: `M${geometry.left},${geometry.top}V${geometry.bottom}H${geometry.right}M${geometry.left},${plot.zeroY}H${geometry.right}`, fill: 'none', stroke: 'currentColor', 'stroke-opacity': '.3' }));
    if (plot.band) svg.append(node('path', { d: plot.band, class: 'series-0', fill: 'currentColor', 'fill-opacity': '.12',
      stroke: 'currentColor', 'stroke-opacity': '.25', 'data-house-band': '' }));
    svg.append(node('path', { d: plot.path, class: 'chart-line series-0', 'data-house-series': '' }));
    // One batched marker slot, including 1200 isolated observations. Never
    // allocate a circle/title pair per point or bridge gaps when decimating.
    const markerPath = plot.markers.map(p => `M${Number(p.x) - 2},${p.y}a2,2 0 1,0 4,0a2,2 0 1,0 -4,0`).join('');
    svg.append(node('path', { d: markerPath, class: 'chart-dot series-0', 'data-house-markers': '' }));
    const fmt = n => new Intl.NumberFormat('de-DE', { maximumSignificantDigits: 3 }).format(n);
    svg.append(node('text', { x: 2, y: geometry.top + 4, class: 'chart-axis' }, `${fmt(plot.hi)} kW`),
      node('text', { x: 2, y: geometry.bottom, class: 'chart-axis' }, fmt(plot.lo)));
    const time = t => archive && matches && root.OverlayCalendar?.axisLabel
      ? root.OverlayCalendar.axisLabel(t, batch.selection.period, batch.range.timezone, true)
      : new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(t);
    const first = archive && matches ? timestamp(batch.range.from) : now - ([1, 5, 15].includes(minutes) ? minutes : 5) * 60000;
    const last = archive && matches ? timestamp(batch.range.to) : now;
    svg.append(node('text', { x: geometry.left, y: height - 10, class: 'chart-axis' }, time(first)),
      node('text', { x: geometry.right, y: height - 10, 'text-anchor': 'end', class: 'chart-axis' }, time(last)));
  }
  api.observe = view => {
    const revision = history.revision;
    history.observe(view); loader?.tick();
    if (history.revision !== revision) schedule();
  };
  root.OverlayHouseChart = api;
  // Explicit user choices apply immediately; only automatic updates are
  // frame-coalesced. Do not show an old curve under a newly selected period.
  for (const control of [range, checkbox]) control?.addEventListener('change', () => draw());
  mode?.addEventListener('change', schedule);
  root.addEventListener('evse:calendar-change', event => {
    selection = event.detail?.selection || null; selectedRange = event.detail?.range || null;
    // A range update for the same query must not restart an in-flight request.
    const query = selection && root.OverlayHistory?.calendarQuery(selection);
    if (query !== api.selectionQuery || event.detail?.range === null) {
      api.selectionQuery = query;
      if (!loader?.select(selection)) loader?.suspend();
      loader?.tick();
    }
    draw();
  });
  document.addEventListener('visibilitychange', () => { history.gap(); loader?.setVisible(!document.hidden); loader?.tick(); schedule(); });
  root.addEventListener('pagehide', () => { history.gap(); loader?.setVisible(false); });
  root.addEventListener('pageshow', () => { history.gap(); loader?.restore(); loader?.setVisible(!document.hidden); loader?.tick(); schedule(); });
  root.addEventListener('online', () => { history.gap(); loader?.restore(); loader?.tick(); schedule(); });
  root.addEventListener('resize', schedule);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(schedule).observe(figure);
  api.selectionQuery = selection && root.OverlayHistory?.calendarQuery(selection);
  if (!loader?.select(selection)) loader?.suspend();
  loader?.setVisible(!document.hidden); loader?.tick();
  draw();
})(typeof window !== 'undefined' ? window : globalThis);
