/**
 * task command - Project backlog management
 *
 * Minimal task/backlog system stored in the project's AiDex database.
 * Supports CRUD operations, priority management, tags, and task history log.
 * Completed tasks are preserved as documentation.
 */

import type { AiDexDatabase } from '../db/index.js';
import type { TaskRow, TaskLogRow } from '../db/index.js';
import { broadcastTaskUpdate } from '../viewer/server.js';
import { validateIndex, noIndexError, withDatabase, normalizePath, parseDueDate } from './shared.js';
import { GlobalDatabase, globalDbExists } from '../db/global-database.js';

// ============================================================
// Types
// ============================================================

export type TaskAction = 'create' | 'read' | 'update' | 'delete' | 'log';

export interface TaskParams {
    path: string;
    action: TaskAction;
    id?: number;
    title?: string;
    description?: string;
    summary?: string;
    priority?: 1 | 2 | 3;
    status?: 'backlog' | 'active' | 'done' | 'cancelled';
    tags?: string;
    source?: string;
    sort_order?: number;
    note?: string;
    // Scheduler fields
    due?: string;            // ISO date or relative ("3d", "1w")
    interval?: string;       // repeat interval ("3d", "1w", "12h")
    task_action?: string;    // what to do when triggered (DB column: action)
    auto_go?: boolean;       // auto-execute on trigger
}

export interface TaskResult {
    success: boolean;
    action: TaskAction;
    task?: TaskRow;
    log?: TaskLogRow[];
    error?: string;
}

export interface TasksParams {
    path: string;
    status?: 'backlog' | 'active' | 'done' | 'cancelled';
    priority?: 1 | 2 | 3;
    tag?: string;
}

export interface TasksResult {
    success: boolean;
    tasks: TaskRow[];
    total: number;
    error?: string;
}

// ============================================================
// Auto-migration (creates tables if they don't exist yet)
// ============================================================

const TASKS_MIGRATION = `
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    summary TEXT,
    priority INTEGER NOT NULL DEFAULT 2 CHECK(priority IN (1, 2, 3)),
    status TEXT NOT NULL DEFAULT 'backlog' CHECK(status IN ('backlog', 'active', 'done', 'cancelled')),
    tags TEXT,
    source TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    due INTEGER,
    interval TEXT,
    action TEXT,
    auto_go INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE TABLE IF NOT EXISTS task_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    note TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_log_task ON task_log(task_id);
`;

// Migration: Add 'cancelled' to status CHECK constraint
// SQLite can't ALTER CHECK constraints, so we recreate the table
const TASKS_MIGRATE_CANCELLED = `
CREATE TABLE IF NOT EXISTS tasks_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    summary TEXT,
    priority INTEGER NOT NULL DEFAULT 2 CHECK(priority IN (1, 2, 3)),
    status TEXT NOT NULL DEFAULT 'backlog' CHECK(status IN ('backlog', 'active', 'done', 'cancelled')),
    tags TEXT,
    source TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    due INTEGER,
    interval TEXT,
    action TEXT,
    auto_go INTEGER DEFAULT 0
);
INSERT INTO tasks_new (id, title, description, priority, status, tags, source, sort_order, created_at, updated_at, completed_at)
    SELECT id, title, description, priority, status, tags, source, sort_order, created_at, updated_at, completed_at FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due);
`;

