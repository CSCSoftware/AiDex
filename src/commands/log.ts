/**
 * log command - Universal Log Hub
 *
 * Receives logs from external programs via HTTP, queryable by LLM.
 * Zero-cost when not initialized — no server, no buffer, no resources.
 *
 * Pattern: Same as task.ts (action-based dispatch).
 */

import { initLogHub, freeLogHub, isLogHubRunning, getLogBuffer, getLogStats, writeLogEntry, getControlValues, setControl } from '../loghub/log-server.js';
import { parseTimeOffset } from './query.js';
import type { LogAction, LogLevel, LogParams, LogResult } from '../loghub/log-types.js';

export type { LogAction, LogLevel, LogParams, LogResult };

// ============================================================
// Implementation: aidex_log (action-based)
// ============================================================

export async function log(params: LogParams): Promise<LogResult> {
    const { action } = params;

    switch (action) {
        case 'init': {
            const port = params.port ?? 3335;
            const bufferSize = params.buffer_size ?? 10000;
            const persist = params.persist ?? false;
            const path = params.path;

            if (persist && !path) {
                return { success: false, action, error: 'path is required when persist is true' };
            }

            try {
                const message = await initLogHub({
                    port,
                    bufferSize,
                    persist,
                    path,
                });
                return {
                    success: true,
                    action,
                    stats: getLogStats() ?? undefined,
                };
            } catch (err) {
                return {
                    success: false,
                    action,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
        }

        case 'free': {
            const message = freeLogHub();
            return { success: true, action };
        }

        case 'status': {
            if (!isLogHubRunning()) {
                return { success: true, action, error: 'Log Hub not initialized' };
            }
            return {
                success: true,
                action,
                stats: getLogStats() ?? undefined,
            };
        }

        case 'query': {
            if (!isLogHubRunning()) {
                return { success: false, action, error: 'Log Hub not initialized. Run init first.' };
            }

            const buffer = getLogBuffer();
            if (!buffer) {
                return { success: false, action, error: 'Buffer not available' };
            }

            // Parse since parameter
            let sinceMs: number | undefined;
            if (params.since) {
                const offset = parseTimeOffset(params.since);
                if (offset) {
                    sinceMs = Date.now() - offset;
                } else {
                    // Try ISO date
                    const d = new Date(params.since);
                    if (!isNaN(d.getTime())) {
                        sinceMs = d.getTime();
                    }
                }
            }

            const entries = buffer.query({
                since: sinceMs,
                level: params.level,
                source: params.source,
                contains: params.contains,
                limit: params.limit ?? 50,
                consume: params.consume ?? false,
            });

            return { success: true, action, entries };
        }

        case 'clear': {
            if (!isLogHubRunning()) {
                return { success: false, action, error: 'Log Hub not initialized' };
            }
            const buffer = getLogBuffer();
            buffer?.clear();
            return { success: true, action };
        }

        case 'write': {
            if (!isLogHubRunning()) {
                return { success: false, action, error: 'Log Hub not initialized. Run init first.' };
            }
            if (!params.message) {
                return { success: false, action, error: 'message is required for write' };
            }

            const level: LogLevel = params.level ?? 'info';
            const entry = writeLogEntry(level, params.message, params.data);
            if (!entry) {
                return { success: false, action, error: 'Failed to write entry' };
            }

            return { success: true, action, entries: [entry] };
        }

        case 'control_get': {
            // Read all interactive-control values as a flat { id: value } map.
            // Lets the AI see exactly what the user sees in the dashboard.
            if (!isLogHubRunning()) {
                return { success: false, action, error: 'Log Hub not initialized. Run init first.' };
            }
            return { success: true, action, controls: getControlValues() };
        }

        case 'control_set': {
            // Change ONE control — the same setter the dashboard slider drives.
            // The source (e.g. the ESP32) defines which controls exist; this only
            // changes the value of an existing one. Returns the full map after.
            if (!isLogHubRunning()) {
                return { success: false, action, error: 'Log Hub not initialized. Run init first.' };
            }
            if (typeof params.id !== 'string' || !params.id.trim()) {
                return { success: false, action, error: 'id is required for control_set' };
            }
            if (params.value === undefined) {
                return { success: false, action, error: 'value is required for control_set' };
            }
            if (!setControl(params.id, params.value)) {
                return { success: false, action, error: 'invalid control id or value' };
            }
            return { success: true, action, controls: getControlValues() };
        }

        default:
            return { success: false, action, error: `Unknown action: ${action}` };
    }
}
