/**
 * Tests for the read-only health analysis (pure functions, no real files or databases).
 */

import { analyzeSources } from '../build/commands/health.js';

const NOW = Date.UTC(2026, 10, 14);

const opts = (over = {}) => ({
    now: NOW,
    projectNames: [],
    pathExists: () => true,
    driveExists: () => true,
    ...over,
});

const src = (id, text, over = {}) => ({ id, label: id, loaded: true, global: false, text, ...over });
const checks = (findings, check) => findings.filter(f => f.check === check);

describe('health analysis', () => {
    test('size: only loaded sources over the limit', () => {
        const big = 'x'.repeat(4100);
        expect(checks(analyzeSources([src('a', big)], opts()), 'size')).toHaveLength(1);
        expect(checks(analyzeSources([src('a', big, { loaded: false })], opts()), 'size')).toHaveLength(0);
        expect(checks(analyzeSources([src('a', 'short')], opts()), 'size')).toHaveLength(0);
    });

    test('dead paths: missing path flagged, offline drive and placeholders skipped', () => {
        const text = 'Use C:\\tools\\gone.exe and P:\\TempAi and %APPDATA%\\x and D:\\keep\\ok.txt.';
        const f = analyzeSources([src('a', text)], opts({
            pathExists: (p) => p.startsWith('D:'),
            driveExists: (d) => d !== 'P:',
        }));
        const dead = checks(f, 'dead-path');
        expect(dead).toHaveLength(1);
        expect(dead[0].message).toContain('C:\\tools\\gone.exe');
    });

    test('dead paths: URLs, elisions and metadata footers are not reported', () => {
        const text = 'See http://localhost:3335/log and Q:\\...\\.espressif for details.\n*Created: 22.6.2026 | Updated: 8.8.2026*';
        const f = analyzeSources([src('a', text)], opts({ pathExists: () => false }));
        expect(checks(f, 'dead-path')).toHaveLength(0);
        expect(checks(f, 'dated')).toHaveLength(0);
    });

    test('dated: old date with a time word is flagged, recent or plain attribution is not', () => {
        const text = [
            'Abo ab 11.11.2026 laeuft einen Monat',   // recent -> no
            'Stand 2026-02-11: Phase 1',              // old + time word -> yes
            'Regel (Uwe, 03.06.2026)',                // old, no time word -> no
        ].join('\n');
        const dated = checks(analyzeSources([src('a', text)], opts()), 'dated');
        expect(dated).toHaveLength(1);
        expect(dated[0].message).toContain('2026-02-11');
    });

    test('untouched: only entries with an update time', () => {
        const old = NOW - 400 * 24 * 60 * 60 * 1000;
        expect(checks(analyzeSources([src('a', 'x', { updatedAt: old })], opts()), 'untouched')).toHaveLength(1);
        expect(checks(analyzeSources([src('a', 'x', { updatedAt: NOW })], opts()), 'untouched')).toHaveLength(0);
        expect(checks(analyzeSources([src('a', 'x')], opts()), 'untouched')).toHaveLength(0);
    });

    test('scope: global loaded text that names a project', () => {
        const text = 'Always update the Tellnox product doc after each change.';
        const g = analyzeSources([src('a', text, { global: true })], opts({ projectNames: ['Tellnox', 'ab'] }));
        expect(checks(g, 'scope')).toHaveLength(1);
        const p = analyzeSources([src('a', text, { global: false })], opts({ projectNames: ['Tellnox'] }));
        expect(checks(p, 'scope')).toHaveLength(0);
    });

    test('duplicates: same and near-identical lines across sources, not within one', () => {
        const a = 'Never commit unless the user explicitly asks for it.\nOnly in a.';
        const b = '- Never commit unless the user explicitly asks for it\nUnrelated line that is long enough to count here.';
        const c = 'Never commit unless the user explicitly asks you for it today.';
        const f = analyzeSources([src('a', a), src('b', b), src('c', c)], opts());
        expect(checks(f, 'duplicate').length).toBeGreaterThanOrEqual(2);
        const within = analyzeSources([src('a', a + '\n' + a)], opts());
        expect(checks(within, 'duplicate')).toHaveLength(0);
    });
});
