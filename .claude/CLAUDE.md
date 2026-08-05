# AiDex - CLAUDE.md

MCP Server für persistentes Code-Indexing. Ermöglicht Claude Code schnelle, präzise Suchen statt Grep/Glob.

**Version:** 2.2.0 | **Sprachen:** 12 | **Repo:** https://github.com/CSCSoftware/AiDex

## Build & Run

```bash
npm install && npm run build    # Einmalig
npm run build                   # Nach Code-Änderungen
```

Registriert als MCP Server `aidex` (Prefix: `mcp__aidex__aidex_*`).

**Claude Code** (`~/.claude/settings.json`):
```json
"mcpServers": {
  "aidex": {
    "command": "node",
    "args": ["Q:/develop/Tools/AiDex/build/index.js"]
  }
}
```

**Claude Desktop** (`%APPDATA%/Claude/claude_desktop_config.json`):
```json
"mcpServers": {
  "aidex": {
    "command": "C:\\Program Files\\nodejs\\node.exe",
    "args": ["Q:\\develop\\Tools\\AiDex\\build\\index.js"]
  }
}
```

**Nach Änderungen:** Build ausführen, dann Claude Code neu starten.
**MCP-Name:** Server muss als `"aidex"` registriert sein → Prefix wird `mcp__aidex__aidex_*`.

## Tools (30)

### Suche & Index
| Tool | Beschreibung |
|------|--------------|
| `aidex_init` | Projekt indexieren |
| `aidex_query` | Terme suchen (exact/contains/starts_with), Zeit-Filter |
| `aidex_status` | Index-Statistiken |
| `aidex_update` | Einzelne Datei neu indexieren |
| `aidex_remove` | Datei aus Index entfernen |

### Signaturen (statt Read!)
| Tool | Beschreibung |
|------|--------------|
| `aidex_signature` | Datei-Signatur (Types + Methods) |
| `aidex_signatures` | Mehrere Dateien (Glob-Pattern) |

### Projekt-Übersicht
| Tool | Beschreibung |
|------|--------------|
| `aidex_summary` | Projekt-Übersicht mit Entry Points |
| `aidex_tree` | Dateibaum mit Stats |
| `aidex_describe` | Dokumentation zu summary.md |
| `aidex_files` | Projektdateien nach Typ, `modified_since` |

### Cross-Project
| Tool | Beschreibung |
|------|--------------|
| `aidex_link/unlink/links` | Dependencies verlinken |
| `aidex_scan` | Indexierte Projekte finden |

### Session (v1.2+)
| Tool | Beschreibung |
|------|--------------|
| `aidex_session` | Session starten, externe Änderungen erkennen |
| `aidex_note` | Session-Notizen (persistiert in DB) |
| `aidex_viewer` | Browser-Explorer mit Live-Reload (v1.3) |

### Task Backlog (v1.8+)
| Tool | Beschreibung |
|------|--------------|
| `aidex_task` | Task CRUD + Log + Scheduler (due/interval/action/auto_go) |
| `aidex_tasks` | Tasks auflisten, filtern nach Status/Priority/Tag. Zeigt due-Daten + Intervalle |

Status: `backlog → active → done | cancelled`

### Log Hub (v1.16+)
| Tool | Beschreibung |
|------|--------------|
| `aidex_log` | Universal-Logging: init/free/status/query/clear/write. HTTP-Server empfängt Logs von externen Programmen |

Actions: `init` (Server starten) → `query` (Logs abfragen) → `free` (Server stoppen)

### Screenshots (v1.9+, Optimierung v1.13)
| Tool | Beschreibung |
|------|--------------|
| `aidex_screenshot` | Screenshot aufnehmen + optional optimieren (`scale`, `colors`) |
| `aidex_windows` | Offene Fenster auflisten (Helper für window-Modus) |

### Global Search (v1.11+)
| Tool | Beschreibung |
|------|--------------|
| `aidex_global_init` | Verzeichnisbaum scannen, Projekte in `~/.aidex/global.db` registrieren. `index_unindexed`: Auto-Index ≤500 Dateien. `show_progress`: Browser Progress-UI |
| `aidex_global_status` | Alle registrierten Projekte mit Stats anzeigen |
| `aidex_global_query` | Terme über ALLE Projekte suchen (ATTACH DATABASE, 5-Min Cache) |
| `aidex_global_signatures` | Methoden/Typen nach Name über alle Projekte suchen |
| `aidex_global_refresh` | Stats aktualisieren, veraltete Projekte entfernen |

