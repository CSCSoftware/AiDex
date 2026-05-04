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
    SearchResultWithTelemetry,
    SearchScope,
    SearchTelemetry,
    SourceKind,
    SourceType,
} from './index.js';
import { createEmbedder, type Embedder } from './embedder.js';
import { getModel } from './model-registry.js';
import { getLlm } from '../llm/index.js';
import { readLlmSendCode } from '../llm/config.js';
import { normalizePath } from '../commands/shared.js';

// ============================================================
// Singleton DB connection (must be the same connection that has sqlite-vec loaded)
// ============================================================

import { _searchDbAccessor, ensureVecTable } from './store.js';

// ============================================================
// Public entry
// ============================================================

const RRF_K = 60;
const SEMANTIC_FETCH_FACTOR = 3; // pull 3x more candidates than k for filtering headroom
// Floor for the vec0 KNN candidate pool. Without this, small `k` (e.g. k=5)
// asks vec0 for only 15 neighbours, while k=10 asks for 30. sqlite-vec's KNN
// is not strictly stable under k variation (ANN-style behaviour: the top-N
// of a k=30 query is not always equal to the result of a k=15 query),
// which made `aidex_search k=5` occasionally return 0 hits while k=10
// returned 3 — even though k=5 should be a subset of k=10. Pinning the
// candidate pool to at least SEMANTIC_FETCH_FLOOR makes the underlying
// KNN deterministic across user-facing `k` values; the JS slice does the
// final trimming.
const SEMANTIC_FETCH_FLOOR = 60;

let _embedderCache: { modelId: string; embedder: Embedder } | null = null;

async function getQueryEmbedder(modelId: string): Promise<Embedder> {
    if (_embedderCache && _embedderCache.modelId === modelId) return _embedderCache.embedder;
    if (_embedderCache) await _embedderCache.embedder.dispose();
    const embedder = await createEmbedder(getModel(modelId));
    _embedderCache = { modelId, embedder };
    return embedder;
}

export async function runSearch(opts: SearchOptions): Promise<SearchHit[]> {
    const r = await runSearchWithTelemetry(opts);
    return r.hits;
}

function newTelemetry(): SearchTelemetry {
    return {
        translateRan: false,
        translateFailed: false,
        expandRan: false,
        expandFailed: false,
        rerankRan: false,
        rerankFailed: false,
        queriesUsed: [],
    };
}

export async function runSearchWithTelemetry(opts: SearchOptions): Promise<SearchResultWithTelemetry> {
    const k = opts.k ?? 20;
    const mode = opts.mode ?? 'hybrid';
    const path = opts.path ? normalizePath(opts.path) : undefined;
    const scope = opts.scope ?? (path ? 'current' : 'all');
    const llmStrategy: LlmStrategy = opts.llm ?? 'auto';
    const telemetry = newTelemetry();

    const db = _searchDbAccessor();

    const projects = resolveProjects(db, scope, path, opts.projectFilter);
    if (projects.length === 0) return { hits: [], telemetry };

    const modelId = projects[0].embedding_model_id;
    if (!modelId) return { hits: [], telemetry };

    const dim = projects[0].embedding_dim as number;
    const projectIds = projects.map(p => p.id);

    await ensureVecTable(dim);

    // ============================================================
    // LLM stage 1: query rewriting (translate / expand)
    // ============================================================
    const queries = await rewriteQuery(opts.query, llmStrategy, path, telemetry);
    telemetry.queriesUsed = queries;

    // ============================================================
    // Retrieval — run against each subquery and merge by RRF.
    // For a single-query path this is a single pass with no merge cost.
    // ============================================================
    const candidateLimit = Math.max(k * SEMANTIC_FETCH_FACTOR, SEMANTIC_FETCH_FLOOR);
    const semBatches: SearchHit[][] = [];
    if (mode !== 'exact') {
        for (const q of queries) {
            const o2: SearchOptions = { ...opts, query: q };
            semBatches.push(await runSemantic(db, o2, modelId, dim, projectIds, candidateLimit));
        }
    }
    let semantic: SearchHit[] = mergeBatchesRRF(semBatches);

    if (mode === 'semantic') {
        const hits = await maybeRerank(semantic.slice(0, k), opts, llmStrategy, path, telemetry);
        return { hits, telemetry };
    }

    // Exact side runs against the original query (exact match in any
    // language doesn't translate well — identifiers are language-neutral).
    const exact = runExactAcrossProjects(projects, opts, candidateLimit);

    if (mode === 'exact') {
        const hits = await maybeRerank(exact.slice(0, k), opts, llmStrategy, path, telemetry);
        return { hits, telemetry };
    }

    // Hybrid: RRF fusion of semantic + exact.
    const fused = fuseRRF(semantic, exact, k);
    const hits = await maybeRerank(fused, opts, llmStrategy, path, telemetry);
    return { hits, telemetry };
}

// ============================================================
// LLM helpers
// ============================================================

