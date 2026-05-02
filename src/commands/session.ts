/**
 * session command - Session tracking and external change detection
 *
 * Tracks session start/end times and detects files changed outside of sessions.
 * This enables:
 * - "What did we do last session?" queries using time filtering
 * - Automatic detection of externally modified files that need re-indexing
 */

import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { minimatch } from 'minimatch';
import { createQueries } from '../db/index.js';
import { openDatabase } from '../db/index.js';
import { update } from './update.js';
import { DEFAULT_EXCLUDE, readGitignore, shortHash } from './init.js';
import { validateIndex, noIndexError, withProjectDb } from './shared.js';
import { PRODUCT_VERSION } from '../constants.js';
import { checkScheduledTasks, type SchedulerResult } from './global/global-scheduler.js';

// ============================================================
// Types
// ============================================================

export interface SessionParams {
    path: string;
}

export interface SessionInfo {
    lastSessionStart: number | null;
    lastSessionEnd: number | null;
    currentSessionStart: number | null;
}

export interface ChangedFile {
    path: string;
    reason: 'modified' | 'deleted' | 'new';
}

export interface UpdateInfo {
    previousVersion: string;
    currentVersion: string;
    highlights: string[];
}

export interface EmbeddingsSessionStatus {
    enabled: boolean;
    modelId: string | null;
    totalEmbeddings: number;
    filesChangedSince: number;
    lastFullEmbedAt: number | null;
    /** "stale", "drifting", "fresh", null when not enabled */
    health: 'stale' | 'drifting' | 'fresh' | null;
    /** Suggestion text shown to the user/AI ("consider re-indexing", etc.) */
    hint: string | null;
    /** Welcome banner for the first session after install/update (null otherwise). */
    updateBanner: string | null;
}

export interface SessionResult {
    success: boolean;
    isNewSession: boolean;
    sessionInfo: SessionInfo;
    externalChanges: ChangedFile[];
    reindexed: string[];
    note: string | null;
    updateInfo: UpdateInfo | null;
    schedulerResult: SchedulerResult | null;
    embeddings?: EmbeddingsSessionStatus;
    error?: string;
}

// ============================================================
// Constants
// ============================================================

const KEY_LAST_SESSION_START = 'last_session_start';
const KEY_LAST_SESSION_END = 'last_session_end';
const KEY_CURRENT_SESSION_START = 'current_session_start';
const KEY_SESSION_NOTE = 'session_note';
const KEY_LAST_SEEN_VERSION = 'last_seen_version';

// Session is considered "new" if more than 5 minutes have passed since last activity
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

// ============================================================
// Release Notes (update with each release)
// ============================================================

const RELEASE_HIGHLIGHTS: string[] = [
    'New tool: aidex_global_guideline — store AI guidelines and coding conventions in global.db',
    'Security fixes: command injection, SQL injection, WebSocket validation, path whitelisting',
    'Viewer fixes: N+1 queries eliminated, race condition fixed, 1 MB file size limit added',
    'Refactored: hasTool/runPowerShell/normalizePath/escapeLikeTerm centralized — no more duplicates',
    'AI strategy: tool description guides assistants to start aggressive, retry if unreadable, remember per app',
];

// ============================================================
// Implementation
// ============================================================

/**
 * Start or continue a session.
 * - If new session: detect external changes, store previous session times
 * - Always: update session_end timestamp
 */
