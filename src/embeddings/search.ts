/**
 * Search execution — runs vec0 KNN with optional filters and exact-match fusion.
 *
 * Pipeline:
 *   1. Embed the query string with the active model.
 *   2. KNN against the matching vec_embeddings_<dim> table.
 *   3. Join with the embeddings metadata table for paths, names, snippets.
 *   4. Apply scope / source_kind / source_type / project filters.
 *   5. (Hybrid only) Run a parallel exact-match query and fuse rankings via RRF.
 */

import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';

import type {
    LlmStrategy,
    SearchHit,
    SearchOptions,
    SearchScope,
    SourceKind,
    SourceType,
} from './index.js';
import { createEmbedder, type Embedder } from './embedder.js';
import { getModel } from './model-registry.js';
import { getLlm } from '../llm/index.js';
import { readLlmSendCode } from '../llm/config.js';

// ============================================================
// Singleton DB connection (must be the same connection that has sqlite-vec loaded)
// ============================================================

import { _searchDbAccessor, ensureVecTable } from './store.js';

// ============================================================
// Public entry
// ============================================================

const RRF_K = 60;
const SEMANTIC_FETCH_FACTOR = 3; // pull 3x more candidates than k for filtering headroom

let _embedderCache: { modelId: string; embedder: Embedder } | null = null;

async function getQueryEmbedder(modelId: string): Promise<Embedder> {
    if (_embedderCache && _embedderCache.modelId === modelId) return _embedderCache.embedder;
    if (_embedderCache) await _embedderCache.embedder.dispose();
    const embedder = await createEmbedder(getModel(modelId));
    _embedderCache = { modelId, embedder };
    return embedder;
}

export async function runSearch(opts: SearchOptions): Promise<SearchHit[]> {
    const k = opts.k ?? 20;
    const mode = opts.mode ?? 'hybrid';
    const scope = opts.scope ?? (opts.path ? 'current' : 'all');
    const llmStrategy: LlmStrategy = opts.llm ?? 'auto';

    const db = _searchDbAccessor();

    const projects = resolveProjects(db, scope, opts.path, opts.projectFilter);
    if (projects.length === 0) return [];

    const modelId = projects[0].embedding_model_id;
    if (!modelId) return [];

    const dim = projects[0].embedding_dim as number;
    const projectIds = projects.map(p => p.id);

    await ensureVecTable(dim);

    // ============================================================
    // LLM stage 1: query rewriting (translate / expand)
    // ============================================================
    const queries = await rewriteQuery(opts.query, llmStrategy, opts.path);

    // ============================================================
    // Retrieval — run against each subquery and merge by RRF.
    // For a single-query path this is a single pass with no merge cost.
    // ============================================================
    const candidateLimit = k * SEMANTIC_FETCH_FACTOR;
    const semBatches: SearchHit[][] = [];
    if (mode !== 'exact') {
        for (const q of queries) {
            const o2: SearchOptions = { ...opts, query: q };
            semBatches.push(await runSemantic(db, o2, modelId, dim, projectIds, candidateLimit));
        }
    }
    let semantic: SearchHit[] = mergeBatchesRRF(semBatches);

    if (mode === 'semantic') {
        // No exact-match fusion. Optionally rerank.
        return await maybeRerank(semantic.slice(0, k), opts, llmStrategy, opts.path);
    }

    // Exact side runs against the original query (exact match in any
    // language doesn't translate well — identifiers are language-neutral).
    const exact = runExactAcrossProjects(projects, opts, candidateLimit);

    if (mode === 'exact') {
        return await maybeRerank(exact.slice(0, k), opts, llmStrategy, opts.path);
    }

    // Hybrid: RRF fusion of semantic + exact.
    const fused = fuseRRF(semantic, exact, k);
    return await maybeRerank(fused, opts, llmStrategy, opts.path);
}

// ============================================================
// LLM helpers
// ============================================================

async function rewriteQuery(
    original: string,
    strategy: LlmStrategy,
    projectPath: string | undefined
): Promise<string[]> {
    if (strategy === 'off' || strategy === 'rerank') return [original];

    const llm = getLlm();
    const ctx = { projectPath: projectPath ?? '', sendCode: false }; // query-only stage — code never sent

    if (strategy === 'expand+rerank') {
        const r = await llm.expand(original, ctx);
        return r.queries.length > 0 ? r.queries : [original];
    }

    if (strategy === 'translate' || strategy === 'auto') {
        const r = await llm.translate(original, ctx);
        return r.queries.length > 0 ? r.queries : [original];
    }

    return [original];
}

