/**
 * Log Hub HTTP Server (Singleton)
 *
 * Receives log entries from external programs via HTTP POST.
 * Lazy start — no resources until init() is called.
 *
 * Pattern: Same as progress.ts (module-level singleton).
 */

import express from 'express';
import { createServer, type Server } from 'http';
import { join, isAbsolute, dirname } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import BetterSqlite3 from 'better-sqlite3';
import { LogBuffer } from './log-buffer.js';
import { PanelStore } from './panel-store.js';
import { ControlStore } from './control-store.js';
import { broadcastLogEntry, broadcastPanelUpdate, broadcastPanelClear } from '../viewer/server.js';
import type { LogEntry, LogLevel, LogConfig, LogStats, LogHttpEntry } from './log-types.js';
import { CONTROL_TYPES, BUTTON_COUNTER_MAX, type PanelHttpEntry, type WidgetType } from './panel-types.js';

const VALID_LEVELS = new Set<string>(['debug', 'info', 'warn', 'error']);
const BODY_LIMIT = '64kb';
const VIEWER_PORT = 3333;
const BIND_HOST = '0.0.0.0';

// Blob assembly: external programs (e.g. an ESP32) stream a binary file to the
// hub as a sequence of base64 chunks under a name, then signal EOB to flush it
// to disk. Useful for pulling audio captures, screenshots, dumps off a device
// that has no other file transport. Chunks accumulate in RAM (per name); only
// on EOB is the whole thing decoded once and written binary. A name WITHOUT a
// path goes to BLOB_DEFAULT_DIR; an absolute/relative path is used as given.
const BLOB_DEFAULT_DIR = 'C:\\temp\\loghub';
const BLOB_MAX_BYTES = 64 * 1024 * 1024;   // 64 MB cap per blob (safety)
interface BlobInProgress { chunks: Buffer[]; bytes: number; }
const blobs = new Map<string, BlobInProgress>();

let logServer: Server | null = null;
let logBuffer: LogBuffer | null = null;
let logConfig: LogConfig | null = null;
let panelStore: PanelStore | null = null;
let controlStore: ControlStore | null = null;

// Optional DB persistence
let logDb: BetterSqlite3.Database | null = null;
let insertStmt: BetterSqlite3.Statement | null = null;

/**
 * Initialize the Log Hub — start HTTP server and create buffer
 */