export function session(params: SessionParams): SessionResult {
    const { path: projectPath } = params;

    return withProjectDb<SessionResult>(
        projectPath, false,
        (error) => ({ success: false, isNewSession: false, sessionInfo: { lastSessionStart: null, lastSessionEnd: null, currentSessionStart: null }, externalChanges: [], reindexed: [], note: null, updateInfo: null, schedulerResult: null, error }),
        (db, queries) => {
            try {
                const now = Date.now();

                // Get current session info
                const currentStart = db.getMetadata(KEY_CURRENT_SESSION_START);
                const lastEnd = db.getMetadata(KEY_LAST_SESSION_END);

                // Determine if this is a new session
                const lastActivity = lastEnd ? parseInt(lastEnd, 10) : (currentStart ? parseInt(currentStart, 10) : 0);
                const isNewSession = !currentStart || (now - lastActivity > SESSION_TIMEOUT_MS);

                let sessionInfo: SessionInfo;
                let externalChanges: ChangedFile[] = [];
                let reindexed: string[] = [];

                if (isNewSession) {
                    // Archive previous session times
                    if (currentStart) {
                        db.setMetadata(KEY_LAST_SESSION_START, currentStart);
                    }
                    if (lastEnd) {
                        // Use the last recorded end time as last_session_end
                    } else if (currentStart) {
                        db.setMetadata(KEY_LAST_SESSION_END, currentStart);
                    }

                    // Start new session
                    db.setMetadata(KEY_CURRENT_SESSION_START, now.toString());

                    // Detect external changes
                    externalChanges = detectExternalChanges(projectPath, queries);

                    // Auto-reindex modified files
                    for (const change of externalChanges) {
                        if (change.reason === 'modified') {
                            const result = update({ path: projectPath, file: change.path });
                            if (result.success) {
                                reindexed.push(change.path);
                            }
                        }
                    }

                    sessionInfo = {
                        lastSessionStart: currentStart ? parseInt(currentStart, 10) : null,
                        lastSessionEnd: lastEnd ? parseInt(lastEnd, 10) : null,
                        currentSessionStart: now,
                    };
                } else {
                    // Continue existing session
                    const lastStart = db.getMetadata(KEY_LAST_SESSION_START);
                    const lastEndVal = db.getMetadata(KEY_LAST_SESSION_END);
                    sessionInfo = {
                        lastSessionStart: lastStart ? parseInt(lastStart, 10) : null,
                        lastSessionEnd: lastEndVal ? parseInt(lastEndVal, 10) : null,
                        currentSessionStart: parseInt(currentStart!, 10),
                    };
                }

                // Always update session end time (heartbeat)
                db.setMetadata(KEY_LAST_SESSION_END, now.toString());

                // Get session note
                const note = db.getMetadata(KEY_SESSION_NOTE);

                // Check for version update
                let updateInfo: UpdateInfo | null = null;
                const lastSeenVersion = db.getMetadata(KEY_LAST_SEEN_VERSION);
                if (lastSeenVersion !== PRODUCT_VERSION) {
                    if (lastSeenVersion) {
                        updateInfo = {
                            previousVersion: lastSeenVersion,
                            currentVersion: PRODUCT_VERSION,
                            highlights: RELEASE_HIGHLIGHTS,
                        };
                    }
                    db.setMetadata(KEY_LAST_SEEN_VERSION, PRODUCT_VERSION);
                }

                // Check global scheduled tasks
                let schedulerResult: SchedulerResult | null = null;
                try {
                    schedulerResult = checkScheduledTasks();
                } catch {
                    // Don't let scheduler errors break session
                }

                return {
                    success: true,
                    isNewSession,
                    sessionInfo,
                    externalChanges,
                    reindexed,
                    note,
                    updateInfo,
                    schedulerResult,
                    embeddings: probeEmbeddingsStatus(projectPath),
                };

            } catch (error) {
                return {
                    success: false,
                    isNewSession: false,
                    sessionInfo: { lastSessionStart: null, lastSessionEnd: null, currentSessionStart: null },
                    externalChanges: [],
                    reindexed: [],
                    note: null,
                    updateInfo: null,
                    schedulerResult: null,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        }
    );
}

/**
 * Update session heartbeat (call periodically during session)
 */
export function updateSessionHeartbeat(projectPath: string): void {
    const dbPath = validateIndex(projectPath);
    if (!dbPath) return;

    try {
        const db = openDatabase(dbPath, false);
        try {
            db.setMetadata(KEY_LAST_SESSION_END, Date.now().toString());
        } finally {
            db.close();
        }
    } catch {
        // Silently ignore errors
    }
}

/**
 * Get session info without starting/updating
 */
export function getSessionInfo(projectPath: string): SessionInfo | null {
    const dbPath = validateIndex(projectPath);
    if (!dbPath) return null;

    try {
        const db = openDatabase(dbPath, true);
        try {
            const lastStart = db.getMetadata(KEY_LAST_SESSION_START);
            const lastEnd = db.getMetadata(KEY_LAST_SESSION_END);
            const currStart = db.getMetadata(KEY_CURRENT_SESSION_START);
            return {
                lastSessionStart: lastStart ? parseInt(lastStart, 10) : null,
                lastSessionEnd: lastEnd ? parseInt(lastEnd, 10) : null,
                currentSessionStart: currStart ? parseInt(currStart, 10) : null,
            };
        } finally {
            db.close();
        }
    } catch {
        return null;
    }
}

// ============================================================
// Helper functions
// ============================================================

/**
 * Detect files that were changed outside of the session.
 * Also cleans up excluded files (e.g. build/) that shouldn't be in the index.
 */
function detectExternalChanges(projectPath: string, queries: ReturnType<typeof createQueries>): ChangedFile[] {
    const changes: ChangedFile[] = [];
    const projectRoot = resolve(projectPath);

    // Build exclude patterns (same logic as init/update)
    const gitignorePatterns = readGitignore(projectPath);
    const excludePatterns = [...DEFAULT_EXCLUDE, ...gitignorePatterns];

    // Get all indexed files
    const indexedFiles = queries.getAllFiles();

    for (const file of indexedFiles) {
        // Skip excluded files - remove them from index silently
        const isExcluded = excludePatterns.some(pattern =>
            minimatch(file.path, pattern, { dot: true })
        );
        if (isExcluded) {
            queries.clearFileData(file.id);
            queries.deleteFile(file.id);
            continue;
        }

        const fullPath = join(projectRoot, file.path);

        if (!existsSync(fullPath)) {
            // File was deleted
            changes.push({ path: file.path, reason: 'deleted' });
            continue;
        }

        // Check if file hash changed
        try {
            const content = readFileSync(fullPath);
            const currentHash = shortHash(content);

            if (currentHash !== file.hash) {
                changes.push({ path: file.path, reason: 'modified' });
            }
        } catch {
            // Can't read file - skip
        }
    }

    // Cleanup orphaned items after removing excluded files
    queries.deleteUnusedItems();

    return changes;
}

/**
 * Format session time for display
 */
export function formatSessionTime(timestamp: number | null): string {
    if (!timestamp) return 'N/A';
    return new Date(timestamp).toISOString();
}

/**
 * Format duration between two timestamps
 */
export function formatDuration(startMs: number, endMs: number): string {
    const durationMs = endMs - startMs;
    const minutes = Math.floor(durationMs / 60000);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
    }
    return `${minutes}m`;
}

/**
 * Read embeddings status synchronously from global.db without touching the
 * model. Returns a stub-like result if embeddings aren't enabled or the DB
 * isn't there. We talk to global.db directly here to avoid pulling the async
 * embeddings module into the synchronous session path.
 */
function probeEmbeddingsStatus(projectPath: string): EmbeddingsSessionStatus {
    const updateBanner = computeUpdateBanner();
    const stub: EmbeddingsSessionStatus = {
        enabled: false,
        modelId: null,
        totalEmbeddings: 0,
        filesChangedSince: 0,
        lastFullEmbedAt: null,
        health: null,
        hint: null,
        updateBanner,
    };

    try {
        // Lazy synchronous probe — uses better-sqlite3 directly to stay off the
        // async embeddings module's hot path. Errors silently fall through to stub.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Database = require('better-sqlite3') as new (path: string, opts?: { readonly?: boolean }) => {
            prepare(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown };
            close(): void;
        };
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const path = require('path') as typeof import('path');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const os = require('os') as typeof import('os');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs') as typeof import('fs');

        const globalDbPath = path.join(os.homedir(), '.aidex', 'global.db');
        if (!fs.existsSync(globalDbPath)) return stub;

        const db = new Database(globalDbPath, { readonly: true });
        try {
            const cols = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
            const have = new Set(cols.map(c => c.name));
            if (!have.has('embedding_model_id')) return stub; // pre-embeddings DB

            const proj = db.prepare(
                `SELECT id, embedding_model_id, last_full_embed_at, files_changed_since
                 FROM projects WHERE path = ?`
            ).get(projectPath) as
                | { id: number; embedding_model_id: string | null; last_full_embed_at: number | null; files_changed_since: number | null }
                | undefined;
            if (!proj || !proj.embedding_model_id) return stub;

            const count = (db.prepare(
                'SELECT COUNT(*) as n FROM embeddings WHERE project_id = ?'
            ).get(proj.id) as { n: number }).n;

            const filesChanged = proj.files_changed_since ?? 0;
            const lastFull = proj.last_full_embed_at;
            const ageDays = lastFull ? (Date.now() - lastFull) / (1000 * 60 * 60 * 24) : Infinity;

            let health: 'stale' | 'drifting' | 'fresh';
            let hint: string | null = null;
            if (ageDays > 30 || filesChanged > 50) {
                health = 'stale';
                hint = `Embeddings index hasn't been refreshed in ${formatAge(ageDays)}` +
                    (filesChanged > 0 ? ` and ${filesChanged} files changed since.` : '.') +
                    ' Consider running aidex_init({ embeddings: true }) again.';
            } else if (filesChanged > 10) {
                health = 'drifting';
                hint = `${filesChanged} files have changed since the last full embed — incremental updates have kept up, but a fresh re-index would tighten things.`;
            } else {
                health = 'fresh';
            }

            return {
                enabled: true,
                modelId: proj.embedding_model_id,
                totalEmbeddings: count,
                filesChangedSince: filesChanged,
                lastFullEmbedAt: lastFull,
                health,
                hint,
                updateBanner,
            };
        } finally {
            db.close();
        }
    } catch {
        return stub;
    }
}

