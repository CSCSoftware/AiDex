/**
 * Tests for Global Task Scheduler
 *
 * Tests the scheduler logic: interval parsing, due date parsing,
 * task creation with scheduler fields, global mirror sync,
 * and the checkScheduledTasks() flow.
 */

import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import Database from 'better-sqlite3';

// ============================================================
// Module imports (built JS)
// ============================================================

import { parseIntervalToMs, parseDueDate } from '../build/commands/shared.js';
import { checkScheduledTasks } from '../build/commands/global/global-scheduler.js';
import { task, tasks } from '../build/commands/task.js';

// ============================================================
// Test helpers
// ============================================================

/**
 * Create a temporary project with .aidex/index.db
 */
function createTempProject() {
    const dir = mkdtempSync(join(tmpdir(), 'aidex-test-'));
    const aidexDir = join(dir, '.aidex');
    mkdirSync(aidexDir);

    // Create minimal index.db with schema
    const db = new Database(join(aidexDir, 'index.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Minimal schema for tasks + metadata
    db.exec(`
        CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE,
            hash TEXT,
            last_indexed INTEGER
        );
        CREATE TABLE IF NOT EXISTS metadata (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            summary TEXT,
            priority INTEGER NOT NULL DEFAULT 2,
            status TEXT NOT NULL DEFAULT 'backlog',
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
        CREATE TABLE IF NOT EXISTS task_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            note TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, term TEXT);
        CREATE TABLE IF NOT EXISTS occurrences (item_id INTEGER, file_id INTEGER, line_id INTEGER);
        CREATE TABLE IF NOT EXISTS lines (id INTEGER PRIMARY KEY, file_id INTEGER, line_number INTEGER, line_type TEXT, line_hash TEXT, modified INTEGER);
        CREATE TABLE IF NOT EXISTS methods (id INTEGER PRIMARY KEY, file_id INTEGER, name TEXT, prototype TEXT, line_number INTEGER, visibility TEXT, is_static INTEGER, is_async INTEGER);
        CREATE TABLE IF NOT EXISTS types (id INTEGER PRIMARY KEY, file_id INTEGER, name TEXT, kind TEXT, line_number INTEGER);
        CREATE TABLE IF NOT EXISTS signatures (file_id INTEGER, header_comments TEXT);
        CREATE TABLE IF NOT EXISTS project_files (id INTEGER PRIMARY KEY, path TEXT, type TEXT, extension TEXT, indexed INTEGER);
    `);
    db.close();

    return dir;
}

function cleanupTempProject(dir) {
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch {
        // Ignore cleanup errors on Windows
    }
}

// ============================================================
// Tests: parseIntervalToMs
// ============================================================

describe('parseIntervalToMs', () => {
    test('parses minutes', () => {
        expect(parseIntervalToMs('30m')).toBe(30 * 60 * 1000);
        expect(parseIntervalToMs('1m')).toBe(60 * 1000);
    });

    test('parses hours', () => {
        expect(parseIntervalToMs('2h')).toBe(2 * 60 * 60 * 1000);
        expect(parseIntervalToMs('12h')).toBe(12 * 60 * 60 * 1000);
    });

    test('parses days', () => {
        expect(parseIntervalToMs('3d')).toBe(3 * 24 * 60 * 60 * 1000);
        expect(parseIntervalToMs('1d')).toBe(24 * 60 * 60 * 1000);
    });

    test('parses weeks', () => {
        expect(parseIntervalToMs('1w')).toBe(7 * 24 * 60 * 60 * 1000);
        expect(parseIntervalToMs('2w')).toBe(14 * 24 * 60 * 60 * 1000);
    });

    test('returns null for invalid input', () => {
        expect(parseIntervalToMs('')).toBeNull();
        expect(parseIntervalToMs('abc')).toBeNull();
        expect(parseIntervalToMs('3x')).toBeNull();
        expect(parseIntervalToMs('3')).toBeNull();
    });
});

// ============================================================
// Tests: parseDueDate
// ============================================================

describe('parseDueDate', () => {
    test('parses relative intervals as future timestamps', () => {
        const before = Date.now();
        const result = parseDueDate('3d');
        const after = Date.now();

        const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
        expect(result).toBeGreaterThanOrEqual(before + threeDaysMs);
        expect(result).toBeLessThanOrEqual(after + threeDaysMs);
    });

    test('parses ISO date strings', () => {
        const result = parseDueDate('2026-04-10T14:00:00Z');
        expect(result).toBe(new Date('2026-04-10T14:00:00Z').getTime());
    });

    test('parses date-only strings', () => {
        const result = parseDueDate('2026-04-10');
        expect(result).not.toBeNull();
        expect(new Date(result).getFullYear()).toBe(2026);
    });

    test('returns null for invalid input', () => {
        expect(parseDueDate('')).toBeNull();
        expect(parseDueDate('not-a-date')).toBeNull();
    });
});

// ============================================================
// Tests: Task CRUD with scheduler fields
// ============================================================

describe('task with scheduler fields', () => {
    let projectDir;

    beforeEach(() => {
        projectDir = createTempProject();
    });

    afterEach(() => {
        cleanupTempProject(projectDir);
    });

    test('create task with due, interval, action, auto_go', () => {
        const result = task({
            path: projectDir,
            action: 'create',
            title: 'Scheduled test task',
            due: '2d',
            interval: '1w',
            task_action: 'check something',
            auto_go: true,
        });

        expect(result.success).toBe(true);
        expect(result.task.title).toBe('Scheduled test task');
        expect(result.task.due).toBeGreaterThan(Date.now());
        expect(result.task.interval).toBe('1w');
        expect(result.task.action).toBe('check something');
        expect(result.task.auto_go).toBe(1);
    });

    test('create task without scheduler fields (backwards compatible)', () => {
        const result = task({
            path: projectDir,
            action: 'create',
            title: 'Normal task',
            priority: 1,
        });

        expect(result.success).toBe(true);
        expect(result.task.due).toBeNull();
        expect(result.task.interval).toBeNull();
        expect(result.task.action).toBeNull();
        expect(result.task.auto_go).toBe(0);
    });

    test('update task to add due date', () => {
        const created = task({
            path: projectDir,
            action: 'create',
            title: 'Later scheduled',
        });
        expect(created.success).toBe(true);

        const updated = task({
            path: projectDir,
            action: 'update',
            id: created.task.id,
            due: '1d',
            interval: '3d',
        });

        expect(updated.success).toBe(true);
        expect(updated.task.due).toBeGreaterThan(Date.now());
        expect(updated.task.interval).toBe('3d');
    });

    test('update task to clear due date', () => {
        const created = task({
            path: projectDir,
            action: 'create',
            title: 'Remove schedule',
            due: '1d',
        });

        const updated = task({
            path: projectDir,
            action: 'update',
            id: created.task.id,
            due: '',
        });

        expect(updated.success).toBe(true);
        expect(updated.task.due).toBeNull();
    });

    test('invalid due date returns error', () => {
        const result = task({
            path: projectDir,
            action: 'create',
            title: 'Bad due',
            due: 'not-valid-at-all',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid due date');
    });

    test('task list shows due info', () => {
        task({
            path: projectDir,
            action: 'create',
            title: 'Scheduled',
            due: '1d',
            interval: '1w',
        });
        task({
            path: projectDir,
            action: 'create',
            title: 'Not scheduled',
        });

        const list = tasks({ path: projectDir });
        expect(list.success).toBe(true);
        expect(list.tasks.length).toBe(2);

        const scheduled = list.tasks.find(t => t.title === 'Scheduled');
        const normal = list.tasks.find(t => t.title === 'Not scheduled');

        expect(scheduled.due).toBeGreaterThan(0);
        expect(scheduled.interval).toBe('1w');
        expect(normal.due).toBeNull();
    });
});

// ============================================================
// Tests: Global mirror sync
// ============================================================

describe('global mirror sync', () => {
    let projectDir;
    const globalDbPath = join(homedir(), '.aidex', 'global.db');

    beforeEach(() => {
        projectDir = createTempProject();
        // Clean up any test entries from global.db
        if (existsSync(globalDbPath)) {
            const db = new Database(globalDbPath);
            db.exec("DELETE FROM scheduled_tasks WHERE project_path LIKE '%aidex-test-%'");
            db.close();
        }
    });

    afterEach(() => {
        // Clean up test entries
        if (existsSync(globalDbPath)) {
            const db = new Database(globalDbPath);
            db.exec("DELETE FROM scheduled_tasks WHERE project_path LIKE '%aidex-test-%'");
            db.close();
        }
        cleanupTempProject(projectDir);
    });

    function getGlobalScheduledTasks(path) {
        if (!existsSync(globalDbPath)) return [];
        const db = new Database(globalDbPath, { readonly: true });
        const normalizedPath = path.replace(/\\/g, '/');
        const rows = db.prepare(
            'SELECT * FROM scheduled_tasks WHERE project_path = ?'
        ).all(normalizedPath);
        db.close();
        return rows;
    }

    test('task with due syncs to global.db', () => {
        const result = task({
            path: projectDir,
            action: 'create',
            title: 'Synced task',
            due: '2d',
            interval: '1w',
        });

        expect(result.success).toBe(true);
        const global = getGlobalScheduledTasks(projectDir);
        expect(global.length).toBe(1);
        expect(global[0].task_id).toBe(result.task.id);
        expect(global[0].interval).toBe('1w');
    });

    test('task without due does NOT sync to global.db', () => {
        task({
            path: projectDir,
            action: 'create',
            title: 'No schedule',
        });

        const global = getGlobalScheduledTasks(projectDir);
        expect(global.length).toBe(0);
    });

    test('completing task removes from global.db', () => {
        const created = task({
            path: projectDir,
            action: 'create',
            title: 'Will complete',
            due: '2d',
        });

        // Verify it's in global
        let global = getGlobalScheduledTasks(projectDir);
        expect(global.length).toBe(1);

        // Complete it
        task({
            path: projectDir,
            action: 'update',
            id: created.task.id,
            status: 'done',
        });

        // Should be gone from global
        global = getGlobalScheduledTasks(projectDir);
        expect(global.length).toBe(0);
    });

    test('deleting task removes from global.db', () => {
        const created = task({
            path: projectDir,
            action: 'create',
            title: 'Will delete',
            due: '1d',
        });

        let global = getGlobalScheduledTasks(projectDir);
        expect(global.length).toBe(1);

        task({
            path: projectDir,
            action: 'delete',
            id: created.task.id,
        });

        global = getGlobalScheduledTasks(projectDir);
        expect(global.length).toBe(0);
    });

    test('clearing due removes from global.db', () => {
        const created = task({
            path: projectDir,
            action: 'create',
            title: 'Clear due',
            due: '1d',
        });

        let global = getGlobalScheduledTasks(projectDir);
        expect(global.length).toBe(1);

        task({
            path: projectDir,
            action: 'update',
            id: created.task.id,
            due: '',
        });

        global = getGlobalScheduledTasks(projectDir);
        expect(global.length).toBe(0);
    });
});

// ============================================================
// Tests: checkScheduledTasks
// ============================================================

describe('checkScheduledTasks', () => {
    let projectDir;
    const globalDbPath = join(homedir(), '.aidex', 'global.db');

    beforeEach(() => {
        projectDir = createTempProject();
        if (existsSync(globalDbPath)) {
            const db = new Database(globalDbPath);
            db.exec("DELETE FROM scheduled_tasks WHERE project_path LIKE '%aidex-test-%'");
            db.close();
        }
    });

    afterEach(() => {
        if (existsSync(globalDbPath)) {
            const db = new Database(globalDbPath);
            db.exec("DELETE FROM scheduled_tasks WHERE project_path LIKE '%aidex-test-%'");
            db.close();
        }
        cleanupTempProject(projectDir);
    });

    test('returns active:true when global.db exists', () => {
        const result = checkScheduledTasks();
        expect(result.active).toBe(true);
    });

    test('finds overdue task', () => {
        // Create task with due in the past
        const created = task({
            path: projectDir,
            action: 'create',
            title: 'Overdue task',
            due: '2026-01-01T00:00:00Z',
            task_action: 'do something',
        });
        expect(created.success).toBe(true);

        const result = checkScheduledTasks();
        expect(result.dueTasks.length).toBeGreaterThanOrEqual(1);

        const found = result.dueTasks.find(dt => dt.task.id === created.task.id);
        expect(found).toBeDefined();
        expect(found.task.title).toBe('Overdue task');
        expect(found.task.action).toBe('do something');
        expect(found.autoGo).toBe(false);
    });

    test('one-shot task: due cleared after trigger', () => {
        const created = task({
            path: projectDir,
            action: 'create',
            title: 'One-shot',
            due: '2026-01-01T00:00:00Z',
        });

        checkScheduledTasks();

        // Read task — due should be null now
        const after = task({ path: projectDir, action: 'read', id: created.task.id });
        expect(after.task.due).toBeNull();
    });

    test('interval task: due advanced after trigger', () => {
        const created = task({
            path: projectDir,
            action: 'create',
            title: 'Recurring',
            due: '2026-01-01T00:00:00Z',
            interval: '3d',
        });

        const before = Date.now();
        checkScheduledTasks();
        const after = Date.now();

        // Read task — due should be ~3 days from now
        const read = task({ path: projectDir, action: 'read', id: created.task.id });
        const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
        expect(read.task.due).toBeGreaterThanOrEqual(before + threeDaysMs);
        expect(read.task.due).toBeLessThanOrEqual(after + threeDaysMs);
    });

    test('does not trigger future tasks', () => {
        task({
            path: projectDir,
            action: 'create',
            title: 'Future task',
            due: '2099-01-01T00:00:00Z',
        });

        const result = checkScheduledTasks();
        const found = result.dueTasks.find(dt => dt.task.title === 'Future task');
        expect(found).toBeUndefined();
    });

    test('skips done tasks', () => {
        const created = task({
            path: projectDir,
            action: 'create',
            title: 'Done task',
            due: '2026-01-01T00:00:00Z',
        });

        // Mark as done (should remove from global)
        task({
            path: projectDir,
            action: 'update',
            id: created.task.id,
            status: 'done',
        });

        const result = checkScheduledTasks();
        const found = result.dueTasks.find(dt => dt.task.title === 'Done task');
        expect(found).toBeUndefined();
    });
});