## Sprachen

C# · TypeScript · JavaScript · Rust · Python · C · C++ · Java · Go · PHP · Ruby · HCL/Terraform

## Architektur

```
src/
├── index.ts              # Entry Point (MCP + CLI)
├── server/
│   ├── mcp-server.ts     # MCP Protocol
│   └── tools.ts          # Tool-Handler
├── commands/             # Tool-Implementierungen
│   ├── init.ts, query.ts, signature.ts, update.ts
│   ├── summary.ts, link.ts, scan.ts, files.ts
│   ├── session.ts, note.ts, task.ts, log.ts
│   ├── screenshot/              # Plattform-Screenshots
│   └── global/                  # Global Search (v1.11)
│       ├── global-init.ts       # Scan + Bulk-Index
│       ├── global-query.ts      # ATTACH DATABASE Queries
│       ├── global-signatures.ts # Methoden/Typen suchen
│       ├── global-status.ts     # Projekt-Übersicht
│       └── global-refresh.ts    # Stats aktualisieren
├── loghub/                      # Log Hub (v1.16)
│   ├── log-types.ts       # Shared Types
│   ├── log-buffer.ts      # Ring Buffer (FIFO)
│   └── log-server.ts      # HTTP Server Singleton (Port 3335)
├── viewer/
│   ├── server.ts         # Interactive Viewer (Port 3333)
│   └── progress.ts       # SSE Progress UI (Port 3334)
├── db/
│   ├── database.ts       # SQLite (WAL)
│   ├── queries.ts        # Prepared Statements
│   ├── schema.sql        # Projekt-DB Schema
│   └── global-database.ts # ~/.aidex/global.db
└── parser/
    ├── tree-sitter.ts    # Parser (1MB Buffer)
    ├── extractor.ts      # Identifier + Signaturen
    └── languages/        # Keyword-Filter (12 Sprachen)
```

## Datenbank-Tabellen

| Tabelle | Inhalt |
|---------|--------|
| `files` | Dateibaum (path, hash, last_indexed) |
| `lines` | Zeilen mit line_hash, modified Timestamp |
| `items` | Indexierte Terme (case-insensitive) |
| `occurrences` | Term-Vorkommen |
| `methods` | Methoden-Prototypen |
| `types` | Klassen/Structs/Interfaces |
| `signatures` | Header-Kommentare |
| `project_files` | Alle Dateien mit Typ |
| `metadata` | Key-Value (Sessions, Notizen) |
| `tasks` | Backlog-Tasks (Priority, Status, Tags, Scheduling: due/interval/action/auto_go) |
| `task_log` | Task-Historie (Auto-Log bei Änderungen) |
| `scheduled_tasks` | Global Scheduler Mirror in ~/.aidex/global.db (project_path, task_id, due) |

## Wichtige Features

### Zeit-Filter (v1.1)
```
aidex_query({ term: "render", modified_since: "2h" })
aidex_files({ path: ".", modified_since: "30m" })
```
Formate: `30m`, `2h`, `1d`, `1w`, ISO-Datum

### Session-Notizen (v1.2)
```
aidex_note({ path: ".", note: "Fix testen" })     # Schreiben
aidex_note({ path: ".", append: true, note: "+" }) # Anhängen
aidex_note({ path: "." })                          # Lesen
aidex_note({ path: ".", clear: true })             # Löschen
```

### Interactive Viewer (v1.3)
```
aidex_viewer({ path: "." })                        # http://localhost:3333
aidex_viewer({ path: ".", action: "close" })
```
- Dateibaum mit Klick-Navigation
- Signaturen anzeigen
- Live-Reload (chokidar)
- Syntax-Highlighting
- Git-Status mit Katzen-Icons (v1.3.1)

