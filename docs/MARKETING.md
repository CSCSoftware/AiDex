# AiDex — The Brain Your AI Has Been Missing

> **Your AI assistant spends 80% of its thinking on finding code.
> AiDex gives it a photographic memory — so it can spend 100% on solving problems.**

---

## One Search. 50 Tokens. Done.

Every time your AI searches for code, it burns through your context window like a flamethrower:

| | Without AiDex | With AiDex |
|---|---|---|
| **Find `PlayerHealth`** | Grep → 200 hits in 40 files → reads 5 files → **2,000+ tokens, 5 tool calls** | 1 query → 3 exact locations → **~50 tokens, 1 call** |
| **Get file structure** | Reads entire 500-line file → **1,500 tokens** | Signatures → classes + methods → **~80 tokens** |
| **What changed today?** | `git diff` + grep + context → **3,000+ tokens** | Time-filtered query → **~50 tokens** |
| **Search 200 projects** | Impossible | Global search → results in milliseconds |

**That's not an optimization. That's a paradigm shift.**

---

## What If Your AI Could...

<!-- HERO-FEATURES: Each becomes a landing page section -->

### 🧠 Remember Everything Between Sessions
Your chat ends. Context gone. Tomorrow you start from zero.

**Not with AiDex.** Session notes persist in the database. The AI picks up exactly where you left off — what was tested, what's broken, what to do next. Even searches past sessions: *"What did we do about the parser last week?"*

### 🔍 Search Your Entire Career in One Call
*"Have I ever written a transparent window?"*

One query. All your projects. Instantly. AiDex searches across your entire codebase — 10 projects or 200 — in milliseconds. No re-indexing, no waiting, no switching directories.

### 📡 See Your App's Logs in Real-Time
Your game engine. Your Python script. Your C# desktop app. Whatever you're building — add one HTTP POST and watch logs stream live into your browser. The AI reads them too, spots the bug, and tells you where to look.

### 📸 Share What You See — Without the Token Tax
A typical screenshot costs 20,000 tokens. AiDex compresses it to 500 — **95% savings** — while keeping text perfectly readable. Your AI sees the same screen you do, without going blind from context overload.

### 📋 Track Bugs Without Leaving Your Editor
Found a memory leak at 2 AM? Add it to the backlog. No Jira, no Trello, no browser tab. Tasks live next to your code, prioritized, tagged, with automatic history. Pick up tomorrow exactly where you stopped.

### 🌐 Works With Every AI Assistant
Claude Code, Claude Desktop, Cursor, Windsurf, Gemini CLI, VS Code Copilot — install once, works everywhere. Auto-setup detects your tools and configures itself. Zero friction.

---

## Table of Contents

