/**
 * MCP Tool definitions and handlers for AiDex
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { init, query, signature, signatures, update, remove, summary, tree, describe, link, unlink, listLinks, scan, files, note, getSessionNote, session, formatSessionTime, formatDuration, task, tasks, screenshot, listWindows, globalInit, globalStatus, globalQuery, globalSignatures, globalRefresh, globalGuideline, log, type QueryMode, type TaskAction, type ScreenshotMode, type ScreenshotColors, type SignatureKind, type GuidelineAction, type LogAction, type LogLevel } from '../commands/index.js';
import type { TaskRow } from '../db/index.js';
import { openDatabase } from '../db/index.js';
import { startViewer, stopViewer } from '../viewer/index.js';
import { PRODUCT_NAME, PRODUCT_NAME_LOWER, PRODUCT_VERSION, INDEX_DIR, TOOL_PREFIX } from '../constants.js';

/**
 * Register all available tools
 */
export function registerTools(): Tool[] {
    return [
        {
            name: `${TOOL_PREFIX}init`,
            description: `Initialize ${PRODUCT_NAME} indexing for a project. Scans all source files and builds a searchable index of identifiers, methods, types, and signatures.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Absolute path to the project directory to index',
                    },
                    name: {
                        type: 'string',
                        description: 'Optional project name (defaults to directory name)',
                    },
                    exclude: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Additional glob patterns to exclude (e.g., ["**/test/**"])',
                    },
                    store_bodies: {
                        type: 'boolean',
                        description: 'Store full method bodies in DB. Required for embeddings. ~10-20 MB extra per project. Persisted across runs.',
                    },
                    embeddings: {
                        type: 'boolean',
                        description: 'Enable embeddings for this project (implies store_bodies=true). Builds semantic search vectors using jina-code by default.',
                    },
                    llm_endpoint: {
                        type: 'string',
                        description: 'LLM provider endpoint URL (https://api.anthropic.com / https://api.openai.com/v1 / https://openrouter.ai/api/v1 / http://localhost:11434 for Ollama). Persisted per project.',
                    },
                    llm_model: {
                        type: 'string',
                        description: 'LLM model name for the chosen endpoint (e.g. "claude-haiku-4-5", "gpt-4o-mini", "llama3.1:8b"). Persisted per project.',
                    },
                    llm_send_code: {
                        type: 'boolean',
                        description: 'PRIVACY SWITCH. If true, code snippets and doc bodies may be sent to the LLM during reranking. If false (default), only paths, names, and the user query are sent. Set true only for non-sensitive projects.',
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}query`,
            description: `Search for terms/identifiers in the ${PRODUCT_NAME} index. Returns file locations where the term appears. PREFERRED over Grep/Glob for code searches when ${INDEX_DIR}/ exists - faster and more precise. Use this instead of grep for finding functions, classes, variables by name.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    term: {
                        type: 'string',
                        description: 'The term to search for',
                    },
                    mode: {
                        type: 'string',
                        enum: ['exact', 'contains', 'starts_with'],
                        description: 'Search mode: exact match, contains, or starts_with (default: exact)',
                    },
                    file_filter: {
                        type: 'string',
                        description: 'Glob pattern to filter files (e.g., "src/commands/**")',
                    },
                    type_filter: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Filter by line type: code, comment, method, struct, property',
                    },
                    modified_since: {
                        type: 'string',
                        description: 'Only include lines modified after this time. Supports: "2h" (hours), "30m" (minutes), "1d" (days), "1w" (weeks), or ISO date string',
                    },
                    modified_before: {
                        type: 'string',
                        description: 'Only include lines modified before this time. Same format as modified_since',
                    },
                    limit: {
                        type: 'number',
                        description: 'Maximum number of results (default: 100)',
                    },
                },
                required: ['path', 'term'],
            },
        },
        {
            name: `${TOOL_PREFIX}status`,
            description: `Get ${PRODUCT_NAME} server status and statistics for an indexed project`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory (optional, shows server status if not provided)`,
                    },
                },
                required: [],
            },
        },
        {
            name: `${TOOL_PREFIX}signature`,
            description: 'Get the signature of a single file: header comments, types (classes/structs/interfaces), and method prototypes. Use this INSTEAD of reading entire files when you only need to know what methods/classes exist. Much faster than Read tool for understanding file structure.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    file: {
                        type: 'string',
                        description: 'Relative path to the file within the project (e.g., "src/Core/Engine.cs")',
                    },
                },
                required: ['path', 'file'],
            },
        },
        {
            name: `${TOOL_PREFIX}signatures`,
            description: 'Get signatures for multiple files at once using glob pattern or file list. Returns types and method prototypes. Use INSTEAD of reading multiple files when exploring codebase structure. Much more efficient than multiple Read calls.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    pattern: {
                        type: 'string',
                        description: 'Glob pattern to match files (e.g., "src/Core/**/*.cs", "**/*.ts")',
                    },
                    files: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Explicit list of relative file paths (alternative to pattern)',
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}update`,
            description: `Re-index a single file. Use after editing a file to update the ${PRODUCT_NAME} index. If the file is new, it will be added to the index. If unchanged (same hash), no update is performed.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    file: {
                        type: 'string',
                        description: 'Relative path to the file to update (e.g., "src/Core/Engine.cs")',
                    },
                },
                required: ['path', 'file'],
            },
        },
        {
            name: `${TOOL_PREFIX}remove`,
            description: `Remove a file from the ${PRODUCT_NAME} index. Use when a file has been deleted from the project.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    file: {
                        type: 'string',
                        description: 'Relative path to the file to remove (e.g., "src/OldFile.cs")',
                    },
                },
                required: ['path', 'file'],
            },
        },
        {
            name: `${TOOL_PREFIX}summary`,
            description: 'Get project summary including auto-detected entry points, main types, and languages. Also returns content from summary.md if it exists.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}tree`,
            description: 'Get the indexed file tree. Optionally filter by subdirectory, limit depth, or include statistics per file.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    subpath: {
                        type: 'string',
                        description: 'Subdirectory to list (default: project root)',
                    },
                    depth: {
                        type: 'number',
                        description: 'Maximum depth to traverse (default: unlimited)',
                    },
                    include_stats: {
                        type: 'boolean',
                        description: 'Include item/method/type counts per file',
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}describe`,
            description: 'Add or update a section in the project summary (summary.md). Use to document project purpose, architecture, key concepts, or patterns.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    section: {
                        type: 'string',
                        enum: ['purpose', 'architecture', 'concepts', 'patterns', 'notes'],
                        description: 'Section to update',
                    },
                    content: {
                        type: 'string',
                        description: 'Content to add to the section',
                    },
                    replace: {
                        type: 'boolean',
                        description: 'Replace existing section content (default: append)',
                    },
                },
                required: ['path', 'section', 'content'],
            },
        },
        {
            name: `${TOOL_PREFIX}link`,
            description: `Link a dependency project to enable cross-project queries. The dependency must have its own ${INDEX_DIR} index.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to current project with ${INDEX_DIR} directory`,
                    },
                    dependency: {
                        type: 'string',
                        description: 'Path to dependency project to link',
                    },
                    name: {
                        type: 'string',
                        description: 'Optional display name for the dependency',
                    },
                },
                required: ['path', 'dependency'],
            },
        },
        {
            name: `${TOOL_PREFIX}unlink`,
            description: 'Remove a linked dependency project.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to current project with ${INDEX_DIR} directory`,
                    },
                    dependency: {
                        type: 'string',
                        description: 'Path to dependency project to unlink',
                    },
                },
                required: ['path', 'dependency'],
            },
        },
        {
            name: `${TOOL_PREFIX}links`,
            description: 'List all linked dependency projects.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}scan`,
            description: `Scan a directory tree to find all projects with ${PRODUCT_NAME} indexes (${INDEX_DIR} directories). Use this to discover which projects are already indexed before using Grep/Glob - indexed projects should use ${TOOL_PREFIX}query instead.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Root path to scan for ${INDEX_DIR} directories`,
                    },
                    max_depth: {
                        type: 'number',
                        description: 'Maximum directory depth to scan (default: 10)',
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}files`,
            description: 'List all files and directories in the indexed project. Returns the complete project structure with file types (code, config, doc, asset, test, other) and whether each file is indexed for code search. Use modified_since to find files changed in this session.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    type: {
                        type: 'string',
                        enum: ['dir', 'code', 'config', 'doc', 'asset', 'test', 'other'],
                        description: 'Filter by file type',
                    },
                    pattern: {
                        type: 'string',
                        description: 'Glob pattern to filter files (e.g., "src/**/*.ts")',
                    },
                    modified_since: {
                        type: 'string',
                        description: 'Only files indexed after this time. Supports: "2h", "30m", "1d", "1w", or ISO date. Use to find files changed this session.',
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}note`,
            description: `Read or write a session note for the project. Notes persist in the ${PRODUCT_NAME} database. When a note is overwritten or cleared, the old note is automatically archived. Use history/search to browse past notes.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    note: {
                        type: 'string',
                        description: 'Note to save. If omitted, reads the current note.',
                    },
                    append: {
                        type: 'boolean',
                        description: 'If true, appends to existing note instead of replacing (default: false)',
                    },
                    clear: {
                        type: 'boolean',
                        description: 'If true, clears the note (default: false)',
                    },
                    history: {
                        type: 'boolean',
                        description: 'If true, shows archived note history (newest first)',
                    },
                    search: {
                        type: 'string',
                        description: 'Search term to find in note history (case-insensitive)',
                    },
                    limit: {
                        type: 'number',
                        description: 'Max history/search entries to return (default: 20)',
                    },
                    summary: {
                        type: 'string',
                        description: 'One-sentence summary for the archived note (~150 chars). Provide when writing (old note gets archived with this summary) or clearing.',
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}session`,
            description: `Start or check an ${PRODUCT_NAME} session. Call this at the beginning of a new chat session to: (1) detect files changed externally since last session, (2) auto-reindex modified files, (3) get session note and last session times. Returns info for "What did we do last session?" queries.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}viewer`,
            description: 'Open an interactive project tree viewer in the browser. Shows the indexed file structure with clickable nodes - click on a file to see its signature (header comments, types, methods). Uses a local HTTP server with WebSocket for live updates.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    action: {
                        type: 'string',
                        enum: ['open', 'close'],
                        description: 'Action to perform: open (default) or close the viewer',
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}task`,
            description: `Manage a single task in the project backlog. Actions: create (new task), read (get task + log), update (change fields), delete, log (add history note). Tasks persist in the ${PRODUCT_NAME} database. Completed tasks are preserved as documentation.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    action: {
                        type: 'string',
                        enum: ['create', 'read', 'update', 'delete', 'log'],
                        description: 'Action to perform on the task',
                    },
                    id: {
                        type: 'number',
                        description: 'Task ID (required for read/update/delete/log)',
                    },
                    title: {
                        type: 'string',
                        description: 'Task title (required for create)',
                    },
                    description: {
                        type: 'string',
                        description: 'Task description (optional details)',
                    },
                    summary: {
                        type: 'string',
                        description: 'One-sentence summary (~150 chars). Shown in task list as table-of-contents. Write it on create, update on changes.',
                    },
                    priority: {
                        type: 'number',
                        enum: [1, 2, 3],
                        description: 'Priority: 1=high, 2=medium (default), 3=low',
                    },
                    status: {
                        type: 'string',
                        enum: ['backlog', 'active', 'done', 'cancelled'],
                        description: 'Task status (default: backlog)',
                    },
                    tags: {
                        type: 'string',
                        description: 'Comma-separated tags (e.g., "bug, viewer, parser")',
                    },
                    source: {
                        type: 'string',
                        description: 'Where the task came from (freetext, e.g., "code review of parser.ts:142")',
                    },
                    sort_order: {
                        type: 'number',
                        description: 'Sort order within same priority (lower = first, default: 0)',
                    },
                    note: {
                        type: 'string',
                        description: 'Log note text (required for log action)',
                    },
                    due: {
                        type: 'string',
                        description: 'Due date: ISO date ("2026-04-10") or relative from now ("30s", "12h", "3d", "1w"). Set to "" to clear.',
                    },
                    interval: {
                        type: 'string',
                        description: 'Repeat interval after trigger: "30s", "30m", "2h", "3d", "1w". Omit or "" for one-shot.',
                    },
                    task_action: {
                        type: 'string',
                        description: 'What to do when triggered (description of the action to perform)',
                    },
                    auto_go: {
                        type: 'boolean',
                        description: 'If true, auto-execute the action on trigger. If false (default), just report.',
                    },
                },
                required: ['path', 'action'],
            },
        },
        {
            name: `${TOOL_PREFIX}tasks`,
            description: `List and filter tasks in the project backlog. Returns tasks grouped by status (active, backlog, done, cancelled) and sorted by priority. Use to get an overview of all open and completed work.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    status: {
                        type: 'string',
                        enum: ['backlog', 'active', 'done', 'cancelled'],
                        description: 'Filter by status (default: show all)',
                    },
                    priority: {
                        type: 'number',
                        enum: [1, 2, 3],
                        description: 'Filter by priority',
                    },
                    tag: {
                        type: 'string',
                        description: 'Filter by tag (matches any task containing this tag)',
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}screenshot`,
            description: 'Take a screenshot. Returns file path for Read. No index required. OPTIMIZATION STRATEGY: Always start with scale=0.5 + colors=2 (smallest). If text is unreadable, retry with colors=16. If still unclear, try scale=0.75 or omit colors for full quality. Remember what works for each window/app during the session to avoid retries.',
            inputSchema: {
                type: 'object',
                properties: {
                    mode: {
                        type: 'string',
                        enum: ['fullscreen', 'active_window', 'window', 'region', 'rect'],
                        description: 'Capture mode: fullscreen (default), active_window, window (by title), region (interactive selection), or rect (specific coordinates)',
                    },
                    window_title: {
                        type: 'string',
                        description: 'Window title substring to match (required when mode="window"). Use aidex_windows to find titles.',
                    },
                    monitor: {
                        type: 'number',
                        description: 'Monitor index (0-based, default: primary). Only applies to fullscreen mode.',
                    },
                    delay: {
                        type: 'number',
                        description: 'Seconds to wait before capturing (e.g., 3 to give time to switch windows)',
                    },
                    filename: {
                        type: 'string',
                        description: 'Custom filename (default: aidex-screenshot.png). Overwrites if exists.',
                    },
                    save_path: {
                        type: 'string',
                        description: 'Custom directory to save in (default: system temp directory)',
                    },
                    x: {
                        type: 'number',
                        description: 'X coordinate of the capture rectangle (required when mode="rect")',
                    },
                    y: {
                        type: 'number',
                        description: 'Y coordinate of the capture rectangle (required when mode="rect")',
                    },
                    width: {
                        type: 'number',
                        description: 'Width of the capture rectangle in pixels (required when mode="rect")',
                    },
                    height: {
                        type: 'number',
                        description: 'Height of the capture rectangle in pixels (required when mode="rect")',
                    },
                    scale: {
                        type: 'number',
                        description: 'Scale factor 0.1-1.0 (e.g., 0.5 = half size). Reduces resolution to save tokens. Default: no scaling.',
                    },
                    colors: {
                        type: 'number',
                        enum: [2, 4, 16, 256],
                        description: 'Reduce color palette: 2 (B&W, ideal for text), 4 (text + light shading), 16 (UI readable), 256 (good quality). Default: full color. Tip: Use 2 for text-only screenshots to dramatically reduce file size.',
                    },
                },
                required: [],
            },
        },
        {
            name: `${TOOL_PREFIX}windows`,
            description: 'List all open windows with their titles, PIDs, and process names. Use this to find the exact window title for aidex_screenshot with mode="window". No project index required.',
            inputSchema: {
                type: 'object',
                properties: {
                    filter: {
                        type: 'string',
                        description: 'Optional substring to filter window titles (case-insensitive)',
                    },
                },
                required: [],
            },
        },
        // ============================================================
        // Global Tools
        // ============================================================
        {
            name: `${TOOL_PREFIX}global_init`,
            description: `Scan a directory tree for ${PRODUCT_NAME}-indexed projects and register them in the global database (~/.aidex/global.db). Also finds unindexed projects (by markers like .csproj, package.json, Cargo.toml, etc.). Use this to enable cross-project searches with aidex_global_query.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Root directory to scan for projects (e.g., "Q:/develop")',
                    },
                    max_depth: {
                        type: 'number',
                        description: 'Maximum directory depth to scan (default: 10)',
                    },
                    tags: {
                        type: 'string',
                        description: 'Tags to assign to all found projects (e.g., "privat,libs")',
                    },
                    exclude: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Directory names or absolute paths to exclude from scanning (e.g., ["llama.cpp", "Q:/develop/Repos/external"])',
                    },
                    index_unindexed: {
                        type: 'boolean',
                        description: 'Auto-index all unindexed projects with ≤500 estimated files. Large projects (>500 files) are skipped and listed separately for user decision.',
                    },
                    show_progress: {
                        type: 'boolean',
                        description: 'Open a browser window showing indexing progress (only with index_unindexed)',
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}global_status`,
            description: `Show overview of all projects registered in the global ${PRODUCT_NAME} index. Lists project names, paths, file counts, languages, and last indexed times.`,
            inputSchema: {
                type: 'object',
                properties: {
                    tag_filter: {
                        type: 'string',
                        description: 'Only show projects with this tag',
                    },
                    sort: {
                        type: 'string',
                        enum: ['name', 'size', 'recent'],
                        description: 'Sort order: name (default), size (most files first), recent (most recently indexed first)',
                    },
                },
                required: [],
            },
        },
        {
            name: `${TOOL_PREFIX}global_query`,
            description: `Search for a term across ALL registered projects in the global ${PRODUCT_NAME} index. Returns matches grouped by project. Use this to find code across your entire codebase.`,
            inputSchema: {
                type: 'object',
                properties: {
                    term: {
                        type: 'string',
                        description: 'The term to search for',
                    },
                    mode: {
                        type: 'string',
                        enum: ['exact', 'contains', 'starts_with'],
                        description: 'Search mode: exact (default), contains, starts_with',
                    },
                    project_filter: {
                        type: 'string',
                        description: 'Glob pattern to filter project names (e.g., "Lib*")',
                    },
                    tag_filter: {
                        type: 'string',
                        description: 'Only search projects with this tag',
                    },
                    type_filter: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Filter by line type: code, comment, method, struct, property',
                    },
                    limit: {
                        type: 'number',
                        description: 'Max results per project (default: 20)',
                    },
                    limit_total: {
                        type: 'number',
                        description: 'Max results total across all projects (default: 100)',
                    },
                    no_cache: {
                        type: 'boolean',
                        description: 'Bypass session cache (default: false)',
                    },
                },
                required: ['term'],
            },
        },
        {
            name: `${TOOL_PREFIX}global_signatures`,
            description: `Search for methods and types by name across ALL registered projects. Returns method prototypes and type definitions grouped by project. Use to find "where is class X defined?" or "who has a method called Y?".`,
            inputSchema: {
                type: 'object',
                properties: {
                    term: {
                        type: 'string',
                        description: 'Method or type name to search for (case-insensitive, partial match)',
                    },
                    kind: {
                        type: 'string',
                        enum: ['method', 'class', 'struct', 'interface', 'enum', 'type'],
                        description: 'Filter by kind: method, class, struct, interface, enum, type. Omit to search all.',
                    },
                    project_filter: {
                        type: 'string',
                        description: 'Glob pattern to filter project names (e.g., "Lib*")',
                    },
                    tag_filter: {
                        type: 'string',
                        description: 'Only search projects with this tag',
                    },
                    limit: {
                        type: 'number',
                        description: 'Max results total (default: 50)',
                    },
                },
                required: ['term'],
            },
        },
        {
            name: `${TOOL_PREFIX}global_refresh`,
            description: `Refresh project statistics in the global ${PRODUCT_NAME} index. Updates file counts, method counts, etc. from each project's database. Removes projects whose paths no longer exist.`,
            inputSchema: {
                type: 'object',
                properties: {
                    project: {
                        type: 'string',
                        description: 'Refresh only this project (name or path). Omit to refresh all.',
                    },
                    tag_filter: {
                        type: 'string',
                        description: 'Only refresh projects with this tag',
                    },
                },
                required: [],
            },
        },
        {
            name: `${TOOL_PREFIX}global_guideline`,
            description: `Manage persistent guidelines in the global ${PRODUCT_NAME} database (~/.aidex/global.db). Guidelines are named key-value instructions that apply across all projects — e.g. "review" → detailed review checklist, "release-prep" → release steps, "new-feature" → conventions to follow. Use \`list\` at session start to load active guidelines. Works without prior global_init.`,
            inputSchema: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['set', 'get', 'list', 'delete'],
                        description: 'set: create/overwrite | get: read one | list: all (optional filter) | delete: remove',
                    },
                    key: {
                        type: 'string',
                        description: 'Guideline key/name (required for set, get, delete). Use short slugs like "review", "release-prep".',
                    },
                    value: {
                        type: 'string',
                        description: 'Guideline content — the full instruction text (required for set)',
                    },
                    filter: {
                        type: 'string',
                        description: 'Substring filter for keys when listing (optional)',
                    },
                },
                required: ['action'],
            },
        },
        {
            name: `${TOOL_PREFIX}log`,
            description: `Universal Log Hub — receive and query logs from any external program (C#, Python, Node, etc.) via HTTP. Zero-cost when not used. Actions: init (start HTTP server), free (stop server), status (show stats), query (search logs), clear (reset buffer), write (inject entry as "claude"), control_get (read all interactive dashboard control values), control_set (change one control — same set-point the user's dashboard slider drives, so the AI can tune live).`,
            inputSchema: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['init', 'free', 'status', 'query', 'clear', 'write', 'control_get', 'control_set'],
                        description: 'init: start server | free: stop server | status: stats | query: search logs | clear: reset buffer | write: inject entry | control_get: read all control values | control_set: set one control (id+value)',
                    },
                    port: {
                        type: 'number',
                        description: 'HTTP port (default: 3335, used with init)',
                    },
                    buffer_size: {
                        type: 'number',
                        description: 'Ring buffer size (default: 10000, used with init)',
                    },
                    persist: {
                        type: 'boolean',
                        description: 'Enable SQLite persistence (default: false, used with init)',
                    },
                    path: {
                        type: 'string',
                        description: 'Project path for DB persistence (required when persist=true)',
                    },
                    since: {
                        type: 'string',
                        description: 'Time filter for query: "30m", "2h", "1d", or ISO date',
                    },
                    level: {
                        type: 'string',
                        enum: ['debug', 'info', 'warn', 'error'],
                        description: 'Filter by log level (query/write)',
                    },
                    source: {
                        type: 'string',
                        description: 'Filter by source name (query)',
                    },
                    contains: {
                        type: 'string',
                        description: 'Filter by message substring (query)',
                    },
                    limit: {
                        type: 'number',
                        description: 'Max entries to return (default: 50, used with query)',
                    },
                    consume: {
                        type: 'boolean',
                        description: 'If true, returned entries are removed from the buffer — ideal for polling without duplicates (default: false, used with query)',
                    },
                    message: {
                        type: 'string',
                        description: 'Log message text (required for write)',
                    },
                    data: {
                        type: 'string',
                        description: 'Optional JSON data (write)',
                    },
                    id: {
                        type: 'string',
                        description: 'Control id to change (required for control_set). The source defines which controls exist.',
                    },
                    value: {
                        type: ['number', 'string'],
                        description: 'New control value (required for control_set)',
                    },
                },
                required: ['action'],
            },
        },
        {
            name: `${TOOL_PREFIX}settings`,
            description: `Open the AiDex Settings tab in the viewer (where the user configures embeddings, LLM provider/key/model, and the privacy switch). Use this when the user asks to "open my AiDex settings", "show my LLM configuration", "configure embeddings", etc. Without 'open: true' the tool returns the current settings as JSON for inspection.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory (defaults to current working directory if omitted on the server).`,
                    },
                    open: {
                        type: 'boolean',
                        description: 'If true, open the viewer (if not already running) and switch to the Settings tab.',
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}search`,
            description: `Semantic search across embedded code, docs, and workspace items (tasks/notes/history). Best for natural-language questions like "how do we handle retry with backoff" or "what does the error logging do" — finds the right file even when you don't know the identifier name. Requires \`embeddings: true\` on aidex_init for the project. Three modes: semantic (pure vector KNN), exact (identifier match like aidex_query), hybrid (RRF fusion of both — default and recommended).`,
            inputSchema: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'The search query — natural language for semantic, or a term for exact mode',
                    },
                    path: {
                        type: 'string',
                        description: 'Project path. Required for scope:"current" (default when path is set).',
                    },
                    scope: {
                        type: 'string',
                        enum: ['current', 'all', 'linked'],
                        description: 'current: only this project (default if path set). all: every project that has embeddings enabled. linked: this project + its linked dependencies.',
                    },
                    project_filter: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Glob patterns over project paths (e.g. ["Q:/develop/**"]). Combined with scope.',
                    },
                    source_kinds: {
                        type: 'array',
                        items: { type: 'string', enum: ['code', 'docs', 'workspace'] },
                        description: 'Filter by content kind. Default: all kinds.',
                    },
                    source_types: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Filter by source_type: method, type, doc-section, task, task-log, note, note-history.',
                    },
                    mode: {
                        type: 'string',
                        enum: ['semantic', 'hybrid', 'exact'],
                        description: 'semantic: pure vector KNN. exact: identifier match (like aidex_query). hybrid: both fused via RRF (default).',
                    },
                    k: {
                        type: 'number',
                        description: 'Number of results to return (default: 20)',
                    },
                    llm: {
                        type: 'string',
                        enum: ['auto', 'off', 'translate', 'rerank', 'expand+rerank'],
                        description: 'LLM-layer strategy. "auto" (default): translate non-English queries + rerank if a key is configured. "off": pure embeddings. "translate": just rewrite the query. "rerank": embeddings then LLM-reranking. "expand+rerank": split into 2-4 subqueries + LLM rerank. Per-project privacy switch llm_send_code controls whether code/snippets are sent.',
                    },
                },
                required: ['query'],
            },
        },
    ];
}

