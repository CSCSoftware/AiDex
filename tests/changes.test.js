/**
 * Tests for the structural change log (db/change-log.ts) and aidex_changes (commands/changes.ts).
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';

import { diffStructure, netStructureChanges } from '../build/db/change-log.js';
import { changes, formatChangesText, extractCommentLine, parseSince } from '../build/commands/changes.js';
import { init } from '../build/commands/init.js';
import { update, remove } from '../build/commands/update.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function snapshot(methods, types = []) {
    return {
        methods: methods.map(([name, prototype]) => ({ name, prototype })),
        types: types.map(([name, kind]) => ({ name, kind })),
    };
}

describe('diffStructure', () => {
    test('added, removed, signature changed', () => {
        const oldS = snapshot([['a', 'a(): void'], ['b', 'b(x: number): void'], ['c', 'c(): void']], [['Foo', 'class']]);
        const newS = snapshot([['a', 'a(): void'], ['b', 'b(x: number, y: number): void'], ['d', 'd(): string']], [['Foo', 'interface'], ['Bar', 'type']]);
        expect(diffStructure(oldS, newS)).toEqual([
            { kind: 'added', itemKind: 'type', name: 'Bar', signature: 'type' },
            { kind: 'changed', itemKind: 'type', name: 'Foo', signature: 'interface', oldSignature: 'class' },
            { kind: 'changed', itemKind: 'method', name: 'b', signature: 'b(x: number, y: number): void', oldSignature: 'b(x: number): void' },
            { kind: 'removed', itemKind: 'method', name: 'c', signature: 'c(): void' },
            { kind: 'added', itemKind: 'method', name: 'd', signature: 'd(): string' },
        ]);
    });

    test('whitespace-only prototype change is no change', () => {
        expect(diffStructure(snapshot([['a', 'a(x:  number)']]), snapshot([['a', 'a(x: number)']]))).toEqual([]);
    });

    test('overloads: only the differing overload is reported', () => {
        const oldS = snapshot([['f', 'f(a: int)'], ['f', 'f(a: string)']]);
        const newS = snapshot([['f', 'f(a: int)'], ['f', 'f(a: string)'], ['f', 'f()']]);
        expect(diffStructure(oldS, newS)).toEqual([{ kind: 'added', itemKind: 'method', name: 'f', signature: 'f()' }]);
    });
});

describe('netStructureChanges', () => {
    const row = (id, kind, name, signature, old_signature = null) =>
        ({ id, time: id, file: 'x.ts', kind, item_kind: 'method', name, signature, old_signature });

    test('added then removed cancels out', () => {
        expect(netStructureChanges([row(1, 'added', 'a', 'a()'), row(2, 'removed', 'a', 'a()')])).toEqual([]);
    });

    test('changed twice is reported once, oldest to newest', () => {
        expect(netStructureChanges([
            row(1, 'changed', 'a', 'a(x)', 'a()'),
            row(2, 'changed', 'a', 'a(x, y)', 'a(x)'),
        ])).toEqual([{ kind: 'changed', itemKind: 'method', name: 'a', signature: 'a(x, y)', oldSignature: 'a()' }]);
    });

    test('changed back to the original is no change', () => {
        expect(netStructureChanges([
            row(1, 'changed', 'a', 'a(x)', 'a()'),
            row(2, 'changed', 'a', 'a()', 'a(x)'),
        ])).toEqual([]);
    });
});

describe('extractCommentLine', () => {
    test('trailing comment: only the text after the marker', () => {
        expect(extractCommentLine(['const x = secret(); // TODO: drop this'], 0, '.ts'))
            .toEqual({ text: 'TODO: drop this', doc: false });
    });

    test('code line without a marker gives null', () => {
        expect(extractCommentLine(['const url = compute(a, b);'], 0, '.ts')).toBeNull();
    });

    test('bare doc opener takes the first text line', () => {
        expect(extractCommentLine(['/**', ' * Loads the scene.', ' */'], 0, '.ts'))
            .toEqual({ text: 'Loads the scene.', doc: true });
    });

    test('# only for hash-comment languages', () => {
        expect(extractCommentLine(['# FIXME later'], 0, '.py')).toEqual({ text: 'FIXME later', doc: false });
        expect(extractCommentLine(['#include <x.h>'], 0, '.c')).toBeNull();
    });

    test('long comments are cut to 120 chars', () => {
        const r = extractCommentLine(['// ' + 'x'.repeat(300)], 0, '.ts');
        expect(r.text.length).toBe(120);
    });
});

describe('parseSince', () => {
    test('relative, ISO, epoch ms, invalid', () => {
        expect(parseSince('1794168280600')).toBe(1794168280600);
        expect(parseSince('2026-11-19T10:00:00Z')).toBe(Date.parse('2026-11-19T10:00:00Z'));
        expect(Math.abs(parseSince('2h') - (Date.now() - 2 * 3600 * 1000))).toBeLessThan(1000);
        expect(parseSince('soon')).toBeNull();
    });
});

