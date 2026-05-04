/**
 * Rerank — ask the LLM to reorder retrieval candidates by true relevance.
 *
 * Privacy-aware: when sendCode=false we present only metadata
 * (kind, type, name, anchor, path, line). The LLM still ranks reasonably
 * well based on names and paths alone.
 */

import type { Provider } from './providers.js';
import type { SafeCandidate } from './safety.js';
import { assertNoLeak } from './safety.js';

const RERANK_SYSTEM_FULL = `You rerank code-search results by relevance to the user's query.
You see snippets, names, paths.
Output STRICT JSON: {"order": ["id1", "id2", ...]}.
Rules:
- Best match first.
- Include only the ids that are actually relevant — drop noise.
- IDs are exactly the strings provided in the input items.
- No commentary.`;

const RERANK_SYSTEM_METADATA = `You rerank code-search results by relevance using ONLY metadata.
You will NOT see source code, doc bodies, or task descriptions — by user policy.
You see: kind, type, name, anchor, path, line.
Output STRICT JSON: {"order": ["id1", "id2", ...]}.
Rules:
- Lean on names, anchors, and paths to judge relevance.
- Best match first; drop irrelevant items.
- IDs are exactly the strings provided in the input items.
- No commentary.`;

export async function rerankCandidates(
    provider: Provider,
    query: string,
    candidates: SafeCandidate[],
    sendCode: boolean
): Promise<string[]> {
    if (candidates.length === 0) return [];
    assertNoLeak(candidates, sendCode); // belt + braces

    const items = candidates.map(c => ({
        id: c.id,
        kind: c.sourceKind,
        type: c.sourceType,
        name: c.name,
        anchor: c.anchor,
        path: c.path,
        line: c.line,
        ...(sendCode && c.snippet ? { snippet: c.snippet } : {}),
    }));

    const userMsg = JSON.stringify({ query, items });

    try {
        const res = await provider.call({
            system: sendCode ? RERANK_SYSTEM_FULL : RERANK_SYSTEM_METADATA,
            user: userMsg,
            // Output tokens proportional to candidate count.
            maxTokens: Math.min(2000, 50 + candidates.length * 12),
            temperature: 0.0,
        });
        return parseOrder(res.text, candidates.map(c => c.id));
    } catch {
        // Fall back to original order — caller already had a useful ranking.
        return candidates.map(c => c.id);
    }
}

function parseOrder(text: string, validIds: string[]): string[] {
    if (!text) return validIds;
    const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const valid = new Set(validIds);
    let arr: unknown = null;
    try {
        const obj = JSON.parse(trimmed) as { order?: unknown };
        if (Array.isArray(obj.order)) arr = obj.order;
        else if (Array.isArray(obj)) arr = obj;
    } catch {
        // ignore
    }
    if (!Array.isArray(arr)) return validIds;
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const item of arr) {
        if (typeof item !== 'string') continue;
        if (!valid.has(item)) continue;
        if (seen.has(item)) continue;
        seen.add(item);
        ordered.push(item);
    }
    // Append any missing ids in their original order so we never drop a candidate
    // entirely just because the LLM forgot it.
    for (const id of validIds) if (!seen.has(id)) ordered.push(id);
    return ordered;
}