function formatAge(days: number): string {
    if (!isFinite(days)) return 'a long time';
    if (days < 1) return 'less than a day';
    if (days < 14) return `${Math.round(days)} days`;
    if (days < 60) return `${Math.round(days / 7)} weeks`;
    return `${Math.round(days / 30)} months`;
}

/**
 * Show an update / welcome banner the first time a session runs after a
 * version bump. The banner is shown once per version: as soon as the user
 * opens Settings (or otherwise calls aidex_settings), the version is marked
 * as seen and the banner stops appearing.
 */
function computeUpdateBanner(): string | null {
    try {
        const Database = require('better-sqlite3') as new (path: string, opts?: { readonly?: boolean }) => {
            prepare(sql: string): { get(...args: unknown[]): unknown };
            close(): void;
        };
        const path = require('path') as typeof import('path');
        const os = require('os') as typeof import('os');
        const fs = require('fs') as typeof import('fs');

        const dbPath = path.join(os.homedir(), '.aidex', 'global.db');
        if (!fs.existsSync(dbPath)) return null;
        const db = new Database(dbPath, { readonly: true });
        try {
            const seenRow = db
                .prepare('SELECT value FROM metadata WHERE key = ?')
                .get('last_seen_version') as { value: string } | undefined;
            const seen = seenRow?.value ?? null;
            const current = readPkgVersion();
            if (!current) return null;
            if (seen === current) return null;
            return (
                `🎉 AiDex ${current} — new features available! ` +
                `Semantic search across code, docs & tasks, plus an optional LLM layer ` +
                `for multilingual queries. ` +
                `Open the Settings tab in the viewer to enable: aidex_settings({ path: "...", open: true }).`
            );
        } finally {
            db.close();
        }
    } catch {
        return null;
    }
}

function readPkgVersion(): string | null {
    return PRODUCT_VERSION || null;
}
