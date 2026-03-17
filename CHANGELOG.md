# Changelog

All notable changes to AiDex will be documented in this file.

## [Unreleased]

## [1.15.0] - 2026-03-17

### Added
- **Task summaries**: Tasks now support a `summary` field — a one-sentence table-of-contents entry (~150 chars) that the AI writes on create/update. `aidex_tasks` shows summaries inline so you can scan the backlog without reading full details.
- **Note history summaries**: Archived notes now get an optional `summary` field. When a note is overwritten or cleared, a summary can be provided for the archive. `aidex_note` with `history: true` shows summaries (with fallback to truncated preview for older notes). Search also matches summaries.
- **Auto-migration**: Existing databases are automatically upgraded with `ALTER TABLE ADD COLUMN summary` — no manual migration needed.
- **Viewer integration**: Task summaries shown in italic between title and description in the browser viewer.

## [1.14.0] - 2026-03-10

### Added
- **`aidex_global_guideline`**: New tool (#28) — persistent key-value store in `~/.aidex/global.db` for AI guidelines and coding conventions. Store named instructions like "review" → review checklist, "release-prep" → release steps. Actions: `set`, `get`, `list`, `delete`. Works without prior `global_init`.
- **Viewer file size limit**: `getFileContent()` now refuses files larger than 1 MB — prevents browser from freezing on large binary or generated files

### Fixed
- **Command injection in Linux screenshot tools**: All `execSync` calls with shell string interpolation replaced with `execFileSync` using argument arrays — window titles, file paths and IDs are no longer injectable via shell
- **Global query cache grows unbounded**: Cache entries are now evicted on write when they exceed the 5-minute TTL — prevents memory leak in long-running sessions
- **Viewer race condition on file change**: `pendingChanges` set is now snapshotted and cleared before processing — new events arriving during async re-indexing are no longer silently dropped
- **Viewer buildTree() N+1 queries**: Correlated subqueries for `methods` and `types` counts replaced with `LEFT JOIN` — single query instead of one subquery per file
- **WebSocket unknown message type**: Viewer now sends an error response for unrecognized message types instead of silently ignoring them
- **Viewer taskId not validated**: `updateTaskStatus` now checks `Number.isInteger(taskId)` before processing
- **Viewer mode not whitelisted**: `getTree` message mode is now constrained to `'code' | 'all'` — arbitrary values no longer passed through
- **`getProjects()` SQL injection via tag/namePattern**: `escapeLikeTerm()` now applied to both filter parameters in `global-database.ts`
- **Silent fails in viewer and global DB**: `catch {}` blocks now log errors via `console.error`
- **Git status refresh on every file event**: Added 5-second minimum interval between git status refreshes — reduces git subprocess spam during rapid file saves
- **Global query cache not invalidated after init/update**: `aidex_init` and `aidex_update` now call `invalidateGlobalCache()` so global searches immediately see fresh data

### Refactored
- **`screenshot/shared.ts`**: New module with centralized `hasTool()` and `runPowerShell()` — both use `execFileSync` (no shell). Imported by `platform-win32.ts`, `platform-linux.ts`, and `post-process.ts` — eliminates duplicate implementations
- **`normalizePath()`**: Private duplicates in `global-database.ts` and `git-status.ts` removed — both now import from `commands/shared.ts`
- **`escapeLikeTerm()`**: Exported from `commands/shared.ts` and used consistently across all LIKE queries
- **macOS sips output parsing**: Replaced shell pipe (`| tail -1 | awk`) with regex on direct `sips` output

## [1.13.0] - 2026-03-09

### Added
- **Screenshot optimization**: New `scale` (0.1-1.0) and `colors` (2/4/16/256) parameters for `aidex_screenshot`
  - Reduces file size up to 95% (e.g., 108 KB → 5 KB with `scale: 0.5, colors: 2`)
  - Black & white mode (`colors: 2`) ideal for text-only screenshots — saves thousands of tokens
  - Cross-platform post-processing: Windows (System.Drawing), macOS (sips + ImageMagick), Linux (ImageMagick)
  - Size reporting: shows original → optimized size and percentage saved
- **LLM auto-optimization strategy**: Tool description guides AI assistants to start with aggressive settings, retry if unreadable, and remember working settings per app during the session

## [1.12.1] - 2026-03-07

### Added
- **Update notifications**: `aidex_session` now shows "What's New" when AiDex was updated since the last session
  - Compares installed version with `last_seen_version` stored in project DB
  - Shows highlights + changelog link, only once per version update

## [1.12.0] - 2026-03-07

### Added
- **Auto-setup on install**: `npm install -g aidex-mcp` now automatically registers AiDex with all detected AI clients and installs AI instructions (`CLAUDE.md`, `GEMINI.md`)
  - Opt-out via `AIDEX_NO_SETUP=1` or `CI` environment variable
  - Graceful fallback: shows manual hint if auto-setup fails
- **Comprehensive AI instructions**: The CLAUDE.md block installed by `aidex setup` now covers all 27 tools
  - Decision tree: "Do I want to search code? → .aidex/ exists? → STOP, use AiDex"
  - Explicit ❌/✅ examples (never Grep when .aidex exists)
  - Search modes explained (exact/contains/starts_with)
  - Session notes, task backlog, global search, screenshots — all with examples
- **Duplicate detection**: `aidex setup` skips CLAUDE.md/GEMINI.md if manual AiDex instructions already exist (avoids double entries)

### Changed
- **Refactored commands**: Extracted shared utilities into `shared.ts` and `global-shared.ts`
  - `validateIndex()`, `noIndexError()`, `withDatabase()`, `withProjectDb()` — ~200 lines of boilerplate eliminated across 10 command files
  - `withGlobalDb()`, `EMPTY_TOTALS` — 4 global commands refactored
- **README**: Expanded "Make your AI use it" section with full best-practice instruction block

### Fixed
- **DB transactions**: `clearFileData()` and `bulkInsert*()` now wrapped in transactions
- **N+1 query**: Batch `getOccurrencesByItems()` replaces per-item queries
- **Stats query**: `getStats()` reduced from 7 queries to 1
- **SQL injection**: `global-signatures.ts` — `t.kind = '${kind}'` → parameterized query
- **Session**: Eliminated duplicate `getMetadata` calls
- **Tasks**: Added null-check for `tableInfo` result

## [1.11.0] - 2026-03-07

### Added
- **Global Search**: Search across ALL indexed projects at once — 5 new tools
  - `aidex_global_init` — Scan directory tree, register indexed projects in `~/.aidex/global.db`, detect unindexed projects by project markers (`.csproj`, `package.json`, `Cargo.toml`, etc.)
  - `aidex_global_status` — List all registered projects with stats, sortable by name/size/recent
  - `aidex_global_query` — Cross-project term search (exact/contains/starts_with) with in-memory session caching (5-min TTL)
  - `aidex_global_signatures` — Search methods/types by name across all projects, filterable by kind
  - `aidex_global_refresh` — Update stats and remove stale projects
  - Uses SQLite `ATTACH DATABASE` for zero-copy queries — each project DB remains the single source of truth
  - `exclude` parameter on `global_init` to skip external repos (e.g., `["llama.cpp"]`)
  - Auto-updates global registry after `aidex_init` / `aidex_update`
- **Bulk Indexing**: `global_init` can auto-index all unindexed projects in one call
  - `index_unindexed: true` — Auto-index projects with ≤500 code files
  - Large projects (>500 files) are listed separately for user decision
  - File count estimation uses code-only extensions (matches what `init()` actually processes)
- **Progress UI**: Browser-based progress display for bulk indexing
  - `show_progress: true` — Opens `http://localhost:3334` with live progress bar
  - Server-Sent Events (SSE) for real-time updates
  - Shows per-project status (indexing/done/error), progress bar, scrolling log
  - Dark theme, auto-closes after completion
- **Project deduplication**: Parent projects that contain sub-projects are automatically removed
  - e.g., `AudioGrabber/` is skipped when `AudioGrabber/AudioGrabber/` and `AudioGrabber/AudioGrabber2/` exist
  - Existing duplicates in global DB are cleaned up on next `global_init` run
  - Reduced test index from 215 to 167 projects (48 parent-duplicates removed)
- **Extended excludes**: Better handling of embedded runtimes and external code
  - `init.ts`: Added `**/site-packages/**`, `**/Lib/**`, `**/fdk-aac/**` to DEFAULT_EXCLUDE
  - `global-init.ts`: Added Python venvs, embedded Python runtimes (Python310-313), `.cargo`, `packages`, `fdk-aac` to DEFAULT_EXCLUDED_DIRS

## [1.10.1] - 2026-03-07

### Fixed
- **npm package**: Exclude token files and `futureWork.md` from published package
- **gitignore negation patterns**: Filter out `!` negation patterns in `.gitignore` to prevent excluding all files
  - Negation patterns (e.g., `!.vscode/settings.json`) were passed to minimatch, which interpreted `!` as "NOT this pattern" — matching ALL files
  - This caused the entire index to be purged after initialization in projects with negation patterns (common in monorepos)

## [1.10.0] - 2026-02-17

### Added
- **Note History**: Archived notes are now searchable across sessions
  - Old notes are automatically archived when overwritten or cleared
  - `history: true` parameter to browse archived notes (newest first)
  - `search: "term"` parameter to search note history (case-insensitive)
  - `limit` parameter to control how many history entries are returned (default: 20)

## [1.9.1] - 2026-02-10

### Added
- **Rect Screenshot Mode**: New `mode: "rect"` for coordinate-based screen capture
  - Specify exact `x`, `y`, `width`, `height` in pixels
  - Useful with accessibility bounds (e.g., from WinfoMCP `get_element_details`)

### Fixed
- **Region screenshot flicker on Windows**: Fixed visual flicker during interactive region selection

## [1.9.0] - 2026-02-06

### Added
- **Cross-Platform Screenshots**: New `aidex_screenshot` tool for capturing screenshots directly from AI assistants
  - 4 capture modes: `fullscreen`, `active_window`, `window` (by title), `region` (interactive selection)
  - Cross-platform: Windows (PowerShell + .NET), macOS (screencapture), Linux (maim/scrot)
  - Multi-monitor support (select monitor by index)
  - Delay parameter (wait N seconds before capture)
  - Default: Saves to temp directory with fixed filename (overwrites for quick iteration)
  - Custom filename and save path supported
  - Returns file path so AI can immediately `Read` the image
  - No project index required - standalone utility
- **Window Listing**: New `aidex_windows` tool to list all open windows
  - Shows title, PID, and process name
  - Optional substring filter (case-insensitive)
  - Helper for `aidex_screenshot` mode="window"

### Technical
- New directory module: `src/commands/screenshot/` with platform-specific implementations
- Windows: PowerShell scripts written to temp .ps1 files (avoids quoting issues with inline C#)
- macOS: Uses native `screencapture` command (interactive selection built-in)
- Linux: Uses `maim` (preferred) with `scrot` fallback; `xdotool`/`wmctrl` for window operations
- Synchronous delay via `Atomics.wait` (Node >= 18)

## [1.8.1] - 2026-02-02

### Added
- **Cancelled status** for tasks: `backlog → active → done | cancelled`
  - Cancelled tasks preserved as documentation (not deleted)
  - Viewer: collapsible ❌ Cancelled section with strikethrough styling

### Fixed
- **`aidex_update` now respects exclude patterns**: Files in `build/`, `node_modules/`, `.gitignore` patterns are rejected
  - Previously the viewer's file watcher could re-index excluded files via `aidex_update`

### Technical
- Auto-migration: existing `tasks` table CHECK constraint updated to include `cancelled`
- Exported `DEFAULT_EXCLUDE` and `readGitignore` from `init.ts` for reuse

## [1.8.0] - 2026-02-02

### Added
- **Task Backlog**: Built-in project task management persisted in AiDex database
  - `aidex_task` - Create, read, update, delete tasks with priority, tags, and descriptions
  - `aidex_tasks` - List and filter tasks by status, priority, or tag
  - **Auto-logging**: Status changes and task creation are automatically recorded in task history
  - **Manual log entries**: Add notes to any task with the `log` action
  - Priorities: high (🔴), medium (🟡), low (⚪)
  - Statuses: backlog → active → done
  - Sort order support for custom ordering within same priority
- **Viewer Tasks Tab**: Interactive task management in the browser viewer
  - Priority-colored task list grouped by status
  - Done toggle directly from the viewer
  - Tag display

### Technical
- New database tables: `tasks` and `task_log` with auto-migration
- Tasks survive between sessions (persisted in SQLite)

## [1.7.0] - 2026-02-01

### Added
- **Gemini CLI support**: `aidex setup` now detects and registers AiDex with Gemini CLI (`~/.gemini/settings.json`)
- **VS Code Copilot support**: `aidex setup` now detects and registers AiDex with VS Code (`mcp.json` with `"servers"` key and `"type": "stdio"`)

### Changed
- JSON client config is now flexible: supports custom server key (`serversKey`) and extra fields (`extraFields`) per client
- Updated README with Gemini CLI and VS Code Copilot config examples

## [1.6.1] - 2026-02-01

### Fixed
- **MCP Server version**: Now reads version dynamically from package.json (was hardcoded to 1.3.0)
- **`aidex setup` for local installs**: Detects if `aidex` is globally available; falls back to `node /full/path/index.js` when not installed globally

## [1.6.0] - 2026-02-01

### Added
- **Auto CLAUDE.md instructions**: `aidex setup` now installs AI instructions in `~/.claude/CLAUDE.md`
  - Tells Claude to auto-run `aidex_init` when no `.aidex/` exists
  - Provides tool usage guide (prefer AiDex over Grep/Glob)
  - `aidex unsetup` cleanly removes the instructions block
- **Idempotent setup**: Re-running `aidex setup` updates existing config without errors

## [1.5.2] - 2026-02-01

### Fixed
- **`aidex setup` for Claude Code**: Uses `claude mcp add --scope user` instead of editing settings.json directly
- Claude Desktop, Cursor, Windsurf still use JSON config editing

## [1.5.1] - 2026-01-31

### Fixed
- **`aidex setup`**: Now creates config file if client directory exists but config is missing (e.g. fresh Claude Code install)

## [1.5.0] - 2026-01-31

### Added
- **`aidex setup`**: Auto-register AiDex as MCP server in all detected AI clients
  - Supports: Claude Code, Claude Desktop, Cursor, Windsurf
  - Cross-platform: Windows, macOS, Linux
- **`aidex unsetup`**: Remove AiDex registration from all clients
- **Postinstall hint**: Shows `Run "aidex setup"` after npm install

## [1.4.2] - 2026-01-31

### Added
- **npm package**: Published as `aidex-mcp` on npm (`npm install -g aidex-mcp`)
- **Dual CLI commands**: Both `aidex` and `aidex-mcp` work as command names
- **npm-publish.bat**: Script for easy npm publishing

### Changed
- README updated with npm install instructions

## [1.4.1] - 2026-01-31

### Fixed
- **Git Status for Subfolder Projects**: Viewer now correctly shows git status for projects that are subdirectories of a git repo (e.g., a library inside a monorepo)
  - `isGitRepo()` now uses `simpleGit().checkIsRepo()` instead of checking for `.git` directory — traverses parent dirs
  - New `toProjectRelative()` helper maps git-root-relative paths to project-relative paths
  - Files outside the project subfolder are properly filtered out

## [1.4.0] - 2026-01-31

### Breaking Changes
- **Renamed from CodeGraph to AiDex**: Package name, MCP server name, and all internal references updated
  - MCP prefix changes from `mcp__codegraph__` to `mcp__aidex__` (requires config update)
  - Index directory changed from `.codegraph/` to `.aidex/`
  - Batch scripts renamed: `codegraph-scan.bat` → `aidex-scan.bat`, `codegraph-init-all.bat` → `aidex-init-all.bat`
  - Old `.codegraph/` directories can be safely deleted

### Added
- **Automatic Cleanup**: `aidex_init` now removes files that became excluded (e.g., build outputs)
  - Reports `filesRemoved` count in result
  - Uses minimatch for proper glob pattern matching
- **Git Status in Viewer**: File tree now shows git status with cat icons
  - 🟢 Pushed (committed and up-to-date)
  - 🟡 Modified (uncommitted changes)
  - 🔵 Staged (added to index)
  - ⚪ Untracked (new files)
- **aidex-init-all.bat**: New batch script to recursively index all git projects in a directory tree

### Changed
- Added minimatch dependency for exclude pattern handling
- Updated all documentation (README, CLAUDE.md, MCP-API-REFERENCE) with correct MCP prefix info

## [1.3.0] - 2026-01-27

### Added
- **Interactive Viewer**: New `aidex_viewer` tool opens a browser-based project explorer
  - Interactive file tree (click to expand directories)
  - Click files to view signatures (types, methods)
  - Tabs: Code files / All files, Overview / Source code
  - **Live reload** with chokidar file watcher
  - WebSocket for real-time updates
  - Syntax highlighting with highlight.js
  - Runs on `http://localhost:3333`
- **Recent Files Filter**: New `modified_since` parameter for `aidex_files`
  - Find files changed in current session: `modified_since: "30m"`
  - Supports relative time (`2h`, `1d`, `1w`) and ISO dates

### Changed
- Viewer auto-reindexes changed files before refreshing tree

### Fixed
- Server version now correctly reports 1.3.0

## [1.2.0] - 2026-01-27

### Added
- **Session Notes**: New `aidex_note` tool to persist reminders between sessions
  - Write, append, read, and clear notes
  - Stored in SQLite database (survives restarts)
  - Use cases: handover notes, test reminders, context for next session
- **Session Tracking**: New `aidex_session` tool for automatic session management
  - Detects new sessions (>5 min since last activity)
  - Records session start/end times
  - Detects files modified externally (outside sessions)
  - Auto-reindexes changed files on session start
  - Returns session note if one exists

### Changed
- Database schema: Added `metadata` table for key-value storage (session times, notes)

## [1.1.0] - 2026-01-27

### Added
- **Time-based Filtering**: New `modified_since` and `modified_before` parameters for `aidex_query`
  - Relative time: `30m`, `2h`, `1d`, `1w`
  - ISO dates: `2026-01-27` or `2026-01-27T14:30:00`
  - Track line-level changes across updates
- **Project Structure**: New `aidex_files` tool to query all project files
  - File types: `code`, `config`, `doc`, `asset`, `test`, `other`, `dir`
  - Glob pattern filtering
  - Statistics by file type

### Changed
- `aidex_init` now indexes complete project structure (all files, not just code)
- `aidex_update` preserves modification timestamps for unchanged lines (hash-based diff)
- Path normalization to forward slashes across all commands

### Technical
- New `project_files` table in database schema
- New `line_hash` and `modified` columns in `lines` table
- Hash-based change detection for accurate timestamps

## [1.0.0] - 2026-01-27

### Added
- **11 Language Support**: C#, TypeScript, JavaScript, Rust, Python, C, C++, Java, Go, PHP, Ruby
- **Core Tools**:
  - `aidex_init` - Index a project
  - `aidex_query` - Search terms (exact/contains/starts_with)
  - `aidex_signature` - Get file signatures (methods, types)
  - `aidex_signatures` - Batch signatures with glob patterns
  - `aidex_update` - Re-index single files
  - `aidex_remove` - Remove files from index
  - `aidex_summary` - Project overview with auto-detected entry points
  - `aidex_tree` - File tree with statistics
  - `aidex_describe` - Add documentation to summary
  - `aidex_status` - Index statistics
- **Cross-Project Support**:
  - `aidex_link` - Link dependency projects
  - `aidex_unlink` - Remove linked projects
  - `aidex_links` - List all linked projects
- **Discovery**:
  - `aidex_scan` - Find all indexed projects in directory tree
  - CLI commands: `scan`, `init`
- **Technical**:
  - Tree-sitter parsing for accurate identifier extraction
  - SQLite with WAL mode for fast, reliable storage
  - Keyword filtering per language (excludes language keywords from index)
  - 1MB parser buffer for large files

### Infrastructure
- MCP Server protocol implementation
- MIT License
- Comprehensive documentation
