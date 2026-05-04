/**
 * Embeddings public API.
 *
 * The rest of AiDex talks to this module ONLY through `getEmbeddings()`.
 * No deep imports — that's how we keep the system encapsulated.
 *
 * The default instance is a stub: it costs nothing, loads nothing, and
 * answers `isEnabled()` with false. The real implementation (model loading,
 * sqlite-vec, HTTP downloads) is loaded lazily on the first `enable()` call.
 */

import { DEFAULT_MODEL_ID } from './model-registry.js';

// ============================================================
// Public types
// ============================================================

export type SourceKind = 'code' | 'docs' | 'workspace';
export type SourceType =
    | 'method'
    | 'type'
    | 'doc-section'
    | 'task'
    | 'note'
    | 'note-history'
    | 'task-log';

export type SearchScope = 'current' | 'all' | 'linked';
export type SearchMode = 'semantic' | 'hybrid' | 'exact';

export interface EnableOptions {
    /** Model id from the registry (default: jina-code). */
    model?: string;
    /** Mark this project's embeddings as private. Reserved for future team-sync. */
    isPrivate?: boolean;
}

export interface IndexOptions {
    /** Limit indexing to a specific source kind. Default: all. */
    sourceKinds?: SourceKind[];
    /** Re-embed everything, ignoring content hashes. */
    force?: boolean;
}

export interface IndexResult {
    embedded: number;
    skipped: number;
    removed: number;
    durationMs: number;
}

export type LlmStrategy = 'auto' | 'off' | 'translate' | 'rerank' | 'expand+rerank';

export interface SearchOptions {
    query: string;
    scope?: SearchScope;
    /** Required when scope is 'current' or 'linked'. */
    path?: string;
    projectFilter?: string[];
    sourceKinds?: SourceKind[];
    sourceTypes?: SourceType[];
    mode?: SearchMode;
    k?: number;
    /**
     * LLM-layer strategy.
     *  - 'auto'           : translate + rerank if a backend is available, else off
     *  - 'off'            : pure embeddings, no LLM at all (default if no key)
     *  - 'translate'      : just rewrite the query
     *  - 'rerank'         : embedding search, then rerank top-N
     *  - 'expand+rerank'  : split query into 2-4 subqueries, merge, then rerank
     */
    llm?: LlmStrategy;
}

export interface SearchHit {
    projectPath: string;
    projectName: string;
    sourceType: SourceType;
    sourceKind: SourceKind;
    sourcePath: string | null;
    sourceLine: number | null;
    sourceAnchor: string | null;
    sourceName: string | null;
    sourceText: string;
    distance: number;
    rank: number;
}

/**
 * Side-channel info about which LLM stages ran during a search and whether
 * they succeeded. Useful for the user/AI to know if translate/rerank actually
 * fired or silently fell back to embeddings-only.
 */
export interface SearchTelemetry {
    translateRan: boolean;
    translateFailed: boolean;
    expandRan: boolean;
    expandFailed: boolean;
    rerankRan: boolean;
    rerankFailed: boolean;
    queriesUsed: string[];
    /** Optional human-readable error from the last LLM failure. */
    lastError?: string;
}

export interface SearchResultWithTelemetry {
    hits: SearchHit[];
    telemetry: SearchTelemetry;
}

export interface EmbeddingStatus {
    moduleLoaded: boolean;
    modelId: string | null;
    enabledProjects: number;
    totalEmbeddings: number;
    storageBytes: number;
}

export interface MigrateOptions {
    fromModel: string;
    toModel: string;
    /** If true: actually perform migration. Default: dry-run. */
    apply?: boolean;
}

export interface MigrationResult {
    applied: boolean;
    projectsAffected: number;
    embeddingsAffected: number;
}

// ============================================================
// Module interface
// ============================================================

export interface EmbeddingsModule {
    /** Whether embeddings are enabled for this project. Cheap; safe to call often. */
    isEnabled(projectPath: string): boolean;

    /** Enable embeddings for a project. Triggers lazy-load of the real module + model. */
    enable(projectPath: string, opts?: EnableOptions): Promise<void>;

    /** (Re-)index a whole project. Skips items whose content hash hasn't changed. */
    indexProject(projectPath: string, opts?: IndexOptions): Promise<IndexResult>;

    /** Update embeddings for a single source file (hash-diffed). */
    updateFile(projectPath: string, filePath: string): Promise<void>;

    /** Drop embeddings for a single source file. */
    removeFile(projectPath: string, filePath: string): Promise<void>;

    /** Hook called after a task changes (create/update/log). */
    onTaskChanged(projectPath: string, taskId: number): Promise<void>;

    /** Hook called after a session note changes (write/append/clear/archive). */
    onNoteChanged(projectPath: string, noteId?: string): Promise<void>;

    /** Search embeddings. */
    search(opts: SearchOptions): Promise<SearchHit[]>;

    /** Search and return telemetry about which LLM stages fired. */
    searchWithTelemetry(opts: SearchOptions): Promise<SearchResultWithTelemetry>;

    /** Status overview. */
    status(projectPath?: string): Promise<EmbeddingStatus>;

