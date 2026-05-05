/**
 * SQLite Database wrapper for AiDex
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DatabaseConfig {
    dbPath: string;
    readonly?: boolean;
}

export class AiDexDatabase {
    private db: Database.Database;
    private dbPath: string;
    private _statsStmt?: Database.Statement;

    constructor(config: DatabaseConfig) {
        this.dbPath = config.dbPath;
        this.db = new Database(config.dbPath, {
            readonly: config.readonly ?? false,
        });

        // Enable WAL mode and foreign keys
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
    }

    /**
     * Initialize database with schema. Runs incremental migrations BEFORE
     * exec'ing the schema file, so `CREATE INDEX` statements that reference
     * newer columns don't blow up on legacy DBs.
     */
    initSchema(): void {
        // Pre-migrations: bring old tables up to current shape so that the
        // schema.sql `CREATE INDEX` statements can succeed even when the
        // user's existing tables are missing newer columns.
        this.migrateLegacySchema();

        const schemaPath = join(__dirname, 'schema.sql');
        const schema = readFileSync(schemaPath, 'utf-8');
        this.db.exec(schema);

        // Set initial metadata if not exists
        const stmt = this.db.prepare(
            'INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)'
        );
        stmt.run('schema_version', '1.2');
        stmt.run('created_at', Date.now().toString());

        // Update schema_version on existing DBs
        this.db.prepare(
            "UPDATE metadata SET value = '1.2' WHERE key = 'schema_version' AND value IN ('1.0', '1.1')"
        ).run();
    }

    /**
     * Idempotent schema migrations for legacy DBs. Safe to run on a fresh DB
     * (PRAGMA returns no rows for tables that don't yet exist — every
     * migration step early-returns in that case). Called from `initSchema()`
     * AND from `openDatabase()` for writeable opens, so every entry point
     * (init / update / remove / task / etc.) is covered.
     */
    migrateLegacySchema(): void {
        // methods.body_text + body_lines + body_truncated (v1.19a)
        const methodCols = this.tableColumns('methods');
        if (methodCols.size > 0) {
            if (!methodCols.has('body_text')) {
                this.db.exec("ALTER TABLE methods ADD COLUMN body_text TEXT");
            }
            if (!methodCols.has('body_lines')) {
                this.db.exec("ALTER TABLE methods ADD COLUMN body_lines INTEGER");
            }
            if (!methodCols.has('body_truncated')) {
                this.db.exec("ALTER TABLE methods ADD COLUMN body_truncated INTEGER DEFAULT 0");
            }
        }

        // tasks.summary (v1.15)
        const taskCols = this.tableColumns('tasks');
        if (taskCols.size > 0) {
            if (!taskCols.has('summary')) {
                this.db.exec('ALTER TABLE tasks ADD COLUMN summary TEXT');
            }
            // Scheduler columns (v1.17): due / interval / action / auto_go
            if (!taskCols.has('due')) {
                this.db.exec('ALTER TABLE tasks ADD COLUMN due INTEGER');
            }
            if (!taskCols.has('interval')) {
                this.db.exec('ALTER TABLE tasks ADD COLUMN interval TEXT');
            }
            if (!taskCols.has('action')) {
                this.db.exec('ALTER TABLE tasks ADD COLUMN action TEXT');
            }
            if (!taskCols.has('auto_go')) {
                this.db.exec('ALTER TABLE tasks ADD COLUMN auto_go INTEGER DEFAULT 0');
            }
            // Old `cancelled` status was added later — if the CHECK constraint
            // doesn't allow it, we'd need to rebuild the table. That's already
            // handled by ensureTaskTables() in commands/task.ts on first task call.
        }

        // note_history.summary (added when archived-note summaries were introduced)
        const noteHistoryCols = this.tableColumns('note_history');
        if (noteHistoryCols.size > 0 && !noteHistoryCols.has('summary')) {
            this.db.exec('ALTER TABLE note_history ADD COLUMN summary TEXT');
        }
    }

    private tableColumns(table: string): Set<string> {
        try {
            const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
            return new Set(cols.map(c => c.name));
        } catch {
            return new Set();
        }
    }

    /**
     * Set metadata value
     */
    setMetadata(key: string, value: string | null): void {
        this.db.prepare(
            'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)'
        ).run(key, value);
    }

    /**
     * Get metadata value
     */
    getMetadata(key: string): string | null {
        const row = this.db.prepare(
            'SELECT value FROM metadata WHERE key = ?'
        ).get(key) as { value: string | null } | undefined;
        return row?.value ?? null;
    }

    /**
     * Delete metadata entry
     */
    deleteMetadata(key: string): void {
        this.db.prepare('DELETE FROM metadata WHERE key = ?').run(key);
    }

    // ============================================================
    // Note History
    // ============================================================

    /**
     * Archive a note to the history table (called before overwriting)
     */
    archiveNote(note: string, summary?: string | null): void {
        this.db.prepare(
            'INSERT INTO note_history (note, summary, created_at) VALUES (?, ?, ?)'
        ).run(note, summary ?? null, Date.now());
    }

    /**
     * Get note history entries, newest first
     */
    getNoteHistory(limit = 50): Array<{ id: number; note: string; summary: string | null; created_at: number }> {
        return this.db.prepare(
            'SELECT id, note, summary, created_at FROM note_history ORDER BY created_at DESC LIMIT ?'
        ).all(limit) as Array<{ id: number; note: string; summary: string | null; created_at: number }>;
    }

    /**
     * Search note history by text (case-insensitive LIKE)
     */
    searchNoteHistory(query: string, limit = 20): Array<{ id: number; note: string; summary: string | null; created_at: number }> {
        return this.db.prepare(
            'SELECT id, note, summary, created_at FROM note_history WHERE note LIKE ? OR summary LIKE ? ORDER BY created_at DESC LIMIT ?'
        ).all(`%${query}%`, `%${query}%`, limit) as Array<{ id: number; note: string; summary: string | null; created_at: number }>;
    }

    /**
     * Count note history entries
     */
    countNoteHistory(): number {
        return (this.db.prepare('SELECT COUNT(*) as c FROM note_history').get() as { c: number }).c;
    }

    /**
     * Run a function in a transaction
     */
    transaction<T>(fn: () => T): T {
        return this.db.transaction(fn)();
    }

    /**
     * Get the underlying better-sqlite3 database instance
     */
    getDb(): Database.Database {
        return this.db;
    }

    /**
     * Get database file path
     */
    getPath(): string {
        return this.dbPath;
    }

    /**
     * Get database statistics
     */
    getStats(): {
        files: number;
        lines: number;
        items: number;
        occurrences: number;
        methods: number;
        types: number;
        dependencies: number;
        sizeBytes: number;
    } {
        this._statsStmt ??= this.db.prepare(`
            SELECT
                (SELECT COUNT(*) FROM files) as files,
                (SELECT COUNT(*) FROM lines) as lines,
                (SELECT COUNT(*) FROM items) as items,
                (SELECT COUNT(*) FROM occurrences) as occurrences,
                (SELECT COUNT(*) FROM methods) as methods,
                (SELECT COUNT(*) FROM types) as types,
                (SELECT COUNT(*) FROM dependencies) as dependencies
        `);
        const counts = this._statsStmt.get() as { files: number; lines: number; items: number; occurrences: number; methods: number; types: number; dependencies: number };

        // Get file size
        const pragmaResult = this.db.pragma('page_count') as Array<{ page_count: number }>;
        const pageSizeResult = this.db.pragma('page_size') as Array<{ page_size: number }>;
        const pageCount = pragmaResult[0]?.page_count ?? 0;
        const pageSize = pageSizeResult[0]?.page_size ?? 4096;
        const sizeBytes = pageCount * pageSize;

        return { ...counts, sizeBytes };
    }

    /**
     * Close database connection
     */
    close(): void {
        this.db.close();
    }
}