### Task Backlog (v1.8)
```
aidex_task({ path: ".", action: "create", title: "Bug fixen", priority: 1, tags: "bug" })
aidex_task({ path: ".", action: "read", id: 1 })           # Task + Log lesen
aidex_task({ path: ".", action: "update", id: 1, status: "done" })
aidex_task({ path: ".", action: "log", id: 1, note: "Root cause gefunden" })
aidex_task({ path: ".", action: "delete", id: 1 })
aidex_tasks({ path: "." })                                  # Alle Tasks
aidex_tasks({ path: ".", status: "active", tag: "bug" })    # Gefiltert
```
- Priority: 1=high, 2=medium (default), 3=low
- Status: backlog → active → done | cancelled
- Auto-Log bei Status-Änderungen und Task-Erstellung
- Viewer: Tasks-Tab mit Priority-Farben, Done-Toggle, Cancelled-Sektion (durchgestrichen)

### Task Scheduler (v1.17)
```
aidex_task({ path: ".", action: "create", title: "Check PR", due: "3d", interval: "3d", task_action: "gh pr list" })
aidex_task({ path: ".", action: "create", title: "One-shot", due: "1w" })
```
- Due: `"30m"`, `"2h"`, `"3d"`, `"1w"` oder ISO-Datum
- Intervall: Automatisch weitergesetzt nach Trigger
- One-Shot: `due` wird nach Trigger gelöscht
- Cross-Project: Bei jedem `aidex_session` werden fällige Tasks aus ALLEN Projekten gemeldet
- `auto_go: true`: Aktion wird automatisch ausgeführt

### Screenshots (v1.9, Optimierung v1.13)
```
aidex_screenshot()                                             # Ganzer Bildschirm
aidex_screenshot({ mode: "active_window" })                    # Aktives Fenster
aidex_screenshot({ mode: "window", window_title: "VS Code" })  # Bestimmtes Fenster
aidex_screenshot({ scale: 0.5, colors: 2 })                   # S/W, halbe Größe (ideal für LLM)
aidex_screenshot({ colors: 16 })                               # 16 Farben (UI lesbar)
aidex_screenshot({ mode: "region" })                           # Rechteck aufziehen
aidex_windows({ filter: "chrome" })                            # Fenster finden
```
- Kein Index nötig - standalone Tool
- Cross-Platform: Windows (PowerShell), macOS (screencapture), Linux (maim/scrot)
- Default: Speichert in `os.tmpdir()/aidex-screenshot.png` (überschreibt immer)
- Optional: `filename` und `save_path` für andere Pfade
- Rückgabe: Dateipfad → Claude kann sofort `Read` aufrufen
- **LLM-Optimierung:** `scale` (0.1-1.0) und `colors` (2/4/16/256) reduzieren Dateigröße drastisch
- **Strategie:** Start mit `scale: 0.5, colors: 2` → falls unlesbar `colors: 16` → dann `scale: 0.75`
- Settings pro Fenster/App merken für die aktuelle Session

### Global Search (v1.11)
```
aidex_global_init({ path: "Q:/develop" })                              # Nur registrieren
aidex_global_init({ path: "Q:/develop", index_unindexed: true, show_progress: true })  # Alles indexieren + Progress-UI
aidex_global_query({ term: "TransparentWindow", mode: "contains" })    # Über alle Projekte suchen
aidex_global_signatures({ term: "Render", kind: "method" })            # Methoden über alle Projekte
aidex_global_status({ sort: "recent" })                                # Projektliste
aidex_global_refresh()                                                 # Stats updaten
```
- `~/.aidex/global.db` referenziert alle Projekt-DBs
- SQLite ATTACH DATABASE — kein Daten-Kopieren
- Session-Cache (5-Min TTL) für schnelle wiederholte Queries
- Bulk-Index: ≤500 Code-Dateien automatisch, >500 werden dem User gezeigt
- Progress-UI: SSE-basiert auf Port 3334 mit Browser-Auto-Open
- Auto-Deduplizierung: Parent-Projekte mit Sub-Projekten werden übersprungen

