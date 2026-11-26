# Projektdienste gemeinsam starten, stoppen und das Archiv prüfen

Vom Repository-Hauptverzeichnis auf dem Linux-Docker-Host: **`bash bin/stack.sh up`** startet die im lokalen Plan gewählten Dienste; **`bash bin/stack.sh stop`** stoppt sie. Das ist ein gemeinsamer *Bedieneinstieg*, kein neues Compose-Projekt. Ein Root-`docker compose up` würde unter anderem Projekt-/Volumenidentitäten und die Auflösung gleichnamiger `.env`-Schlüssel verändern. Deshalb ruft der Einstieg Compose für jedes bisherige Projekt in dessen eigenem Verzeichnis auf.

## Einmalige Übernahme durch den Betreiber

1. Bisherige Projektnamen, Verzeichnisse, `-f`-Dateien und aktive Dienste/Profile mit dem tatsächlichen Bestand vergleichen. Dasselbe Checkout am bisherigen Pfad benutzen. Bestehende Symlinks, `.env`, Secretdateien und Volumes belassen. Ein früheres manuelles `-p` **vorher identisch** als `COMPOSE_PROJECT_NAME` in der zugehörigen Dienst-`.env` hinterlegen. Nicht bloß Verzeichnisse kopieren oder Port-/Gerätenamen ändern. Bei einem Pfad-/Projektkonflikt nicht durch einen Zweitstart „reparieren“.
2. Beim ersten Aufruf legt der Einstieg die **ignorierte** Datei `bin/.env` aus `bin/stack-plan.example` an, falls sie fehlt; eine vorhandene Datei wird nie überschrieben, auch keine leere oder ungültige. Der unfreigegebene Standard enthält nur `web base`; **`up` und `build-up` verweigern den Start**, bis der Betreiber die Auswahl gegen den Bestand geprüft, angepasst und ausdrücklich `ready yes` eingetragen hat. Das gilt auch für alte Pläne ohne diese Bestätigung. `plan` darf zur Prüfung vorher laufen, bestätigt aber selbst nichts. `build`, `check`, `stop` und `archive-pin` benötigen diese Startbestätigung nicht; ihre sonstigen Prüfungen bleiben bestehen. Die Datei ist *nur* ein Plan, kein Shellskript. Pro Komponente genau eine Zeile, `#`-Kommentar auf eigener Zeile. Nur bereits eingerichtete/gewünschte Dienste eintragen. Beispiel: `web auth+history` ersetzt die Zeile `web base`, steht nicht zusätzlich dazu. SQL und MQTT-Dateiauthentifizierung sind unabhängig; ein zuvor fehlendes MQTT-Passwortfile nicht durch Aktivieren des Auth-Overlays erzwingen. Keine privaten Werte, Passwörter, Gerätepfade oder neuen Grenzwerte hier eintragen.

   | Planeintrag | Wirkung |
   |---|---|
   | `ready yes` | Bewusste Betreiberbestätigung der Betriebswahl; keine automatische Erkennung, technische Readiness oder Hardwarefreigabe. Bei Auswahländerungen erneut prüfen. |
   | `web base`, `web auth`, `web history` oder `web auth+history` | `rasppi/weboverlay`: `weboverlay`, mit vorhandener Kombination der Auth-/History-Overlays; bei aktivem HTTPS-Profil auch `https` und das **bisherige** Projektvolume `https-data`. |
   | `reader base` oder `reader auth` | `rasppi/wallbox`: bestehender `wallbox-reader`. Vorher Gerätefreigabe/Portbesitzer klären. |
   | `storage base` oder `storage auth` | `rasppi/storage`: `storage`; aktives Profil `history` nimmt `history-rollup` dazu. **Nie** `migrate`, auch nicht mit aktivem Tools-Profil. |
   | `https on` / `rollup on` | Nur wenn `web` / `storage` ausgewählt: entspricht dem früheren expliziten `--profile https` / `--profile history`. Nicht nötig bei entsprechendem `COMPOSE_PROFILES` in der jeweiligen `.env`. |
   | `uart gateway` | `rasppi`: ausschließlich dauerhaftes, bereits eingerichtetes `uart-bridge`-Gateway (`UART_MODE=gateway`, `UART_NETWORK_MODE=evse-mqtt`, `UART_RESTART_POLICY=unless-stopped`). Kein interaktiver Default/keine Firmwareaktion. |

   Fehlt eine Komponente, fasst der Einstieg deren Projekt nicht an. Der Plan ersetzt die bisherigen **CLI-Datei-/Profilauswahlen**, nicht die `.env`-Dateien. Unterstützt sind die tabellierten Produktionsdateien, keine zusätzlichen `COMPOSE_FILE`-/CLI-Sonderoverlays. Bei einer abweichenden Einrichtung **vorher stoppen und prüfen, nicht mit `base` improvisieren**. Dienst-`.env` bleibt am bisherigen Ort; die getrennten Prozesse erhalten keine global exportierten App-/Compose-Variablen. Werte, die bisher nur im Shell-Environment standen, zuerst gesichert in die zugehörige lokale Dienstkonfiguration übernehmen. Der Wrapper akzeptiert keinen Remote-Docker-Kontext. Er benötigt Bash, Linux-Standardwerkzeuge (`flock`, `timeout`, `realpath`), Docker Engine und Compose V2; keine Host-Projektpakete.
