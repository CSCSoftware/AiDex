/**
 * changes command - Compact, deterministic "work state since <time>" report
 *
 * Meant for coding agents that compact their conversation: before compacting they ask
 * what really changed in the project since a point in time and put the answer into the
 * fresh context. Output is metadata only - file status, structural delta (methods/types
 * added, removed, signature changed), new comment texts, task activity and whether the
 * session note changed. Never code lines.
 *
 * Sources:
 * - files.last_indexed / lines.modified (existing index)
 * - change_log (structural delta recorded at re-index time, see db/change-log.ts)
 * - tasks / task_log, note_history + metadata session_note_updated_at
 */

import { existsSync, readFileSync } from 'fs';
import { extname, join } from 'path';

import type Database from 'better-sqlite3';
import { openDatabase, createQueries } from '../db/index.js';
import { getChangeLogSince, netStructureChanges, recordFileDeleted, type ChangeLogRow, type StructureChange } from '../db/change-log.js';
import { parseTimeOffset } from './query.js';
import { validateIndex, noIndexError, withDatabase } from './shared.js';
import { detectExternalChanges } from './session.js';
import { update } from './update.js';
import { NOTE_UPDATED_KEY } from './note.js';

// ============================================================
// Types
// ============================================================

export type ChangesFormat = 'text' | 'json';

export interface ChangesParams {
    path: string;
    since: string;            // "30m", "2h", "1d", "1w", ISO date or epoch ms
    maxFiles?: number;        // default 40
    maxComments?: number;     // default 15
    format?: ChangesFormat;   // default 'text'
    refresh?: boolean;        // re-index files changed on disk first (default true)
}

export type ChangedFileStatus = 'new' | 'modified' | 'deleted';

export interface ChangedFileInfo {
    path: string;
    status: ChangedFileStatus;
    lastChange: number;
    changes: StructureChange[];
}

export interface ChangedComment {
    file: string;
    line: number;
    text: string;
    modified: number;
}

export interface ChangedTask {
    id: number;
    title: string;
    status: string;
    events: string[];          // created | done | cancelled | updated | logged
    lastActivity: number;
    log: Array<{ time: number; text: string }>;
}

export interface ChangesData {
    since: number;
    files: ChangedFileInfo[];
    filesOmitted: number;
    comments: ChangedComment[];
    commentsOmitted: number;
    tasks: ChangedTask[];
    note: { changed: boolean; changedAt: number | null; firstLine: string | null };
    refreshed: string[];       // files re-indexed by this call (not part of the text output)
}

export interface ChangesResult {
    success: boolean;
    data?: ChangesData;
    text?: string;
    error?: string;
}

// ============================================================
// Constants
// ============================================================

export const CHANGES_TEXT_LIMIT = 6000;
const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_COMMENTS = 15;
const MAX_ITEMS_PER_FILE = 10;
const COMMENT_MAX_CHARS = 120;
const SIGNATURE_MAX_CHARS = 140;
const TASK_LOG_MAX_CHARS = 200;
const TASK_LOG_PER_TASK = 3;
const NOTE_LINE_MAX_CHARS = 160;

/** Extensions whose comments start with '#'. */
const HASH_COMMENT_EXT = new Set(['.py', '.pyw', '.rb', '.php', '.tf', '.hcl', '.sh', '.ps1', '.psm1']);

// ============================================================
// Helpers
// ============================================================

/** Parse `since`: relative ("2h"), ISO date, or epoch milliseconds. */
export function parseSince(input: string): number | null {
    if (!input) return null;
    const trimmed = input.trim();
    if (/^\d{10,}$/.test(trimmed)) return parseInt(trimmed, 10);
    return parseTimeOffset(trimmed);
}

/** ISO timestamp with minute precision, UTC (deterministic, timezone independent). */
export function fmtTime(ms: number): string {
    return new Date(ms).toISOString().slice(0, 16) + 'Z';
}

function cut(text: string, max: number): string {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? oneLine.slice(0, max - 1).trimEnd() + '…' : oneLine;
}