export function ensureTaskTables(db: AiDexDatabase): void {
    const sqlite = db.getDb();
    sqlite.exec(TASKS_MIGRATION);

    // Check if existing table needs migration (missing 'cancelled' in CHECK)
    const tableInfo = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string | null } | undefined;
    if (tableInfo?.sql && !tableInfo.sql.includes('cancelled')) {
        sqlite.exec(TASKS_MIGRATE_CANCELLED);
    }

    // Add summary column if missing (for existing DBs before v1.15)
    const hasSummary = sqlite.prepare(
        "SELECT COUNT(*) as cnt FROM pragma_table_info('tasks') WHERE name = 'summary'"
    ).get() as { cnt: number };
    if (hasSummary.cnt === 0) {
        sqlite.exec('ALTER TABLE tasks ADD COLUMN summary TEXT');
    }

    // Add scheduler columns if missing (for existing DBs before v1.17)
    for (const col of ['due', 'interval', 'action', 'auto_go']) {
        const has = sqlite.prepare(
            "SELECT COUNT(*) as cnt FROM pragma_table_info('tasks') WHERE name = ?"
        ).get(col) as { cnt: number };
        if (has.cnt === 0) {
            const type = (col === 'due' || col === 'auto_go') ? 'INTEGER' : 'TEXT';
            const def = col === 'auto_go' ? ' DEFAULT 0' : '';
            sqlite.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${type}${def}`);
        }
    }
    // Ensure due index exists
    sqlite.exec('CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due)');
}

/**
 * Sync a task's scheduling state to the global scheduled_tasks mirror.
 */
function syncScheduleToGlobal(projectPath: string, taskId: number, task: TaskRow | undefined): void {
    if (!globalDbExists()) return;

    try {
        const globalDb = new GlobalDatabase();
        try {
            if (!task || task.status === 'done' || task.status === 'cancelled' || task.due == null) {
                globalDb.removeScheduledTask(projectPath, taskId);
            } else {
                globalDb.upsertScheduledTask(
                    projectPath,
                    taskId,
                    task.due,
                    task.interval ?? null,
                    task.auto_go ?? 0
                );
            }
        } finally {
            globalDb.close();
        }
    } catch {
        // Silently ignore global sync errors — project DB is source of truth
    }
}

// ============================================================
// Implementation: aidex_task (single task CRUD + log)
// ============================================================

export function task(params: TaskParams): TaskResult {
    const { path: projectPath, action } = params;

    const dbPath = validateIndex(projectPath);
    if (!dbPath) {
        return {
            success: false,
            action,
            error: noIndexError(projectPath),
        };
    }

    let resultRef: TaskResult | null = null;
    try {
        const result = withDatabase(dbPath, false, (db, queries) => {
            try {
                ensureTaskTables(db);

                switch (action) {
                    case 'create': {
                        if (!params.title) {
                            return { success: false, action, error: 'title is required for create' };
                        }
                        // Parse due date
                        let dueTs: number | null = null;
                        if (params.due) {
                            dueTs = parseDueDate(params.due);
                            if (dueTs === null) {
                                return { success: false, action, error: `Invalid due date: "${params.due}". Use ISO date or relative (e.g., "3d", "1w")` };
                            }
                        }
                        const id = queries.insertTask(
                            params.title,
                            params.description ?? null,
                            params.summary ?? null,
                            params.priority ?? 2,
                            params.status ?? 'backlog',
                            params.tags ?? null,
                            params.source ?? null,
                            params.sort_order ?? 0,
                            dueTs,
                            params.interval ?? null,
                            params.task_action ?? null,
                            params.auto_go ? 1 : 0
                        );
                        const created = queries.getTaskById(id);
                        // Auto-log creation
                        queries.insertTaskLog(id, `Task created: ${params.title}`);
                        // Sync schedule to global
                        syncScheduleToGlobal(projectPath, id, created);
                        return { success: true, action, task: created };
                    }

                    case 'read': {
                        if (!params.id) {
                            return { success: false, action, error: 'id is required for read' };
                        }
                        const t = queries.getTaskById(params.id);
                        if (!t) {
                            return { success: false, action, error: `Task #${params.id} not found` };
                        }
                        const log = queries.getTaskLog(params.id);
                        return { success: true, action, task: t, log };
                    }

                    case 'update': {
                        if (!params.id) {
                            return { success: false, action, error: 'id is required for update' };
                        }
                        const fields: Record<string, unknown> = {};
                        if (params.title !== undefined) fields.title = params.title;
                        if (params.description !== undefined) fields.description = params.description;
                        if (params.summary !== undefined) fields.summary = params.summary;
                        if (params.priority !== undefined) fields.priority = params.priority;
                        if (params.status !== undefined) fields.status = params.status;
                        if (params.tags !== undefined) fields.tags = params.tags;
                        if (params.source !== undefined) fields.source = params.source;
                        if (params.sort_order !== undefined) fields.sort_order = params.sort_order;
                        // Scheduler fields
                        if (params.due !== undefined) {
                            if (params.due === '' || params.due === null) {
                                fields.due = null;
                            } else {
                                const dueTs = parseDueDate(params.due);
                                if (dueTs === null) {
                                    return { success: false, action, error: `Invalid due date: "${params.due}"` };
                                }
                                fields.due = dueTs;
                            }
                        }
                        if (params.interval !== undefined) fields.interval = params.interval || null;
                        if (params.task_action !== undefined) fields.action = params.task_action || null;
                        if (params.auto_go !== undefined) fields.auto_go = params.auto_go ? 1 : 0;

                        const updated = queries.updateTask(params.id, fields);
                        if (!updated) {
                            return { success: false, action, error: `Task #${params.id} not found` };
                        }

                        // Auto-log status changes
                        if (params.status) {
                            queries.insertTaskLog(params.id, `Status changed to: ${params.status}`);
                        }

                        const t = queries.getTaskById(params.id);
                        // Sync schedule to global
                        syncScheduleToGlobal(projectPath, params.id, t);
                        return { success: true, action, task: t };
                    }

                    case 'delete': {
                        if (!params.id) {
                            return { success: false, action, error: 'id is required for delete' };
                        }
                        // Remove from global mirror before deleting
                        syncScheduleToGlobal(projectPath, params.id, undefined);
                        const deleted = queries.deleteTask(params.id);
                        if (!deleted) {
                            return { success: false, action, error: `Task #${params.id} not found` };
                        }
                        return { success: true, action };
                    }

                    case 'log': {
                        if (!params.id) {
                            return { success: false, action, error: 'id is required for log' };
                        }
                        if (!params.note) {
                            return { success: false, action, error: 'note is required for log' };
                        }
                        const existing = queries.getTaskById(params.id);
                        if (!existing) {
                            return { success: false, action, error: `Task #${params.id} not found` };
                        }
                        queries.insertTaskLog(params.id, params.note);
                        const log = queries.getTaskLog(params.id);
                        return { success: true, action, task: existing, log };
                    }

                    default:
                        return { success: false, action, error: `Unknown action: ${action}` };
                }
            } catch (error) {
                return {
                    success: false,
                    action,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        });
        resultRef = result;
        return result;
    } finally {
        // Notify viewer of task changes (no-op if viewer not running)
        if (action !== 'read') {
            broadcastTaskUpdate();
        }
        // Fire-and-forget: refresh embeddings if a task changed.
        // No-op if embeddings aren't enabled for this project.
        if (action !== 'read') {
            const taskId = params.id ?? resultRef?.task?.id;
            if (taskId != null) {
                void notifyEmbeddingsTaskChanged(projectPath, taskId);
            }
        }
    }
}

