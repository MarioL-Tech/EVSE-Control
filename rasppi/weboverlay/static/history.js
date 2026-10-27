(function (root) {
  'use strict';
  const MAX_BYTES = 1024 * 1024, TIMEOUT_MS = 4000;
  // No live-state access and no persistence: this controller only loads archives.
  function createHistoryLoader({ fetch: fetcher = root.fetch.bind(root),
    clock = () => ({ wall: Date.now(), mono: performance.now() }),
    setTimer = setTimeout, clearTimer = clearTimeout,
    makeAbort = () => new AbortController(), importHistory, onState = () => {}, onReset = () => {} }) {
    let visible = true, generation = 0, active = null, due = 0, failures = 0;
    let disabled = false, loaded = false, lastClock = null, stopped = false;
    function cancel() {
      generation++;
      if (active) { clearTimer(active.timer); active.controller.abort(); active = null; }
    }
    function report(status, complete = true) { onState({ status, loaded, complete }); }
    function failure(now) {
      due = now + [10000, 30000, 60000][Math.min(failures++, 2)];
      report('unavailable');
    }
    async function read(response, current, controller) {
      const length = response.headers?.get('content-length');
      if (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw Error('size');
      if (!response.body?.getReader) {
        // Compatibility for non-streaming fetch implementations; browsers use
        // the bounded streaming path below, before JSON allocation.
        const value = await response.text();
        if (!current() || new TextEncoder().encode(value).length > MAX_BYTES) throw Error('size');
        return JSON.parse(value);
      }
      const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0, value = '';
      try {
        while (true) {
          const chunk = await reader.read();
          if (!current()) throw Error('cancelled');
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_BYTES) throw Error('size');
          value += decoder.decode(chunk.value, { stream: true });
        }
        value += decoder.decode();
        return JSON.parse(value);
      } catch (error) {
        // Stop the transport before awaiting reader cleanup, which may itself
        // depend on cancellation of a still-streaming response.
        if (current()) controller.abort();
        throw error;
      } finally {
        try { await reader.cancel(); } catch (_) { /* already closed */ }
        reader.releaseLock();
      }
    }
    function request(now) {
      const token = ++generation, controller = makeAbort();
      const current = () => visible && !stopped && active?.token === token && generation === token;
      active = { token, controller, timer: null };
      active.timer = setTimer(() => {
        if (!current()) return;
        cancel(); failure(clock().mono);
      }, TIMEOUT_MS);
      (async () => {
        try {
          const response = await fetcher('/api/history?minutes=15', {
            method: 'GET', cache: 'no-store', signal: controller.signal
          });
          if (!current()) return;
          if (![200, 503].includes(response.status)) throw Error('HTTP');
          const batch = await read(response, current, controller);
          if (!current()) return;
          // Observe both clocks after asynchronous work, before any import.
          const end = clock();
          if (lastClock && (end.wall < lastClock.wall || end.mono < lastClock.mono)) {
            cancel(); onReset(); loaded = false; disabled = false; due = 0; lastClock = end; report('browser'); return;
          }
          lastClock = end;
          if ((response.status === 503) !== (batch?.status === 'unavailable') || !importHistory(batch, end.wall)) throw Error('payload');
          if (batch.status === 'unavailable') throw Error('unavailable');
          failures = 0; disabled = batch.status === 'disabled';
          if (batch.status === 'ok') loaded = true;
          due = end.mono + 60000;
          report(batch.status, batch.complete);
        } catch (_) {
          if (current()) {
            // Headers/status can reject a response before its body is read.
            // Releasing the logical slot must never leave that body streaming.
            controller.abort();
            failure(clock().mono);
          }
        } finally {
          if (active?.token === token) { clearTimer(active.timer); active = null; }
        }
      })();
    }
    return {
      tick() {
        if (stopped) return;
        const now = clock();
        if (lastClock && (now.wall < lastClock.wall || now.mono < lastClock.mono)) {
          // A clock correction invalidates measurements, not the server's
          // already confirmed disabled configuration. Only visibility/restore
          // deliberately rechecks that configuration.
          cancel(); onReset(); loaded = false; due = 0;
          report(disabled ? 'disabled' : 'browser');
        }
        lastClock = now;
        if (visible && !disabled && !active && now.mono >= due) request(now);
      },
      setVisible(value) {
        if (visible === value || stopped) return;
        visible = value; cancel();
        if (visible) { disabled = false; due = 0; }
      },
      invalidate() { cancel(); due = 0; },
      restore() {
        cancel(); onReset(); loaded = false; disabled = false; failures = 0; due = 0; lastClock = null; report('browser');
      },
      stop() { cancel(); stopped = true; }
    };
  }
  const api = { createHistoryLoader, MAX_BYTES, TIMEOUT_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OverlayHistory = api;
})(typeof window !== 'undefined' ? window : globalThis);