### Log Hub (v1.16)
```
aidex_log({ action: "init" })                                         # Server starten (Port 3335)
aidex_log({ action: "init", port: 3336, buffer_size: 5000 })          # Custom Port + Buffer
aidex_log({ action: "init", persist: true, path: "." })               # Mit DB-Persistenz
aidex_log({ action: "query" })                                        # Letzte 50 Entries
aidex_log({ action: "query", since: "10m", level: "error" })          # Fehler der letzten 10 Min
aidex_log({ action: "query", source: "MyApp", contains: "crash" })    # Gefiltert
aidex_log({ action: "write", message: "Debug started" })              # LLM-Eintrag
aidex_log({ action: "status" })                                       # Stats
aidex_log({ action: "clear" })                                        # Buffer leeren
aidex_log({ action: "free" })                                         # Server stoppen
```
- HTTP API: `POST /log` (single), `POST /logs` (batch), `GET /health`
- Ring Buffer: Fixed-size FIFO, älteste werden überschrieben
- Viewer: Logs-Tab mit WebSocket-Live-Stream + Filter
- Zero-Cost: Kein Server/Buffer bis `init` aufgerufen wird

### Auto-Cleanup (v1.3.1)
`aidex_init` entfernt automatisch Dateien die jetzt excluded sind (z.B. build/).
Zeigt "Files removed: N" im Ergebnis.

## CLI

```bash
node build/index.js              # MCP Server
node build/index.js scan <path>  # Projekte finden
node build/index.js init <path>  # Indexieren
```

## Implementierungsdetails

- **Tree-sitter:** 1MB Buffer für große Dateien
- **Hash-Diff:** Zeilen-Timestamps bleiben bei unverändertem Hash
- **Arrow Functions:** Werden als Methods erkannt (gewollt, etwas Noise)
- **Keyword-Filter:** Pro Sprache in `src/parser/languages/`

## LogHub Developer Guide

### Übersicht

LogHub ist ein universeller Log-Empfänger. Jedes Programm kann per HTTP POST Logs senden — keine Library, kein SDK nötig. Die KI kann die Logs abfragen, der User sieht sie live im AiDex Viewer.

### Setup (durch die KI)

```
1. aidex_log({ action: "init" })                    # Server starten (Port 3335)
2. aidex_viewer({ path: "." })                       # Viewer öffnen → Logs-Tab zeigt Live-Stream
3. Logging in das Programm einbauen (siehe unten)
4. aidex_log({ action: "query", since: "5m" })       # KI fragt Logs ab
5. aidex_log({ action: "free" })                     # Am Ende: Server stoppen
```

### HTTP API

| Endpoint | Method | Body | Beschreibung |
|----------|--------|------|--------------|
| `/log` | POST | `{ level, source, message, data? }` | Einzelner Log-Eintrag |
| `/logs` | POST | `[{ level, source, message, data? }, ...]` | Batch (mehrere auf einmal) |
| `/health` | GET | — | Status + Buffer-Auslastung |

**Felder:**
- `level`: `"debug"`, `"info"`, `"warn"`, `"error"` (default: `"info"`)
- `source`: Name der App/Komponente (z.B. `"MyApp"`, `"Parser"`)
- `message`: Log-Text (required)
- `data`: Beliebiges JSON-Objekt für strukturierte Daten (optional)
- `timestamp`: Unix-Timestamp in ms (optional, sonst Server-Zeit)

### Code-Beispiele für verschiedene Sprachen

**C# (.NET)**
```csharp
using var http = new HttpClient();
http.PostAsJsonAsync("http://localhost:3335/log", new {
    level = "info",
    source = "MyApp",
    message = "Player spawned",
    data = new { x = 10, y = 20 }
});
```

**C# (Minimal-Helper)**
```csharp
// Einmal initialisieren
static readonly HttpClient _log = new();
static void Log(string msg, string level = "info", object? data = null) {
    var body = new { level, source = "MyApp", message = msg, data };
    _ = _log.PostAsJsonAsync("http://localhost:3335/log", body);
}

// Verwenden
Log("Game started");
Log("Error loading level", "error", new { levelId = 5 });
```

**Python**
```python
import requests
requests.post("http://localhost:3335/log", json={
    "level": "info",
    "source": "MyScript",
    "message": "Processing complete",
    "data": {"items": 42}
})
```

**JavaScript / Node.js**
```javascript
fetch("http://localhost:3335/log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        level: "info",
        source: "MyApp",
        message: "Server started",
    })
});
```

**C / C++ (curl)**
```c
// Mit libcurl oder shell:
// curl -X POST http://localhost:3335/log -H "Content-Type: application/json" -d '{"level":"info","source":"MyApp","message":"Init done"}'
```