1. [The Problem Nobody Talks About](#1-the-problem-nobody-talks-about)
2. [How AiDex Works](#2-how-aidex-works)
3. [Code Intelligence — Parse, Don't Grep](#3-code-intelligence--parse-dont-grep)
4. [Cross-Project Search — Your Entire Career, Indexed](#4-cross-project-search--your-entire-career-indexed)
5. [Session Continuity — Never Lose Context Again](#5-session-continuity--never-lose-context-again)
6. [Log Hub — Universal Debugging](#6-log-hub--universal-debugging)
7. [Interactive Viewer — Your Codebase in the Browser](#7-interactive-viewer--your-codebase-in-the-browser)
8. [Screenshots — LLM-Optimized Visual Capture](#8-screenshots--llm-optimized-visual-capture)
9. [AI Guidelines — Teach Once, Apply Everywhere](#9-ai-guidelines--teach-once-apply-everywhere)
10. [30 Tools at a Glance](#10-30-tools-at-a-glance)
11. [Who Is This For?](#11-who-is-this-for)
12. [Quick Start — 60 Seconds to First Query](#12-quick-start--60-seconds-to-first-query)
13. [Performance](#13-performance)
14. [Supported Languages](#14-supported-languages)
15. [Architecture](#15-architecture)
16. [Roadmap](#16-roadmap)

---

## 1. The Problem Nobody Talks About

AI coding assistants are powerful — but they have a dirty secret: **most of their work is navigation, not problem-solving.**

Ask your AI to fix a bug:

1. It greps for the function name → 200 results flood the context
2. It reads file after file to understand the structure → more tokens consumed
3. It finally understands the code → half the context window is gone
4. It writes the fix → runs out of room for nuance

**The code search is the bottleneck.** Not the AI's intelligence. Not the model size. The search.

And when the session ends? Everything is forgotten. Tomorrow, the same search happens again. Same files. Same context. Same waste.

AiDex solves both problems:
- **Search**: Pre-built index → 50 tokens per query instead of 2,000
- **Memory**: Notes, tasks, and session tracking → context survives between sessions

<!-- IMAGE: Side-by-side comparison animation: grep flooding context vs AiDex precise result -->
<!-- PLACEHOLDER: docs/comparison-animation.gif -->

---

## 2. How AiDex Works

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Your Code  │────▶│  Tree-sitter │────▶│  SQLite Index    │
│  11 langs   │     │  Real Parser │     │  .aidex/index.db │
└─────────────┘     └──────────────┘     └────────┬────────┘
                                                   │
                         ┌─────────────────────────┤
                         │                         │
                    ┌────▼────┐              ┌─────▼─────┐
                    │ AI Chat │              │  Browser   │
                    │ 50 tok  │              │  Viewer    │
                    │ /query  │              │ :3333      │
                    └─────────┘              └───────────┘
```

1. **Index once** — Tree-sitter parses your code into an AST, extracts identifiers, methods, classes. Stored in SQLite. Takes ~1 second per 1,000 files.

2. **Query forever** — Your AI searches the index instead of grepping. Results are precise: only identifiers, not every text match. `log` finds `log`, not `catalog`.

3. **Stays fresh** — On session start, AiDex detects external changes and auto-reindexes. Edit a file? The Viewer catches it and updates live.

4. **Survives sessions** — Notes, tasks, search history, and the index itself persist in SQLite. Your next chat session picks up where you left off.

<!-- IMAGE: Architecture diagram with icons -->
<!-- PLACEHOLDER: docs/architecture-overview.png -->

---

## 3. Code Intelligence — Parse, Don't Grep

### The Difference Between Searching and Understanding

Grep finds text. AiDex finds code.

| Search for `User` | Grep | AiDex |
|---|---|---|
| `class User` | ✅ | ✅ |
| `// TODO: fix user logic` | ✅ (noise) | ❌ (filtered) |
| `"user_name"` string literal | ✅ (noise) | ❌ (filtered) |
| `getUserData()` | ✅ | ✅ (`contains` mode) |
| `namespace UserManagement` | ✅ | ✅ |
| Results | 200+ hits | 5-10 precise matches |
| Tokens consumed | 2,000+ | ~50 |

AiDex uses [Tree-sitter](https://tree-sitter.github.io/) — the same parser used by GitHub, Neovim, and Zed — to build a real AST (Abstract Syntax Tree). It knows the difference between a class definition, a variable name, and a comment.

### Three Search Modes

**Exact** (default) — `log` finds only `log`, not `catalog` or `logarithm`
```
aidex_query({ term: "PlayerHealth" })
→ Engine.cs:45, Player.cs:23, UI.cs:156
```

**Contains** — `render` matches `preRenderSetup`, `renderTarget`, `Renderer`
```
aidex_query({ term: "render", mode: "contains" })
→ All identifiers containing "render" across the project
```

**Starts with** — `Update` matches `UpdatePlayer`, `UpdateUI`, `UpdateHealth`
```
aidex_query({ term: "Update", mode: "starts_with" })
→ All update-related functions
```

### Time Travel

Track what changed with granular precision:

```
aidex_query({ term: "Parser", modified_since: "2h" })          # Last 2 hours
aidex_query({ term: "API", modified_since: "1d" })              # Last day
aidex_files({ path: ".", modified_since: "30m" })               # Files changed this session
aidex_query({ term: "auth", file_filter: "src/server/**" })     # Only in server directory
aidex_query({ term: "Calculate", type_filter: ["method"] })     # Only method definitions
```

Change tracking works at the **line level** — if you modify line 42 but line 43 stays the same, AiDex knows.

### Signatures — The File Overview That Doesn't Cost 1,500 Tokens

Want to know what's in a file? Don't read it. Ask for the signature:

```
aidex_signature({ file: "src/Engine.cs" })
```

Returns:
```
# Signature: src/Engine.cs

## Types (2)
- class GameEngine (line 15)
- struct Config (line 8)

## Methods (5)
- [public] void Initialize() :20
- [public async] Task LoadAsync(string path) :45
- [private] void Update(float delta) :78
- [private] void Render() :112
- [static] Config LoadConfig(string file) :150
```

**80 tokens instead of reading 500 lines.** Your AI knows the structure, the visibility, the parameter types — without consuming the implementation.

For multiple files: `aidex_signatures({ pattern: "src/**/*.cs" })` — get the architecture of an entire directory in one call.

<!-- IMAGE: Screenshot showing signature output in AI chat -->
<!-- PLACEHOLDER: docs/signature-demo.png -->

---

## 4. Cross-Project Search — Your Entire Career, Indexed

### "Have I Ever Written This Before?"

Every developer has asked this question. With AiDex, the answer is one call away:

```
aidex_global_query({ term: "TransparentWindow", mode: "contains" })
→ Found in 3 projects:
  - LibWebAppGpu: src/Window.cs:45, src/Renderer.cs:89
  - DebugViewer: app-core/src/App.ts:23
  - TaaviBook: src/ui/overlay.ts:67
```

### How It Works

1. **Scan** your project directory:
   ```
   aidex_global_init({ path: "Q:/develop" })
   ```
   AiDex walks the directory tree, finds projects by markers (`.csproj`, `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`), and registers them in a global database.

2. **Auto-index** unindexed projects (optional):
   ```
   aidex_global_init({ path: "Q:/develop", index_unindexed: true, show_progress: true })
   ```
   Projects with ≤500 code files are indexed automatically. Large projects are listed for your decision. A browser progress UI shows real-time status.

3. **Search everything**:
   ```
   aidex_global_query({ term: "render", mode: "starts_with" })
   aidex_global_signatures({ term: "Player", kind: "class" })
   ```

### Zero-Copy Architecture

AiDex doesn't copy data into a central index. It uses SQLite `ATTACH DATABASE` to query each project's own database directly. The project `.aidex/index.db` is always the single source of truth.

Results are cached in memory (5-minute TTL) for fast repeated queries.

### Smart Deduplication

If `MyApp/` contains `MyApp/Frontend/` and `MyApp/Backend/` as separate indexed projects, AiDex automatically skips the parent — no duplicate results.

<!-- IMAGE: Global search results spanning multiple projects -->
<!-- PLACEHOLDER: docs/global-search-demo.png -->

---

## 5. Session Continuity — Never Lose Context Again

### The Session Problem

You spend an hour with your AI, building understanding, tracking down a bug, planning the fix. Then: session over. Tomorrow, the AI starts from zero. The debugging context? Gone. The plan? Gone.

AiDex solves this with three interlocking features:

### 5.1 Session Tracking

Every session starts with:
```
aidex_session({ path: "." })
```

AiDex:
- Detects external changes (files modified since last session)
- Auto-reindexes modified files
- Returns your session note (if you left one)
- Shows what's new in AiDex (update notifications)

**No more stale indexes.** No more wondering what changed overnight.

### 5.2 Session Notes — Context That Survives

```
aidex_note({ path: ".", note: "Parser bug: nested generics cause stack overflow. Fix is in progress, test after restart." })
```

Next session — next day, next week, next month:
```
aidex_note({ path: "." })
→ "Parser bug: nested generics cause stack overflow. Fix is in progress, test after restart."
```

The AI sees this immediately. Picks up where you left off.

**Search past sessions:**
```
aidex_note({ path: ".", search: "parser" })
→ 4 notes mentioning "parser" across your session history
```

**Summaries for archival:**
When you write a new note, the old one is archived with a one-sentence summary:
```
aidex_note({
  path: ".",
  note: "Merged parser fix, now working on UI",
  summary: "Previous session: fixed nested generic stack overflow in parser"
})
```

### 5.3 Task Backlog — Your Built-in Jira

No browser tabs. No context switching. Tasks live right next to your code:

```
aidex_task({
  path: ".",
  action: "create",
  title: "Fix memory leak in parser",
  summary: "Parser allocates unbounded buffers for nested generics",
  priority: 1,
  tags: "bug, parser"
})
```

**Everything is tracked:**
- Status: `backlog → active → done | cancelled`
- Priority: 🔴 high, 🟡 medium, ⚪ low
- Tags: categorize by feature, bug type, component
- History: every status change auto-logged, plus manual notes

```
aidex_task({ path: ".", action: "log", id: 1, note: "Root cause: unbounded buffer in recursive descent" })
aidex_task({ path: ".", action: "update", id: 1, status: "done" })
```

**Filter your backlog:**
```
aidex_tasks({ path: ".", status: "active", tag: "bug" })
```

The Viewer shows tasks in a dedicated tab — with priority colors, done toggles, and cancelled tasks crossed out.

<!-- IMAGE: Task backlog in Viewer with priorities -->
<!-- PLACEHOLDER: docs/task-backlog-viewer.png -->

---

## 6. Log Hub — Universal Debugging

### Your Program → HTTP → AI + Browser

Any program in any language can send logs to AiDex. No SDK. No library. Just one HTTP POST:

```
┌──────────────┐     HTTP POST      ┌─────────────────┐
│  C# App      │───────────────────▶│                 │
│  Python ML   │     /log           │   AiDex         │
│  Node Server │     /logs          │   Log Hub       │
│  PowerShell  │                    │   (port 3335)   │
│  Any program │                    │                 │
└──────────────┘                    └────────┬────────┘
                                             │
                              ┌──────────────┼──────────────┐
                              │              │              │
                         ┌────▼────┐    ┌────▼────┐    ┌────▼────┐
                         │ Browser │    │   AI    │    │ SQLite  │
                         │ Viewer  │    │  Query  │    │ Persist │
                         │ :3333   │    │         │    │ 7-day   │
                         └─────────┘    └─────────┘    └─────────┘
```

### Add Logging in One Line

**C#:**
```csharp
await http.PostAsJsonAsync("http://localhost:3335/log", new {
    level = "info", source = "MyApp", message = "Player spawned", data = new { x = 10, y = 20 }
});
```

**Python:**
```python
requests.post("http://localhost:3335/log", json={
    "level": "error", "source": "Trainer", "message": "GPU OOM", "data": {"batch": 64}
})
```

**JavaScript:**
```javascript
fetch("http://localhost:3335/log", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({level: "warn", source: "API", message: "Rate limit hit"})
});
```

### Zero Cost When Not Used

Log Hub doesn't exist until you need it. No server, no buffer, no memory, no port — until you call `init`:

```
aidex_log({ action: "init" })              # Start (port 3335)
aidex_log({ action: "init", persist: true, path: "." })  # With SQLite persistence
```

### AI Queries Your Logs

```
aidex_log({ action: "query", since: "10m", level: "error" })        # Errors last 10 min
aidex_log({ action: "query", source: "GameEngine", contains: "crash" })  # Filtered
aidex_log({ action: "query", consume: true })                        # Poll pattern (remove after read)
```

The AI sees the logs, spots patterns, suggests fixes — all without you reading a single line.

### You See Them Live

Open the Viewer → Logs tab → live WebSocket stream:

- Filter by level (debug/info/warn/error)
- Filter by source (which app)
- Full-text search
- Auto-scroll
- Clear button

<!-- IMAGE: Viewer Logs tab with live streaming entries -->
<!-- PLACEHOLDER: docs/loghub-viewer-demo.png -->

### Ring Buffer = No Memory Leaks

The buffer holds N entries (default 10,000). When full, oldest entries are overwritten. Your process never consumes more memory than configured — even if your app logs millions of lines.

---

## 7. Interactive Viewer — Your Codebase in the Browser

```
aidex_viewer({ path: "." })
→ Opens http://localhost:3333
```

### A Developer Dashboard, Not Just a File Browser

The Viewer is a single-page app with four integrated views:

**📁 File Tree**
- Click directories to expand
- Click files to view signatures
- Two modes: "Code files only" and "All files"
- Git status with visual icons:
  - 🟢 Committed & pushed
  - 🟡 Modified (uncommitted)
  - 🔵 Staged
  - ⚪ Untracked

**🔍 Signatures on Demand**
- Click any file → see all classes, methods, types
- Syntax highlighting (highlight.js)
- Line numbers link to definitions
- No need to open the file in your editor

**📋 Tasks Tab**
- View your backlog at a glance
- Priority colors (red/yellow/white)
- Toggle done status with a checkbox
- Cancelled tasks shown crossed out
- Live updates via WebSocket

**📡 Logs Tab**
- Live stream from Log Hub
- Client-side filters (level, source, text)
- Auto-scroll with toggle
- Clear button

### Live Reload — Always Current

The Viewer uses [chokidar](https://github.com/paulmillr/chokidar) to watch your project files. When you save a file in your editor:

1. Chokidar detects the change
2. AiDex re-indexes the file automatically
3. WebSocket pushes update to browser
4. File tree and signatures refresh — no manual reload

Git status refreshes on a 5-second interval to avoid subprocess spam during rapid saves.

### Auto-Reconnect

If the WebSocket connection drops (MCP server restart, network blip), the Viewer automatically reconnects after 2 seconds. No manual refresh needed.

<!-- IMAGE: Viewer showing file tree + signatures side by side -->
<!-- PLACEHOLDER: docs/viewer-full-demo.png -->

<!-- IMAGE: Viewer with Logs tab streaming live entries -->
<!-- PLACEHOLDER: docs/viewer-logs-demo.png -->

---

## 8. Screenshots — LLM-Optimized Visual Capture

### The Token Problem with Images

A typical screenshot: 100-500 KB. That's 5,000-25,000 tokens consumed by the AI just to look at a picture.

Most of the time, you're showing text — error messages, log output, a UI button. You don't need 16 million colors for that.

### AiDex Compresses Up to 95%

| Setting | File size | Tokens | Readable? |
|---|---|---|---|
| Raw screenshot | ~200 KB | ~10,000 | ✓ |
| `scale: 0.5` | ~50 KB | ~2,500 | ✓ |
| `scale: 0.5, colors: 2` | ~8 KB | ~400 | ✓ (text) |
| `scale: 0.5, colors: 16` | ~15 KB | ~750 | ✓ (UI) |

### Five Capture Modes

```
aidex_screenshot()                                                    # Full screen
aidex_screenshot({ mode: "active_window" })                           # Current window
aidex_screenshot({ mode: "window", window_title: "Visual Studio" })   # Specific window
aidex_screenshot({ mode: "region" })                                  # Draw a rectangle
aidex_screenshot({ mode: "rect", x: 100, y: 200, width: 800, height: 600 })  # Exact coordinates
```

### Smart AI Strategy

The AI learns which settings work for each app:

1. **Start aggressive**: `scale: 0.5, colors: 2` (B&W, smallest)
2. **If unreadable**: retry with `colors: 16` (adds shading)
3. **If still unclear**: `scale: 0.75` or full quality
4. **Remember** what works → don't retry every time

Cross-platform: Windows (PowerShell + System.Drawing), macOS (screencapture), Linux (maim/scrot).

<!-- IMAGE: Before/after comparison — raw vs optimized screenshot -->
<!-- PLACEHOLDER: docs/screenshot-comparison.png -->

---

## 9. AI Guidelines — Teach Once, Apply Everywhere

### Your Rules, Persistent

Store coding conventions, review checklists, and AI instructions in a single place — shared across all projects:

```
aidex_global_guideline({ action: "set", key: "review",
  value: "Always check: error handling, null safety, no hardcoded strings, logging" })

aidex_global_guideline({ action: "set", key: "style",
  value: "PascalCase classes, camelCase methods, 4-space indent" })

aidex_global_guideline({ action: "set", key: "release",
  value: "1. Update version 2. Run tests 3. Update CHANGELOG 4. npm publish 5. GitHub release" })
```

### Use Anywhere

```
aidex_global_guideline({ action: "get", key: "review" })
→ "Always check: error handling, null safety, no hardcoded strings, logging"

aidex_global_guideline({ action: "list" })
→ All stored guidelines
```

No CLAUDE.md editing. No pasting the same context into every session. Define once, reference always.

Stored in `~/.aidex/global.db` — available across all projects without `aidex_init`.

---

## 10. 30 Tools at a Glance

| Category | Tools | What it does |
|----------|-------|--------------|
| **Search & Index** | `init`, `query`, `update`, `remove`, `status` | Index your project, search identifiers, time-based filtering |
| **Signatures** | `signature`, `signatures` | Get classes + methods without reading files |
| **Project Overview** | `summary`, `tree`, `describe`, `files` | Entry points, language breakdown, file tree |
| **Cross-Project** | `link`, `unlink`, `links`, `scan` | Link dependencies, discover indexed projects |
| **Global Search** | `global_init`, `global_query`, `global_signatures`, `global_status`, `global_refresh` | Search across ALL projects at once |
| **Guidelines** | `global_guideline` | Persistent AI instructions — shared across projects |
| **Sessions** | `session`, `note` | Track sessions, leave notes with searchable history |
| **Tasks** | `task`, `tasks` | Built-in backlog with priorities, tags, auto-logged history |
| **Log Hub** | `log` | Universal log receiver — HTTP in, AI + Viewer out |
| **Screenshots** | `screenshot`, `windows` | LLM-optimized screen capture (up to 95% smaller) |
| **Viewer** | `viewer` | Interactive browser UI with file tree, signatures, tasks, logs |

**11 languages:** C#, TypeScript, JavaScript, Rust, Python, C, C++, Java, Go, PHP, Ruby

---

## 11. Who Is This For?

### Solo Developers
**Problem:** You're the only developer. You need your AI to be your pair programmer, not your file browser.
**AiDex gives you:** Persistent context (notes, tasks), instant code search (50 tokens), live debugging (Log Hub + Viewer).

### Team Leads & Architects
**Problem:** Understanding multiple codebases. Onboarding new team members.
**AiDex gives you:** Global search across all projects, signatures for instant code overview, guidelines for consistent standards.

### Consultants & Freelancers
**Problem:** Working across multiple client codebases. Reusing past solutions.
**AiDex gives you:** Global search ("Have I solved this before?"), portable guidelines, project linking for dependency analysis.

### AI-First Developers
**Problem:** Context windows fill up with navigation, not problem-solving.
**AiDex gives you:** 50-token searches, signatures instead of file reads, LLM-optimized screenshots. Your AI stays sharp.

### Game Developers & ML Engineers
**Problem:** Real-time debugging. Monitoring training runs. Analyzing log output.
**AiDex gives you:** Log Hub streams from any program. AI analyzes patterns. Viewer shows live. Ring buffer prevents memory leaks.

---

## 12. Quick Start — 60 Seconds to First Query

### Install

```bash
npm install -g aidex-mcp
```

**That's it.** AiDex auto-detects your AI clients (Claude Code, Claude Desktop, Cursor, Windsurf, Gemini CLI, VS Code Copilot) and registers itself. It also installs AI instructions so your assistant knows when and how to use it.

### Use

Open any AI chat and say:

> *"Index this project with AiDex"*

Your AI runs `aidex_init` — index created in ~1 second. From now on, every code search uses the index instead of grepping.

> *"Where is PlayerHealth defined?"*

50 tokens. 1 call. Exact answer.

### Manual Setup (Optional)

For **Claude Code** (`~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "aidex": {
      "type": "stdio",
      "command": "aidex"
    }
  }
}
```

For other clients: see [README](README.md#2-or-register-manually-with-your-ai-assistant).

---

## 13. Performance

| Project Size | Files | Items Indexed | Index Time | Query Time |
|---|---|---|---|---|
| Small (AiDex itself) | 19 | 1,200 | <1s | 1-5ms |
| Medium (RemoteDebug) | 10 | 1,900 | <1s | 1-5ms |
| Large (LibPyramid3D) | 18 | 3,000 | <1s | 1-5ms |
| XL (MeloTTS) | 56 | 4,100 | ~2s | 1-10ms |

- **Index**: ~1 second per 1,000 files
- **Query**: 1-10ms (SQLite prepared statements)
- **Storage**: Typically 100-500 KB per project (SQLite with WAL)
- **Memory**: Minimal — buffer sizes are bounded (Log Hub ring buffer, query cache with TTL)

---

## 14. Supported Languages

| Language | Extensions | Parser |
|----------|------------|--------|
| C# | `.cs` | tree-sitter-c-sharp |
| TypeScript | `.ts`, `.tsx` | tree-sitter-typescript |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | tree-sitter-javascript |
| Rust | `.rs` | tree-sitter-rust |
| Python | `.py`, `.pyw` | tree-sitter-python |
| C | `.c`, `.h` | tree-sitter-c |
| C++ | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hxx` | tree-sitter-cpp |
| Java | `.java` | tree-sitter-java |
| Go | `.go` | tree-sitter-go |
| PHP | `.php` | tree-sitter-php |
| Ruby | `.rb`, `.rake` | tree-sitter-ruby |

All parsers from the Tree-sitter ecosystem — the same technology used by GitHub, Neovim, and Zed.

---

## 15. Architecture

```
AiDex/
├── src/
│   ├── commands/              # 30 tool implementations
│   │   ├── init.ts            # Indexing engine
│   │   ├── query.ts           # Semantic search
│   │   ├── signature.ts       # File structure extraction
│   │   ├── session.ts         # Session tracking + auto-reindex
│   │   ├── note.ts            # Persistent notes with history
│   │   ├── task.ts            # Backlog management
│   │   ├── log.ts             # Log Hub dispatch
│   │   ├── screenshot/        # Cross-platform capture
│   │   └── global/            # Cross-project search (5 tools)
│   ├── loghub/                # Universal log receiver
│   │   ├── log-server.ts      # HTTP server (Express, port 3335)
│   │   ├── log-buffer.ts      # Ring buffer (FIFO, bounded)
│   │   └── log-types.ts       # Shared types
│   ├── viewer/                # Interactive browser UI
│   │   ├── server.ts          # Express app (port 3333) + WebSocket
│   │   ├── git-status.ts      # Git integration
│   │   └── progress.ts        # SSE progress UI (port 3334)
│   ├── db/                    # Database layer
│   │   ├── database.ts        # SQLite wrapper (WAL mode)
│   │   ├── queries.ts         # Prepared statements
│   │   └── global-database.ts # Global registry (~/.aidex/global.db)
│   ├── parser/                # Code intelligence
│   │   ├── tree-sitter.ts     # Parser engine (1MB buffer)
│   │   ├── extractor.ts       # Identifier + signature extraction
│   │   └── languages/         # Keyword filters (11 languages)
│   └── server/                # MCP protocol
│       ├── mcp-server.ts      # Protocol handler
│       └── tools.ts           # Tool registration + dispatch
```

**Technology stack:**
- **Parser**: [Tree-sitter](https://tree-sitter.github.io/) — real AST parsing, 11 languages
- **Database**: [SQLite](https://www.sqlite.org/) with WAL mode — fast, portable, zero config
- **Protocol**: [MCP](https://modelcontextprotocol.io/) — standard for AI tool integration
- **Server**: Express.js (Viewer + Log Hub)
- **File watching**: [chokidar](https://github.com/paulmillr/chokidar) — cross-platform
- **Git**: [simple-git](https://github.com/steveukx/git-js) — status detection
- **Highlighting**: [highlight.js](https://highlightjs.org/) — Viewer syntax colors

---

## 16. Roadmap

<!-- These are ideas and directions, not commitments -->

| Direction | Vision |
|-----------|--------|
| **Smart Re-indexing** | Background incremental updates — index stays fresh without explicit calls |
| **Log Analysis Agents** | AI automatically categorizes and triages incoming logs |
| **Visual Diffing** | Viewer shows real-time file diffs, git blame overlay |
| **Team Sharing** | Viewer accessible via tunnel for remote pair programming |
| **IDE Plugins** | Native VS Code and JetBrains extensions |
| **More Languages** | Swift, Kotlin, Dart, Zig, Lua — community-driven |
| **Guideline Versioning** | Track history of team conventions |

---

## Open Source

AiDex is MIT licensed. Contributions welcome.

- **Repository**: [github.com/CSCSoftware/AiDex](https://github.com/CSCSoftware/AiDex)
- **npm**: [npmjs.com/package/aidex-mcp](https://www.npmjs.com/package/aidex-mcp)
- **Discussions**: [GitHub Discussions](https://github.com/CSCSoftware/AiDex/discussions)
- **Issues**: [GitHub Issues](https://github.com/CSCSoftware/AiDex/issues)

---

<p align="center">
<strong>Built by Uwe Chalas & Claude</strong><br/>
<em>"Stop searching. Start solving."</em>
</p>

<!--
=== MEDIA PLACEHOLDERS ===
These need to be created for the final marketing page:

docs/comparison-animation.gif    — Side-by-side: grep flooding context vs AiDex precise result
docs/architecture-overview.png   — Architecture diagram with icons
docs/signature-demo.png          — Signature output in AI chat session
docs/global-search-demo.png      — Global search results spanning multiple projects
docs/task-backlog-viewer.png     — Task backlog in Viewer with priorities
docs/loghub-viewer-demo.png      — Viewer Logs tab with live streaming entries
docs/viewer-full-demo.png        — Viewer file tree + signatures side by side
docs/viewer-logs-demo.png        — Viewer with Logs tab streaming
docs/screenshot-comparison.png   — Before/after: raw vs optimized screenshot

VIDEO IDEAS:
- 60-second "First Index to First Query" demo
- Log Hub: "Debug any app in any language" walkthrough
- Global Search: "Search 200 projects in 1 call" showcase
- Session Continuity: "Pick up where you left off" scenario
- Viewer Tour: All 4 tabs in 2 minutes
-->
