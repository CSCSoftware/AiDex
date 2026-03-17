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
     * Initialize database with schema
     */
    initSchema(): void {
        const schemaPath = join(__dirname, 'schema.sql');
        const schema = readFileSync(schemaPath, 'utf-8');
        this.db.exec(schema);

        // Set initial metadata if not exists
        const stmt = this.db.prepare(
            'INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)'
        );
        stmt.run('schema_version', '1.0');
        stmt.run('created_at', Date.now().toString());
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
 * Open or create an AiDex database
 */
export function openDatabase(dbPath: string, readonly = false): AiDexDatabase {
    return new AiDexDatabase({ dbPath, readonly });
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
