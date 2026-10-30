(function (root) {
  'use strict';
  const SERVICES = ['uart', 'wallbox', 'storage', 'weboverlay'];
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

  // Fail closed; never use remote error messages or secret values in the DOM.
  function parseResponse(body, service, httpOK = true, fallbackServices = null) {
    if (!object(body) || !SERVICES.includes(service)) throw new Error('invalid_response');
    if (!httpOK) throw new Error(body.status === 'conflict' ? 'conflict' : 'http_error');
    if (body.status !== 'ok' && body.status !== 'disabled') {
      throw new Error(body.status === 'conflict' ? 'conflict' : 'invalid_status');
    }
    const services = body.services === undefined ? fallbackServices : body.services;
    if (!object(services)) throw new Error('invalid_response');
    const catalog = Object.create(null);
    for (const name of SERVICES) {
      if (!object(services[name])) throw new Error('invalid_response');
      catalog[name] = Object.create(null);
      for (const [key, entry] of Object.entries(services[name])) {
        if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key) || !object(entry) ||
            typeof entry.type !== 'string' || typeof entry.secret !== 'boolean' ||
            typeof entry.readonly !== 'boolean' || !Array.isArray(entry.choices) ||
            !entry.choices.every(choice => typeof choice === 'string') ||
            ![entry.min, entry.max].every(n => n === null || Number.isFinite(n))) {
          throw new Error('invalid_response');
        }
        catalog[name][key] = { type: entry.type, min: entry.min, max: entry.max,
          secret: entry.secret, readonly: entry.readonly, choices: entry.choices.slice() };
      }
    }
    if (body.status === 'disabled') return { status: 'disabled', services: catalog };
    const snapshot = body.snapshot;
    if (!object(snapshot) || snapshot.service !== service || !object(snapshot.entries) ||
        !['ok', 'missing'].includes(snapshot.status) ||
        (snapshot.status === 'missing' ? snapshot.revision !== null :
          typeof snapshot.revision !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.revision)) ||
        typeof body.csrf !== 'string' || !body.csrf.length) throw new Error('invalid_response');
    const entries = Object.create(null);
    for (const [key, definition] of Object.entries(catalog[service])) {
      const entry = snapshot.entries[key];
      if (!object(entry) || typeof entry.present !== 'boolean' || typeof entry.configured !== 'boolean' ||
          entry.secret !== definition.secret || entry.readonly !== definition.readonly ||
          (!entry.secret && entry.value !== null && typeof entry.value !== 'string')) {
        throw new Error('invalid_response');
      }
      entries[key] = { present: entry.present, configured: entry.configured,
        secret: definition.secret, readonly: definition.readonly };
      if (!definition.secret) entries[key].value = entry.value;
    }
    return { status: 'ok', services: catalog, csrf: body.csrf,
      snapshot: { status: snapshot.status, service, revision: snapshot.revision, entries } };
  }

  function createDraft(snapshot) {
    return { snapshot, edits: Object.create(null) };
  }
  function editDraft(draft, key, value, clear = false) {
    const entry = draft.snapshot.entries[key];
    if (!entry || entry.readonly || typeof value !== 'string') return;
    // Empty password fields mean unchanged. Clearing requires a separate explicit action.
    if (entry.secret ? !clear && value === '' : value === (entry.value ?? '') && entry.present) {
      delete draft.edits[key];
    } else draft.edits[key] = entry.secret && clear ? '' : value;
  }
  function changesFor(draft) {
    return Object.fromEntries(Object.entries(draft.edits).filter(([key]) =>
      own(draft.snapshot.entries, key) && !draft.snapshot.entries[key].readonly));
  }
  const api = { SERVICES, parseResponse, createDraft, editDraft, changesFor };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (!root.document) return;
  const document = root.document;
  const form = document.getElementById('env-form');
  if (!form) return;
  const serviceInput = document.getElementById('env-service');
  const fields = document.getElementById('env-fields');
  const status = document.getElementById('env-status');
  const save = document.getElementById('env-save');
  const reload = document.getElementById('env-reload');
  const create = document.getElementById('env-create');
  const drafts = new Map();
  let service = 'weboverlay', services = null, csrf = null, enabled = false;
  let active = null, generation = 0, posting = false, conflicted = false;
  function controls() {
    const draft = drafts.get(service);
    const ready = enabled && !active && !conflicted && draft && csrf;
    fields.disabled = !ready;
    create.disabled = !ready || draft.snapshot.status !== 'missing';
    save.disabled = !ready || Object.keys(changesFor(draft)).length === 0 ||
      (draft.snapshot.status === 'missing' && !create.checked);
    serviceInput.disabled = posting;
    reload.disabled = !!active;
  }
  function node(tag, text) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function render() {
    fields.replaceChildren(node('legend', 'Variablen'));
    const draft = drafts.get(service);
    for (const [key, definition] of Object.entries(services?.[service] || {})) {
      const entry = draft?.snapshot.entries[key];
      const row = node('p');
      const id = 'env-key-' + key;
      const label = node('label', key); label.htmlFor = id; row.append(label, node('br'));
      const hint = node('span', [definition.type,
        definition.min === null ? '' : 'Minimum: ' + definition.min,
        definition.max === null ? '' : 'Maximum: ' + definition.max,
        definition.choices.length ? 'Werte: ' + definition.choices.join(', ') : '',
        definition.readonly ? 'Nur lesen (Mount/Profil oder feste Vorgabe)' : '',
        entry ? (entry.present ? (entry.configured ? 'Konfiguriert' : 'Leer konfiguriert') : 'Nicht gesetzt') : 'Nicht geladen'
      ].filter(Boolean).join(' · '));
      hint.id = id + '-hint'; hint.className = 'subtle';
      const input = node('input'); input.id = id; input.name = key;
      input.type = definition.secret ? 'password' : 'text';
      input.autocomplete = 'off'; input.spellcheck = false;
      input.setAttribute('aria-describedby', hint.id);
      input.disabled = definition.readonly;
      input.readOnly = definition.readonly;
      input.value = draft && own(draft.edits, key) ? draft.edits[key] : (entry?.value ?? '');
      if (definition.secret) input.placeholder = 'Unverändert (Wert wird nicht angezeigt)';
      if (definition.type === 'integer') input.inputMode = 'numeric';
      let clear;
      if (definition.secret && !definition.readonly) {
        clear = node('input'); clear.type = 'checkbox'; clear.id = id + '-clear';
        clear.checked = !!draft && own(draft.edits, key) && draft.edits[key] === '';
        const clearLabel = node('label'); clearLabel.htmlFor = clear.id;
        clearLabel.append(clear, document.createTextNode(' ' + key + ' ausdrücklich leeren'));
        clear.addEventListener('change', () => {
          input.value = ''; input.disabled = clear.checked;
          editDraft(draft, key, '', clear.checked); controls();
        });
        input.disabled = clear.checked;
        row.append(input, node('br'), clearLabel);
      } else row.append(input);
      if (definition.choices.length && !definition.secret) {
        const list = node('datalist'); list.id = id + '-choices'; input.setAttribute('list', list.id);
        for (const choice of definition.choices) { const option = node('option'); option.value = choice; list.append(option); }
        row.append(list);
      }
      input.addEventListener('input', () => { editDraft(draft, key, input.value); controls(); });
      row.append(node('br'), hint); fields.append(row);
    }
    controls();
  }
  async function request(method, discard = false) {
    if (posting) return;
    if (active) active.abort();
    const controller = new AbortController(); active = controller;
    const token = ++generation, selected = service;
    const draft = drafts.get(selected);
    posting = method === 'POST'; enabled = false;
    status.textContent = posting ? '.env wird gespeichert …' : 'Konfiguration wird geladen …';
    controls();
    const timeout = root.setTimeout(() => controller.abort(), 8000);
    try {
      const options = { method, signal: controller.signal, cache: 'no-store', credentials: 'same-origin' };
      if (posting) {
        options.headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
        options.body = JSON.stringify({ service: selected, revision: draft.snapshot.revision,
          changes: changesFor(draft), create: create.checked && draft.snapshot.status === 'missing' });
      }
      const response = await root.fetch('/api/settings-env' + (posting ? '' : '?service=' + selected), options);
      const body = await response.json();
      if (token !== generation || selected !== service) return;
      // A POST may retain the CSRF token from GET if the backend does not rotate it.
      const parsed = parseResponse({ ...body, csrf: body.csrf ?? (posting ? csrf : undefined) }, selected, response.ok, services);
      services = parsed.services;
      enabled = parsed.status === 'ok';
      if (enabled) {
        csrf = parsed.csrf;
        if (posting || discard || !drafts.has(selected)) drafts.set(selected, createDraft(parsed.snapshot));
        else {
          const previous = drafts.get(selected);
          // Never silently rebase pending changes onto a different file revision.
          if (Object.keys(changesFor(previous)).length && previous.snapshot.revision !== parsed.snapshot.revision) {
            conflicted = true;
          } else if (!Object.keys(changesFor(previous)).length) drafts.set(selected, createDraft(parsed.snapshot));
        }
        if (discard || posting) conflicted = false;
        status.textContent = conflicted ? 'Konflikt: Änderungen erhalten; bitte neu laden.' :
          posting ? '.env gespeichert; laufende Container unverändert. Neuerstellung zum Anwenden nötig.' :
            parsed.snapshot.status === 'missing' ? 'Keine .env vorhanden. Anlegen ausdrücklich bestätigen; keine Vorgabewerte werden ergänzt.' : 'Konfiguration geladen.';
      } else {
        csrf = null;
        status.textContent = 'Konfigurationseditor noch nicht freigeschaltet';
      }
      create.checked = false;
      render();
    } catch (error) {
      if (token !== generation || selected !== service) return;
      enabled = false;
      if (error.message === 'conflict') conflicted = true;
      status.textContent = conflicted ? 'Konflikt: Änderungen erhalten; bitte neu laden.' :
        posting ? 'Speicherstand unbestätigt. Bitte neu laden.' : 'Konfiguration nicht verfügbar.';
    } finally {
      root.clearTimeout(timeout);
      if (token === generation) { active = null; posting = false; controls(); }
    }
  }
  serviceInput.addEventListener('change', () => {
    service = serviceInput.value; conflicted = false; enabled = false; create.checked = false;
    render(); request('GET');
  });
  reload.addEventListener('click', () => {
    const draft = drafts.get(service);
    if (draft && Object.keys(changesFor(draft)).length &&
        !root.confirm('Ungespeicherte Änderungen dieses Dienstes verwerfen und neu laden?')) return;
    request('GET', true);
  });
  create.addEventListener('change', controls);
  form.addEventListener('submit', event => { event.preventDefault(); if (!save.disabled) request('POST'); });
  request('GET');
})(typeof globalThis !== 'undefined' ? globalThis : this);
