# AiDex MCP API Reference

Complete reference for all AiDex MCP tools.

---

## Table of Contents

- [Indexing](#indexing)
  - [aidex_init](#aidex_init)
  - [aidex_update](#aidex_update)
  - [aidex_remove](#aidex_remove)
- [Querying](#querying)
  - [aidex_query](#aidex_query)
  - [aidex_signature](#aidex_signature)
  - [aidex_signatures](#aidex_signatures)
- [Project Info](#project-info)
  - [aidex_status](#aidex_status)
  - [aidex_summary](#aidex_summary)
  - [aidex_tree](#aidex_tree)
  - [aidex_files](#aidex_files)
  - [aidex_describe](#aidex_describe)
- [Cross-Project](#cross-project)
  - [aidex_link](#aidex_link)
  - [aidex_unlink](#aidex_unlink)
  - [aidex_links](#aidex_links)
  - [aidex_scan](#aidex_scan)
- [Session Management](#session-management)
  - [aidex_session](#aidex_session)
  - [aidex_note](#aidex_note)
  - [aidex_viewer](#aidex_viewer)
- [Task Management](#task-management)
  - [aidex_task](#aidex_task)
  - [aidex_tasks](#aidex_tasks)
- [Global Search](#global-search)
  - [aidex_global_init](#aidex_global_init)
  - [aidex_global_status](#aidex_global_status)
  - [aidex_global_query](#aidex_global_query)
  - [aidex_global_signatures](#aidex_global_signatures)
  - [aidex_global_refresh](#aidex_global_refresh)
  - [aidex_global_guideline](#aidex_global_guideline)
- [Log Hub](#log-hub)
  - [aidex_log](#aidex_log)
- [Screenshots](#screenshots)
  - [aidex_screenshot](#aidex_screenshot)
  - [aidex_windows](#aidex_windows)

---

## Indexing

### aidex_init

Initialize or re-index a project. Creates `.aidex/` directory with SQLite database.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | ✅ | Absolute path to the project directory |
| `name` | string | - | Custom project name (default: directory name) |
| `exclude` | string[] | - | Additional glob patterns to exclude (e.g., `["**/test/**"]`) |

**Returns:**
- Files indexed count
- Items/methods/types found
- Duration in ms
- Warnings (if any)

**Example:**
```json
{
  "path": "/home/user/myproject",
  "exclude": ["**/vendor/**", "**/dist/**"]
}
```

---

### aidex_update

Re-index a single file after editing. Detects unchanged files via hash comparison.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | ✅ | Path to project with `.aidex` directory |
| `file` | string | ✅ | Relative path to file within project |

**Returns:**
- Items added/removed
- Methods/types updated
- Duration in ms
- "File unchanged" if hash matches

**Example:**
```json
{
  "path": "/home/user/myproject",
  "file": "src/Engine.cs"
}
```

---

### aidex_remove

Remove a deleted file from the index.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | ✅ | Path to project with `.aidex` directory |
| `file` | string | ✅ | Relative path to file to remove |

**Returns:**
- Success/failure status
- Items removed count

**Example:**
```json
{
  "path": "/home/user/myproject",
  "file": "src/OldFile.cs"
}
```

---

## Querying

### aidex_query

Search for terms/identifiers in the index. **Primary search tool** - use instead of grep/glob.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | ✅ | Path to project with `.aidex` directory |
| `term` | string | ✅ | The term to search for |
| `mode` | string | - | Search mode: `exact` (default), `contains`, `starts_with` |
| `file_filter` | string | - | Glob pattern to filter files (e.g., `"src/commands/**"`) |
| `type_filter` | string[] | - | Filter by line type: `code`, `comment`, `method`, `struct`, `property` |
| `modified_since` | string | - | Only matches after this time. Formats: `2h`, `30m`, `1d`, `1w`, or ISO date |
| `modified_before` | string | - | Only matches before this time. Same formats as above |
| `limit` | number | - | Maximum results (default: 100) |

**Returns:**
- Matches grouped by file with line numbers and types
- Total match count
- Truncation indicator if limit reached

**Examples:**

```json
// Find exact term
{ "path": ".", "term": "PlayerHealth" }

// Find anything containing "Update"
{ "path": ".", "term": "Update", "mode": "contains" }

// Find recent changes
{ "path": ".", "term": "render", "modified_since": "2h" }

// Filter by file location
{ "path": ".", "term": "API", "file_filter": "src/server/**" }

// Filter by code type
{ "path": ".", "term": "Calculate", "type_filter": ["method"] }
```

---

### aidex_signature

Get the signature of a single file: types, methods, header comments. **Use instead of reading entire files** when you only need structure.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | ✅ | Path to project with `.aidex` directory |
| `file` | string | ✅ | Relative path to file (e.g., `"src/Core/Engine.cs"`) |

**Returns:**
- Header comments (if any)
- Types: classes, structs, interfaces, enums with line numbers
- Methods: prototypes with visibility, static/async modifiers, line numbers

**Example:**
```json
{
  "path": "/home/user/myproject",
  "file": "src/Core/Engine.cs"
}
```

**Output example:**
```
# Signature: src/Core/Engine.cs

## Header Comments
Game engine core implementation

## Types (2)
- class Engine (line 15)
- struct Config (line 8)

## Methods (5)
- [public] void Initialize() :20
- [public async] Task LoadAsync(string path) :45
- [private] void Update(float delta) :78
```

---

### aidex_signatures

Get signatures for multiple files at once using glob pattern. Efficient for exploring codebase structure.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | ✅ | Path to project with `.aidex` directory |
| `pattern` | string | - | Glob pattern (e.g., `"src/**/*.cs"`, `"**/*.ts"`) |
| `files` | string[] | - | Explicit list of file paths (alternative to pattern) |

*Note: Provide either `pattern` OR `files`, not both.*

**Returns:**
- Compact summary per file: types and method counts
- Method list with modifiers and line numbers

**Examples:**
```json
// All TypeScript files
{ "path": ".", "pattern": "**/*.ts" }

// Specific directory
{ "path": ".", "pattern": "src/commands/**/*.ts" }

// Explicit file list
{ "path": ".", "files": ["src/index.ts", "src/server/tools.ts"] }
```

---

## Project Info

### aidex_status

Get index statistics for a project.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | - | Path to project (optional - shows server status if omitted) |

**Returns:**
- Schema version
- Counts: files, lines, items, occurrences, methods, types, dependencies
- Database size in bytes
- Database path

**Example:**
```json
{ "path": "/home/user/myproject" }
```

---

### aidex_summary

Get project overview including auto-detected entry points and main types.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | ✅ | Path to project with `.aidex` directory |

**Returns:**
- Project name
- Language breakdown
- Entry points (main files, index files)
- Main types (most referenced classes)
- Custom summary content (from `summary.md`)

**Example:**
```json
{ "path": "/home/user/myproject" }
```

---

### aidex_tree

Get file tree with optional statistics per file.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | ✅ | Path to project with `.aidex` directory |
| `subpath` | string | - | Subdirectory to list (default: project root) |
| `depth` | number | - | Maximum depth to traverse (default: unlimited) |
| `include_stats` | boolean | - | Include item/method/type counts per file |

**Returns:**
- Hierarchical file tree
- Optional: counts per file

**Examples:**
```json
// Full tree
{ "path": "." }

// Specific directory with stats
{ "path": ".", "subpath": "src/commands", "include_stats": true }

// Shallow tree
{ "path": ".", "depth": 2 }
```

---

### aidex_files

List all project files by type. Includes non-code files (config, docs, assets). Supports time-based filtering to find recently changed files.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | ✅ | Path to project with `.aidex` directory |
| `type` | string | - | Filter by type: `dir`, `code`, `config`, `doc`, `asset`, `test`, `other` |
| `pattern` | string | - | Glob pattern filter (e.g., `"**/*.md"`, `"src/**/*.ts"`) |
| `modified_since` | string | - | Only files indexed after this time. Formats: `30m`, `2h`, `1d`, `1w`, or ISO date |

**Returns:**
- Files grouped by directory
- Type statistics
- Indexed indicator (✓) for code files
- `lastIndexed` timestamp (when `modified_since` is used)

**Examples:**
```json
// All config files
{ "path": ".", "type": "config" }

// All markdown files
{ "path": ".", "pattern": "**/*.md" }

// All test files
{ "path": ".", "type": "test" }

// Files changed in the last 30 minutes (this session)
{ "path": ".", "modified_since": "30m" }

// Files changed in the last 2 hours
{ "path": ".", "modified_since": "2h" }
```

**File type detection:**

| Type | Extensions/Patterns |
|------|---------------------|
| `code` | `.cs`, `.ts`, `.js`, `.py`, `.rs`, `.go`, `.java`, `.c`, `.cpp`, `.php`, `.rb` |
| `config` | `.json`, `.yaml`, `.yml`, `.toml`, `.xml`, `.ini`, `.env` |
| `doc` | `.md`, `.txt`, `.rst`, `.adoc` |
| `asset` | `.png`, `.jpg`, `.svg`, `.ico`, `.woff`, `.ttf` |
| `test` | Files in `test/`, `tests/`, `__tests__/` or with `.test.`, `.spec.` |
| `other` | Everything else |

---

### aidex_describe

Add or update sections in the project summary (`summary.md`).

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | ✅ | Path to project with `.aidex` directory |
| `section` | string | ✅ | Section to update: `purpose`, `architecture`, `concepts`, `patterns`, `notes` |
| `content` | string | ✅ | Content to add |
| `replace` | boolean | - | Replace existing content (default: append) |

**Example:**
```json
{
  "path": ".",
  "section": "architecture",
  "content": "This project uses a layered architecture with commands, services, and repositories.",
  "replace": true
}
```

---

## Cross-Project

### aidex_link

Link another indexed project as a dependency. Enables cross-project queries.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | ✅ | Path to current project |
| `dependency` | string | ✅ | Path to dependency project (must have `.aidex`) |
| `name` | string | - | Display name for the dependency |

**Returns:**
- Link status
- Files available in dependency

**Example:**
```json
{
  "path": "/home/user/myapp",
  "dependency": "/home/user/shared-lib",
  "name": "SharedLib"
}
```

---

### aidex_unlink

Remove a linked dependency.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | ✅ | Path to current project |
| `dependency` | string | ✅ | Path to dependency to unlink |

**Example:**
```json
{
  "path": "/home/user/myapp",
  "dependency": "/home/user/shared-lib"
}
```

---

### aidex_links

List all linked dependencies.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | ✅ | Path to project with `.aidex` directory |

**Returns:**
- List of linked projects with:
  - Name
  - Path
  - File count
  - Availability status

**Example:**
```json
{ "path": "/home/user/myapp" }
```

---

### aidex_scan

Find all projects with AiDex indexes in a directory tree.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | ✅ | Root path to scan |
| `max_depth` | number | - | Maximum depth to scan (default: 10) |

**Returns:**
- List of indexed projects with:
  - Name
  - Path
  - Statistics (files, items, methods, types)
  - Last indexed timestamp

**Example:**
```json
{
  "path": "/home/user/projects",
  "max_depth": 5
}
```

---

## Session Management

### aidex_session

Start or continue a session. **Call at the start of every new chat session!**

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | ✅ | Path to project with `.aidex` directory |

**What it does:**

1. **Detects new session** - If >5 minutes since last activity
2. **Records session times** - Stores `last_session_start` and `last_session_end`
3. **Detects external changes** - Files modified outside sessions (hash comparison)
4. **Auto-reindexes** - Modified files are automatically updated
5. **Returns session note** - If one exists

**Returns:**
- `isNewSession`: boolean
- `sessionInfo`: last session start/end times, current session start
- `externalChanges`: list of modified/deleted files
- `reindexed`: list of auto-reindexed files
- `note`: session note (if set)

**Example:**
```json
{ "path": "." }
```

**Output example:**
```
🆕 **New Session Started**

## Last Session
- **Start:** 2026-01-27T10:00:00.000Z
- **End:** 2026-01-27T12:30:00.000Z
- **Duration:** 2h 30m

💡 Query last session changes with:
`aidex_query({ term: "...", modified_since: "1706349600000", modified_before: "1706358600000" })`

## External Changes Detected
Found 3 file(s) changed outside of session:

- ✏️ src/index.ts (modified)
- ✏️ src/utils.ts (modified)
- 🗑️ src/old-file.ts (deleted)

✅ Auto-reindexed 2 file(s)

## 📝 Session Note
Test the new feature after restart
```

---

### aidex_note

Read or write session notes. Persists in the database between sessions.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | ✅ | Path to project with `.aidex` directory |
| `note` | string | - | Note to save. If omitted, reads current note |
| `append` | boolean | - | Append to existing note instead of replacing (default: false) |
| `clear` | boolean | - | Clear the note (default: false) |
| `history` | boolean | - | Show archived note history, newest first (default: false) |
| `search` | string | - | Search term to find in note history (case-insensitive) |
| `limit` | number | - | Max history/search entries to return (default: 20) |
| `summary` | string | - | One-sentence summary for the archived note (~150 chars). Provide when writing (old note gets archived with this summary) or clearing. |

**Operations:**

| Parameters | Action |
|------------|--------|
| `{ path }` | Read current note |
| `{ path, note: "..." }` | Write/replace note (old note is archived) |
| `{ path, note: "...", append: true }` | Append to note |
| `{ path, clear: true }` | Delete note (old note is archived) |
| `{ path, history: true }` | Browse archived notes |
| `{ path, search: "term" }` | Search note history |

**Examples:**
```json
// Read note
{ "path": "." }

// Write note with summary for archive (old note auto-archived with summary)
{ "path": ".", "note": "Test glob fix after restart", "summary": "Previous: finished parser refactoring and tests" }

// Append to note
{ "path": ".", "note": "Also check edge cases", "append": true }

// Clear note (old note auto-archived)
{ "path": ".", "clear": true }

// Browse note history
{ "path": ".", "history": true }

// Search past notes
{ "path": ".", "search": "parser" }

// Last 5 archived notes
{ "path": ".", "history": true, "limit": 5 }
```

---

### aidex_viewer

Open an interactive project tree viewer in the browser. Provides visual exploration with live updates.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | ✅ | Path to project with `.aidex` directory |
| `action` | string | - | `open` (default) or `close` |

**Features:**

- **Interactive file tree** - Click directories to expand, click files to view signatures
- **Live reload** - File changes detected automatically via chokidar file watcher
- **Signature display** - Shows types (classes, interfaces) and methods with line numbers
- **WebSocket updates** - Real-time sync between file changes and browser

**Server:**
- Runs on `http://localhost:3333`
- Persistent until explicitly closed or MCP server restart

**Examples:**
```json
// Open viewer
{ "path": "." }

// Close viewer
{ "path": ".", "action": "close" }
```

**Output example:**
```
🖥️ Viewer opened at http://localhost:3333
```

---

## Task Management

### aidex_task

Manage a single task in the project backlog. Tasks persist in the AiDex database and survive between sessions.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | ✅ | Path to project with `.aidex` directory |
| `action` | string | ✅ | `create`, `read`, `update`, `delete`, or `log` |
| `id` | number | for read/update/delete/log | Task ID |
| `title` | string | for create | Task title |
| `description` | string | - | Task description (optional details) |
| `summary` | string | - | One-sentence summary (~150 chars). Shown in task list as table-of-contents. Write on create, update on changes. |
| `priority` | number | - | `1` = high, `2` = medium (default), `3` = low |
| `status` | string | - | `backlog` (default), `active`, `done`, `cancelled` |
| `tags` | string | - | Comma-separated tags (e.g., `"bug, viewer"`) |
| `source` | string | - | Where the task came from (e.g., `"code review of parser.ts:142"`) |
| `sort_order` | number | - | Sort order within same priority (lower = first, default: 0) |
| `note` | string | for log | Log note text |
| `due` | string | - | Due date: ISO date (`"2026-04-10"`) or relative from now (`"3d"`, `"1w"`, `"12h"`). Set to `""` to clear. |
| `interval` | string | - | Repeat interval after trigger: `"30m"`, `"2h"`, `"3d"`, `"1w"`. Omit or `""` for one-shot. |
| `task_action` | string | - | What to do when triggered (description of the action to perform) |
| `auto_go` | boolean | - | If `true`, auto-execute the action on trigger. Default: `false`. |

**Actions:**

| Action | Required params | Description |
|--------|----------------|-------------|
| `create` | `title` | Create a new task |
| `read` | `id` | Get task details + history log |
| `update` | `id` | Change any field (title, status, priority, etc.) |
| `delete` | `id` | Permanently remove a task |
| `log` | `id`, `note` | Add a note to the task history |

**Auto-logging:** Status changes and task creation are automatically recorded in the task history.

**Task Scheduler:** Tasks with `due` dates are tracked globally in `~/.aidex/global.db`. At every `aidex_session` call, overdue tasks from ALL projects are reported. Recurring tasks (`interval` set) automatically advance their due date. Setting a task to `done`/`cancelled` or clearing `due` removes it from the scheduler.

**Examples:**
```json
// Create a high-priority bug task with summary
{
  "path": ".", "action": "create",
  "title": "Fix memory leak in parser",
  "summary": "Parser allocates unbounded buffers for nested generics",
  "priority": 1, "tags": "bug, parser"
}

// Read task with history
{ "path": ".", "action": "read", "id": 1 }

// Mark as done
{ "path": ".", "action": "update", "id": 1, "status": "done" }

// Cancel a task
{ "path": ".", "action": "update", "id": 2, "status": "cancelled" }

// Add a log note
{ "path": ".", "action": "log", "id": 1, "note": "Root cause found: unbounded buffer" }

// Create a recurring task — check every 3 days
{
  "path": ".", "action": "create",
  "title": "Check PR status",
  "due": "3d", "interval": "3d",
  "task_action": "gh pr list --state open"
}

// One-shot reminder in 1 week
{
  "path": ".", "action": "create",
  "title": "Follow up on review",
  "due": "1w"
}

// Auto-execute task
{
  "path": ".", "action": "create",
  "title": "Refresh project stats",
  "due": "1d", "interval": "1d",
  "auto_go": true
}

// Clear a task's schedule
{ "path": ".", "action": "update", "id": 3, "due": "" }
```

---

### aidex_tasks

List and filter tasks in the project backlog. Returns tasks grouped by status and sorted by priority.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | ✅ | Path to project with `.aidex` directory |
| `status` | string | - | Filter: `backlog`, `active`, `done`, `cancelled` |
| `priority` | number | - | Filter: `1`, `2`, `3` |
| `tag` | string | - | Filter by tag (matches any task containing this tag) |

**Returns:**
- Tasks grouped by status (Active → Backlog → Done → Cancelled)
- Priority icons: 🔴 high, 🟡 medium, ⚪ low
- Task summaries shown inline (one-sentence table-of-contents)
- Tags displayed inline
- Due dates shown with ⏰ indicator (OVERDUE if past due)
- Recurring intervals displayed inline

**Examples:**
```json
// All tasks
{ "path": "." }

// Only active tasks
{ "path": ".", "status": "active" }

// High priority bugs
{ "path": ".", "priority": 1, "tag": "bug" }
```

---

## Global Search

Search across ALL indexed projects at once. Uses a global database (`~/.aidex/global.db`) that references each project's own `.aidex/index.db`. Queries use SQLite `ATTACH DATABASE` — no data copying, each project DB is the single source of truth.

### aidex_global_init

Scan a directory tree for AiDex-indexed projects and register them in the global database. Also detects unindexed projects by looking for project markers (`.csproj`, `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `CMakeLists.txt`, etc.).

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Root directory to scan (e.g., `"Q:/develop"`) |
| `max_depth` | number | No | Maximum directory depth to scan (default: 10) |
| `tags` | string | No | Comma-separated tags for all found projects (e.g., `"privat,libs"`) |
| `exclude` | string[] | No | Directory names or absolute paths to exclude (e.g., `["llama.cpp", "Q:/develop/external"]`) |
| `index_unindexed` | boolean | No | Auto-index all unindexed projects with ≤500 estimated code files. Large projects (>500 files) are listed separately for user decision |
| `show_progress` | boolean | No | Open a browser window (`http://localhost:3334`) showing live indexing progress. Only effective with `index_unindexed: true` |

**Examples:**
```json
// Scan and register existing indexes
{ "path": "Q:/develop", "exclude": ["llama.cpp", "node_modules"] }

// Scan, register, AND auto-index all unindexed projects with progress UI
{ "path": "Q:/develop", "index_unindexed": true, "show_progress": true }
```

**Returns:** Count of registered/new/updated/removed projects, list of unindexed projects with their markers, totals across all registered projects. When `index_unindexed` is true, also returns `indexedResults` (per-project success/failure) and `largeProjects` (projects >500 files needing user decision).

---

### aidex_global_status

Show overview of all projects registered in the global index.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `tag_filter` | string | No | Only show projects with this tag |
| `sort` | string | No | Sort order: `"name"` (default), `"size"` (most files first), `"recent"` (most recently indexed first) |

**Example:**
```json
{ "sort": "recent" }
```

**Returns:** Table of all registered projects with name, path, languages, file/method/type counts, and last indexed time.

---

### aidex_global_query

Search for a term across all registered projects. Results are cached in memory for 5 minutes.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `term` | string | Yes | Term to search for |
| `mode` | string | No | `"exact"` (default), `"contains"`, or `"starts_with"` |
| `tag_filter` | string | No | Only search projects with this tag |

**Example:**
```json
{ "term": "TransparentWindow", "mode": "contains" }
```

**Returns:** Matches grouped by project, showing file paths and line numbers.

---

### aidex_global_signatures

Search for methods or types by name across all registered projects.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | Yes | Method or type name to search for |
| `kind` | string | No | Filter by kind: `"method"`, `"class"`, `"struct"`, `"interface"`, `"enum"`, `"type"` |
| `tag_filter` | string | No | Only search projects with this tag |

**Example:**
```json
{ "name": "Render", "kind": "method" }
```

**Returns:** Matching methods (with prototype, visibility, file, line) and types (with kind, file, line), grouped by project.

---

### aidex_global_refresh

Update statistics for all registered projects and remove projects whose paths no longer exist.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `tag_filter` | string | No | Only refresh projects with this tag |

**Example:**
```json
{}
```

**Returns:** Count of updated and removed projects, plus updated totals.

---

### aidex_global_guideline

Store, retrieve, list, or delete persistent AI guidelines and coding conventions. Stored in `~/.aidex/global.db` — available across all projects without requiring `aidex_init`. Perfect for team coding conventions, review checklists, and reusable AI instructions.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | Yes | `set`, `get`, `list`, or `delete` |
| `key` | string | for set/get/delete | Guideline name (e.g., `"review"`, `"style"`, `"release"`) |
| `value` | string | for set | The guideline content to store |
| `filter` | string | No | Substring filter for `list` action |

**Examples:**
```json
{ "action": "set", "key": "review", "value": "Check: error handling, null safety, no magic strings, consistent naming" }
{ "action": "set", "key": "style", "value": "PascalCase classes, camelCase methods, 4-space indent, XML docs on public APIs" }
{ "action": "get", "key": "review" }
{ "action": "list" }
{ "action": "list", "filter": "code" }
{ "action": "delete", "key": "old-rule" }
```

**Returns:** For `get` — key, value, created/updated timestamps. For `list` — all matching guidelines. For `set`/`delete` — confirmation message.

---

## Log Hub

### aidex_log

Universal log receiver — any program (C#, Python, Node, etc.) can send logs via HTTP POST, queryable by the LLM. **Zero-cost when not used** — no server, no buffer, no resources until `init` is called. No project index required.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | string | ✅ | `init`, `free`, `status`, `query`, `clear`, or `write` |
| `port` | number | - | HTTP port (default: `3335`, used with `init`) |
| `buffer_size` | number | - | Ring buffer size (default: `10000`, used with `init`) |
| `persist` | boolean | - | Enable SQLite persistence (default: `false`, used with `init`) |
| `path` | string | - | Project path for DB persistence (required when `persist=true`) |
| `since` | string | - | Time filter for query: `"30m"`, `"2h"`, `"1d"`, or ISO date |
| `level` | string | - | Filter by level: `debug`, `info`, `warn`, `error` (query/write) |
| `source` | string | - | Filter by source name (query) |
| `contains` | string | - | Filter by message substring (query) |
| `limit` | number | - | Max entries to return (default: `50`, used with query) |
| `consume` | boolean | - | If true, returned entries are removed from buffer — ideal for polling without duplicates (default: `false`, used with query) |
| `message` | string | for write | Log message text |
| `data` | string | - | Optional JSON data (write) |

**Actions:**

| Action | Description |
|--------|-------------|
| `init` | Start HTTP server and ring buffer. Optional: `persist` + `path` for SQLite storage |
| `free` | Stop server, free all resources, release port |
| `status` | Show stats: entries, buffer usage, sources, level counts, port |
| `query` | Search logs with filters (since, level, source, contains, limit, consume). Newest first |
| `clear` | Clear the ring buffer (keep server running) |
| `write` | Inject a log entry as source "claude" |

**HTTP API (for external programs):**

| Endpoint | Method | Body | Description |
|----------|--------|------|-------------|
| `/log` | POST | `{ level, source, message, data? }` | Send single entry |
| `/logs` | POST | `[{ level, source, message, data? }, ...]` | Send batch |
| `/health` | GET | - | Status check |

Body limit: 64KB. CORS enabled. Levels: `debug`, `info`, `warn`, `error`.

**Examples:**
```json
// Start Log Hub
{ "action": "init" }

// Start with persistence
{ "action": "init", "persist": true, "path": "." }

// Query last 10 minutes of errors
{ "action": "query", "since": "10m", "level": "error" }

// Query by source
{ "action": "query", "source": "MyApp", "contains": "connection" }

// Poll and consume (entries removed from buffer after reading)
{ "action": "query", "consume": true }

// LLM writes a log entry
{ "action": "write", "level": "info", "message": "Starting debug session" }

// Stop and free
{ "action": "free" }
```

**Client snippets:**
```bash
# curl
curl -X POST localhost:3335/log -H "Content-Type: application/json" \
  -d '{"level":"info","source":"test","message":"Hello from curl"}'
```
```csharp
// C#
await new HttpClient().PostAsJsonAsync("http://localhost:3335/log",
    new { level = "info", source = "MyApp", message = "Player spawned", data = new { x = 10, y = 20 } });
```
```python
# Python
requests.post("http://localhost:3335/log",
    json={"level": "info", "source": "trainer", "message": "Epoch 5 done", "data": {"loss": 0.023}})
```
```typescript
// Node/TypeScript
fetch("http://localhost:3335/log", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({level: "info", source: "worker", message: "Job complete"})
});
```
```powershell
# PowerShell
Invoke-RestMethod -Method Post -Uri http://localhost:3335/log -ContentType "application/json" -Body '{"level":"info","source":"script","message":"Done"}'
```

**Viewer integration:** When the Viewer is running, a "Logs" tab shows live log entries via WebSocket with client-side filtering (level, source, text search, auto-scroll).

---

## Screenshots

### aidex_screenshot

Take a screenshot of the screen, a window, or an interactive region selection. Returns the file path so you can immediately `Read` the image. **No project index required.**

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `mode` | string | - | `fullscreen` (default), `active_window`, `window`, `region`, `rect` |
| `window_title` | string | for mode=window | Window title substring to match (use `aidex_windows` to find titles) |
| `x` | number | for mode=rect | X coordinate of the capture rectangle |
| `y` | number | for mode=rect | Y coordinate of the capture rectangle |
| `width` | number | for mode=rect | Width of the capture rectangle in pixels |
| `height` | number | for mode=rect | Height of the capture rectangle in pixels |
| `monitor` | number | - | Monitor index (0-based, default: primary). Only for fullscreen mode |
| `delay` | number | - | Seconds to wait before capturing (e.g., `3` to switch windows first) |
| `filename` | string | - | Custom filename (default: `aidex-screenshot.png`). Overwrites if exists |
| `save_path` | string | - | Custom directory (default: system temp directory) |

**Capture Modes:**

| Mode | Description | Platform tools |
|------|-------------|----------------|
| `fullscreen` | Entire screen (primary monitor or selected) | PowerShell / screencapture / maim |
| `active_window` | Currently focused window | Win32 API / screencapture / xdotool+maim |
| `window` | Specific window by title substring | EnumWindows / osascript / xdotool |
| `region` | User draws a rectangle interactively | WinForms overlay / screencapture -i / maim -s |
| `rect` | Capture specific coordinates (x, y, width, height) | PowerShell / screencapture / maim |

**Returns:**
- `file_path`: Absolute path to the saved PNG file
- `mode`: Which capture mode was used
- `monitor`: Which monitor was captured (if specified)

**Examples:**

```json
// Fullscreen (default)
{}

// Active window
{ "mode": "active_window" }

// Specific window by title
{ "mode": "window", "window_title": "Visual Studio Code" }

// Interactive region selection
{ "mode": "region" }

// Capture specific coordinates (e.g., from accessibility bounds)
{ "mode": "rect", "x": 100, "y": 200, "width": 800, "height": 600 }

// Fullscreen with delay and custom path
{ "delay": 3, "filename": "bug-report.png", "save_path": "/tmp/screenshots" }

// Second monitor
{ "monitor": 1 }
```

**Platform Requirements:**

| Platform | Required | Optional |
|----------|----------|----------|
| Windows | PowerShell (built-in) | - |
| macOS | screencapture (built-in) | osascript (built-in) |
| Linux | maim OR scrot | xdotool, wmctrl, slop (for region) |

---

### aidex_windows

List all open windows with their titles, PIDs, and process names. Use to find window titles for `aidex_screenshot` with `mode="window"`. **No project index required.**

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `filter` | string | - | Substring to filter window titles (case-insensitive) |

**Returns:**
- List of windows with `title`, `pid`, `process_name`
- Platform identifier

**Examples:**

```json
// All windows
{}

// Filter by title
{ "filter": "chrome" }

// Find a specific app
{ "filter": "Visual Studio" }
```

**Output example:**
```
# Open Windows (5)

Platform: win32

- **Visual Studio Code** (Code) [PID: 1234]
- **Chrome - Google** (chrome) [PID: 5678]
- **Windows Terminal** (WindowsTerminal) [PID: 9012]
```

---

## Time Format Reference

Used by `aidex_query` parameters `modified_since` and `modified_before`:

| Format | Example | Meaning |
|--------|---------|---------|
| Minutes | `30m` | 30 minutes ago |
| Hours | `2h` | 2 hours ago |
| Days | `1d` | 1 day ago |
| Weeks | `1w` | 1 week ago |
| ISO Date | `2026-01-27` | Specific date (midnight) |
| ISO DateTime | `2026-01-27T14:30:00` | Specific date and time |
| Unix timestamp | `1706349600000` | Milliseconds since epoch |

---

## Supported Languages

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
| HCL/Terraform | `.tf`, `.tfvars`, `.hcl` | @tree-sitter-grammars/tree-sitter-hcl |

---

## Database Schema

SQLite database at `.aidex/index.db`:

| Table | Purpose |
|-------|---------|
| `files` | Indexed files with path, hash, last_indexed timestamp |
| `lines` | Line objects with type (code/comment/method/struct) and hash |
| `items` | Unique terms/identifiers (case-insensitive) |
| `occurrences` | Term locations (item_id, file_id, line_id) |
| `signatures` | Header comments per file |
| `methods` | Method prototypes with visibility, static/async flags |
| `types` | Classes, structs, interfaces, enums |
| `dependencies` | Linked projects |
| `project_files` | All files with type classification |
| `metadata` | Key-value store (session times, notes, etc.) |
| `tasks` | Project backlog tasks (priority, status, tags, summary, timestamps) |
| `task_log` | Task history log (auto-logged status changes + manual notes) |

---

## Best Practices

1. **Start sessions with `aidex_session`** - Detects external changes automatically
2. **Use `aidex_query` instead of grep** - 50x less tokens, precise results
3. **Use `aidex_signature` instead of reading files** - Get structure without implementation
4. **Leave session notes** - Context persists between chat sessions
5. **Re-index after edits** - Call `aidex_update` for modified files
6. **Link related projects** - Query across multiple codebases