describe('aidex_changes on a real index', () => {
    let dir;

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'aidex-changes-test-'));
        mkdirSync(join(dir, 'src'));
        writeFileSync(join(dir, 'src', 'engine.ts'),
            'export class Engine {\n    start(): void {}\n    tick(): void {}\n    render(scale: number): void {}\n}\n');
        writeFileSync(join(dir, 'src', 'old.ts'), 'export function legacy(): number { return 1; }\n');
        const r = await init({ path: dir });
        expect(r.success).toBe(true);
        await sleep(20);
    });

    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    test('structural delta, comments and since filtering', async () => {
        const since = Date.now();
        await sleep(20);
        writeFileSync(join(dir, 'src', 'engine.ts'),
            'export class Engine {\n    start(): void {}\n    // TODO: fixed timestep\n    update(dt: number): void {}\n    render(scale: number, alpha: number): void {}\n}\n');
        expect(update({ path: dir, file: 'src/engine.ts' }).success).toBe(true);
        expect(remove({ path: dir, file: 'src/old.ts' }).removed).toBe(true);

        const res = changes({ path: dir, since: String(since), refresh: false });
        expect(res.success).toBe(true);
        const engine = res.data.files.find(f => f.path === 'src/engine.ts');
        expect(engine.status).toBe('modified');
        expect(engine.changes).toEqual([
            { kind: 'changed', itemKind: 'method', name: 'render', signature: 'render(scale: number, alpha: number): void', oldSignature: 'render(scale: number): void' },
            { kind: 'removed', itemKind: 'method', name: 'tick', signature: 'tick(): void' },
            { kind: 'added', itemKind: 'method', name: 'update', signature: 'update(dt: number): void' },
        ]);
        const old = res.data.files.find(f => f.path === 'src/old.ts');
        expect(old.status).toBe('deleted');
        expect(old.changes.map(c => `${c.kind}:${c.name}`)).toEqual(['removed:legacy']);

        expect(res.data.comments.map(c => `${c.file}:${c.line} ${c.text}`)).toEqual(['src/engine.ts:3 TODO: fixed timestep']);
        expect(res.text).toContain('~ render(scale: number): void → render(scale: number, alpha: number): void');
        expect(res.text).not.toContain('export class Engine {');

        // Same state -> same text
        expect(changes({ path: dir, since: String(since), refresh: false }).text).toBe(res.text);

        // Nothing after "now"
        await sleep(20);
        const later = changes({ path: dir, since: String(Date.now()), refresh: false });
        expect(later.data.files).toEqual([]);
        expect(later.data.comments).toEqual([]);
        expect(later.text).toContain('No changes recorded since then.');
    });

    test('refresh re-indexes files changed on disk', async () => {
        const since = Date.now();
        await sleep(20);
        writeFileSync(join(dir, 'src', 'engine.ts'),
            'export class Engine {\n    start(): void {}\n    tick(): void {}\n    render(scale: number): void {}\n    stop(): void {}\n}\n');
        const res = changes({ path: dir, since: String(since) });
        expect(res.data.refreshed).toEqual(['src/engine.ts']);
        expect(res.data.files[0].changes).toEqual([{ kind: 'added', itemKind: 'method', name: 'stop', signature: 'stop(): void' }]);
    });

    test('legacy index without change_log table', async () => {
        const db = new Database(join(dir, '.aidex', 'index.db'));
        db.exec('DROP TABLE change_log');
        db.close();

        const res = changes({ path: dir, since: '1h', refresh: false });
        expect(res.success).toBe(true);

        // A writeable open (update) recreates the table and logs again
        const since = Date.now();
        await sleep(20);
        writeFileSync(join(dir, 'src', 'old.ts'), 'export function legacy(): string { return "1"; }\n');
        expect(update({ path: dir, file: 'src/old.ts' }).success).toBe(true);
        const after = changes({ path: dir, since: String(since), refresh: false });
        expect(after.data.files[0].changes[0].kind).toBe('changed');
    });
});

describe('formatChangesText size limit', () => {
    test('stays under the limit and reports omissions', () => {
        const files = [];
        for (let i = 0; i < 40; i++) {
            files.push({
                path: `src/module${String(i).padStart(2, '0')}/file.ts`,
                status: 'modified',
                lastChange: 1_800_000_000_000 - i * 1000,
                changes: Array.from({ length: 8 }, (_, k) => ({ kind: 'added', itemKind: 'method', name: `m${k}`, signature: `m${k}(argument: SomeLongTypeName, other: AnotherType): Promise<void>` })),
            });
        }
        const data = {
            since: 1_700_000_000_000,
            files,
            filesOmitted: 25,
            comments: [{ file: 'a.ts', line: 1, text: 'TODO: x', modified: 1 }],
            commentsOmitted: 0,
            tasks: [{ id: 1, title: 'T', status: 'active', events: ['updated'], lastActivity: 1_800_000_000_000, log: [] }],
            note: { changed: false, changedAt: null, firstLine: null },
        };
        const text = formatChangesText(data);
        expect(text.length).toBeLessThanOrEqual(6000);
        expect(text).toMatch(/… \d+ more file\(s\) omitted/);
        expect(text).toContain('TODO: x');
        expect(text).toContain('#1 [active] T');
    });
});