/**
 * Handle tool calls
 */
export async function handleToolCall(
    name: string,
    args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
        switch (name) {
            case `${TOOL_PREFIX}init`:
                return await handleInit(args);

            case `${TOOL_PREFIX}query`:
                return handleQuery(args);

            case `${TOOL_PREFIX}status`:
                return await handleStatus(args);

            case `${TOOL_PREFIX}signature`:
                return handleSignature(args);

            case `${TOOL_PREFIX}signatures`:
                return handleSignatures(args);

            case `${TOOL_PREFIX}update`:
                return handleUpdate(args);

            case `${TOOL_PREFIX}remove`:
                return handleRemove(args);

            case `${TOOL_PREFIX}summary`:
                return handleSummary(args);

            case `${TOOL_PREFIX}tree`:
                return handleTree(args);

            case `${TOOL_PREFIX}describe`:
                return handleDescribe(args);

            case `${TOOL_PREFIX}link`:
                return handleLink(args);

            case `${TOOL_PREFIX}unlink`:
                return handleUnlink(args);

            case `${TOOL_PREFIX}links`:
                return handleLinks(args);

            case `${TOOL_PREFIX}scan`:
                return handleScan(args);

            case `${TOOL_PREFIX}files`:
                return handleFiles(args);

            case `${TOOL_PREFIX}note`:
                return handleNote(args);

            case `${TOOL_PREFIX}session`:
                return handleSession(args);

            case `${TOOL_PREFIX}viewer`:
                return handleViewer(args);

            case `${TOOL_PREFIX}task`:
                return handleTask(args);

            case `${TOOL_PREFIX}tasks`:
                return handleTasks(args);

            case `${TOOL_PREFIX}screenshot`:
                return handleScreenshot(args);

            case `${TOOL_PREFIX}windows`:
                return handleWindows(args);

            case `${TOOL_PREFIX}global_init`:
                return await handleGlobalInit(args);

            case `${TOOL_PREFIX}global_status`:
                return handleGlobalStatus(args);

            case `${TOOL_PREFIX}global_query`:
                return handleGlobalQuery(args);

            case `${TOOL_PREFIX}global_signatures`:
                return handleGlobalSignatures(args);

            case `${TOOL_PREFIX}global_refresh`:
                return handleGlobalRefresh(args);

            case `${TOOL_PREFIX}global_guideline`:
                return handleGlobalGuideline(args);

            case `${TOOL_PREFIX}log`:
                return await handleLog(args);

            case `${TOOL_PREFIX}search`:
                return await handleSearch(args);

            case `${TOOL_PREFIX}settings`:
                return await handleSettings(args);

            default:
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Unknown tool: ${name}`,
                        },
                    ],
                };
        }
    } catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
        };
    }
}

/**
 * Handle init
 */
async function handleInit(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
    const path = args.path as string;
    if (!path) {
        return {
            content: [{ type: 'text', text: 'Error: path parameter is required' }],
        };
    }

    const result = await init({
        path,
        name: args.name as string | undefined,
        exclude: args.exclude as string[] | undefined,
        store_bodies: args.store_bodies as boolean | undefined,
        embeddings: args.embeddings as boolean | undefined,
        llm_endpoint: args.llm_endpoint as string | undefined,
        llm_model: args.llm_model as string | undefined,
        llm_send_code: args.llm_send_code as boolean | undefined,
    });

    if (result.success) {
        let message = `✓ ${PRODUCT_NAME} initialized for project\n\n`;
        message += `Database: ${result.indexPath}/index.db\n`;
        message += `Files indexed: ${result.filesIndexed}`;
        if (result.filesSkipped > 0) {
            message += ` (${result.filesSkipped} unchanged, skipped)`;
        }
        message += `\n`;
        if (result.filesRemoved > 0) {
            message += `Files removed: ${result.filesRemoved} (now excluded)\n`;
        }
        message += `Items found: ${result.itemsFound}\n`;
        message += `Methods found: ${result.methodsFound}\n`;
        message += `Types found: ${result.typesFound}\n`;
        message += `Duration: ${result.durationMs}ms`;

        if (result.embeddings) {
            const e = result.embeddings;
            message += `\n\nEmbeddings: ${e.embedded} embedded`;
            if (e.skipped > 0) message += `, ${e.skipped} unchanged (skipped)`;
            if (e.removed > 0) message += `, ${e.removed} pruned`;
            message += ` in ${e.durationMs}ms`;
        }

        if (result.errors.length > 0) {
            message += `\n\nWarnings (${result.errors.length}):\n`;
            message += result.errors.slice(0, 10).map(e => `  - ${e}`).join('\n');
            if (result.errors.length > 10) {
                message += `\n  ... and ${result.errors.length - 10} more`;
            }
        }

        return {
            content: [{ type: 'text', text: message }],
        };
    } else {
        return {
            content: [{ type: 'text', text: `Error: ${result.errors.join(', ')}` }],
        };
    }
}

/**
 * Handle query
 */
function handleQuery(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const path = args.path as string;
    const term = args.term as string;

    if (!path || !term) {
        return {
            content: [{ type: 'text', text: 'Error: path and term parameters are required' }],
        };
    }

    const result = query({
        path,
        term,
        mode: (args.mode as QueryMode) ?? 'exact',
        fileFilter: args.file_filter as string | undefined,
        typeFilter: args.type_filter as string[] | undefined,
        modifiedSince: args.modified_since as string | undefined,
        modifiedBefore: args.modified_before as string | undefined,
        limit: args.limit as number | undefined,
    });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    if (result.matches.length === 0) {
        return {
            content: [{ type: 'text', text: `No matches found for "${term}" (mode: ${result.mode})` }],
        };
    }

    // Format results
    let message = `Found ${result.totalMatches} match(es) for "${term}" (mode: ${result.mode})`;
    if (result.truncated) {
        message += ` [showing first ${result.matches.length}]`;
    }
    message += '\n\n';

    // Group by file
    const byFile = new Map<string, Array<{ lineNumber: number; lineType: string }>>();
    for (const match of result.matches) {
        if (!byFile.has(match.file)) {
            byFile.set(match.file, []);
        }
        byFile.get(match.file)!.push({ lineNumber: match.lineNumber, lineType: match.lineType });
    }

    for (const [file, lines] of byFile) {
        message += `${file}\n`;
        for (const line of lines) {
            message += `  :${line.lineNumber} (${line.lineType})\n`;
        }
    }

    return {
        content: [{ type: 'text', text: message.trimEnd() }],
    };
}

/**
 * Handle status
 */
async function handleStatus(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
    const path = args.path as string | undefined;

    if (!path) {
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        status: 'running',
                        version: PRODUCT_VERSION,
                        message: `${PRODUCT_NAME} MCP server is running. Use ${TOOL_PREFIX}init to index a project.`,
                    }, null, 2),
                },
            ],
        };
    }

    // Check if project has index
    const indexDir = join(path, INDEX_DIR);
    const dbPath = join(indexDir, 'index.db');

    if (!existsSync(dbPath)) {
        return {
            content: [
                {
                    type: 'text',
                    text: `No ${PRODUCT_NAME} index found at ${path}. Run ${TOOL_PREFIX}init first.`,
                },
            ],
        };
    }

    // Open database and get stats
    const db = openDatabase(dbPath, true);
    const stats = db.getStats();
    const projectName = db.getMetadata('project_name') ?? 'Unknown';
    const schemaVersion = db.getMetadata('schema_version') ?? 'Unknown';
    db.close();

    // Best-effort: include embeddings breakdown if the global DB exists
    // and this project has embeddings enabled. Failures are silently ignored —
    // status must always succeed even when the embeddings module is unavailable.
    let embeddings: {
        enabled: boolean;
        modelId?: string;
        dim?: number;
        total?: number;
        byKind?: Record<string, number>;
        byType?: Record<string, number>;
    } = { enabled: false };
    try {
        const { isProjectEnabled, getProjectInfo, getProjectEmbeddingBreakdown, ensureEmbeddingsSchema } = await import(
            '../embeddings/store.js'
        );
        ensureEmbeddingsSchema();
        if (isProjectEnabled(path)) {
            const info = getProjectInfo(path);
            if (info) {
                const breakdown = getProjectEmbeddingBreakdown(info.id);
                embeddings = {
                    enabled: true,
                    modelId: info.modelId,
                    dim: info.dim,
                    total: breakdown.total,
                    byKind: breakdown.byKind,
                    byType: breakdown.byType,
                };
            }
        }
    } catch {
        // module unavailable or DB error → leave embeddings as { enabled: false }
    }

    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    project: projectName,
                    schemaVersion,
                    statistics: stats,
                    embeddings,
                    databasePath: dbPath,
                }, null, 2),
            },
        ],
    };
}

/**
 * Handle signature
 */
function handleSignature(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const path = args.path as string;
    const file = args.file as string;

    if (!path || !file) {
        return {
            content: [{ type: 'text', text: 'Error: path and file parameters are required' }],
        };
    }

    const result = signature({ path, file });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    // Format output
    let message = `# Signature: ${result.file}\n\n`;

    // Header comments
    if (result.headerComments) {
        message += `## Header Comments\n\`\`\`\n${result.headerComments}\n\`\`\`\n\n`;
    }

    // Types
    if (result.types.length > 0) {
        message += `## Types (${result.types.length})\n`;
        for (const t of result.types) {
            message += `- **${t.kind}** \`${t.name}\` (line ${t.lineNumber})\n`;
        }
        message += '\n';
    }

    // Methods
    if (result.methods.length > 0) {
        message += `## Methods (${result.methods.length})\n`;
        for (const m of result.methods) {
            const modifiers: string[] = [];
            if (m.visibility) modifiers.push(m.visibility);
            if (m.isStatic) modifiers.push('static');
            if (m.isAsync) modifiers.push('async');
            const prefix = modifiers.length > 0 ? `[${modifiers.join(' ')}] ` : '';
            message += `- ${prefix}\`${m.prototype}\` (line ${m.lineNumber})\n`;
        }
    }

    if (result.types.length === 0 && result.methods.length === 0 && !result.headerComments) {
        message += '_No signature data found for this file._\n';
    }

    return {
        content: [{ type: 'text', text: message.trimEnd() }],
    };
}

/**
 * Handle signatures
 */
function handleSignatures(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const path = args.path as string;
    const pattern = args.pattern as string | undefined;
    const files = args.files as string[] | undefined;

    if (!path) {
        return {
            content: [{ type: 'text', text: 'Error: path parameter is required' }],
        };
    }

    if (!pattern && (!files || files.length === 0)) {
        return {
            content: [{ type: 'text', text: 'Error: either pattern or files parameter is required' }],
        };
    }

    const result = signatures({ path, pattern, files });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    if (result.signatures.length === 0) {
        const searchDesc = pattern ? `pattern "${pattern}"` : `files list`;
        return {
            content: [{ type: 'text', text: `No files found matching ${searchDesc}` }],
        };
    }

    // Format output - summary view
    let message = `# Signatures (${result.totalFiles} files)\n\n`;

    for (const sig of result.signatures) {
        if (!sig.success) {
            message += `## ${sig.file}\n_Error: ${sig.error}_\n\n`;
            continue;
        }

        message += `## ${sig.file}\n`;

        // Compact summary
        const parts: string[] = [];
        if (sig.types.length > 0) {
            const typesSummary = sig.types.map(t => `${t.kind} ${t.name}`).join(', ');
            parts.push(`Types: ${typesSummary}`);
        }
        if (sig.methods.length > 0) {
            parts.push(`Methods: ${sig.methods.length}`);
        }

        if (parts.length > 0) {
            message += parts.join(' | ') + '\n';
        }

        // List methods compactly
        if (sig.methods.length > 0) {
            for (const m of sig.methods) {
                const modifiers: string[] = [];
                if (m.visibility) modifiers.push(m.visibility);
                if (m.isStatic) modifiers.push('static');
                if (m.isAsync) modifiers.push('async');
                const prefix = modifiers.length > 0 ? `[${modifiers.join(' ')}] ` : '';
                message += `  - ${prefix}${m.prototype} :${m.lineNumber}\n`;
            }
        }

        message += '\n';
    }

    return {
        content: [{ type: 'text', text: message.trimEnd() }],
    };
}

/**
 * Handle update
 */
function handleUpdate(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const path = args.path as string;
    const file = args.file as string;

    if (!path || !file) {
        return {
            content: [{ type: 'text', text: 'Error: path and file parameters are required' }],
        };
    }

    const result = update({ path, file });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    // Check if file was unchanged
    if (result.error === 'File unchanged (hash match)') {
        return {
            content: [{ type: 'text', text: `File unchanged: ${result.file} (hash match, no update needed)` }],
        };
    }

    let message = `✓ Updated: ${result.file}\n`;
    message += `  Items: +${result.itemsAdded} / -${result.itemsRemoved}\n`;
    message += `  Methods: ${result.methodsUpdated}\n`;
    message += `  Types: ${result.typesUpdated}\n`;
    message += `  Duration: ${result.durationMs}ms`;

    return {
        content: [{ type: 'text', text: message }],
    };
}

/**
 * Handle remove
 */
function handleRemove(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const path = args.path as string;
    const file = args.file as string;

    if (!path || !file) {
        return {
            content: [{ type: 'text', text: 'Error: path and file parameters are required' }],
        };
    }

    const result = remove({ path, file });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    if (!result.removed) {
        return {
            content: [{ type: 'text', text: `File not in index: ${result.file}` }],
        };
    }

    return {
        content: [{ type: 'text', text: `✓ Removed from index: ${result.file}` }],
    };
}

/**
 * Handle summary
 */
function handleSummary(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const path = args.path as string;

    if (!path) {
        return {
            content: [{ type: 'text', text: 'Error: path parameter is required' }],
        };
    }

    const result = summary({ path });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    let message = `# Project: ${result.name}\n\n`;

    // Auto-generated info
    message += `## Overview\n`;
    message += `- **Files indexed:** ${result.autoGenerated.fileCount}\n`;
    message += `- **Languages:** ${result.autoGenerated.languages.join(', ') || 'None detected'}\n`;

    if (result.autoGenerated.entryPoints.length > 0) {
        message += `- **Entry points:** ${result.autoGenerated.entryPoints.join(', ')}\n`;
    }

    if (result.autoGenerated.mainTypes.length > 0) {
        message += `\n## Main Types\n`;
        for (const t of result.autoGenerated.mainTypes) {
            message += `- ${t}\n`;
        }
    }

    // User-provided summary content
    if (result.content) {
        message += `\n---\n\n${result.content}`;
    }

    return {
        content: [{ type: 'text', text: message.trimEnd() }],
    };
}

/**
 * Handle tree
 */
function handleTree(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const path = args.path as string;

    if (!path) {
        return {
            content: [{ type: 'text', text: 'Error: path parameter is required' }],
        };
    }

    const result = tree({
        path,
        subpath: args.subpath as string | undefined,
        depth: args.depth as number | undefined,
        includeStats: args.include_stats as boolean | undefined,
    });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    if (result.entries.length === 0) {
        return {
            content: [{ type: 'text', text: `No files found in ${result.root}` }],
        };
    }

    let message = `# File Tree: ${result.root} (${result.totalFiles} files)\n\n`;

    for (const entry of result.entries) {
        if (entry.type === 'directory') {
            message += `📁 ${entry.path}/\n`;
        } else {
            let stats = '';
            if (entry.itemCount !== undefined) {
                stats = ` [${entry.itemCount} items, ${entry.methodCount} methods, ${entry.typeCount} types]`;
            }
            message += `  📄 ${entry.path}${stats}\n`;
        }
    }

    return {
        content: [{ type: 'text', text: message.trimEnd() }],
    };
}

/**
 * Handle describe
 */
function handleDescribe(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const path = args.path as string;
    const section = args.section as string;
    const content = args.content as string;

    if (!path || !section || !content) {
        return {
            content: [{ type: 'text', text: 'Error: path, section, and content parameters are required' }],
        };
    }

    const validSections = ['purpose', 'architecture', 'concepts', 'patterns', 'notes'];
    if (!validSections.includes(section)) {
        return {
            content: [{ type: 'text', text: `Error: section must be one of: ${validSections.join(', ')}` }],
        };
    }

    const result = describe({
        path,
        section: section as 'purpose' | 'architecture' | 'concepts' | 'patterns' | 'notes',
        content,
        replace: args.replace as boolean | undefined,
    });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    return {
        content: [{ type: 'text', text: `✓ Updated section: ${result.section}` }],
    };
}

/**
 * Handle link
 */
function handleLink(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const path = args.path as string;
    const dependency = args.dependency as string;

    if (!path || !dependency) {
        return {
            content: [{ type: 'text', text: 'Error: path and dependency parameters are required' }],
        };
    }

    const result = link({
        path,
        dependency,
        name: args.name as string | undefined,
    });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    return {
        content: [{ type: 'text', text: `✓ Linked: ${result.name} (${result.filesAvailable} files)` }],
    };
}

/**
 * Handle unlink
 */
function handleUnlink(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const path = args.path as string;
    const dependency = args.dependency as string;

    if (!path || !dependency) {
        return {
            content: [{ type: 'text', text: 'Error: path and dependency parameters are required' }],
        };
    }

    const result = unlink({ path, dependency });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    if (!result.removed) {
        return {
            content: [{ type: 'text', text: `Dependency not found: ${dependency}` }],
        };
    }

    return {
        content: [{ type: 'text', text: `✓ Unlinked: ${dependency}` }],
    };
}

/**
 * Handle links
 */
function handleLinks(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const path = args.path as string;

    if (!path) {
        return {
            content: [{ type: 'text', text: 'Error: path parameter is required' }],
        };
    }

    const result = listLinks({ path });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    if (result.dependencies.length === 0) {
        return {
            content: [{ type: 'text', text: 'No linked dependencies.' }],
        };
    }

    let message = `# Linked Dependencies (${result.dependencies.length})\n\n`;

    for (const dep of result.dependencies) {
        const status = dep.available ? '✓' : '✗';
        const name = dep.name ?? 'unnamed';
        message += `${status} **${name}**\n`;
        message += `  Path: ${dep.path}\n`;
        message += `  Files: ${dep.filesAvailable}\n`;
        if (!dep.available) {
            message += `  ⚠️ Not available (index missing)\n`;
        }
        message += '\n';
    }

    return {
        content: [{ type: 'text', text: message.trimEnd() }],
    };
}

/**
 * Handle scan
 */
function handleScan(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const path = args.path as string;

    if (!path) {
        return {
            content: [{ type: 'text', text: 'Error: path parameter is required' }],
        };
    }

    const result = scan({
        path,
        maxDepth: args.max_depth as number | undefined,
    });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    if (result.projects.length === 0) {
        return {
            content: [{ type: 'text', text: `No ${PRODUCT_NAME} indexes found in ${result.searchPath}\n(scanned ${result.scannedDirs} directories)` }],
        };
    }

    let message = `# ${PRODUCT_NAME} Indexes Found (${result.projects.length})\n\n`;
    message += `Scanned: ${result.searchPath} (${result.scannedDirs} directories)\n\n`;

    for (const proj of result.projects) {
        message += `## ${proj.name}\n`;
        message += `- **Path:** ${proj.path}\n`;
        message += `- **Files:** ${proj.files} | **Items:** ${proj.items} | **Methods:** ${proj.methods} | **Types:** ${proj.types}\n`;
        message += `- **Last indexed:** ${proj.lastIndexed}\n`;
        message += '\n';
    }

    return {
        content: [{ type: 'text', text: message.trimEnd() }],
    };
}

/**
 * Handle files
 */
function handleFiles(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const path = args.path as string;

    if (!path) {
        return {
            content: [{ type: 'text', text: 'Error: path parameter is required' }],
        };
    }

    const result = files({
        path,
        type: args.type as string | undefined,
        pattern: args.pattern as string | undefined,
        modifiedSince: args.modified_since as string | undefined,
    });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    if (result.files.length === 0) {
        const since = args.modified_since as string | undefined;
        const msg = since
            ? `No files modified since ${since}.\n\nNote: \`modified_since\` checks when each file was last (re-)indexed, not when it was last edited. Files whose content is unchanged keep their old \`last_indexed\` timestamp. Run \`aidex_update\` after editing, or \`aidex_init\` to refresh the whole project.`
            : 'No files found in project.';
        return {
            content: [{ type: 'text', text: msg }],
        };
    }

    // Build summary
    let message = `# Project Files (${result.totalFiles})\n\n`;

    // Type statistics
    message += `## By Type\n`;
    for (const [type, count] of Object.entries(result.byType).sort()) {
        message += `- **${type}:** ${count}\n`;
    }
    message += '\n';

    // Group files by directory
    const byDir = new Map<string, typeof result.files>();
    for (const file of result.files) {
        const dir = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : '.';
        if (!byDir.has(dir)) {
            byDir.set(dir, []);
        }
        byDir.get(dir)!.push(file);
    }

    // List files (limit output for large projects)
    const MAX_ENTRIES = 200;
    let entriesShown = 0;

    message += `## Files\n`;
    for (const [dir, dirFiles] of [...byDir.entries()].sort()) {
        if (entriesShown >= MAX_ENTRIES) {
            message += `\n... and ${result.totalFiles - entriesShown} more files\n`;
            break;
        }

        // Show directory
        if (dir !== '.') {
            message += `\n📁 ${dir}/\n`;
            entriesShown++;
        }

        // Show files in directory
        for (const file of dirFiles) {
            if (entriesShown >= MAX_ENTRIES) break;

            const fileName = file.path.includes('/') ? file.path.substring(file.path.lastIndexOf('/') + 1) : file.path;
            const icon = file.type === 'dir' ? '📁' : '📄';
            const indexed = file.indexed ? ' ✓' : '';
            message += `  ${icon} ${fileName} (${file.type})${indexed}\n`;
            entriesShown++;
        }
    }

    return {
        content: [{ type: 'text', text: message.trimEnd() }],
    };
}

/**
 * Handle note
 */
function handleNote(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const path = args.path as string;

    if (!path) {
        return {
            content: [{ type: 'text', text: 'Error: path parameter is required' }],
        };
    }

    const result = note({
        path,
        note: args.note as string | undefined,
        append: args.append as boolean | undefined,
        clear: args.clear as boolean | undefined,
        history: args.history as boolean | undefined,
        search: args.search as string | undefined,
        limit: args.limit as number | undefined,
        summary: args.summary as string | undefined,
    });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    switch (result.action) {
        case 'clear':
            return {
                content: [{ type: 'text', text: '✓ Session note cleared (old note archived).' }],
            };

        case 'write':
            return {
                content: [{ type: 'text', text: `✓ Session note saved (old note archived):\n\n${result.note}` }],
            };

        case 'append':
            return {
                content: [{ type: 'text', text: `✓ Appended to session note:\n\n${result.note}` }],
            };

        case 'history':
        case 'search': {
            const entries = result.history ?? [];
            if (entries.length === 0) {
                const msg = result.action === 'search'
                    ? `No notes found matching "${args.search}".`
                    : 'No note history yet.';
                return { content: [{ type: 'text', text: msg }] };
            }

            const header = result.action === 'search'
                ? `🔍 Found ${entries.length} note(s) matching "${args.search}" (${result.historyCount} total in history):`
                : `📋 Note history (${entries.length} of ${result.historyCount} total, newest first):`;

            const lines = entries.map(e => {
                const date = new Date(e.created_at).toISOString().replace('T', ' ').slice(0, 19);
                const preview = e.note.length > 200 ? e.note.slice(0, 200) + '…' : e.note;
                if (e.summary) {
                    return `--- ${date} ---\n📋 ${e.summary}\n\n${preview}`;
                }
                return `--- ${date} ---\n${preview}`;
            });

            return {
                content: [{ type: 'text', text: `${header}\n\n${lines.join('\n\n')}` }],
            };
        }

        case 'read':
        default:
            if (!result.note) {
                return {
                    content: [{ type: 'text', text: 'No session note set for this project.' }],
                };
            }
            return {
                content: [{ type: 'text', text: `📝 Session Note:\n\n${result.note}` }],
            };
    }
}

/**
 * Handle session
 */
function handleSession(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const path = args.path as string;

    if (!path) {
        return {
            content: [{ type: 'text', text: 'Error: path parameter is required' }],
        };
    }

    const result = session({ path });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    let message = '';

    // Update banner — shown at the top once per version bump.
    if (result.embeddings?.updateBanner) {
        message += `> ${result.embeddings.updateBanner}\n\n`;
    }

    // Session status
    if (result.isNewSession) {
        message += '🆕 **New Session Started**\n\n';
    } else {
        message += '▶️ **Session Continued**\n\n';
    }

    // Last session info
    if (result.sessionInfo.lastSessionStart && result.sessionInfo.lastSessionEnd) {
        message += '## Last Session\n';
        message += `- **Start:** ${formatSessionTime(result.sessionInfo.lastSessionStart)}\n`;
        message += `- **End:** ${formatSessionTime(result.sessionInfo.lastSessionEnd)}\n`;
        message += `- **Duration:** ${formatDuration(result.sessionInfo.lastSessionStart, result.sessionInfo.lastSessionEnd)}\n`;
        message += `\n💡 Query last session changes with:\n\`${TOOL_PREFIX}query({ term: "...", modified_since: "${result.sessionInfo.lastSessionStart}", modified_before: "${result.sessionInfo.lastSessionEnd}" })\`\n\n`;
    }

    // External changes
    if (result.externalChanges.length > 0) {
        message += '## External Changes Detected\n';
        message += `Found ${result.externalChanges.length} file(s) changed outside of session:\n\n`;

        for (const change of result.externalChanges) {
            const icon = change.reason === 'deleted' ? '🗑️' : '✏️';
            message += `- ${icon} ${change.path} (${change.reason})\n`;
        }

        if (result.reindexed.length > 0) {
            message += `\n✅ Auto-reindexed ${result.reindexed.length} file(s)\n`;
        }
        message += '\n';
    }

    // Version update info
    if (result.updateInfo) {
        message += `## 🎉 Updated: v${result.updateInfo.previousVersion} → v${result.updateInfo.currentVersion}\n\n`;
        for (const highlight of result.updateInfo.highlights) {
            message += `- ${highlight}\n`;
        }
        message += `\nFull changelog: https://github.com/CSCSoftware/AiDex/blob/master/CHANGELOG.md\n\n`;
    }

    // Session note
    if (result.note) {
        message += '## 📝 Session Note\n';
        message += result.note + '\n';
    }

    // Embeddings status (only if enabled and has something to say)
    if (result.embeddings?.enabled) {
        const e = result.embeddings;
        const healthIcon = e.health === 'fresh' ? '🟢' : e.health === 'drifting' ? '🟡' : '🔴';
        message += `\n## 🧠 Embeddings\n`;
        message += `${healthIcon} ${e.totalEmbeddings} vectors · ${e.modelId} · ${e.health}\n`;
        if (e.hint) message += `_${e.hint}_\n`;
    }

    // Task Scheduler
    if (result.schedulerResult) {
        message += '\n## ⏰ Task Scheduler\n';
        if (result.schedulerResult.active) {
            message += 'Task-Scheduler active.\n';
            if (result.schedulerResult.dueTasks.length > 0) {
                const priorityIcon: Record<number, string> = { 1: '🔴', 2: '🟡', 3: '⚪' };
                message += `\n**${result.schedulerResult.dueTasks.length} task(s) due:**\n\n`;
                for (const dt of result.schedulerResult.dueTasks) {
                    const t = dt.task;
                    message += `- [${dt.projectName}] ${priorityIcon[t.priority]} **#${t.id}** ${t.title}\n`;
                    if (t.action) message += `  Action: ${t.action}\n`;
                    if (t.interval) message += `  Repeats: every ${t.interval}\n`;
                    if (dt.autoGo) message += `  ⚡ AUTO-EXECUTE\n`;
                }
            }
        }
        if (result.schedulerResult.errors.length > 0) {
            message += '\nScheduler warnings:\n';
            for (const err of result.schedulerResult.errors) {
                message += `- ⚠️ ${err}\n`;
            }
        }
    }

    return {
        content: [{ type: 'text', text: message.trimEnd() }],
    };
}

/**
 * Handle viewer
 */
async function handleViewer(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
    const path = args.path as string;
    const action = (args.action as string) || 'open';

    if (!path) {
        return {
            content: [{ type: 'text', text: 'Error: path parameter is required' }],
        };
    }

    // Check if index directory exists
    const indexPath = join(path, INDEX_DIR);
    if (!existsSync(indexPath)) {
        return {
            content: [{ type: 'text', text: `Error: No ${INDEX_DIR} directory found at ${path}. Run ${TOOL_PREFIX}init first.` }],
        };
    }

    if (action === 'close') {
        const message = stopViewer();
        return {
            content: [{ type: 'text', text: message }],
        };
    }

    try {
        const message = await startViewer(path);
        return {
            content: [{ type: 'text', text: `🖥️ ${message}` }],
        };
    } catch (error) {
        return {
            content: [{ type: 'text', text: `Error starting viewer: ${error instanceof Error ? error.message : String(error)}` }],
        };
    }
}

/**
 * Handle task (single task CRUD + log)
 */
function handleTask(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const path = args.path as string;
    const action = args.action as TaskAction;

    if (!path || !action) {
        return {
            content: [{ type: 'text', text: 'Error: path and action parameters are required' }],
        };
    }

    const result = task({
        path,
        action,
        id: args.id as number | undefined,
        title: args.title as string | undefined,
        description: args.description as string | undefined,
        summary: args.summary as string | undefined,
        priority: args.priority as 1 | 2 | 3 | undefined,
        status: args.status as 'backlog' | 'active' | 'done' | 'cancelled' | undefined,
        tags: args.tags as string | undefined,
        source: args.source as string | undefined,
        sort_order: args.sort_order as number | undefined,
        note: args.note as string | undefined,
        due: args.due as string | undefined,
        interval: args.interval as string | undefined,
        task_action: args.task_action as string | undefined,
        auto_go: args.auto_go as boolean | undefined,
    });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    const priorityLabel: Record<number, string> = { 1: '🔴 high', 2: '🟡 medium', 3: '⚪ low' };

    switch (result.action) {
        case 'create':
        case 'update': {
            const t = result.task!;
            let msg = `✓ Task #${t.id} ${result.action === 'create' ? 'created' : 'updated'}\n\n`;
            msg += `**${t.title}**\n`;
            if (t.summary) msg += `Summary: ${t.summary}\n`;
            msg += `Priority: ${priorityLabel[t.priority]} | Status: ${t.status}\n`;
            if (t.description) msg += `Description: ${t.description}\n`;
            if (t.tags) msg += `Tags: ${t.tags}\n`;
            if (t.source) msg += `Source: ${t.source}\n`;
            if (t.due) msg += `Due: ${new Date(t.due).toISOString()}\n`;
            if (t.interval) msg += `Interval: ${t.interval}\n`;
            if (t.action) msg += `Action: ${t.action}\n`;
            if (t.auto_go) msg += `Auto-execute: yes\n`;
            return { content: [{ type: 'text', text: msg.trimEnd() }] };
        }
        case 'read': {
            const t = result.task!;
            let msg = `# Task #${t.id}: ${t.title}\n\n`;
            if (t.summary) msg += `Summary: ${t.summary}\n`;
            msg += `Priority: ${priorityLabel[t.priority]} | Status: ${t.status}\n`;
            if (t.description) msg += `Description: ${t.description}\n`;
            if (t.tags) msg += `Tags: ${t.tags}\n`;
            if (t.source) msg += `Source: ${t.source}\n`;
            if (t.due) msg += `Due: ${new Date(t.due).toISOString()}\n`;
            if (t.interval) msg += `Interval: ${t.interval}\n`;
            if (t.action) msg += `Action: ${t.action}\n`;
            if (t.auto_go) msg += `Auto-execute: yes\n`;
            msg += `Created: ${new Date(t.created_at).toISOString()}\n`;
            if (t.completed_at) msg += `Completed: ${new Date(t.completed_at).toISOString()}\n`;
            if (result.log && result.log.length > 0) {
                msg += `\n## Log (${result.log.length})\n`;
                for (const entry of result.log) {
                    msg += `- [${new Date(entry.created_at).toISOString()}] ${entry.note}\n`;
                }
            }
            return { content: [{ type: 'text', text: msg.trimEnd() }] };
        }
        case 'delete':
            return { content: [{ type: 'text', text: `✓ Task #${args.id} deleted` }] };
        case 'log': {
            const t = result.task!;
            let msg = `✓ Log added to Task #${t.id}: ${t.title}\n\n`;
            msg += `## Log (${result.log!.length})\n`;
            for (const entry of result.log!) {
                msg += `- [${new Date(entry.created_at).toISOString()}] ${entry.note}\n`;
            }
            return { content: [{ type: 'text', text: msg.trimEnd() }] };
        }
        default:
            return { content: [{ type: 'text', text: 'Unknown action' }] };
    }
}

/**
 * Handle tasks (list/filter)
 */
function handleTasks(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const path = args.path as string;

    if (!path) {
        return {
            content: [{ type: 'text', text: 'Error: path parameter is required' }],
        };
    }

    const result = tasks({
        path,
        status: args.status as 'backlog' | 'active' | 'done' | 'cancelled' | undefined,
        priority: args.priority as 1 | 2 | 3 | undefined,
        tag: args.tag as string | undefined,
    });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    if (result.tasks.length === 0) {
        return {
            content: [{ type: 'text', text: 'No tasks found.' }],
        };
    }

    const priorityIcon: Record<number, string> = { 1: '🔴', 2: '🟡', 3: '⚪' };
    let msg = `# Task Backlog (${result.total})\n\n`;

    // Group by status
    const byStatus: Record<string, TaskRow[]> = { active: [], backlog: [], done: [], cancelled: [] };
    for (const t of result.tasks) {
        byStatus[t.status].push(t);
    }

    for (const [status, items] of Object.entries(byStatus)) {
        if (items.length === 0) continue;
        msg += `## ${status.charAt(0).toUpperCase() + status.slice(1)} (${items.length})\n`;
        for (const t of items) {
            msg += `- ${priorityIcon[t.priority]} **#${t.id}** ${t.title}`;
            if (t.summary) msg += ` — ${t.summary}`;
            if (t.due) {
                const isOverdue = t.due <= Date.now();
                const dueStr = new Date(t.due).toLocaleDateString();
                msg += isOverdue ? ` ⏰ OVERDUE:${dueStr}` : ` ⏰ ${dueStr}`;
                if (t.interval) msg += ` (every ${t.interval})`;
            }
            if (t.tags) msg += ` [${t.tags}]`;
            msg += '\n';
        }
        msg += '\n';
    }

    return {
        content: [{ type: 'text', text: msg.trimEnd() }],
    };
}

/**
 * Handle screenshot
 */
function handleScreenshot(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const result = screenshot({
        mode: args.mode as ScreenshotMode | undefined,
        window_title: args.window_title as string | undefined,
        monitor: args.monitor as number | undefined,
        delay: args.delay as number | undefined,
        filename: args.filename as string | undefined,
        save_path: args.save_path as string | undefined,
        x: args.x as number | undefined,
        y: args.y as number | undefined,
        width: args.width as number | undefined,
        height: args.height as number | undefined,
        scale: args.scale as number | undefined,
        colors: args.colors as ScreenshotColors | undefined,
    });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    let message = `Screenshot captured!\n\n`;
    message += `**File:** ${result.file_path}\n`;
    message += `**Mode:** ${result.mode}\n`;
    if (result.monitor !== undefined) {
        message += `**Monitor:** ${result.monitor}\n`;
    }
    if (result.scale !== undefined) {
        message += `**Scale:** ${Math.round(result.scale * 100)}%\n`;
    }
    if (result.colors !== undefined) {
        message += `**Colors:** ${result.colors}\n`;
    }
    if (result.original_size !== undefined && result.optimized_size !== undefined) {
        const saved = result.original_size - result.optimized_size;
        const pct = result.original_size > 0 ? Math.round((saved / result.original_size) * 100) : 0;
        message += `**Size:** ${formatBytes(result.original_size)} → ${formatBytes(result.optimized_size)} (${pct}% saved)\n`;
    }
    if (result.error) {
        message += `\n⚠️ ${result.error}\n`;
    }

    return {
        content: [{ type: 'text', text: message.trimEnd() }],
    };
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Handle windows listing
 */
function handleWindows(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const result = listWindows({
        filter: args.filter as string | undefined,
    });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    if (result.windows.length === 0) {
        let msg = 'No windows found.';
        if (args.filter) msg += ` (filter: "${args.filter}")`;
        return {
            content: [{ type: 'text', text: msg }],
        };
    }

    let message = `# Open Windows (${result.windows.length})\n\n`;

    for (const w of result.windows) {
        message += `- **${w.title}**`;
        if (w.process_name) message += ` (${w.process_name})`;
        message += ` [PID: ${w.pid}]\n`;
    }

    return {
        content: [{ type: 'text', text: message.trimEnd() }],
    };
}

// ============================================================
// Global Handlers
// ============================================================

/**
 * Handle global init
 */
async function handleGlobalInit(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
    const path = args.path as string;
    if (!path) {
        return {
            content: [{ type: 'text', text: 'Error: path parameter is required' }],
        };
    }

    const result = await globalInit({
        path,
        maxDepth: args.max_depth as number | undefined,
        tags: args.tags as string | undefined,
        exclude: args.exclude as string[] | undefined,
        indexUnindexed: args.index_unindexed as boolean | undefined,
        showProgress: args.show_progress as boolean | undefined,
    });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    let message = `# Global Index Updated\n\n`;
    message += `**Search path:** ${result.searchPath}\n\n`;
    message += `- **Registered:** ${result.registered} projects\n`;
    message += `- **New:** ${result.newProjects} projects\n`;
    message += `- **Updated:** ${result.updatedProjects} projects\n`;
    if (result.removedProjects > 0) {
        message += `- **Removed:** ${result.removedProjects} projects (path no longer exists)\n`;
    }

    // Show bulk indexing results
    if (result.indexedResults && result.indexedResults.length > 0) {
        const successCount = result.indexedResults.filter(r => r.success).length;
        const failCount = result.indexedResults.filter(r => !r.success).length;
        message += `\n## Bulk Indexed: ${successCount} OK` + (failCount > 0 ? `, ${failCount} failed` : '') + `\n\n`;
        for (const r of result.indexedResults) {
            if (r.success) {
                message += `- **${r.name}** — ${r.filesIndexed} files, ${r.methodsFound} methods\n`;
            } else {
                message += `- **${r.name}** — FAILED: ${r.error}\n`;
            }
        }
    }

    // Show large projects that need user decision
    if (result.largeProjects && result.largeProjects.length > 0) {
        message += `\n## Large Projects (${result.largeProjects.length}, >500 files estimated)\n\n`;
        for (const proj of result.largeProjects) {
            message += `- **${proj.name}** — \`${proj.path}\` (~${proj.estimatedFiles} files)\n`;
        }
        message += `\n**→ Ask the user** for each: index, skip, or permanently exclude its directory name?\n`;
    }

    // Show unindexed projects (only when NOT bulk indexing)
    if (result.unindexedProjects.length > 0) {
        const small = result.unindexedProjects.filter(p => p.estimatedFiles <= 500);
        const large = result.unindexedProjects.filter(p => p.estimatedFiles > 500);

        if (small.length > 0) {
            message += `\n## Not Indexed (${small.length} projects, ≤500 files)\n\n`;
            for (const proj of small) {
                message += `- **${proj.name}** — \`${proj.path}\` (${proj.markers.join(', ')}, ~${proj.estimatedFiles} files)\n`;
            }
        }

        if (large.length > 0) {
            message += `\n## Large Projects (${large.length}, >500 files estimated)\n\n`;
            for (const proj of large) {
                message += `- **${proj.name}** — \`${proj.path}\` (~${proj.estimatedFiles} files)\n`;
            }
        }

        message += `\n**→ Ask the user:** Should I index all ${small.length} smaller projects?`;
        if (large.length > 0) {
            message += ` Index the small ones FIRST, then come back and ask about the ${large.length} large one(s) — for each: index, skip, or permanently exclude its directory name?`;
        }
        message += `\n`;
    }

    message += `\n## Totals\n\n`;
    message += `| | Count |\n|---|---|\n`;
    message += `| Projects | ${result.totals.projects} |\n`;
    message += `| Files | ${result.totals.files} |\n`;
    message += `| Items | ${result.totals.items} |\n`;
    message += `| Methods | ${result.totals.methods} |\n`;
    message += `| Types | ${result.totals.types} |\n`;

    return {
        content: [{ type: 'text', text: message.trimEnd() }],
    };
}

/**
 * Handle global status
 */
function handleGlobalStatus(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const result = globalStatus({
        tagFilter: args.tag_filter as string | undefined,
        sort: args.sort as 'name' | 'size' | 'recent' | undefined,
    });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    if (result.projects.length === 0) {
        return {
            content: [{ type: 'text', text: 'No projects registered in global index. Run aidex_global_init first.' }],
        };
    }

    let message = `# Global ${PRODUCT_NAME} Index — ${result.projects.length} projects\n\n`;
    message += `| Project | Files | Methods | Types | Languages | Last Indexed | Tags |\n`;
    message += `|---------|-------|---------|-------|-----------|-------------|------|\n`;

    for (const p of result.projects) {
        const lastIndexed = p.lastIndexed ? formatRelativeTime(p.lastIndexed) : 'unknown';
        const available = p.available ? '' : ' (unavailable)';
        const tags = p.tags ?? '';
        const langs = p.languages ?? '';
        message += `| ${p.name}${available} | ${p.files} | ${p.methods} | ${p.types} | ${langs} | ${lastIndexed} | ${tags} |\n`;
    }

    message += `\n**Totals:** ${result.totals.projects} projects | ${result.totals.files} files | ${result.totals.methods} methods | ${result.totals.types} types\n`;
    message += `**Database:** ${result.globalDbPath}`;

    return {
        content: [{ type: 'text', text: message.trimEnd() }],
    };
}

/**
 * Handle global query
 */
function handleGlobalQuery(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const term = args.term as string;
    if (!term) {
        return {
            content: [{ type: 'text', text: 'Error: term parameter is required' }],
        };
    }

    const result = globalQuery({
        term,
        mode: args.mode as 'exact' | 'contains' | 'starts_with' | undefined,
        projectFilter: args.project_filter as string | undefined,
        tagFilter: args.tag_filter as string | undefined,
        typeFilter: args.type_filter as string[] | undefined,
        limit: args.limit as number | undefined,
        limitTotal: args.limit_total as number | undefined,
        noCache: args.no_cache as boolean | undefined,
    });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    if (result.totalMatches === 0) {
        let msg = `No matches for "${result.term}" (mode: ${result.mode}) across ${result.projectsSearched} projects.`;
        if (result.cached) msg += ' (cached)';
        return {
            content: [{ type: 'text', text: msg }],
        };
    }

    let message = `# Global Search: "${result.term}" (${result.mode})\n\n`;
    message += `Found **${result.totalMatches}** matches in **${result.projectResults.length}** projects`;
    message += ` (searched ${result.projectsSearched})`;
    if (result.cached) message += ' *(cached)*';
    message += '\n';

    for (const pr of result.projectResults) {
        message += `\n## ${pr.project}\n`;
        message += `\`${pr.projectPath}\`\n\n`;

        for (const m of pr.matches) {
            message += `- ${m.file}:${m.lineNumber} [${m.lineType}]\n`;
        }
    }

    return {
        content: [{ type: 'text', text: message.trimEnd() }],
    };
}

/**
 * Handle global signatures
 */
function handleGlobalSignatures(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const term = args.term as string;
    if (!term) {
        return {
            content: [{ type: 'text', text: 'Error: term parameter is required' }],
        };
    }

    const result = globalSignatures({
        term,
        kind: args.kind as SignatureKind | undefined,
        projectFilter: args.project_filter as string | undefined,
        tagFilter: args.tag_filter as string | undefined,
        limit: args.limit as number | undefined,
    });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    const totalResults = result.totalMethods + result.totalTypes;
    if (totalResults === 0) {
        return {
            content: [{ type: 'text', text: `No methods or types matching "${result.term}" found across ${result.projectsSearched} projects.` }],
        };
    }

    let message = `# Global Signatures: "${result.term}"`;
    if (result.kind !== 'all') message += ` (kind: ${result.kind})`;
    message += `\n\nFound **${result.totalMethods}** methods and **${result.totalTypes}** types across **${result.projectResults.length}** projects\n`;

    for (const pr of result.projectResults) {
        message += `\n## ${pr.project}\n`;
        message += `\`${pr.projectPath}\`\n`;

        if (pr.types.length > 0) {
            message += `\n### Types\n`;
            for (const t of pr.types) {
                message += `- ${t.kind} **${t.name}** — ${t.file}:${t.lineNumber}\n`;
            }
        }

        if (pr.methods.length > 0) {
            message += `\n### Methods\n`;
            for (const m of pr.methods) {
                const mods: string[] = [];
                if (m.visibility) mods.push(m.visibility);
                if (m.isStatic) mods.push('static');
                if (m.isAsync) mods.push('async');
                const prefix = mods.length > 0 ? `[${mods.join(' ')}] ` : '';
                message += `- ${prefix}${m.prototype} — ${m.file}:${m.lineNumber}\n`;
            }
        }
    }

    return {
        content: [{ type: 'text', text: message.trimEnd() }],
    };
}

/**
 * Derive a one-line summary from a guideline's full text for the `list` view.
 * Picks the first non-empty, non-decorative line (skips markdown headings that
 * only repeat the key, separator rules, and block markers), strips markdown
 * noise, and truncates to keep the listing scannable.
 */
function summarizeGuideline(key: string, value: string): string {
    const lines = value.split('\n');
    for (const raw of lines) {
        let line = raw.trim();
        if (!line) continue;
        // Skip horizontal rules and decorative separators (---, ===, ──, ##).
        if (/^[#=\-─━*_>\s]*$/.test(line)) continue;
        // Strip leading markdown heading hashes / blockquote / list markers.
        line = line.replace(/^#{1,6}\s+/, '').replace(/^>\s+/, '').replace(/^[-*]\s+/, '');
        // Strip inline bold/italic/code markers.
        line = line.replace(/[*_`]/g, '').trim();
        if (!line) continue;
        // Skip a heading that just repeats the key (case-insensitive).
        if (line.toLowerCase() === key.toLowerCase()) continue;
        const max = 100;
        return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line;
    }
    return '(no description)';
}

/**
 * Handle global refresh
 */
function handleGlobalGuideline(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const action = args.action as string;
    if (!action) {
        return { content: [{ type: 'text', text: 'Error: action parameter is required' }] };
    }

    const result = globalGuideline({
        action: action as GuidelineAction,
        key: args.key as string | undefined,
        value: args.value as string | undefined,
        filter: args.filter as string | undefined,
    });

    if (!result.success) {
        return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
    }

    switch (result.action) {
        case 'set':
        case 'get': {
            const g = result.guideline!;
            const updated = new Date(g.updated_at).toLocaleString();
            const created = new Date(g.created_at).toLocaleString();
            let msg = `# Guideline: ${g.key}\n\n${g.value}\n\n`;
            msg += `*Created: ${created} | Updated: ${updated}*`;
            return { content: [{ type: 'text', text: msg }] };
        }

        case 'list': {
            const rows = result.guidelines!;
            if (rows.length === 0) {
                return { content: [{ type: 'text', text: 'No guidelines found.' }] };
            }
            // Keys + one-line summary only — the full text can be huge and
            // overflow the tool result. Fetch a guideline's body with `get`.
            let msg = `# Guidelines (${rows.length}) — keys + summary\n\n`;
            msg += `Use \`get\` with a key to read the full text.\n\n`;
            for (const g of rows) {
                const summary = summarizeGuideline(g.key, g.value);
                const updated = new Date(g.updated_at).toLocaleDateString();
                msg += `- **${g.key}** — ${summary}  _(updated ${updated})_\n`;
            }
            return { content: [{ type: 'text', text: msg.trimEnd() }] };
        }

        case 'delete':
            return {
                content: [{
                    type: 'text',
                    text: result.deleted
                        ? `Guideline "${args.key}" deleted.`
                        : `Guideline "${args.key}" not found.`,
                }],
            };
    }
}

function handleGlobalRefresh(args: Record<string, unknown>): { content: Array<{ type: string; text: string }> } {
    const result = globalRefresh({
        project: args.project as string | undefined,
        tagFilter: args.tag_filter as string | undefined,
    });

    if (!result.success) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    let message = `# Global Index Refreshed\n\n`;
    message += `- **Updated:** ${result.updated} projects\n`;

    if (result.removed > 0) {
        message += `- **Removed:** ${result.removed} projects (path no longer exists)\n`;
        for (const path of result.removedPaths) {
            message += `  - \`${path}\`\n`;
        }
    }

    message += `\n## Totals\n\n`;
    message += `${result.totals.projects} projects | ${result.totals.files} files | ${result.totals.methods} methods | ${result.totals.types} types`;

    return {
        content: [{ type: 'text', text: message.trimEnd() }],
    };
}

/**
 * Format a timestamp as relative time (e.g., "2 hours ago")
 */
function formatRelativeTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return `${Math.floor(days / 7)}w ago`;
}

// ============================================================
// Log Hub Handler
// ============================================================

async function handleLog(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
    const action = args.action as LogAction;

    if (!action) {
        return {
            content: [{ type: 'text', text: 'Error: action parameter is required' }],
        };
    }

    const result = await log({
        action,
        port: args.port as number | undefined,
        buffer_size: args.buffer_size as number | undefined,
        persist: args.persist as boolean | undefined,
        path: args.path as string | undefined,
        since: args.since as string | undefined,
        level: args.level as LogLevel | undefined,
        source: args.source as string | undefined,
        contains: args.contains as string | undefined,
        limit: args.limit as number | undefined,
        consume: args.consume as boolean | undefined,
        message: args.message as string | undefined,
        data: args.data as string | undefined,
        id: args.id as string | undefined,
        value: args.value as number | string | undefined,
    });

    if (!result.success && result.error) {
        return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
        };
    }

    const levelIcon: Record<string, string> = { debug: '⚪', info: '🔵', warn: '🟡', error: '🔴' };

    switch (action) {
        case 'init': {
            let msg = '✓ Log Hub initialized\n\n';
            if (result.stats) {
                msg += `Port: ${result.stats.port}\n`;
                msg += `Buffer: ${result.stats.bufferSize} entries\n`;
                msg += `Persistence: ${result.stats.persist ? 'enabled' : 'disabled'}\n`;
                msg += `\nHTTP endpoints:\n`;
                msg += `- POST http://localhost:${result.stats.port}/log — single entry\n`;
                msg += `- POST http://localhost:${result.stats.port}/logs — batch\n`;
                msg += `- GET  http://localhost:${result.stats.port}/health — status\n`;
            }
            return { content: [{ type: 'text', text: msg.trimEnd() }] };
        }

        case 'free':
            return { content: [{ type: 'text', text: '✓ Log Hub stopped, resources freed' }] };

        case 'status': {
            if (result.error) {
                return { content: [{ type: 'text', text: `ℹ️ ${result.error}` }] };
            }
            const s = result.stats!;
            let msg = `# Log Hub Status\n\n`;
            msg += `Port: ${s.port}\n`;
            msg += `Entries: ${s.entries} / ${s.bufferSize} (${s.bufferUsage})\n`;
            msg += `Persistence: ${s.persist ? 'enabled' : 'disabled'}\n`;
            if (s.entries > 0) {
                msg += `ID range: ${s.oldestId} — ${s.newestId}\n`;
                msg += `Sources: ${s.sources.join(', ')}\n`;
                msg += `Levels: ${Object.entries(s.levelCounts).map(([l, c]) => `${levelIcon[l] || ''} ${l}: ${c}`).join(' | ')}\n`;
            }
            return { content: [{ type: 'text', text: msg.trimEnd() }] };
        }

        case 'query': {
            const entries = result.entries ?? [];
            if (entries.length === 0) {
                return { content: [{ type: 'text', text: 'No log entries found matching the filters.' }] };
            }

            let msg = `# Log Entries (${entries.length})\n\n`;
            for (const e of entries) {
                const time = new Date(e.timestamp).toISOString().slice(11, 23);
                const icon = levelIcon[e.level] || '';
                msg += `${icon} \`${time}\` **[${e.source}]** ${e.message}`;
                if (e.data && e.data !== 'null') msg += ` \`${e.data}\``;
                msg += '\n';
            }
            return { content: [{ type: 'text', text: msg.trimEnd() }] };
        }

        case 'clear':
            return { content: [{ type: 'text', text: '✓ Log buffer cleared' }] };

        case 'write': {
            const e = result.entries?.[0];
            if (e) {
                return { content: [{ type: 'text', text: `✓ Log entry #${e.id} written (${e.level}: ${e.message})` }] };
            }
            return { content: [{ type: 'text', text: '✓ Entry written' }] };
        }

        case 'control_get':
        case 'control_set': {
            const controls = result.controls ?? {};
            const keys = Object.keys(controls);
            const setPrefix = action === 'control_set'
                ? `✓ Set ${args.id} = ${String(args.value)}\n\n`
                : '';
            if (keys.length === 0) {
                return { content: [{ type: 'text', text: setPrefix + 'No controls defined yet (the source defines them).' }] };
            }
            let msg = setPrefix + `# Controls (${keys.length})\n\n`;
            for (const k of keys.sort()) msg += `- \`${k}\` = ${String(controls[k])}\n`;
            return { content: [{ type: 'text', text: msg.trimEnd() }] };
        }

        default:
            return { content: [{ type: 'text', text: `Unknown action: ${action}` }] };
    }
}

/**
 * Handle aidex_settings — open Settings tab in viewer or report current config.
 */
async function handleSettings(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
    const path = args.path as string;
    if (!path) {
        return { content: [{ type: 'text', text: 'Error: path parameter is required' }] };
    }
    const open = args.open === true;

    try {
        const { getSettings, markVersionSeen } = await import('../llm/settings.js');
        const s = await getSettings(path);

        if (open) {
            // Start viewer if not running, with the Settings tab pre-selected via URL hash.
            await startViewer(path, 'settings');
            // Mark the current version as seen so the update banner stops showing.
            markVersionSeen();

            // Always queue a focus-tab message — works for fresh start, replay
            // on first WS connect, or live broadcast if the browser is already there.
            const { broadcastFocusTab } = await import('../viewer/server.js');
            broadcastFocusTab('settings');

            const lines: string[] = [];
            lines.push('✓ Opening AiDex Settings in the viewer (http://localhost:3333).');
            lines.push('');
            lines.push('Current configuration:');
            lines.push(`  Embeddings: ${s.embeddings.enabled ? 'enabled' : 'disabled'}` +
                (s.embeddings.totalEmbeddings ? ` (${s.embeddings.totalEmbeddings} vectors)` : ''));
            lines.push(`  LLM: ${s.llm.active
                ? `${s.llm.active.backend} / ${s.llm.active.model} (${s.llm.active.source})`
                : 'no backend configured'}`);
            lines.push(`  Privacy (llm_send_code): ${s.llm.sendCode ? 'on (snippets sent)' : 'off (metadata only)'}`);
            lines.push('');
            lines.push('Use the Settings tab to change provider, key, model, and privacy.');
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        // Read-only mode: return JSON-ish summary.
        const lines: string[] = [];
        lines.push(`# Settings — ${path}`);
        lines.push('');
        lines.push(`**Embeddings:** ${s.embeddings.enabled ? `enabled (${s.embeddings.totalEmbeddings} vectors, model: ${s.embeddings.modelId})` : 'disabled'}`);
        lines.push(`**Model cached on disk:** ${s.embeddings.modelCached ? 'yes' : 'no'}`);
        lines.push('');
        lines.push(`**LLM active:** ${s.llm.active ? `${s.llm.active.backend} / ${s.llm.active.model} (source: ${s.llm.active.source})` : '(none)'}`);
        lines.push(`**LLM file (~/.aidex/llm.json):** ${s.llm.file.hasKey ? 'has key' : 'no key'}` +
            (s.llm.file.endpoint ? `, endpoint: ${s.llm.file.endpoint}` : '') +
            (s.llm.file.model ? `, model: ${s.llm.file.model}` : ''));
        lines.push(`**Privacy switch (llm_send_code):** ${s.llm.sendCode ? '🔓 ON (code snippets are sent to LLM)' : '🔒 OFF (only metadata sent)'}`);
        lines.push('');
        lines.push(`**AiDex version:** ${s.currentVersion}` + (s.lastSeenVersion ? ` (last seen: ${s.lastSeenVersion})` : ' (first session)'));
        lines.push('');
        lines.push('To open the Settings UI: `aidex_settings({ path: "...", open: true })`');
        return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
}

/**
 * Handle aidex_search — semantic / exact / hybrid search across embeddings.
 */
async function handleSearch(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
    const query = args.query as string;
    if (!query) {
        return { content: [{ type: 'text', text: 'Error: query parameter is required' }] };
    }

    try {
        const { getEmbeddings } = await import('../embeddings/index.js');
        const e = getEmbeddings();

        const { hits, telemetry } = await e.searchWithTelemetry({
            query,
            scope: args.scope as 'current' | 'all' | 'linked' | undefined,
            path: args.path as string | undefined,
            projectFilter: args.project_filter as string[] | undefined,
            sourceKinds: args.source_kinds as Array<'code' | 'docs' | 'workspace'> | undefined,
            sourceTypes: args.source_types as Array<'method' | 'type' | 'doc-section' | 'task' | 'note' | 'note-history' | 'task-log'> | undefined,
            mode: args.mode as 'semantic' | 'hybrid' | 'exact' | undefined,
            k: typeof args.k === 'number' ? args.k : undefined,
            llm: args.llm as 'auto' | 'off' | 'translate' | 'rerank' | 'expand+rerank' | undefined,
        });

        const llmTags: string[] = [];
        if (telemetry.translateRan) llmTags.push(telemetry.translateFailed ? 'translate ✗' : 'translate ✓');
        if (telemetry.expandRan) llmTags.push(telemetry.expandFailed ? 'expand ✗' : 'expand ✓');
        if (telemetry.rerankRan) llmTags.push(telemetry.rerankFailed ? 'rerank ✗' : 'rerank ✓');
        const llmLine = llmTags.length > 0 ? `LLM: ${llmTags.join(', ')}` : null;
        const errLine = telemetry.lastError ? `LLM error: ${telemetry.lastError}` : null;
        const showRewrites = telemetry.queriesUsed.length > 1
            ? `Rewrites: ${telemetry.queriesUsed.map(q => `"${q}"`).join(', ')}`
            : null;

        if (hits.length === 0) {
            const parts = ['No matches.'];
            if (llmLine) parts.push(llmLine);
            if (errLine) parts.push(errLine);
            return { content: [{ type: 'text', text: parts.join('\n') }] };
        }

        const lines: string[] = [];
        const showProject = (args.scope === 'all' || args.scope === 'linked');
        lines.push(`# Search results (${hits.length})`);
        lines.push(`Query: "${query}"  ·  Mode: ${args.mode ?? 'hybrid'}`);
        if (llmLine) lines.push(llmLine);
        if (showRewrites) lines.push(showRewrites);
        if (errLine) lines.push(errLine);
        lines.push('');
        for (const h of hits) {
            const loc = h.sourcePath ? `${h.sourcePath}:${h.sourceLine ?? ''}` : '(workspace)';
            const head = `${h.rank}. [${h.sourceKind}/${h.sourceType}] ${h.sourceName ?? h.sourceAnchor ?? '(unnamed)'}`;
            const proj = showProject ? `  ·  ${h.projectName}` : '';
            const dist = h.distance > 0 ? `  ·  d=${h.distance.toFixed(3)}` : '';
            lines.push(`${head}${proj}${dist}`);
            lines.push(`   ${loc}`);
            if (h.sourceText) {
                const snippet = h.sourceText.replace(/\n/g, ' ').slice(0, 180);
                lines.push(`   ${snippet}${h.sourceText.length > 180 ? '…' : ''}`);
            }
            lines.push('');
        }

        return { content: [{ type: 'text', text: lines.join('\n').trimEnd() }] };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${msg}` }] };
    }
}
