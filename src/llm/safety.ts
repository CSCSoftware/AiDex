/**
 * Privacy filters — enforce the per-project `llm_send_code` switch.
 *
 * When sendCode === false, NOTHING that contains source/doc/note/task BODY
 * may leave the box. Only:
 *   - the user's literal query
 *   - file paths (relative)
 *   - method/type/section NAMES and ANCHORS
 *   - tags
 *
 * This module is the single chokepoint for "candidate → LLM-safe payload".
 */

import type { RerankCandidate } from './index.js';

export interface SafeCandidate {
    id: string;
    sourceKind: string;
    sourceType: string;
    /** Always safe: user-supplied identifier name. */
    name: string | null;
    anchor: string | null;
    path: string | null;
    line: number | null;
    /**
     * Snippet — present only when sendCode=true.
     * When sendCode=false this is always undefined; never an empty string,
     * so a downstream bug can't accidentally smuggle a snippet.
     */
    snippet?: string;
}

/**
 * Strip body content from a candidate when sendCode is false.
 * Always returns a plain object — never the original reference — so callers
 * can't mutate body fields back in by accident.
 */
export function safeCandidate(c: RerankCandidate, sendCode: boolean): SafeCandidate {
    const base: SafeCandidate = {
        id: c.id,
        sourceKind: c.sourceKind,
        sourceType: c.sourceType,
        name: c.sourceName,
        anchor: c.sourceAnchor,
        path: c.sourcePath,
        line: c.sourceLine,
    };
    if (sendCode && c.sourceText) {
        // Cap snippet length defensively — even with sendCode=true we don't
        // want to ship 10 KB methods to the LLM.
        base.snippet = c.sourceText.length > 600 ? c.sourceText.slice(0, 600) + '…' : c.sourceText;
    }
    return base;
}

/** Bulk-safe a candidate list. */
export function safeCandidates(list: RerankCandidate[], sendCode: boolean): SafeCandidate[] {
    return list.map(c => safeCandidate(c, sendCode));
}

/**
 * Defensive sanity check: throws if any candidate sneaks a snippet through
 * when sendCode is false. Cheap; called before any actual LLM request.
 */
export function assertNoLeak(list: SafeCandidate[], sendCode: boolean): void {
    if (sendCode) return;
    for (const c of list) {
        if ('snippet' in c && c.snippet !== undefined) {
            throw new Error('LLM safety: snippet present despite sendCode=false');
        }
    }
}
