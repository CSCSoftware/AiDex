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
import { broadcastLogEntry } from '../viewer/server.js';
import type { LogEntry, LogLevel, LogConfig, LogStats, LogHttpEntry } from './log-types.js';

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
