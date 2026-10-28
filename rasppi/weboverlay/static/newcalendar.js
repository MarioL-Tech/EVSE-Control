(function (root) {
  'use strict';
  const KEY = 'evse-calendar-v1', ZONE = 'Europe/Vienna', MAX_BINS = 512;
  const PERIODS = ['live', 'hour', 'day', 'week', 'month', 'year', 'custom'];
  const FIELDS = ['active_power_w', 'session_energy_wh', 'current_limit_a',
    'current_l1_a', 'current_l2_a', 'current_l3_a', 'voltage_l1_v', 'voltage_l2_v', 'voltage_l3_v',
    'plugged_in', 'charging', 'below_commanded_current', 'error_code', 'charging_state', 'charging_state_raw', 'socket_lock_state'];
  const FLAGS = FIELDS.slice(9, 12), CODES = FIELDS.slice(12);
  const MEANS = [FIELDS[0], ...FIELDS.slice(3, 9)];
  const valueFormat = new Intl.NumberFormat('de-AT', { maximumSignificantDigits: 6 });
  const timeFormats = new Map();
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const keys = (v, names) => object(v) && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
  const count = n => Number.isSafeInteger(n) && n >= 0;
  function utc(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(s)) return NaN;
    const n = Date.parse(s);
    return Number.isFinite(n) && new Date(n).toISOString().slice(0, 19) === s.slice(0, 19) ? n : NaN;
  }
  function query(s) {
    const history = root.OverlayHistory || (typeof require === 'function' ? require('./history.js') : null);
    return history?.calendarQuery(s);
  }
  function validate(batch, now, requested) {
    if (!keys(batch, ['schema_version', 'read_only', 'status', 'reason', 'generated_at', 'range', 'selection',
      'navigation', 'aggregation', 'complete', 'progress', 'buckets']) || batch.schema_version !== 2 || batch.read_only !== true ||
      !['ok', 'disabled', 'unavailable'].includes(batch.status) || typeof batch.reason !== 'string' || batch.reason.length > 1024 ||
      !Number.isFinite(utc(batch.generated_at)) || utc(batch.generated_at) > now + 5000 || utc(batch.generated_at) < now - 900000 ||
      batch.aggregation !== 'sample_mean' || typeof batch.complete !== 'boolean' ||
      !keys(batch.progress, ['samples_done', 'events_done']) || Object.values(batch.progress).some(v => typeof v !== 'boolean') ||
      !keys(batch.range, ['from', 'to', 'timezone']) || !keys(batch.selection, ['period', 'date', 'timezone']) ||
      !['Europe/Vienna', 'UTC'].includes(batch.range.timezone) || batch.selection.timezone !== batch.range.timezone ||
      !PERIODS.slice(1).includes(batch.selection.period) || typeof batch.selection.date !== 'string' || batch.selection.date.length > 80 ||
      !Array.isArray(batch.buckets) || batch.buckets.length > MAX_BINS ||
      (batch.status !== 'ok' && batch.buckets.length)) return null;
    const from = utc(batch.range.from), to = utc(batch.range.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 366 * 86400000 + 3600000) return null;
    if (requested && (requested.period !== batch.selection.period || requested.tz !== batch.range.timezone ||
      (requested.date && requested.date !== 'now' && requested.date !== batch.selection.date) ||
      (requested.at && !(utc(requested.at) >= from && utc(requested.at) < to)) ||
      (requested.from && (utc(requested.from) !== from || utc(requested.to) !== to)))) return null;
    if (!(batch.selection.period === 'custom' && batch.navigation === null) &&
        !keys(batch.navigation, ['previous', 'next', 'now'])) return null;
    for (const nav of Object.values(batch.navigation || {})) {
      if (nav === null) continue;
      if (!query(nav) || nav.period !== batch.selection.period || nav.tz !== batch.range.timezone ||
          Object.keys(nav).some(k => !['period', 'at', 'date', 'tz', 'from', 'to', 'date_from', 'date_to'].includes(k))) return null;
    }
    let end = from;
    for (const bin of batch.buckets) {
      if (!keys(bin, ['from', 'to', 'samples', 'has_gap', 'complete', 'coverage_seconds', 'metrics']) ||
          !count(bin.samples) || typeof bin.has_gap !== 'boolean' || typeof bin.complete !== 'boolean' ||
          !Number.isFinite(bin.coverage_seconds) || bin.coverage_seconds < 0 || !keys(bin.metrics, FIELDS)) return null;
      const a = utc(bin.from), b = utc(bin.to);
      if (!Number.isFinite(a) || !Number.isFinite(b) || a < end || b <= a || a < from || b > to ||
          bin.coverage_seconds > (b - a) / 1000 || (bin.samples > 0 && a > now + 5000)) return null;
      end = b;
      for (const field of FIELDS) {
        const m = bin.metrics[field];
        if (!keys(m, ['count', 'nulls', 'mean', 'min', 'max', 'last', 'mixed']) || !count(m.count) || !count(m.nulls) ||
            m.count + m.nulls !== bin.samples || typeof m.mixed !== 'boolean') return null;
        const numeric = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER &&
          (!CODES.includes(field) || Number.isInteger(v) && v <= 4294967295) && (!FLAGS.includes(field) || v === 0 || v === 1);
        if ([m.min, m.max].some(v => v !== null && !numeric(v)) ||
            (m.last !== null && !(FLAGS.includes(field) ? typeof m.last === 'boolean' : numeric(m.last))) ||
            (MEANS.includes(field) ? m.mean !== null && !numeric(m.mean) : m.mean !== null) ||
            (m.count === 0 && [m.mean, m.min, m.max, m.last].some(v => v !== null)) ||
            (m.count > 0 && (m.min === null || m.max === null || m.min > m.max)) ||
            (m.last !== null && (Number(m.last) < m.min || Number(m.last) > m.max)) ||
            (m.mean !== null && (m.mean < m.min - 1e-9 * Math.max(1, m.min) ||
              m.mean > m.max + 1e-9 * Math.max(1, m.max)))) return null;
      }
    }
    return JSON.parse(JSON.stringify(batch));
  }
  function createArchiveStore() {
    let batch = null, revision = 0;
    return {
      importHistory(value, now = Date.now(), selection) {
        const validated = validate(value, now, selection);
        if (!validated) return false;
        if (validated.status === 'ok') { batch = validated; revision++; }
        return true;
      },
      clear() { batch = null; revision++; },
      snapshot() { return batch === null ? null : JSON.parse(JSON.stringify(batch)); },
      get size() { return batch?.buckets.length || 0; },
      get revision() { return revision; }
    };
  }
  function fieldFor(m) {
    return m.index === null ? m.field : `${m.field === 'current_a' ? 'current' : 'voltage'}_l${m.index + 1}_${m.field === 'current_a' ? 'a' : 'v'}`;
  }
  function buildSummaryPlot(batch, group, selected, charts, geometry) {
    const start = utc(batch.range.from), end = utc(batch.range.to), points = [];
    for (const bin of batch.buckets) {
      for (const stat of ['min', 'max']) points.push({ t: utc(bin.from), values: Object.fromEntries(charts.METRICS.map(m =>
        [m.id, bin.metrics[fieldFor(m)][stat] === null ? null : bin.metrics[fieldFor(m)][stat] / m.divisor])) });
    }
    const plot = charts.buildPlot(points, group, selected, start, end, geometry);
    const bounds = plot.geometry;
    const x = t => bounds.left + (t - start) / (end - start) * (bounds.right - bounds.left);
    const y = v => bounds.bottom - (v - plot.lo) / (plot.hi - plot.lo) * (bounds.bottom - bounds.top);
    plot.paths = plot.metrics.map(m => {
      const glyphs = [];
      for (const bin of batch.buckets) {
        const stat = bin.metrics[fieldFor(m)];
        if (!stat.count) continue;
        const left = x(utc(bin.from)), right = x(utc(bin.to)), middle = (left + right) / 2;
        const mean = MEANS.includes(fieldFor(m)) ? stat.mean : (typeof stat.last === 'boolean' ? Number(stat.last) : stat.last);
        const min = y(stat.min / m.divisor), max = y(stat.max / m.divisor);
        const format = v => v === null ? 'unbekannt' : valueFormat.format(v / m.divisor);
        const attributes = { gap: bin.has_gap || !bin.complete || stat.nulls > 0, mixed: stat.mixed,
          label: `${m.label} · ${axisLabel(utc(bin.from), 'day', batch.range.timezone)} – ${axisLabel(utc(bin.to), 'day', batch.range.timezone)} · ${batch.range.timezone}: ${stat.count} Werte; Min ${format(stat.min)}, Max ${format(stat.max)}, ${MEANS.includes(fieldFor(m)) ? 'Stichprobenmittel' : 'letzter Wert'} ${format(mean)} ${group.unit}; belegte Dauer ${bin.coverage_seconds} s${stat.mixed ? ', gemischt' : ''}${bin.has_gap || !bin.complete || stat.nulls > 0 ? ', Lücken / unvollständig' : ''}` };
        // Independent, observed aggregates, not reconstructed time series. The
        // renderer styles range softly and value SOLID, even when gap is true;
        // gap remains available for separate uncertainty styling / the tooltip.
        glyphs.push({ ...attributes, kind: 'range',
          path: `M${middle.toFixed(2)},${min.toFixed(2)}V${max.toFixed(2)}` });
        // Never replace a NULL last with an older non-NULL observation. Mixed
        // flags/codes expose only the range, not a seemingly constant state.
        if (mean !== null && !((FLAGS.includes(fieldFor(m)) || CODES.includes(fieldFor(m))) && stat.mixed)) {
          const py = y(mean / m.divisor).toFixed(2);
          // A short bucket-local tick is an aggregate mark, not an assertion
          // that the value held for the entire interval. No neighbour links,
          // even for complete buckets; an inset preserves every bucket edge.
          const halfWidth = Math.min(5, (right - left) * .4);
          glyphs.push({ ...attributes, kind: 'value',
            path: `M${(middle - halfWidth).toFixed(2)},${py}H${(middle + halfWidth).toFixed(2)}` });
        }
      }
      return { metric: m, path: '', markers: [], glyphs };
    });
    plot.count = batch.buckets.reduce((n, b) => n + b.samples, 0);
    return plot;
  }
  function axisLabel(t, period, zone = ZONE, compact = false) {
    const key = `${period}:${zone}:${compact}`;
    if (!timeFormats.has(key)) timeFormats.set(key, new Intl.DateTimeFormat('de-AT', { timeZone: zone,
      ...(compact ? ['hour', 'day'].includes(period) ? { hour: '2-digit', minute: '2-digit' }
        : { day: '2-digit', month: '2-digit', ...(period === 'custom' ? { year: '2-digit' } : {}) }
        : period === 'hour' ? { hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset' }
        : period === 'day' ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset' }
          : { day: '2-digit', month: '2-digit', year: 'numeric' }) }));
    return timeFormats.get(key).format(t);
  }
  function mount({ document, loader, archive, onChange, storage }) {
    const mode = document.getElementById('calendar-mode');
    if (!mode) return null;
    const picker = document.getElementById('calendar-date'), custom = document.getElementById('calendar-custom');
    const periodButtons = document.querySelectorAll('[data-calendar-period]');
    const pickerLabel = document.getElementById('calendar-picker-label');
    const pickerCaption = document.getElementById('calendar-picker-caption');
    const label = document.getElementById('calendar-label'), range = document.getElementById('chart-range');
    let selection = null, navigation = null;
    const persist = () => { try { storage?.setItem(KEY, JSON.stringify(selection)); } catch (_) { /* page-only */ } };
    function controls() {
      picker.hidden = ['live', 'custom'].includes(mode.value); custom.hidden = mode.value !== 'custom';
      if (pickerLabel) pickerLabel.hidden = picker.hidden;
      const caption = ({ hour: 'Stunde', day: 'Datum', week: 'Kalenderwoche', month: 'Monat', year: 'Jahr' })[mode.value] || 'Datum';
      if (pickerCaption) pickerCaption.textContent = caption;
      for (const button of periodButtons)
        button.setAttribute('aria-pressed', String(button.getAttribute('data-calendar-period') === mode.value));
      range.disabled = mode.value !== 'live';
      const liveWindow = range.closest('label');
      if (liveWindow) liveWindow.hidden = mode.value !== 'live';
      picker.type = ({ hour: 'datetime-local', day: 'date', week: 'week', month: 'month', year: 'number' })[mode.value] || 'date';
      picker.step = mode.value === 'hour' ? '3600' : '1';
      if (mode.value === 'year') { picker.min = '1970'; picker.max = '9998'; }
      else { picker.removeAttribute('min'); picker.removeAttribute('max'); }
      picker.setAttribute('aria-label', `${caption} wählen · ${ZONE}`);
      for (const [id, key] of [['calendar-prev', 'previous'], ['calendar-next', 'next']])
        document.getElementById(id).disabled = !navigation?.[key];
    }
    function select(value, save = true) {
      if (value !== null && (!query(value) || value.tz !== ZONE)) return false;
      selection = value; navigation = null; archive.clear(); loader.select(value);
      loader.setVisible(!document.hidden);
      mode.value = value?.period || 'live'; picker.value = value?.date === 'now' ? '' : value?.date || '';
      if (value?.period === 'custom') {
        document.getElementById('calendar-from').value = value.date_from || '';
        document.getElementById('calendar-to').value = value.date_to || '';
      }
      label.textContent = value ? `Archiv · ${ZONE} · Zeitraum wird geladen` : 'Live-Verlauf · Browser und Roharchiv';
      controls(); if (save) persist(); onChange(); loader.tick(); return true;
    }
    mode.addEventListener('change', () => {
      if (mode.value === 'custom') {
        selection = { period: 'custom', tz: ZONE }; navigation = null; archive.clear(); loader.suspend();
        controls(); label.textContent = `Zeitraum wählen · ${ZONE}`; onChange(); return;
      }
      select(mode.value === 'live' ? null : { period: mode.value, date: 'now', tz: ZONE });
    });
    for (const button of periodButtons) button.addEventListener('click', () => {
      const period = button.getAttribute('data-calendar-period');
      if (!PERIODS.includes(period)) return;
      mode.value = period;
      mode.dispatchEvent(new Event('change'));
    });
    picker.addEventListener('change', () => {
      if (picker.value) select({ period: mode.value, date: picker.value, tz: ZONE });
    });
    custom.addEventListener('submit', event => {
      event.preventDefault();
      const a = document.getElementById('calendar-from'), b = document.getElementById('calendar-to');
      if (a.value && b.value) select({ period: 'custom', date_from: a.value, date_to: b.value, tz: ZONE });
    });
    for (const [id, key] of [['calendar-prev', 'previous'], ['calendar-next', 'next']])
      document.getElementById(id).addEventListener('click', () => { if (navigation?.[key]) select(navigation[key]); });
    document.getElementById('calendar-now').addEventListener('click', () =>
      select(mode.value === 'live' ? null : { period: mode.value === 'custom' ? 'day' : mode.value, date: 'now', tz: ZONE }));
    function loaded(batch) {
      if (!selection) return;
      navigation = batch.navigation;
      picker.value = batch.selection.date;
      const period = batch.selection.period;
      const title = period === 'year' ? batch.selection.date : period === 'week'
        ? `KW ${batch.selection.date.slice(6)} · ${batch.selection.date.slice(0, 4)}`
        : ['day', 'month'].includes(period) ? new Intl.DateTimeFormat('de-AT', { timeZone: ZONE,
          ...(period === 'day' ? { dateStyle: 'long' } : { month: 'long', year: 'numeric' }) }).format(utc(batch.range.from))
          : `${axisLabel(utc(batch.range.from), 'day')} – ${axisLabel(utc(batch.range.to), 'day')}`;
      label.textContent = `${title} · ${ZONE}`;
      controls();
    }
    let saved = null;
    try { saved = JSON.parse(storage?.getItem(KEY) || 'null'); } catch (_) { /* default live */ }
    if (!select(saved, false)) select(null, false);
    return { get selection() { return selection; }, loaded, reset() { navigation = null; controls(); } };
  }
  const api = { KEY, ZONE, MAX_BINS, PERIODS, FIELDS, utc, validate, createArchiveStore, fieldFor, buildSummaryPlot, axisLabel, mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OverlayCalendar = api;
})(typeof window !== 'undefined' ? window : globalThis);
