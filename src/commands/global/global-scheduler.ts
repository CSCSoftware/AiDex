/**
 * Global Task Scheduler
 *
 * Checks for due tasks across all projects at session start.
 * Processes due tasks: reports them, advances recurring intervals.
 *
 * Architecture:
 * - Tasks with `due` dates are mirrored in global.db/scheduled_tasks
 * - On every aidex_session call, this module scans for due tasks
 * - Recurring tasks get their `due` advanced by `interval`
 * - One-shot tasks get `due` cleared after trigger
 */

import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { openDatabase, createQueries } from '../../db/index.js';
import { GlobalDatabase, globalDbExists, type ScheduledTaskRow } from '../../db/global-database.js';
import { INDEX_DIR } from '../../constants.js';
import type { TaskRow } from '../../db/queries.js';
import { parseIntervalToMs } from '../shared.js';
import { ensureTaskTables } from '../task.js';

// ============================================================
// Types
// ============================================================

export interface DueTask {
    projectPath: string;
    projectName: string;
    task: TaskRow;
    autoGo: boolean;
}

export interface SchedulerResult {
    active: boolean;
    dueTasks: DueTask[];
    processed: number;
    errors: string[];
}

// ============================================================
// Scheduler Check
// ============================================================

/**
 * Check for due scheduled tasks across all projects.
 * Called from session.ts at every session start/continue.
 */
export function checkScheduledTasks(): SchedulerResult {
    if (!globalDbExists()) {
        return { active: false, dueTasks: [], processed: 0, errors: [] };
    }

    let globalDb: GlobalDatabase | null = null;
    try {
        globalDb = new GlobalDatabase();
        const now = Date.now();
        const dueRows = globalDb.getDueScheduledTasks(now);

        if (dueRows.length === 0) {
            return { active: true, dueTasks: [], processed: 0, errors: [] };
        }

        const dueTasks: DueTask[] = [];
        const errors: string[] = [];

        for (const row of dueRows) {
            try {
                const projectPath = resolve(row.project_path);
                const dbPath = join(projectPath, INDEX_DIR, 'index.db');

                if (!existsSync(dbPath)) {
                    // Project DB missing — remove stale entry
                    globalDb.removeScheduledTask(row.project_path, row.task_id);
                    errors.push(`Stale schedule removed: DB missing at ${row.project_path}`);
                    continue;
                }

                const db = openDatabase(dbPath, false);
                try {
                    // Ensure scheduler columns exist (migration for older DBs)
                    ensureTaskTables(db);
                    const queries = createQueries(db);
                    const task = queries.getTaskById(row.task_id);

                    if (!task) {
                        // Task deleted externally
                        globalDb.removeScheduledTask(row.project_path, row.task_id);
                        continue;
                    }

                    if (task.status === 'done' || task.status === 'cancelled') {
                        // Task completed/cancelled externally
                        globalDb.removeScheduledTask(row.project_path, row.task_id);
                        continue;
                    }

                    // Get project name
                    const projectName = row.project_path.split('/').pop() || row.project_path;

                    dueTasks.push({
                        projectPath: row.project_path,
                        projectName,
                        task,
                        autoGo: row.auto_go === 1,
                    });

                    // Advance the schedule
                    if (row.interval) {
                        const intervalMs = parseIntervalToMs(row.interval);
                        if (intervalMs) {
                            const nextDue = now + intervalMs;
                            // Update project DB
                            queries.updateTask(row.task_id, { due: nextDue });
                            // Update global mirror
                            globalDb.updateScheduledTaskDue(row.project_path, row.task_id, nextDue);
                        }
                    } else {
                        // One-shot: clear due in project DB, remove from global
                        queries.updateTask(row.task_id, { due: null });
                        globalDb.removeScheduledTask(row.project_path, row.task_id);
                    }
                } finally {
                    db.close();
                }
            } catch (err) {
                errors.push(`Error: task #${row.task_id} in ${row.project_path}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        return { active: true, dueTasks, processed: dueTasks.length, errors };
    } catch {
        // Don't let scheduler errors break anything
        return { active: false, dueTasks: [], processed: 0, errors: [] };
    } finally {
        globalDb?.close();
    }
}
