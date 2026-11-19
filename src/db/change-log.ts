/**
 * Structural change log for AiDex.
 *
 * The index replaces a file's rows on re-index, so after the fact nobody can tell
 * which methods/types were removed or got a new signature. This module records that
 * delta at re-index time (old rows vs. new extraction of the same file) into the
 * `change_log` table, which `aidex_changes` reads later.
 *
 * Entries are metadata only (names, prototypes, kinds) - never file contents.
 */

import type Database from 'better-sqlite3';

// ============================================================
// Types
// ============================================================

export type ChangeKind = 'added' | 'removed' | 'changed' | 'file_added' | 'file_deleted';
export type ChangeItemKind = 'method' | 'type';

export interface StructureSnapshot {
    methods: Array<{ name: string; prototype: string }>;
    types: Array<{ name: string; kind: string }>;
}

export interface StructureChange {
    kind: 'added' | 'removed' | 'changed';
    itemKind: ChangeItemKind;
    name: string;
    signature: string;           // new signature (added/changed) or old signature (removed)
    oldSignature?: string;       // only for 'changed'
}

export interface ChangeLogRow {
    id: number;
    time: number;
    file: string;
    kind: ChangeKind;
    item_kind: ChangeItemKind | null;
    name: string | null;
    signature: string | null;
    old_signature: string | null;
}