3. `bash bin/stack.sh plan` prüft das tatsächlich von Compose aufgelöste Modell (inkl. Profilen), bestehende Compose-Labels und erkennbare Portkonflikte, ohne Projektdienste zu starten. Für die Modellprüfung läuft `python:3.12-slim-bookworm` **digestgepinnt** als kurzlebiger, unprivilegierter Container ohne Netzwerk, Docker-Socket oder Secretmount. Beim ersten Mal muss Docker das Image beziehen können. Die Compose-JSON kann sensible Werte enthalten; sie fließt nur über stdin, wird weder gedruckt noch als Datei gespeichert. Nicht `set -x`, `compose config`-Dumps oder vollständiges `docker inspect` teilen. Externe Broker/DB, Netze/Aliase, erforderliche Mounts, Rollen/Schemata und das private Backup müssen bereits nach [Installation](installation.md) vorbereitet sein. Keine Migration, Änderung der Site-Freigaben, Flash- oder Hardwaretests durch den Wrapper.

## Betrieb

**Eine Konfiguration pro Aufruf.** Den Einstieg als normalen Betreiber mit lokalem Docker-Zugriff aufrufen, nicht mit `sudo`. Er öffnet jede ausgewählte Dienst-`.env` einmal und hält ihre Interpolationswerte für diesen Aufruf in einem privaten Linux-tmpfs (`/dev/shm`, Verzeichnis 0700, Dateien 0400). Unterstützt: fehlende Datei (leere Eingabe), reguläre lokale Datei bis 64 KiB oder der genaue absolute Link des Settings-Setups. Compose bekommt **bei jedem** Aufruf denselben rolleneigenen Snapshot per `--env-file`; `-f`, Projektverzeichnis, relative Secretmounts, Profile und Volumen bleiben projektspezifisch. Ein paralleles atomares Speichern im Webeditor ändert damit nicht nach der Geräteprüfung die Eingabe für `up`. Verschiedene Rollen werden nacheinander erfasst, nicht in einer gemeinsamen Transaktion. Änderungen erscheinen im nächsten Aufruf. Währenddessen weder Compose-Dateien, Secretmounts und Gerätelinks austauschen noch die Dienstdatei manuell *in place* überschreiben. Keine private Datei auf stdout oder in ein Image kopieren.

