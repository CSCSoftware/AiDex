/**
 * Global AiDex Database
 *
 * Meta-DB at ~/.aidex/global.db that references all project databases.
 * Uses ATTACH DATABASE for cross-project queries.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { INDEX_DIR } from '../constants.js';
import { escapeLikeTerm, normalizePath } from '../commands/shared.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Types
// ============================================================

export interface GuidelineRow {
    key: string;
    value: string;
    created_at: number;
    updated_at: number;
}

export interface GlobalProject {
    id: number;
    path: string;
    name: string;
    languages: string | null;
    files_count: number;
    items_count: number;
    methods_count: number;
    types_count: number;
    db_size_bytes: number;
    last_indexed: number | null;
    last_synced: number | null;
    tags: string | null;
    registered_at: number;
}

export interface ScheduledTaskRow {
    id: number;
    project_path: string;
    task_id: number;
    due: number;
    interval: string | null;
    auto_go: number;
}

export interface ProjectStats {
    files: number;
    items: number;
    methods: number;
    types: number;
    sizeBytes: number;
    languages: string[];
    lastIndexed: number | null;
}

// ============================================================
// Constants
// ============================================================

const GLOBAL_DIR = join(homedir(), '.aidex');
const GLOBAL_DB_PATH = join(GLOBAL_DIR, 'global.db');
const ATTACH_BATCH_SIZE = 8;  // SQLite limit is 10, keep 2 margin

// ============================================================
// GlobalDatabase class
// ============================================================

export class GlobalDatabase {
    private db: Database.Database;
    private dbPath: string;

    constructor() {
        // Ensure ~/.aidex/ exists
        if (!existsSync(GLOBAL_DIR)) {
            mkdirSync(GLOBAL_DIR, { recursive: true });
        }

        this.dbPath = GLOBAL_DB_PATH;
        this.db = new Database(this.dbPath);

        // Enable WAL mode
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');

        // Initialize schema
        const schemaPath = join(__dirname, 'global-schema.sql');
        const schema = readFileSync(schemaPath, 'utf-8');
        this.db.exec(schema);

        // Set initial metadata if not exists
        this.db.prepare(
            'INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)'
        ).run('schema_version', '1.0');
    }

    // --------------------------------------------------------
    // Project Registry
    // --------------------------------------------------------

    /**
     * Register or update a project in the global registry
     */
    registerProject(
        path: string,
        name: string,
        stats: ProjectStats,
        tags?: string
    ): void {
        const now = Date.now();
        const languages = stats.languages.length > 0 ? stats.languages.join(',') : null;

        this.db.prepare(`
            INSERT INTO projects (path, name, languages, files_count, items_count, methods_count, types_count, db_size_bytes, last_indexed, last_synced, tags, registered_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
                name = excluded.name,
                languages = excluded.languages,
                files_count = excluded.files_count,
                items_count = excluded.items_count,
                methods_count = excluded.methods_count,
                types_count = excluded.types_count,
                db_size_bytes = excluded.db_size_bytes,
                last_indexed = excluded.last_indexed,
                last_synced = excluded.last_synced,
                tags = COALESCE(excluded.tags, projects.tags)
        `).run(
            normalizePath(path), name, languages,
            stats.files, stats.items, stats.methods, stats.types, stats.sizeBytes,
            stats.lastIndexed, now,
            tags ?? null, now
        );
    }

    /**
     * Remove a project from the registry
     */
    unregisterProject(path: string): boolean {
        const result = this.db.prepare(
            'DELETE FROM projects WHERE path = ?'
        ).run(normalizePath(path));
        return result.changes > 0;
    }

    /**
     * Get all registered projects, optionally filtered
     */
    getProjects(filter?: { tag?: string; namePattern?: string }): GlobalProject[] {
        let sql = 'SELECT * FROM projects';
        const conditions: string[] = [];
        const params: string[] = [];

        if (filter?.tag) {
            conditions.push("tags LIKE ? ESCAPE '\\'");
            params.push(`%${escapeLikeTerm(filter.tag)}%`);
        }
        if (filter?.namePattern) {
            conditions.push("name LIKE ? ESCAPE '\\'");
            params.push(filter.namePattern.replace(/\*/g, '%'));
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }
        sql += ' ORDER BY name';

        return this.db.prepare(sql).all(...params) as GlobalProject[];
    }

    /**
     * Get a single project by path
     */
    getProjectByPath(path: string): GlobalProject | null {
        const row = this.db.prepare(
            'SELECT * FROM projects WHERE path = ?'
        ).get(normalizePath(path));
        return (row as GlobalProject) ?? null;
    }

    /**
     * Update tags for a project
     */
    updateProjectTags(path: string, tags: string): void {
        this.db.prepare(
            'UPDATE projects SET tags = ? WHERE path = ?'
        ).run(tags, normalizePath(path));
    }

    /**
     * Get total counts across all projects
     */
    getTotals(): { projects: number; files: number; items: number; methods: number; types: number } {
        return this.db.prepare(`
            SELECT
                COUNT(*) as projects,
                COALESCE(SUM(files_count), 0) as files,
                COALESCE(SUM(items_count), 0) as items,
                COALESCE(SUM(methods_count), 0) as methods,
                COALESCE(SUM(types_count), 0) as types
            FROM projects
        `).get() as { projects: number; files: number; items: number; methods: number; types: number };
    }

    // --------------------------------------------------------
    // ATTACH-based cross-project queries
    // --------------------------------------------------------

    /**
     * Execute a query function across multiple project databases in batches.
     * Opens each project DB via ATTACH, runs the query, collects results.
     */
    queryAcrossProjects<T>(
        projects: GlobalProject[],
        queryFn: (db: Database.Database, alias: string, project: GlobalProject) => T[],
        limitTotal?: number
    ): Array<{ project: GlobalProject; results: T[] }> {
        const allResults: Array<{ project: GlobalProject; results: T[] }> = [];
        let totalCount = 0;

        for (let i = 0; i < projects.length; i += ATTACH_BATCH_SIZE) {
            const batch = projects.slice(i, i + ATTACH_BATCH_SIZE);
            const attached: string[] = [];

            // ATTACH batch
            for (let j = 0; j < batch.length; j++) {
                const alias = `p${j}`;
                const dbPath = join(batch[j].path, INDEX_DIR, 'index.db');

                if (!existsSync(dbPath)) continue;

                try {
                    // Escape single quotes in path for ATTACH
                    const escapedPath = dbPath.replace(/\\/g, '/').replace(/'/g, "''");
                    this.db.exec(`ATTACH DATABASE '${escapedPath}' AS ${alias}`);
                    attached.push(alias);
                } catch {
                    // Skip DBs that can't be attached (locked, corrupt, etc.)
                    continue;
                }
            }

            // QUERY each attached DB
            for (let j = 0; j < batch.length; j++) {
                const alias = `p${j}`;
                if (!attached.includes(alias)) continue;

                try {
                    const results = queryFn(this.db, alias, batch[j]);
                    if (results.length > 0) {
                        allResults.push({ project: batch[j], results });
                        totalCount += results.length;
                    }
                } catch (err) {
                    console.error(`[GlobalDB] Query error on project ${batch[j].name}:`, err);
                }
            }

            // DETACH all
            for (const alias of attached) {
                try {
                    this.db.exec(`DETACH DATABASE ${alias}`);
                } catch {
                    // Ignore detach errors
                }
            }

            // Early exit if we have enough results
            if (limitTotal && totalCount >= limitTotal) break;
        }

        return allResults;
    }

    // --------------------------------------------------------
    // Metadata
    // --------------------------------------------------------

    setMetadata(key: string, value: string | null): void {
        this.db.prepare(
            'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)'
        ).run(key, value);
    }

    getMetadata(key: string): string | null {
        const row = this.db.prepare(
            'SELECT value FROM metadata WHERE key = ?'
        ).get(key) as { value: string | null } | undefined;
        return row?.value ?? null;
    }

    // --------------------------------------------------------
    // Guidelines
    // --------------------------------------------------------

    setGuideline(key: string, value: string): void {
        const now = Date.now();
        this.db.prepare(`
            INSERT INTO guidelines (key, value, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value      = excluded.value,
                updated_at = excluded.updated_at
        `).run(key, value, now, now);
    }

    getGuideline(key: string): GuidelineRow | null {
        const row = this.db.prepare(
            'SELECT key, value, created_at, updated_at FROM guidelines WHERE key = ?'
        ).get(key);
        return (row as GuidelineRow) ?? null;
    }

    listGuidelines(filter?: string): GuidelineRow[] {
        if (filter) {
            const escaped = filter.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
            return this.db.prepare(
                "SELECT key, value, created_at, updated_at FROM guidelines WHERE key LIKE ? ESCAPE '\\' ORDER BY key"
            ).all(`%${escaped}%`) as GuidelineRow[];
        }
        return this.db.prepare(
            'SELECT key, value, created_at, updated_at FROM guidelines ORDER BY key'
        ).all() as GuidelineRow[];
    }

    deleteGuideline(key: string): boolean {
        const result = this.db.prepare('DELETE FROM guidelines WHERE key = ?').run(key);
        return result.changes > 0;
    }

    // --------------------------------------------------------
    // Scheduled Tasks (mirror/cache)
    // --------------------------------------------------------

    /**
     * Upsert a scheduled task into the global mirror table.
     */
    upsertScheduledTask(projectPath: string, taskId: number, due: number, interval: string | null, autoGo: number): void {
        this.db.prepare(`
            INSERT INTO scheduled_tasks (project_path, task_id, due, interval, auto_go)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(project_path, task_id) DO UPDATE SET
                due = excluded.due,
                interval = excluded.interval,
                auto_go = excluded.auto_go
        `).run(normalizePath(projectPath), taskId, due, interval, autoGo);
    }

    /**
     * Remove a scheduled task from the global mirror.
     */
    removeScheduledTask(projectPath: string, taskId: number): void {
        this.db.prepare(
            'DELETE FROM scheduled_tasks WHERE project_path = ? AND task_id = ?'
        ).run(normalizePath(projectPath), taskId);
    }

    /**
     * Remove all scheduled tasks for a project.
     */
    removeScheduledTasksByProject(projectPath: string): void {
        this.db.prepare(
            'DELETE FROM scheduled_tasks WHERE project_path = ?'
        ).run(normalizePath(projectPath));
    }

    /**
     * Get all scheduled tasks that are due (due <= now).
     */
    getDueScheduledTasks(now?: number): ScheduledTaskRow[] {
        const ts = now ?? Date.now();
        return this.db.prepare(
            'SELECT * FROM scheduled_tasks WHERE due <= ? ORDER BY due ASC'
        ).all(ts) as ScheduledTaskRow[];
    }

    /**
     * Get all scheduled tasks (for status display).
     */
    getAllScheduledTasks(): ScheduledTaskRow[] {
        return this.db.prepare(
            'SELECT * FROM scheduled_tasks ORDER BY due ASC'
        ).all() as ScheduledTaskRow[];
    }

    /**
     * Update the due timestamp for a scheduled task (after interval advancement).
     */
    updateScheduledTaskDue(projectPath: string, taskId: number, newDue: number): void {
        this.db.prepare(
            'UPDATE scheduled_tasks SET due = ? WHERE project_path = ? AND task_id = ?'
        ).run(newDue, normalizePath(projectPath), taskId);
    }

    // --------------------------------------------------------
    // Lifecycle
    // --------------------------------------------------------

    getDb(): Database.Database {
        return this.db;
    }

    getPath(): string {
        return this.dbPath;
    }

    close(): void {
        this.db.close();
    }
}

