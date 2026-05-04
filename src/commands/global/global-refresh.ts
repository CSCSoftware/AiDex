/**
 * global-refresh command
 *
 * Update stats in global.db for all (or specific) projects.
 * Removes projects whose paths no longer exist.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { INDEX_DIR } from '../../constants.js';
import { readProjectStats } from '../../db/global-database.js';
import { normalizePath } from '../shared.js';
import { withGlobalDb, EMPTY_TOTALS } from './global-shared.js';

// ============================================================
// Types
// ============================================================

export interface GlobalRefreshParams {
    project?: string;   // Name or path of a specific project
    tagFilter?: string;
}

export interface GlobalRefreshResult {
    success: boolean;
    updated: number;
    removed: number;
    removedPaths: string[];
    totals: {
        projects: number;
        files: number;
        items: number;
        methods: number;
        types: number;
    };
    error?: string;
}

// ============================================================
// Implementation
// ============================================================

export function globalRefresh(params: GlobalRefreshParams): GlobalRefreshResult {
    return withGlobalDb<GlobalRefreshResult>(
        (error) => ({
            success: false,
            updated: 0,
            removed: 0,
            removedPaths: [],
            totals: { ...EMPTY_TOTALS },
            error,
        }),
        (globalDb) => {
            let projects = globalDb.getProjects(
                params.tagFilter ? { tag: params.tagFilter } : undefined
            );

            // Filter to specific project if requested
            if (params.project) {
                const normalizedFilter = normalizePath(params.project);
                projects = projects.filter(p =>
                    p.name === params.project ||
                    normalizePath(p.path) === normalizedFilter
                );
            }

            let updated = 0;
            let removed = 0;
            const removedPaths: string[] = [];

            // First pass: dedupe entries that differ only in path separators
            // (e.g. "Q:/develop/Aidex" and "Q:\develop\Aidex" registered as
            // separate rows due to a historical normalisation gap). We keep
            // the entry with stats and drop the empty duplicate.
            const seen = new Map<string, typeof projects[number]>();
            const dropped: string[] = [];
            for (const p of projects) {
                const key = normalizePath(p.path).toLowerCase();
                const prev = seen.get(key);
                if (!prev) {
                    seen.set(key, p);
                    continue;
                }
                // Prefer the one with more files indexed; on tie, prefer
                // forward-slash form.
                const prevHasData = (prev.files_count ?? 0) > 0;
                const currHasData = (p.files_count ?? 0) > 0;
                const winner = currHasData && !prevHasData ? p : prev;
                const loser = winner === p ? prev : p;
                seen.set(key, winner);
                if (loser.path !== winner.path) {
                    globalDb.unregisterProject(loser.path);
                    dropped.push(loser.path);
                }
            }
            projects = [...seen.values()];

            for (const project of projects) {
                const dbPath = join(project.path, INDEX_DIR, 'index.db');

                if (!existsSync(dbPath)) {
                    // Project no longer exists — remove from registry
                    globalDb.unregisterProject(project.path);
                    removedPaths.push(project.path);
                    removed++;
                    continue;
                }

                // Read fresh stats and update — registerProject already
                // normalises the path, so re-registering an entry that was
                // stored with backslashes will overwrite it under the canonical
                // forward-slash form.
                const stats = readProjectStats(project.path);
                if (stats) {
                    globalDb.registerProject(project.path, project.name, stats);
                    updated++;
                }
            }

            // Surface any deduplicated paths so the user sees the cleanup.
            for (const d of dropped) {
                removedPaths.push(d);
                removed++;
            }

            const totals = globalDb.getTotals();

            return {
                success: true,
                updated,
                removed,
                removedPaths,
                totals,
            };
        }
    );
}