Der Snapshotpfad in einem Compose-Label ist kein dauerhaftes Konfigurationsfile. Nach normalem Ende löscht der Wrapper seine Snapshots. Bleibt das Verzeichnis nach Prozessabbruch belegt, stoppt er, statt fremde Inhalte zu verwenden. Betreiber prüft, dass kein Aufruf mehr läuft, und entfernt ausschließlich seine verwaisten vier benannten Rollen-Dateien und das leere Verzeichnis; nicht ausgeben. Den bestehenden Einzelprojektaufruf weiterhin mit der ursprünglichen Dienst-`.env` verwenden. Für diesen Checkout denselben Betreiber verwenden.

```bash
bash bin/stack.sh plan       # Plan/Bestandskonflikte vorab prüfen
bash bin/stack.sh build      # alle fünf Stack-Laufzeitimages, unabhängig von der Betriebswahl
bash bin/stack.sh up         # Start/Abgleich; mit vorhandenen Images, fehlende baut Compose
bash bin/stack.sh check      # separat nach Docker-/Hostneustart und nach Konfigurationsänderungen
bash bin/stack.sh stop       # stop statt down: Container/Volumes bleiben bestehen
```

`build` baut ohne Start, Stop oder Recreate von Projektdiensten **immer alle fünf Stack-Laufzeitimages**: Storage (auch für Rollup/Migration), Website, HTTPS, Reader und UART. Dafür muss der Betriebsplan weder erweitert noch freigegeben werden; der frische Standardplan genügt. HTTPS wird ausdrücklich als Buildziel gewählt, auch ohne `https on`. Der Build verwendet für im Plan enthaltene Rollen deren gewählte Compose-Overlays, für ausgelassene Rollen die Basisdatei, und ausschließlich synthetische Interpolationswerte statt Dienst-`.env` und Secrets. Geräte, private Mountquellen und externe Netze müssen nicht existieren. Er aktiviert keine Tools-/Migrationsdienste; Dockerfile-Buildprüfungen laufen im Build. Firmware ist kein Stack-Laufzeitdienst: ESP32-Targetcompile und Artefakte bleiben im getrennten Firmware-Dockerworkflow, ohne Upload.

Dienst-`.env`-Profile und Produktionsprojektnamen werden beim reinen Build nicht eingelesen. Die Images tragen die Compose-Standardtags. Bei abweichenden lokalen Projektnamen baut `build-up` die ausgewählten Dienste unter den wirksamen Namen und startet sie. Für alle UART-Buildwege begrenzt `rasppi/.dockerignore` den Kontext auf Dockerfile, Requirements, beide Programme und die Gateway-Tests. Keine Standortdateien im Kontext. Vor dem Start: `plan`, Bestandsabgleich und `ready yes`.

`build-up` statt `up` erzwingt den Imagebuild für die ausgewählten Dienste vor deren jeweiligem Start. Reihenfolge beim Start: Storage, Website, Reader, UART; Stop in umgekehrter Reihenfolge. Nicht atomar: Schlägt ein Projekt oder die nachgeschaltete Prüfung fehl, bleiben zuvor gestartete Dienste laufen. Keine stillen Rollbacks, Zwangsneustarts, Orphanentfernung, Volumeoperationen oder Wiederholung von Ladebefehlen. Start/Stop kann die laufende Erfassung/Regelung unterbrechen; nur koordiniert bedienen. Der Wrapper prüft keine elektrische Sicherheit, keine Firmware und keine mechanische Verriegelung. `check` ist kein Ladevorgang und lauscht nicht dauerhaft. Für eine wiederholte Kontrolle den lesenden Aufruf z. B. aus der **bestehenden** Betriebsüberwachung nach Neustarts ausführen und dessen Exitcode auswerten. Docker-Zugriff bleibt ein privilegiertes **Betreiberrecht**; keine Docker-Socketfreigabe an die Website oder einen neuen Dienst.

