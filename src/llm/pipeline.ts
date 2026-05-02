/**
 * Real LLM module — wires up config discovery, provider, and the three
 * operations (translate / expand / rerank).
 */

import { resolveLlmCreds, type LlmCreds } from './config.js';
import { createProvider, type Provider } from './providers.js';
import { expandQuery, translateQuery } from './translate.js';
import { rerankCandidates } from './rerank.js';
import { safeCandidates } from './safety.js';
import type {
    LlmContext,
    LlmModule,
    LlmStatus,
    RerankCandidate,
    RerankResult,
    TranslateResult,
} from './index.js';

class RealLlm implements LlmModule {
    private provider: Provider | null;
    private creds: LlmCreds | null;

    constructor(creds: LlmCreds | null) {
        this.creds = creds;
        this.provider = creds ? createProvider(creds) : null;
    }

    async status(): Promise<LlmStatus> {
        if (!this.creds) {
            return { available: false, backend: null, model: null, source: null };
        }
        return {
            available: true,
            backend: this.creds.backend,
            model: this.creds.model,
            source: this.creds.source as LlmStatus['source'],
        };
    }

    async translate(query: string, _ctx: LlmContext): Promise<TranslateResult> {
        if (!this.provider) return { original: query, queries: [query], invoked: false };
        const queries = await translateQuery(this.provider, query);
        return { original: query, queries, invoked: true };
    }

    async expand(query: string, _ctx: LlmContext): Promise<TranslateResult> {
        if (!this.provider) return { original: query, queries: [query], invoked: false };
        const queries = await expandQuery(this.provider, query);
        return { original: query, queries, invoked: true };
    }

    async rerank(query: string, candidates: RerankCandidate[], ctx: LlmContext): Promise<RerankResult> {
        if (!this.provider || candidates.length === 0) {
            return { orderedIds: candidates.map(c => c.id), invoked: false };
        }
        const safe = safeCandidates(candidates, ctx.sendCode);
        const orderedIds = await rerankCandidates(this.provider, query, safe, ctx.sendCode);
        return { orderedIds, invoked: true };
    }
}

/**
 * Discover credentials and build a real module instance. Falls back to a
 * "stub-like" real module (returns identity results) if no backend was found —
 * that way callers still get a valid LlmModule and can call status() to learn why.
 */
export async function createRealModule(): Promise<LlmModule> {
    const creds = await resolveLlmCreds();
    return new RealLlm(creds);
}