function cmp(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Extract the comment text of a source line, or null when the line holds no
 * comment marker. Only text after the marker is returned, so code in front of a
 * trailing comment is never included. A bare block opener ("/**", '"""') takes the
 * first text line of the block.
 */
export function extractCommentLine(
    lines: string[],
    index: number,
    ext: string
): { text: string; doc: boolean } | null {
    const line = lines[index];
    if (line === undefined) return null;

    const markers = ['//', '/*', '"""', "'''", '<!--'];
    if (HASH_COMMENT_EXT.has(ext)) markers.push('#');
    let pos = -1;
    let marker = '';
    for (const m of markers) {
        const p = line.indexOf(m);
        if (p >= 0 && (pos < 0 || p < pos)) {
            pos = p;
            marker = m;
        }
    }
    const trimmedStart = line.length - line.trimStart().length;
    if (line.trimStart().startsWith('*') && (pos < 0 || trimmedStart < pos)) {
        pos = trimmedStart;
        marker = '*';
    }
    if (pos < 0) return null;

    const rest = line.slice(pos);
    const doc = rest.startsWith('/**') || rest.startsWith('///') || rest.startsWith('//!')
        || marker === '"""' || marker === "'''";
    const isBlockOpener = marker === '/*' || marker === '"""' || marker === "'''" || marker === '<!--';

    const clean = (s: string): string => s
        .replace(/^(\/\/[\/!]?|\/\*\*?|#+|"""|'''|<!--|\*+)\s?/, '')
        .replace(/(\*\/|"""|'''|-->)\s*$/, '')
        .trim();

    let text = clean(rest);
    if (!text && isBlockOpener) {
        const closer = marker === '/*' ? '*/' : marker === '<!--' ? '-->' : marker;
        for (let i = index + 1; i < Math.min(lines.length, index + 6); i++) {
            const raw = lines[i];
            const closeAt = raw.indexOf(closer);
            const part = closeAt >= 0 ? raw.slice(0, closeAt) : raw;
            const t = part.trim().replace(/^\*+\s?/, '').trim();
            if (t) {
                text = t;
                break;
            }
            if (closeAt >= 0) break;
        }
    }
    if (!text) return null;
    return { text: cut(text, COMMENT_MAX_CHARS), doc };
}

function commentPriority(c: { text: string; doc: boolean }): number {
    if (/\b(TODO|FIXME|HACK|XXX|BUG)\b/.test(c.text)) return 0;
    return c.doc ? 1 : 2;
}

function tableExists(sqlite: Database.Database, name: string): boolean {
    return !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/**
 * Re-index files that changed on disk (same detection as a new aidex_session),
 * so the report is current even inside a running session.
 */
function refreshIndex(projectPath: string, dbPath: string): string[] {
    const modified: string[] = [];
    withDatabase(dbPath, false, (db, queries) => {
        const now = Date.now();
        for (const change of detectExternalChanges(projectPath, queries)) {
            if (change.reason === 'deleted') recordFileDeleted(db.getDb(), change.path, now, true);
            else modified.push(change.path);
        }
    });
    const refreshed: string[] = [];
    for (const file of modified) {
        const r = update({ path: projectPath, file });
        if (r.success && !r.error) refreshed.push(file);
    }
    return refreshed.sort(cmp);
}

// ============================================================
// Data collection
// ============================================================

export function collectChanges(projectPath: string, dbPath: string, since: number, maxFiles: number, maxComments: number): Omit<ChangesData, 'refreshed'> {
    const db = openDatabase(dbPath, true);
    const queries = createQueries(db);
    try {
        const sqlite = db.getDb();

        // ---- Files ------------------------------------------------
        const logRows = getChangeLogSince(sqlite, since);
        const logByFile = new Map<string, ChangeLogRow[]>();
        for (const r of logRows) {
            const list = logByFile.get(r.file);
            if (list) list.push(r);
            else logByFile.set(r.file, [r]);
        }

        const indexed = new Map<string, number>();
        for (const f of queries.getAllFiles()) indexed.set(f.path, f.last_indexed);

        const candidates = new Set<string>(logByFile.keys());
        for (const [path, lastIndexed] of indexed) {
            if (lastIndexed >= since) candidates.add(path);
        }

        const allFiles: ChangedFileInfo[] = [];
        for (const path of candidates) {
            const rows = logByFile.get(path) ?? [];
            const lastIndexed = indexed.get(path);
            let lastChange = lastIndexed !== undefined && lastIndexed >= since ? lastIndexed : 0;
            let lastFileEvent: string | null = null;
            let added = false;
            for (const r of rows) {
                if (r.time > lastChange) lastChange = r.time;
                if (r.kind === 'file_added') { added = true; lastFileEvent = r.kind; }
                if (r.kind === 'file_deleted') lastFileEvent = r.kind;
            }
            const onDisk = existsSync(join(projectPath, path));
            let status: ChangedFileStatus;
            if (!onDisk || (lastFileEvent === 'file_deleted' && lastIndexed === undefined)) status = 'deleted';
            else if (added) status = 'new';
            else status = 'modified';
            allFiles.push({ path, status, lastChange, changes: netStructureChanges(rows) });
        }
        allFiles.sort((a, b) => b.lastChange - a.lastChange || cmp(a.path, b.path));
        const files = allFiles.slice(0, maxFiles);
        const filesOmitted = allFiles.length - files.length;

        // ---- Comments ---------------------------------------------
        const commentRows = sqlite.prepare(`
            SELECT f.path AS path, l.line_number AS line, l.modified AS modified
            FROM lines l JOIN files f ON f.id = l.file_id
            WHERE l.line_type = 'comment' AND l.modified >= ?
            ORDER BY f.path, l.line_number
        `).all(since) as Array<{ path: string; line: number; modified: number }>;

        const fileRank = new Map<string, number>();
        allFiles.forEach((f, i) => fileRank.set(f.path, i));

        const found: Array<ChangedComment & { prio: number }> = [];
        let currentPath = '';
        let currentLines: string[] | null = null;
        const seenText = new Set<string>();
        for (const row of commentRows) {
            if (row.path !== currentPath) {
                currentPath = row.path;
                try {
                    currentLines = readFileSync(join(projectPath, row.path), 'utf-8').split(/\r?\n/);
                } catch {
                    currentLines = null;
                }
            }
            if (!currentLines) continue;
            const c = extractCommentLine(currentLines, row.line - 1, extname(row.path).toLowerCase());
            if (!c) continue;
            const key = `${row.path}\0${c.text}`;
            if (seenText.has(key)) continue;
            seenText.add(key);
            found.push({ file: row.path, line: row.line, text: c.text, modified: row.modified, prio: commentPriority(c) });
        }
        found.sort((a, b) =>
            a.prio - b.prio
            || (fileRank.get(a.file) ?? 1e9) - (fileRank.get(b.file) ?? 1e9)
            || cmp(a.file, b.file)
            || a.line - b.line);
        const comments = found.slice(0, maxComments).map(({ prio: _prio, ...c }) => c);
        const commentsOmitted = found.length - comments.length;

        // ---- Tasks ------------------------------------------------
        const tasks: ChangedTask[] = [];
        if (tableExists(sqlite, 'tasks')) {
            const taskRows = sqlite.prepare(`
                SELECT id, title, status, created_at, updated_at, completed_at FROM tasks
                WHERE created_at >= ? OR updated_at >= ? OR (completed_at IS NOT NULL AND completed_at >= ?)
            `).all(since, since, since) as Array<{ id: number; title: string; status: string; created_at: number; updated_at: number; completed_at: number | null }>;
            const logs = tableExists(sqlite, 'task_log')
                ? sqlite.prepare(`
                    SELECT l.task_id AS task_id, l.note AS note, l.created_at AS created_at, l.id AS id,
                           t.title AS title, t.status AS status
                    FROM task_log l JOIN tasks t ON t.id = l.task_id
                    WHERE l.created_at >= ?
                    ORDER BY l.created_at DESC, l.id DESC
                `).all(since) as Array<{ task_id: number; note: string; created_at: number; id: number; title: string; status: string }>
                : [];

            const byId = new Map<number, ChangedTask>();
            for (const t of taskRows) {
                const events: string[] = [];
                if (t.created_at >= since) events.push('created');
                if (t.completed_at !== null && t.completed_at >= since && (t.status === 'done' || t.status === 'cancelled')) events.push(t.status);
                if (events.length === 0) events.push('updated');
                byId.set(t.id, {
                    id: t.id, title: t.title, status: t.status, events,
                    lastActivity: Math.max(t.updated_at, t.created_at, t.completed_at ?? 0),
                    log: [],
                });
            }
            for (const l of logs) {
                // "Task created: <title>" is the auto-log of the 'created' event - redundant here
                if (l.note.startsWith('Task created: ')) continue;
                let t = byId.get(l.task_id);
                if (!t) {
                    t = { id: l.task_id, title: l.title, status: l.status, events: ['logged'], lastActivity: l.created_at, log: [] };
                    byId.set(l.task_id, t);
                }
                if (l.created_at > t.lastActivity) t.lastActivity = l.created_at;
                if (t.log.length < TASK_LOG_PER_TASK) t.log.push({ time: l.created_at, text: cut(l.note, TASK_LOG_MAX_CHARS) });
            }
            tasks.push(...[...byId.values()].sort((a, b) => b.lastActivity - a.lastActivity || a.id - b.id));
        }

        // ---- Note -------------------------------------------------
        let noteChangedAt: number | null = null;
        const stamp = parseInt(db.getMetadata(NOTE_UPDATED_KEY) ?? '', 10);
        if (!isNaN(stamp) && stamp >= since) noteChangedAt = stamp;
        if (tableExists(sqlite, 'note_history')) {
            const row = sqlite.prepare('SELECT MAX(created_at) AS t FROM note_history WHERE created_at >= ?').get(since) as { t: number | null };
            if (row.t !== null && (noteChangedAt === null || row.t > noteChangedAt)) noteChangedAt = row.t;
        }
        const noteText = db.getMetadata('session_note');
        const firstLine = noteText
            ? (noteText.split(/\r?\n/).map(s => s.trim()).find(s => s.length > 0) ?? null)
            : null;

        return {
            since,
            files,
            filesOmitted,
            comments,
            commentsOmitted,
            tasks,
            note: {
                changed: noteChangedAt !== null,
                changedAt: noteChangedAt,
                firstLine: firstLine ? cut(firstLine, NOTE_LINE_MAX_CHARS) : null,
            },
        };
    } finally {
        db.close();
    }
}

// ============================================================
// Text formatting
// ============================================================

function formatChange(c: StructureChange): string {
    if (c.itemKind === 'type') {
        if (c.kind === 'changed') return `  ~ ${c.name}: ${c.oldSignature} → ${c.signature}`;
        return `  ${c.kind === 'added' ? '+' : '-'} ${c.signature} ${c.name}`;
    }
    const sig = cut(c.signature, SIGNATURE_MAX_CHARS);
    if (c.kind === 'changed') return `  ~ ${cut(c.oldSignature ?? '', SIGNATURE_MAX_CHARS)} → ${sig}`;
    return `  ${c.kind === 'added' ? '+' : '-'} ${sig}`;
}

function formatFile(f: ChangedFileInfo): string {
    const lines = [`- ${f.path} — ${f.status} ${fmtTime(f.lastChange)}`];
    const shown = f.changes.slice(0, MAX_ITEMS_PER_FILE);
    for (const c of shown) lines.push(formatChange(c));
    if (f.changes.length > shown.length) lines.push(`  … +${f.changes.length - shown.length} more`);
    return lines.join('\n');
}

function formatTask(t: ChangedTask): string {
    const lines = [`- #${t.id} [${t.status}] ${cut(t.title, 120)} — ${t.events.join(', ')} ${fmtTime(t.lastActivity)}`];
    for (const l of t.log) lines.push(`  · ${fmtTime(l.time)} ${l.text}`);
    return lines.join('\n');
}

/** Greedily take entries while they fit into `budget` chars (each entry + newline). */
function fill(entries: string[], budget: number): { taken: string[]; used: number } {
    const taken: string[] = [];
    let used = 0;
    for (const e of entries) {
        if (used + e.length + 1 > budget) break;
        taken.push(e);
        used += e.length + 1;
    }
    return { taken, used };
}

export function formatChangesText(data: ChangesData | Omit<ChangesData, 'refreshed'>, limit = CHANGES_TEXT_LIMIT): string {
    const count = (s: ChangedFileStatus) => data.files.filter(f => f.status === s).length;
    const totalFiles = data.files.length + data.filesOmitted;
    const totalComments = data.comments.length + data.commentsOmitted;

    const head: string[] = [];
    head.push(`# Work state since ${fmtTime(data.since)}`);
    head.push(`Files: ${totalFiles}${totalFiles ? ` (shown: ${count('new')} new, ${count('modified')} modified, ${count('deleted')} deleted)` : ''} · comments: ${totalComments} · tasks: ${data.tasks.length} · note: ${data.note.changed ? 'changed' : 'unchanged'}`);
    if (data.note.changed) {
        head.push(`Note changed ${fmtTime(data.note.changedAt!)}: ${data.note.firstLine ?? '(cleared)'}`);
    }
    const headText = head.join('\n');

    const fileEntries = data.files.map(formatFile);
    const commentEntries = data.comments.map(c => `- ${c.file}:${c.line} ${c.text}`);
    const taskEntries = data.tasks.map(formatTask);

    const size = (list: string[]) => list.reduce((n, e) => n + e.length + 1, 0);
    const RESERVE = 300; // section headers + omission lines
    const tasksNeed = Math.min(size(taskEntries), 1500);
    const commentsNeed = Math.min(size(commentEntries), 1000);

    let remaining = limit - headText.length - RESERVE;
    const filesFit = fill(fileEntries, remaining - tasksNeed - commentsNeed);
    remaining -= filesFit.used;
    const commentsFit = fill(commentEntries, remaining - tasksNeed);
    remaining -= commentsFit.used;
    const tasksFit = fill(taskEntries, remaining);

    const out: string[] = [headText];
    if (fileEntries.length > 0 || data.filesOmitted > 0) {
        out.push('', '## Files (newest change first)');
        out.push(...filesFit.taken);
        const omitted = data.filesOmitted + (fileEntries.length - filesFit.taken.length);
        if (omitted > 0) out.push(`… ${omitted} more file(s) omitted`);
    }
    if (commentEntries.length > 0 || data.commentsOmitted > 0) {
        out.push('', '## New or changed comments');
        out.push(...commentsFit.taken);
        const omitted = data.commentsOmitted + (commentEntries.length - commentsFit.taken.length);
        if (omitted > 0) out.push(`… ${omitted} more comment(s) omitted`);
    }
    if (taskEntries.length > 0) {
        out.push('', '## Tasks');
        out.push(...tasksFit.taken);
        const omitted = taskEntries.length - tasksFit.taken.length;
        if (omitted > 0) out.push(`… ${omitted} more task(s) omitted`);
    }
    if (totalFiles === 0 && totalComments === 0 && data.tasks.length === 0 && !data.note.changed) {
        out.push('', 'No changes recorded since then.');
    }
    return out.join('\n');
}

// ============================================================
// Main
// ============================================================

export function changes(params: ChangesParams): ChangesResult {
    const dbPath = validateIndex(params.path);
    if (!dbPath) return { success: false, error: noIndexError(params.path) };

    const since = parseSince(params.since);
    if (since === null) {
        return { success: false, error: `Invalid since: "${params.since}". Use "30m", "2h", "1d", "1w", an ISO date or epoch milliseconds.` };
    }

    const maxFiles = Math.max(1, Math.floor(params.maxFiles ?? DEFAULT_MAX_FILES));
    const maxComments = Math.max(0, Math.floor(params.maxComments ?? DEFAULT_MAX_COMMENTS));

    try {
        const refreshed = params.refresh === false ? [] : refreshIndex(params.path, dbPath);
        const data: ChangesData = { ...collectChanges(params.path, dbPath, since, maxFiles, maxComments), refreshed };
        const text = params.format === 'json' ? JSON.stringify(data, null, 1) : formatChangesText(data);
        return { success: true, data, text };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}