async function maybeRerank(
    hits: SearchHit[],
    opts: SearchOptions,
    strategy: LlmStrategy,
    projectPath: string | undefined
): Promise<SearchHit[]> {
    if (hits.length === 0) return hits;
    if (strategy === 'off' || strategy === 'translate') return hits;
    // 'auto' triggers rerank only when there's a backend. getLlm().status()
    // is cheap; we let the LLM module's stub no-op if none is available.

    const sendCode = projectPath ? readLlmSendCode(projectPath) : false;
    const llm = getLlm();
    const status = await llm.status();
    if (!status.available) return hits;

    const ctx = { projectPath: projectPath ?? '', sendCode };
    const candidates = hits.map((h, i) => ({
        id: String(i),
        sourceKind: h.sourceKind,
        sourceType: h.sourceType,
        sourceName: h.sourceName,
        sourceAnchor: h.sourceAnchor,
        sourcePath: h.sourcePath,
        sourceLine: h.sourceLine,
        sourceText: h.sourceText,
    }));
    const r = await llm.rerank(opts.query, candidates, ctx);
    if (!r.invoked) return hits;

    const byId = new Map(candidates.map((c, i) => [c.id, hits[i]]));
    const reordered: SearchHit[] = [];
    let rank = 1;
    for (const id of r.orderedIds) {
        const h = byId.get(id);
        if (h) reordered.push({ ...h, rank: rank++ });
    }
    return reordered;
}

/** RRF over multiple candidate lists (for query-expansion). */
function mergeBatchesRRF(batches: SearchHit[][]): SearchHit[] {
    if (batches.length === 0) return [];
    if (batches.length === 1) return batches[0];
    const score = new Map<string, { hit: SearchHit; rrf: number }>();
    const keyOf = (h: SearchHit) =>
        `${h.projectPath}::${h.sourceType}::${h.sourcePath ?? ''}::${h.sourceLine ?? ''}::${h.sourceName ?? ''}`;
    for (const batch of batches) {
        for (let i = 0; i < batch.length; i++) {
            const h = batch[i];
            const key = keyOf(h);
            const r = 1 / (RRF_K + (i + 1));
            const prev = score.get(key);
            if (prev) prev.rrf += r;
            else score.set(key, { hit: h, rrf: r });
        }
    }
    return Array.from(score.values())
        .sort((a, b) => b.rrf - a.rrf)
        .map((entry, i) => ({ ...entry.hit, rank: i + 1 }));
}

// ============================================================
// Project resolution
// ============================================================

interface ProjectRow {
    id: number;
    path: string;
    name: string;
    embedding_model_id: string | null;
    embedding_dim: number | null;
}

function resolveProjects(
    db: Database.Database,
    scope: SearchScope,
    path: string | undefined,
    projectFilter: string[] | undefined
): ProjectRow[] {
    if (scope === 'current') {
        if (!path) {
            throw new Error('scope:"current" requires a path argument');
        }
        const row = db.prepare(
            `SELECT id, path, name, embedding_model_id, embedding_dim
             FROM projects WHERE path = ? AND embedding_model_id IS NOT NULL`
        ).get(path) as ProjectRow | undefined;
        return row ? [row] : [];
    }

    // scope === 'all' or 'linked'
    let rows = db.prepare(
        `SELECT id, path, name, embedding_model_id, embedding_dim
         FROM projects WHERE embedding_model_id IS NOT NULL ORDER BY id`
    ).all() as ProjectRow[];

    if (projectFilter && projectFilter.length > 0) {
        const matchers = projectFilter.map(p => globToRegex(p));
        rows = rows.filter(r => matchers.some(re => re.test(r.path)));
    }

    return rows;
}

function globToRegex(glob: string): RegExp {
    const escaped = glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '__GLOBSTAR__')
        .replace(/\*/g, '[^/\\\\]*')
        .replace(/__GLOBSTAR__/g, '.*');
    return new RegExp('^' + escaped + '$', 'i');
}

// ============================================================
// Semantic search
// ============================================================

