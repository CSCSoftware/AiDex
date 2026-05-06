/**
 * AiDex Viewer - Local HTTP Server with WebSocket
 * Opens an interactive project tree in the browser
 *
 * Features:
 * - Tab-based navigation (Code/All files, Overview/Code view)
 * - Session change indicators (modified/new files)
 * - Syntax highlighting with highlight.js
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { exec } from 'child_process';
import path from 'path';
import { existsSync, readFileSync, statSync } from 'fs';
import chokidar, { FSWatcher } from 'chokidar';
import { openDatabase, createQueries } from '../db/index.js';
import { update as updateIndex } from '../commands/update.js';
import { getGitStatus, GitStatusInfo, GitFileStatus } from './git-status.js';
import { isSupported as isSupportedByParser } from '../parser/index.js';
import { PRODUCT_NAME, INDEX_DIR } from '../constants.js';
import Database from 'better-sqlite3';

const PORT = 3333;

let server: ReturnType<typeof createServer> | null = null;
let wss: WebSocketServer | null = null;
let fileWatcher: FSWatcher | null = null;
let viewerDbPath: string | null = null;
let viewerDb: ReturnType<typeof openDatabase> | null = null;

interface ViewerMessage {
    type:
        | 'getTree'
        | 'getSignature'
        | 'getFileContent'
        | 'getTasks'
        | 'updateTaskStatus'
        | 'searchEmbeddings'
        | 'getSettings'
        | 'setSettings'
        | 'testLlmConnection'
        | 'pollPendingFocus';
    mode?: 'code' | 'all' | 'semantic' | 'hybrid' | 'exact';
    path?: string;
    file?: string;
    taskId?: number;
    status?: string;
    // searchEmbeddings fields
    query?: string;
    requestId?: number;
    scope?: 'current' | 'all' | 'linked';
    sourceKinds?: Array<'code' | 'docs' | 'workspace'>;
    k?: number;
    projectFilter?: string[];
    // getFileContent: optional cross-project read (must be a path of an
    // embeddings-enabled project registered in ~/.aidex/global.db).
    projectPath?: string;
    // setSettings payload
    payload?: {
        enableEmbeddings?: boolean;
        embeddingModel?: string;
        llmEndpoint?: string | null;
        llmModel?: string | null;
        llmApiKey?: string | null;
        llmSendCode?: boolean;
    };
}

interface TreeNode {
    name: string;
    path: string;
    type: 'dir' | 'file';
    fileType?: string;  // code, config, doc, asset, test, other
    children?: TreeNode[];
    stats?: {
        items: number;
        methods: number;
        types: number;
    };
    status?: 'modified' | 'new' | 'unchanged';  // Session change status
    gitStatus?: GitFileStatus;  // Git status for cat icon coloring
}

interface SessionChangeInfo {
    modified: Set<string>;
    new: Set<string>;
}

export async function startViewer(projectPath: string, initialTab?: string): Promise<string> {
    const hash = initialTab ? `#tab=${encodeURIComponent(initialTab)}` : '';

    // Check if already running — broadcast a focus message + reopen browser at the hash URL.
    if (server) {
        if (initialTab) {
            broadcastFocusTab(initialTab);
            try { openBrowser(`http://localhost:${PORT}${hash}`); } catch { /* ignore */ }
        }
        return `Viewer already running at http://localhost:${PORT}${hash}`;
    }

    const dbPath = path.join(projectPath, INDEX_DIR, 'index.db');
    viewerDbPath = dbPath;
    viewerDb = openDatabase(dbPath, true); // readonly for queries
    const sqlite = viewerDb.getDb();
    const queries = createQueries(viewerDb);
    const projectRoot = path.resolve(projectPath);
    const absoluteProjectPath = path.resolve(projectPath); // For updateIndex

    // Track files changed - initialize with DB session changes, then add live changes
    const dbSessionChanges = detectSessionChanges(sqlite);
    const viewerSessionChanges: SessionChangeInfo = {
        modified: new Set(dbSessionChanges.modified),
        new: new Set(dbSessionChanges.new)
    };

    console.error('[Viewer] Session changes from DB:', viewerSessionChanges.modified.size, 'modified,', viewerSessionChanges.new.size, 'new');

    // Git status - fetch once at startup, refresh on file changes
    let cachedGitInfo: GitStatusInfo | undefined;
    let lastGitRefresh = 0;
    const GIT_REFRESH_INTERVAL = 5000; // ms — avoid hammering git on rapid file changes
    const refreshGitStatus = async (force = false) => {
        const now = Date.now();
        if (!force && now - lastGitRefresh < GIT_REFRESH_INTERVAL) return;
        lastGitRefresh = now;
        cachedGitInfo = await getGitStatus(projectPath);
        console.error('[Viewer] Git status:', cachedGitInfo.isGitRepo ? 'repo' : 'no-repo',
            cachedGitInfo.hasRemote ? 'with-remote' : 'no-remote',
            cachedGitInfo.fileStatuses.size, 'files with status');
    };
    await refreshGitStatus(true); // force on startup

    const app = express();
    server = createServer(app);
    wss = new WebSocketServer({ server });

    // File watcher for live reload
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingChanges: Set<string> = new Set();  // Files changed since last broadcast

    const broadcastTreeUpdate = async () => {
        if (!wss) return;

        // Re-index changed files before refreshing the tree.
        // Snapshot + clear first so new events during async processing aren't lost.
        if (pendingChanges.size > 0) {
            const snapshot = new Set(pendingChanges);
            pendingChanges.clear();
            console.error('[Viewer] Re-indexing', snapshot.size, 'changed file(s)');
            for (const changedFile of snapshot) {
                // Convert absolute path to relative path
                const relativePath = path.relative(projectRoot, changedFile).replace(/\\/g, '/');
                try {
                    // updateIndex opens its own DB connection with write access
                    const result = updateIndex({ path: absoluteProjectPath, file: relativePath });
                    console.error('[Viewer] Re-indexed:', relativePath, result.success ? '✓' : '✗');
                    // Track as modified in viewer session
                    viewerSessionChanges.modified.add(relativePath);
                } catch (err) {
                    console.error('[Viewer] Failed to re-index:', relativePath, err);
                }
            }
        }

        // Refresh git status on file changes
        await refreshGitStatus();

        // Build fresh trees for both modes using viewer session tracking
        const freshDb = openDatabase(dbPath, true);
        const codeTree = await buildTree(freshDb.getDb(), projectPath, 'code', viewerSessionChanges, cachedGitInfo);
        const allTree = await buildTree(freshDb.getDb(), projectPath, 'all', viewerSessionChanges, cachedGitInfo);
        freshDb.close();

        // Broadcast to all connected clients
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'refresh', codeTree, allTree }));
            }
        });

        console.error('[Viewer] Broadcast tree update to', wss.clients.size, 'clients');
    };

    // Use chokidar for reliable cross-platform file watching
    fileWatcher = chokidar.watch(projectRoot, {
        ignored: [
            '**/node_modules/**',
            '**/.git/**',
            `**/${INDEX_DIR}/**`,
            '**/build/**',
            '**/dist/**',
            '**/.terraform/**',  // Terraform downloaded modules + state cache
        ],
        ignoreInitial: true,
        persistent: true
    });

    fileWatcher.on('ready', () => {
        console.error('[Viewer] Chokidar ready, watching for changes');
    });

    fileWatcher.on('error', (error: unknown) => {
        console.error('[Viewer] Chokidar error:', error);
    });

    fileWatcher.on('all', (event: string, filePath: string) => {
        console.error('[Viewer] Chokidar event:', event, filePath);

        // Track changed files for re-indexing (only for change/add events on code files)
        if ((event === 'change' || event === 'add') && isSupportedByParser(filePath)) {
            pendingChanges.add(filePath);
        }

        // Debounce: wait 500ms after last change before broadcasting
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            console.error('[Viewer] Broadcasting after debounce');
            broadcastTreeUpdate();
        }, 500);
    });

    console.error('[Viewer] Initializing chokidar for', projectRoot);

    // Serve static HTML (no-cache to always get fresh JS)
    app.get('/', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.send(getViewerHTML(projectPath));
    });

    // Debug endpoint to manually trigger refresh
    app.get('/refresh', async (req, res) => {
        await broadcastTreeUpdate();
        res.send('Refresh triggered');
    });

    // WebSocket handling
    wss.on('connection', (ws: WebSocket) => {
        console.error('[Viewer] Client connected');

        // If a focus-tab request is pending in global.db (e.g. user just ran
        // aidex_settings from a different MCP module instance), replay it now.
        const pending = readPendingFocusTab();
        if (pending) {
            writePendingFocusTab(null);
            setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'focusTab', tab: pending }));
                }
            }, 50);
        }

        ws.on('message', async (data: Buffer) => {
            try {
                const msg: ViewerMessage = JSON.parse(data.toString());

                if (msg.type === 'getTree') {
                    const mode: 'code' | 'all' = msg.mode === 'all' ? 'all' : 'code';
                    const freshDb = openDatabase(dbPath, true);
                    const tree = await buildTree(freshDb.getDb(), projectPath, mode, viewerSessionChanges, cachedGitInfo);
                    freshDb.close();
                    ws.send(JSON.stringify({ type: 'tree', mode, data: tree }));
                }
                else if (msg.type === 'getSignature' && msg.file) {
                    const freshDb = openDatabase(dbPath, true);
                    const signature = await getFileSignature(freshDb.getDb(), msg.file);
                    freshDb.close();
                    ws.send(JSON.stringify({ type: 'signature', file: msg.file, data: signature }));
                }
                else if (msg.type === 'getFileContent' && msg.file) {
                    // Cross-project read: when msg.projectPath is set and is a different
                    // project, validate it's an embeddings-enabled project registered in
                    // the global DB before reading. Default falls back to current project.
                    let readRoot = projectRoot;
                    let crossProjectName: string | undefined;
                    let crossProjectError: string | undefined;
                    const normRequested = typeof msg.projectPath === 'string'
                        ? path.resolve(msg.projectPath).replace(/\\/g, '/')
                        : '';
                    const normCurrent = path.resolve(projectRoot).replace(/\\/g, '/');
                    if (normRequested.length > 0 && normRequested !== normCurrent) {
                        const guard = await resolveCrossProjectRoot(normRequested);
                        if (guard.ok) {
                            readRoot = guard.root;
                            crossProjectName = guard.name;
                        } else {
                            crossProjectError = guard.error;
                        }
                    }
                    if (crossProjectError) {
                        ws.send(JSON.stringify({
                            type: 'fileContent',
                            file: msg.file,
                            data: { error: crossProjectError },
                        }));
                    } else {
                        const content = getFileContent(readRoot, msg.file);
                        ws.send(JSON.stringify({
                            type: 'fileContent',
                            file: msg.file,
                            data: content,
                            projectPath: crossProjectName ? path.resolve(readRoot) : undefined,
                            projectName: crossProjectName,
                        }));
                    }
                }
                else if (msg.type === 'getTasks') {
                    const freshDb = openDatabase(dbPath, true);
                    const taskData = getTasksFromDb(freshDb.getDb());
                    freshDb.close();
                    ws.send(JSON.stringify({ type: 'tasks', data: taskData }));
                }
                else if (msg.type === 'updateTaskStatus' && Number.isInteger(msg.taskId) && msg.status) {
                    const taskData = updateTaskStatus(msg.taskId as number, msg.status as string);
                    if (taskData) {
                        // Broadcast updated task list to all clients
                        wss!.clients.forEach((client) => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({ type: 'tasks', data: taskData }));
                            }
                        });
                    }
                }
                else if (msg.type === 'getSettings') {
                    try {
                        const { getSettings } = await import('../llm/settings.js');
                        const s = await getSettings(projectPath);
                        ws.send(JSON.stringify({ type: 'settings', requestId: msg.requestId, data: s }));
                    } catch (err) {
                        ws.send(JSON.stringify({
                            type: 'settings',
                            requestId: msg.requestId,
                            error: err instanceof Error ? err.message : String(err),
                        }));
                    }
                }
                else if (msg.type === 'pollPendingFocus') {
                    // Client polls this once after connecting / on visibilitychange.
                    // Returns and clears any pending focus-tab request stored in global.db.
                    const tab = readPendingFocusTab();
                    if (tab) {
                        writePendingFocusTab(null);
                        ws.send(JSON.stringify({ type: 'focusTab', tab }));
                    }
                }
                else if (msg.type === 'setSettings' && msg.payload) {
                    try {
                        const { setSettings, getSettings, validateSetSettingsPayload } = await import('../llm/settings.js');
                        const validated = validateSetSettingsPayload(msg.payload);
                        const result = await setSettings(projectPath, validated);
                        const updated = await getSettings(projectPath);
                        ws.send(JSON.stringify({
                            type: 'settingsSaved',
                            requestId: msg.requestId,
                            result,
                            data: updated,
                        }));
                    } catch (err) {
                        ws.send(JSON.stringify({
                            type: 'settingsSaved',
                            requestId: msg.requestId,
                            result: { success: false, error: err instanceof Error ? err.message : String(err) },
                        }));
                    }
                }
                else if (msg.type === 'testLlmConnection') {
                    try {
                        const { testLlmConnection } = await import('../llm/settings.js');
                        const r = await testLlmConnection(projectPath);
                        ws.send(JSON.stringify({ type: 'llmTestResult', requestId: msg.requestId, data: r }));
                    } catch (err) {
                        ws.send(JSON.stringify({
                            type: 'llmTestResult',
                            requestId: msg.requestId,
                            data: { ok: false, error: err instanceof Error ? err.message : String(err) },
                        }));
                    }
                }
                else if (msg.type === 'searchEmbeddings' && typeof msg.query === 'string') {
                    const requestId = msg.requestId;
                    try {
                        const { getEmbeddings } = await import('../embeddings/index.js');
                        const filter = Array.isArray(msg.projectFilter)
                            ? msg.projectFilter.filter(s => typeof s === 'string' && s.trim().length > 0)
                            : undefined;
                        const r = await getEmbeddings().searchWithTelemetry({
                            query: msg.query,
                            path: projectPath,
                            scope: (msg.scope as 'current' | 'all' | 'linked' | undefined) ?? 'current',
                            projectFilter: filter && filter.length > 0 ? filter : undefined,
                            sourceKinds: msg.sourceKinds as Array<'code' | 'docs' | 'workspace'> | undefined,
                            mode: (msg.mode as 'semantic' | 'hybrid' | 'exact' | undefined) ?? 'hybrid',
                            k: typeof msg.k === 'number' ? msg.k : 20,
                        });
                        ws.send(JSON.stringify({ type: 'searchResults', requestId, hits: r.hits, telemetry: r.telemetry }));
                    } catch (err) {
                        ws.send(JSON.stringify({
                            type: 'searchResults',
                            requestId,
                            hits: [],
                            error: err instanceof Error ? err.message : String(err),
                        }));
                    }
                }
                else {
                    ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
                }
            } catch (err) {
                console.error('[Viewer] Error:', err);
                ws.send(JSON.stringify({ type: 'error', message: String(err) }));
            }
        });

        ws.on('close', () => {
            console.error('[Viewer] Client disconnected');
        });

        // Send initial tree (code files only)
        const initDb = openDatabase(dbPath, true);
        buildTree(initDb.getDb(), projectPath, 'code', viewerSessionChanges, cachedGitInfo).then(tree => {
            initDb.close();
            ws.send(JSON.stringify({ type: 'tree', mode: 'code', data: tree }));
        });
    });

    return new Promise((resolve, reject) => {
        server!.listen(PORT, '127.0.0.1', () => {
            const url = `http://localhost:${PORT}${hash}`;
            console.error(`[Viewer] Server running at ${url}`);

            openBrowser(url);

            resolve(`Viewer opened at ${url}`);
        });

        server!.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                resolve(`Port ${PORT} already in use - viewer may already be running at http://localhost:${PORT}`);
            } else {
                reject(err);
            }
        });
    });
}

/**
 * Broadcast task updates to all connected viewer clients.
 * Called from task.ts after create/update/delete operations.
 */
/**
 * Persisted pending tab to focus. Stored in global.db so it survives across
 * MCP server module instances (the viewer module is sometimes loaded twice
 * via dynamic import, once for `startViewer` and once for `broadcastFocusTab`).
 *
 * The browser polls for it via the `pollPendingFocus` WebSocket message right
 * after connecting, and clears it server-side after delivery.
 */
