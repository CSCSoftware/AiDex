/**
 * Storage layer for the embeddings module.
 *
 * Owns:
 *  - the embeddings-specific schema migration on global.db
 *  - the projects.embedding_* columns
 *  - the vec0 virtual table for vectors
 *  - read/write helpers around `embeddings`
 *  - identifier extraction from a project's local index.db
 *
 * The vec0 hookup is lazy: sqlite-vec is loaded on first use, not at import time.
 */

import { existsSync, readFileSync } from 'fs';
// (readFileSync used for both schema.sql and doc files)
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

import Database from 'better-sqlite3';
import { INDEX_DIR } from '../constants.js';
import { normalizePath } from '../commands/shared.js';
import type { EmbeddingModel } from './model-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_EMBEDDING_COLUMNS: Array<{ name: string; ddl: string }> = [
    { name: 'embedding_model_id', ddl: 'TEXT' },
    { name: 'embedding_dim', ddl: 'INTEGER' },
    { name: 'embedding_version', ddl: 'INTEGER' },
    { name: 'last_full_embed_at', ddl: 'INTEGER' },
    { name: 'files_changed_since', ddl: 'INTEGER NOT NULL DEFAULT 0' },
    // LLM-layer columns (v1.25). Privacy default: send_code=0 (off).
    { name: 'llm_endpoint', ddl: 'TEXT' },
    { name: 'llm_model', ddl: 'TEXT' },
    { name: 'llm_send_code', ddl: 'INTEGER NOT NULL DEFAULT 0' },
];

// ============================================================
// Singleton DB connection — sqlite-vec lives on a single connection.
// Other parts of AiDex still use openGlobalDatabase() which opens new
// connections; that's fine because they don't run vector queries.
// ============================================================

let _db: Database.Database | null = null;
let _vecLoaded = false;