export function initLogHub(config: LogConfig): Promise<string> {
    if (logServer) {
        return Promise.resolve(`Log Hub already running on port ${logConfig!.port}`);
    }

    logBuffer = new LogBuffer(config.bufferSize);
    logConfig = config;
    panelStore = new PanelStore();
    controlStore = new ControlStore();

    // Optional DB persistence
    if (config.persist && config.path) {
        setupPersistence(config.path);
    }

    const app = express();
    app.use(express.json({ limit: BODY_LIMIT }));

    // CORS — only allow localhost (Viewer + curl from same machine)
    const ALLOWED_ORIGINS = new Set([
        `http://localhost:${VIEWER_PORT}`,
        `http://127.0.0.1:${VIEWER_PORT}`,
    ]);
    app.use((req, res, next) => {
        const origin = req.headers.origin;
        if (origin && ALLOWED_ORIGINS.has(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
        }
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') {
            res.status(204).end();
            return;
        }
        next();
    });

    // POST /log — single entry
    app.post('/log', (req, res) => {
        const body = req.body as LogHttpEntry;
        const entry = ingestEntry(body);
        if (!entry) {
            res.status(400).json({ error: 'Invalid log entry. Required: level, source, message' });
            return;
        }
        res.status(201).json({ id: entry.id });
    });

    // POST /logs — batch
    app.post('/logs', (req, res) => {
        const bodies = req.body as LogHttpEntry[];
        if (!Array.isArray(bodies)) {
            res.status(400).json({ error: 'Expected array of log entries' });
            return;
        }
        const ids: number[] = [];
        for (const body of bodies) {
            const entry = ingestEntry(body);
            if (entry) ids.push(entry.id);
        }
        res.status(201).json({ count: ids.length, ids });
    });

    // POST /panel — create/update a single dashboard widget (overwrites by id).
    //   body: { id, type, value, group?, label?, unit?, min?, max?, warn?, crit?, color?, order? }
    app.post('/panel', (req, res) => {
        const widget = ingestPanel(req.body as PanelHttpEntry);
        if (!widget) {
            res.status(400).json({ error: 'Invalid panel widget. Required: id, and type (on first update)' });
            return;
        }
        res.status(201).json({ id: widget.id });
    });

    // POST /panels — batch widget updates.
    app.post('/panels', (req, res) => {
        const bodies = req.body as PanelHttpEntry[];
        if (!Array.isArray(bodies)) {
            res.status(400).json({ error: 'Expected array of panel widgets' });
            return;
        }
        const ids: string[] = [];
        for (const body of bodies) {
            const widget = ingestPanel(body);
            if (widget) ids.push(widget.id);
        }
        res.status(201).json({ count: ids.length, ids });
    });

    // POST /panel/clear — remove one widget ({ id }) or all (empty body).
    app.post('/panel/clear', (req, res) => {
        const body = (req.body ?? {}) as { id?: string };
        const id = typeof body.id === 'string' ? body.id : undefined;
        if (panelStore) panelStore.clear(id);
        if (controlStore) controlStore.clear(id);   // controls live alongside widgets
        broadcastPanelClear(id);
        res.status(200).json({ cleared: id ?? 'all' });
    });

    // ── Control back-channel (interactive slider/number widgets) ─────────────
    // Generic, source-agnostic. The viewer POSTs here when the user changes a
    // control; sources GET the flat id→value map at their own pace. The store
    // knows nothing about what a value means — see control-store.ts.

    // POST /control — set one control's value. body: { id, value }.
    // Updates the store AND the widget's displayed value (so every connected
    // viewer reflects the change), then the owning source picks it up via GET.
    app.post('/control', (req, res) => {
        const body = (req.body ?? {}) as { id?: string; value?: number | string };
        if (!controlStore || typeof body.id !== 'string' || body.value === undefined) {
            res.status(400).json({ error: 'control requires { id, value }' });
            return;
        }
        // Same setter the MCP tool uses — store + widget mirror + broadcast.
        if (!setControl(body.id, body.value)) {
            res.status(400).json({ error: 'invalid control id or value' });
            return;
        }
        res.status(200).json({ id: body.id.trim(), value: body.value });
    });

    // POST /control/press — register ONE press of a button control. body: { id }.
    // Separate from POST /control on purpose: the caller says "it was pressed"
    // and the HUB owns the counter. If the viewer computed the next value
    // itself, two open dashboards would both send the same number and one press
    // would be lost.
    app.post('/control/press', (req, res) => {
        const body = (req.body ?? {}) as { id?: string };
        if (!controlStore || typeof body.id !== 'string' || !body.id.trim()) {
            res.status(400).json({ error: 'press requires { id }' });
            return;
        }
        const count = pressButton(body.id);
        if (count === null) {
            res.status(400).json({ error: 'unknown id, or widget is not a button' });
            return;
        }
        res.status(200).json({ id: body.id.trim(), value: count });
    });

    // GET /control — the whole store as a flat { id: value } object. This is
    // what a source (e.g. the ESP32) polls to learn the current set-points.
    // Button entries are press COUNTERS: compare against the last value you saw,
    // and treat any backwards jump as a restart rather than as presses.
    app.get('/control', (_req, res) => {
        res.status(200).json(controlStore ? controlStore.getAll() : {});
    });

    // POST /blob — assemble a binary file from base64 chunks.
    //   body: { name: string, data?: string (base64), eob?: boolean, reset?: boolean }
    //   - reset:true   → discard any existing buffer for `name` and start fresh
    //   - data         → append these decoded bytes to the buffer for `name`
    //   - eob:true     → write the assembled buffer to disk and clear it
    // A single POST may carry data AND eob (last chunk + flush in one go).
    app.post('/blob', (req, res) => {
        const body = req.body as { name?: string; data?: string; eob?: boolean; reset?: boolean };
        if (!body || typeof body.name !== 'string' || !body.name.trim()) {
            res.status(400).json({ error: 'blob requires a non-empty "name"' });
            return;
        }
        const name = body.name.trim();

        if (body.reset) blobs.delete(name);

        // Append a chunk if present.
        if (typeof body.data === 'string' && body.data.length > 0) {
            let buf: Buffer;
            try {
                buf = Buffer.from(body.data, 'base64');
            } catch {
                res.status(400).json({ error: 'data is not valid base64' });
                return;
            }
            let bip = blobs.get(name);
            if (!bip) { bip = { chunks: [], bytes: 0 }; blobs.set(name, bip); }
            if (bip.bytes + buf.length > BLOB_MAX_BYTES) {
                blobs.delete(name);
                res.status(413).json({ error: `blob "${name}" exceeded ${BLOB_MAX_BYTES} bytes — discarded` });
                return;
            }
            bip.chunks.push(buf);
            bip.bytes += buf.length;
        }

        // Flush to disk on EOB.
        if (body.eob) {
            const bip = blobs.get(name);
            if (!bip || bip.bytes === 0) {
                res.status(400).json({ error: `EOB for "${name}" but no data was received` });
                return;
            }
            const full = Buffer.concat(bip.chunks, bip.bytes);
            blobs.delete(name);

            // No path → default dir; otherwise honour the given (abs or rel) path.
            const hasPath = name.includes('/') || name.includes('\\');
            const outPath = hasPath
                ? (isAbsolute(name) ? name : join(process.cwd(), name))
                : join(BLOB_DEFAULT_DIR, name);
            try {
                const dir = dirname(outPath);
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                writeFileSync(outPath, full);
            } catch (err) {
                res.status(500).json({ error: `failed to write blob: ${(err as Error).message}` });
                return;
            }
            console.error(`[LogHub] blob "${name}" written: ${full.length} bytes → ${outPath}`);
            res.status(201).json({ name, bytes: full.length, path: outPath });
            return;
        }

        // Just an append (no flush yet).
        const bip = blobs.get(name);
        res.status(202).json({ name, buffered: bip ? bip.bytes : 0 });
    });

    // GET /health
    app.get('/health', (_req, res) => {
        const stats = logBuffer!.getStats();
        res.json({
            status: 'ok',
            entries: stats.entries,
            bufferUsage: stats.bufferUsage,
        });
    });

    return new Promise((resolve, reject) => {
        logServer = createServer(app);

        logServer.on('error', (err: NodeJS.ErrnoException) => {
            logServer = null;
            logBuffer = null;
            logConfig = null;
            if (err.code === 'EADDRINUSE') {
                reject(new Error(`Port ${config.port} is already in use`));
            } else {
                reject(err);
            }
        });

        logServer.listen(config.port, BIND_HOST, () => {
            console.error(`[LogHub] Server started on ${BIND_HOST}:${config.port} (buffer: ${config.bufferSize})`);
            resolve(`Log Hub started on port ${config.port} (buffer: ${config.bufferSize} entries)`);
        });
    });
}

