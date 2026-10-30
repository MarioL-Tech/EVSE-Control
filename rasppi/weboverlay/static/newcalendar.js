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
  function calendarLimits(now = Date.now(), zone = ZONE) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now).map(part => [part.type, part.value]));
    const day = `${p.year}-${p.month}-${p.day}`, month = day.slice(0, 7);
    const thursday = new Date(`${day}T00:00:00Z`);
    thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
    const year = thursday.getUTCFullYear();
    const week = Math.ceil(((thursday - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
    return { hour: `${day}T${p.hour}:00`, day, week: `${year}-W${String(week).padStart(2, '0')}`,
      month, year: p.year, custom: `${day}T${p.hour}:${p.minute}` };
  }
  function selectionAllowed(value, now = Date.now()) {
    if (value === null) return true;
    if (!query(value)) return false;
    const limits = calendarLimits(now, value.tz);
    if (value.period === 'custom') {
      if (value.from) return utc(value.from) < utc(value.to) && utc(value.to) <= now;
      return value.date_from < value.date_to && value.date_to <= limits.custom;
    }
    if (value.at) return Number.isFinite(utc(value.at)) && utc(value.at) <= now;
    return value.date === 'now' || value.date <= limits[value.period];
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
    let batch = null, revision = 0, signature = null;
    function freeze(value) {
      if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
      return value;
    }
    return {
      importHistory(value, now = Date.now(), selection) {
        const validated = validate(value, now, selection);
        if (!validated) return false;
        if (validated.status === 'ok') {
          const next = JSON.stringify({ ...validated, generated_at: undefined, reason: undefined });
          if (signature !== next) { signature = next; batch = freeze(validated); revision++; }
        }
        return true;
      },
      clear() { batch = null; signature = null; revision++; },
      snapshot() { return batch === null ? null : JSON.parse(JSON.stringify(batch)); },
      // Internal renderer view has immutable ownership: no full JSON copy per
      // status update or frame. snapshot() retains its public copy contract.
      view() { return batch; },
      get size() { return batch?.buckets.length || 0; },
      get revision() { return revision; }
    };
  }
  function fieldFor(m) {
    return m.index === null ? m.field : `${m.field === 'current_a' ? 'current' : 'voltage'}_l${m.index + 1}_${m.field === 'current_a' ? 'a' : 'v'}`;
  }
  const preparedArchives = new WeakMap();
  function prepareArchive(batch) {
    if (preparedArchives.has(batch)) return preparedArchives.get(batch);
    const result = { start: utc(batch.range.from), end: utc(batch.range.to),
      bins: batch.buckets.map(bin => ({ bin, from: utc(bin.from), to: utc(bin.to) })), labels: new Map(),
      count: batch.buckets.reduce((n, bin) => n + bin.samples, 0) };
    // Tests/external callers can pass mutable data. Cache only owned immutable
    // store views so a changed timestamp can never reuse stale geometry.
    if (Object.isFrozen(batch)) preparedArchives.set(batch, result);
    return result;
  }
  function buildSummaryPlot(batch, group, selected, charts, geometry) {
    const prepared = prepareArchive(batch), { start, end } = prepared, points = [];
    const lineMode = batch.selection.period !== 'custom';
    const metrics = charts.METRICS.filter(m => m.group === group.id && selected[m.id]);
    for (const bin of batch.buckets) {
      for (const stat of lineMode ? ['value'] : ['min', 'max']) points.push({ values: Object.fromEntries(metrics.map(m => {
        const field = fieldFor(m), s = bin.metrics[field];
        const value = stat === 'value' ? (MEANS.includes(field) ? s.mean : s.last) : s[stat];
        return [m.id, value === null ? null : Number(value) / m.divisor];
      })) });
    }
    const plot = charts.buildPlot(points, group, selected, start, end, geometry, true);
    // Line axes use the displayed aggregate values, not hidden raw extrema.
    delete plot.points;
    const bounds = plot.geometry;
    const x = t => bounds.left + (t - start) / (end - start) * (bounds.right - bounds.left);
    const y = v => bounds.bottom - (v - plot.lo) / (plot.hi - plot.lo) * (bounds.bottom - bounds.top);
    plot.bucketCount = batch.buckets.length;
    plot.lineMode = lineMode;
    // Categorical centre points represent actual last observations per bin,
    // NOT continuous state occupancy or a measured transition time.
    plot.stateObservations = lineMode && Boolean(group.step);
    plot.paths = plot.metrics.map(m => {
      const renderPaths = [], runs = [], logical = [], labels = new Map(), stateMarkers = [], quality = new Map();
      const xy = (a, b) => `${a.toFixed(2)},${b.toFixed(2)}`;
      const field = fieldFor(m), isMean = MEANS.includes(field), categorical = FLAGS.includes(field) || CODES.includes(field);
      const labelAt = index => {
        const entry = prepared.bins[index];
        if (!entry || !entry.bin.samples) return null;
        if (!labels.has(index)) {
          const { bin, from, to } = entry, stat = bin.metrics[field];
          if (!prepared.labels.has(index)) prepared.labels.set(index,
            `${axisLabel(from, 'day', batch.range.timezone)} – ${axisLabel(to, 'day', batch.range.timezone)} · ${batch.range.timezone}`);
          const mean = isMean ? stat.mean : typeof stat.last === 'boolean' ? Number(stat.last) : stat.last;
          const format = v => v === null ? 'unbekannt' : valueFormat.format(v / m.divisor);
          labels.set(index, `${m.label} · ${prepared.labels.get(index)}: ${stat.count} Werte; Min ${format(stat.min)}, Max ${format(stat.max)}, ${isMean ? 'Stichprobenmittel' : 'letzter Wert'} ${format(mean)} ${group.unit}; belegte Dauer ${bin.coverage_seconds} s${stat.mixed ? ', gemischt' : ''}${bin.has_gap || !bin.complete || stat.nulls > 0 ? ', Lücken / unvollständig' : ''}`);
        }
        return labels.get(index);
      };
      let run = [];
      const finish = () => { if (run.length) runs.push(run); run = []; };
      for (const [bucketIndex, { bin, from, to }] of prepared.bins.entries()) {
        const stat = bin.metrics[field];
        if (lineMode && categorical && bin.samples > 0) {
          const left = x(from), right = x(to), inset = Math.min(3, (right - left) * .2);
          const uncertain = bin.has_gap || !bin.complete || stat.nulls > 0;
          // Unknown takes precedence over mixed/partial: no last value is
          // inferred from earlier observations. Quality has its own lane and
          // never occupies the numeric/boolean zero coordinate.
          const kind = !stat.count || stat.last === null ? 'unknown' : stat.mixed ? 'mixed' : uncertain ? 'partial' : null;
          if (kind) quality.set(kind, (quality.get(kind) || '')
            + `M${xy(left + inset, bounds.bottom + 14)}H${(right - inset).toFixed(2)}`);
          if (stat.count && stat.last !== null && stat.mixed)
            stateMarkers.push({ x: (left + right) / 2, y: y(Number(stat.last) / m.divisor) });
        }
        if (!stat.count) { finish(); continue; }
        const left = x(from), right = x(to), middle = (left + right) / 2;
        const mean = isMean ? stat.mean : (typeof stat.last === 'boolean' ? Number(stat.last) : stat.last);
        const min = y(stat.min / m.divisor), max = y(stat.max / m.divisor);
        const attributes = { bucketIndex, gap: bin.has_gap || !bin.complete || stat.nulls > 0, mixed: stat.mixed };
        const value = mean === null || (categorical && stat.mixed)
          ? null : y(mean / m.divisor);
        // A varying numeric measurement is precisely why a mean/range is
        // plotted. `mixed` only makes categorical states ambiguous; it must
        // not turn an otherwise continuous voltage/current series into ticks.
        // Calendar lines show a trend of available interval aggregates, not a
        // reconstruction of uninterrupted raw acquisition. Coarse coverage /
        // processing flags remain in inspection labels, but must not isolate
        // every known mean until background quality processing catches up.
        // A partial NULL/coarse quality flag does not erase an actual known
        // last observation. This stepped observational trend does not assert
        // an uninterrupted state throughout a partly sampled interval. The
        // separate quality lane and inspection retain that uncertainty.
        // Missing/empty/unknown-last and mixed categorical bins still split.
        const safe = value !== null && (lineMode || !attributes.gap);
        const previous = run.at(-1);
        if (!safe || (previous && previous.to !== from)) finish();
        const point = { left, right, middle, min, max, value, ...attributes, to };
        run.push(point); logical.push(point);
        if (!safe) finish();
      }
      finish();
      const add = (kind, gap, path) => {
        let target = renderPaths.find(p => p.kind === kind && p.gap === gap);
        if (!target) { target = { kind, gap, path: '' }; renderPaths.push(target); }
        target.path += path;
      };
      if (lineMode) {
        // Lines interpolate adjacent available mean/last centres only; they
        // do not claim gap-free raw acquisition. Live/raw's 10s/lifecycle
        // barriers and long-range coverage envelopes remain unchanged.
        let path = '';
        const markers = [];
        for (const segment of runs) {
          const known = segment.filter(p => p.value !== null);
          if (!known.length) continue;
          path += `M${xy(known[0].middle, known[0].value)}`;
          for (const p of known.slice(1)) path += group.step
            ? `H${p.middle.toFixed(2)}V${p.value.toFixed(2)}` : `L${xy(p.middle, p.value)}`;
          if (known.length === 1) markers.push({ x: known[0].middle, y: known[0].value });
        }
        const last = logical.filter(p => p.value !== null).at(-1);
        if (last && !markers.some(p => p.x === last.middle && p.y === last.value))
          markers.push({ x: last.middle, y: last.value });
        const sparse = [];
        for (const p of markers.slice().reverse())
          if (!sparse.some(q => Math.abs(q.x - p.x) < 7 && Math.abs(q.y - p.y) < 5)) sparse.push(p);
        const sparseStates = [];
        for (const p of stateMarkers.slice().reverse())
          if (!sparseStates.some(q => Math.abs(q.x - p.x) < 7 && Math.abs(q.y - p.y) < 5)) sparseStates.push(p);
        return { metric: m, path, markers: sparse.reverse(), stateMarkers: sparseStates.reverse(),
          qualityPaths: [...quality].map(([kind, path]) => ({ kind, path })), renderPaths: [], labelAt,
          get bucketLabels() { return batch.buckets.map((_, i) => labelAt(i)); },
          get glyphs() { return []; } };
      }
      for (const segment of runs) {
        if (segment.length === 1) {
          const p = segment[0], half = (p.right - p.left) * .36;
          add('range', p.gap, `M${xy(p.middle - half, p.min)}L${xy(p.middle - half, p.max)}L${xy(p.middle + half, p.max)}L${xy(p.middle + half, p.min)}Z`);
          if (p.value !== null) {
            const tick = Math.min(3, (p.right - p.left) * .32);
            add('value', p.gap, `M${xy(p.middle - tick, p.value)}H${(p.middle + tick).toFixed(2)}`);
          }
          continue;
        }
        // Only fully evidenced adjoining buckets form a trend/envelope.
        // Each run is a separate subpath, including at a one-pixel-wide gap.
        add('range', false, `M${segment.map(p => xy(p.middle, p.min)).join('L')}L${segment.slice().reverse().map(p => xy(p.middle, p.max)).join('L')}Z`);
        let trend = `M${xy(segment[0].middle, segment[0].value)}`;
        for (const point of segment.slice(1)) trend += group.step
          ? `H${point.middle.toFixed(2)}V${point.value.toFixed(2)}` : `L${xy(point.middle, point.value)}`;
        add('value', false, trend);
      }
      let glyphs = null;
      return { metric: m, path: '', markers: [], renderPaths, labelAt,
        // Compatibility/inspection data is lazy. Normal SVG rendering uses
        // only the batched paths and formats only the inspected interval.
        get bucketLabels() { return batch.buckets.map((_, i) => labelAt(i)); },
        get glyphs() {
          if (glyphs) return glyphs;
          glyphs = [];
          const xy = (a, b) => `${a.toFixed(2)},${b.toFixed(2)}`;
          for (const p of logical) {
            const half = (p.right - p.left) * .36, tick = Math.min(3, (p.right - p.left) * .32);
            const attrs = { bucketIndex: p.bucketIndex, gap: p.gap, mixed: p.mixed, label: labelAt(p.bucketIndex) };
            glyphs.push({ ...attrs, kind: 'range', path: `M${xy(p.middle - half, p.min)}L${xy(p.middle - half, p.max)}L${xy(p.middle + half, p.max)}L${xy(p.middle + half, p.min)}Z` });
            if (p.value !== null) glyphs.push({ ...attrs, kind: 'value', path: `M${xy(p.middle - tick, p.value)}H${(p.middle + tick).toFixed(2)}` });
          }
          return glyphs;
        } };
    });
    plot.count = prepared.count;
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
  function mount({ document, loader, archive, onChange, storage, eventTarget = root, clock = () => Date.now() }) {
    const mode = document.getElementById('calendar-mode');
    if (!mode) return null;
    const picker = document.getElementById('calendar-date'), custom = document.getElementById('calendar-custom');
    const periodButtons = document.querySelectorAll('[data-calendar-period]');
    const pickerLabel = document.getElementById('calendar-picker-label');
    const pickerCaption = document.getElementById('calendar-picker-caption');
    const label = document.getElementById('calendar-label'), range = document.getElementById('chart-range');
    let selection = null, navigation = null;
    const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
    function publish(resolved = null) {
      api.currentSelection = clone(selection);
      api.currentRange = clone(resolved);
      if (resolved && selection?.date === 'now')
        api.currentSelection = { period: selection.period, at: resolved.from, tz: selection.tz };
      if (eventTarget.dispatchEvent) {
        const detail = { selection: clone(api.currentSelection), range: clone(api.currentRange) };
        const event = typeof root.CustomEvent === 'function' ? new root.CustomEvent('evse:calendar-change', { detail }) : new Event('evse:calendar-change');
        if (!('detail' in event)) Object.defineProperty(event, 'detail', { value: detail });
        eventTarget.dispatchEvent(event);
      }
    }
    const persist = () => { try { storage?.setItem(KEY, JSON.stringify(selection)); } catch (_) { /* page-only */ } };
    function controls() {
      const limits = calendarLimits(clock());
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
      if (mode.value === 'year') picker.min = '1970';
      else picker.removeAttribute('min');
      picker.max = limits[mode.value] || limits.day;
      for (const id of ['calendar-from', 'calendar-to']) document.getElementById(id).max = limits.custom;
      picker.setAttribute('aria-label', `${caption} wählen · ${ZONE}`);
      for (const [id, key] of [['calendar-prev', 'previous'], ['calendar-next', 'next']])
        document.getElementById(id).disabled = !navigation?.[key] || !selectionAllowed(navigation[key], clock());
    }
    function select(value, save = true) {
      if (value !== null && (!query(value) || value.tz !== ZONE)) return false;
      if (!selectionAllowed(value, clock())) {
        controls(); label.textContent = 'Zukünftige Zeiträume sind nicht verfügbar.'; return false;
      }
      selection = value; navigation = null; archive.clear(); loader.select(value);
      loader.setVisible(!document.hidden);
      mode.value = value?.period || 'live'; picker.value = value?.date === 'now' ? '' : value?.date || '';
      if (value?.period === 'custom') {
        document.getElementById('calendar-from').value = value.date_from || '';
        document.getElementById('calendar-to').value = value.date_to || '';
      }
      label.textContent = value ? `Archiv · ${ZONE} · wird geladen` : 'Live-Verlauf';
      controls(); if (save) persist(); publish(); onChange(); loader.tick(); return true;
    }
    mode.addEventListener('change', () => {
      if (mode.value === 'custom') {
        selection = { period: 'custom', tz: ZONE }; navigation = null; archive.clear(); loader.suspend();
        controls(); label.textContent = `Zeitraum wählen · ${ZONE}`; publish(); onChange(); return;
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
    for (const element of [picker, document.getElementById('calendar-from'), document.getElementById('calendar-to')])
      element.addEventListener('focus', controls);
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
      if (!selection || batch.status !== 'ok') return;
      navigation = batch.navigation;
      picker.value = batch.selection.date;
      const period = batch.selection.period;
      const title = period === 'year' ? batch.selection.date : period === 'week'
        ? `KW ${batch.selection.date.slice(6)} · ${batch.selection.date.slice(0, 4)}`
        : ['day', 'month'].includes(period) ? new Intl.DateTimeFormat('de-AT', { timeZone: ZONE,
          ...(period === 'day' ? { dateStyle: 'long' } : { month: 'long', year: 'numeric' }) }).format(utc(batch.range.from))
          : `${axisLabel(utc(batch.range.from), 'day')} – ${axisLabel(utc(batch.range.to), 'day')}`;
      label.textContent = `${title} · ${ZONE}`;
      controls(); publish(batch.range);
    }
    eventTarget.addEventListener?.('evse:calendar-range', event => {
      const detail = event.detail, currentQuery = query(api.currentSelection);
      if (!selection || navigation || api.currentRange !== null || currentQuery === null ||
          !keys(detail, ['query', 'metadata']) || detail.query !== currentQuery ||
          !keys(detail.metadata, ['range', 'selection', 'navigation'])) return;
      // Reuse the strict calendar metadata/query checks; no HOUSE measurements
      // cross this interface, and a stale/foreign query cannot move navigation.
      const candidate = { schema_version: 2, read_only: true, status: 'ok', reason: '',
        generated_at: new Date().toISOString(), aggregation: 'sample_mean', complete: false,
        progress: { samples_done: false, events_done: false }, buckets: [], ...detail.metadata };
      if (validate(candidate, Date.now(), api.currentSelection)) loaded(candidate);
    });
    let saved = null;
    try { saved = JSON.parse(storage?.getItem(KEY) || 'null'); } catch (_) { /* default live */ }
    if (!select(saved, false)) select(null, false);
    return { get selection() { return selection; }, loaded, reset() { navigation = null; controls(); publish(); } };
  }
  const api = { KEY, ZONE, MAX_BINS, PERIODS, FIELDS, utc, calendarLimits, selectionAllowed, validate, createArchiveStore, fieldFor, buildSummaryPlot, axisLabel, mount,
    currentSelection: null, currentRange: null };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OverlayCalendar = api;
})(typeof window !== 'undefined' ? window : globalThis);