    /** Migrate embeddings between models. */
    migrate(opts: MigrateOptions): Promise<MigrationResult>;
}

// ============================================================
// Stub implementation
// ============================================================

const NOT_LOADED = new Error(
    'Embeddings module is not loaded. Call enable() first, or set embeddings:true on aidex_init.'
);

function createStub(): EmbeddingsModule {
    return {
        isEnabled: () => false,
        async enable(projectPath, opts) {
            // First real call — swap the singleton with a real instance.
            const real = await loadRealModule();
            _instance = real;
            await real.enable(projectPath, opts);
        },
        async indexProject(projectPath, opts) {
            // Auto-load: a caller intending to index implies they want embeddings.
            const real = await loadRealModule();
            _instance = real;
            return real.indexProject(projectPath, opts);
        },
        async updateFile(projectPath, filePath) {
            // Auto-load only if embeddings are enabled for this project.
            // Otherwise keep this a true no-op (pre-embedding users pay nothing).
            if (await isProjectEmbedEnabled(projectPath)) {
                const real = await loadRealModule();
                _instance = real;
                return real.updateFile(projectPath, filePath);
            }
        },
        async removeFile(projectPath, filePath) {
            if (await isProjectEmbedEnabled(projectPath)) {
                const real = await loadRealModule();
                _instance = real;
                return real.removeFile(projectPath, filePath);
            }
        },
        async onTaskChanged(projectPath, taskId) {
            if (await isProjectEmbedEnabled(projectPath)) {
                const real = await loadRealModule();
                _instance = real;
                return real.onTaskChanged(projectPath, taskId);
            }
        },
        async onNoteChanged(projectPath, noteId) {
            if (await isProjectEmbedEnabled(projectPath)) {
                const real = await loadRealModule();
                _instance = real;
                return real.onNoteChanged(projectPath, noteId);
            }
        },
        async search(opts) {
            // Auto-load: searching is a read-only intent, safe to load on demand.
            const real = await loadRealModule();
            _instance = real;
            return real.search(opts);
        },
        async searchWithTelemetry(opts) {
            const real = await loadRealModule();
            _instance = real;
            return real.searchWithTelemetry(opts);
        },
        async status() {
            return {
                moduleLoaded: false,
                modelId: null,
                enabledProjects: 0,
                totalEmbeddings: 0,
                storageBytes: 0,
            };
        },
        async migrate() {
            throw NOT_LOADED;
        },
    };
}

// ============================================================
// Lazy loader
// ============================================================

/**
 * Cheap synchronous-ish check: is this project enabled for embeddings?
 * Used by hook stubs to decide whether to auto-load the real module.
 * Avoids loading transformers.js for projects that don't use embeddings.
 */
async function isProjectEmbedEnabled(projectPath: string): Promise<boolean> {
    try {
        const { isProjectEnabled, ensureEmbeddingsSchema } = await import('./store.js');
        ensureEmbeddingsSchema();
        return isProjectEnabled(projectPath);
    } catch {
        return false;
    }
}

async function loadRealModule(): Promise<EmbeddingsModule> {
    try {
        const mod = await import('./pipeline.js');
        return mod.createRealModule();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
            `Failed to load embeddings module. Optional dependencies may be missing.\n` +
                `Install with: npm install @xenova/transformers sqlite-vec\n` +
                `Original error: ${msg}`
        );
    }
}

// ============================================================
// Singleton accessor
// ============================================================

let _instance: EmbeddingsModule | null = null;

function getOrInit(): EmbeddingsModule {
    if (!_instance) {
        _instance = createStub();
    }
    return _instance;
}

/**
 * Returns a stable handle to the embeddings module.
 *
 * The handle delegates every call to the current internal instance, so
 * after `enable()` swaps the stub for the real module, callers that cached
 * the handle automatically see the upgrade — no need to re-fetch.
 */
export function getEmbeddings(): EmbeddingsModule {
    return {
        isEnabled: (projectPath) => getOrInit().isEnabled(projectPath),
        enable: (projectPath, opts) => getOrInit().enable(projectPath, opts),
        indexProject: (projectPath, opts) => getOrInit().indexProject(projectPath, opts),
        updateFile: (projectPath, filePath) => getOrInit().updateFile(projectPath, filePath),
        removeFile: (projectPath, filePath) => getOrInit().removeFile(projectPath, filePath),
        onTaskChanged: (projectPath, taskId) => getOrInit().onTaskChanged(projectPath, taskId),
        onNoteChanged: (projectPath, noteId) => getOrInit().onNoteChanged(projectPath, noteId),
        search: (opts) => getOrInit().search(opts),
        searchWithTelemetry: (opts) => getOrInit().searchWithTelemetry(opts),
        status: (projectPath) => getOrInit().status(projectPath),
        migrate: (opts) => getOrInit().migrate(opts),
    };
}

/** Test helper: reset the singleton. Not part of the stable API. */
export function _resetEmbeddings(): void {
    _instance = null;
}

// Re-exports kept narrow: only what callers might legitimately need.
export { DEFAULT_MODEL_ID, MODEL_REGISTRY, listModels } from './model-registry.js';