const PENDING_FOCUS_KEY = 'pending_viewer_focus_tab';

function getGlobalDbPath(): string | null {
    const homedir = process.env.USERPROFILE ?? process.env.HOME;
    if (!homedir) return null;
    const dbPath = path.join(homedir, '.aidex', 'global.db');
    return existsSync(dbPath) ? dbPath : null;
}

function readPendingFocusTab(): string | null {
    try {
        const dbPath = getGlobalDbPath();
        if (!dbPath) return null;
        const db = new Database(dbPath, { readonly: true });
        try {
            const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(PENDING_FOCUS_KEY) as
                | { value: string }
                | undefined;
            return row?.value ?? null;
        } finally {
            db.close();
        }
    } catch (err) {
        console.error('[Viewer] readPendingFocusTab failed:', err);
        return null;
    }
}

function writePendingFocusTab(tab: string | null): void {
    try {
        const dbPath = getGlobalDbPath();
        if (!dbPath) return;
        const db = new Database(dbPath);
        try {
            if (tab) {
                db.prepare('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)').run(PENDING_FOCUS_KEY, tab);
            } else {
                db.prepare('DELETE FROM metadata WHERE key = ?').run(PENDING_FOCUS_KEY);
            }
        } finally {
            db.close();
        }
    } catch (err) {
        console.error('[Viewer] writePendingFocusTab failed:', err);
    }
}

/**
 * Request that the viewer focus a tab. Works whether the viewer is in the
 * same Node process or in a different one — state lives in global.db.
 * Browsers pick it up via the `pollPendingFocus` WS message on connect.
 */
export function broadcastFocusTab(tab: string): void {
    // Persist first so any module instance can serve it.
    writePendingFocusTab(tab);

    // Also try a live broadcast for the case where the browser is already
    // connected to *this* module instance.
    if (wss) {
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'focusTab', tab }));
            }
        });
    }
}

export function broadcastTaskUpdate(): void {
    if (!wss || !viewerDbPath) return;

    try {
        const freshDb = openDatabase(viewerDbPath, false);
        const taskData = getTasksFromDb(freshDb.getDb());
        freshDb.close();

        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'tasks', data: taskData }));
            }
        });
        console.error('[Viewer] Broadcast task update to', wss.clients.size, 'clients');
    } catch (err) {
        console.error('[Viewer] Failed to broadcast task update:', err);
    }
}

/**
 * Broadcast a log entry to all connected viewer clients.
 * Called from log-server.ts on each new entry.
 */
export function broadcastLogEntry(entry: import('../loghub/log-types.js').LogEntry): void {
    if (!wss) return;

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'log', entry }));
        }
    });
}

export function stopViewer(): string {
    if (server) {
        fileWatcher?.close();
        fileWatcher = null;
        wss?.close();
        viewerDb?.close();
        viewerDb = null;
        viewerDbPath = null;
        server.close();
        server = null;
        wss = null;
        return 'Viewer stopped';
    }
    return 'Viewer was not running';
}

function openBrowser(url: string) {
    const platform = process.platform;
    let cmd: string;

    if (platform === 'win32') {
        cmd = `start "" "${url}"`;
    } else if (platform === 'darwin') {
        cmd = `open "${url}"`;
    } else {
        cmd = `xdg-open "${url}"`;
    }

    exec(cmd, (err) => {
        if (err) console.error('[Viewer] Failed to open browser:', err);
    });
}

/**
 * Detect files changed in the current session
 * Uses last_indexed timestamps vs session start time
 */
function detectSessionChanges(db: Database.Database): SessionChangeInfo {
    const changes: SessionChangeInfo = {
        modified: new Set(),
        new: new Set()
    };

    try {
        // Get session start time from metadata
        const sessionStartRow = db.prepare(
            `SELECT value FROM metadata WHERE key = 'current_session_start'`
        ).get() as { value: string } | undefined;

        if (!sessionStartRow) {
            // No session tracking yet - all files are "unchanged"
            return changes;
        }

        const sessionStart = parseInt(sessionStartRow.value, 10);

        // Find files indexed AFTER session start (not AT session start)
        // This ensures a fresh re-index doesn't mark everything as modified
        const recentlyIndexed = db.prepare(`
            SELECT path, last_indexed,
                   (SELECT COUNT(*) FROM lines l WHERE l.file_id = f.id) as line_count
            FROM files f
            WHERE last_indexed > ?
        `).all(sessionStart) as Array<{ path: string; last_indexed: number; line_count: number }>;

        for (const file of recentlyIndexed) {
            // Heuristic: if file has very few lines, it might be new
            // But we can't really distinguish new vs modified without more metadata
            // For now, mark all recently indexed files as "modified"
            changes.modified.add(file.path);
        }
    } catch (err) {
        console.error('[Viewer] Failed to detect session changes:', err);
    }

    return changes;
}

async function buildTree(
    db: Database.Database,
    projectPath: string,
    mode: 'code' | 'all',
    sessionChanges: SessionChangeInfo,
    gitInfo?: GitStatusInfo
): Promise<TreeNode> {
    let files: Array<{ path: string; items: number; methods: number; types: number; fileType?: string }>;

    if (mode === 'code') {
        // Only indexed code files (original behavior)
        files = db.prepare(`
            SELECT f.path,
                   COUNT(DISTINCT o.item_id) as items,
                   COUNT(DISTINCT m.id) as methods,
                   COUNT(DISTINCT t.id) as types
            FROM files f
            LEFT JOIN occurrences o ON o.file_id = f.id
            LEFT JOIN methods m ON m.file_id = f.id
            LEFT JOIN types t ON t.file_id = f.id
            GROUP BY f.id
            ORDER BY f.path
        `).all() as Array<{ path: string; items: number; methods: number; types: number }>;
    } else {
        // All project files from project_files table
        const projectFiles = db.prepare(`
            SELECT path, type as fileType FROM project_files WHERE type != 'dir' ORDER BY path
        `).all() as Array<{ path: string; fileType: string }>;

        // Get stats for indexed files — single query with JOINs (no N+1)
        const statsMap = new Map<string, { items: number; methods: number; types: number }>();
        const indexedStats = db.prepare(`
            SELECT f.path,
                   COUNT(DISTINCT o.item_id) as items,
                   COUNT(DISTINCT m.id) as methods,
                   COUNT(DISTINCT t.id) as types
            FROM files f
            LEFT JOIN occurrences o ON o.file_id = f.id
            LEFT JOIN methods m ON m.file_id = f.id
            LEFT JOIN types t ON t.file_id = f.id
            GROUP BY f.id
        `).all() as Array<{ path: string; items: number; methods: number; types: number }>;

        for (const stat of indexedStats) {
            statsMap.set(stat.path, { items: stat.items, methods: stat.methods, types: stat.types });
        }

        files = projectFiles.map(f => ({
            path: f.path,
            fileType: f.fileType,
            items: statsMap.get(f.path)?.items || 0,
            methods: statsMap.get(f.path)?.methods || 0,
            types: statsMap.get(f.path)?.types || 0
        }));
    }

    const root: TreeNode = {
        name: path.basename(projectPath),
        path: '',
        type: 'dir',
        children: []
    };

    for (const file of files) {
        const parts = file.path.split('/');
        let current = root;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isFile = i === parts.length - 1;
            const currentPath = parts.slice(0, i + 1).join('/');

            let child = current.children?.find(c => c.name === part);

            if (!child) {
                child = {
                    name: part,
                    path: currentPath,
                    type: isFile ? 'file' : 'dir',
                    fileType: isFile ? file.fileType : undefined,
                    children: isFile ? undefined : [],
                    stats: isFile ? { items: file.items, methods: file.methods, types: file.types } : undefined,
                    status: isFile ? getFileStatus(file.path, sessionChanges) : undefined,
                    gitStatus: isFile && gitInfo?.isGitRepo ? getGitFileStatus(file.path, gitInfo) : undefined
                };
                current.children?.push(child);
            }

            current = child;
        }
    }

    // Sort: directories first, then alphabetically
    sortTree(root);
    return root;
}

function getFileStatus(filePath: string, changes: SessionChangeInfo): 'modified' | 'new' | 'unchanged' {
    if (changes.modified.has(filePath)) return 'modified';
    if (changes.new.has(filePath)) return 'new';
    return 'unchanged';
}

function getGitFileStatus(filePath: string, gitInfo: GitStatusInfo): GitFileStatus {
    const status = gitInfo.fileStatuses.get(filePath);
    if (status) return status;
    // File is tracked and clean - show as pushed (green) if remote exists, otherwise committed (blue)
    return gitInfo.hasRemote ? 'pushed' : 'committed';
}

function sortTree(node: TreeNode) {
    if (node.children) {
        node.children.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        node.children.forEach(sortTree);
    }
}

async function getFileSignature(db: Database.Database, filePath: string): Promise<object> {
    // Prevent path traversal in DB lookups
    if (filePath.includes('..')) {
        return { error: 'Access denied: invalid path' };
    }

    const file = db.prepare(`SELECT id FROM files WHERE path = ?`).get(filePath) as { id: number } | undefined;

    if (!file) {
        return { error: 'File not found in index' };
    }

    const signature = db.prepare(`SELECT header_comments FROM signatures WHERE file_id = ?`).get(file.id) as { header_comments: string } | undefined;
    const methods = db.prepare(`
        SELECT prototype, line_number, visibility, is_static, is_async
        FROM methods WHERE file_id = ? ORDER BY line_number
    `).all(file.id) as Array<{ prototype: string; line_number: number; visibility: string; is_static: number; is_async: number }>;
    const types = db.prepare(`
        SELECT name, kind, line_number
        FROM types WHERE file_id = ? ORDER BY line_number
    `).all(file.id) as Array<{ name: string; kind: string; line_number: number }>;

    return {
        header: signature?.header_comments || null,
        methods: methods.map(m => ({
            prototype: m.prototype,
            line: m.line_number,
            visibility: m.visibility,
            static: !!m.is_static,
            async: !!m.is_async
        })),
        types: types.map(t => ({
            name: t.name,
            kind: t.kind,
            line: t.line_number
        }))
    };
}

/**
 * Validate that a cross-project read request points at a project that's
 * registered in ~/.aidex/global.db. This is the whitelist gate for letting
 * the Source tab show files from a different project (e.g. after a global
 * search hit). Without this, msg.projectPath would let any caller read any
 * directory via the WebSocket.
 */
async function resolveCrossProjectRoot(
    requestedPath: string
): Promise<{ ok: true; root: string; name: string } | { ok: false; error: string }> {
    try {
        const mod = await import('../db/global-database.js');
        const { openGlobalDatabase, globalDbExists } = mod;
        if (!globalDbExists()) {
            return { ok: false, error: 'Cross-project read requires a global AiDex index' };
        }
        const gdb = openGlobalDatabase();
        try {
            // Global DB stores paths with forward slashes; normalise the request
            // to match (path.resolve on Windows would produce backslashes).
            const normalised = path.resolve(requestedPath).replace(/\\/g, '/');
            const project = gdb.getProjectByPath(normalised);
            if (!project) {
                return { ok: false, error: 'Project not registered in global AiDex index: ' + normalised };
            }
            return { ok: true, root: project.path, name: project.name };
        } finally {
            gdb.close();
        }
    } catch (err) {
        return {
            ok: false,
            error: 'Cross-project read failed: ' + (err instanceof Error ? err.message : String(err)),
        };
    }
}

const FILE_SIZE_LIMIT = 1 * 1024 * 1024; // 1 MB

/**
 * Get file content for the Code tab
 */
function getFileContent(projectRoot: string, filePath: string): { content: string; language: string } | { error: string } {
    const resolvedRoot = path.resolve(projectRoot);
    const fullPath = path.resolve(path.join(projectRoot, filePath));

    // Prevent path traversal
    if (!fullPath.startsWith(resolvedRoot + path.sep) && fullPath !== resolvedRoot) {
        return { error: 'Access denied: path outside project' };
    }

    if (!existsSync(fullPath)) {
        return { error: 'File not found' };
    }

    try {
        const { size } = statSync(fullPath);
        if (size > FILE_SIZE_LIMIT) {
            return { error: `File too large (${(size / 1024).toFixed(0)} KB). Limit is 1 MB.` };
        }
        const content = readFileSync(fullPath, 'utf-8');
        const language = getLanguageFromExtension(filePath);
        return { content, language };
    } catch (err) {
        return { error: `Failed to read file: ${err}` };
    }
}

/**
 * Map file extension to highlight.js language identifier
 */
function getLanguageFromExtension(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const langMap: Record<string, string> = {
        '.ts': 'typescript',
        '.tsx': 'typescript',
        '.js': 'javascript',
        '.jsx': 'javascript',
        '.mjs': 'javascript',
        '.cjs': 'javascript',
        '.cs': 'csharp',
        '.rs': 'rust',
        '.py': 'python',
        '.pyw': 'python',
        '.c': 'c',
        '.h': 'c',
        '.cpp': 'cpp',
        '.cc': 'cpp',
        '.cxx': 'cpp',
        '.hpp': 'cpp',
        '.hxx': 'cpp',
        '.java': 'java',
        '.go': 'go',
        '.php': 'php',
        '.rb': 'ruby',
        '.rake': 'ruby',
        // HCL/Terraform: highlight.js base bundle has no hcl language module,
        // fall back to plaintext to avoid "Unknown language" errors
        '.tf': 'plaintext',
        '.tfvars': 'plaintext',
        '.hcl': 'plaintext',
        '.json': 'json',
        '.xml': 'xml',
        '.html': 'html',
        '.htm': 'html',
        '.css': 'css',
        '.scss': 'scss',
        '.less': 'less',
        '.yaml': 'yaml',
        '.yml': 'yaml',
        '.md': 'markdown',
        '.sql': 'sql',
        '.sh': 'bash',
        '.bash': 'bash',
        '.bat': 'batch',
        '.ps1': 'powershell',
        '.toml': 'toml',
        '.ini': 'ini',
        '.cfg': 'ini'
    };
    return langMap[ext] || 'plaintext';
}

/**
 * Get tasks from the database for the viewer
 */