// ============================================================
// Helpers
// ============================================================

/**
 * Check if global.db exists
 */
export function globalDbExists(): boolean {
    return existsSync(GLOBAL_DB_PATH);
}

/**
 * Get the global DB path
 */
export function getGlobalDbPath(): string {
    return GLOBAL_DB_PATH;
}

/**
 * Get the global directory path
 */
export function getGlobalDir(): string {
    return GLOBAL_DIR;
}

/**
 * Open the global database (creates if not exists)
 */
export function openGlobalDatabase(): GlobalDatabase {
    return new GlobalDatabase();
}

/**
 * Read project stats from a project's index.db
 */
export function readProjectStats(projectPath: string): ProjectStats | null {
    const dbPath = join(projectPath, INDEX_DIR, 'index.db');
    if (!existsSync(dbPath)) return null;

    try {
        const db = new Database(dbPath, { readonly: true });

        const counts = {
            files: (db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number }).c,
            items: (db.prepare('SELECT COUNT(*) as c FROM items').get() as { c: number }).c,
            methods: (db.prepare('SELECT COUNT(*) as c FROM methods').get() as { c: number }).c,
            types: (db.prepare('SELECT COUNT(*) as c FROM types').get() as { c: number }).c,
        };

        // Get DB size
        const pragmaResult = db.pragma('page_count') as Array<{ page_count: number }>;
        const pageSizeResult = db.pragma('page_size') as Array<{ page_size: number }>;
        const pageCount = pragmaResult[0]?.page_count ?? 0;
        const pageSize = pageSizeResult[0]?.page_size ?? 4096;
        const sizeBytes = pageCount * pageSize;

        // Get languages from indexed files
        const fileExts = db.prepare(
            "SELECT DISTINCT SUBSTR(path, INSTR(path, '.')) as ext FROM files WHERE path LIKE '%.%'"
        ).all() as Array<{ ext: string }>;

        const langMap: Record<string, string> = {
            '.cs': 'C#', '.ts': 'TypeScript', '.tsx': 'TypeScript',
            '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
            '.rs': 'Rust', '.py': 'Python', '.pyw': 'Python',
            '.c': 'C', '.h': 'C', '.cpp': 'C++', '.cc': 'C++', '.cxx': 'C++', '.hpp': 'C++', '.hxx': 'C++',
            '.java': 'Java', '.go': 'Go', '.php': 'PHP', '.rb': 'Ruby', '.rake': 'Ruby',
            '.tf': 'HCL/Terraform', '.tfvars': 'HCL/Terraform', '.hcl': 'HCL/Terraform',
        };

        const languages = [...new Set(
            fileExts.map(e => langMap[e.ext]).filter(Boolean)
        )] as string[];

        // Get last indexed timestamp
        const lastIndexedRow = db.prepare(
            "SELECT value FROM metadata WHERE key = 'last_indexed'"
        ).get() as { value: string } | undefined;
        const lastIndexed = lastIndexedRow ? parseInt(lastIndexedRow.value, 10) : null;

        db.close();

        return {
            files: counts.files,
            items: counts.items,
            methods: counts.methods,
            types: counts.types,
            sizeBytes,
            languages,
            lastIndexed,
        };
    } catch {
        return null;
    }
}