**PowerShell**
```powershell
Invoke-RestMethod -Uri "http://localhost:3335/log" -Method POST -ContentType "application/json" -Body '{"level":"info","source":"MyApp","message":"Task done"}'
```

### Tipps für die KI

- **Viewer immer mit anbieten** — `aidex_viewer({ path: "." })` öffnet den Browser, Logs-Tab zeigt Live-Stream via WebSocket
- **Source sinnvoll wählen** — ermöglicht Filtern per `aidex_log({ action: "query", source: "MyApp" })`
- **Level nutzen** — `error` für Fehler, `warn` für Warnungen, `debug` für Verbose
- **Batch für Performance** — bei vielen Logs pro Sekunde `/logs` statt `/log` verwenden
- **Consume-Pattern** — `aidex_log({ action: "query", consume: true })` holt Logs und entfernt sie aus dem Buffer (Poll-Muster)
- **Fire & Forget** — Logs asynchron senden (kein await nötig), damit die App nicht blockiert
- **Kein Error-Handling nötig** — wenn LogHub nicht läuft, schlägt der POST still fehl

## Debug-Dashboard (Panel-API)

Neben dem scrollenden Log-Stream gibt es ein **Live-Dashboard** mit festen Slots: jeder Wert hat eine `id`, ein erneutes Senden derselben `id` **überschreibt den Wert in-place** statt wegzuscrollen. Ideal für hochfrequente / wiederholte Werte (Audio-Pegel, Buffer-Füllung, FPS, Sensoren). Sichtbar im Viewer-**Live-Tab** (hieß bis 2.2.2 „Debug").

### HTTP API

| Endpoint | Method | Body | Beschreibung |
|----------|--------|------|--------------|
| `/panel` | POST | `{ id, type, value, group?, ... }` | Einzelnes Widget setzen/aktualisieren |
| `/panels` | POST | `[{ ... }, ...]` | Batch |
| `/panel/clear` | POST | `{ id? }` | Ein Widget (id) oder alle (leer) entfernen |
| `/control` | POST/GET | `{ id, value }` / — | Control-Wert setzen; GET liefert alle als `{ id: value }` (das pollt die Quelle) |
| `/control/press` | POST | `{ id }` | Einen Tastendruck melden — der **Hub** zählt hoch, nicht der Aufrufer |

### Widget-Felder

- `id` (Pflicht) — fester Slot-Key; gleiche id = Überschreiben
- `type` (Pflicht bei Erst-Anlage) — `label` · `progress` · `gauge` · `plot` · `slider` · `number` · `toggle` · `button`
- `value` — typabhängig: Zahl, String (für gauge-Status `"ok"`/`"warn"`/`"error"`), oder Zahl-Array (plot: ganzer Frame)
- `group` — Sektion im Dashboard (default `"Default"`)
- `label` — Anzeigename (default = id)
- `unit` — Einheit (z.B. `"dB"`, `"°C"`, `"fps"`)
- `min` / `max` — Skala für progress/gauge (default 0..100)
- `warn` / `crit` — Schwellen → Färbung grün/gelb/rot (gauge/progress)
- `color` — Akzent: `cyan`/`blue`/`green`/`orange`/`purple`/`yellow`/`red` oder Hex
- `order` — Sortierung innerhalb der Gruppe

### Widget-Typen

- **label** — großer Wert + Einheit, in-place überschrieben
- **progress** — Balken (min..max), mit Schwellwert-Färbung (warn/crit)
- **gauge** — bei Zahl: radiales Tacho (Afterburner-Stil) mit Zonen-Färbung; bei Status-String: pulsierende LED (grün/gelb/rot)
- **plot** — Echtzeit-Liniengraph (HWiNFO-Stil) mit Gitternetz + min/max/avg. Einzel-Sample (`value: 0.7`) wird an einen Verlauf (200 Werte) angehängt; ein Array ersetzt den ganzen Verlauf.

**Interaktiv** (Wert fließt zurück zur Quelle, die ihn per `GET /control` abholt):
- **slider** / **number** — Regler bzw. Zahleneingabe. Felder `min`/`max`/`step`/`value`.
- **toggle** — Schalter, Wert `0`/`1`. `unit` als `"AN|AUS"` beschriftet beide Stellungen.
- **button** — Taster. ⚠️ Der Wert ist ein **monoton steigender Zähler**, kein Flag: die
  Quelle pollt in ihrem eigenen Takt, ein Ja/Nein wäre zwischen zwei Polls verloren.
  Die Quelle vergleicht mit dem zuletzt gesehenen Stand → Differenz = Anzahl Drücke.
  Jeder Sprung **nach unten** (Überlauf bei 1e6, `/panel/clear`, Hub-Neustart) heißt
  „Neustart, Wert übernehmen" — nicht eine Million Drücke. `value` beim Anlegen wird
  ignoriert, Start immer 0.

### Lifecycle

- Server hält den letzten Zustand pro `id` → ein neu verbundener/neugeladener Browser bekommt sofort den kompletten Snapshot.
- Karten ohne Update seit ~3 s werden visuell „stale" (ausgegraut).
- Backpressure-geschützt: ein langsamer Browser-Client lässt die Send-Queue nicht volllaufen (Frames werden gedroppt, kein Memory-Leak).

### Code-Beispiele

**PowerShell**
```powershell
Invoke-RestMethod -Uri "http://localhost:3335/panel" -Method POST -ContentType "application/json" `
  -Body '{"id":"mic_level","type":"plot","value":0.73,"group":"Audio","label":"Mic Level","unit":"dB"}'
```

**C# (Minimal-Helper)**
```csharp
static readonly HttpClient _hub = new();
static void Panel(string id, string type, object value, string group = "Default", object? extra = null) {
    var body = new { id, type, value, group };
    _ = _hub.PostAsJsonAsync("http://localhost:3335/panel", body);
}
Panel("buffer", "progress", 82, "Engine");      // value überschreibt in-place
Panel("state",  "gauge",    "ok", "Engine");     // LED-Status
```

**Python**
```python
import requests
requests.post("http://localhost:3335/panel", json={
    "id": "gpu_temp", "type": "gauge", "value": 67, "min": 0, "max": 100,
    "unit": "°C", "warn": 75, "crit": 90, "group": "Hardware", "label": "GPU Temp"
})
```

**C / ESP32 (curl-Stil)**
```c
// POST http://localhost:3335/panel  Body: {"id":"audio","type":"plot","value":0.42,"group":"Audio"}
// Einzel-Sample je Frame senden — der Server baut den Verlauf, der Viewer plottet flüssig.
```

### Demo zum Vorführen

`scripts/demo-dashboard.mjs` animiert alle Widget-Typen endlos (Audio-Waveform, GPU-Gauges durch ihre Zonen, Signalgenerator sine→sawtooth→triangle→square, Latenz-Spikes). Ideal zum Zeigen/Testen.

```
# Voraussetzung: LogHub + Viewer laufen (aidex_log init, aidex_viewer → Live-Tab)
node scripts/demo-dashboard.mjs        # Endlos-Loop, Ctrl+C beendet (clear't beim Exit)
scripts/demo-dashboard.ps1             # Launcher mit LogHub-Check
```

Auch per **▷ Demo**-Button im Live-Tab (kopiert den Befehl in die Zwischenablage). Der Button steht auch im leeren Dashboard bereit — er ist ja der Weg zu den ersten Widgets.

**⚠️ Nie zweimal starten** — zwei Instanzen überschreiben sich gegenseitig (Flackern). Erst alte stoppen. Und: `TaskStop` killt nur den PowerShell-Wrapper, nicht den node-Prozess — bei Background-Start node direkt aufrufen und nach dem Stop verifizieren ([[feedback_taskstop_orphan_node]]).

### Clear

`POST /panel/clear` (oder der Clear-Button) ist ein **voller Reset** — leert den Store. Eine Quelle taucht nur wieder auf, wenn sie Widgets erneut **mit `type`** sendet (reine value-Updates auf eine gelöschte id werden ignoriert).

## Dokumentation

| Datei | Inhalt |
|-------|--------|
| `README.md` | Öffentliche Doku |
| `MCP-API-REFERENCE.md` | Vollständige API |
| `CHANGELOG.md` | Versionshistorie |
