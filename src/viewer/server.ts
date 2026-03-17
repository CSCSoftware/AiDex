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
import { PRODUCT_NAME, INDEX_DIR } from '../constants.js';
import type Database from 'better-sqlite3';

const PORT = 3333;

let server: ReturnType<typeof createServer> | null = null;
let wss: WebSocketServer | null = null;
let fileWatcher: FSWatcher | null = null;
let viewerDbPath: string | null = null;
let viewerDb: ReturnType<typeof openDatabase> | null = null;

interface ViewerMessage {
    type: 'getTree' | 'getSignature' | 'getFileContent' | 'getTasks' | 'updateTaskStatus';
    mode?: 'code' | 'all';  // Tree mode
    path?: string;
    file?: string;
    taskId?: number;
    status?: string;
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

export async function startViewer(projectPath: string): Promise<string> {
    // Check if already running
    if (server) {
        return `Viewer already running at http://localhost:${PORT}`;
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
            '**/dist/**'
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
        if ((event === 'change' || event === 'add') && /\.(ts|tsx|js|jsx|cs|rs|py|c|cpp|h|hpp|java|go|php|rb)$/i.test(filePath)) {
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

    // Serve static HTML
    app.get('/', (req, res) => {
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
                    const content = getFileContent(projectRoot, msg.file);
                    ws.send(JSON.stringify({ type: 'fileContent', file: msg.file, data: content }));
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
        server!.listen(PORT, () => {
            const url = `http://localhost:${PORT}`;
            console.error(`[Viewer] Server running at ${url}`);

            // Open browser
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
        // Add summary column if missing (for existing DBs before v1.15)
        try {
            const hasSummary = db.prepare(
                "SELECT COUNT(*) as cnt FROM pragma_table_info('tasks') WHERE name = 'summary'"
            ).get() as { cnt: number };
            if (hasSummary.cnt === 0) {
                db.exec('ALTER TABLE tasks ADD COLUMN summary TEXT');
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
            </div>
            <div class="panel-content" id="detail">
                <div class="empty-state">
                    <p>Click on a file to view its signature</p>
                </div>
            </div>
        </div>
    </div>

    <script>
        const ws = new WebSocket('ws://localhost:${PORT}');
        let selectedNode = null;
        let currentFile = null;
        let currentTreeMode = 'code';
        let currentDetailTab = 'overview';
        let cachedSignature = null;
        let cachedContent = null;
        let cachedTasks = null;

        ws.onopen = () => {
            console.log('Connected to AiDex Viewer');
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
                cachedContent = { file: msg.file, data: msg.data };
                if (currentDetailTab === 'source') {
                    renderFileContent(msg.file, msg.data);
                }
            } else if (msg.type === 'tasks') {
                cachedTasks = msg.data;
                if (currentDetailTab === 'tasks') {
                    renderTasks(msg.data);
                }
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
                // Tasks tab works without file selection
                if (!currentFile && tab.dataset.tab !== 'tasks') return;

                document.querySelectorAll('.detail-panel .tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                currentDetailTab = tab.dataset.tab;

                if (currentDetailTab === 'overview') {
                    if (cachedSignature && cachedSignature.file === currentFile) {
                        renderSignature(cachedSignature.file, cachedSignature.data);
                    } else {
                        ws.send(JSON.stringify({ type: 'getSignature', file: currentFile }));
                    }
                } else if (currentDetailTab === 'source') {
                    if (cachedContent && cachedContent.file === currentFile) {
                        renderFileContent(cachedContent.file, cachedContent.data);
                    } else {
                        document.getElementById('detail').innerHTML = '<div class="loading">Loading source...</div>';
                        ws.send(JSON.stringify({ type: 'getFileContent', file: currentFile }));
                    }
                } else if (currentDetailTab === 'tasks') {
                    if (cachedTasks) {
                        renderTasks(cachedTasks);
                    } else {
                        document.getElementById('detail').innerHTML = '<div class="loading">Loading tasks...</div>';
                        ws.send(JSON.stringify({ type: 'getTasks' }));
                    }
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

        function renderFileContent(filePath, data) {
            const detail = document.getElementById('detail');

            if (data.error) {
                detail.innerHTML = '<div class="empty-state">' + data.error + '</div>';
                return;
            }

            let html = '<h2>' + filePath.split('/').pop() + '</h2>';
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
                html += '<div class="task-description">' + escapeHtml(t.description) + '</div>';
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
