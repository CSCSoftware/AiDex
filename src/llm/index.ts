/**
 * LLM Layer — public API.
 *
 * Optional intelligence layer over the embeddings system. When the user has
 * an API key (Anthropic/OpenAI/OpenRouter) or a local Ollama running, this
 * module can:
 *   - translate non-English queries to English (the embedding model's language)
 *   - expand vague queries into several concrete subqueries
 *   - rerank top-N retrieval candidates by semantic relevance
 *
 * Privacy-first: the module honours a per-project `llm_send_code` flag.
 * When false (the default), only the user's literal query and metadata
 * (paths, names, types) are ever sent to the LLM — never source bodies,
 * doc sections, task descriptions, or note contents.
 *
 * The rest of AiDex talks to this module ONLY through `getLlm()`.
 */

// ============================================================
// Public types
// ============================================================

export interface LlmContext {
    projectPath: string;
    /** Whether snippets/bodies may be sent to the LLM. Defaults to false. */
    sendCode: boolean;
}

export interface TranslateResult {
    original: string;
    /** English subqueries — usually 1-3, sometimes equal to the original if already English. */
    queries: string[];
    /** True if the model was actually invoked (false ⇒ stub fallback). */
    invoked: boolean;
}

export interface RerankCandidate {
    id: string;          // arbitrary stable id per row (caller's choice)
    sourceKind: 'code' | 'docs' | 'workspace';
    sourceType: string;
    sourceName: string | null;
    sourceAnchor: string | null;
    sourcePath: string | null;
    sourceLine: number | null;
    /** Snippet — only sent to LLM if context.sendCode === true. */
    sourceText: string;
}

export interface RerankResult {
    /** Ordered list of ids — best first. May be a subset of the input. */
    orderedIds: string[];
    invoked: boolean;
}

export interface LlmStatus {
    /** True if a working backend was discovered. */
    available: boolean;
    backend: 'anthropic' | 'openai' | 'openrouter' | 'ollama' | 'custom' | 'huggingface' | null;
    model: string | null;
    /** Where the credentials came from (for diagnostics). */
    source: 'env' | 'guideline' | 'config-file' | 'ollama-default' | 'project' | null;
}

// ============================================================
// Module interface
// ============================================================

export interface LlmModule {
    /** Quickly check if the module is wired up. Cheap. */
    status(): Promise<LlmStatus>;

    /** Translate / normalize a query string. Falls back to identity if no backend. */
    translate(query: string, ctx: LlmContext): Promise<TranslateResult>;

    /** Expand a vague query into 2-4 concrete subqueries. */
    expand(query: string, ctx: LlmContext): Promise<TranslateResult>;

    /** Rerank retrieval candidates. Returns identity order if no backend. */
    rerank(query: string, candidates: RerankCandidate[], ctx: LlmContext): Promise<RerankResult>;

    /** Invalidate any cached creds — call after Settings save. */
    invalidate(): void;
}

// ============================================================
// Stub implementation (no LLM available)
// ============================================================

function createStub(): LlmModule {
    return {
        async status() {
            return { available: false, backend: null, model: null, source: null };
        },
        async translate(query, _ctx) {
            return { original: query, queries: [query], invoked: false };
        },
        async expand(query, _ctx) {
            return { original: query, queries: [query], invoked: false };
        },
        async rerank(_query, candidates, _ctx) {
            return { orderedIds: candidates.map(c => c.id), invoked: false };
        },
        invalidate() { /* no-op */ },
    };
}

// ============================================================
// Lazy loader for the real implementation
// ============================================================

let _instance: LlmModule | null = null;

async function loadRealModule(): Promise<LlmModule> {
    try {
        const mod = await import('./pipeline.js');
        return await mod.createRealModule();
    } catch (err) {
        // Real module failed (missing fetch, no network, etc.) — keep stub.
        return createStub();
    }
}

function getOrInit(): LlmModule {
    if (!_instance) _instance = createStub();
    return _instance;
}

/**
 * Stable handle to the LLM module. Like getEmbeddings(), this is a Proxy:
 * the first method call triggers a lazy upgrade from stub to real impl
 * if a backend can be discovered, but cached references stay valid.
 */
export function getLlm(): LlmModule {
    return {
        status: async () => {
            await ensureUpgraded();
            return getOrInit().status();
        },
        translate: async (q, ctx) => {
            await ensureUpgraded();
            return getOrInit().translate(q, ctx);
        },
        expand: async (q, ctx) => {
            await ensureUpgraded();
            return getOrInit().expand(q, ctx);
        },
        rerank: async (q, c, ctx) => {
            await ensureUpgraded();
            return getOrInit().rerank(q, c, ctx);
        },
        invalidate: () => {
            // Sync method — don't await upgrade. If real instance exists, invalidate it.
            if (_instance) _instance.invalidate();
        },
    };
}

let _upgradeAttempted = false;
async function ensureUpgraded(): Promise<void> {
    if (_upgradeAttempted) return;
    _upgradeAttempted = true;
    const real = await loadRealModule();
    _instance = real;
}

/** Test helper. */
export function _resetLlm(): void {
    _instance = null;
    _upgradeAttempted = false;
}
