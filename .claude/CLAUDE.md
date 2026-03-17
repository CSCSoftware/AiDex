# AiDex - CLAUDE.md

MCP Server für persistentes Code-Indexing. Ermöglicht Claude Code schnelle, präzise Suchen statt Grep/Glob.

**Version:** 1.15.0 | **Sprachen:** 11 | **Repo:** https://github.com/CSCSoftware/AiDex

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

## Tools (27)

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
| `aidex_task` | Task CRUD + Log (create/read/update/delete/log) |
| `aidex_tasks` | Tasks auflisten, filtern nach Status/Priority/Tag |

Status: `backlog → active → done | cancelled`

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

C# · TypeScript · JavaScript · Rust · Python · C · C++ · Java · Go · PHP · Ruby

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
│   ├── session.ts, note.ts, task.ts
│   ├── screenshot/              # Plattform-Screenshots
│   └── global/                  # Global Search (v1.11)
│       ├── global-init.ts       # Scan + Bulk-Index
│       ├── global-query.ts      # ATTACH DATABASE Queries
│       ├── global-signatures.ts # Methoden/Typen suchen
│       ├── global-status.ts     # Projekt-Übersicht
│       └── global-refresh.ts    # Stats aktualisieren
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
    └── languages/        # Keyword-Filter (11 Sprachen)
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
| `tasks` | Backlog-Tasks (Priority, Status, Tags) |
| `task_log` | Task-Historie (Auto-Log bei Änderungen) |

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

## Dokumentation

| Datei | Inhalt |
|-------|--------|
| `README.md` | Öffentliche Doku |
| `MCP-API-REFERENCE.md` | Vollständige API |
| `CHANGELOG.md` | Versionshistorie |