function getDb(): Database.Database {
    if (_db) return _db;
    const dbPath = join(homedir(), '.aidex', 'global.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    _db = db;
    return db;
}

/** Test/teardown helper — closes the embeddings connection. */
export function _closeEmbeddingsDb(): void {
    if (_db) {
        try { _db.close(); } catch { /* ignore */ }
        _db = null;
        _vecLoaded = false;
    }
}

/**
 * Internal accessor for search.ts — returns the singleton DB with sqlite-vec
 * loaded. Throws if vec isn't ready yet (caller must call ensureVecTable first
 * via the pipeline).
 */
export function _searchDbAccessor(): Database.Database {
    return getDb();
}

// ============================================================
// Schema migration
// ============================================================

export function ensureEmbeddingsSchema(): void {
    const db = getDb();

    const schemaPath = resolveSchemaPath();
    const sql = readFileSync(schemaPath, 'utf-8');
    db.exec(sql);

    const cols = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
    const have = new Set(cols.map(c => c.name));
    for (const col of PROJECT_EMBEDDING_COLUMNS) {
        if (!have.has(col.name)) {
            db.exec(`ALTER TABLE projects ADD COLUMN ${col.name} ${col.ddl}`);
        }
    }
}

function resolveSchemaPath(): string {
    return join(__dirname, 'schema.sql');
}

// ============================================================
// vec0 virtual table — lazy load of sqlite-vec
// ============================================================

export async function ensureVecTable(dim: number): Promise<void> {
    const db = getDb();

    if (!_vecLoaded) {
        try {
            const sqliteVec = await import('sqlite-vec');
            sqliteVec.load(db);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(
                `sqlite-vec is not installed. Run: npm install --save-optional sqlite-vec\nOriginal: ${msg}`
            );
        }
        _vecLoaded = true;
    }

    const tableName = `vec_embeddings_${dim}`;
    db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(embedding FLOAT[${dim}])`
    );
}

export function vecTableName(dim: number): string {
    return `vec_embeddings_${dim}`;
}

// ============================================================
// Project enable/disable
// ============================================================

export function markProjectEnabled(projectPath: string, model: EmbeddingModel): void {
    const db = getDb();
    const normPath = normalizePath(projectPath);

    const row = db.prepare('SELECT id FROM projects WHERE path = ?').get(normPath) as
        | { id: number }
        | undefined;

    if (!row) {
        return;
    }

    db.prepare(
        `UPDATE projects
         SET embedding_model_id = ?, embedding_dim = ?, embedding_version = ?
         WHERE id = ?`
    ).run(model.id, model.dim, model.version, row.id);
}

export function isProjectEnabled(projectPath: string): boolean {
    const db = getDb();
    const row = db.prepare(
        'SELECT embedding_model_id FROM projects WHERE path = ?'
    ).get(normalizePath(projectPath)) as { embedding_model_id: string | null } | undefined;
    return !!row?.embedding_model_id;
}

export function getEnabledProjectIds(): number[] {
    const db = getDb();
    const rows = db.prepare(
        'SELECT id FROM projects WHERE embedding_model_id IS NOT NULL'
    ).all() as Array<{ id: number }>;
    return rows.map(r => r.id);
}

export function getEnabledProjectsWithModel(modelId: string): ProjectEmbeddingInfo[] {
    const db = getDb();
    const rows = db
        .prepare(
            `SELECT id, path, name, embedding_model_id, embedding_dim, embedding_version
             FROM projects WHERE embedding_model_id = ?`
        )
        .all(modelId) as Array<{
        id: number;
        path: string;
        name: string;
        embedding_model_id: string;
        embedding_dim: number;
        embedding_version: number | null;
    }>;
    return rows.map(r => ({
        id: r.id,
        path: r.path,
        name: r.name,
        modelId: r.embedding_model_id,
        dim: r.embedding_dim,
        version: r.embedding_version ?? 1,
    }));
}

/**
 * Wipe every embedding row + vec0 entry for a project. Used by migrate().
 */
export async function wipeProjectEmbeddings(project: ProjectEmbeddingInfo): Promise<number> {
    await ensureVecTable(project.dim);
    const db = getDb();
    const oldVec = vecTableName(project.dim);
    const rows = db.prepare('SELECT id FROM embeddings WHERE project_id = ?').all(project.id) as Array<{ id: number }>;
    db.transaction(() => {
        for (const r of rows) {
            db.prepare(`DELETE FROM ${oldVec} WHERE rowid = ?`).run(BigInt(r.id));
        }
        db.prepare('DELETE FROM embeddings WHERE project_id = ?').run(project.id);
    })();
    return rows.length;
}

export interface ProjectEmbeddingInfo {
    id: number;
    path: string;
    name: string;
    modelId: string;
    dim: number;
    version: number;
}

export function getProjectInfo(projectPath: string): ProjectEmbeddingInfo | null {
    const db = getDb();
    const row = db
        .prepare(
            `SELECT id, path, name, embedding_model_id, embedding_dim, embedding_version
             FROM projects WHERE path = ?`
        )
        .get(normalizePath(projectPath)) as
        | {
              id: number;
              path: string;
              name: string;
              embedding_model_id: string | null;
              embedding_dim: number | null;
              embedding_version: number | null;
          }
        | undefined;
    if (!row || !row.embedding_model_id || !row.embedding_dim) return null;
    return {
        id: row.id,
        path: row.path,
        name: row.name,
        modelId: row.embedding_model_id,
        dim: row.embedding_dim,
        version: row.embedding_version ?? 1,
    };
}

// ============================================================
// Reading from a project's local index.db
// ============================================================

export interface MethodForEmbedding {
    methodId: number;
    name: string;
    prototype: string;
    filePath: string;
    lineNumber: number;
    bodyText: string | null;
    bodyLines: number | null;
    docComment: string | null; // currently unused — header comments are file-level
}

export interface TypeForEmbedding {
    typeId: number;
    name: string;
    kind: string;
    filePath: string;
    lineNumber: number;
}

export interface IndexedFile {
    fileId: number;
    path: string;
}

export interface IndexDbHandle {
    db: Database.Database;
    close(): void;
}

export function openProjectIndexDb(projectPath: string): IndexDbHandle | null {
    const dbPath = join(projectPath, INDEX_DIR, 'index.db');
    if (!existsSync(dbPath)) return null;

    // Pre-migrate: legacy DBs may lack columns the embedder reads.
    // Open writable briefly, run idempotent ALTER TABLEs, then reopen readonly.
    // Best-effort: if the write-open fails (DB locked by a concurrent writer,
    // read-only filesystem, etc.) the read paths below are defensive.
    try {
        const writeDb = new Database(dbPath);
        try {
            const tableCols = (table: string) =>
                new Set<string>(
                    (writeDb.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
                        .map(r => r.name)
                );
            const methodCols = tableCols('methods');
            if (methodCols.size > 0) {
                if (!methodCols.has('body_text')) writeDb.exec("ALTER TABLE methods ADD COLUMN body_text TEXT");
                if (!methodCols.has('body_lines')) writeDb.exec("ALTER TABLE methods ADD COLUMN body_lines INTEGER");
                if (!methodCols.has('body_truncated')) writeDb.exec("ALTER TABLE methods ADD COLUMN body_truncated INTEGER DEFAULT 0");
            }
            const taskCols = tableCols('tasks');
            if (taskCols.size > 0 && !taskCols.has('summary')) {
                writeDb.exec('ALTER TABLE tasks ADD COLUMN summary TEXT');
            }
            const noteHistoryCols = tableCols('note_history');
            if (noteHistoryCols.size > 0 && !noteHistoryCols.has('summary')) {
                writeDb.exec('ALTER TABLE note_history ADD COLUMN summary TEXT');
            }
        } finally {
            writeDb.close();
        }
    } catch {
        // Ignore — read paths handle missing columns defensively
    }

    const db = new Database(dbPath, { readonly: true });
    return { db, close: () => db.close() };
}

function methodsHasBodyText(handle: IndexDbHandle): boolean {
    const cols = handle.db.prepare("PRAGMA table_info(methods)").all() as Array<{ name: string }>;
    return cols.some(c => c.name === 'body_text');
}

export function readMethods(handle: IndexDbHandle): MethodForEmbedding[] {
    const bodySelect = methodsHasBodyText(handle)
        ? 'm.body_text as bodyText, m.body_lines as bodyLines'
        : 'NULL as bodyText, NULL as bodyLines';
    const rows = handle.db
        .prepare(
            `SELECT m.id as methodId, m.name, m.prototype, m.line_number as lineNumber,
                    ${bodySelect},
                    f.path as filePath
             FROM methods m JOIN files f ON m.file_id = f.id
             ORDER BY f.path, m.line_number`
        )
        .all() as Array<Omit<MethodForEmbedding, 'docComment'>>;
    return rows.map(r => ({ ...r, docComment: null }));
}

export function readTypes(handle: IndexDbHandle): TypeForEmbedding[] {
    return handle.db
        .prepare(
            `SELECT t.id as typeId, t.name, t.kind, t.line_number as lineNumber,
                    f.path as filePath
             FROM types t JOIN files f ON t.file_id = f.id
             ORDER BY f.path, t.line_number`
        )
        .all() as TypeForEmbedding[];
}

/**
 * Identifiers occurring within a method's body lines, with usage counts.
 * Built from the existing items/occurrences/lines tables — no extra extraction.
 */
export function readMethodIdentifiers(
    handle: IndexDbHandle,
    filePath: string,
    startLine: number,
    endLine: number
): Map<string, number> {
    const rows = handle.db
        .prepare(
            `SELECT i.term as term, COUNT(*) as cnt
             FROM occurrences o
             JOIN items i ON o.item_id = i.id
             JOIN lines l ON o.line_id = l.id AND o.file_id = l.file_id
             JOIN files f ON o.file_id = f.id
             WHERE f.path = ? AND l.line_number BETWEEN ? AND ?
             GROUP BY i.term`
        )
        .all(filePath, startLine, endLine) as Array<{ term: string; cnt: number }>;
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.term, r.cnt);
    return map;
}

/**
 * Identifiers occurring within ±2 lines of a type definition.
 * Heuristic: types don't have bodies in our index, so we approximate.
 */
export function readTypeIdentifiers(
    handle: IndexDbHandle,
    filePath: string,
    line: number
): Map<string, number> {
    return readMethodIdentifiers(handle, filePath, line, line + 2);
}

// ============================================================
// Workspace readers (tasks / notes / history)
// ============================================================

export interface TaskForEmbedding {
    id: number;
    title: string;
    description: string | null;
    summary: string | null;
    tags: string | null;
    status: string;
    priority: number;
    updated_at: number;
}

export interface TaskLogForEmbedding {
    id: number;
    task_id: number;
    task_title: string;
    note: string;
    created_at: number;
}

export interface NoteHistoryForEmbedding {
    id: number;
    note: string;
    summary: string | null;
    created_at: number;
}

const SESSION_NOTE_KEY = 'session_note';

function tableHasColumn(handle: IndexDbHandle, table: string, column: string): boolean {
    try {
        const cols = handle.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        return cols.some(c => c.name === column);
    } catch {
        return false;
    }
}

export function readAllTasks(handle: IndexDbHandle): TaskForEmbedding[] {
    const summaryCol = tableHasColumn(handle, 'tasks', 'summary') ? 'summary' : 'NULL as summary';
    return handle.db
        .prepare(
            `SELECT id, title, description, ${summaryCol}, tags, status, priority, updated_at
             FROM tasks ORDER BY id`
        )
        .all() as TaskForEmbedding[];
}

export function readTaskById(handle: IndexDbHandle, id: number): TaskForEmbedding | null {
    const summaryCol = tableHasColumn(handle, 'tasks', 'summary') ? 'summary' : 'NULL as summary';
    const row = handle.db
        .prepare(
            `SELECT id, title, description, ${summaryCol}, tags, status, priority, updated_at
             FROM tasks WHERE id = ?`
        )
        .get(id) as TaskForEmbedding | undefined;
    return row ?? null;
}

export function readAllTaskLogs(handle: IndexDbHandle): TaskLogForEmbedding[] {
    return handle.db
        .prepare(
            `SELECT tl.id, tl.task_id, t.title as task_title, tl.note, tl.created_at
             FROM task_log tl JOIN tasks t ON tl.task_id = t.id
             ORDER BY tl.id`
        )
        .all() as TaskLogForEmbedding[];
}

export function readTaskLogsByTask(handle: IndexDbHandle, taskId: number): TaskLogForEmbedding[] {
    return handle.db
        .prepare(
            `SELECT tl.id, tl.task_id, t.title as task_title, tl.note, tl.created_at
             FROM task_log tl JOIN tasks t ON tl.task_id = t.id
             WHERE tl.task_id = ? ORDER BY tl.id`
        )
        .all(taskId) as TaskLogForEmbedding[];
}

export function readSessionNote(handle: IndexDbHandle): string | null {
    const row = handle.db
        .prepare('SELECT value FROM metadata WHERE key = ?')
        .get(SESSION_NOTE_KEY) as { value: string | null } | undefined;
    return row?.value ?? null;
}

export function readNoteHistory(handle: IndexDbHandle): NoteHistoryForEmbedding[] {
    const summaryCol = tableHasColumn(handle, 'note_history', 'summary') ? 'summary' : 'NULL as summary';
    return handle.db
        .prepare(
            `SELECT id, note, ${summaryCol}, created_at FROM note_history ORDER BY id`
        )
        .all() as NoteHistoryForEmbedding[];
}

// ============================================================
// Doc files (Markdown discovery + read)
// ============================================================

export interface DocFile {
    path: string;        // relative to project root
    absPath: string;     // absolute path on disk
}

/**
 * Markdown / text-doc files belonging to the project.
 * Reads from `project_files` (populated by aidex_init).
 */
export function listDocFiles(handle: IndexDbHandle, projectPath: string): DocFile[] {
    const rows = handle.db
        .prepare(`SELECT path FROM project_files WHERE type = 'doc' ORDER BY path`)
        .all() as Array<{ path: string }>;
    const out: DocFile[] = [];
    for (const r of rows) {
        if (!isIndexableDoc(r.path)) continue;
        out.push({ path: r.path, absPath: join(projectPath, r.path) });
    }
    return out;
}

function isIndexableDoc(p: string): boolean {
    const lower = p.toLowerCase();
    return lower.endsWith('.md') || lower.endsWith('.mdx') || lower.endsWith('.markdown');
}

export function readDocFile(absPath: string): string | null {
    if (!existsSync(absPath)) return null;
    try {
        return readFileSync(absPath, 'utf-8');
    } catch {
        return null;
    }
}

// ============================================================
// Writing embeddings to global.db
// ============================================================

export interface EmbeddingWrite {
    sourceType: string;
    sourceKind: 'code' | 'docs' | 'workspace';
    sourcePath: string | null;
    sourceAnchor: string | null;
    sourceName: string | null;
    sourceLine: number | null;
    /** Human-readable snippet stored in DB (what the viewer shows). */
    sourceText: string;
    /**
     * Text actually fed to the embedding model. Optional — defaults to sourceText
     * when the two are identical (e.g. workspace, docs). Code chunks set this
     * separately so the display text can omit weighted-repetition noise.
     */
    embeddingText?: string;
    contentHash: string;
    isPrivate: boolean;
    embedding: Float32Array;
}

const SNIPPET_MAX = 500;

function snippet(text: string): string {
    if (text.length <= SNIPPET_MAX) return text;
    return text.slice(0, SNIPPET_MAX - 3) + '...';
}

export interface BulkWriteResult {
    inserted: number;
    skipped: number;
}

/**
 * Insert or replace an embedding row + its vector.
 * Returns the embeddings.id.
 */
export async function bulkUpsertEmbeddings(
    project: ProjectEmbeddingInfo,
    items: EmbeddingWrite[]
): Promise<BulkWriteResult> {
    if (items.length === 0) return { inserted: 0, skipped: 0 };

    await ensureVecTable(project.dim);
    const db = getDb();
    const vec = vecTableName(project.dim);

    const findExisting = db.prepare(
        `SELECT id, content_hash FROM embeddings
         WHERE project_id = ? AND source_type = ? AND source_path IS ? AND source_anchor IS ?`
    );
    const insertMeta = db.prepare(
        `INSERT INTO embeddings
         (project_id, project_path, source_type, source_kind, source_path, source_anchor,
          source_name, source_line, source_text, content_hash, is_private,
          model_id, dim, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const updateMeta = db.prepare(
        `UPDATE embeddings
         SET source_kind=?, source_name=?, source_line=?, source_text=?, content_hash=?,
             is_private=?, model_id=?, dim=?, updated_at=?
         WHERE id = ?`
    );
    const deleteVec = db.prepare(`DELETE FROM ${vec} WHERE rowid = ?`);
    const insertVec = db.prepare(`INSERT INTO ${vec}(rowid, embedding) VALUES (?, ?)`);

    let inserted = 0;
    let skipped = 0;
    const now = Date.now();

    const runAll = db.transaction((batch: EmbeddingWrite[]) => {
        for (const it of batch) {
            const existing = findExisting.get(
                project.id,
                it.sourceType,
                it.sourcePath,
                it.sourceAnchor
            ) as { id: number; content_hash: string } | undefined;

            if (existing && existing.content_hash === it.contentHash) {
                skipped++;
                continue;
            }

            const buf = Buffer.from(it.embedding.buffer, it.embedding.byteOffset, it.embedding.byteLength);

            if (existing) {
                updateMeta.run(
                    it.sourceKind,
                    it.sourceName,
                    it.sourceLine,
                    snippet(it.sourceText),
                    it.contentHash,
                    it.isPrivate ? 1 : 0,
                    project.modelId,
                    project.dim,
                    now,
                    existing.id
                );
                // vec0 requires BigInt rowids — Number triggers an "integers only" error.
                const rowidBig = BigInt(existing.id);
                deleteVec.run(rowidBig);
                insertVec.run(rowidBig, buf);
            } else {
                const res = insertMeta.run(
                    project.id,
                    project.path,
                    it.sourceType,
                    it.sourceKind,
                    it.sourcePath,
                    it.sourceAnchor,
                    it.sourceName,
                    it.sourceLine,
                    snippet(it.sourceText),
                    it.contentHash,
                    it.isPrivate ? 1 : 0,
                    project.modelId,
                    project.dim,
                    now,
                    now
                );
                insertVec.run(BigInt(res.lastInsertRowid), buf);
            }
            inserted++;
        }
    });

    runAll(items);
    return { inserted, skipped };
}

export function setLastFullEmbedAt(projectId: number, ts: number): void {
    getDb().prepare('UPDATE projects SET last_full_embed_at = ? WHERE id = ?').run(ts, projectId);
}

export function countProjectEmbeddings(projectId: number): number {
    const row = getDb()
        .prepare('SELECT COUNT(*) as n FROM embeddings WHERE project_id = ?')
        .get(projectId) as { n: number };
    return row.n;
}

export function totalEmbeddings(): number {
    const row = getDb().prepare('SELECT COUNT(*) as n FROM embeddings').get() as { n: number };
    return row.n;
}

export interface ProjectEmbeddingBreakdown {
    total: number;
    byKind: Record<string, number>;
    byType: Record<string, number>;
}

export function getProjectEmbeddingBreakdown(projectId: number): ProjectEmbeddingBreakdown {
    const db = getDb();
    const total = (db.prepare('SELECT COUNT(*) as n FROM embeddings WHERE project_id = ?').get(projectId) as { n: number }).n;
    const kindRows = db
        .prepare('SELECT source_kind as k, COUNT(*) as n FROM embeddings WHERE project_id = ? GROUP BY source_kind')
        .all(projectId) as Array<{ k: string; n: number }>;
    const typeRows = db
        .prepare('SELECT source_type as t, COUNT(*) as n FROM embeddings WHERE project_id = ? GROUP BY source_type')
        .all(projectId) as Array<{ t: string; n: number }>;
    const byKind: Record<string, number> = {};
    const byType: Record<string, number> = {};
    for (const r of kindRows) byKind[r.k] = r.n;
    for (const r of typeRows) byType[r.t] = r.n;
    return { total, byKind, byType };
}

/**
 * Delete one embedding (and its vec0 row) by primary key fields.
 * Returns true if a row was deleted.
 */
export async function deleteEmbeddingByAnchor(
    project: ProjectEmbeddingInfo,
    sourceType: string,
    sourceAnchor: string,
    sourcePath: string | null = null
): Promise<boolean> {
    await ensureVecTable(project.dim);
    const db = getDb();
    const vec = vecTableName(project.dim);

    const row = db
        .prepare(
            `SELECT id FROM embeddings
             WHERE project_id = ? AND source_type = ? AND source_anchor = ? AND source_path IS ?`
        )
        .get(project.id, sourceType, sourceAnchor, sourcePath) as { id: number } | undefined;
    if (!row) return false;

    const rowidBig = BigInt(row.id);
    db.transaction(() => {
        db.prepare(`DELETE FROM ${vec} WHERE rowid = ?`).run(rowidBig);
        db.prepare('DELETE FROM embeddings WHERE id = ?').run(row.id);
    })();
    return true;
}

/**
 * Delete all embeddings whose source_anchor starts with the given prefix
 * (optionally filtered by source_type). Used to remove all embeddings
 * tied to a specific entity (e.g., all `task-log` rows for one task)
 * without touching embeddings of unrelated entities.
 * Returns the number of deleted rows.
 */
export async function deleteEmbeddingsByAnchorPrefix(
    project: ProjectEmbeddingInfo,
    sourceAnchorPrefix: string,
    sourceType: string | null = null
): Promise<number> {
    await ensureVecTable(project.dim);
    const db = getDb();
    const vec = vecTableName(project.dim);

    const sql = sourceType
        ? `SELECT id FROM embeddings
           WHERE project_id = ? AND source_type = ? AND source_anchor LIKE ?`
        : `SELECT id FROM embeddings
           WHERE project_id = ? AND source_anchor LIKE ?`;
    const likePattern = sourceAnchorPrefix + '%';
    const rows = (sourceType
        ? db.prepare(sql).all(project.id, sourceType, likePattern)
        : db.prepare(sql).all(project.id, likePattern)) as Array<{ id: number }>;

    let deleted = 0;
    db.transaction(() => {
        for (const r of rows) {
            db.prepare(`DELETE FROM ${vec} WHERE rowid = ?`).run(BigInt(r.id));
            db.prepare('DELETE FROM embeddings WHERE id = ?').run(r.id);
            deleted++;
        }
    })();
    return deleted;
}

/**
 * Delete embeddings whose anchors are NOT in `keepAnchors` for the given source_type.
 * Used after re-indexing workspace items: any task that disappeared gets its
 * embedding pruned. Returns the number of pruned rows.
 */
export async function pruneEmbeddingsByType(
    project: ProjectEmbeddingInfo,
    sourceType: string,
    keepAnchors: Set<string>
): Promise<number> {
    await ensureVecTable(project.dim);
    const db = getDb();
    const vec = vecTableName(project.dim);

    const stale = db
        .prepare(
            `SELECT id FROM embeddings WHERE project_id = ? AND source_type = ?`
        )
        .all(project.id, sourceType) as Array<{ id: number; }>;

    let pruned = 0;
    db.transaction(() => {
        for (const r of stale) {
            // We can't filter by anchor in SQL because keepAnchors is in JS.
            // Pull anchor for each row and decide.
            const a = db.prepare('SELECT source_anchor FROM embeddings WHERE id = ?').get(r.id) as
                | { source_anchor: string | null }
                | undefined;
            if (!a || !a.source_anchor) continue;
            if (keepAnchors.has(a.source_anchor)) continue;
            db.prepare(`DELETE FROM ${vec} WHERE rowid = ?`).run(BigInt(r.id));
            db.prepare('DELETE FROM embeddings WHERE id = ?').run(r.id);
            pruned++;
        }
    })();
    return pruned;
}

/**
 * Delete all embeddings (and their vec0 rows) for a given file path within a project.
 * Used by removeFile() and as a precursor to updateFile().
 * Returns the number of deleted rows.
 */
export async function deleteEmbeddingsByFile(
    project: ProjectEmbeddingInfo,
    filePath: string
): Promise<number> {
    await ensureVecTable(project.dim);
    const db = getDb();
    const vec = vecTableName(project.dim);

    const rows = db
        .prepare(
            `SELECT id FROM embeddings WHERE project_id = ? AND source_path = ?`
        )
        .all(project.id, filePath) as Array<{ id: number }>;

    if (rows.length === 0) return 0;

    db.transaction(() => {
        for (const r of rows) {
            db.prepare(`DELETE FROM ${vec} WHERE rowid = ?`).run(BigInt(r.id));
            db.prepare('DELETE FROM embeddings WHERE id = ?').run(r.id);
        }
    })();
    return rows.length;
}

/**
 * Prune file-scoped embeddings (code/docs) whose anchors aren't in keepAnchors.
 * Used by updateFile() to drop methods/types/sections that disappeared.
 */
export async function pruneFileEmbeddingsExcept(
    project: ProjectEmbeddingInfo,
    filePath: string,
    keepAnchors: Set<string>
): Promise<number> {
    await ensureVecTable(project.dim);
    const db = getDb();
    const vec = vecTableName(project.dim);

    const rows = db
        .prepare(
            `SELECT id, source_anchor FROM embeddings
             WHERE project_id = ? AND source_path = ?`
        )
        .all(project.id, filePath) as Array<{ id: number; source_anchor: string | null }>;

    let pruned = 0;
    db.transaction(() => {
        for (const r of rows) {
            if (r.source_anchor && keepAnchors.has(r.source_anchor)) continue;
            db.prepare(`DELETE FROM ${vec} WHERE rowid = ?`).run(BigInt(r.id));
            db.prepare('DELETE FROM embeddings WHERE id = ?').run(r.id);
            pruned++;
        }
    })();
    return pruned;
}

/** Read methods+types limited to one file path. Mirrors readMethods/readTypes. */
export function readMethodsForFile(handle: IndexDbHandle, filePath: string): MethodForEmbedding[] {
    const bodySelect = methodsHasBodyText(handle)
        ? 'm.body_text as bodyText, m.body_lines as bodyLines'
        : 'NULL as bodyText, NULL as bodyLines';
    const rows = handle.db
        .prepare(
            `SELECT m.id as methodId, m.name, m.prototype, m.line_number as lineNumber,
                    ${bodySelect},
                    f.path as filePath
             FROM methods m JOIN files f ON m.file_id = f.id
             WHERE f.path = ?
             ORDER BY m.line_number`
        )
        .all(filePath) as Array<Omit<MethodForEmbedding, 'docComment'>>;
    return rows.map(r => ({ ...r, docComment: null }));
}

export function readTypesForFile(handle: IndexDbHandle, filePath: string): TypeForEmbedding[] {
    return handle.db
        .prepare(
            `SELECT t.id as typeId, t.name, t.kind, t.line_number as lineNumber,
                    f.path as filePath
             FROM types t JOIN files f ON t.file_id = f.id
             WHERE f.path = ?
             ORDER BY t.line_number`
        )
        .all(filePath) as TypeForEmbedding[];
}

/** Bump files_changed_since for stale-detection. */
export function bumpFilesChanged(projectId: number, by: number = 1): void {
    getDb()
        .prepare('UPDATE projects SET files_changed_since = COALESCE(files_changed_since, 0) + ? WHERE id = ?')
        .run(by, projectId);
}

export function getFilesChangedSince(projectId: number): number {
    const row = getDb()
        .prepare('SELECT files_changed_since FROM projects WHERE id = ?')
        .get(projectId) as { files_changed_since: number | null } | undefined;
    return row?.files_changed_since ?? 0;
}

export function resetFilesChanged(projectId: number): void {
    getDb().prepare('UPDATE projects SET files_changed_since = 0 WHERE id = ?').run(projectId);
}

export function getLastFullEmbedAt(projectId: number): number | null {
    const row = getDb()
        .prepare('SELECT last_full_embed_at FROM projects WHERE id = ?')
        .get(projectId) as { last_full_embed_at: number | null } | undefined;
    return row?.last_full_embed_at ?? null;
}

/**
 * Prune doc-section embeddings whose (source_path, source_anchor) pair is not in keepKeys.
 * Used after re-indexing docs — removed sections / deleted files vanish.
 * Returns the number of pruned rows.
 */
export async function pruneDocSectionsExcept(
    project: ProjectEmbeddingInfo,
    keepKeys: Set<string>
): Promise<number> {
    await ensureVecTable(project.dim);
    const db = getDb();
    const vec = vecTableName(project.dim);

    const rows = db
        .prepare(
            `SELECT id, source_path, source_anchor FROM embeddings
             WHERE project_id = ? AND source_type = 'doc-section'`
        )
        .all(project.id) as Array<{ id: number; source_path: string | null; source_anchor: string | null }>;

    let pruned = 0;
    db.transaction(() => {
        for (const r of rows) {
            const key = `${r.source_path ?? ''}::${r.source_anchor ?? ''}`;
            if (keepKeys.has(key)) continue;
            db.prepare(`DELETE FROM ${vec} WHERE rowid = ?`).run(BigInt(r.id));
            db.prepare('DELETE FROM embeddings WHERE id = ?').run(r.id);
            pruned++;
        }
    })();
    return pruned;
}

export function readExistingHashes(projectId: number): Map<string, string> {
    const rows = getDb()
        .prepare(
            `SELECT source_type, source_path, source_anchor, content_hash
             FROM embeddings WHERE project_id = ?`
        )
        .all(projectId) as Array<{
        source_type: string;
        source_path: string | null;
        source_anchor: string | null;
        content_hash: string;
    }>;
    const map = new Map<string, string>();
    for (const r of rows) {
        const key = `${r.source_type}:${r.source_path ?? ''}:${r.source_anchor ?? ''}`;
        map.set(key, r.content_hash);
    }
    return map;
}