Ein Verzeichnislock verhindert parallele Wrapperaufrufe dieses Checkouts. Vorhandene gleichnamige Compose-Dienste mit anderem Projekt/Pfad, aktive Einmalcontainer und erkannte kollidierende Docker-Gerätezuordnungen blockieren den Start. Das ersetzt keine Kontrolle von Hostprozessen (z. B. `mbpoll`), privilegierten Containern, ungewöhnlichen Geräte-Bindmounts oder konkurrierenden manuellen Starts: den seriellen Port immer genau einem Prozess überlassen. Der Wrapper übernimmt keine Fremdcontainer. Bei einer nicht mehr auflösbaren Projektkonfiguration den bekannten Einzelprojektablauf für einen koordinierten manuellen Stop nutzen; nie pauschal andere Projekte oder den externen Broker/DB-Server herunterfahren.

## Isolierte Betriebsprüfungen

Der gemeinsame Einstieg ist im [Installationsguide](installation.md) beschrieben. Eine Änderung am Plan invalidiert den Archivpin: erst die Auswahl bestätigen, danach bei vollständigem Sollzustand neu freigeben.

`tests/stack/isolated-ci.sh` verwendet ausschließlich getrackte **Arbeitsbaumdateien**, keine ignorierten privaten Dateien und nicht einen möglicherweise veralteten `HEAD`. Der dedizierte GitHub-Linuxrunner muss anfangs containerleer sein. Er prüft den frischen unfreigegebenen Plan, alle fünf Buildimages, explizite Overlays, unveränderte/ungültige/leere Bestandspläne, Startverweigerung ohne Bestätigung und später einen reinen Build bei laufender synthetischer Installation. Dabei müssen Container-IDs, Startzeitpunkte, Restartzähler, Mounts, Netzendpunkte und Portbindungen unverändert bleiben; eine absichtlich unbrauchbare Dienst-Dateiauswahl darf den Build nicht beeinflussen. Die bestehenden Start-/Stop-/Wiederkehr-, Overlay-, Geräte- und SQL-Assertions bleiben bestehen. Nicht auf einem Produktionsdaemon oder durch gefälschte Runnerkennungen ausführen.

**Historischer Lauf 45901462425 (`cbf15d4`):** Der Stackjob bestand, der erste Start des installierten Boothelfers schlug fehl. Der Diagnoselauf `45904974635` meldete für den Hauptprozess Exitcode 127. Die Abschlussnachweise stehen bei A1/E1 der [Aufgabencheckliste](aufgaben-checkliste.md).

## Wenn das Archiv nach einem Neustart fehlt

`check` unterscheidet folgende Nachweise. Ein Widerspruch führt zu Exitcode ungleich null, **nicht** zu automatischer Netzwerkreparatur:

1. **Gewünschtes Modell:** Aktiviertes Webarchiv benötigt das History-Overlay mit eigenem readonly Passwortmount und separatem externem DB-Netz. MQTT samt Alias `weboverlay` und internes Webnetz bleiben erhalten. Bei ausgewähltem Storage und Webarchiv müssen beide denselben wirksamen externen DB-Netznamen verwenden.
2. **Realer Zustand:** Container muss laufen. Bei Reader/UART müssen gewünschtes und tatsächlich gemapptes Hostgerät dieselbe Zeichengerätekennung haben, das Ziel muss `/dev/ttyWallbox` bzw. `/dev/serial0` sein, und `stat` **im Container** muss dort dieselbe Major-/Minor-Kennung ergeben. Das öffnet den Port nicht und prüft weder Verkabelung noch Kommunikation. Für Website mit Archiv, Storage und ausgewählten Rollup vergleicht der Check die tatsächlichen Netzwerk-Endpoint-IDs mit der aktuellen ID des konfigurierten DB-Netzes. Ein gleich lautender Name im YAML reicht nicht.
3. **Lesende API:** Im laufenden Websitecontainer je ein lokaler HTTP-GET auf `/api/history?minutes=1` und `/api/house-history?minutes=1`: HTTP 200, passender Status `ok` bzw. absichtlich `disabled`, Lese-Kennzeichen und Schema 1/3. Drei begrenzte Versuche pro Endpunkt, maximal 1 MiB pro Antwort, 4,5 s HTTP-Timeout plus äußere `docker exec`-Frist. Nur der Status wird gemeldet. Ein `ok` mit leerem Zeitfenster ist gültig, beweist aber weder vorhandene ältere Messwerte, fertige Kalenderaggregation noch einen gesunden Collector. Die gewöhnliche HTTP-Liveness `/healthz` bleibt DB-unabhängig; der Wrapper ändert keine Healthchecks/Restartpolitik.

