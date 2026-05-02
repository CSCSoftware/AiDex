/**
 * Translate / normalize — turn an arbitrary user query into 1-3 English search
 * queries optimized for the embedding model.
 *
 * Examples:
 *   "wie speichere ich Logs lokal" → ["save logs locally", "log persistence"]
 *   "how do we cache the model"     → ["how do we cache the model"]
 *   "schneller als grep"            → ["faster than grep", "grep alternative"]
 *
 * The LLM only ever sees the query — never code/docs.
 */

import type { Provider } from './providers.js';

const SYSTEM = `You translate code-search queries into English.
Output STRICT JSON with this shape: {"queries": ["...", "..."]}.
Rules:
- Up to 3 queries, lowercase, English.
- Keep the original meaning, prefer short phrases (3-8 words).
- If the input is already a clean English search phrase, return just one item.
- No prose, no code fences, no commentary — just the JSON.`;

export async function translateQuery(provider: Provider, query: string): Promise<string[]> {
    try {
        const res = await provider.call({
            system: SYSTEM,
            user: query,
            maxTokens: 200,
            temperature: 0.1,
        });
        const queries = parseQueries(res.text);
        if (queries.length === 0) return [query];
        return queries.slice(0, 3);
    } catch {
        // Provider failure — fall back to identity. Search still works.
        return [query];
    }
}

const EXPAND_SYSTEM = `You expand a vague code-search query into concrete English search phrases.
Output STRICT JSON: {"queries": ["...", "..."]}.
Rules:
- 2 to 4 phrases, complementary not redundant.
- Each phrase 3-10 words, English, lowercase.
- Concrete: include likely identifier-style words ("retry backoff exponential" beats "how to retry").
- No prose, no code fences.`;

export async function expandQuery(provider: Provider, query: string): Promise<string[]> {
    try {
        const res = await provider.call({
            system: EXPAND_SYSTEM,
            user: query,
            maxTokens: 250,
            temperature: 0.2,
        });
        const queries = parseQueries(res.text);
        if (queries.length === 0) return [query];
        return queries.slice(0, 4);
    } catch {
        return [query];
    }
}

function parseQueries(text: string): string[] {
    if (!text) return [];
    const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try {
        const obj = JSON.parse(trimmed) as { queries?: unknown };
        if (Array.isArray(obj.queries)) {
            return obj.queries
                .filter((q): q is string => typeof q === 'string')
                .map(s => s.trim())
                .filter(s => s.length > 0);
        }
    } catch {
        // Some models return bare arrays — try that fallback.
        try {
            const obj = JSON.parse(trimmed) as unknown;
            if (Array.isArray(obj)) {
                return obj.filter((q): q is string => typeof q === 'string').map(s => s.trim());
            }
        } catch { /* fall through */ }
    }
    // Last resort: lines starting with "-" or "1)" etc.
    return trimmed
        .split('\n')
        .map(l => l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').replace(/^["']|["']$/g, '').trim())
        .filter(l => l.length > 2);
}