function getTasksFromDb(db: Database.Database): unknown[] {
    try {
        // Ensure tasks table exists (auto-migration)
        db.exec(`
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT,
                summary TEXT,
                priority INTEGER NOT NULL DEFAULT 2 CHECK(priority IN (1, 2, 3)),
                status TEXT NOT NULL DEFAULT 'backlog' CHECK(status IN ('backlog', 'active', 'done', 'cancelled')),
                tags TEXT,
                source TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                completed_at INTEGER
            );
        `);
        // Add missing columns for existing DBs (auto-migration)
        try {
            const migrations: Array<[string, string, string]> = [
                ['summary', 'TEXT', ''],
                ['due', 'INTEGER', ''],
                ['interval', 'TEXT', ''],
                ['action', 'TEXT', ''],
                ['auto_go', 'INTEGER', ' DEFAULT 0'],
            ];
            for (const [col, type, def] of migrations) {
                const has = db.prepare(
                    "SELECT COUNT(*) as cnt FROM pragma_table_info('tasks') WHERE name = ?"
                ).get(col) as { cnt: number };
                if (has.cnt === 0) {
                    db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${type}${def}`);
                }
            }
        } catch { /* ignore */ }
        return db.prepare(
            `SELECT * FROM tasks ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'backlog' THEN 1 WHEN 'done' THEN 2 WHEN 'cancelled' THEN 3 END, priority ASC, sort_order ASC, created_at DESC`
        ).all();
    } catch {
        return [];
    }
}

/**
 * Update a task's status from the viewer
 */
function updateTaskStatus(taskId: number, status: string): unknown[] | null {
    const validStatuses = ['backlog', 'active', 'done', 'cancelled'];
    if (!validStatuses.includes(status) || !viewerDbPath) return null;

    try {
        const writeDb = openDatabase(viewerDbPath, false); // writable connection
        const db = writeDb.getDb();
        const now = Date.now();
        const completedAt = (status === 'done' || status === 'cancelled') ? now : null;
        db.prepare(
            `UPDATE tasks SET status = ?, updated_at = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?`
        ).run(status, now, completedAt, taskId);

        // Auto-log status change
        db.prepare(
            `INSERT INTO task_log (task_id, note, created_at) VALUES (?, ?, ?)`
        ).run(taskId, `Status changed to: ${status} (via Viewer)`, now);

        // Read back tasks on same writable connection (guaranteed to see the write)
        const taskData = getTasksFromDb(db);
        writeDb.close();
        return taskData;
    } catch (err) {
        console.error('[Viewer] Failed to update task status:', err);
        return null;
    }
}

/**
 * Escape HTML special characters to prevent XSS
 */
function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getViewerHTML(projectPath: string): string {
    const projectName = escapeHtml(path.basename(projectPath));

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(PRODUCT_NAME)} Viewer - ${projectName}</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.0/styles/tokyo-night-dark.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.0/highlight.min.js"></script>
    <style>
        :root {
            --bg-primary: #1a1b26;
            --bg-secondary: #24283b;
            --bg-tertiary: #414868;
            --text-primary: #c0caf5;
            --text-secondary: #a9b1d6;
            --text-muted: #565f89;
            --accent: #7aa2f7;
            --accent-green: #9ece6a;
            --accent-orange: #ff9e64;
            --accent-purple: #bb9af7;
            --accent-cyan: #7dcfff;
            --accent-yellow: #e0af68;
            --accent-red: #f7768e;
            --border: #3b4261;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: 'Segoe UI', system-ui, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }

        header {
            background: var(--bg-secondary);
            padding: 12px 20px;
            border-bottom: 1px solid var(--border);
            display: flex;
            align-items: center;
            gap: 15px;
        }

        header h1 {
            font-size: 1.3em;
            color: var(--accent);
            font-weight: 500;
        }

        header .project-name {
            color: var(--accent-purple);
            font-weight: 600;
        }

        .container {
            display: flex;
            flex: 1;
            overflow: hidden;
        }

        /* Splitter */
        .splitter {
            width: 6px;
            background: var(--bg-tertiary);
            cursor: col-resize;
            transition: background 0.2s;
            flex-shrink: 0;
        }

        .splitter:hover, .splitter.dragging {
            background: var(--accent);
        }

        /* Panel styles */
        .panel {
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .tree-panel {
            width: 350px;
            background: var(--bg-secondary);
            border-right: 1px solid var(--border);
        }

        .detail-panel {
            flex: 1;
        }

        /* Tab bar styles */
        .tab-bar {
            display: flex;
            background: var(--bg-tertiary);
            border-bottom: 1px solid var(--border);
        }

        .tab {
            padding: 10px 20px;
            cursor: pointer;
            user-select: none;
            color: var(--text-primary);
            border-bottom: 2px solid transparent;
            transition: all 0.2s;
        }

        .tab:hover {
            color: var(--accent);
            background: rgba(122, 162, 247, 0.1);
        }

        .tab.active {
            color: var(--accent);
            border-bottom-color: var(--accent);
        }

        .panel-content {
            flex: 1;
            overflow-y: auto;
            padding: 10px 0;
        }

        .detail-panel .panel-content {
            padding: 20px;
        }

        /* Tree styles */
        .tree-node {
            padding: 6px 10px 6px 0;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            white-space: nowrap;
        }

        .tree-node:hover {
            background: rgba(122, 162, 247, 0.1);
        }

        .tree-node.selected {
            background: rgba(122, 162, 247, 0.2);
        }

        .tree-node .status-icon {
            width: 16px;
            font-size: 11px;
            text-align: center;
            flex-shrink: 0;
        }

        .tree-node .status-icon.modified {
            color: var(--accent-orange);
        }

        .tree-node .status-icon.new {
            color: var(--accent-green);
        }

        .tree-node .status-icon.unchanged {
            color: var(--accent-green);
            opacity: 0.7;
        }

        /* Git status cat icon */
        .tree-node .git-cat {
            width: 16px;
            height: 16px;
            flex-shrink: 0;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .tree-node .git-cat svg {
            width: 14px;
            height: 14px;
        }

        .tree-node .git-cat.untracked svg { fill: #6b7280; }
        .tree-node .git-cat.modified svg { fill: #f59e0b; }
        .tree-node .git-cat.committed svg { fill: #3b82f6; }
        .tree-node .git-cat.pushed svg { fill: #22c55e; }

        .tree-node .icon {
            width: 18px;
            text-align: center;
            flex-shrink: 0;
        }

        .tree-node .name {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .tree-node .stats {
            font-size: 0.75em;
            color: var(--text-muted);
            margin-left: auto;
            padding-right: 10px;
        }

        .tree-node.dir .icon { color: var(--accent-yellow); }
        .tree-node.file .icon { color: var(--accent-cyan); }
        .tree-node.file.config .icon { color: var(--accent-purple); }
        .tree-node.file.doc .icon { color: var(--accent-green); }
        .tree-node.file.test .icon { color: var(--accent-orange); }

        .tree-children {
            margin-left: 20px;
        }

        .tree-children.collapsed {
            display: none;
        }

        /* Detail panel styles */
        .detail-panel h2 {
            color: var(--accent-purple);
            font-size: 1.2em;
            margin-bottom: 15px;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--border);
        }

        .detail-panel .file-path {
            color: var(--text-muted);
            font-size: 0.9em;
            margin-bottom: 20px;
        }

        .section {
            margin-bottom: 25px;
        }

        .section h3 {
            color: var(--accent-cyan);
            font-size: 1em;
            margin-bottom: 10px;
        }

        .header-comment {
            background: var(--bg-secondary);
            padding: 15px;
            border-radius: 6px;
            font-family: 'Consolas', 'Fira Code', monospace;
            font-size: 0.9em;
            white-space: pre-wrap;
            color: var(--accent-green);
            border-left: 3px solid var(--accent-green);
        }

        .method-list, .type-list {
            list-style: none;
        }

        .method-list li, .type-list li {
            padding: 8px 12px;
            background: var(--bg-secondary);
            margin-bottom: 6px;
            border-radius: 4px;
            font-family: 'Consolas', monospace;
            font-size: 0.85em;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .method-list .line-num, .type-list .line-num {
            color: var(--text-muted);
            font-size: 0.8em;
            min-width: 40px;
        }

        .method-list .visibility {
            color: var(--accent-purple);
            font-size: 0.75em;
            padding: 2px 6px;
            background: rgba(187, 154, 247, 0.15);
            border-radius: 3px;
        }

        .method-list .modifier {
            color: var(--accent-orange);
            font-size: 0.75em;
        }

        .type-list .kind {
            color: var(--accent-yellow);
            font-size: 0.75em;
            padding: 2px 6px;
            background: rgba(224, 175, 104, 0.15);
            border-radius: 3px;
        }

        .empty-state {
            color: var(--text-muted);
            text-align: center;
            padding: 40px;
        }

        .loading {
            color: var(--text-muted);
            padding: 20px;
            text-align: center;
        }

        /* Code view styles */
        .code-view {
            background: var(--bg-secondary);
            border-radius: 6px;
            overflow: hidden;
        }

        .code-view pre {
            margin: 0;
            padding: 15px;
            overflow-x: auto;
            font-size: 0.85em;
            line-height: 1.5;
        }

        .code-view code {
            font-family: 'Consolas', 'Fira Code', monospace;
        }

        /* Override highlight.js background to match our theme */
        .hljs {
            background: var(--bg-secondary) !important;
        }

        /* Task backlog styles */
        .task-list { list-style: none; }
        .task-item {
            padding: 12px 14px;
            background: var(--bg-secondary);
            margin-bottom: 6px;
            border-radius: 6px;
            border-left: 3px solid var(--text-muted);
        }
        .task-item.priority-1 { border-left-color: var(--accent-red); }
        .task-item.priority-2 { border-left-color: var(--accent-yellow); }
        .task-item.priority-3 { border-left-color: var(--text-muted); }
        .task-item.status-done { opacity: 0.6; }
        .task-item.status-cancelled { opacity: 0.5; text-decoration: line-through; }
        .task-title { font-weight: 600; font-size: 0.95em; }
        .task-description { font-size: 0.85em; color: var(--text-secondary); margin-top: 4px; }
        .task-meta { font-size: 0.8em; color: var(--text-muted); margin-top: 6px; display: flex; gap: 12px; }
        .task-tags { color: var(--accent-cyan); font-size: 0.8em; margin-top: 4px; }
        .task-schedule { font-size: 0.8em; margin-top: 4px; color: var(--accent-yellow); }
        .task-schedule.overdue { color: var(--accent-red); font-weight: 600; }
        .task-schedule .schedule-icon { margin-right: 4px; }
        .task-section-header {
            color: var(--accent-purple);
            font-size: 1em;
            font-weight: 600;
            margin: 20px 0 10px 0;
            padding-bottom: 6px;
            border-bottom: 1px solid var(--border);
        }
        .task-section-header:first-child { margin-top: 0; }
        .task-done-toggle {
            cursor: pointer;
            color: var(--text-muted);
            font-size: 0.9em;
            margin-top: 20px;
            padding: 8px 0;
            user-select: none;
        }
        .task-done-toggle:hover { color: var(--text-secondary); }
        .task-done-list.collapsed { display: none; }
        .task-actions { margin-top: 8px; display: flex; gap: 6px; }
        .task-btn {
            padding: 3px 10px;
            border: 1px solid var(--border);
            border-radius: 4px;
            background: var(--bg-primary);
            color: var(--text-secondary);
            cursor: pointer;
            font-size: 0.8em;
        }
        .task-btn:hover { background: var(--border); color: var(--text-primary); }
        .task-btn-done { border-color: var(--accent-green, #4caf50); }
        .task-btn-done:hover { background: var(--accent-green, #4caf50); color: #fff; }
        .task-btn-cancel { border-color: var(--accent-red); }
        .task-btn-cancel:hover { background: var(--accent-red); color: #fff; }
        .task-group-toggle {
            display: inline-flex; gap: 0; margin-left: 12px; font-size: 0.8em;
            border: 1px solid var(--border); border-radius: 4px; overflow: hidden;
        }
        .task-group-toggle button {
            padding: 3px 10px; border: none; background: var(--bg-secondary);
            color: var(--text-muted); cursor: pointer; font-size: 1em;
        }
        .task-group-toggle button.active {
            background: var(--accent-purple); color: #fff;
        }
        .task-group-toggle button:hover:not(.active) {
            background: var(--border); color: var(--text-primary);
        }
        .task-tag-group-header {
            color: var(--accent-cyan); font-size: 1em; font-weight: 600;
            margin: 20px 0 8px 0; padding: 6px 0; border-bottom: 1px solid var(--border);
            cursor: pointer; user-select: none;
        }
        .task-tag-group-header:first-of-type { margin-top: 0; }
        .task-tag-group-header:hover { color: var(--text-primary); }
        .task-tag-group.collapsed .task-list { display: none; }
        .task-status-badge {
            font-size: 0.75em; padding: 1px 6px; border-radius: 3px;
            margin-left: 8px; font-weight: 400;
        }
        .task-status-badge.status-active { color: var(--accent-green, #4caf50); border: 1px solid var(--accent-green, #4caf50); }
        .task-status-badge.status-backlog { color: var(--text-muted); border: 1px solid var(--border); }
        .task-status-badge.status-done { color: var(--text-muted); border: 1px solid var(--border); }
        .task-status-badge.status-cancelled { color: var(--accent-red); border: 1px solid var(--accent-red); }

        /* Log Hub styles */
        .log-container {
            display: flex;
            flex-direction: column;
            height: calc(100vh - 120px);
        }
        .log-toolbar {
            display: flex;
            gap: 8px;
            align-items: center;
            margin-bottom: 10px;
            flex-wrap: wrap;
        }
        .log-toolbar select, .log-toolbar input {
            background: var(--bg-secondary);
            color: var(--text-primary);
            border: 1px solid var(--border);
            border-radius: 4px;
            padding: 4px 8px;
            font-size: 0.85em;
        }
        .log-toolbar input { flex: 1; min-width: 120px; }
        .log-level-btn {
            padding: 3px 10px;
            border: 1px solid var(--border);
            border-radius: 4px;
            background: var(--bg-secondary);
            color: var(--text-muted);
            cursor: pointer;
            font-size: 0.8em;
        }
        .log-level-btn.active { color: var(--text-primary); background: var(--bg-tertiary); }
        .log-level-btn.level-error.active { border-color: var(--accent-red); color: var(--accent-red); }
        .log-level-btn.level-warn.active { border-color: var(--accent-orange); color: var(--accent-orange); }
        .log-level-btn.level-info.active { border-color: var(--accent-cyan); color: var(--accent-cyan); }
        .log-level-btn.level-success.active { border-color: var(--accent-green); color: var(--accent-green); }
        .log-level-btn.level-debug.active { border-color: var(--text-muted); }
        .log-entries {
            flex: 1;
            overflow: auto;
            background: var(--bg-secondary);
            border-radius: 6px;
            padding: 8px;
            font-family: 'Consolas', 'Fira Code', monospace;
            font-size: 0.82em;
            line-height: 1.6;
        }
        .log-entry-line {
            display: flex;
            gap: 8px;
            padding: 1px 4px;
            border-radius: 2px;
            white-space: nowrap;
        }
        .log-entry-line:hover { background: rgba(122, 162, 247, 0.08); }
        .log-entry-line .log-time { color: var(--text-muted); white-space: nowrap; min-width: 85px; }
        .log-entry-line .log-level { min-width: 16px; text-align: center; }
        .log-entry-line .log-src { color: var(--accent-purple); min-width: 60px; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .log-entry-line .log-msg { color: var(--text-primary); white-space: nowrap; }
        .log-entry-line .log-data { color: var(--text-muted); font-size: 0.9em; white-space: nowrap; }
        .log-entry-line.level-error .log-msg { color: var(--accent-red); }
        .log-entry-line.level-warn .log-msg { color: var(--accent-orange); }
        .log-entry-line.level-success .log-msg { color: var(--accent-green); }
        .log-entry-line.level-debug .log-msg { color: var(--text-muted); }
        .log-auto-scroll {
            display: flex; align-items: center; gap: 4px;
            font-size: 0.85em; color: var(--text-muted);
            cursor: pointer; user-select: none;
        }
        .log-auto-scroll input { cursor: pointer; }
        .log-clear-btn {
            padding: 2px 10px; border: 1px solid var(--border); border-radius: 4px;
            background: var(--bg-secondary); color: var(--text-muted); cursor: pointer;
            font-size: 0.85em; margin-left: auto;
        }
        .log-clear-btn:hover { background: var(--accent-red); color: white; border-color: var(--accent-red); }
        .log-not-init {
            color: var(--text-muted);
            text-align: center;
            padding: 40px;
        }
        .log-not-init code { color: var(--accent-cyan); }

        /* Search tab */
        .search-controls {
            padding: 12px 16px;
            border-bottom: 1px solid var(--border);
            display: flex;
            flex-direction: column;
            gap: 10px;
            background: var(--bg-secondary);
        }
        .search-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
        .search-input {
            flex: 1;
            min-width: 200px;
            padding: 8px 12px;
            background: var(--bg-primary);
            color: var(--text-primary);
            border: 1px solid var(--border);
            border-radius: 4px;
            font: inherit;
            font-size: 14px;
        }
        .search-input:focus { outline: none; border-color: var(--accent-cyan); }
        .search-segment {
            display: inline-flex;
            border: 1px solid var(--border);
            border-radius: 4px;
            overflow: hidden;
            font-size: 0.85em;
        }
        .search-segment label {
            padding: 6px 10px;
            cursor: pointer;
            background: var(--bg-primary);
            color: var(--text-muted);
            border-right: 1px solid var(--border);
            user-select: none;
        }
        .search-segment label:last-child { border-right: none; }
        .search-segment input { display: none; }
        .search-segment input:checked + label {
            background: var(--accent-cyan);
            color: var(--bg-primary);
        }
        .search-kinds { display: flex; gap: 12px; font-size: 0.85em; color: var(--text-secondary); }
        .search-kinds label { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
        .search-kinds input[type="checkbox"] { accent-color: var(--accent-cyan); }
        .search-k-row { display: flex; align-items: center; gap: 8px; font-size: 0.85em; color: var(--text-muted); }
        .search-k-row input[type="range"] { flex: 1; accent-color: var(--accent-cyan); }
        .search-results { padding: 0; }
        .search-telemetry {
            margin: 0 0 10px 0;
            padding: 6px 10px;
            border-radius: 4px;
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            color: var(--text-secondary);
            font-size: 0.85em;
        }
        .search-telemetry.off { color: var(--text-muted); }
        .search-telemetry.rewrites { background: transparent; border: none; color: var(--text-muted); padding: 2px 10px; }
        .search-telemetry.err { background: rgba(247, 118, 142, 0.1); border-color: var(--accent-red); color: var(--accent-red); }
        .llm-tag {
            display: inline-block;
            padding: 1px 6px;
            margin: 0 3px 0 0;
            border-radius: 3px;
            font-weight: 600;
            font-size: 0.9em;
        }
        .llm-tag.ok { background: rgba(158, 206, 106, 0.15); color: var(--accent-green); }
        .llm-tag.fail { background: rgba(247, 118, 142, 0.15); color: var(--accent-red); }
        .search-hint {
            padding: 24px 16px;
            color: var(--text-muted);
            font-size: 0.9em;
            line-height: 1.5;
        }
        .search-result {
            padding: 12px 16px;
            border-bottom: 1px solid var(--border);
            cursor: pointer;
            transition: background 0.1s;
        }
        .search-result:hover { background: var(--bg-tertiary); }
        .search-result-head {
            display: flex;
            align-items: center;
            gap: 8px;
            font-weight: 500;
            margin-bottom: 4px;
        }
        .search-result-rank {
            color: var(--text-muted);
            font-size: 0.85em;
            min-width: 20px;
        }
        .search-badge {
            font-size: 0.7em;
            padding: 2px 6px;
            border-radius: 3px;
            background: var(--bg-primary);
            border: 1px solid var(--border);
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            white-space: nowrap;
        }
        .search-badge.code     { color: var(--accent-cyan);   border-color: var(--accent-cyan); }
        .search-badge.docs     { color: var(--accent-yellow); border-color: var(--accent-yellow); }
        .search-badge.workspace{ color: var(--accent-purple); border-color: var(--accent-purple); }
        .search-badge.project  { color: var(--accent-orange); border-color: var(--accent-orange); }
        .search-result.foreign {
            border-left: 3px solid var(--accent-orange);
            padding-left: 9px;
        }
        .search-filter {
            flex: 1;
            background: var(--bg-primary);
            color: var(--text-primary);
            border: 1px solid var(--border);
            border-radius: 4px;
            padding: 6px 10px;
            font-size: 0.9em;
            font-family: 'Consolas', 'Monaco', monospace;
            margin-left: 8px;
            min-width: 200px;
        }
        .search-filter:focus { outline: none; border-color: var(--accent-cyan); }
        .cross-project-banner {
            background: var(--bg-tertiary);
            color: var(--accent-orange);
            border-left: 3px solid var(--accent-orange);
            padding: 6px 10px;
            margin: 6px 0;
            font-size: 0.85em;
            font-family: 'Consolas', 'Monaco', monospace;
            border-radius: 3px;
        }
        .search-result-name { flex: 1; word-break: break-word; }
        .search-result-dist {
            color: var(--text-muted);
            font-size: 0.8em;
            font-family: 'Consolas', 'Monaco', monospace;
        }
        .search-result-loc {
            color: var(--accent-cyan);
            font-size: 0.85em;
            font-family: 'Consolas', 'Monaco', monospace;
            font-weight: 600;
            margin-bottom: 4px;
        }
        .search-result-snippet {
            font-size: 0.85em;
            color: var(--text-secondary);
            line-height: 1.4;
            white-space: pre-wrap;
            font-family: 'Consolas', 'Monaco', monospace;
            max-height: 4.2em;
            overflow: hidden;
        }
        .search-error {
            padding: 16px;
            color: var(--accent-red);
            font-size: 0.9em;
            border-left: 3px solid var(--accent-red);
            background: var(--bg-secondary);
            margin: 12px 16px;
        }

        /* Markdown rendering inside task descriptions */
        .markdown-body { line-height: 1.5; }
        .markdown-body h1, .markdown-body h2, .markdown-body h3,
        .markdown-body h4, .markdown-body h5, .markdown-body h6 {
            margin: 0.7em 0 0.3em;
            font-weight: 600;
            color: var(--text-primary);
        }
        .markdown-body h1 { font-size: 1.2em; }
        .markdown-body h2 { font-size: 1.1em; color: var(--accent-cyan); }
        .markdown-body h3 { font-size: 1.0em; color: var(--accent-purple); }
        .markdown-body h4 { font-size: 0.95em; color: var(--accent-yellow); }
        .markdown-body p { margin: 0.4em 0; }
        .markdown-body ul, .markdown-body ol { margin: 0.3em 0 0.3em 1.4em; padding: 0; }
        .markdown-body li { margin: 0.15em 0; }
        .markdown-body code {
            background: var(--bg-primary);
            border: 1px solid var(--border);
            border-radius: 3px;
            padding: 1px 5px;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 0.9em;
            color: var(--accent-yellow);
        }
        .markdown-body pre {
            background: var(--bg-primary);
            border: 1px solid var(--border);
            border-radius: 4px;
            padding: 8px 10px;
            margin: 0.5em 0;
            overflow-x: auto;
        }
        .markdown-body pre code {
            background: transparent;
            border: none;
            padding: 0;
            color: var(--text-primary);
            font-size: 0.85em;
            white-space: pre;
        }
        .markdown-body blockquote {
            border-left: 3px solid var(--accent-cyan);
            padding-left: 10px;
            margin: 0.5em 0;
            color: var(--text-secondary);
        }
        .markdown-body table {
            border-collapse: collapse;
            margin: 0.5em 0;
            font-size: 0.88em;
            width: 100%;
        }
        .markdown-body th, .markdown-body td {
            border: 1px solid var(--border);
            padding: 4px 8px;
            text-align: left;
        }
        .markdown-body th {
            background: var(--bg-primary);
            color: var(--accent-cyan);
            font-weight: 600;
        }
        .markdown-body hr {
            border: none;
            border-top: 1px solid var(--border);
            margin: 0.8em 0;
        }
        .markdown-body strong { color: var(--text-primary); font-weight: 600; }
        .markdown-body em { color: var(--text-primary); }
        .markdown-body a { color: var(--accent-cyan); text-decoration: none; }
        .markdown-body a:hover { text-decoration: underline; }
        .markdown-body del { color: var(--text-muted); text-decoration: line-through; }

        /* Settings tab */
        .settings-page {
            padding: 20px 24px 80px;
            max-width: 720px;
        }
        .settings-page h2 {
            font-size: 1.3em;
            margin: 0 0 4px;
            color: var(--text-primary);
        }
        .settings-page .subtitle {
            color: var(--text-muted);
            font-size: 0.9em;
            margin-bottom: 24px;
        }
        .settings-section {
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 16px 18px;
            margin-bottom: 20px;
        }
        .settings-section-title {
            font-size: 1em;
            font-weight: 600;
            color: var(--accent-cyan);
            margin: 0 0 4px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .settings-section-help {
            color: var(--text-muted);
            font-size: 0.85em;
            margin: 0 0 14px;
            line-height: 1.5;
        }
        .settings-row {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            align-items: center;
            margin: 10px 0;
        }
        .settings-row label {
            color: var(--text-secondary);
            font-size: 0.9em;
            min-width: 100px;
        }
        .settings-row input[type="text"],
        .settings-row input[type="password"],
        .settings-row select {
            flex: 1;
            min-width: 220px;
            padding: 6px 10px;
            background: var(--bg-primary);
            color: var(--text-primary);
            border: 1px solid var(--border);
            border-radius: 4px;
            font: inherit;
            font-size: 0.9em;
        }
        .settings-row input:focus, .settings-row select:focus {
            outline: none;
            border-color: var(--accent-cyan);
        }
        /* Custom combobox — input + dropdown that always shows ALL options */
        .combo {
            position: relative;
            flex: 1;
            display: flex;
        }
        .combo input[type="text"] {
            flex: 1;
            padding-right: 30px;
        }
        .combo-toggle {
            position: absolute;
            right: 1px;
            top: 1px;
            bottom: 1px;
            width: 28px;
            background: transparent;
            border: none;
            color: var(--text-secondary);
            cursor: pointer;
            font-size: 0.9em;
            border-left: 1px solid var(--border);
        }
        .combo-toggle:hover {
            background: var(--bg-tertiary);
            color: var(--text-primary);
        }
        .combo-list {
            display: none;
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            margin-top: 2px;
            max-height: 240px;
            overflow-y: auto;
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 4px;
            z-index: 100;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
        }
        .combo.open .combo-list {
            display: block;
        }
        .combo-option {
            padding: 8px 12px;
            cursor: pointer;
            color: var(--text-primary);
            font-size: 0.9em;
        }
        .combo-option:hover {
            background: var(--bg-tertiary);
            color: var(--accent-cyan);
        }
        .settings-toggle {
            display: flex;
            align-items: flex-start;
            gap: 10px;
            margin: 12px 0;
            cursor: pointer;
        }
        .settings-toggle input[type="checkbox"] {
            margin-top: 4px;
            accent-color: var(--accent-cyan);
            transform: scale(1.2);
        }
        .settings-toggle .label-main {
            font-weight: 500;
            color: var(--text-primary);
        }
        .settings-toggle .label-help {
            display: block;
            color: var(--text-muted);
            font-size: 0.85em;
            margin-top: 2px;
            line-height: 1.4;
        }
        .settings-status {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 0.82em;
            font-weight: 500;
        }
        .settings-status.ok      { background: rgba(158, 206, 106, 0.18); color: var(--accent-green); }
        .settings-status.off     { background: rgba(86, 95, 137, 0.25);   color: var(--text-muted); }
        .settings-status.warn    { background: rgba(224, 175, 104, 0.18); color: var(--accent-yellow); }
        .settings-status.err     { background: rgba(247, 118, 142, 0.15); color: var(--accent-red); }
        .settings-actions {
            display: flex;
            gap: 10px;
            margin-top: 18px;
            padding-top: 14px;
            border-top: 1px solid var(--border);
        }
        .settings-btn {
            padding: 8px 18px;
            background: var(--bg-primary);
            color: var(--text-primary);
            border: 1px solid var(--border);
            border-radius: 4px;
            font: inherit;
            font-size: 0.9em;
            cursor: pointer;
        }
        .settings-btn:hover { border-color: var(--accent-cyan); }
        .settings-btn.primary {
            background: var(--accent-cyan);
            color: var(--bg-primary);
            border-color: var(--accent-cyan);
            font-weight: 600;
        }
        .settings-btn.primary:hover { background: #91d8ff; }
        .settings-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .settings-info {
            background: var(--bg-primary);
            border: 1px solid var(--border);
            border-radius: 4px;
            padding: 8px 12px;
            font-size: 0.85em;
            color: var(--text-secondary);
            margin: 10px 0;
            line-height: 1.4;
        }
        .settings-info code { color: var(--accent-yellow); }
        .settings-feedback {
            margin-top: 12px;
            padding: 10px 12px;
            border-radius: 4px;
            font-size: 0.88em;
        }
        .settings-feedback.success { background: rgba(158, 206, 106, 0.15); color: var(--accent-green); border: 1px solid var(--accent-green); }
        .settings-feedback.error { background: rgba(247, 118, 142, 0.10); color: var(--accent-red); border: 1px solid var(--accent-red); }
        .settings-update-banner {
            background: linear-gradient(90deg, rgba(125, 207, 255, 0.15), rgba(187, 154, 247, 0.10));
            border: 1px solid var(--accent-cyan);
            border-radius: 6px;
            padding: 12px 16px;
            margin-bottom: 20px;
            color: var(--text-primary);
            font-size: 0.9em;
            line-height: 1.5;
        }
        .settings-update-banner strong { color: var(--accent-cyan); }
    </style>
</head>
<body>
    <header>
        <h1>${escapeHtml(PRODUCT_NAME)} Viewer</h1>
        <span class="project-name">${projectName}</span>
    </header>

    <div class="container">
        <div class="panel tree-panel" id="treePanel">
            <div class="tab-bar">
                <div class="tab active" data-tab="code">Code</div>
                <div class="tab" data-tab="all">All</div>
            </div>
            <div class="panel-content" id="tree">
                <div class="loading">Loading project tree...</div>
            </div>
        </div>
        <div class="splitter" id="splitter"></div>
        <div class="panel detail-panel">
            <div class="tab-bar">
                <div class="tab active" data-tab="overview">Overview</div>
                <div class="tab" data-tab="source">Code</div>
                <div class="tab" data-tab="tasks">Tasks</div>
                <div class="tab" data-tab="logs">Logs</div>
                <div class="tab" data-tab="search">Search</div>
                <div class="tab" data-tab="settings">Settings</div>
            </div>
            <div class="panel-content" id="detail">
                <div class="empty-state">
                    <p>Click on a file to view its signature</p>
                </div>
            </div>
        </div>
    </div>

    <script>
        let ws = new WebSocket('ws://localhost:${PORT}');
        // Normalised to forward-slashes so the comparison with global.db
        // project paths (always forward-slash) works on Windows too.
        const CURRENT_PROJECT_PATH = ${JSON.stringify(path.resolve(projectPath).replace(/\\/g, '/'))};
        // When the active file is a cross-project read (from a global search
        // hit), this holds the foreign project's path so re-reads triggered by
        // tab-switches keep using the same project context.
        let currentForeignProjectPath = '';
        function normalizeProjectPath(p) {
            return String(p || '').replace(/\\\\/g, '/');
        }
        let selectedNode = null;
        let currentFile = null;
        let currentTreeMode = 'code';
        let currentDetailTab = 'overview';
        let cachedSignature = null;
        let cachedContent = null;
        let cachedTasks = null;

        function pollPendingFocus() {
            try { ws.send(JSON.stringify({ type: 'pollPendingFocus' })); } catch (e) { /* ignore */ }
        }

        ws.onopen = () => {
            console.log('Connected to AiDex Viewer');
            // Ask the server: any pending focus-tab request?
            pollPendingFocus();
            // Honor URL hash like #tab=settings as a fallback path.
            const hash = window.location.hash;
            const m = hash.match(/tab=([\w-]+)/);
            if (m) {
                const target = decodeURIComponent(m[1]);
                const tabEl = document.querySelector('.detail-panel .tab[data-tab="' + target + '"]');
                if (tabEl) tabEl.click();
            }
        };

        // Poll for pending focus when the tab regains visibility — covers
        // the case where the user already had the viewer open in another tab
        // and triggered aidex_settings({open:true}) elsewhere.
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && ws.readyState === WebSocket.OPEN) pollPendingFocus();
        });
        window.addEventListener('focus', () => {
            if (ws.readyState === WebSocket.OPEN) pollPendingFocus();
        });
        // Also poll periodically while visible — cheap, covers everything.
        setInterval(() => {
            if (!document.hidden && ws.readyState === WebSocket.OPEN) pollPendingFocus();
        }, 2000);

        ws.onclose = () => {
            console.log('WebSocket closed — reconnecting in 2s...');
            setTimeout(() => {
                const newWs = new WebSocket('ws://localhost:${PORT}');
                newWs.onopen = ws.onopen;
                newWs.onclose = ws.onclose;
                newWs.onmessage = ws.onmessage;
                ws = newWs;
            }, 2000);
        };

        let cachedCodeTree = null;
        let cachedAllTree = null;

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            console.log('📨 Received:', msg.type, msg);

            if (msg.type === 'tree') {
                // Cache the tree for the mode
                if (msg.mode === 'code') cachedCodeTree = msg.data;
                else cachedAllTree = msg.data;
                renderTree(msg.data);
            } else if (msg.type === 'refresh') {
                // Live reload: update cached trees and re-render current mode
                console.log('🔄 Live reload triggered');
                cachedCodeTree = msg.codeTree;
                cachedAllTree = msg.allTree;
                const treeToRender = currentTreeMode === 'code' ? cachedCodeTree : cachedAllTree;
                if (treeToRender) renderTree(treeToRender);
            } else if (msg.type === 'signature') {
                cachedSignature = { file: msg.file, data: msg.data };
                if (currentDetailTab === 'overview') {
                    renderSignature(msg.file, msg.data);
                }
            } else if (msg.type === 'fileContent') {
                cachedContent = {
                    file: msg.file,
                    data: msg.data,
                    projectName: msg.projectName || null,
                    projectPath: msg.projectPath || null,
                };
                if (currentDetailTab === 'source') {
                    renderFileContent(msg.file, msg.data, cachedContent);
                }
            } else if (msg.type === 'tasks') {
                cachedTasks = msg.data;
                if (currentDetailTab === 'tasks') {
                    renderTasks(msg.data);
                }
            } else if (msg.type === 'log') {
                handleLogEntry(msg.entry);
            } else if (msg.type === 'searchResults') {
                handleSearchResults(msg);
            } else if (msg.type === 'settings') {
                handleSettings(msg);
            } else if (msg.type === 'settingsSaved') {
                handleSettingsSaved(msg);
            } else if (msg.type === 'llmTestResult') {
                handleLlmTestResult(msg);
            } else if (msg.type === 'focusTab' && msg.tab) {
                const tab = document.querySelector('.detail-panel .tab[data-tab="' + msg.tab + '"]');
                if (tab) tab.click();
            }
        };

        // Tab switching - Tree panel
        document.querySelectorAll('.tree-panel .tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.tree-panel .tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                currentTreeMode = tab.dataset.tab;
                document.getElementById('tree').innerHTML = '<div class="loading">Loading...</div>';
                ws.send(JSON.stringify({ type: 'getTree', mode: currentTreeMode }));
            });
        });

        // Tab switching - Detail panel
        document.querySelectorAll('.detail-panel .tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.detail-panel .tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                currentDetailTab = tab.dataset.tab;

                if (currentDetailTab === 'overview') {
                    if (!currentFile) {
                        document.getElementById('detail').innerHTML = '<div class="empty-state"><p>Click on a file to view its signature</p></div>';
                    } else if (cachedSignature && cachedSignature.file === currentFile) {
                        renderSignature(cachedSignature.file, cachedSignature.data);
                    } else {
                        ws.send(JSON.stringify({ type: 'getSignature', file: currentFile }));
                    }
                } else if (currentDetailTab === 'source') {
                    if (!currentFile) {
                        document.getElementById('detail').innerHTML = '<div class="empty-state"><p>Click on a file to view its source</p></div>';
                    } else if (cachedContent && cachedContent.file === currentFile) {
                        renderFileContent(cachedContent.file, cachedContent.data, cachedContent);
                    } else {
                        document.getElementById('detail').innerHTML = '<div class="loading">Loading source...</div>';
                        const req = { type: 'getFileContent', file: currentFile };
                        if (currentForeignProjectPath) req.projectPath = currentForeignProjectPath;
                        ws.send(JSON.stringify(req));
                    }
                } else if (currentDetailTab === 'tasks') {
                    if (cachedTasks) {
                        renderTasks(cachedTasks);
                    } else {
                        document.getElementById('detail').innerHTML = '<div class="loading">Loading tasks...</div>';
                        ws.send(JSON.stringify({ type: 'getTasks' }));
                    }
                } else if (currentDetailTab === 'logs') {
                    renderLogView();
                } else if (currentDetailTab === 'search') {
                    renderSearchTab();
                } else if (currentDetailTab === 'settings') {
                    renderSettingsTab();
                }
            });
        });

        function renderTree(node, container = document.getElementById('tree'), depth = 0) {
            if (depth === 0) {
                container.innerHTML = '';
            }

            const div = document.createElement('div');
            div.className = 'tree-node ' + node.type + (node.fileType ? ' ' + node.fileType : '');
            div.style.paddingLeft = (depth * 20 + 10) + 'px';
            div.dataset.path = node.path;
            div.dataset.type = node.type;

            // Status icon (modified/new/unchanged)
            const statusIcon = document.createElement('span');
            statusIcon.className = 'status-icon';
            if (node.status === 'modified') {
                statusIcon.className += ' modified';
                statusIcon.textContent = '✏️';
                statusIcon.title = 'Modified in this session';
            } else if (node.status === 'new') {
                statusIcon.className += ' new';
                statusIcon.textContent = '➕';
                statusIcon.title = 'New in this session';
            } else if (node.status === 'unchanged') {
                statusIcon.className += ' unchanged';
                statusIcon.textContent = '✓';
                statusIcon.title = 'Unchanged';
            }
            div.appendChild(statusIcon);

            // Git status cat icon (only for files in git repos)
            if (node.gitStatus) {
                const gitCat = document.createElement('span');
                gitCat.className = 'git-cat ' + node.gitStatus;
                // Cat silhouette SVG - simple sitting cat with raised paw
                gitCat.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12,8L10.67,8.09C9.81,7.07 7.4,4.5 5,4.5C5,4.5 3.03,7.46 4.96,11.41C4.41,12.24 4.07,12.67 4,13.66L2.07,13.95L2.28,14.93L4.04,14.67L4.18,15.38L2.61,16.32L3.08,17.21L4.53,16.32C5.68,18.76 8.59,20 12,20C15.41,20 18.32,18.76 19.47,16.32L20.92,17.21L21.39,16.32L19.82,15.38L19.96,14.67L21.72,14.93L21.93,13.95L20,13.66C19.93,12.67 19.59,12.24 19.04,11.41C20.97,7.46 19,4.5 19,4.5C16.6,4.5 14.19,7.07 13.33,8.09L12,8M9,11A1,1 0 0,1 10,12A1,1 0 0,1 9,13A1,1 0 0,1 8,12A1,1 0 0,1 9,11M15,11A1,1 0 0,1 16,12A1,1 0 0,1 15,13A1,1 0 0,1 14,12A1,1 0 0,1 15,11M11,14H13V16H11V14Z"/></svg>';
                const gitTitles = {
                    'untracked': 'Untracked - not in git',
                    'modified': 'Modified - not committed',
                    'committed': 'Committed - not pushed',
                    'pushed': 'Pushed - in sync with remote'
                };
                gitCat.title = gitTitles[node.gitStatus] || node.gitStatus;
                div.appendChild(gitCat);
            }

            // File/folder icon
            const icon = document.createElement('span');
            icon.className = 'icon';
            if (node.type === 'dir') {
                icon.textContent = '📁';
            } else {
                // Different icons for different file types
                const iconMap = {
                    'code': '📄',
                    'config': '⚙️',
                    'doc': '📝',
                    'test': '🧪',
                    'asset': '🖼️',
                    'other': '📄'
                };
                icon.textContent = iconMap[node.fileType] || '📄';
            }

            const name = document.createElement('span');
            name.className = 'name';
            name.textContent = node.name;

            div.appendChild(icon);
            div.appendChild(name);

            if (node.stats && (node.stats.methods > 0 || node.stats.types > 0)) {
                const stats = document.createElement('span');
                stats.className = 'stats';
                stats.textContent = node.stats.methods + 'm ' + node.stats.types + 't';
                div.appendChild(stats);
            }

            div.onclick = (e) => {
                e.stopPropagation();

                if (node.type === 'dir') {
                    const children = div.nextElementSibling;
                    if (children && children.classList.contains('tree-children')) {
                        children.classList.toggle('collapsed');
                        icon.textContent = children.classList.contains('collapsed') ? '📁' : '📂';
                    }
                } else {
                    if (selectedNode) selectedNode.classList.remove('selected');
                    div.classList.add('selected');
                    selectedNode = div;
                    currentFile = node.path;
                    currentForeignProjectPath = '';
                    cachedSignature = null;
                    cachedContent = null;

                    // Reset to overview tab
                    currentDetailTab = 'overview';
                    document.querySelectorAll('.detail-panel .tab').forEach(t => t.classList.remove('active'));
                    document.querySelector('.detail-panel .tab[data-tab="overview"]').classList.add('active');

                    ws.send(JSON.stringify({ type: 'getSignature', file: node.path }));
                }
            };

            container.appendChild(div);

            if (node.children && node.children.length > 0) {
                const childContainer = document.createElement('div');
                childContainer.className = 'tree-children';
                container.appendChild(childContainer);

                for (const child of node.children) {
                    renderTree(child, childContainer, depth + 1);
                }
            }
        }

        function renderSignature(filePath, data) {
            const detail = document.getElementById('detail');

            if (data.error) {
                detail.innerHTML = '<div class="empty-state">' + data.error + '</div>';
                return;
            }

            let html = '<h2>' + filePath.split('/').pop() + '</h2>';
            html += '<div class="file-path">' + filePath + '</div>';

            if (data.header) {
                html += '<div class="section"><h3>Header Comments</h3>';
                html += '<div class="header-comment">' + escapeHtml(data.header) + '</div></div>';
            }

            if (data.types && data.types.length > 0) {
                html += '<div class="section"><h3>Types (' + data.types.length + ')</h3>';
                html += '<ul class="type-list">';
                for (const t of data.types) {
                    html += '<li><span class="line-num">:' + t.line + '</span>';
                    html += '<span class="kind">' + t.kind + '</span>';
                    html += '<span>' + escapeHtml(t.name) + '</span></li>';
                }
                html += '</ul></div>';
            }

            if (data.methods && data.methods.length > 0) {
                html += '<div class="section"><h3>Methods (' + data.methods.length + ')</h3>';
                html += '<ul class="method-list">';
                for (const m of data.methods) {
                    html += '<li><span class="line-num">:' + m.line + '</span>';
                    if (m.visibility) html += '<span class="visibility">' + m.visibility + '</span>';
                    if (m.static) html += '<span class="modifier">static</span>';
                    if (m.async) html += '<span class="modifier">async</span>';
                    html += '<span>' + escapeHtml(m.prototype) + '</span></li>';
                }
                html += '</ul></div>';
            }

            if (!data.header && (!data.types || data.types.length === 0) && (!data.methods || data.methods.length === 0)) {
                html += '<div class="empty-state">No signature data for this file</div>';
            }

            detail.innerHTML = html;
        }

        function renderFileContent(filePath, data, meta) {
            const detail = document.getElementById('detail');

            if (data.error) {
                detail.innerHTML = '<div class="empty-state">' + data.error + '</div>';
                return;
            }

            const isCrossProject = meta && meta.projectName && meta.projectPath
                && normalizeProjectPath(meta.projectPath) !== CURRENT_PROJECT_PATH;

            let html = '<h2>' + filePath.split('/').pop() + '</h2>';
            if (isCrossProject) {
                html += '<div class="cross-project-banner">Cross-project read-only · '
                    + escapeHtml(meta.projectName) + ' (' + escapeHtml(meta.projectPath) + ')</div>';
            }
            html += '<div class="file-path">' + filePath + '</div>';
            html += '<div class="code-view"><pre><code class="language-' + data.language + '">' + escapeHtml(data.content) + '</code></pre></div>';

            detail.innerHTML = html;

            // Apply syntax highlighting
            detail.querySelectorAll('pre code').forEach((block) => {
                hljs.highlightElement(block);
            });
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        let taskGroupMode = localStorage.getItem('aidex-task-group') || 'status';

        function setTaskGroupMode(mode) {
            taskGroupMode = mode;
            localStorage.setItem('aidex-task-group', mode);
            if (cachedTasks) renderTasks(cachedTasks);
        }

        function renderTasks(taskList) {
            const detail = document.getElementById('detail');
            const priorityIcon = { 1: '\\u{1F534}', 2: '\\u{1F7E1}', 3: '\\u26AA' };
            const priorityLabel = { 1: 'High', 2: 'Medium', 3: 'Low' };

            let html = '<h2 style="display:flex;align-items:center">Task Backlog (' + taskList.length + ')';
            html += '<span class="task-group-toggle">';
            html += '<button onclick="setTaskGroupMode(\\'status\\')" class="' + (taskGroupMode === 'status' ? 'active' : '') + '">Status</button>';
            html += '<button onclick="setTaskGroupMode(\\'tags\\')" class="' + (taskGroupMode === 'tags' ? 'active' : '') + '">Tags</button>';
            html += '</span></h2>';

            if (taskList.length === 0) {
                html += '<div class="empty-state"><p>No tasks yet.</p><p style="margin-top:8px;font-size:0.9em">Use <code>aidex_task</code> to create tasks from the chat.</p></div>';
                detail.innerHTML = html;
                return;
            }

            if (taskGroupMode === 'tags') {
                html += renderTasksByTags(taskList, priorityIcon, priorityLabel);
            } else {
                html += renderTasksByStatus(taskList, priorityIcon, priorityLabel);
            }

            detail.innerHTML = html;
        }

        function renderTasksByStatus(taskList, priorityIcon, priorityLabel) {
            const active = taskList.filter(t => t.status === 'active');
            const backlog = taskList.filter(t => t.status === 'backlog');
            const done = taskList.filter(t => t.status === 'done');
            const cancelled = taskList.filter(t => t.status === 'cancelled');

            let html = '';

            if (active.length > 0) {
                html += '<div class="task-section-header">Active (' + active.length + ')</div>';
                html += '<ul class="task-list">';
                for (const t of active) html += renderTaskItem(t, priorityIcon, priorityLabel);
                html += '</ul>';
            }

            if (backlog.length > 0) {
                html += '<div class="task-section-header">Backlog (' + backlog.length + ')</div>';
                html += '<ul class="task-list">';
                for (const t of backlog) html += renderTaskItem(t, priorityIcon, priorityLabel);
                html += '</ul>';
            }

            if (done.length > 0) {
                html += '<div class="task-done-toggle" onclick="var el=this.nextElementSibling;el.classList.toggle(\\'collapsed\\');this.textContent=el.classList.contains(\\'collapsed\\')?\\'\u2705 Done (' + done.length + ') \u25B8\\':\\'\u2705 Done (' + done.length + ') \u25BE\\'">\\u2705 Done (' + done.length + ') \\u25B8</div>';
                html += '<ul class="task-list task-done-list collapsed">';
                for (const t of done) html += renderTaskItem(t, priorityIcon, priorityLabel);
                html += '</ul>';
            }

            if (cancelled.length > 0) {
                html += '<div class="task-done-toggle" onclick="var el=this.nextElementSibling;el.classList.toggle(\\'collapsed\\');this.textContent=el.classList.contains(\\'collapsed\\')?\\'\u274C Cancelled (' + cancelled.length + ') \u25B8\\':\\'\u274C Cancelled (' + cancelled.length + ') \u25BE\\'">\\u274C Cancelled (' + cancelled.length + ') \\u25B8</div>';
                html += '<ul class="task-list task-done-list collapsed">';
                for (const t of cancelled) html += renderTaskItem(t, priorityIcon, priorityLabel);
                html += '</ul>';
            }

            return html;
        }

        const tagIcons = { marketing: '\\u{1F4E3}', release: '\\u{1F4E6}', docs: '\\u{1F4C4}', viewer: '\\u{1F5A5}', test: '\\u{1F9EA}', bug: '\\u{1F41B}', feature: '\\u2728', social: '\\u{1F310}', content: '\\u270D\\uFE0F', github: '\\u{1F4BB}' };

        function renderTasksByTags(taskList, priorityIcon, priorityLabel) {
            const groups = {};
            const statusOrder = { active: 0, backlog: 1, done: 2, cancelled: 3 };

            for (const t of taskList) {
                const firstTag = t.tags ? t.tags.split(',')[0].trim() : 'ungrouped';
                if (!groups[firstTag]) groups[firstTag] = [];
                groups[firstTag].push(t);
            }

            // Sort groups: by number of active/backlog tasks descending
            const sortedTags = Object.keys(groups).sort((a, b) => {
                if (a === 'ungrouped') return 1;
                if (b === 'ungrouped') return -1;
                const aActive = groups[a].filter(t => t.status === 'active' || t.status === 'backlog').length;
                const bActive = groups[b].filter(t => t.status === 'active' || t.status === 'backlog').length;
                return bActive - aActive;
            });

            let html = '';
            for (const tag of sortedTags) {
                const tasks = groups[tag];
                // Sort within group: status then priority
                tasks.sort((a, b) => (statusOrder[a.status] - statusOrder[b.status]) || (a.priority - b.priority));

                const openCount = tasks.filter(t => t.status === 'active' || t.status === 'backlog').length;
                const doneCount = tasks.length - openCount;
                const icon = tagIcons[tag] || '\\u{1F3F7}\\uFE0F';
                const collapsed = openCount === 0 ? ' collapsed' : '';

                html += '<div class="task-tag-group' + collapsed + '">';
                html += '<div class="task-tag-group-header" onclick="this.parentElement.classList.toggle(\\'collapsed\\')">';
                html += icon + ' ' + escapeHtml(tag) + ' (' + openCount + (doneCount > 0 ? '+' + doneCount : '') + ') ';
                html += (collapsed ? '\\u25B8' : '\\u25BE');
                html += '</div>';
                html += '<ul class="task-list">';
                for (const t of tasks) html += renderTaskItem(t, priorityIcon, priorityLabel, true);
                html += '</ul>';
                html += '</div>';
            }

            return html;
        }

        function renderTaskItem(t, priorityIcon, priorityLabel, showStatus) {
            let html = '<li class="task-item priority-' + t.priority + ' status-' + t.status + '">';
            html += '<div class="task-title">' + (priorityIcon[t.priority] || '') + ' #' + t.id + ' ' + escapeHtml(t.title);
            if (showStatus) html += '<span class="task-status-badge status-' + t.status + '">' + t.status + '</span>';
            html += '</div>';
            if (t.summary) {
                html += '<div style="font-size:0.88em;color:var(--text-secondary);margin-top:2px;font-style:italic">' + escapeHtml(t.summary) + '</div>';
            }
            if (t.description) {
                html += '<div class="task-description markdown-body">' + renderMarkdown(t.description) + '</div>';
            }
            const meta = [];
            meta.push(priorityLabel[t.priority] || 'Medium');
            if (t.source) meta.push('Source: ' + escapeHtml(t.source));
            const created = new Date(t.created_at);
            meta.push(created.toLocaleDateString() + ' ' + created.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}));
            if (t.completed_at) {
                const completed = new Date(t.completed_at);
                meta.push('Done: ' + completed.toLocaleDateString());
            }
            html += '<div class="task-meta">' + meta.map(m => '<span>' + m + '</span>').join('') + '</div>';
            if (t.tags) {
                html += '<div class="task-tags">' + t.tags.split(',').map(s => '#' + escapeHtml(s.trim())).join(' ') + '</div>';
            }
            if (t.due) {
                const dueDate = new Date(t.due);
                const isOverdue = t.due <= Date.now();
                const dueStr = dueDate.toLocaleDateString() + ' ' + dueDate.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
                html += '<div class="task-schedule' + (isOverdue ? ' overdue' : '') + '">';
                html += '<span class="schedule-icon">' + (isOverdue ? '\\u{1F6A8}' : '\\u23F0') + '</span>';
                html += (isOverdue ? 'OVERDUE: ' : 'Due: ') + dueStr;
                if (t.interval) html += ' (every ' + escapeHtml(t.interval) + ')';
                if (t.auto_go) html += ' \\u26A1 auto';
                html += '</div>';
            }
            if (t.action) {
                html += '<div style="font-size:0.8em;color:var(--text-muted);margin-top:2px">\\u{1F3AF} ' + escapeHtml(t.action) + '</div>';
            }
            if (t.status !== 'done' && t.status !== 'cancelled') {
                html += '<div class="task-actions">';
                html += '<button class="task-btn task-btn-done" onclick="updateTaskStatus(' + t.id + ', \\'done\\')">\\u2705 Done</button>';
                html += '<button class="task-btn task-btn-cancel" onclick="updateTaskStatus(' + t.id + ', \\'cancelled\\')">\\u274C Cancel</button>';
                html += '</div>';
            }
            html += '</li>';
            return html;
        }

        function updateTaskStatus(taskId, status) {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'updateTaskStatus', taskId: taskId, status: status }));
            }
        }

        // ============================================================
        // Log Hub View
        // ============================================================
        let logEntries = [];
        let logAutoScroll = true;
        let logFilterLevel = null;  // null = all
        let logFilterSource = '';
        let logFilterText = '';
        let logViewInitialized = false;

        const logLevelIcon = { debug: '\\u26AA', info: '\\u{1F535}', success: '\\u{1F7E2}', warn: '\\u{1F7E1}', error: '\\u{1F534}' };

        function handleLogEntry(entry) {
            logEntries.push(entry);
            // Keep max 5000 entries in browser memory
            if (logEntries.length > 5000) logEntries = logEntries.slice(-4000);

            if (currentDetailTab === 'logs' && logViewInitialized) {
                appendLogEntryToDOM(entry);
            }
        }

        // ============================================================
        // Search tab — semantic search across embeddings
        // ============================================================
        let searchState = {
            query: '',
            mode: 'hybrid',
            kinds: { code: true, docs: true, workspace: true },
            k: 20,
            scope: 'current',         // 'current' | 'all'
            projectFilter: '',         // glob string, e.g. "*Aidex*"; empty = no filter
            inFlight: 0,
            results: null,
            error: null,
        };
        let searchRequestSeq = 0;
        let searchDebounce = null;

        function renderSearchTab() {
            const detail = document.getElementById('detail');
            // The detail panel is shared across tabs and gets overwritten when other
            // tabs render. So we always re-build our controls if they're missing.
            const needsBuild = !document.getElementById('searchInput');
            if (needsBuild) {
                detail.innerHTML = \`
                    <div class="search-controls">
                        <div class="search-row">
                            <input type="text" class="search-input" id="searchInput"
                                placeholder="Ask a question — e.g. 'how do we cache the embedding model'"
                                autocomplete="off" />
                        </div>
                        <div class="search-row">
                            <div class="search-segment" id="searchScopeSeg" title="Search this project only, or all projects with embeddings enabled">
                                <input type="radio" name="searchScope" id="scope-current" value="current" checked>
                                <label for="scope-current">This project</label>
                                <input type="radio" name="searchScope" id="scope-all" value="all">
                                <label for="scope-all">All projects</label>
                            </div>
                            <input type="text" class="search-filter" id="searchProjectFilter"
                                placeholder="Project filter (glob, e.g. *Aidex*)" autocomplete="off"
                                style="display:none;" />
                        </div>
                        <div class="search-row">
                            <div class="search-segment" id="searchModeSeg">
                                <input type="radio" name="searchMode" id="mode-hybrid" value="hybrid" checked>
                                <label for="mode-hybrid">Hybrid</label>
                                <input type="radio" name="searchMode" id="mode-semantic" value="semantic">
                                <label for="mode-semantic">Semantic</label>
                                <input type="radio" name="searchMode" id="mode-exact" value="exact">
                                <label for="mode-exact">Exact</label>
                            </div>
                            <div class="search-kinds">
                                <label><input type="checkbox" id="kind-code" checked> Code</label>
                                <label><input type="checkbox" id="kind-docs" checked> Docs</label>
                                <label><input type="checkbox" id="kind-workspace" checked> Workspace</label>
                            </div>
                        </div>
                        <div class="search-k-row">
                            <span>k =</span>
                            <input type="range" id="searchK" min="5" max="50" step="5" value="20">
                            <span id="searchKLabel">20</span>
                        </div>
                    </div>
                    <div class="search-results" id="searchResults">
                        <div class="search-hint">
                            Type a natural-language question. Results stream in as you type.<br>
                            Click any hit to open the file or task it points to.
                        </div>
                    </div>
                \`;
                wireSearchControls();
            }

            // Restore state from prior visit
            const input = document.getElementById('searchInput');
            if (input) input.value = searchState.query;
            const kSlider = document.getElementById('searchK');
            if (kSlider) kSlider.value = searchState.k;
            const kLabel = document.getElementById('searchKLabel');
            if (kLabel) kLabel.textContent = searchState.k;
            ['hybrid','semantic','exact'].forEach(m => {
                const el = document.getElementById('mode-' + m);
                if (el) el.checked = (m === searchState.mode);
            });
            ['code','docs','workspace'].forEach(k => {
                const el = document.getElementById('kind-' + k);
                if (el) el.checked = !!searchState.kinds[k];
            });
            ['current','all'].forEach(s => {
                const el = document.getElementById('scope-' + s);
                if (el) el.checked = (s === searchState.scope);
            });
            const filterInput = document.getElementById('searchProjectFilter');
            if (filterInput) {
                filterInput.value = searchState.projectFilter;
                filterInput.style.display = (searchState.scope === 'all') ? '' : 'none';
            }
            renderSearchResults();
            if (input) setTimeout(() => input.focus(), 50);
        }

        function wireSearchControls() {
            const input = document.getElementById('searchInput');
            input.addEventListener('input', () => {
                searchState.query = input.value;
                scheduleSearch();
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); runSearchNow(); }
            });
            document.querySelectorAll('input[name="searchMode"]').forEach(r => {
                r.addEventListener('change', () => {
                    searchState.mode = document.querySelector('input[name="searchMode"]:checked').value;
                    if (searchState.query.trim()) runSearchNow();
                });
            });
            ['code','docs','workspace'].forEach(k => {
                const el = document.getElementById('kind-' + k);
                el.addEventListener('change', () => {
                    searchState.kinds[k] = el.checked;
                    if (searchState.query.trim()) runSearchNow();
                });
            });
            const slider = document.getElementById('searchK');
            slider.addEventListener('input', () => {
                searchState.k = parseInt(slider.value, 10);
                document.getElementById('searchKLabel').textContent = searchState.k;
            });
            slider.addEventListener('change', () => {
                if (searchState.query.trim()) runSearchNow();
            });
            document.querySelectorAll('input[name="searchScope"]').forEach(r => {
                r.addEventListener('change', () => {
                    searchState.scope = document.querySelector('input[name="searchScope"]:checked').value;
                    const f = document.getElementById('searchProjectFilter');
                    if (f) f.style.display = (searchState.scope === 'all') ? '' : 'none';
                    if (searchState.query.trim()) runSearchNow();
                });
            });
            const filterInput = document.getElementById('searchProjectFilter');
            if (filterInput) {
                filterInput.addEventListener('input', () => {
                    searchState.projectFilter = filterInput.value;
                });
                filterInput.addEventListener('change', () => {
                    if (searchState.query.trim() && searchState.scope === 'all') runSearchNow();
                });
                filterInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') { e.preventDefault(); runSearchNow(); }
                });
            }
        }

        function scheduleSearch() {
            if (searchDebounce) clearTimeout(searchDebounce);
            searchDebounce = setTimeout(runSearchNow, 350);
        }

        function runSearchNow() {
            const q = searchState.query.trim();
            if (!q) {
                searchState.results = null;
                searchState.error = null;
                renderSearchResults();
                return;
            }
            const kinds = Object.keys(searchState.kinds).filter(k => searchState.kinds[k]);
            if (kinds.length === 0) {
                searchState.error = 'Select at least one source kind (Code / Docs / Workspace).';
                searchState.results = null;
                renderSearchResults();
                return;
            }
            searchRequestSeq++;
            searchState.inFlight = searchRequestSeq;
            searchState.error = null;
            renderSearchResults();
            const filter = (searchState.scope === 'all' && searchState.projectFilter.trim())
                ? [searchState.projectFilter.trim()]
                : undefined;
            ws.send(JSON.stringify({
                type: 'searchEmbeddings',
                query: q,
                mode: searchState.mode,
                scope: searchState.scope,
                projectFilter: filter,
                sourceKinds: kinds,
                k: searchState.k,
                requestId: searchRequestSeq,
            }));
        }

        function handleSearchResults(msg) {
            if (msg.requestId !== searchState.inFlight) return; // stale
            searchState.inFlight = 0;
            if (msg.error) {
                searchState.error = msg.error;
                searchState.results = null;
                searchState.telemetry = null;
            } else {
                searchState.error = null;
                searchState.results = Array.isArray(msg.hits) ? msg.hits : [];
                searchState.telemetry = msg.telemetry || null;
            }
            if (currentDetailTab === 'search') renderSearchResults();
        }

        function renderSearchResults() {
            const container = document.getElementById('searchResults');
            if (!container) return;
            if (searchState.error) {
                container.innerHTML = \`<div class="search-error">\${escapeHtml(searchState.error)}</div>\`;
                return;
            }
            if (searchState.inFlight) {
                container.innerHTML = '<div class="search-hint">Searching…</div>';
                return;
            }
            if (!searchState.results) {
                container.innerHTML = \`
                    <div class="search-hint">
                        Type a natural-language question. Results appear as you type.<br>
                        Click any hit to open the file or task it points to.
                    </div>\`;
                return;
            }
            if (searchState.results.length === 0) {
                container.innerHTML = renderSearchTelemetry(searchState.telemetry) + '<div class="search-hint">No matches.</div>';
                return;
            }
            container.innerHTML = renderSearchTelemetry(searchState.telemetry) + searchState.results.map(renderHit).join('');
            container.querySelectorAll('.search-result').forEach(el => {
                el.addEventListener('click', (ev) => {
                    try {
                        const path = el.dataset.path;
                        const kind = el.dataset.kind;
                        const foreignProjectPath = el.dataset.projectPath || '';
                        if (kind === 'workspace') {
                            const tasksTab = document.querySelector('.detail-panel .tab[data-tab="tasks"]');
                            if (tasksTab) tasksTab.click();
                            return;
                        }
                        if (path) {
                            if (foreignProjectPath) {
                                // Cross-project hit: bypass tree (tree only shows the
                                // current project's files); open Source tab in
                                // read-only cross-project mode.
                                currentFile = path;
                                currentForeignProjectPath = foreignProjectPath;
                                cachedSignature = null;
                                cachedContent = null;
                                ws.send(JSON.stringify({
                                    type: 'getFileContent',
                                    file: path,
                                    projectPath: foreignProjectPath,
                                }));
                                const sourceTab = document.querySelector('.detail-panel .tab[data-tab="source"]');
                                if (sourceTab) sourceTab.click();
                                return;
                            }
                            currentForeignProjectPath = '';
                            // Find the file node in the tree and select it (mirrors a tree click).
                            const treeNode = document.querySelector('.tree-node[data-path="' + cssEsc(path) + '"]');
                            if (treeNode) {
                                treeNode.click();
                            } else {
                                // Fallback: just open Code/source view for the file path.
                                currentFile = path;
                                cachedSignature = null;
                                cachedContent = null;
                                ws.send(JSON.stringify({ type: 'getFileContent', file: path }));
                                const sourceTab = document.querySelector('.detail-panel .tab[data-tab="source"]');
                                if (sourceTab) sourceTab.click();
                            }
                        }
                    } catch (err) {
                        console.error('search-result click failed:', err);
                    }
                });
            });
        }

        function renderSearchTelemetry(t) {
            if (!t) return '';
            const tags = [];
            if (t.translateRan) tags.push(t.translateFailed ? '<span class="llm-tag fail">translate ✗</span>' : '<span class="llm-tag ok">translate ✓</span>');
            if (t.expandRan) tags.push(t.expandFailed ? '<span class="llm-tag fail">expand ✗</span>' : '<span class="llm-tag ok">expand ✓</span>');
            if (t.rerankRan) tags.push(t.rerankFailed ? '<span class="llm-tag fail">rerank ✗</span>' : '<span class="llm-tag ok">rerank ✓</span>');
            if (tags.length === 0) {
                return '<div class="search-telemetry off">○ Pure embeddings (LLM layer not used)</div>';
            }
            let html = '<div class="search-telemetry on">🤖 LLM: ' + tags.join(' ') + '</div>';
            if (t.queriesUsed && t.queriesUsed.length > 1) {
                html += '<div class="search-telemetry rewrites">Rewrites: ' +
                    t.queriesUsed.map(q => '<code>' + escapeHtml(q) + '</code>').join(' · ') + '</div>';
            }
            if (t.lastError) {
                html += '<div class="search-telemetry err">LLM error: ' + escapeHtml(t.lastError) + '</div>';
            }
            return html;
        }

        function renderHit(h) {
            const kind = h.sourceKind || 'code';
            const type = h.sourceType || '';
            const name = h.sourceName || h.sourceAnchor || '(unnamed)';
            const dist = (typeof h.distance === 'number' && h.distance > 0)
                ? \`d=\${h.distance.toFixed(3)}\` : '';
            const loc = h.sourcePath
                ? \`\${h.sourcePath}\${h.sourceLine ? ':' + h.sourceLine : ''}\`
                : '(workspace)';
            const snippet = h.sourceText ? escapeHtml(h.sourceText) : '';
            const isForeign = h.projectPath && normalizeProjectPath(h.projectPath) !== CURRENT_PROJECT_PATH;
            const projectBadge = isForeign
                ? \`<span class="search-badge project">\${escapeHtml(h.projectName || h.projectPath)}</span>\`
                : '';
            return \`
                <div class="search-result\${isForeign ? ' foreign' : ''}"
                     data-path="\${h.sourcePath ? escapeAttr(h.sourcePath) : ''}"
                     data-kind="\${kind}"
                     data-type="\${type}"
                     data-project-path="\${isForeign ? escapeAttr(h.projectPath) : ''}"
                     data-project-name="\${isForeign ? escapeAttr(h.projectName || '') : ''}">
                    <div class="search-result-head">
                        <span class="search-result-rank">#\${h.rank}</span>
                        <span class="search-badge \${kind}">\${kind}/\${type}</span>
                        \${projectBadge}
                        <span class="search-result-name">\${escapeHtml(name)}</span>
                        <span class="search-result-dist">\${dist}</span>
                    </div>
                    <div class="search-result-loc">\${escapeHtml(loc)}</div>
                    \${snippet ? \`<div class="search-result-snippet">\${snippet}</div>\` : ''}
                </div>
            \`;
        }

        function escapeAttr(s) {
            return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        // CSS.escape polyfill for selector-safe paths (Windows backslashes etc.)
        function cssEsc(s) {
            if (window.CSS && CSS.escape) return CSS.escape(s);
            return String(s).replace(/[^a-zA-Z0-9_\-]/g, ch => '\\\\' + ch.charCodeAt(0).toString(16) + ' ');
        }

        // ============================================================
        // Tiny Markdown renderer (no dependencies)
        // Supports: H1-H6, fenced code blocks, inline code, bold/italic,
        // unordered/ordered lists, blockquotes, tables, hr, links, paragraphs.
        // Good enough for task descriptions and notes.
        // ============================================================
        function renderMarkdown(src) {
            if (!src) return '';
            const lines = String(src).replace(/\\r\\n/g, '\\n').split('\\n');
            const out = [];
            let i = 0;

            const inlineEscape = (s) => escapeHtml(s);

            // Inline formatting: code, bold, italic, strikethrough, links.
            const renderInline = (s) => {
                // Replace inline code first to protect its content from other rules.
                const codeSpans = [];
                s = s.replace(/\`([^\`]+)\`/g, (_, code) => {
                    const idx = codeSpans.push('<code>' + inlineEscape(code) + '</code>') - 1;
                    return '\\u0000CODE' + idx + '\\u0000';
                });
                s = inlineEscape(s);
                // Bold + italic
                s = s.replace(/\\*\\*\\*([^*]+)\\*\\*\\*/g, '<strong><em>$1</em></strong>');
                s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
                s = s.replace(/(^|[^*])\\*([^*\\n]+)\\*(?!\\*)/g, '$1<em>$2</em>');
                // Strikethrough
                s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
                // Links [text](url)
                s = s.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
                // Restore code spans
                s = s.replace(/\\u0000CODE(\\d+)\\u0000/g, (_, n) => codeSpans[+n]);
                return s;
            };

            const flushParagraph = (buf) => {
                if (buf.length === 0) return;
                out.push('<p>' + renderInline(buf.join(' ')) + '</p>');
                buf.length = 0;
            };

            const paraBuf = [];

            while (i < lines.length) {
                const line = lines[i];

                // Fenced code block
                const fence = line.match(/^\\s*\`\`\`(\\w+)?\\s*$/);
                if (fence) {
                    flushParagraph(paraBuf);
                    const lang = fence[1] || '';
                    const codeLines = [];
                    i++;
                    while (i < lines.length && !/^\\s*\`\`\`\\s*$/.test(lines[i])) {
                        codeLines.push(lines[i]);
                        i++;
                    }
                    if (i < lines.length) i++; // skip closing fence
                    const cls = lang ? ' class="language-' + escapeAttr(lang) + '"' : '';
                    out.push('<pre><code' + cls + '>' + escapeHtml(codeLines.join('\\n')) + '</code></pre>');
                    continue;
                }

                // ATX heading
                const heading = line.match(/^(#{1,6})\\s+(.+?)\\s*#*\\s*$/);
                if (heading) {
                    flushParagraph(paraBuf);
                    const level = heading[1].length;
                    out.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>');
                    i++;
                    continue;
                }

                // Horizontal rule
                if (/^\\s*(?:-{3,}|\\*{3,}|_{3,})\\s*$/.test(line)) {
                    flushParagraph(paraBuf);
                    out.push('<hr>');
                    i++;
                    continue;
                }

                // Blockquote
                if (/^\\s*>\\s?/.test(line)) {
                    flushParagraph(paraBuf);
                    const quote = [];
                    while (i < lines.length && /^\\s*>\\s?/.test(lines[i])) {
                        quote.push(lines[i].replace(/^\\s*>\\s?/, ''));
                        i++;
                    }
                    out.push('<blockquote>' + renderInline(quote.join(' ')) + '</blockquote>');
                    continue;
                }

                // Table — needs at least header + separator line
                if (line.includes('|') && i + 1 < lines.length && /^\\s*\\|?\\s*[:\\-\\s|]+\\s*\\|?\\s*$/.test(lines[i + 1])) {
                    flushParagraph(paraBuf);
                    const header = splitTableRow(line);
                    i += 2;
                    const rows = [];
                    while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
                        rows.push(splitTableRow(lines[i]));
                        i++;
                    }
                    let tbl = '<table><thead><tr>' + header.map(c => '<th>' + renderInline(c) + '</th>').join('') + '</tr></thead><tbody>';
                    for (const r of rows) {
                        tbl += '<tr>' + r.map(c => '<td>' + renderInline(c) + '</td>').join('') + '</tr>';
                    }
                    tbl += '</tbody></table>';
                    out.push(tbl);
                    continue;
                }

                // Unordered list
                if (/^\\s*[-*+]\\s+/.test(line)) {
                    flushParagraph(paraBuf);
                    const items = [];
                    while (i < lines.length && /^\\s*[-*+]\\s+/.test(lines[i])) {
                        items.push(lines[i].replace(/^\\s*[-*+]\\s+/, ''));
                        i++;
                    }
                    out.push('<ul>' + items.map(it => '<li>' + renderInline(it) + '</li>').join('') + '</ul>');
                    continue;
                }

                // Ordered list
                if (/^\\s*\\d+[.)]\\s+/.test(line)) {
                    flushParagraph(paraBuf);
                    const items = [];
                    while (i < lines.length && /^\\s*\\d+[.)]\\s+/.test(lines[i])) {
                        items.push(lines[i].replace(/^\\s*\\d+[.)]\\s+/, ''));
                        i++;
                    }
                    out.push('<ol>' + items.map(it => '<li>' + renderInline(it) + '</li>').join('') + '</ol>');
                    continue;
                }

                // Blank line — paragraph boundary
                if (line.trim() === '') {
                    flushParagraph(paraBuf);
                    i++;
                    continue;
                }

                // Default: paragraph line
                paraBuf.push(line);
                i++;
            }
            flushParagraph(paraBuf);
            return out.join('\\n');
        }

        function splitTableRow(line) {
            return line
                .replace(/^\\s*\\|/, '')
                .replace(/\\|\\s*$/, '')
                .split('|')
                .map(c => c.trim());
        }

        // ============================================================
        // Settings tab — single source of truth: formState
        //
        // Architecture:
        //   - settingsState.data       = read-only mirror of server state
        //                                (llm.active, llm.file, embeddings, …)
        //   - settingsState.form       = THE truth for what the form shows.
        //                                Every input/checkbox/radio reflects
        //                                exactly one form field.
        //   - render() builds DOM from form. Always full re-render.
        //   - User events update form, then call render(). Period.
        //   - Save/Test send form to server. On success the form is *kept*
        //     (the user's intent wins); only data is refreshed.
        // ============================================================
        let settingsState = {
            data: null,           // server state: { embeddings, llm, projectPath, ... }
            form: null,           // form state (see makeFormFromData)
            loading: false,
            saving: false,
            testing: false,
            testPending: false,
            feedback: null,
        };
        let settingsRequestId = 0;

        function renderSettingsTab() {
            const detail = document.getElementById('detail');
            detail.innerHTML = '<div class="settings-page" id="settingsPage"><div class="loading">Loading settings…</div></div>';
            settingsState.form = null;
            loadSettings();
        }

        function loadSettings() {
            settingsState.loading = true;
            settingsRequestId++;
            ws.send(JSON.stringify({ type: 'getSettings', requestId: settingsRequestId }));
        }

        function handleSettings(msg) {
            if (msg.requestId !== settingsRequestId) return;
            settingsState.loading = false;
            if (msg.error) {
                document.getElementById('settingsPage').innerHTML =
                    '<div class="settings-feedback error">Failed to load settings: ' + escapeHtml(msg.error) + '</div>';
                return;
            }
            settingsState.data = msg.data;
            // Build initial form state from server data — only on first load,
            // or after a hard reload of the tab.
            settingsState.form = makeFormFromData(msg.data);
            render();
        }

        function handleSettingsSaved(msg) {
            settingsState.saving = false;
            if (msg.data) settingsState.data = msg.data;
            const success = !!(msg.result && msg.result.success);

            // Test queued? Don't toast — fire the test, let it deliver its toast.
            if (settingsState.testPending) {
                settingsState.testPending = false;
                if (!success) {
                    settingsState.testing = false;
                    settingsState.feedback = { kind: 'error', text: 'Save failed before test: ' + (msg.result && msg.result.error || 'unknown') };
                    render();
                    return;
                }
                settingsRequestId++;
                ws.send(JSON.stringify({ type: 'testLlmConnection', requestId: settingsRequestId }));
                render();
                return;
            }

            if (success) {
                let txt = '✓ Settings saved.';
                if (msg.result.indexed) {
                    txt += ' Indexed ' + msg.result.indexed.embedded + ' new vectors in ' +
                        Math.round(msg.result.indexed.durationMs / 100) / 10 + 's.';
                }
                settingsState.feedback = { kind: 'success', text: txt };
            } else {
                settingsState.feedback = { kind: 'error', text: 'Save failed: ' + (msg.result && msg.result.error || 'unknown') };
            }
            // After save: clear the API-key input so the masked stored-key state
            // becomes visible (form.apiKeyInput is the user's *pending* input).
            if (success && settingsState.form) {
                settingsState.form.apiKeyInput = '';
            }
            render();
            setTimeout(() => {
                settingsState.feedback = null;
                if (currentDetailTab === 'settings') render();
            }, 6000);
        }

        function handleLlmTestResult(msg) {
            settingsState.testing = false;
            const r = msg.data || {};
            settingsState.feedback = r.ok
                ? { kind: 'success', text: '✓ Connected to ' + (r.backend || '?') + ' / ' + (r.model || '?') + ' — ' + (r.latencyMs || 0) + ' ms' }
                : { kind: 'error', text: '✗ Test failed: ' + (r.error || 'unknown error') };
            render();
        }

        // Build form state from a fresh server snapshot.
        function makeFormFromData(data) {
            const llm = data.llm;
            // Pick the backend the form should preselect: active wins, else
            // first provider that needs a key.
            const backend = (llm.active && llm.active.backend) || 'openai';
            const provider = llm.providers.find(p => p.backend === backend) || llm.providers[0];
            return {
                backend: backend,
                endpoint: (llm.active && llm.active.endpoint) || (llm.file.endpoint || provider.defaultEndpoint),
                model: (llm.active && llm.active.model) || (llm.file.model || ''),
                apiKeyInput: '',          // user's pending input
                apiKeyVisible: false,     // toggle for show/hide button
                sendCode: !!llm.sendCode,
                llmEnabled: !!llm.enabled,
                enableEmbeddings: !!data.embeddings.enabled,
                embeddingModel: data.embeddings.modelId || (data.embeddings.availableModels[0] && data.embeddings.availableModels[0].id) || 'jina-code',
                modelDropdownOpen: false, // custom dropdown state
            };
        }

        // ============================================================
        // Render — pure function of state, builds HTML in one pass
        // ============================================================
        function render() {
            const page = document.getElementById('settingsPage');
            if (!page || !settingsState.data || !settingsState.form) return;

            const data = settingsState.data;
            const form = settingsState.form;
            const llm = data.llm;
            const provider = llm.providers.find(p => p.backend === form.backend) || llm.providers[0];

            // ---- Update banner ----
            const updateBanner = (data.lastSeenVersion !== data.currentVersion)
                ? '<div class="settings-update-banner">' +
                  '<strong>🎉 Welcome to AiDex ' + escapeHtml(data.currentVersion) + '</strong><br>' +
                  'New: <strong>semantic search</strong> for your code, docs, tasks &amp; notes — and an optional <strong>LLM layer</strong> ' +
                  'that lets you ask questions in any language. Configure both below. ' +
                  'Your existing index keeps working as before.' +
                  '</div>'
                : '';

            // ---- Embeddings card ----
            const e = data.embeddings;
            const embStatus = e.enabled
                ? '<span class="settings-status ok">● Active · ' + e.totalEmbeddings + ' vectors · ' + (e.modelId || '?') + '</span>'
                : '<span class="settings-status off">○ Not enabled</span>';
            const embModelOpts = e.availableModels.map(m =>
                '<option value="' + escapeAttr(m.id) + '"' + (form.embeddingModel === m.id ? ' selected' : '') + '>' +
                escapeHtml(m.id) + ' — ' + escapeHtml(m.description.slice(0, 60)) + '</option>'
            ).join('');
            const cachedHint = e.modelCached
                ? '<span class="settings-status ok" style="margin-left:6px">model cached</span>'
                : '<span class="settings-status warn" style="margin-left:6px">first run downloads ~100 MB</span>';

            // ---- LLM status badge (uses data.llm.active, not form) ----
            const llmStatus = llm.active
                ? '<span class="settings-status ok">● ' + escapeHtml(llm.active.backend) + ' / ' +
                  escapeHtml(llm.active.model) + ' (' + escapeHtml(llm.active.source) + ')</span>'
                : '<span class="settings-status off">○ No backend configured (pure embeddings only)</span>';

            // ---- Provider radios ----
            const providerRadios = llm.providers.map(p => {
                const checked = form.backend === p.backend ? ' checked' : '';
                return '<div style="margin:4px 0;">' +
                    '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;color:var(--text-primary);">' +
                    '<input type="radio" name="provider" value="' + p.backend + '"' + checked + '>' +
                    '<span><strong>' + escapeHtml(p.label) + '</strong>' +
                    (p.needsKey ? '' : ' <span class="settings-status off">no key needed</span>') +
                    '<br><span style="color:var(--text-muted);font-size:0.85em;">Default endpoint: <code>' +
                    escapeHtml(p.defaultEndpoint) + '</code></span></span>' +
                    '</label></div>';
            }).join('');

            // ---- Model — custom dropdown (always shows ALL provider models) ----
            const modelOptions = provider.suggestedModels.map(m =>
                '<div class="combo-option" data-value="' + escapeAttr(m) + '">' + escapeHtml(m) + '</div>'
            ).join('');
            const modelPlaceholder = provider.suggestedModels[0] || 'model name';
            const dropdownOpenClass = form.modelDropdownOpen ? ' open' : '';

            // ---- API-key placeholder/hint — purely a function of form.backend + data.llm.file ----
            const apiKey = computeApiKeyHint(provider, llm.file);
            const keyDisabled = !provider.needsKey;
            const keyType = (form.apiKeyVisible && !keyDisabled) ? 'text' : 'password';

            page.innerHTML =
                updateBanner +
                '<h2>Settings</h2>' +
                '<div class="subtitle">Embeddings &amp; LLM configuration · ' + escapeHtml(data.projectPath) + '</div>' +

                // Embeddings card (also hosts the LLM-Layer master toggle, since
                // LLM is currently only useful in the embedding-search pipeline).
                '<div class="settings-section">' +
                  '<div class="settings-section-title">🧠 Embeddings ' + embStatus + '</div>' +
                  '<p class="settings-section-help">Semantic search across code, docs, tasks &amp; notes. Find what you mean, even without the exact identifier name.</p>' +
                  '<label class="settings-toggle">' +
                    '<input type="checkbox" id="embEnabled"' + (form.enableEmbeddings ? ' checked' : '') + '>' +
                    '<div>' +
                      '<span class="label-main">Enable embeddings for this project</span>' +
                      '<span class="label-help">Indexing takes ~30s per project. Adds ~10 MB to <code>~/.aidex/global.db</code>. ' + cachedHint + '</span>' +
                    '</div>' +
                  '</label>' +
                  (form.enableEmbeddings
                    ? '<div class="settings-row">' +
                        '<label for="embModel">Model</label>' +
                        '<select id="embModel">' + embModelOpts + '</select>' +
                      '</div>' +
                      // LLM-layer sub-toggle — only shown when embeddings are enabled.
                      '<label class="settings-toggle" style="margin-top:14px;padding-left:8px;border-left:2px solid var(--border);">' +
                        '<input type="checkbox" id="llmEnabled"' + (form.llmEnabled ? ' checked' : '') + '>' +
                        '<div>' +
                          '<span class="label-main">Enable LLM Layer (translation &amp; reranking)</span>' +
                          '<span class="label-help">Optional. Adds query translation (non-English queries), expansion, and result reranking. Needs an API key from one of the supported providers.</span>' +
                        '</div>' +
                      '</label>'
                    : '') +
                '</div>' +

                // LLM card — only when embeddings AND llm-layer toggle are on.
                ((form.enableEmbeddings && form.llmEnabled)
                  ? '<div class="settings-section">' +
                      '<div class="settings-section-title">🤖 LLM Layer ' + llmStatus + '</div>' +
                      '<p class="settings-section-help">Pick a provider, set the endpoint &amp; model, and provide an API key (literal or env-var name).</p>' +
                      '<div style="margin:12px 0;">' + providerRadios + '</div>' +
                      '<div class="settings-row">' +
                        '<label for="llmEndpoint">Endpoint</label>' +
                        '<input type="text" id="llmEndpoint" value="' + escapeAttr(form.endpoint) + '" placeholder="' + escapeAttr(provider.defaultEndpoint) + '">' +
                      '</div>' +
                      '<div class="settings-row">' +
                        '<label for="llmModel">Model</label>' +
                        '<div class="combo' + dropdownOpenClass + '" id="modelCombo">' +
                          '<input type="text" id="llmModel" autocomplete="off" value="' + escapeAttr(form.model) + '" placeholder="' + escapeAttr(modelPlaceholder) + '">' +
                          '<button type="button" class="combo-toggle" id="modelComboToggle" aria-label="Show all models">▾</button>' +
                          '<div class="combo-list">' + modelOptions + '</div>' +
                        '</div>' +
                      '</div>' +
                      '<div class="settings-row">' +
                        '<label for="llmKey">API Key</label>' +
                        '<input type="' + keyType + '" id="llmKey" value="' + escapeAttr(form.apiKeyInput) + '" placeholder="' + escapeAttr(apiKey.placeholder) + '"' + (keyDisabled ? ' disabled' : '') + '>' +
                        (keyDisabled ? '' : '<button type="button" class="settings-btn" id="toggleKeyVisible">' + (form.apiKeyVisible ? 'Hide' : 'Show') + '</button>') +
                      '</div>' +
                      '<div class="settings-info">' + apiKey.hint + ' 🔒 Stored in <code>~/.aidex/llm.json</code> (chmod 600). Never echoed back.</div>' +

                      // Privacy switch
                      '<label class="settings-toggle" style="margin-top:14px;">' +
                        '<input type="checkbox" id="llmSendCode"' + (form.sendCode ? ' checked' : '') + '>' +
                        '<div>' +
                          '<span class="label-main">Allow code snippets to be sent to the LLM</span>' +
                          '<span class="label-help"><strong>Default: OFF.</strong> When off, only your query and metadata (file paths, names) leave the box. When on, snippets of method bodies and doc sections are sent during reranking — better results, but only for non-confidential projects.</span>' +
                        '</div>' +
                      '</label>' +
                    '</div>'
                  : '') +

                // Actions
                '<div class="settings-actions">' +
                  '<button type="button" class="settings-btn primary" id="saveSettings"' + (settingsState.saving ? ' disabled' : '') + '>' +
                    (settingsState.saving ? 'Saving…' : 'Save settings') + '</button>' +
                  '<button type="button" class="settings-btn" id="testConn"' + (settingsState.testing ? ' disabled' : '') + '>' +
                    (settingsState.testing ? 'Testing…' : 'Test connection') + '</button>' +
                '</div>' +

                (settingsState.feedback
                    ? '<div class="settings-feedback ' + settingsState.feedback.kind + '">' + escapeHtml(settingsState.feedback.text) + '</div>'
                    : '');

            wireForm();
        }

        // Compute API-key placeholder + hint as a pure function of:
        //   - the *currently selected* provider (drives env-var convention)
        //   - what's stored in the file (literal key vs api_key_env)
        function computeApiKeyHint(provider, file) {
            if (!provider.needsKey) {
                return { placeholder: 'no key needed', hint: 'This provider runs locally and needs no API key.' };
            }
            if (file.keyTail) {
                return {
                    placeholder: 'sk-...' + file.keyTail + ' (stored)',
                    hint: 'Stored literal key in <code>~/.aidex/llm.json</code>. Type to replace, leave blank to keep.',
                };
            }
            if (file.keyEnvName) {
                return {
                    placeholder: file.keyEnvName + ' (env var, stored)',
                    hint: 'Reads the key from environment variable <code>' + escapeHtml(file.keyEnvName) + '</code> at runtime. Type to replace.',
                };
            }
            if (provider.envVarName) {
                return {
                    placeholder: provider.envVarName + ' (env var) — or paste a literal key',
                    hint: 'Set <code>' + escapeHtml(provider.envVarName) + '</code> in your environment, or type the var name / a literal key here.',
                };
            }
            return {
                placeholder: 'API key, or env var name',
                hint: 'Type a literal key (e.g. <code>sk-proj-...</code>) or just the name of an env var.',
            };
        }

        // ============================================================
        // Wire — attach event listeners. Each handler updates form, calls render().
        // ============================================================
        function wireForm() {
            const form = settingsState.form;

            // --- Embeddings ---
            // Toggling embeddings shows/hides the LLM sub-toggle and LLM panel,
            // so we need a full re-render.
            const embEnabledEl = document.getElementById('embEnabled');
            if (embEnabledEl) {
                embEnabledEl.addEventListener('change', () => {
                    form.enableEmbeddings = embEnabledEl.checked;
                    render();
                });
            }
            bindSelect('embModel', v => form.embeddingModel = v);

            // LLM master toggle (lives in the embeddings panel) — re-render to
            // show/hide the LLM section.
            const llmEnabledEl = document.getElementById('llmEnabled');
            if (llmEnabledEl) {
                llmEnabledEl.addEventListener('change', () => {
                    form.llmEnabled = llmEnabledEl.checked;
                    render();
                });
            }

            // --- Provider radio ---
            document.querySelectorAll('input[name="provider"]').forEach(r => {
                r.addEventListener('change', (ev) => {
                    const newBackend = ev.target.value;
                    const provider = settingsState.data.llm.providers.find(p => p.backend === newBackend);
                    if (!provider) return;
                    form.backend = newBackend;
                    // Switching provider always resets endpoint + model. Predictable.
                    form.endpoint = provider.defaultEndpoint;
                    form.model = '';
                    form.modelDropdownOpen = false;
                    render();
                });
            });

            // --- Endpoint / model / key inputs ---
            bindInput('llmEndpoint', v => form.endpoint = v);
            bindInput('llmModel', v => form.model = v);
            bindInput('llmKey', v => form.apiKeyInput = v);

            // --- Send-code privacy switch ---
            bindCheckbox('llmSendCode', v => form.sendCode = v);

            // --- Show/Hide API key ---
            const showBtn = document.getElementById('toggleKeyVisible');
            if (showBtn) {
                showBtn.addEventListener('click', () => {
                    form.apiKeyVisible = !form.apiKeyVisible;
                    render();
                });
            }

            // --- Custom model combobox ---
            const comboToggle = document.getElementById('modelComboToggle');
            if (comboToggle) {
                comboToggle.addEventListener('click', () => {
                    form.modelDropdownOpen = !form.modelDropdownOpen;
                    render();
                });
            }
            document.querySelectorAll('#modelCombo .combo-option').forEach(opt => {
                opt.addEventListener('mousedown', (ev) => {
                    ev.preventDefault(); // don't lose focus before we read data-value
                    form.model = opt.getAttribute('data-value') || '';
                    form.modelDropdownOpen = false;
                    render();
                });
            });
            // Click outside the combo closes it
            document.addEventListener('mousedown', (ev) => {
                if (!form.modelDropdownOpen) return;
                const combo = document.getElementById('modelCombo');
                if (combo && !combo.contains(ev.target)) {
                    form.modelDropdownOpen = false;
                    render();
                }
            }, { once: true });

            // --- Action buttons ---
            const saveBtn = document.getElementById('saveSettings');
            if (saveBtn) saveBtn.addEventListener('click', save);
            const testBtn = document.getElementById('testConn');
            if (testBtn) testBtn.addEventListener('click', testConnection);
        }

        function bindCheckbox(id, setter) {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', () => { setter(el.checked); /* no render — checkbox already reflects state */ });
        }
        function bindSelect(id, setter) {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', () => { setter(el.value); });
        }
        function bindInput(id, setter) {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('input', () => { setter(el.value); });
        }

        // ============================================================
        // Save / Test — both send the same payload built from form state
        // ============================================================
        function buildPayload() {
            const f = settingsState.form;
            const payload = {
                enableEmbeddings: f.enableEmbeddings,
                embeddingModel: f.embeddingModel,
                llmEnabled: f.llmEnabled,
                llmEndpoint: f.endpoint || null,
                llmModel: f.model || null,
                llmSendCode: f.sendCode,
            };
            if (f.apiKeyInput && f.apiKeyInput.trim()) payload.llmApiKey = f.apiKeyInput.trim();
            return payload;
        }

        function save() {
            if (settingsState.saving) return;
            settingsState.saving = true;
            settingsState.feedback = null;
            render();
            settingsRequestId++;
            ws.send(JSON.stringify({ type: 'setSettings', payload: buildPayload(), requestId: settingsRequestId }));
        }

        function testConnection() {
            if (settingsState.testing) return;
            settingsState.testing = true;
            settingsState.testPending = true;
            settingsState.feedback = null;
            render();
            settingsRequestId++;
            ws.send(JSON.stringify({ type: 'setSettings', payload: buildPayload(), requestId: settingsRequestId }));
            // handleSettingsSaved will fire testLlmConnection when testPending is set
        }

        function renderLogView() {
            const detail = document.getElementById('detail');
            logViewInitialized = true;

            // Build sources dropdown from entries
            const sources = [...new Set(logEntries.map(e => e.source))].sort();

            let html = '<div class="log-container">';
            html += '<h2>Log Hub</h2>';
            html += '<div class="log-toolbar">';
            html += '<button class="log-level-btn level-error active" data-level="error" onclick="toggleLogLevel(this)">Error</button>';
            html += '<button class="log-level-btn level-warn active" data-level="warn" onclick="toggleLogLevel(this)">Warn</button>';
            html += '<button class="log-level-btn level-info active" data-level="info" onclick="toggleLogLevel(this)">Info</button>';
            html += '<button class="log-level-btn level-success active" data-level="success" onclick="toggleLogLevel(this)">OK</button>';
            html += '<button class="log-level-btn level-debug active" data-level="debug" onclick="toggleLogLevel(this)">Debug</button>';
            html += '<select id="logSourceFilter" onchange="logFilterSource=this.value;filterLogEntries()">';
            html += '<option value="">All sources</option>';
            for (const s of sources) html += '<option value="' + escapeHtml(s) + '">' + escapeHtml(s) + '</option>';
            html += '</select>';
            html += '<input type="text" id="logTextFilter" placeholder="Search..." oninput="logFilterText=this.value;filterLogEntries()">';
            html += '<label class="log-auto-scroll"><input type="checkbox" ' + (logAutoScroll ? 'checked' : '') + ' onchange="logAutoScroll=this.checked"> Auto-scroll</label>';
            html += '<button class="log-clear-btn" onclick="clearLogs()" title="Clear all log entries">Clear</button>';
            html += '</div>';

            if (logEntries.length === 0) {
                html += '<div class="log-not-init"><p>No log entries received yet.</p>';
                html += '<p style="margin-top:12px">Start the Log Hub with <code>aidex_log init</code></p>';
                html += '<p style="margin-top:8px;font-size:0.85em">Then send logs via HTTP POST to <code>http://localhost:3335/log</code></p></div>';
            }

            html += '<div class="log-entries" id="logEntries"></div>';
            html += '</div>';

            detail.innerHTML = html;
            filterLogEntries();
        }

        const logActivelevels = new Set(['error', 'warn', 'info', 'debug']);

        function toggleLogLevel(btn) {
            const level = btn.dataset.level;
            if (logActivelevels.has(level)) {
                logActivelevels.delete(level);
                btn.classList.remove('active');
            } else {
                logActivelevels.add(level);
                btn.classList.add('active');
            }
            filterLogEntries();
        }

        function filterLogEntries() {
            const container = document.getElementById('logEntries');
            if (!container) return;
            container.innerHTML = '';

            const textLower = logFilterText.toLowerCase();
            for (const e of logEntries) {
                if (!logActivelevels.has(e.level)) continue;
                if (logFilterSource && e.source !== logFilterSource) continue;
                if (textLower && !e.message.toLowerCase().includes(textLower)) continue;
                container.innerHTML += formatLogEntry(e);
            }

            if (logAutoScroll) container.scrollTop = container.scrollHeight;
        }

        function appendLogEntryToDOM(entry) {
            const container = document.getElementById('logEntries');
            if (!container) return;

            const textLower = logFilterText.toLowerCase();
            if (!logActivelevels.has(entry.level)) return;
            if (logFilterSource && entry.source !== logFilterSource) return;
            if (textLower && !entry.message.toLowerCase().includes(textLower)) return;

            // Update sources dropdown if new source
            const select = document.getElementById('logSourceFilter');
            if (select) {
                const exists = Array.from(select.options).some(o => o.value === entry.source);
                if (!exists && entry.source) {
                    const opt = document.createElement('option');
                    opt.value = entry.source;
                    opt.textContent = entry.source;
                    select.appendChild(opt);
                }
            }

            container.innerHTML += formatLogEntry(entry);
            if (logAutoScroll) container.scrollTop = container.scrollHeight;
        }

        function clearLogs() {
            logEntries = [];
            const container = document.getElementById('logEntries');
            if (container) container.innerHTML = '';
        }

        // Color prefix: optional {color} at start of message, e.g. "{green}text" or "{#ff0}text"
        // Also supports {bold}, {italic}, and combinations: "{green,bold}text"
        const colorNames = { red:'var(--accent-red)', green:'var(--accent-green)', orange:'var(--accent-orange)',
            yellow:'var(--accent-yellow)', cyan:'var(--accent-cyan)', purple:'var(--accent-purple)',
            blue:'var(--accent)', white:'var(--text-primary)', muted:'var(--text-muted)' };

        function parseColorPrefix(msg) {
            const m = msg.match(/^\{([^}]+)\}/);
            if (!m) return { msg, style: '' };
            const parts = m[1].split(',').map(s => s.trim());
            let style = '';
            for (const p of parts) {
                if (colorNames[p]) style += 'color:' + colorNames[p] + ';';
                else if (p.startsWith('#')) style += 'color:' + p + ';';
                else if (p === 'bold') style += 'font-weight:bold;';
                else if (p === 'italic') style += 'font-style:italic;';
            }
            return { msg: msg.slice(m[0].length), style };
        }

        function formatLogEntry(e) {
            const time = new Date(e.timestamp).toISOString().slice(11, 23);
            const icon = logLevelIcon[e.level] || '';
            const data = (e.data && e.data !== 'null') ? ' <span class="log-data">' + escapeHtml(e.data) + '</span>' : '';
            const parsed = parseColorPrefix(e.message);
            const msgStyle = parsed.style ? ' style="' + parsed.style + '"' : '';
            return '<div class="log-entry-line level-' + e.level + '">'
                + '<span class="log-time">' + time + '</span>'
                + '<span class="log-level">' + icon + '</span>'
                + '<span class="log-src" title="' + escapeHtml(e.source) + '">' + escapeHtml(e.source) + '</span>'
                + '<span class="log-msg"' + msgStyle + '>' + escapeHtml(parsed.msg) + data + '</span>'
                + '</div>';
        }

        // Splitter functionality
        const splitter = document.getElementById('splitter');
        const treePanel = document.getElementById('treePanel');
        let isDragging = false;

        splitter.addEventListener('mousedown', (e) => {
            isDragging = true;
            splitter.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const containerRect = document.querySelector('.container').getBoundingClientRect();
            const newWidth = e.clientX - containerRect.left;
            if (newWidth >= 200 && newWidth <= 800) {
                treePanel.style.width = newWidth + 'px';
            }
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                splitter.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        });
    </script>
</body>
</html>`;
}