`check` belegt nicht die Erreichbarkeit vom Browser. Unter Engine 29.1.3 fehlte die Hostveröffentlichung beim früher ausschließlich intern vernetzten HTTPS-Proxy. Der optionale Proxy nutzt dafür jetzt zusätzlich seine eigene Projektbridge `https-bind` ohne IP-Masquerading; er bleibt vom DB-/MQTT-Netz getrennt. Nach bewusster Neuerstellung `docker compose port https 8443` und `/healthz` über die vorgesehene Adresse vom Client mit vertrauter CA prüfen. Die Bindadresse nicht pauschal erweitern.

**Konfigurationsfehler:** ursprüngliche Overlay-Auswahl, `DB_NETWORK`, bestehende Web-/Storage-`.env` und Dateibereitstellung überprüfen; `WEB_HISTORY_ENABLED=1` allein stellt keine Netzwerkverbindung her. **Reale Mitgliedschaft fehlt:** gültigen Plan, Netzexistenz und die konfigurierte externe MariaDB-Zuordnung samt Alias beim Betreiber prüfen. Nach Freigabe nur den betroffenen Projektclient mit **derselben** Produktionsdateiauswahl neu erstellen, z. B. bei `web auth+history`:

```bash
(cd rasppi/weboverlay && docker compose -f compose.yaml -f compose.auth.yaml -f compose.history.yaml up -d --no-deps --force-recreate weboverlay)
bash bin/stack.sh check
```

Ohne Dateiauth das `-f compose.auth.yaml` weglassen. `up` ohne `--force-recreate` muss eine extern getrennte Mitgliedschaft bei unverändertem Modell nicht reparieren. **Netz bestätigt, API nicht bereit:** separat DB-Verfügbarkeit, Aliasauflösung aus dem Webnetzkontext, Grants, Schemata und Secretmount prüfen; der Check diagnostiziert daraus kein bestimmtes Passwortproblem. Keine Migrations-/Restore-/Löschaktion als vermeintliche Netzwerkreparatur. Externe Infrastruktur niemals ungefragt verschieben oder neu erstellen.

## Optional: Nur den verlorenen Website-Archivanschluss beim Boot wiederherstellen

Ohne Einrichtung passiert nichts. Diese **Host-systemd-Oneshot-Unit** dient nur einem bereits korrekt laufenden und vollständig verbundenen Webarchiv auf lokalem, rootful Docker (`unix:///var/run/docker.sock`, lokale Bridge-Netze). Der Betreiber gibt **diesen einen Container und diese drei bestehenden Netze** frei, nicht einen wechselnden Dienstnamen. Docker startet die eingerichteten Container wie bisher; die Unit startet weder Docker noch einen Projektdienst. Kein Docker-Socket im Webcontainer, kein neuer Controllercontainer, keine Installation von Projektpaketen auf dem Host.

**Einmal einrichten:** Nur einen vertrauenswürdigen, geprüften Stand übernehmen. `sudo` ist hier nötig, weil Zugriff auf die Docker-API Root-Rechten gleichkommt. Checkout, Compose-Dateien und private `.env` müssen bei jedem Boot unter denselben kanonischen Pfaden verfügbar sein. Der einfache Pfadvertrag der Unit erlaubt ASCII-Buchstaben, Ziffern, Leerzeichen, `._-/`. Kein Root- oder Remote-Docker-Kontextwechsel. Ungewöhnliche Netze, Mounts, Projektnamen, parallele/alte Projektcontainer oder abweichende Labels nicht durch Aufweichen der Prüfung übernehmen.

