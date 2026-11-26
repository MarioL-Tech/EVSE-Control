(function (root) {
  'use strict';
  const SERVICES = ['uart', 'wallbox', 'storage', 'weboverlay'];
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const descriptions = {
    UART_DEVICE: ['Serielles Gerät', 'Gerätepfad der Verbindung zwischen Pi und ESP32.'],
    UART_MODE: ['Betriebsart', 'Interaktives Terminal oder MQTT-Gateway für den ESP32.'],
    UART_RESTART_POLICY: ['Neustartverhalten', 'Die Compose-Konfiguration bestimmt, ob der Container neu startet.'],
    UART_NETWORK_MODE: ['UART-Netzwerk', 'Legt die Netzwerkanbindung des UART-Containers fest.'],
    MQTT_ENABLED: ['MQTT aktivieren', 'Schaltet die MQTT-Anbindung des Readers ein oder aus.'],
    MQTT_HOST: ['Broker-Adresse', 'Hostname oder IPv4-Adresse des vorhandenen MQTT-Brokers.'],
    MQTT_PORT: ['Broker-Port', 'TCP-Port, auf dem der vorhandene MQTT-Broker erreichbar ist.'],
    MQTT_USERNAME: ['Broker-Benutzer', 'Benutzername für die Anmeldung am MQTT-Broker.'],
    MQTT_PASSWORD: ['Broker-Passwort', 'Passwort für die Broker-Anmeldung. Nicht gleichzeitig mit einer Passwortdatei verwenden.'],
    MQTT_CLIENT_ID: ['Client-Kennung', 'Eindeutiger Name dieses Dienstes am Broker; nicht für andere Clients wiederverwenden.'],
    ESP32_MQTT_CLIENT_ID: ['Gateway-Kennung', 'Eindeutiger Name des UART-Gateways am Broker.'],
    MQTT_TOPIC_PREFIX: ['Wallbox-Topic', 'Gemeinsamer MQTT-Themenpräfix für Wallboxdaten.'],
    ESP32_MQTT_TOPIC_PREFIX: ['Gateway-Topic', 'Gemeinsamer Themenpräfix für die ESP32-Anbindung.'],
    WALLBOX_MQTT_TOPIC_PREFIX: ['Wallbox-Messdaten', 'Themenpräfix für den Ladespiegel aus den Wallboxdaten.'],
    WALLBOX_DEVICE: ['RS485-Gerät', 'Gerätepfad des Wallbox-Adapters auf dem Docker-Host.'],
    WALLBOX_PORT: ['Gerät im Container', 'Innerer Gerätepfad für die Modbus-Verbindung.'],
    WALLBOX_BAUD: ['Baudrate', 'Übertragungsrate passend zur seriellen Konfiguration der Wallbox.'],
    WALLBOX_PARITY: ['Parität', 'Fehlerprüfbit der seriellen Verbindung: N = keine, E = gerade, O = ungerade.'],
    WALLBOX_SLAVE: ['Modbus-Adresse', 'Adresse der Wallbox auf dem RS485-Bus.'],
    WALLBOX_INTERVAL_MS: ['Abfrageintervall (ms)', 'Zeitabstand der Messwertabfragen. Der Antworttimeout muss kürzer sein.'],
    WALLBOX_TIMEOUT_MS: ['Antworttimeout (ms)', 'Maximale Wartezeit auf die Geräteantwort, kürzer als das Abfrageintervall.'],
    WALLBOX_INSTALLATION_MAX_MA: ['Installationsgrenze (mA)', 'Nur den ausdrücklich freigegebenen Höchststrom der Installation eintragen. Kein Wert wird aus der Gerätegrenze abgeleitet.'],
    WALLBOX_AUTOMATION_WEB_URL: ['Regler-Verbindung', 'Webadresse der Reglerdaten für den Reader. Leer deaktiviert den Abruf.'],
    DB_HOST: ['Datenbankserver', 'Hostname oder IPv4-Adresse der vorhandenen MariaDB für die Aufzeichnung.'],
    DB_PORT: ['Datenbankport', 'TCP-Port des Datenbankservers.'],
    DB_NAME: ['Datenbankname', 'Name des Schemas für die Aufzeichnung.'],
    DB_USERNAME: ['Schreibkonto', 'Datenbankkonto des Speichercollectors.'],
    DB_MIGRATION_USERNAME: ['Migrationskonto', 'Datenbankkonto für die ausdrücklich gestartete Schema-Einrichtung.'],
    DB_PASSWORD: ['Datenbankpasswort', 'Dieser Dienst verwendet eine außerhalb des Editors bereitgestellte Passwortdatei.'],
    DB_TIMEOUT_SECONDS: ['Datenbanktimeout (s)', 'Maximale Wartezeit für den Datenbankzugriff.'],
    DB_NETWORK: ['Datenbanknetz', 'Docker-Netzwerk, über das der Dienst die vorhandene MariaDB erreicht.'],
    STORAGE_QUEUE_SIZE: ['Puffergröße', 'Obergrenze für die Anzahl wartender Speicheraufträge.'],
    STORAGE_RECORDING_MODE: ['Aufzeichnungsart', 'Rohmessungen oder Minutenprodukte. Eine Dateibearbeitung führt keine Datenbankmigration aus.'],
    WEB_PORT: ['HTTP-Port', 'Port für den Browserzugriff ohne TLS.'],
    WEB_BIND_ADDRESS: ['Bindungsadresse', 'Lokale IPv4-Adresse, auf der der Docker-Host die Website anbietet.'],
    WEB_HTTPS_PORT: ['HTTPS-Port', 'Port für den verschlüsselten Browserzugriff bei eingerichtetem HTTPS-Profil.'],
    WEB_TLS_HOST: ['Zertifikatsname', 'Hostname für lokales HTTPS. Leer verwendet die Bindungsadresse.'],
    WEB_STALE_SECONDS: ['Wallbox-Frische (s)', 'Maximales Alter, bis die Website Wallboxwerte als veraltet behandelt.'],
    WEB_HISTORY_ENABLED: ['Wallboxarchiv lesen', '1 erlaubt den historischen SQL-Abruf; 0 deaktiviert ihn.'],
    WEB_HOUSE_HISTORY_ENABLED: ['Hausarchiv lesen', '1 erlaubt den SQL-Abruf der Haus-Netzleistung; 0 deaktiviert ihn.'],
    HISTORY_DB_HOST: ['Archivserver', 'Datenbankserver für den lesenden Zugriff der Website.'],
    HISTORY_DB_PORT: ['Archivport', 'TCP-Port der Archivdatenbank.'],
    HISTORY_DB_NAME: ['Archivdatenbank', 'Schema mit den aufgezeichneten Messwerten.'],
    HISTORY_DB_USERNAME: ['Archiv-Lesekonto', 'Datenbankkonto für den lesenden Archivzugriff.'],
    SMARTMETER_STALE_SECONDS: ['Zähler-Frische (s)', 'Maximales Abrufalter, bis die Website die Haus-Netzleistung als veraltet behandelt.'],
    SMARTMETER_URL: ['Zähleradresse', 'Private HTTP(S)-Adresse der Haus-Netzleistung. Leer deaktiviert den Abruf.'],
    SMARTMETER_POLL_SECONDS: ['Zählerabfrage (s)', 'Zeitabstand der HTTP-Abrufe vom Hauszähler.'],
    SMARTMETER_TIMEOUT_SECONDS: ['Zähler-Timeout (s)', 'Maximale Wartezeit je HTTP-Abruf.'],
    HOUSE_HISTORY_SOURCE: ['Hausarchiv-Quelle', 'Quellkennung der Haus-Netzleistung im SQL-Archiv.'],
    HOUSE_MQTT_TOPIC_PREFIX: ['Frühere Hauskennung', 'Alte Quellenzuordnung für bereits vorhandene Hausarchivdaten.'],
    COMPOSE_PROFILES: ['Compose-Profile', 'Bereitgestellte Zusatzprofile beeinflussen Dienste und Mounts.']
  };
  function presentation(key, def) {
    const retention = /^STORAGE_RETENTION_(MINUTE|HOUR|DAY)_DAYS$/.exec(key);
    const [title, note] = descriptions[key] || (retention ? [
      ({ MINUTE: 'Minutendaten', HOUR: 'Stundendaten', DAY: 'Tagesdaten' })[retention[1]] + ' aufbewahren (Tage)',
      '0 bedeutet unbegrenzt. Gröbere Stufen dürfen nicht kürzer aufbewahrt werden als ihre Grundlage.'
    ] : def.type === 'mount' ? [key.includes('HOST_FILE') ? 'Passwortdatei auf dem Host' : 'Passwortdatei im Container',
      'Dateipfad und Inhalt bleiben privat. Der Mount wird außerhalb des Browsers eingerichtet.'] : [key, 'Konfiguration für diesen Dienst.']);
    const group = /MQTT/.test(key) && !key.startsWith('HOUSE_') ? 'MQTT-Verbindung' : /^(UART|WALLBOX)_/.test(key) ? 'Gerät & Regelung' :
      /^(SMARTMETER|HOUSE)_/.test(key) ? 'Hauszähler' : /^(DB|HISTORY_DB)_/.test(key) ? 'Datenbank' :
      /^(STORAGE_|WEB_(HOUSE_)?HISTORY)/.test(key) ? 'Aufzeichnung & Archiv' : key.startsWith('WEB_') ? 'Website' : 'Bereitstellung';
    return { title, note, group };
  }
  const INTEGER_EXAMPLES = { WEB_PORT: 8081, WEB_HTTPS_PORT: 8443, MQTT_PORT: 1884, DB_PORT: 3307, HISTORY_DB_PORT: 3307,
    WALLBOX_TIMEOUT_MS: 800, WALLBOX_INTERVAL_MS: 2500, WALLBOX_SLAVE: 12, WALLBOX_INSTALLATION_MAX_MA: 12000,
    SMARTMETER_POLL_SECONDS: 4, SMARTMETER_TIMEOUT_SECONDS: 3, WEB_STALE_SECONDS: 15, SMARTMETER_STALE_SECONDS: 15,
    STORAGE_QUEUE_SIZE: 128, DB_TIMEOUT_SECONDS: 4, STORAGE_RETENTION_MINUTE_DAYS: 30, STORAGE_RETENTION_HOUR_DAYS: 180, STORAGE_RETENTION_DAY_DAYS: 730 };
  function placeholder(def, key) {
    if (def.readonly) return def.secret ? 'Wert verborgen' : 'Nur lesen';
    if (def.secret) return def.type === 'url' ? 'z. B. https://dienst.example/pfad' : 'Leer = unverändert';
    const samples = { host: 'dienst.example', 'optional-host': 'station.example', identifier: 'dienst-a', topic: 'anlage/messwerte',
      database: 'Messarchiv', network: 'anlagennetz', ipv4: '192.0.2.10', device: '/dev/beispiel', text: 'betrieb' };
    if (def.type === 'integer') {
      const sample = INTEGER_EXAMPLES[key];
      return 'z. B. ' + (Number.isInteger(sample) && sample >= def.min && sample <= def.max ? sample : Math.floor((def.min + def.max) / 2));
    }
    return samples[def.type] ? 'z. B. ' + samples[def.type] : 'Nicht gesetzt';
  }
  function problemFor(def, value) {
    const bytes = new TextEncoder().encode(value).length;
    if (bytes > 4096 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029'"\\$`]/u.test(value)) return 'Zu lang oder für eine .env-Datei unzulässige Zeichen.';
    const ipv4 = s => s.split('.').length === 4 && s.split('.').every(v => /^(0|[1-9]\d{0,2})$/.test(v) && +v <= 255);
    const host = s => s.length <= 253 && (/^[\d.]+$/.test(s) ? ipv4(s) : s.split('.').every(x => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(x)));
    switch (def.type) {
    case 'integer': return /^\d{1,10}$/.test(value) && +value >= def.min && +value <= def.max ? '' : `Ganze Zahl zwischen ${def.min} und ${def.max} eingeben.`;
    case 'enum': return def.choices.includes(value) ? '' : 'Bitte einen aufgeführten Wert auswählen.';
    case 'topic': return bytes <= 240 && /^[a-z\d_.:-]+(?:\/[a-z\d_.:-]+)*$/i.test(value) ? '' : 'Topic ohne Leerzeichen, Platzhalter oder leere Abschnitte eingeben.';
    case 'identifier': return bytes >= def.min && bytes <= def.max && /^[a-z\d_.@:-]+$/i.test(value) ? '' : 'Kennung ohne Leerzeichen eingeben (Buchstaben, Ziffern, _.@:-).';
    case 'database': return /^[a-z][a-z\d_]{0,63}$/i.test(value) ? '' : 'Mit einem Buchstaben beginnen; höchstens 64 Buchstaben, Ziffern oder Unterstriche.';
    case 'device': return bytes <= 240 && !value.includes('..') && /^\/dev\/(?:[a-z\d_-]+\/)*[a-z\d_.-]+$/i.test(value) ? '' : 'Gültigen Gerätepfad unter /dev/ eingeben.';
    case 'network': return /^[a-z\d][a-z\d_.-]{0,127}$/i.test(value) ? '' : 'Gültigen Docker-Netzwerknamen eingeben.';
    case 'host': case 'optional-host': return (def.type === 'optional-host' && value === '') || host(value) ? '' : 'Hostname oder gültige IPv4-Adresse ohne Port eingeben.';
    case 'ipv4': return ipv4(value) ? '' : 'IPv4-Adresse mit vier Zahlen von 0 bis 255 eingeben.';
    case 'url': {
      if (value === '') return '';
      const m = /^https?:\/\/([^\s/:?#@]+)(?::(\d+))?(?:[/?][^\s#]*)?$/i.exec(value);
      return bytes <= 2048 && m && host(m[1]) && (!m[2] || (+m[2] >= 1 && +m[2] <= 65535)) ? '' : 'HTTP(S)-Adresse ohne Zugangsdaten oder Fragment eingeben.';
    }
    case 'text': return bytes >= def.min && bytes <= def.max ? '' : `Erlaubte Länge: ${def.min} bis ${def.max} Bytes.`;
    default: return 'Dieser Typ kann hier nicht bearbeitet werden.';
    }
  }

  // Fail closed; never use remote error messages or secret values in the DOM.
  function parseResponse(body, service, httpOK = true, fallbackServices = null) {
    if (!object(body) || !SERVICES.includes(service)) throw new Error('invalid_response');
    if (!httpOK) throw new Error(['conflict', 'invalid'].includes(body.status) ? body.status : 'http_error');
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
  // Only compare known draft/file values. The server remains authoritative for
  // runtime fallbacks, conditions involving mounts, and the current revision.
  function relatedProblems(draft) {
    const result = Object.create(null), entries = draft.snapshot.entries, edits = draft.edits;
    const value = k => own(edits, k) ? edits[k] : entries[k]?.value;
    const knownInt = k => /^\d{1,10}$/.test(value(k) ?? '') ? Number(value(k)) : null;
    const flag = (keys, msg) => { for (const key of keys) if (own(edits, key)) result[key] = msg; };
    if (draft.snapshot.service === 'wallbox') {
      const keys = ['WALLBOX_TIMEOUT_MS', 'WALLBOX_INTERVAL_MS']; const [timeout, interval] = keys.map(knownInt);
      if (timeout !== null && interval !== null && timeout >= interval) flag(keys, 'Der Antworttimeout muss kürzer sein als das Abfrageintervall.');
    }
    if (draft.snapshot.service === 'storage') {
      const keys = ['MINUTE', 'HOUR', 'DAY'].map(k => `STORAGE_RETENTION_${k}_DAYS`);
      for (let i = 0; i < 2; i++) {
        const pair = keys.slice(i, i + 2), [fine, coarse] = pair.map(knownInt);
        if (fine !== null && coarse > 0 && (!fine || fine > coarse)) flag(pair, 'Gröbere Stufen mindestens so lange aufbewahren wie feinere (0 = unbegrenzt).');
      }
    }
    return result;
  }
  const api = { SERVICES, parseResponse, createDraft, editDraft, changesFor, placeholder, problemFor, presentation, relatedProblems };
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
  const openGroups = new Map(), blocked = new Map();
  let service = 'weboverlay', services = null, csrf = null, enabled = false;
  let active = null, generation = 0, posting = false, conflicted = false;
  function controls() {
    const draft = drafts.get(service);
    const ready = enabled && !active && !conflicted && draft && csrf;
    fields.disabled = !ready;
    document.getElementById('env-create-row').hidden = !draft || draft.snapshot.status !== 'missing';
    create.disabled = !ready || draft.snapshot.status !== 'missing';
    save.disabled = !ready || Object.keys(changesFor(draft)).length === 0 ||
      (draft.snapshot.status === 'missing' && !create.checked) || !!fields.querySelector('[aria-invalid="true"]');
    serviceInput.disabled = posting;
    reload.disabled = !!active;
  }
  function feedback() {
    const draft = drafts.get(service); if (!draft || !enabled || active || conflicted) return;
    const edits = Object.keys(changesFor(draft));
    const invalid = fields.querySelector('[aria-invalid="true"]');
    const text = invalid ? 'Ungespeichert. Markierte Eingaben prüfen.' : edits.length ?
      `${edits.length} ${edits.length === 1 ? 'Änderung' : 'Änderungen'} ungespeichert.` + (draft.snapshot.status === 'missing' && !create.checked ? ' Anlegen der Datei bestätigen.' : '') :
      draft.snapshot.status === 'missing' ? 'Keine .env vorhanden.' : 'Konfiguration geladen.';
    if (status.textContent !== text) status.textContent = text;
  }
  function node(tag, text) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function render() {
    const legend = node('legend', 'Variablengruppen'); legend.className = 'sr-only'; fields.replaceChildren(legend);
    const draft = drafts.get(service);
    const groups = new Map(), validators = [], current = service;
    const validate = () => {
      const related = draft ? relatedProblems(draft) : {};
      for (const check of validators) check(related);
      for (const grid of groups.values()) {
        const count = grid.querySelectorAll('.is-edited').length, badge = grid.previousElementSibling.lastElementChild;
        const text = count ? (grid.querySelector('[aria-invalid=true]') ? 'Eingaben prüfen' : `${count} geändert`) : '';
        if (badge.textContent !== text) badge.textContent = text;
        badge.hidden = !count;
      }
    };
    if (!openGroups.has(current)) openGroups.set(current, new Set());
    const expanded = openGroups.get(current);
    for (const [key, definition] of Object.entries(services?.[service] || {})) {
      const entry = draft?.snapshot.entries[key];
      const { title, note, group } = presentation(key, definition);
      if (!groups.has(group)) {
        const section = node('details'); section.className = 'env-group'; section.open = expanded.has(group);
        const summary = node('summary', group), grid = node('div'); grid.className = 'settings-grid';
        const badge = node('span'); badge.className = 'group-edits'; badge.hidden = true; summary.append(badge);
        section.addEventListener('toggle', () => {
          if (section.isConnected) { if (section.open) expanded.add(group); else expanded.delete(group); }
        });
        section.append(summary, grid); fields.append(section); groups.set(group, grid);
      }
      const row = node('div'); row.className = 'setting-field env-field';
      const id = 'env-key-' + key;
      const label = node('label', title); label.htmlFor = id;
      const heading = node('div'); heading.className = 'setting-heading'; row.append(heading);
      const hint = node('span', [definition.readonly ? 'Nur lesen' : '',
        entry ? (entry.present ? (entry.configured ? 'Konfiguriert' : 'Leer konfiguriert') : 'Nicht gesetzt') : 'Nicht geladen'].filter(Boolean).join(' · '));
      hint.id = id + '-hint'; hint.className = 'setting-meta';
      const error = node('span'); error.className = 'setting-error'; error.id = id + '-error'; error.hidden = true;
      const select = definition.choices.length > 0 && !definition.secret;
      // Only the explicitly constructed JSON body may contain edits. No form
      // names that could serialize a write-only field into a navigation URL.
      const input = node(select ? 'select' : 'input'); input.id = id;
      const value = draft && own(draft.edits, key) ? draft.edits[key] : (entry?.value ?? '');
      if (select) {
        for (const choice of new Set(['', ...definition.choices, value])) {
          const option = node('option', choice || (entry?.present ? 'Leer' : 'Nicht gesetzt')); option.value = choice; input.append(option);
        }
      } else { input.type = definition.secret ? 'password' : 'text'; input.placeholder = placeholder(definition, key); }
      input.autocomplete = 'off'; input.spellcheck = false;
      input.setAttribute('aria-describedby', hint.id + ' ' + error.id);
      const range = definition.type === 'integer' ? ` Bereich: ${definition.min} bis ${definition.max}.` : '';
      heading.append(label, root.EvseSettingsUI.helpFor(title, `${note}${range} Variable: ${key}.` +
        (definition.secret ? ' Gespeicherte Werte werden nicht angezeigt.' : ''), input));
      input.disabled = definition.readonly;
      input.readOnly = definition.readonly;
      input.value = value;
      if (definition.type === 'integer') input.inputMode = 'numeric';
      validators.push(related => {
        const changed = draft && own(draft.edits, key);
        const msg = changed ? problemFor(definition, draft.edits[key]) || related[key] || '' : '';
        input.setCustomValidity(msg); if (input.getAttribute('aria-invalid') !== String(!!msg)) input.setAttribute('aria-invalid', String(!!msg));
        if (error.textContent !== msg) error.textContent = msg; error.hidden = !msg;
        row.classList.toggle('is-edited', !!changed);
      });
      row.append(input, hint, error);
      let clear;
      if (definition.secret && !definition.readonly) {
        clear = node('input'); clear.type = 'checkbox'; clear.id = id + '-clear';
        clear.checked = !!draft && own(draft.edits, key) && draft.edits[key] === '';
        const clearLabel = node('label'); clearLabel.htmlFor = clear.id;
        clearLabel.append(clear, document.createTextNode(' Gespeicherten Wert leeren'));
        clear.addEventListener('change', () => {
          input.value = ''; input.disabled = clear.checked;
          editDraft(draft, key, '', clear.checked); validate(); controls(); feedback();
        });
        input.disabled = clear.checked;
        clearLabel.className = 'env-clear'; clear.setAttribute('aria-label', title + ' ausdrücklich leeren');
        row.append(clearLabel);
      }
      input.addEventListener(select ? 'change' : 'input', () => {
        // Typing and then erasing in a previously absent input returns to
        // "not set". Only explicit secret clearing creates a blank secret.
        if (!entry?.present && input.value === '') delete draft.edits[key];
        else editDraft(draft, key, input.value);
        validate(); controls(); feedback();
      });
      groups.get(group).append(row);
    }
    validate(); controls();
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
        if (discard || posting) { conflicted = false; blocked.delete(selected); }
        if (conflicted && !blocked.has(selected)) blocked.set(selected, 'Konflikt: Änderungen erhalten; bitte neu laden.');
        status.textContent = conflicted ? blocked.get(selected) :
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
      if (posting && error.message === 'invalid') {
        enabled = true;
        status.textContent = 'Nicht gespeichert. Werte und Abhängigkeiten des Dienstes prüfen.';
      } else {
        if (error.message === 'conflict' || posting) {
          conflicted = true; blocked.set(selected, error.message === 'conflict' ? 'Konflikt: Änderungen erhalten; bitte neu laden.' : 'Speicherstand unbestätigt. Bitte neu laden.');
        }
        status.textContent = conflicted ? blocked.get(selected) : 'Konfiguration nicht verfügbar.';
      }
    } finally {
      root.clearTimeout(timeout);
      if (token === generation) {
        active = null; posting = false; controls();
        if (method === 'GET' && enabled && !conflicted && Object.keys(changesFor(drafts.get(selected))).length) feedback();
      }
    }
  }
  serviceInput.addEventListener('change', () => {
    service = serviceInput.value; conflicted = blocked.has(service); enabled = false; create.checked = false;
    render(); request('GET');
  });
  reload.addEventListener('click', () => {
    const draft = drafts.get(service);
    if (draft && Object.keys(changesFor(draft)).length &&
        !root.confirm('Ungespeicherte Änderungen dieses Dienstes verwerfen und neu laden?')) return;
    request('GET', true);
  });
  create.addEventListener('change', () => { controls(); feedback(); });
  form.addEventListener('submit', event => { event.preventDefault(); if (!save.disabled) request('POST'); });
  root.addEventListener('pagehide', () => {
    generation++;
    if (posting) {
      blocked.set(service, 'Speicherstand unbestätigt. Bitte neu laden.'); conflicted = true;
      status.textContent = blocked.get(service);
    }
    if (active) active.abort();
    active = null; posting = false; enabled = false; controls();
  });
  root.addEventListener('pageshow', event => { if (event.persisted && !active && !conflicted) request('GET'); });
  request('GET');
})(typeof globalThis !== 'undefined' ? globalThis : this);