/**
 * Open or create an AiDex database. Writeable opens automatically run
 * idempotent legacy-schema migrations so that callers like aidex_update /
 * aidex_remove / aidex_task can safely operate on DBs created by older
 * versions without crashing on missing columns.
 */
export function openDatabase(dbPath: string, readonly = false): AiDexDatabase {
    const db = new AiDexDatabase({ dbPath, readonly });
    if (!readonly) {
        try {
            db.migrateLegacySchema();
        } catch (err) {
            console.error('[AiDex] migrateLegacySchema failed:', err);
        }
    }
    return db;
}

/**
 * Create and initialize a new AiDex database
 * If incremental=true, keeps existing data for incremental updates
 * If incremental=false (default), clears all data for fresh re-index
 */
export function createDatabase(dbPath: string, projectName?: string, projectRoot?: string, incremental = false): AiDexDatabase {
    const db = new AiDexDatabase({ dbPath });
    db.initSchema();

    if (!incremental) {
        // Clear all data for fresh re-index (ON DELETE CASCADE handles related tables)
        db.getDb().exec('DELETE FROM files');
        db.getDb().exec('DELETE FROM items');
    }

    if (projectName) {
        db.setMetadata('project_name', projectName);
    }
    if (projectRoot) {
        db.setMetadata('project_root', projectRoot);
    }
    db.setMetadata('last_indexed', Date.now().toString());

    return db;
}
