/**
 * global-query command
 *
 * Search for terms across ALL registered projects using ATTACH DATABASE.
 */

import type Database from 'better-sqlite3';
import type { GlobalProject } from '../../db/global-database.js';
import { withGlobalDb } from './global-shared.js';
import { escapeLikeTerm } from '../shared.js';

// ============================================================
// Types
// ============================================================

export type GlobalQueryMode = 'exact' | 'contains' | 'starts_with';

export interface GlobalQueryParams {
    term: string;
    mode?: GlobalQueryMode;
    projectFilter?: string;
    tagFilter?: string;
    typeFilter?: string[];
    limit?: number;
    limitTotal?: number;
    noCache?: boolean;
}

export interface GlobalQueryMatch {
    file: string;
    lineNumber: number;
    lineType: string;
}

export interface GlobalQueryProjectResult {
    project: string;
    projectPath: string;
    matches: GlobalQueryMatch[];
}

export interface GlobalQueryResult {
    success: boolean;
    term: string;
    mode: GlobalQueryMode;
    projectResults: GlobalQueryProjectResult[];
    totalMatches: number;
    projectsSearched: number;
    cached: boolean;
    error?: string;
}

// ============================================================
// Session cache
// ============================================================

interface CacheEntry {
    result: GlobalQueryResult;
    timestamp: number;
}

const queryCache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCacheKey(term: string, mode: string, projectFilter?: string, tagFilter?: string): string {
    return `${mode}:${term}:${projectFilter ?? ''}:${tagFilter ?? ''}`;
}

/**
 * Invalidate all cached global queries (call after init/update)
 */
export function invalidateGlobalCache(): void {
    queryCache.clear();
}

// ============================================================
// Implementation
// ============================================================

export function globalQuery(params: GlobalQueryParams): GlobalQueryResult {
    const mode = params.mode ?? 'exact';
    const limitPerProject = params.limit ?? 20;
    const limitTotal = params.limitTotal ?? 100;

    // Check cache before opening DB
    if (!params.noCache) {
        const cacheKey = getCacheKey(params.term, mode, params.projectFilter, params.tagFilter);
        const cached = queryCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
            return { ...cached.result, cached: true };
        }
    }

    return withGlobalDb<GlobalQueryResult>(
        (error) => ({
            success: false,
            term: params.term,
            mode,
            projectResults: [],
            totalMatches: 0,
            projectsSearched: 0,
            cached: false,
            error,
        }),
        (globalDb) => {
            // Get projects to search
            const filter: { tag?: string; namePattern?: string } = {};
            if (params.tagFilter) filter.tag = params.tagFilter;
            if (params.projectFilter) filter.namePattern = params.projectFilter;

            const projects = globalDb.getProjects(filter);

            if (projects.length === 0) {
                return {
                    success: true,
                    term: params.term,
                    mode,
                    projectResults: [],
                    totalMatches: 0,
                    projectsSearched: 0,
                    cached: false,
                };
            }

            // Build search query based on mode
            const queryFn = (db: Database.Database, alias: string, project: GlobalProject): GlobalQueryMatch[] => {
                const { sql, param } = buildItemSearch(alias, params.term, mode);

                // First find matching items
                const items = db.prepare(sql).all(param, 1000) as Array<{ id: number; term: string }>;
                if (items.length === 0) return [];

                // Batch fetch all occurrences at once (eliminates N+1)
                const matches: GlobalQueryMatch[] = [];
                const seen = new Set<string>();
                const itemIds = items.map(i => i.id);

                const batchSize = 500;
                for (let i = 0; i < itemIds.length; i += batchSize) {
                    const batch = itemIds.slice(i, i + batchSize);
                    const placeholders = batch.map(() => '?').join(',');
                    const occSql = `
                        SELECT f.path, l.line_number, l.line_type
                        FROM ${alias}.occurrences o
                        JOIN ${alias}.lines l ON o.file_id = l.file_id AND o.line_id = l.id
                        JOIN ${alias}.files f ON o.file_id = f.id
                        WHERE o.item_id IN (${placeholders})
                        ORDER BY f.path, l.line_number
                    `;
                    const occs = db.prepare(occSql).all(...batch) as Array<{
                        path: string;
                        line_number: number;
                        line_type: string;
                    }>;

                    for (const occ of occs) {
                        // Apply type filter
                        if (params.typeFilter && params.typeFilter.length > 0) {
                            if (!params.typeFilter.includes(occ.line_type)) continue;
                        }

                        // Deduplicate
                        const key = `${occ.path}:${occ.line_number}`;
                        if (seen.has(key)) continue;
                        seen.add(key);

                        matches.push({
                            file: occ.path,
                            lineNumber: occ.line_number,
                            lineType: occ.line_type,
                        });

                        if (matches.length >= limitPerProject) break;
                    }
                    if (matches.length >= limitPerProject) break;
                }

                return matches;
            };

            // Execute across all projects
            const results = globalDb.queryAcrossProjects(projects, queryFn, limitTotal);

            // Format output
            const projectResults: GlobalQueryProjectResult[] = results.map(r => ({
                project: r.project.name,
                projectPath: r.project.path,
                matches: r.results,
            }));

            const totalMatches = projectResults.reduce((sum, pr) => sum + pr.matches.length, 0);

            const result: GlobalQueryResult = {
                success: true,
                term: params.term,
                mode,
                projectResults,
                totalMatches,
                projectsSearched: projects.length,
                cached: false,
            };

            // Store in cache, evict expired entries to prevent unbounded growth
            const cacheKey = getCacheKey(params.term, mode, params.projectFilter, params.tagFilter);
            const now = Date.now();
            for (const [key, entry] of queryCache) {
                if (now - entry.timestamp >= CACHE_TTL) queryCache.delete(key);
            }
            queryCache.set(cacheKey, { result, timestamp: now });

            return result;
        }
    );
}

// ============================================================
// Helpers
// ============================================================

function buildItemSearch(alias: string, term: string, mode: GlobalQueryMode): { sql: string; param: string } {
    switch (mode) {
        case 'exact':
            return {
                sql: `SELECT id, term FROM ${alias}.items WHERE term = ? COLLATE NOCASE LIMIT ?`,
                param: term,
            };
        case 'contains': {
            return {
                sql: `SELECT id, term FROM ${alias}.items WHERE term LIKE ? ESCAPE '\\' COLLATE NOCASE LIMIT ?`,
                param: `%${escapeLikeTerm(term)}%`,
            };
        }
        case 'starts_with': {
            return {
                sql: `SELECT id, term FROM ${alias}.items WHERE term LIKE ? ESCAPE '\\' COLLATE NOCASE LIMIT ?`,
                param: `${escapeLikeTerm(term)}%`,
            };
        }
    }
}
