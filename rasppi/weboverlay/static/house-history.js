(function (root) {
  'use strict';
  const history = root.OverlayHistory || (typeof require === 'function' ? require('./history.js') : null);
  const RAW_RETENTION_MS = 900000, MAX_RAW_POINTS = 1200, MAX_BUCKETS = 512;
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const keys = (v, names) => object(v) && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
  const count = v => Number.isSafeInteger(v) && v >= 0;
  const watt = v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER;
  const minuteEvidence = new WeakSet();
  function minuteAdjacent(a, b) {
    const x = a?.interval, y = b?.interval;
    return a?.source === 'sql' && b?.source === 'sql' && a.recordType === 'minute' && b.recordType === 'minute' &&
      minuteEvidence.has(x) && minuteEvidence.has(y) && x.complete && y.complete && !x.has_gap && !y.has_gap &&
      !x.break_fields.length && !y.break_fields.length && utc(x.to) === utc(y.from) &&
      a.t === utc(x.from) + 30000 && b.t === utc(y.from) + 30000;
  }
  function utc(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(v) ||
        Number(v.slice(0, 4)) < 1970 || Number(v.slice(0, 4)) > 9998) return NaN;
    const t = Date.parse(v);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 19) === v.slice(0, 19)
      ? t + Number((v.match(/\.(\d+)/)?.[1] || '').slice(3).padEnd(3, '0')) / 1000 : NaN;
  }
  function validate(batch, now, requested = null) {
    const calendar = requested !== null;
    if (!Number.isFinite(now) || !keys(batch, calendar ? ['schema_version', 'read_only', 'status', 'reason', 'generated_at', 'range', 'selection',
      'navigation', 'aggregation', 'complete', 'progress', 'buckets'] : ['schema_version', 'read_only', 'status', 'reason',
      'generated_at', 'minutes', 'range', 'complete', 'samples']) || !(calendar ? batch.schema_version === 2 : [1, 3].includes(batch.schema_version)) ||
      batch.read_only !== true || !['ok', 'disabled', 'unavailable'].includes(batch.status) ||
      typeof batch.reason !== 'string' || batch.reason.length > 1024 || typeof batch.complete !== 'boolean' ||
      !Number.isFinite(utc(batch.generated_at)) || utc(batch.generated_at) > now + 5000 || utc(batch.generated_at) < now - 900000 ||
      !keys(batch.range, calendar ? ['from', 'to', 'timezone'] : ['from', 'to'])) return null;
    const from = utc(batch.range.from), to = utc(batch.range.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from ||
        to - from > (calendar ? 366 * 86400000 + 3600000 : RAW_RETENTION_MS)) return null;
    if (!calendar) {
      if (![1, 5, 15].includes(batch.minutes) || to - from !== batch.minutes * 60000 ||
          to > now + 5000 || to < now - RAW_RETENTION_MS || from < now - RAW_RETENTION_MS - 5000 ||
          !Array.isArray(batch.samples) || batch.samples.length > MAX_RAW_POINTS ||
          (batch.status !== 'ok' && batch.samples.length) || (batch.samples.length && batch.samples[0]?.break_before !== true)) return null;
      let previous = -Infinity;
      const ids = new Set();
      for (const p of batch.samples) {
        const t = utc(p?.timestamp), received = utc(p?.received_at);
        const identity = `${p?.interval ? 'minute' : 'raw'}:${p?.id}`;
        if (!keys(p, ['id', 'timestamp', 'received_at', 'status', 'power_w', 'break_before', ...(batch.schema_version === 3 ? ['interval'] : [])]) ||
            typeof p.id !== 'string' || !/^[1-9]\d{0,19}$/.test(p.id) || BigInt(p.id) > 18446744073709551615n || ids.has(identity) ||
            !Number.isFinite(t) || t < from || t > to || t < previous || t > now + 5000 ||
            !Number.isFinite(received) || received > now + 5000 || !['ok', 'error'].includes(p.status) ||
            typeof p.break_before !== 'boolean' || (p.status === 'ok'
              ? !(watt(p.power_w) || batch.schema_version === 3 && p.interval !== null && p.power_w === null)
              : p.power_w !== null)) return null;
        if (batch.schema_version === 3 && p.interval !== null) {
          const v = p.interval, a = utc(v?.from), z = utc(v?.to);
          if (!keys(v, ['from', 'to', 'complete', 'has_gap', 'break_fields']) ||
              typeof v.complete !== 'boolean' || typeof v.has_gap !== 'boolean' ||
              !Array.isArray(v.break_fields) || v.break_fields.length > 1 || v.break_fields.some(f => f !== 'power_w') ||
              !Number.isFinite(a) || a % 60000 !== 0 || z !== a + 60000 || a < from || z > to ||
              t !== a + 30000 || received !== z || p.id !== String(a / 60000 + 1) || p.status !== 'ok' ||
              (p.power_w === null && !v.break_fields.includes('power_w'))) return null;
        }
        previous = t; ids.add(identity);
      }
    } else {
      if (!history?.calendarQuery(requested) || batch.aggregation !== 'sample_mean' ||
          !keys(batch.selection, ['period', 'date', 'timezone']) || batch.selection.period !== requested.period ||
          batch.selection.timezone !== requested.tz || batch.range.timezone !== requested.tz ||
          typeof batch.selection.date !== 'string' || batch.selection.date.length > 80 ||
          (requested.date && requested.date !== 'now' && requested.date !== batch.selection.date) ||
          (requested.at && !(utc(requested.at) >= from && utc(requested.at) < to)) ||
          (requested.from && (utc(requested.from) !== from || utc(requested.to) !== to)) ||
          !keys(batch.progress, ['samples_done', 'events_done']) || Object.values(batch.progress).some(v => typeof v !== 'boolean') ||
          !Array.isArray(batch.buckets) || batch.buckets.length > MAX_BUCKETS || (batch.status !== 'ok' && batch.buckets.length)) return null;
      if (requested.date_from) {
        const local = t => {
          const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: requested.tz,
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
            .formatToParts(t).map(p => [p.type, p.value]));
          return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
        };
        if (local(from) !== requested.date_from || local(to) !== requested.date_to) return null;
      }
      if (!(requested.period === 'custom' && batch.navigation === null) && !keys(batch.navigation, ['previous', 'next', 'now'])) return null;
      for (const nav of Object.values(batch.navigation || {})) if (nav !== null &&
        (!history.calendarQuery(nav) || nav.period !== requested.period || nav.tz !== requested.tz ||
          Object.entries(nav).some(([key, value]) => !['period', 'tz'].includes(key) && value !== 'now' &&
            (Number(value.slice(0, 4)) < 1970 || Number(value.slice(0, 4)) > 9998)))) return null;
      let previous = from;
      for (const b of batch.buckets) {
        if (!keys(b, ['from', 'to', 'samples', 'has_gap', 'complete', 'coverage_seconds', 'metrics']) ||
            !count(b.samples) || typeof b.has_gap !== 'boolean' || typeof b.complete !== 'boolean' ||
            !keys(b.metrics, ['power_w'])) return null;
        const a = utc(b.from), z = utc(b.to), m = b.metrics.power_w;
        if (!Number.isFinite(a) || !Number.isFinite(z) || a < previous || z <= a || a < from || z > to ||
            (b.samples > 0 && a > now + 5000) || !Number.isFinite(b.coverage_seconds) || b.coverage_seconds < 0 ||
            b.coverage_seconds > (z - a) / 1000 || !keys(m, ['count', 'nulls', 'mean', 'min', 'max', 'last', 'mixed']) ||
            !count(m.count) || !count(m.nulls) || m.count + m.nulls !== b.samples || m.mixed !== false ||
            [m.mean, m.min, m.max, m.last].some(v => v !== null && !watt(v)) ||
            (!m.count && [m.mean, m.min, m.max, m.last].some(v => v !== null)) ||
            (m.count > 0 && (m.min === null || m.max === null || m.mean === null || m.min > m.max)) ||
            [m.mean, m.last].some(v => v !== null && (v < m.min - 1e-9 * Math.max(1, Math.abs(m.min)) ||
              v > m.max + 1e-9 * Math.max(1, Math.abs(m.max))))) return null;
        previous = z;
      }
    }
    const validated = JSON.parse(JSON.stringify(batch));
    if (!calendar && validated.schema_version === 3) {
      for (const p of validated.samples) if (p.interval) minuteEvidence.add(p.interval);
    }
    return validated;
  }
  function createStore() {
    let raw = null, archive = null, revision = 0;
    const freeze = value => {
      if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
      return value;
    };
    return {
      importHistory(value, now, selection = null) {
        const batch = validate(value, now, selection);
        if (!batch) return false;
        if (batch.status === 'ok') {
          const old = selection ? archive : raw;
          const signature = value => value && JSON.stringify({ ...value, generated_at: undefined, reason: undefined });
          if (signature(old) !== signature(batch)) { if (selection) archive = freeze(batch); else raw = freeze(batch); revision++; }
        }
        return true;
      },
      clearRaw() { if (raw) { raw = null; revision++; } },
      clear() {
        if (raw || archive) { raw = null; archive = null; revision++; }
      },
      raw() { return raw ? JSON.parse(JSON.stringify(raw)) : null; },
      archive() { return archive ? JSON.parse(JSON.stringify(archive)) : null; },
      rawView() { return raw; },
      archiveView() { return archive; },
      // The two independent HTTP pollers must never interleave. SQL is the
      // baseline; only strictly newer RAM observations form a separate tail.
      points(live, now, minutes = 5) {
        const start = now - minutes * 60000;
        const sql = (raw?.samples || []).map((p, i, all) => {
          const interval = p.interval || null, prior = all[i - 1];
          return { t: utc(p.timestamp), power_w: p.power_w, source: 'sql', interval, recordType: interval ? 'minute' : 'raw',
            seriesBreak: p.power_w === null || !!interval?.break_fields.length,
            breakBefore: p.break_before || p.status !== 'ok' || !!interval && (!interval.complete || interval.has_gap) ||
              !!prior && !!prior.interval !== !!interval };
        });
        const cutoff = sql.length ? Math.max(...sql.map(p => p.interval ? utc(p.interval.to) : p.t)) : -Infinity;
        const tail = (Array.isArray(live) ? live : []).filter(p => Number.isFinite(p.t) && p.t > cutoff)
          .map((p, i) => ({ ...p, source: 'live', recordType: 'raw', interval: null, breakBefore: (sql.length > 0 && i === 0) || p.breakBefore }));
        const result = [...sql, ...tail].filter(p => p.t >= start && p.t <= now).slice(-MAX_RAW_POINTS);
        if (result.length) result[0] = { ...result[0], breakBefore: true };
        return result;
      },
      get revision() { return revision; }
    };
  }
  function createLoader(options = {}) {
    if (!history?.createHistoryLoader) return null;
    const fetcher = options.fetch || root.fetch.bind(root);
    return history.createHistoryLoader({ ...options, fetch: (url, init) => fetcher(url.replace('/api/history', '/api/house-history'), init) });
  }
  const api = { RAW_RETENTION_MS, MAX_RAW_POINTS, MAX_BUCKETS, utc, validate, createStore, createLoader, minuteAdjacent };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OverlayHouseHistory = api;
})(typeof window !== 'undefined' ? window : globalThis);