/** Entries older than this are pruned whenever new entries are written. */
export const CHANGE_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const CHANGE_LOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time INTEGER NOT NULL,
    file TEXT NOT NULL,
    kind TEXT NOT NULL,
    item_kind TEXT,
    name TEXT,
    signature TEXT,
    old_signature TEXT
);
CREATE INDEX IF NOT EXISTS idx_change_log_time ON change_log(time);
CREATE INDEX IF NOT EXISTS idx_change_log_file ON change_log(file);
`;

// ============================================================
// Diff
// ============================================================

/** Collapse whitespace so pure formatting changes are not reported as signature changes. */
export function normalizeSignature(sig: string): string {
    return sig.replace(/\s+/g, ' ').trim();
}

function compareStr(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Turn the net removed/added signatures of ONE name into changes.
 * Pairs removed[i] with added[i] (both sorted) as 'changed', the rest stays removed/added.
 */
export function pairSignatures(
    itemKind: ChangeItemKind,
    name: string,
    removed: string[],
    added: string[]
): StructureChange[] {
    const r = [...removed].sort(compareStr);
    const a = [...added].sort(compareStr);
    const out: StructureChange[] = [];
    const paired = Math.min(r.length, a.length);
    for (let i = 0; i < paired; i++) {
        out.push({ kind: 'changed', itemKind, name, signature: a[i], oldSignature: r[i] });
    }
    for (let i = paired; i < r.length; i++) {
        out.push({ kind: 'removed', itemKind, name, signature: r[i] });
    }
    for (let i = paired; i < a.length; i++) {
        out.push({ kind: 'added', itemKind, name, signature: a[i] });
    }
    return out;
}

/** Multiset difference: elements of `a` not matched in `b`. */
function multisetMinus(a: string[], b: string[]): string[] {
    const counts = new Map<string, number>();
    for (const x of b) counts.set(x, (counts.get(x) ?? 0) + 1);
    const out: string[] = [];
    for (const x of a) {
        const c = counts.get(x) ?? 0;
        if (c > 0) counts.set(x, c - 1);
        else out.push(x);
    }
    return out;
}

function groupByName(entries: Array<{ name: string; sig: string }>): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const e of entries) {
        const list = map.get(e.name);
        if (list) list.push(e.sig);
        else map.set(e.name, [e.sig]);
    }
    return map;
}

function diffGroup(
    itemKind: ChangeItemKind,
    oldEntries: Array<{ name: string; sig: string }>,
    newEntries: Array<{ name: string; sig: string }>
): StructureChange[] {
    const oldMap = groupByName(oldEntries);
    const newMap = groupByName(newEntries);
    const names = [...new Set([...oldMap.keys(), ...newMap.keys()])].sort(compareStr);
    const out: StructureChange[] = [];
    for (const name of names) {
        const o = oldMap.get(name) ?? [];
        const n = newMap.get(name) ?? [];
        out.push(...pairSignatures(itemKind, name, multisetMinus(o, n), multisetMinus(n, o)));
    }
    return out;
}

/**
 * Structural delta between two snapshots of the same file.
 * Methods are matched by name and compared by (whitespace-normalized) prototype,
 * types by name and compared by kind. Output order is deterministic:
 * types first, then methods, each by name.
 */
export function diffStructure(oldS: StructureSnapshot, newS: StructureSnapshot): StructureChange[] {
    const m = (s: StructureSnapshot) => s.methods.map(x => ({ name: x.name, sig: normalizeSignature(x.prototype) }));
    const t = (s: StructureSnapshot) => s.types.map(x => ({ name: x.name, sig: x.kind }));
    return [
        ...diffGroup('type', t(oldS), t(newS)),
        ...diffGroup('method', m(oldS), m(newS)),
    ];
}

// ============================================================
// Persistence
// ============================================================

/** Create the table if missing (idempotent, safe for existing databases). */
export function ensureChangeLog(sqlite: Database.Database): void {
    sqlite.exec(CHANGE_LOG_SCHEMA);
}

/** True when the table exists (read-only opens of old databases may not have it). */
export function hasChangeLog(sqlite: Database.Database): boolean {
    const row = sqlite.prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'change_log'"
    ).get() as { ok: number } | undefined;
    return !!row;
}

function insertRow(
    sqlite: Database.Database,
    time: number,
    file: string,
    kind: ChangeKind,
    itemKind: ChangeItemKind | null,
    name: string | null,
    signature: string | null,
    oldSignature: string | null
): void {
    sqlite.prepare(
        'INSERT INTO change_log (time, file, kind, item_kind, name, signature, old_signature) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(time, file, kind, itemKind, name, signature, oldSignature);
}

function prune(sqlite: Database.Database, now: number): void {
    sqlite.prepare('DELETE FROM change_log WHERE time < ?').run(now - CHANGE_LOG_RETENTION_MS);
}

/**
 * Record the re-index of one file. `oldS` = null means the file is new to the index.
 * Call inside the same transaction as the re-index. Never throws: the change log is
 * best-effort and must not break indexing.
 */
export function recordFileReindex(
    sqlite: Database.Database,
    file: string,
    oldS: StructureSnapshot | null,
    newS: StructureSnapshot,
    now = Date.now()
): void {
    try {
        ensureChangeLog(sqlite);
        if (oldS === null) {
            insertRow(sqlite, now, file, 'file_added', null, null, null, null);
        }
        const changes = diffStructure(oldS ?? { methods: [], types: [] }, newS);
        for (const c of changes) {
            insertRow(sqlite, now, file, c.kind, c.itemKind, c.name, c.signature, c.oldSignature ?? null);
        }
        prune(sqlite, now);
    } catch (err) {
        console.error('[AiDex] change_log write failed:', err);
    }
}

/**
 * Record that a file was deleted. With `onlyOnce`, nothing is written when the newest
 * entry for that file already is a deletion (session start detects the same deleted
 * file again and again until it is removed from the index). Pass `oldS` only when the
 * file is really removed from the index: its methods/types are then logged as removed.
 */
export function recordFileDeleted(
    sqlite: Database.Database,
    file: string,
    now = Date.now(),
    onlyOnce = false,
    oldS: StructureSnapshot | null = null
): void {
    try {
        ensureChangeLog(sqlite);
        if (onlyOnce) {
            const last = sqlite.prepare(
                "SELECT kind FROM change_log WHERE file = ? AND kind IN ('file_added', 'file_deleted') ORDER BY time DESC, id DESC LIMIT 1"
            ).get(file) as { kind: string } | undefined;
            if (last?.kind === 'file_deleted') return;
        }
        insertRow(sqlite, now, file, 'file_deleted', null, null, null, null);
        if (oldS) {
            for (const c of diffStructure(oldS, { methods: [], types: [] })) {
                insertRow(sqlite, now, file, c.kind, c.itemKind, c.name, c.signature, null);
            }
        }
        prune(sqlite, now);
    } catch (err) {
        console.error('[AiDex] change_log write failed:', err);
    }
}

/** All change log rows with time >= since, chronological (time, id). */
export function getChangeLogSince(sqlite: Database.Database, since: number): ChangeLogRow[] {
    if (!hasChangeLog(sqlite)) return [];
    return sqlite.prepare(
        'SELECT id, time, file, kind, item_kind, name, signature, old_signature FROM change_log WHERE time >= ? ORDER BY time, id'
    ).all(since) as ChangeLogRow[];
}

/**
 * Net structural delta of one file from a chronological list of its log rows.
 * Added-then-removed items cancel out; a signature changed twice is reported once
 * (oldest -> newest).
 */
export function netStructureChanges(rows: ChangeLogRow[]): StructureChange[] {
    // key = itemKind \0 name -> { plus, minus } multisets of signatures
    const state = new Map<string, { itemKind: ChangeItemKind; name: string; plus: string[]; minus: string[] }>();
    const get = (itemKind: ChangeItemKind, name: string) => {
        const key = `${itemKind}\0${name}`;
        let s = state.get(key);
        if (!s) {
            s = { itemKind, name, plus: [], minus: [] };
            state.set(key, s);
        }
        return s;
    };
    const add = (s: { plus: string[]; minus: string[] }, sig: string) => {
        const i = s.minus.indexOf(sig);
        if (i >= 0) s.minus.splice(i, 1);
        else s.plus.push(sig);
    };
    const del = (s: { plus: string[]; minus: string[] }, sig: string) => {
        const i = s.plus.indexOf(sig);
        if (i >= 0) s.plus.splice(i, 1);
        else s.minus.push(sig);
    };

    for (const r of rows) {
        if (!r.item_kind || r.name === null) continue;
        const s = get(r.item_kind, r.name);
        const sig = r.signature ?? '';
        if (r.kind === 'added') add(s, sig);
        else if (r.kind === 'removed') del(s, sig);
        else if (r.kind === 'changed') {
            del(s, r.old_signature ?? '');
            add(s, sig);
        }
    }

    const out: StructureChange[] = [];
    const keys = [...state.keys()].sort(compareStr);
    // types before methods ('method' < 'type' alphabetically, so order explicitly)
    for (const itemKind of ['type', 'method'] as const) {
        for (const key of keys) {
            const s = state.get(key)!;
            if (s.itemKind !== itemKind) continue;
            out.push(...pairSignatures(itemKind, s.name, s.minus, s.plus));
        }
    }
    return out;
}