async function runSemantic(
    db: Database.Database,
    opts: SearchOptions,
    modelId: string,
    dim: number,
    projectIds: number[],
    candidateCount: number
): Promise<SearchHit[]> {
    const embedder = await getQueryEmbedder(modelId);
    const [vec] = await embedder.embed([opts.query]);
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);

    const tableName = `vec_embeddings_${dim}`;

    // ------------------------------------------------------------
    // sqlite-vec applies WHERE clauses on joined columns AFTER the
    // KNN step, so a filter like `e.source_kind = 'docs'` only filters
    // the top-K candidates returned by the vector index. In a code-heavy
    // index the K=candidateCount nearest neighbours are typically all
    // code, leaving zero docs hits even though docs embeddings exist.
    //
    // Fix: when a metadata filter is active, resolve the allowed rowids
    // up front and constrain the KNN itself via `v.rowid IN (...)`. This
    // makes vec0 search the filtered subset instead of post-filtering.
    // We skip this work in the unfiltered case to avoid the extra query.
    // ------------------------------------------------------------
    const hasKindFilter = !!(opts.sourceKinds && opts.sourceKinds.length > 0);
    const hasTypeFilter = !!(opts.sourceTypes && opts.sourceTypes.length > 0);
    const hasProjectFilter = projectIds.length > 0;

    let allowedRowids: number[] | null = null;
    if (hasKindFilter || hasTypeFilter) {
        const where: string[] = [];
        const args: any[] = [];
        if (hasProjectFilter) {
            where.push(`project_id IN (${projectIds.map(() => '?').join(',')})`);
            args.push(...projectIds);
        }
        if (hasKindFilter) {
            where.push(`source_kind IN (${opts.sourceKinds!.map(() => '?').join(',')})`);
            args.push(...opts.sourceKinds!);
        }
        if (hasTypeFilter) {
            where.push(`source_type IN (${opts.sourceTypes!.map(() => '?').join(',')})`);
            args.push(...opts.sourceTypes!);
        }
        const idRows = db.prepare(
            `SELECT id FROM embeddings WHERE ${where.join(' AND ')}`
        ).all(...args) as Array<{ id: number }>;
        allowedRowids = idRows.map(r => r.id);
        // Filter set is empty -> no candidates can match the filter, skip KNN.
        if (allowedRowids.length === 0) return [];
    }

    // Build metadata filter for the KNN query.
    const filters: string[] = [`v.embedding MATCH ?`, `k = ?`];
    const params: any[] = [buf, candidateCount];

    if (allowedRowids !== null) {
        // Pre-KNN: restrict the vector search to rowids that already pass
        // every metadata filter. No post-filter needed.
        filters.push(`v.rowid IN (${allowedRowids.map(() => '?').join(',')})`);
        params.push(...allowedRowids);
    } else if (hasProjectFilter) {
        // Unfiltered (kind/type) case — keep the original join-side filter.
        filters.push(`e.project_id IN (${projectIds.map(() => '?').join(',')})`);
        params.push(...projectIds);
    }

    const sql = `
        SELECT v.distance, v.rowid, e.project_id, e.project_path,
               e.source_type, e.source_kind, e.source_path, e.source_line,
               e.source_anchor, e.source_name, e.source_text
        FROM ${tableName} v
        JOIN embeddings e ON e.id = v.rowid
        WHERE ${filters.join(' AND ')}
        ORDER BY v.distance
    `;

    const rows = db.prepare(sql).all(...params) as Array<{
        distance: number;
        rowid: number;
        project_id: number;
        project_path: string;
        source_type: SourceType;
        source_kind: SourceKind;
        source_path: string | null;
        source_line: number | null;
        source_anchor: string | null;
        source_name: string | null;
        source_text: string;
    }>;

    // Map to SearchHit. Need project name — join after.
    const projectNameMap = new Map<number, string>();
    for (const row of db.prepare(
        `SELECT id, name FROM projects WHERE id IN (${rows.map(() => '?').join(',') || '0'})`
    ).all(...rows.map(r => r.project_id)) as Array<{ id: number; name: string }>) {
        projectNameMap.set(row.id, row.name);
    }

    return rows.map((r, i) => ({
        projectPath: r.project_path,
        projectName: projectNameMap.get(r.project_id) ?? r.project_path,
        sourceType: r.source_type,
        sourceKind: r.source_kind,
        sourcePath: r.source_path,
        sourceLine: r.source_line,
        sourceAnchor: r.source_anchor,
        sourceName: r.source_name,
        sourceText: r.source_text,
        distance: r.distance,
        rank: i + 1,
    }));
}

// ============================================================
// Exact match (delegates to existing aidex_query identifier search)
// ============================================================

/**
 * Does the given source_kind pass `opts.sourceKinds`?
 * Mirrors the SQL `e.source_kind IN (...)` filter from runSemantic so
 * both pipelines stay in sync (otherwise hybrid leaks code hits when
 * the caller asked for docs-only).
 */