/**
 * Stop the Log Hub — free all resources
 */
export function freeLogHub(): string {
    if (!logServer) {
        return 'Log Hub was not running';
    }

    logServer.close();
    logServer = null;

    if (logDb) {
        logDb.close();
        logDb = null;
        insertStmt = null;
    }

    const port = logConfig!.port;
    logBuffer = null;
    logConfig = null;
    panelStore = null;
    controlStore = null;

    console.error('[LogHub] Server stopped');
    return `Log Hub stopped (port ${port} freed)`;
}

/**
 * Check if Log Hub is running
 */
export function isLogHubRunning(): boolean {
    return logServer !== null;
}

/**
 * Get the buffer (for direct queries from MCP tool)
 */
export function getLogBuffer(): LogBuffer | null {
    return logBuffer;
}

/**
 * Get the panel store (for the viewer's snapshot-on-connect)
 */
export function getPanelStore(): PanelStore | null {
    return panelStore;
}

/**
 * Get the control store (for the viewer's snapshot-on-connect and MCP reads)
 */
export function getControlStore(): ControlStore | null {
    return controlStore;
}

/**
 * Set ONE control value — the single source of truth for changing a control.
 * BOTH entry points use it: the HTTP route (POST /control, driven by the
 * dashboard) and the MCP tool (aidex_log control_set, driven by the AI). It
 * updates the store, mirrors the value into the widget so every viewer's
 * slider/number reflects it, and broadcasts that widget. Returns false on a
 * bad id/value or when the hub isn't running.
 */
export function setControl(id: string, value: number | string): boolean {
    if (!controlStore) return false;
    if (!controlStore.set(id, value)) return false;
    // Mirror into the widget (value-only update; won't create one) so the
    // slider position and any other connected viewer stay in sync.
    const widget = panelStore?.upsert({ id, value });
    if (widget) broadcastPanelUpdate(widget);
    return true;
}

/**
 * Register ONE press of a button control: read the counter, add one, store it.
 *
 * Deliberately server-side rather than "the viewer sends the new count". Two
 * browsers can have the same dashboard open; if each computed the next value
 * from its own copy they would both send the same number and one press would
 * vanish. Here the hub owns the counter, so presses from any number of viewers
 * add up. Returns the new count, or null if the id isn't a known button.
 */