Freigabeformat **EVSE-ARCHIVE-2** bindet außerdem die Nicht-Root-UID und primäre Nicht-Root-GID des Betreibers. V1-Freigaben vor der Verwendung neu erstellen. Der Hash-Leser am Boot startet über `/usr/bin/setpriv` (util-linux) unter diesen Kennungen, **ohne Zusatzgruppen, Capabilities oder Checkout-Code**. Der Betreiber muss die regulären Konfigurationsdateien auch ohne Zusatzgruppen lesen können (beim offiziellen Settings-Setup dient die primäre Betreibergruppe dafür). Nur der genaue Web-Settings-Link oder die reguläre bisherige Web-`.env` bzw. ihr Fehlen sind zulässig; Compose-Dateien und Plan müssen regulär sein, keine beliebigen Symlinks/Hardlinks, maximal 64 KiB pro Datei. Keine Dateien für andere Benutzer lesbar machen, um diese Prüfung zu umgehen. Die Unit und `/usr/local/libexec/evse-archive-link` sowie deren Installationsverzeichnisse müssen root-kontrolliert bleiben.

```bash
# Aus dem bestehenden Checkout, im Wartungsfenster. Bei Fehler NICHT installieren.
(
  set -eu
  umask 077
  candidate=$(mktemp); trap 'rm -f -- "$candidate"' EXIT
  bash bin/stack.sh check
  bash bin/stack.sh archive-pin > "$candidate"
  sudo install -d -m 0755 /usr/local/libexec
  sudo install -d -m 0700 /etc/evse-archive-link /etc/evse-archive-link/docker-config
  sudo install -o root -g root -m 0755 bin/archive-link.sh /usr/local/libexec/evse-archive-link
  sudo install -o root -g root -m 0600 "$candidate" /etc/evse-archive-link/expected.new
  sudo mv -T /etc/evse-archive-link/expected.new /etc/evse-archive-link/expected
  sudo install -o root -g root -m 0644 bin/evse-archive-link.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now evse-archive-link.service
)
sudo journalctl -u evse-archive-link.service -b --no-pager
```

`archive-pin` ändert **keinen** Projektcontainer. Es prüft das aufgelöste Modell, den aktuellen Compose-Servicehash gegen das Containerlabel, die genaue Dateiauswahl, laufende Container-ID, Mounts sowie die beidseitigen Endpunkte und Website-Aliase. Die private Freigabedatei enthält lokale Pfade, IDs und Hashes, keine Passwörter oder `.env`-Inhalte. Nicht teilen oder einchecken. Bei jeder Änderung am Plan, an Web-`.env` oder einer der drei Web-Compose-Dateien sowie nach Container-/Netzneuerstellung gilt die alte Freigabe nicht mehr. Vor Wartung deaktivieren; korrekt bereitstellen, `check` und Einrichtung erneut durchführen. Der Projekt-/Hashvergleich ist **keine** kryptografische Herkunftsbestätigung des Containerimages. Voraussetzung sind ein vertrauenswürdiger Docker-Host und vertrauenswürdige Administratoren.

**Beim Boot:** Nach `docker.service` läuft die installierte Kopie einmal; kein `ExecStart` aus einem beschreibbaren Checkout, kein Compose, kein Lesen der Passwortdateiinhalte. Stimmen IDs, Freigabe, Labels, Zustand und alle Anschlüsse bereits, erfolgt kein Schreibzugriff. Fehlt ausschließlich der Archivanschluss bei sonst stimmiger beidseitiger Prüfung, versucht die Unit einmal `network connect` zwischen den **vollen freigegebenen IDs** mit den Website-Aliasnamen und liest anschließend erneut. Kein Trennen, Recreate, Neustart, Secret-/Datenbankzugriff oder Hardwarebefehl. Bei nicht rechtzeitig laufendem, pausiertem, nicht gefundenem, neu erstelltem oder mehrdeutigem Container, fremdem Netz, widersprüchlichem Befund oder geändertem Plan wird nicht auf einen Namensnachfolger ausgewichen. Wird das Archiv absichtlich getrennt, **vorher die Bootreparatur deaktivieren**.