function passesKindFilter(kind: SourceKind, opts: SearchOptions): boolean {
    if (!opts.sourceKinds || opts.sourceKinds.length === 0) return true;
    return opts.sourceKinds.includes(kind);
}

/**
 * Does the given source_type pass `opts.sourceTypes`?
 * Same rationale as passesKindFilter — keep semantic + exact pipelines
 * consistent.
 */
function passesTypeFilter(type: SourceType, opts: SearchOptions): boolean {
    if (!opts.sourceTypes || opts.sourceTypes.length === 0) return true;
    return opts.sourceTypes.includes(type);
}

function runExactAcrossProjects(
    projects: ProjectRow[],
    opts: SearchOptions,
    candidateCount: number
): SearchHit[] {
    // The exact pipeline can only ever produce code-identifier hits.
    // If the caller asked for a kind-set that excludes 'code', short-circuit
    // — otherwise hybrid would smuggle code hits past a docs/workspace filter.
    if (!passesKindFilter('code', opts)) return [];

    const hits: SearchHit[] = [];
    let rank = 1;

    // Read each project's local index.db read-only; query identifiers.
    for (const proj of projects) {
        const idxPath = join(proj.path, '.aidex', 'index.db');
        let local: Database.Database;
        try {
            local = new Database(idxPath, { readonly: true });
        } catch {
            continue;
        }
        try {
            const term = opts.query;
            const itemRows = local.prepare(
                `SELECT id, term FROM items WHERE term LIKE ? ESCAPE '\\' COLLATE NOCASE LIMIT 200`
            ).all('%' + term.replace(/[\\%_]/g, '\\$&') + '%') as Array<{ id: number; term: string }>;
            if (itemRows.length === 0) continue;

            // Pull occurrences for these items, with file+line context.
            const itemIds = itemRows.map(r => r.id);
            const occ = local
                .prepare(
                    `SELECT i.term as term, f.path as file_path, l.line_number as line, l.line_type as line_type
                     FROM occurrences o
                     JOIN items i ON o.item_id = i.id
                     JOIN files f ON o.file_id = f.id
                     JOIN lines l ON o.line_id = l.id AND o.file_id = l.file_id
                     WHERE o.item_id IN (${itemIds.map(() => '?').join(',')})
                     ORDER BY i.term, f.path, l.line_number
                     LIMIT ?`
                )
                .all(...itemIds, candidateCount) as Array<{
                term: string;
                file_path: string;
                line: number;
                line_type: string;
            }>;

            for (const o of occ) {
                const sourceType: SourceType = (o.line_type as SourceType) ?? 'method';
                // Honour the same source_types filter the semantic side applies.
                if (!passesTypeFilter(sourceType, opts)) continue;
                hits.push({
                    projectPath: proj.path,
                    projectName: proj.name,
                    sourceType,
                    sourceKind: 'code',
                    sourcePath: o.file_path,
                    sourceLine: o.line,
                    sourceAnchor: null,
                    sourceName: o.term,
                    sourceText: '',
                    distance: 0,
                    rank: rank++,
                });
                if (hits.length >= candidateCount) return hits;
            }
        } finally {
            local.close();
        }
    }
    return hits;
}

// ============================================================
// Reciprocal Rank Fusion
// ============================================================

function fuseRRF(semantic: SearchHit[], exact: SearchHit[], k: number): SearchHit[] {
    const score = new Map<string, { hit: SearchHit; rrf: number }>();
    const keyOf = (h: SearchHit) =>
        `${h.projectPath}::${h.sourceType}::${h.sourcePath ?? ''}::${h.sourceLine ?? ''}::${h.sourceName ?? ''}`;

    for (let i = 0; i < semantic.length; i++) {
        const h = semantic[i];
        const key = keyOf(h);
        const r = 1 / (RRF_K + (i + 1));
        const prev = score.get(key);
        if (prev) prev.rrf += r;
        else score.set(key, { hit: h, rrf: r });
    }
    for (let i = 0; i < exact.length; i++) {
        const h = exact[i];
        const key = keyOf(h);
        const r = 1 / (RRF_K + (i + 1));
        const prev = score.get(key);
        if (prev) {
            prev.rrf += r;
            // Keep the entry with richer metadata (semantic side has snippet text).
            if (!prev.hit.sourceText && h.sourceText) prev.hit.sourceText = h.sourceText;
        } else {
            score.set(key, { hit: h, rrf: r });
        }
    }

    return Array.from(score.values())
        .sort((a, b) => b.rrf - a.rrf)
        .slice(0, k)
        .map((entry, i) => ({ ...entry.hit, rank: i + 1 }));
}
