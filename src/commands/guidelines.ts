/**
 * guideline command (project scope) + session delivery of "always" guidelines
 *
 * Project guidelines live in the project's own index (metadata keys "guideline:<name>").
 * A guideline can be marked "always": the session start delivers its full text
 * (global and project ones), so no one has to remember to read it.
 * Everything else is listed by key only.
 */

import { basename, dirname, resolve } from 'path';
import { withProjectDb, validateIndex } from './shared.js';
import { getGlobalAlwaysKeys, parseKeyList, type GuidelineAction } from './global/global-guideline.js';
import { openGlobalDatabase } from '../db/global-database.js';

const PREFIX = 'guideline:';
const ALWAYS_META_KEY = 'guidelines_always';

/** Warn when the delivered "always" texts exceed this many characters. */
export const ALWAYS_BUDGET = 6000;

export interface ProjectGuideline {
    key: string;
    value: string;
    always: boolean;
}

export interface ProjectGuidelineParams {
    path: string;
    action: GuidelineAction;
    key?: string;
    value?: string;
    always?: boolean;
}

export interface ProjectGuidelineResult {
    success: boolean;
    action: GuidelineAction;
    guideline?: ProjectGuideline;
    guidelines?: ProjectGuideline[];
    deleted?: boolean;
    error?: string;
}

export function projectGuideline(params: ProjectGuidelineParams): ProjectGuidelineResult {
    const { path, action, key, value, always } = params;
    const fail = (error: string): ProjectGuidelineResult => ({ success: false, action, error });
    const readonly = action === 'get' || action === 'list';

    return withProjectDb<ProjectGuidelineResult>(path, readonly, fail, (db) => {
        const alwaysKeys = () => new Set(parseKeyList(db.getMetadata(ALWAYS_META_KEY)));
        const saveAlways = (keys: Set<string>) =>
            db.setMetadata(ALWAYS_META_KEY, JSON.stringify([...keys].sort()));

        switch (action) {
            case 'set': {
                if (!key) return fail('key is required for set');
                if (value === undefined || value === null) return fail('value is required for set');
                db.setMetadata(PREFIX + key, value);
                const keys = alwaysKeys();
                if (always !== undefined) {
                    if (always) keys.add(key); else keys.delete(key);
                    saveAlways(keys);
                }
                return { success: true, action, guideline: { key, value, always: keys.has(key) } };
            }
            case 'get': {
                if (!key) return fail('key is required for get');
                const v = db.getMetadata(PREFIX + key);
                if (v === null) return fail(`Project guideline not found: "${key}"`);
                return { success: true, action, guideline: { key, value: v, always: alwaysKeys().has(key) } };
            }
            case 'list': {
                const keys = alwaysKeys();
                const rows = db.listMetadata(PREFIX).map(r => ({
                    key: r.key.slice(PREFIX.length),
                    value: r.value ?? '',
                    always: keys.has(r.key.slice(PREFIX.length)),
                }));
                return { success: true, action, guidelines: rows };
            }
            case 'delete': {
                if (!key) return fail('key is required for delete');
                const existed = db.getMetadata(PREFIX + key) !== null;
                db.deleteMetadata(PREFIX + key);
                const keys = alwaysKeys();
                if (keys.delete(key)) saveAlways(keys);
                return { success: true, action, deleted: existed };
            }
            default:
                return fail(`Unknown action: ${action as string}`);
        }
    });
}

export interface AlwaysGuidelines {
    global: Array<{ key: string; value: string }>;
    /** Guidelines of this project (no `from`) and of parent projects (`from` = folder name, outermost first). */
    project: Array<{ key: string; value: string; from?: string }>;
    /** Project guidelines that are not "always" (listed by key only). */
    otherProjectKeys: string[];
    chars: number;
}

/** Collect the guidelines the session start delivers in full. Never throws. */
export function loadAlwaysGuidelines(projectPath: string): AlwaysGuidelines {
    const out: AlwaysGuidelines = { global: [], project: [], otherProjectKeys: [], chars: 0 };

    try {
        const keys = getGlobalAlwaysKeys();
        if (keys.length > 0) {
            const gdb = openGlobalDatabase();
            try {
                for (const k of keys) {
                    const row = gdb.getGuideline(k);
                    if (row) out.global.push({ key: row.key, value: row.value.trim() });
                }
            } finally {
                gdb.close();
            }
        }
    } catch {
        // global.db missing or unreadable: no global guidelines
    }

    // Parent projects first (outermost to innermost): a project inside another indexed project
    // inherits the parent's "always" guidelines, like the CLAUDE.md chain.
    const chain: string[] = [];
    for (let dir = dirname(resolve(projectPath)); dirname(dir) !== dir; dir = dirname(dir)) {
        if (validateIndex(dir)) chain.unshift(dir);
    }
    for (const dir of chain) {
        const parent = projectGuideline({ path: dir, action: 'list' });
        for (const g of parent.guidelines ?? []) {
            if (g.always) out.project.push({ key: g.key, value: g.value.trim(), from: basename(dir) });
        }
    }

    const res = projectGuideline({ path: projectPath, action: 'list' });
    for (const g of res.guidelines ?? []) {
        if (g.always) out.project.push({ key: g.key, value: g.value.trim() });
        else out.otherProjectKeys.push(g.key);
    }

    out.chars = [...out.global, ...out.project].reduce((n, g) => n + g.value.length, 0);
    return out;
}
