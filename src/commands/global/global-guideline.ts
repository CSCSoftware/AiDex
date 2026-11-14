/**
 * global-guideline command
 *
 * Persistent key-value store in ~/.aidex/global.db for AI guidelines,
 * coding conventions, and project-wide rules.
 *
 * Use this to store named instructions that apply across all projects —
 * e.g. "review" → detailed review checklist, "release-prep" → release steps.
 *
 * A guideline can be marked "always" (set with always=true): the session start
 * then delivers its full text. The list of such keys is kept in the metadata
 * table (key "guidelines_always"), so no schema change is needed.
 */

import { openGlobalDatabase, type GuidelineRow } from '../../db/global-database.js';

// ============================================================
// Types
// ============================================================

export type GuidelineAction = 'set' | 'get' | 'list' | 'delete';

export interface GlobalGuidelineParams {
    action: GuidelineAction;
    key?: string;
    value?: string;
    filter?: string;
    /** set: mark (true) or unmark (false) the guideline as "always load" at session start. */
    always?: boolean;
}

export interface GlobalGuidelineResult {
    success: boolean;
    action: GuidelineAction;
    guideline?: GuidelineRow;
    guidelines?: GuidelineRow[];
    deleted?: boolean;
    /** Keys of all guidelines marked "always load". */
    alwaysKeys?: string[];
    error?: string;
}

const ALWAYS_META_KEY = 'guidelines_always';

type GlobalDb = ReturnType<typeof openGlobalDatabase>;

export function parseKeyList(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const v: unknown = JSON.parse(raw);
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}

function alwaysKeysOf(db: GlobalDb): string[] {
    return parseKeyList(db.getMetadata(ALWAYS_META_KEY));
}

function setAlways(db: GlobalDb, key: string, always: boolean): void {
    const keys = new Set(alwaysKeysOf(db));
    if (always) keys.add(key); else keys.delete(key);
    db.setMetadata(ALWAYS_META_KEY, JSON.stringify([...keys].sort()));
}

/** Keys of global guidelines that are delivered in full at session start. */
export function getGlobalAlwaysKeys(): string[] {
    const db = openGlobalDatabase();
    try {
        return alwaysKeysOf(db);
    } finally {
        db.close();
    }
}

// ============================================================
// Implementation
// ============================================================

export function globalGuideline(params: GlobalGuidelineParams): GlobalGuidelineResult {
    const { action, key, value, filter, always } = params;

    // openGlobalDatabase() creates ~/.aidex/global.db if it doesn't exist yet —
    // so guidelines work even without prior global_init.
    const globalDb = openGlobalDatabase();

    try {
        switch (action) {

            case 'set': {
                if (!key) return { success: false, action, error: 'key is required for set' };
                if (value === undefined || value === null) return { success: false, action, error: 'value is required for set' };
                globalDb.setGuideline(key, value);
                if (always !== undefined) setAlways(globalDb, key, always);
                const saved = globalDb.getGuideline(key);
                return { success: true, action, guideline: saved ?? undefined, alwaysKeys: alwaysKeysOf(globalDb) };
            }

            case 'get': {
                if (!key) return { success: false, action, error: 'key is required for get' };
                const row = globalDb.getGuideline(key);
                if (!row) return { success: false, action, error: `Guideline not found: "${key}"` };
                return { success: true, action, guideline: row, alwaysKeys: alwaysKeysOf(globalDb) };
            }

            case 'list': {
                const rows = globalDb.listGuidelines(filter);
                return { success: true, action, guidelines: rows, alwaysKeys: alwaysKeysOf(globalDb) };
            }

            case 'delete': {
                if (!key) return { success: false, action, error: 'key is required for delete' };
                const deleted = globalDb.deleteGuideline(key);
                if (deleted) setAlways(globalDb, key, false);
                return { success: true, action, deleted };
            }

            default:
                return { success: false, action, error: `Unknown action: ${action as string}` };
        }
    } catch (error) {
        return {
            success: false,
            action,
            error: error instanceof Error ? error.message : String(error),
        };
    } finally {
        globalDb.close();
    }
}
