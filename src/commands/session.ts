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

export interface SessionResult {
    success: boolean;
    isNewSession: boolean;
    sessionInfo: SessionInfo;
    externalChanges: ChangedFile[];
    reindexed: string[];
    note: string | null;
    updateInfo: UpdateInfo | null;
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

    return withProjectDb(
        projectPath, false,
        (error) => ({ success: false, isNewSession: false, sessionInfo: { lastSessionStart: null, lastSessionEnd: null, currentSessionStart: null }, externalChanges: [], reindexed: [], note: null, updateInfo: null, error }),
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

                return {
                    success: true,
                    isNewSession,
                    sessionInfo,
                    externalChanges,
                    reindexed,
                    note,
                    updateInfo,
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
