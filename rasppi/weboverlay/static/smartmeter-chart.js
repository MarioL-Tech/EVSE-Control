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
    let points = [], lastStamp = null, lastClock = null, broken = true;
    function gap() { broken = true; }
    function prune(now) { points = points.filter(p => p.t >= now - RETENTION_MS).slice(-MAX_POINTS); }
    return {
      gap,
      observe(view, now = Date.now()) {
        if (!Number.isFinite(now)) { gap(); return; }
        if (lastClock !== null && now < lastClock) { points = []; lastStamp = null; gap(); }
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
        lastStamp = t; broken = false; prune(now);
      },
      get size() { return points.length; },
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
  const api = { RETENTION_MS, MAX_POINTS, MAX_GAP_MS, timestamp, createHistory, buildPlot };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined' || root.location?.pathname !== '/diagramme') return;
  const figure = document.getElementById('chart-house'), svg = document.getElementById('house-chart-svg');
  const description = document.getElementById('house-chart-description'), checkbox = document.getElementById('show-house-power');
  if (!figure || !svg || !description || !checkbox) return;
  const history = createHistory(), range = document.getElementById('chart-range'), mode = document.getElementById('calendar-mode');
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
    const archive = mode && mode.value !== 'live', minutes = Number(range?.value || 5);
    svg.hidden = archive || !checkbox.checked;
    svg.toggleAttribute('hidden', svg.hidden);
    svg.setAttribute('display', svg.hidden ? 'none' : 'block');
    const width = Math.max(240, Math.round(svg.getBoundingClientRect().width || 500)), height = 250;
    const geometry = { width, height, left: 62, right: width - 18, top: 24, bottom: height - 38 };
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const points = history.window(now, minutes), plot = buildPlot(points, now - ([1, 5, 15].includes(minutes) ? minutes : 5) * 60000, now, geometry);
    description.textContent = archive ? 'Keine Haus-Archivdaten verfügbar. Haus-Netzleistung wird nur live im Browser gespeichert.'
      : !checkbox.checked ? 'Hauskurve ausgeblendet. Zum Anzeigen Haus-Netzleistung aktivieren.'
        : `Haus-Netzleistung · nur Browser-RAM · ${plot.count} Messpunkte · Bezug (+), Einspeisung (−). ${plot.count ? 'Unterbrechungen bleiben als Lücken sichtbar.' : 'Warten auf neue Live-Abrufe.'}`;
    svg.replaceChildren();
    if (archive || !checkbox.checked) return;
    svg.append(node('path', { d: `M${geometry.left},${geometry.top}V${geometry.bottom}H${geometry.right}M${geometry.left},${plot.zeroY}H${geometry.right}`, fill: 'none', stroke: 'currentColor', 'stroke-opacity': '.3' }));
    svg.append(node('path', { d: plot.path, class: 'chart-line series-0', 'data-house-series': '' }));
    for (const p of plot.markers) svg.append(node('circle', { cx: p.x, cy: p.y, r: '3', class: 'chart-dot series-0' }));
    const fmt = n => new Intl.NumberFormat('de-DE', { maximumSignificantDigits: 3 }).format(n);
    svg.append(node('text', { x: 2, y: geometry.top + 4, class: 'chart-axis' }, `${fmt(plot.hi)} kW`),
      node('text', { x: 2, y: geometry.bottom, class: 'chart-axis' }, fmt(plot.lo)));
    const time = t => new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(t);
    svg.append(node('text', { x: geometry.left, y: height - 10, class: 'chart-axis' }, time(now - ([1, 5, 15].includes(minutes) ? minutes : 5) * 60000)),
      node('text', { x: geometry.right, y: height - 10, 'text-anchor': 'end', class: 'chart-axis' }, time(now)));
  }
  api.observe = view => { history.observe(view); draw(); };
  root.OverlayHouseChart = api;
  for (const control of [range, mode, checkbox]) control?.addEventListener('change', () => draw());
  document.addEventListener('visibilitychange', () => { history.gap(); draw(); });
  root.addEventListener('pagehide', () => history.gap());
  root.addEventListener('pageshow', () => { history.gap(); draw(); });
  root.addEventListener('resize', () => draw());
  draw();
})(typeof window !== 'undefined' ? window : globalThis);