async function rewriteQuery(
    original: string,
    strategy: LlmStrategy,
    projectPath: string | undefined,
    telemetry: SearchTelemetry
): Promise<string[]> {
    if (strategy === 'off' || strategy === 'rerank') return [original];

    const llm = getLlm();
    // Don't claim a stage "ran" when no backend is wired up. The stub
    // module returns invoked:false silently, but the telemetry must reflect
    // that no LLM call actually went out.
    const status = await llm.status();
    if (!status.available) return [original];

    const ctx = { projectPath: projectPath ?? '', sendCode: false }; // query-only stage — code never sent

    if (strategy === 'expand+rerank') {
        try {
            const r = await llm.expand(original, ctx);
            telemetry.expandRan = !!r.invoked;
            return r.queries.length > 0 ? r.queries : [original];
        } catch (err) {
            telemetry.expandRan = true;
            telemetry.expandFailed = true;
            telemetry.lastError = err instanceof Error ? err.message : String(err);
            return [original];
        }
    }

    if (strategy === 'translate' || strategy === 'auto') {
        try {
            const r = await llm.translate(original, ctx);
            telemetry.translateRan = !!r.invoked;
            return r.queries.length > 0 ? r.queries : [original];
        } catch (err) {
            telemetry.translateRan = true;
            telemetry.translateFailed = true;
            telemetry.lastError = err instanceof Error ? err.message : String(err);
            return [original];
        }
    }

    return [original];
}

async function maybeRerank(
    hits: SearchHit[],
    opts: SearchOptions,
    strategy: LlmStrategy,
    projectPath: string | undefined,
    telemetry: SearchTelemetry
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
    telemetry.rerankRan = true;
    let r;
    try {
        r = await llm.rerank(opts.query, candidates, ctx);
    } catch (err) {
        telemetry.rerankFailed = true;
        telemetry.lastError = err instanceof Error ? err.message : String(err);
        return hits;
    }
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
 * Tokenise an NL query for the exact-identifier pipeline.
 *
 * Identifiers don't contain spaces, so feeding the raw NL query
 * (e.g. "how do I extract a thumbnail") to a LIKE search produces zero
 * matches and reduces hybrid to pure-semantic. We split on non-word
 * characters, drop trivial stopwords + tokens shorter than 3 chars,
 * and let each remaining token probe the identifier table.
 *
 * For a single-token query (e.g. "Thumbnail") this returns the original
 * untouched, so hybrid behaviour for code-style queries is unchanged.
 */
const NL_STOPWORDS = new Set([
    'the', 'and', 'for', 'how', 'what', 'why', 'who', 'when', 'where',
    'this', 'that', 'these', 'those', 'with', 'from', 'into', 'onto',
    'can', 'does', 'did', 'are', 'was', 'were', 'will', 'would', 'should',
    'could', 'have', 'has', 'had', 'you', 'your', 'our', 'they', 'them',
    'his', 'her', 'its', 'all', 'any', 'some', 'one', 'two', 'not',
    'but', 'use', 'using', 'used', 'about', 'just',
]);

function tokenizeForExact(query: string): string[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    // Single non-whitespace token → likely an identifier, pass through.
    if (!/\s/.test(trimmed)) return [trimmed];
    const raw = trimmed.split(/[^A-Za-z0-9_]+/).filter(Boolean);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of raw) {
        if (t.length < 3) continue;
        const lower = t.toLowerCase();
        if (NL_STOPWORDS.has(lower)) continue;
        if (seen.has(lower)) continue;
        seen.add(lower);
        out.push(t);
    }
    // If filtering removed everything, fall back to the raw query so we
    // at least try one LIKE rather than silently returning [].
    return out.length > 0 ? out : [trimmed];
}

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

    // NL queries get tokenised here. A single-token query (typical "find
    // identifier X" use case) flows through unchanged.
    const tokens = tokenizeForExact(opts.query);
    if (tokens.length === 0) return [];

    const hits: SearchHit[] = [];
    const seenKey = new Set<string>();
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
            // Collect items matching ANY token (union); de-dup by item id.
            const itemMap = new Map<number, string>();
            const itemStmt = local.prepare(
                `SELECT id, term FROM items WHERE term LIKE ? ESCAPE '\\' COLLATE NOCASE LIMIT 200`
            );
            for (const tok of tokens) {
                const like = '%' + tok.replace(/[\\%_]/g, '\\$&') + '%';
                const rows = itemStmt.all(like) as Array<{ id: number; term: string }>;
                for (const r of rows) {
                    if (!itemMap.has(r.id)) itemMap.set(r.id, r.term);
                }
            }
            if (itemMap.size === 0) continue;

            // Pull occurrences for these items, with file+line context.
            const itemIds = Array.from(itemMap.keys());
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
                // De-dup across token-union (same identifier may match multiple tokens).
                const dedupKey = `${proj.path}::${o.file_path}::${o.line}::${o.term}`;
                if (seenKey.has(dedupKey)) continue;
                seenKey.add(dedupKey);
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
