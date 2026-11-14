/**
 * Tests for project guidelines and the "always" delivery at session start.
 * Project scope only: the global guideline store (~/.aidex/global.db) is not touched.
 */

import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';

import { projectGuideline, loadAlwaysGuidelines, ALWAYS_BUDGET } from '../build/commands/guidelines.js';

function createTempProject() {
    const dir = mkdtempSync(join(tmpdir(), 'aidex-guideline-test-'));
    mkdirSync(join(dir, '.aidex'));
    const db = new Database(join(dir, '.aidex', 'index.db'));
    db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);');
    db.close();
    return dir;
}

describe('project guidelines', () => {
    let dir;
    beforeEach(() => { dir = createTempProject(); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    test('set / get / list / delete', () => {
        expect(projectGuideline({ path: dir, action: 'set', key: 'main', value: 'Rule A' }).success).toBe(true);
        expect(projectGuideline({ path: dir, action: 'set', key: 'extra', value: 'Rule B' }).success).toBe(true);

        const got = projectGuideline({ path: dir, action: 'get', key: 'main' });
        expect(got.guideline).toEqual({ key: 'main', value: 'Rule A', always: false });

        const list = projectGuideline({ path: dir, action: 'list' });
        expect(list.guidelines.map(g => g.key)).toEqual(['extra', 'main']);

        expect(projectGuideline({ path: dir, action: 'delete', key: 'extra' }).deleted).toBe(true);
        expect(projectGuideline({ path: dir, action: 'get', key: 'extra' }).success).toBe(false);
    });

    test('missing key / value / index are reported', () => {
        expect(projectGuideline({ path: dir, action: 'set', value: 'x' }).success).toBe(false);
        expect(projectGuideline({ path: dir, action: 'set', key: 'k' }).success).toBe(false);
        expect(projectGuideline({ path: join(dir, 'nowhere'), action: 'list' }).success).toBe(false);
    });

    test('always flag: set, keep on re-set, clear, cleared on delete', () => {
        projectGuideline({ path: dir, action: 'set', key: 'main', value: 'Rule A', always: true });
        expect(projectGuideline({ path: dir, action: 'get', key: 'main' }).guideline.always).toBe(true);

        // Re-setting without the flag keeps the mark.
        projectGuideline({ path: dir, action: 'set', key: 'main', value: 'Rule A2' });
        expect(projectGuideline({ path: dir, action: 'get', key: 'main' }).guideline.always).toBe(true);

        projectGuideline({ path: dir, action: 'set', key: 'main', value: 'Rule A2', always: false });
        expect(projectGuideline({ path: dir, action: 'get', key: 'main' }).guideline.always).toBe(false);

        projectGuideline({ path: dir, action: 'set', key: 'main', value: 'Rule A3', always: true });
        projectGuideline({ path: dir, action: 'delete', key: 'main' });
        projectGuideline({ path: dir, action: 'set', key: 'main', value: 'fresh' });
        expect(projectGuideline({ path: dir, action: 'get', key: 'main' }).guideline.always).toBe(false);
    });

    test('loadAlwaysGuidelines delivers project "always" texts, other keys by name', () => {
        projectGuideline({ path: dir, action: 'set', key: 'main', value: '  Rule A  ', always: true });
        projectGuideline({ path: dir, action: 'set', key: 'detail', value: 'Long detail' });

        const a = loadAlwaysGuidelines(dir);
        expect(a.project).toEqual([{ key: 'main', value: 'Rule A' }]);
        expect(a.otherProjectKeys).toEqual(['detail']);
        expect(a.chars).toBeGreaterThanOrEqual(6);
        expect(ALWAYS_BUDGET).toBeGreaterThan(0);
    });
});
