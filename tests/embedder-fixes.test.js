/**
 * Regression tests for the embedder schema-migration + race-fix
 * (commits 6209b45 and ee49bd0).
 *
 * Bug 1 — Embedder crashed with "no such column: m.body_text" on legacy DBs.
 *         The embedder opens index.db read-only, so AlterColumn migrations
 *         never ran. Fix: openProjectIndexDb() now opens writable briefly
 *         to apply ALTER TABLEs, plus defensive reads via PRAGMA table_info.
 *
 * Bug 2 — Concurrent indexProject() calls each loaded a fresh embedder
 *         (~7 GB ONNX model), producing N copies in RAM. Fix: in-flight
 *         load is shared via Promise cache.
 */

import { mkdtempSync, rmSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';

import {
    openProjectIndexDb,
    readMethods,
    readMethodsForFile,
    readAllTasks,
    readNoteHistory,
} from '../build/embeddings/store.js';

// ============================================================
// Helpers
// ============================================================

/**
 * Create a temporary project whose index.db has the OLD schema —
 * methods has no body_text/body_lines/body_truncated, tasks has no
 * summary, note_history has no summary.
 */
function createLegacyProject() {
    const dir = mkdtempSync(join(tmpdir(), 'aidex-legacy-'));
    mkdirSync(join(dir, '.aidex'));
    const dbPath = join(dir, '.aidex', 'index.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE,
            hash TEXT,
            last_indexed INTEGER
        );
        -- methods WITHOUT body_text / body_lines / body_truncated
        CREATE TABLE methods (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            prototype TEXT NOT NULL,
            line_number INTEGER NOT NULL,
            visibility TEXT,
            is_static INTEGER DEFAULT 0,
            is_async INTEGER DEFAULT 0,
            FOREIGN KEY (file_id) REFERENCES files(id)
        );
        CREATE TABLE types (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            line_number INTEGER NOT NULL,
            FOREIGN KEY (file_id) REFERENCES files(id)
        );
        -- tasks WITHOUT summary
        CREATE TABLE tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            priority INTEGER NOT NULL DEFAULT 2,
            status TEXT NOT NULL DEFAULT 'backlog',
            tags TEXT,
            source TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            completed_at INTEGER
        );
        CREATE TABLE task_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            note TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (task_id) REFERENCES tasks(id)
        );
        -- note_history WITHOUT summary
        CREATE TABLE note_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE metadata (
            key TEXT PRIMARY KEY,
            value TEXT
        );
    `);
    // Seed minimal data so reads return something
    const fileId = db.prepare('INSERT INTO files (path, hash) VALUES (?, ?)').run('a.ts', 'h1').lastInsertRowid;
    db.prepare('INSERT INTO methods (file_id, name, prototype, line_number) VALUES (?, ?, ?, ?)').run(fileId, 'foo', 'function foo()', 10);
    db.prepare('INSERT INTO methods (file_id, name, prototype, line_number) VALUES (?, ?, ?, ?)').run(fileId, 'bar', 'function bar()', 20);
    const now = Date.now();
    db.prepare('INSERT INTO tasks (title, description, created_at, updated_at) VALUES (?, ?, ?, ?)').run('t1', 'd1', now, now);
    db.prepare('INSERT INTO note_history (note, created_at) VALUES (?, ?)').run('legacy note', now);
    db.close();
    return { dir, dbPath };
}

function tableColumns(dbPath, table) {
    const db = new Database(dbPath, { readonly: true });
    try {
        const rows = db.prepare(`PRAGMA table_info(${table})`).all();
        return new Set(rows.map(r => r.name));
    } finally {
        db.close();
    }
}

// ============================================================
// Tests
// ============================================================

describe('embedder schema migration', () => {
    let project;
    afterEach(() => { if (project) { try { rmSync(project.dir, { recursive: true, force: true }); } catch {} } });

    test('openProjectIndexDb adds methods.body_text/body_lines/body_truncated to legacy DB', () => {
        project = createLegacyProject();
        const before = tableColumns(project.dbPath, 'methods');
        expect(before.has('body_text')).toBe(false);
        expect(before.has('body_lines')).toBe(false);
        expect(before.has('body_truncated')).toBe(false);

        const handle = openProjectIndexDb(project.dir);
        expect(handle).not.toBeNull();
        handle.close();

        const after = tableColumns(project.dbPath, 'methods');
        expect(after.has('body_text')).toBe(true);
        expect(after.has('body_lines')).toBe(true);
        expect(after.has('body_truncated')).toBe(true);
    });

    test('openProjectIndexDb adds tasks.summary to legacy DB', () => {
        project = createLegacyProject();
        expect(tableColumns(project.dbPath, 'tasks').has('summary')).toBe(false);

        const handle = openProjectIndexDb(project.dir);
        handle.close();

        expect(tableColumns(project.dbPath, 'tasks').has('summary')).toBe(true);
    });

    test('openProjectIndexDb adds note_history.summary to legacy DB', () => {
        project = createLegacyProject();
        expect(tableColumns(project.dbPath, 'note_history').has('summary')).toBe(false);

        const handle = openProjectIndexDb(project.dir);
        handle.close();

        expect(tableColumns(project.dbPath, 'note_history').has('summary')).toBe(true);
    });

    test('openProjectIndexDb returns null when index.db does not exist', () => {
        const dir = mkdtempSync(join(tmpdir(), 'aidex-empty-'));
        try {
            expect(openProjectIndexDb(dir)).toBeNull();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('openProjectIndexDb is idempotent — second call is a no-op', () => {
        project = createLegacyProject();
        openProjectIndexDb(project.dir).close();
        // Second call must not throw on already-migrated DB
        expect(() => openProjectIndexDb(project.dir).close()).not.toThrow();
        expect(tableColumns(project.dbPath, 'methods').has('body_text')).toBe(true);
    });
});

describe('embedder defensive reads', () => {
    let project;
    afterEach(() => { if (project) { try { rmSync(project.dir, { recursive: true, force: true }); } catch {} } });

    test('readMethods does not throw when body_text is missing (pre-migration scenario)', () => {
        project = createLegacyProject();
        // Open WITHOUT going through openProjectIndexDb (so columns stay missing)
        const db = new Database(project.dbPath, { readonly: true });
        const handle = { db, close: () => db.close() };
        try {
            const rows = readMethods(handle);
            expect(rows.length).toBe(2);
            expect(rows[0].name).toBe('foo');
            expect(rows[0].bodyText).toBeNull();
            expect(rows[0].bodyLines).toBeNull();
            expect(rows[0].docComment).toBeNull();
        } finally {
            handle.close();
        }
    });

    test('readMethodsForFile is also defensive', () => {
        project = createLegacyProject();
        const db = new Database(project.dbPath, { readonly: true });
        const handle = { db, close: () => db.close() };
        try {
            const rows = readMethodsForFile(handle, 'a.ts');
            expect(rows.length).toBe(2);
            expect(rows[0].bodyText).toBeNull();
        } finally {
            handle.close();
        }
    });

    test('readAllTasks does not throw when tasks.summary is missing', () => {
        project = createLegacyProject();
        const db = new Database(project.dbPath, { readonly: true });
        const handle = { db, close: () => db.close() };
        try {
            const rows = readAllTasks(handle);
            expect(rows.length).toBe(1);
            expect(rows[0].title).toBe('t1');
            expect(rows[0].summary).toBeNull();
        } finally {
            handle.close();
        }
    });

    test('readNoteHistory does not throw when note_history.summary is missing', () => {
        project = createLegacyProject();
        const db = new Database(project.dbPath, { readonly: true });
        const handle = { db, close: () => db.close() };
        try {
            const rows = readNoteHistory(handle);
            expect(rows.length).toBe(1);
            expect(rows[0].note).toBe('legacy note');
            expect(rows[0].summary).toBeNull();
        } finally {
            handle.close();
        }
    });

    test('reads work normally on a migrated DB (round-trip)', () => {
        project = createLegacyProject();
        // Migrate via openProjectIndexDb
        openProjectIndexDb(project.dir).close();
        // Then write summary values
        const writeDb = new Database(project.dbPath);
        writeDb.prepare('UPDATE tasks SET summary = ? WHERE id = 1').run('one-line summary');
        writeDb.prepare('UPDATE note_history SET summary = ? WHERE id = 1').run('archived: foo');
        writeDb.close();

        const readDb = new Database(project.dbPath, { readonly: true });
        const handle = { db: readDb, close: () => readDb.close() };
        try {
            const tasks = readAllTasks(handle);
            expect(tasks[0].summary).toBe('one-line summary');
            const notes = readNoteHistory(handle);
            expect(notes[0].summary).toBe('archived: foo');
        } finally {
            handle.close();
        }
    });
});

describe('embedder concurrent-load race fix', () => {
    test('concurrent getEmbedder() calls share the same in-flight load', async () => {
        // We exercise the Promise-cache logic without loading a real ONNX model.
        // The mechanism we want to verify: when N parallel calls arrive while
        // `embedderLoad` is non-null, only ONE creator runs.
        let createCount = 0;
        let resolveCreate;
        const createPromise = new Promise(r => { resolveCreate = r; });

        // Mimic RealEmbeddings.getEmbedder() exactly (same shape, no real model).
        class FakeEmbeddings {
            constructor() {
                this.embedder = null;
                this.embedderLoad = null;
            }
            async getEmbedder() {
                if (this.embedder) return this.embedder;
                if (this.embedderLoad) return this.embedderLoad;

                this.embedderLoad = (async () => {
                    createCount++;
                    const e = await createPromise; // simulate slow load
                    this.embedder = e;
                    return e;
                })();
                try {
                    return await this.embedderLoad;
                } finally {
                    this.embedderLoad = null;
                }
            }
        }
        const f = new FakeEmbeddings();

        // Fire 14 concurrent calls — what triggered the original 98 GB blowup
        const calls = Promise.all(Array.from({ length: 14 }, () => f.getEmbedder()));
        // Yield once so all callers have entered getEmbedder()
        await new Promise(r => setImmediate(r));
        // Resolve the single creator
        resolveCreate({ embed: () => {} });
        const results = await calls;

        // Exactly ONE createEmbedder() must have run, all 14 share the result
        expect(createCount).toBe(1);
        expect(new Set(results).size).toBe(1);
    });

    test('after first load completes, subsequent calls reuse cached embedder', async () => {
        let createCount = 0;
        class FakeEmbeddings {
            constructor() { this.embedder = null; this.embedderLoad = null; }
            async getEmbedder() {
                if (this.embedder) return this.embedder;
                if (this.embedderLoad) return this.embedderLoad;
                this.embedderLoad = (async () => {
                    createCount++;
                    const e = { id: 'singleton' };
                    this.embedder = e;
                    return e;
                })();
                try { return await this.embedderLoad; }
                finally { this.embedderLoad = null; }
            }
        }
        const f = new FakeEmbeddings();
        const a = await f.getEmbedder();
        const b = await f.getEmbedder();
        const c = await f.getEmbedder();
        expect(createCount).toBe(1);
        expect(a).toBe(b);
        expect(b).toBe(c);
    });
});