async function notifyEmbeddingsTaskChanged(projectPath: string, taskId: number): Promise<void> {
    try {
        const { getEmbeddings } = await import('../embeddings/index.js');
        await getEmbeddings().onTaskChanged(projectPath, taskId);
    } catch {
        // Embeddings are best-effort; never break the user's task action.
    }
}

// ============================================================
// Implementation: aidex_tasks (list/filter)
// ============================================================

export function tasks(params: TasksParams): TasksResult {
    const { path: projectPath } = params;

    const dbPath = validateIndex(projectPath);
    if (!dbPath) {
        return {
            success: false,
            tasks: [],
            total: 0,
            error: noIndexError(projectPath),
        };
    }

    return withDatabase(dbPath, false, (db, queries) => {
        try {
            ensureTaskTables(db);
            let result: TaskRow[];

            if (params.status) {
                result = queries.getTasksByStatus(params.status);
            } else {
                result = queries.getAllTasks();
            }

            // Client-side filtering for priority and tag
            if (params.priority) {
                result = result.filter(t => t.priority === params.priority);
            }
            if (params.tag) {
                const tagLower = params.tag.toLowerCase();
                result = result.filter(t =>
                    t.tags?.toLowerCase().split(',').map(s => s.trim()).includes(tagLower)
                );
            }

            return { success: true, tasks: result, total: result.length };
        } catch (error) {
            return {
                success: false,
                tasks: [],
                total: 0,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    });
}