Verzeichnislock mit `stack.sh`, zwei Beobachtungen vor dem Eingriff sowie Bestätigung von Laufzeitinstanz und übrigen Endpunkten danach schützen vor üblichen Rennen. Docker bietet aber **kein atomisches „connect nur wenn noch laufend“**: Externe Docker-/Dateieingriffe während des Aufrufs können einen unklaren Ausgang hinterlassen. Ein parallel korrekt wiederhergestellter Anschluss darf als vorhanden gemeldet werden, ohne den Erfolg der Unit zuzuschreiben. Kein Retry/Rollback, auch bei 180-s-systemd-Timeout. Nur im Bootmodus wartet der Helfer bis zu 120 s auf den freigegebenen Container im Zustand `created`, `exited` oder `restarting`; er startet ihn nicht selbst und verbindet vorher kein Netz. Pausierte oder ersetzte Container bleiben gesperrt. Der manuelle `--reconcile`-Aufruf wartet nicht auf einen gestoppten Container. Bei Fehler, zu frühem Bootzeitpunkt oder noch nicht laufender Website Journal und `stack.sh check` prüfen. Nach Klärung ggf. einzeln `sudo systemctl start evse-archive-link.service`. Es gibt **keinen Timer** und keine automatische SQL-Reparatur. Erfolg betrifft das Netz, nicht Datenbestand oder DB-Bereitschaft; nach Boot weiterhin `bash bin/stack.sh check` verwenden. Eine erfolgreiche Oneshot-Unit kann anschließend `inactive (dead)` anzeigen.

Die isolierten CI-Skripte unter `tests/stack/` verwenden ausschließlich versionierte Dateien mit ihren aktuellen Arbeitsbaumbytes, keine privaten/ignorierten Dateien. Der Bootjob enthält zusätzlich zwei echte Docker-Daemon-Stop-/Startzyklen mit unverändertem bzw. absichtlich fehlendem Archivanschluss. Das ist kein VM-/Hostneustart und kein Nachweis der ursprünglichen produktiven Fehlerursache. **Nur auf dem ausdrücklich geprüften, leeren GitHub-Wegwerfhost ausführen**, niemals auf einem gemeinsam genutzten oder produktiven Docker-Host. Der SQL-Job vergleicht feste synthetische Wallbox- und HOUSE-Beobachtungen über Netz-/DB-Ausfall und Wiederanlauf; erfolgreich leer, deaktiviert und nicht verfügbar bleiben unterschiedliche Ergebnisse. Die Existenz dieser Regressionen ersetzt keinen erfolgreichen Lauf am jeweiligen Arbeitsstand.

Auch wenn der Endpunkt bereits vorhanden ist oder zwischen den Beobachtungen wieder auftaucht, werden Konfigurationsfingerabdruck und Laufzeitinstanz vor der Erfolgsmeldung erneut geprüft. Das verkleinert das Beobachtungsfenster, ersetzt aber keine atomare Docker-Operation.

**Deaktivieren:** `sudo systemctl disable --now evse-archive-link.service`. Das verhindert weitere Bootaufrufe, trennt kein Netz und stoppt keinen Projektcontainer. Zur vollständigen Entfernung anschließend nur die installierten Dateien entfernen und `sudo systemctl daemon-reload` ausführen:

```bash
sudo rm -f /etc/systemd/system/evse-archive-link.service /usr/local/libexec/evse-archive-link /etc/evse-archive-link/expected
sudo rmdir /etc/evse-archive-link/docker-config /etc/evse-archive-link   # nur wenn leer
sudo systemctl daemon-reload
```