export function pressButton(id: string): number | null {
    if (!controlStore || !panelStore) return null;
    const widget = panelStore.get(id);
    if (!widget || widget.type !== 'button') return null;

    const prev = controlStore.get(id);
    const count = (typeof prev === 'number' && Number.isFinite(prev) ? prev : 0) + 1;
    // Wrap rather than grow forever. Sources are told to read any backwards
    // jump as "restart, adopt the value" — see BUTTON_COUNTER_MAX.
    const next = count > BUTTON_COUNTER_MAX ? 1 : count;

    if (!controlStore.set(id, next)) return null;
    const updated = panelStore.upsert({ id, value: next });
    if (updated) broadcastPanelUpdate(updated);
    return next;
}

/**
 * Read all control values as a flat { id: value } map (for the MCP tool).
 */
export function getControlValues(): Record<string, number | string> {
    return controlStore ? controlStore.getAll() : {};
}

/**
 * Get config (for status display)
 */
export function getLogConfig(): LogConfig | null {
    return logConfig;
}

/**
 * Write an entry from MCP (source: "claude")
 */
export function writeLogEntry(level: LogLevel, message: string, data?: string): LogEntry | null {
    if (!logBuffer) return null;
    const entry = logBuffer.push(level, 'claude', message, data);
    persistEntry(entry);
    broadcastLogEntry(entry);
    return entry;
}

/**
 * Get full stats including port and persist info
 */
export function getLogStats(): LogStats | null {
    if (!logBuffer || !logConfig) return null;
    const bufferStats = logBuffer.getStats();
    return {
        ...bufferStats,
        port: logConfig.port,
        persist: logConfig.persist,
    };
}

// ============================================================
// Internal
// ============================================================

function ingestEntry(body: LogHttpEntry): LogEntry | null {
    if (!body || !body.message) return null;

    const level = (body.level && VALID_LEVELS.has(body.level)) ? body.level as LogLevel : 'info';
    const source = body.source || 'unknown';
    const message = String(body.message);
    const data = body.data !== undefined ? JSON.stringify(body.data) : undefined;
    const timestamp = typeof body.timestamp === 'number' ? body.timestamp : undefined;

    const entry = logBuffer!.push(level, source, message, data, timestamp);
    persistEntry(entry);
    broadcastLogEntry(entry);
    return entry;
}

function ingestPanel(body: PanelHttpEntry) {
    if (!panelStore) return null;
    const widget = panelStore.upsert(body);
    if (!widget) return null;
    // When a source DEFINES an interactive control, seed the control store with
    // its starting value — but only if the store has no value for it yet. That
    // way a re-defining source (e.g. the ESP32 re-announcing its widgets after a
    // reboot) does NOT clobber a value the user already dialed in. For a button
    // that also means the press count SURVIVES the source rebooting.
    if (controlStore && CONTROL_TYPES.has(widget.type as WidgetType)
        && controlStore.get(widget.id) === undefined) {
        // A button is a counter and always starts at 0 — whatever the sender put
        // in `value` would be a meaningless press count.
        const seed = widget.type === 'button'
            ? 0
            : (typeof widget.value === 'number' ? widget.value : undefined);
        if (seed !== undefined) controlStore.set(widget.id, seed);
    }
    broadcastPanelUpdate(widget);
    return widget;
}

function persistEntry(entry: LogEntry): void {
    if (!insertStmt) return;
    try {
        insertStmt.run(
            entry.timestamp,
            entry.level,
            entry.source,
            entry.message,
            entry.data ?? null,
            entry.received_at,
        );
    } catch (err) {
        console.error('[LogHub] DB persist error:', err);
    }
}

function setupPersistence(projectPath: string): void {
    try {
        const dbDir = join(projectPath, '.aidex');
        if (!existsSync(dbDir)) {
            mkdirSync(dbDir, { recursive: true });
        }

        const dbPath = join(dbDir, 'logs.db');
        logDb = new BetterSqlite3(dbPath);
        logDb.pragma('journal_mode = WAL');

        logDb.exec(`
            CREATE TABLE IF NOT EXISTS logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp INTEGER NOT NULL,
                level TEXT NOT NULL,
                source TEXT NOT NULL,
                message TEXT NOT NULL,
                data TEXT,
                received_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
            CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
            CREATE INDEX IF NOT EXISTS idx_logs_source ON logs(source);
        `);

        // Auto-cleanup: entries > 7 days
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        logDb.prepare('DELETE FROM logs WHERE timestamp < ?').run(sevenDaysAgo);

        insertStmt = logDb.prepare(
            'INSERT INTO logs (timestamp, level, source, message, data, received_at) VALUES (?, ?, ?, ?, ?, ?)'
        );

        console.error('[LogHub] Persistence enabled:', dbPath);
    } catch (err) {
        console.error('[LogHub] Failed to setup persistence:', err);
        logDb = null;
        insertStmt = null;
    }
}
