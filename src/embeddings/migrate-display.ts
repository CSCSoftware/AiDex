/**
 * One-shot migration: regenerate `source_text` for all code-kind embeddings
 * using the new display format (with parenthesized counts) — without touching
 * the actual vectors. Run after upgrading to a build that splits embeddingText
 * from displayText.
 *
 * Usage (from build):
 *   node -e "import('./build/embeddings/migrate-display.js').then(m => m.migrateDisplayText())"
 */

import { join } from 'path';
import Database from 'better-sqlite3';

import { INDEX_DIR } from '../constants.js';
import { chunkCode } from './chunker.js';
import {
    _searchDbAccessor,
    ensureEmbeddingsSchema,
    readMethodIdentifiers,
    readTypeIdentifiers,
    type IndexDbHandle,
} from './store.js';

interface CodeRow {
    id: number;
    project_id: number;
    project_path: string;
    source_type: string;
    source_path: string | null;
    source_anchor: string | null;
    source_name: string | null;
    source_line: number | null;
}

const SNIPPET_MAX = 500;
function snippet(text: string): string {
    if (text.length <= SNIPPET_MAX) return text;
    return text.slice(0, SNIPPET_MAX - 3) + '...';
}

export interface MigrationStats {
    scanned: number;
    rewritten: number;
    skippedNoBody: number;
    skippedNoIndex: number;
}

/**
 * Walks every code-kind embedding (source_kind = 'code') and rewrites its
 * source_text using the project's local index.db + new chunker output.
 * Vectors are untouched.
 */
export function migrateDisplayText(): MigrationStats {
    ensureEmbeddingsSchema();
    const db = _searchDbAccessor();

    const rows = db
        .prepare(
            `SELECT id, project_id, project_path, source_type,
                    source_path, source_anchor, source_name, source_line
             FROM embeddings
             WHERE source_kind = 'code'`
        )
        .all() as CodeRow[];

    const stats: MigrationStats = {
        scanned: rows.length,
        rewritten: 0,
        skippedNoBody: 0,
        skippedNoIndex: 0,
    };

    // Group by project path so we open each local index.db once.
    const byProject = new Map<string, CodeRow[]>();
    for (const r of rows) {
        if (!byProject.has(r.project_path)) byProject.set(r.project_path, []);
        byProject.get(r.project_path)!.push(r);
    }

    const updateStmt = db.prepare('UPDATE embeddings SET source_text = ? WHERE id = ?');

    for (const [projectPath, projectRows] of byProject) {
        const idxPath = join(projectPath, INDEX_DIR, 'index.db');
        let local: Database.Database;
        try {
            local = new Database(idxPath, { readonly: true });
        } catch {
            stats.skippedNoIndex += projectRows.length;
            continue;
        }
        const handle: IndexDbHandle = { db: local, close: () => local.close() };

        try {
            // Pre-load methods and types maps for fast lookup.
            const methodMap = buildMethodMap(local);
            const typeMap = buildTypeMap(local);

            db.transaction(() => {
                for (const r of projectRows) {
                    const result = rewriteRow(r, handle, methodMap, typeMap);
                    if (result === null) {
                        stats.skippedNoBody++;
                        continue;
                    }
                    updateStmt.run(snippet(result), r.id);
                    stats.rewritten++;
                }
            })();
        } finally {
            handle.close();
        }
    }

    return stats;
}

interface MethodInfo {
    name: string;
    prototype: string;
    line_number: number;
    body_text: string | null;
    body_lines: number | null;
    file_path: string;
}

interface TypeInfo {
    name: string;
    kind: string;
    line_number: number;
    file_path: string;
}

function buildMethodMap(db: Database.Database): Map<string, MethodInfo> {
    const rows = db
        .prepare(
            `SELECT m.name, m.prototype, m.line_number, m.body_text, m.body_lines,
                    f.path as file_path
             FROM methods m JOIN files f ON m.file_id = f.id`
        )
        .all() as Array<{
        name: string;
        prototype: string;
        line_number: number;
        body_text: string | null;
        body_lines: number | null;
        file_path: string;
    }>;
    const map = new Map<string, MethodInfo>();
    for (const r of rows) {
        const key = `method:${r.name}@${r.line_number}::${r.file_path}`;
        map.set(key, r);
    }
    return map;
}

function buildTypeMap(db: Database.Database): Map<string, TypeInfo> {
    const rows = db
        .prepare(
            `SELECT t.name, t.kind, t.line_number, f.path as file_path
             FROM types t JOIN files f ON t.file_id = f.id`
        )
        .all() as TypeInfo[];
    const map = new Map<string, TypeInfo>();
    for (const r of rows) {
        const key = `type:${r.name}@${r.line_number}::${r.file_path}`;
        map.set(key, r);
    }
    return map;
}

function rewriteRow(
    row: CodeRow,
    handle: IndexDbHandle,
    methodMap: Map<string, MethodInfo>,
    typeMap: Map<string, TypeInfo>
): string | null {
    if (!row.source_anchor || !row.source_path) return null;
    const key = `${row.source_anchor}::${row.source_path}`;

    if (row.source_type === 'method') {
        const m = methodMap.get(key);
        if (!m) return null;
        const startLine = m.line_number;
        const endLine = m.line_number + (m.body_lines ?? 1) - 1;
        const identifiers = readMethodIdentifiers(handle, m.file_path, startLine, endLine);
        const chunk = chunkCode({
            name: m.name,
            signature: m.prototype,
            docComment: null,
            bodyText: m.body_text,
            identifiers,
        });
        return chunk.displayText;
    }

    if (row.source_type === 'type') {
        const t = typeMap.get(key);
        if (!t) return null;
        const identifiers = readTypeIdentifiers(handle, t.file_path, t.line_number);
        const chunk = chunkCode({
            name: t.name,
            signature: `${t.kind} ${t.name}`,
            identifiers,
        });
        return chunk.displayText;
    }

    return null;
}
