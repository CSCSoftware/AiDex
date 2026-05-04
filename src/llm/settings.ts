/**
 * Settings service — single entry point for the viewer's Settings tab and
 * the aidex_settings MCP tool.
 *
 * Reads and writes the user-facing configuration:
 *   - Embeddings on/off + model + status (per project)
 *   - LLM provider + API key + model (global, in ~/.aidex/llm.json)
 *   - llm_send_code privacy switch (per project)
 *
 * Wraps the lower-level pieces from config.ts, store.ts, and the providers.
 */

import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

import { PRODUCT_VERSION } from '../constants.js';
import {
    type LlmBackend,
    type LlmConfigFile,
    type LlmCreds,
    isEnvVarName,
    isLlmEnabled,
    llmConfigPath,
    readLlmConfigFile,
    resolveLlmCreds,
    writeLlmConfigFile,
} from './config.js';
import { createProvider } from './providers.js';
import {
    countProjectEmbeddings,
    ensureEmbeddingsSchema,
    getProjectInfo,
    isProjectEnabled,
} from '../embeddings/store.js';
import { listModels } from '../embeddings/model-registry.js';

// ============================================================
// Public types
// ============================================================

export interface ProviderOption {
    backend: LlmBackend;
    label: string;
    /** Common endpoint URL prefix the user is most likely to want. */
    defaultEndpoint: string;
    /** Suggested models for this provider. */
    suggestedModels: string[];
    /** Does this provider need an API key? Ollama doesn't. */
    needsKey: boolean;
    /** Conventional env-var name for this provider's key (used as placeholder hint). */
    envVarName?: string;
}

export const PROVIDER_OPTIONS: ProviderOption[] = [
    {
        backend: 'anthropic',
        label: 'Anthropic (Claude)',
        defaultEndpoint: 'https://api.anthropic.com',
        suggestedModels: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'],
        needsKey: true,
        envVarName: 'ANTHROPIC_API_KEY',
    },
    {
        backend: 'openai',
        label: 'OpenAI (GPT)',
        defaultEndpoint: 'https://api.openai.com/v1',
        suggestedModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
        needsKey: true,
        envVarName: 'OPENAI_API_KEY',
    },
    {
        backend: 'openrouter',
        label: 'OpenRouter (router for many models)',
        defaultEndpoint: 'https://openrouter.ai/api/v1',
        suggestedModels: ['anthropic/claude-3-5-haiku', 'openai/gpt-4o-mini', 'meta-llama/llama-3.1-8b-instruct'],
        needsKey: true,
        envVarName: 'OPENROUTER_API_KEY',
    },
    {
        backend: 'ollama',
        label: 'Ollama (local, no key)',
        defaultEndpoint: 'http://localhost:11434',
        suggestedModels: ['llama3.1:8b', 'llama3.2:3b', 'qwen2.5:7b', 'mistral:7b'],
        needsKey: false,
    },
    {
        backend: 'huggingface',
        label: 'HuggingFace (Router, OpenAI-compatible)',
        defaultEndpoint: 'https://router.huggingface.co/v1',
        suggestedModels: [
            'meta-llama/Llama-3.1-8B-Instruct',
            'meta-llama/Llama-3.3-70B-Instruct',
            'Qwen/Qwen2.5-Coder-32B-Instruct',
            'Qwen/Qwen2.5-72B-Instruct',
            'mistralai/Mistral-7B-Instruct-v0.3',
            'deepseek-ai/DeepSeek-V3',
        ],
        needsKey: true,
        envVarName: 'HF_TOKEN',
    },
    {
        backend: 'custom',
        label: 'Custom (any OpenAI-compatible endpoint)',
        defaultEndpoint: 'https://api.example.com/v1',
        suggestedModels: [
            'deepseek-chat', 'deepseek-coder',
            'llama-3.3-70b-versatile', 'mixtral-8x7b-32768',
            'qwen-max', 'sonar-pro',
        ],
        needsKey: true,
    },
];

export interface EmbeddingsSettings {
    enabled: boolean;
    modelId: string | null;
    /** Cached vec count for this project. */
    totalEmbeddings: number;
    /** Whether the embedding model is already on disk. */
    modelCached: boolean;
    /** Available models from the registry. */
    availableModels: Array<{ id: string; description: string; dim: number; license: string }>;
}

export interface LlmSettings {
    /** Master switch — when false, LLM layer is off regardless of keys. */
    enabled: boolean;
    /** Currently active resolved config (or null if disabled / none works). */
    active: {
        backend: LlmBackend;
        endpoint: string;
        model: string;
        source: string;
        hasKey: boolean;
        /** When source==='env', the name of the env var. */
        envVarName?: string;
    } | null;
    /** What's stored in ~/.aidex/llm.json (user-controlled). */
    file: {
        endpoint: string | null;
        model: string | null;
        hasKey: boolean;
        /** Last 4 chars of a literal stored key, for masked display ("sk-...abc4"). */
        keyTail: string | null;
        /** If the file points at an env var instead of a literal key. */
        keyEnvName: string | null;
    };
    /** Per-project privacy switch. */
    sendCode: boolean;
    providers: ProviderOption[];
}

export interface ProjectSettings {
    projectPath: string;
    embeddings: EmbeddingsSettings;
    llm: LlmSettings;
    /** Latest schema version this project has acknowledged. */
    lastSeenVersion: string | null;
    currentVersion: string;
}

// ============================================================
// Read
// ============================================================

export async function getSettings(projectPath: string): Promise<ProjectSettings> {
    ensureEmbeddingsSchema();

    const embedInfo = getProjectInfo(projectPath);
    const enabled = isProjectEnabled(projectPath);
    const modelCached = isModelCachedOnDisk(embedInfo?.modelId ?? 'jina-code');

    const file = readLlmConfigFile() ?? {};
    const creds = await resolveLlmCreds({ projectPath });

    const sendCode = readSendCodeFromDb(projectPath);
    const lastSeen = readMetadata('last_seen_version');

    return {
        projectPath,
        embeddings: {
            enabled,
            modelId: embedInfo?.modelId ?? null,
            totalEmbeddings: embedInfo ? countProjectEmbeddings(embedInfo.id) : 0,
            modelCached,
            availableModels: listModels().map(m => ({
                id: m.id,
                description: m.description,
                dim: m.dim,
                license: m.license,
            })),
        },
        llm: {
            enabled: isLlmEnabled(),
            active: creds
                ? {
                      backend: creds.backend,
                      endpoint: creds.endpoint,
                      model: creds.model,
                      source: creds.source,
                      hasKey: !!creds.apiKey || creds.backend === 'ollama',
                      ...(creds.envVarName ? { envVarName: creds.envVarName } : {}),
                  }
                : null,
            file: {
                endpoint: file.endpoint ?? null,
                model: file.model ?? null,
                hasKey: !!(file.api_key || file.api_key_env),
                keyTail: file.api_key && file.api_key.length >= 4
                    ? file.api_key.slice(-4)
                    : null,
                keyEnvName: file.api_key_env ?? null,
            },
            sendCode,
            providers: PROVIDER_OPTIONS,
        },
        lastSeenVersion: lastSeen,
        currentVersion: getCurrentVersion(),
    };
}

// ============================================================
// Write
// ============================================================

export interface SetSettingsPayload {
    enableEmbeddings?: boolean;
    embeddingModel?: string;
    /** Master switch for the LLM layer. When false, no provider is resolved. */
    llmEnabled?: boolean;
    llmEndpoint?: string | null;
    llmModel?: string | null;
    llmApiKey?: string | null;
    llmSendCode?: boolean;
}

const MAX_STRING_LEN = 2048;
const MAX_API_KEY_LEN = 8192;
const MAX_MODEL_LEN = 256;

/**
 * Coerce an untrusted payload (e.g. from a WebSocket client) into a
 * SetSettingsPayload. Unknown keys are dropped, oversized strings rejected.
 * Throws Error with a user-readable message on invalid input.
 */
export function validateSetSettingsPayload(raw: unknown): SetSettingsPayload {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Settings payload must be an object');
    }
    const src = raw as Record<string, unknown>;
    const out: SetSettingsPayload = {};

    const checkStr = (key: string, val: unknown, max: number): string | null => {
        if (val === null) return null;
        if (typeof val !== 'string') throw new Error(`${key} must be a string or null`);
        if (val.length > max) throw new Error(`${key} exceeds max length ${max}`);
        return val;
    };

    if ('enableEmbeddings' in src) {
        if (typeof src.enableEmbeddings !== 'boolean') throw new Error('enableEmbeddings must be boolean');
        out.enableEmbeddings = src.enableEmbeddings;
    }
    if ('embeddingModel' in src && src.embeddingModel !== undefined) {
        if (typeof src.embeddingModel !== 'string') throw new Error('embeddingModel must be a string');
        if (src.embeddingModel.length > MAX_MODEL_LEN) throw new Error(`embeddingModel exceeds max length ${MAX_MODEL_LEN}`);
        out.embeddingModel = src.embeddingModel;
    }
    if ('llmEndpoint' in src) {
        out.llmEndpoint = checkStr('llmEndpoint', src.llmEndpoint, MAX_STRING_LEN);
    }
    if ('llmModel' in src) {
        const v = checkStr('llmModel', src.llmModel, MAX_MODEL_LEN);
        out.llmModel = v;
    }
    if ('llmApiKey' in src) {
        out.llmApiKey = checkStr('llmApiKey', src.llmApiKey, MAX_API_KEY_LEN);
    }
    if ('llmSendCode' in src) {
        if (typeof src.llmSendCode !== 'boolean') throw new Error('llmSendCode must be boolean');
        out.llmSendCode = src.llmSendCode;
    }
    if ('llmEnabled' in src) {
        if (typeof src.llmEnabled !== 'boolean') throw new Error('llmEnabled must be boolean');
        out.llmEnabled = src.llmEnabled;
    }

    return out;
}

export interface SetSettingsResult {
    success: boolean;
    indexed?: { embedded: number; durationMs: number };
    error?: string;
}

export async function setSettings(
    projectPath: string,
    payload: SetSettingsPayload
): Promise<SetSettingsResult> {
    ensureEmbeddingsSchema();

    try {
        // 1. Update LLM config file (~/.aidex/llm.json) — only fields explicitly given.
        if (
            payload.llmEnabled !== undefined ||
            payload.llmEndpoint !== undefined ||
            payload.llmModel !== undefined ||
            payload.llmApiKey !== undefined
        ) {
            const current = readLlmConfigFile() ?? {};
            const next = { ...current };
            if (payload.llmEnabled !== undefined) {
                next.enabled = payload.llmEnabled;
            }
            if (payload.llmEndpoint !== undefined) {
                if (payload.llmEndpoint) next.endpoint = payload.llmEndpoint;
                else delete next.endpoint;
            }
            if (payload.llmModel !== undefined) {
                if (payload.llmModel) next.model = payload.llmModel;
                else delete next.model;
            }
            if (payload.llmApiKey !== undefined) {
                // api_key and api_key_env are mutually exclusive — clear both first.
                delete next.api_key;
                delete next.api_key_env;
                const trimmed = payload.llmApiKey?.trim() ?? '';
                if (trimmed) {
                    if (isEnvVarName(trimmed)) {
                        next.api_key_env = trimmed;
                    } else {
                        next.api_key = trimmed;
                    }
                }
            }

            // Validate ONLY when LLM layer is on. Off means the user wants no
            // provider resolved at all — no key required.
            if (next.enabled !== false) {
                const validation = validateLlmConfigKey(next);
                if (!validation.ok) {
                    return { success: false, error: validation.error };
                }
            }

            writeLlmConfigFile(next);

            // Invalidate the LLM module's cred cache so the next call sees
            // the new config without waiting for the 5s TTL.
            try {
                const { getLlm } = await import('./index.js');
                getLlm().invalidate();
            } catch { /* non-fatal */ }
        }

        // 2. Per-project send_code (and optional endpoint/model overrides).
        if (
            payload.llmSendCode !== undefined ||
            payload.llmEndpoint !== undefined ||
            payload.llmModel !== undefined
        ) {
            writeProjectLlmSettings(projectPath, payload);
        }

        // 3. Embeddings on/off.
        let indexed: SetSettingsResult['indexed'] | undefined;
        if (payload.enableEmbeddings === true) {
            const { getEmbeddings } = await import('../embeddings/index.js');
            const e = getEmbeddings();
            await e.enable(projectPath, { model: payload.embeddingModel });
            const r = await e.indexProject(projectPath);
            indexed = { embedded: r.embedded, durationMs: r.durationMs };
        } else if (payload.enableEmbeddings === false) {
            disableEmbeddingsForProject(projectPath);
        }

        return { success: true, indexed };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}

// ============================================================
// Test connection
// ============================================================

export interface TestConnectionResult {
    ok: boolean;
    backend: LlmBackend | null;
    model: string | null;
    latencyMs: number | null;
    error?: string;
}

export async function testLlmConnection(projectPath: string): Promise<TestConnectionResult> {
    // Test the *user's chosen* backend strictly — i.e. the one stored in
    // ~/.aidex/llm.json. resolveLlmCreds() has fallbacks (ENV auto-detect,
    // Ollama probe) which would silently switch to a different provider —
    // that's wrong for an explicit Test button. If the file says Anthropic
    // but no Anthropic key is resolvable, return a clear error rather than
    // testing OpenAI behind the user's back.
    const file = readLlmConfigFile();

    if (file && file.enabled === false) {
        return {
            ok: false, backend: null, model: null, latencyMs: null,
            error: 'LLM Layer is disabled. Enable it in Settings to run a connection test.',
        };
    }

    const creds = file
        ? buildCredsFromFile(file)
        : await resolveLlmCreds({ projectPath });

    if (!creds) {
        if (file && file.endpoint) {
            // File chose a backend but no key resolves — explain why.
            const backend = inferBackendFromEndpoint(file.endpoint);
            const conventional = expectedEnvVarFor(backend);
            const hint = conventional
                ? ` Set ${conventional} or paste a key into the API Key field.`
                : '';
            return {
                ok: false,
                backend,
                model: file.model ?? null,
                latencyMs: null,
                error: `No API key found for ${backend}.${hint}`,
            };
        }
        return {
            ok: false,
            backend: null,
            model: null,
            latencyMs: null,
            error: 'No LLM backend configured (no API key, no Ollama running)',
        };
    }
    const provider = createProvider(creds);
    const t0 = Date.now();
    try {
        const res = await provider.call({
            system: 'You are a connection test. Reply with the single word OK.',
            user: 'ping',
            maxTokens: 5,
            temperature: 0,
        });
        const latencyMs = Date.now() - t0;
        return {
            ok: !!res.text,
            backend: creds.backend,
            model: creds.model,
            latencyMs,
        };
    } catch (err) {
        return {
            ok: false,
            backend: creds.backend,
            model: creds.model,
            latencyMs: Date.now() - t0,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

/** Infer backend purely from an endpoint URL (no DB, no env). */
function inferBackendFromEndpoint(endpoint: string): LlmBackend {
    const e = endpoint.toLowerCase();
    if (e.includes('anthropic.com')) return 'anthropic';
    if (e.includes('openai.com')) return 'openai';
    if (e.includes('openrouter')) return 'openrouter';
    if (e.includes('huggingface.co')) return 'huggingface';
    if (/^https?:\/\/(localhost|127\.|192\.168\.|10\.|::1)/.test(endpoint)) return 'ollama';
    return 'custom';
}

function expectedEnvVarFor(backend: LlmBackend): string | null {
    const map: Record<string, string> = {
        anthropic: 'ANTHROPIC_API_KEY',
        openai: 'OPENAI_API_KEY',
        openrouter: 'OPENROUTER_API_KEY',
        huggingface: 'HF_TOKEN',
    };
    return map[backend] ?? null;
}

/**
 * Build LlmCreds strictly from the file content, following the same key-
 * resolution chain as readConfigFileSmart but without falling back to a
 * different backend.
 */
function buildCredsFromFile(file: LlmConfigFile): LlmCreds | null {
    if (!file.endpoint && !file.api_key && !file.api_key_env) return null;
    const endpoint = file.endpoint ?? 'https://api.anthropic.com';
    const backend = inferBackendFromEndpoint(endpoint);
    const model = file.model ?? defaultModelForBackend(backend);

    if (backend === 'ollama') {
        return { backend, apiKey: null, endpoint, model, source: 'config-file' };
    }

    let apiKey: string | null = null;
    let envVarName: string | undefined;
    if (file.api_key && file.api_key.trim()) {
        apiKey = file.api_key.trim();
    } else if (file.api_key_env && file.api_key_env.trim()) {
        envVarName = file.api_key_env.trim();
        apiKey = process.env[envVarName] ?? null;
    } else {
        envVarName = expectedEnvVarFor(backend) ?? undefined;
        if (envVarName) apiKey = process.env[envVarName] ?? null;
    }

    if (!apiKey) return null;
    return { backend, apiKey, endpoint, model, source: 'config-file', envVarName };
}

function defaultModelForBackend(b: LlmBackend): string {
    const provider = PROVIDER_OPTIONS.find(p => p.backend === b);
    return provider?.suggestedModels[0] ?? 'gpt-4o-mini';
}

/**
 * Validate that a llm.json config has a usable key for its backend.
 * Returns ok:false if the user picked a paid backend without a key
 * resolvable (literal in file, env-var in file, or conventional ENV var).
 */
function validateLlmConfigKey(file: LlmConfigFile): { ok: true } | { ok: false; error: string } {
    if (!file.endpoint && !file.api_key && !file.api_key_env) return { ok: true }; // empty = nothing to validate
    const endpoint = file.endpoint ?? 'https://api.anthropic.com';
    const backend = inferBackendFromEndpoint(endpoint);

    // Ollama / local backends don't need a key.
    if (backend === 'ollama') return { ok: true };

    // Literal key always wins.
    if (file.api_key && file.api_key.trim()) return { ok: true };

    // api_key_env: must resolve to a non-empty value.
    if (file.api_key_env && file.api_key_env.trim()) {
        const v = process.env[file.api_key_env.trim()];
        if (v && v.trim()) return { ok: true };
        return {
            ok: false,
            error: `Environment variable ${file.api_key_env} is not set or empty. Set it, or paste a literal key.`,
        };
    }

    // No explicit file key — check the conventional ENV var for this backend.
    const conventional = expectedEnvVarFor(backend);
    if (conventional && process.env[conventional] && process.env[conventional]!.trim()) {
        return { ok: true };
    }

    const hint = conventional
        ? ` Set ${conventional} in your environment, or paste a literal key into the API Key field.`
        : ' Paste a literal key into the API Key field.';
    return {
        ok: false,
        error: `No API key for ${backend}.${hint}`,
    };
}

// ============================================================
// Helpers
// ============================================================

function isModelCachedOnDisk(modelId: string): boolean {
    // Transformers.js cache layout: ~/.aidex/models/<huggingface-id>/onnx/...
    // We probe for the directory; that's a useful signal even if it's not exhaustive.
    const cacheRoot = join(homedir(), '.aidex', 'models');
    if (!existsSync(cacheRoot)) return false;
    // Loose check: any non-empty subdir under cacheRoot means at least one model is cached.
    try {
        const entries = readdirSync(cacheRoot, { withFileTypes: true });
        return entries.some(e => e.isDirectory());
    } catch {
        return false;
    }
}

function readSendCodeFromDb(projectPath: string): boolean {
    try {
        const dbPath = join(homedir(), '.aidex', 'global.db');
        if (!existsSync(dbPath)) return false;
        const db = new Database(dbPath, { readonly: true });
        try {
            const row = db
                .prepare('SELECT llm_send_code FROM projects WHERE path = ?')
                .get(projectPath) as { llm_send_code: number | null } | undefined;
            return (row?.llm_send_code ?? 0) === 1;
        } finally {
            db.close();
        }
    } catch {
        return false;
    }
}

function writeProjectLlmSettings(projectPath: string, payload: SetSettingsPayload): void {
    const dbPath = join(homedir(), '.aidex', 'global.db');
    if (!existsSync(dbPath)) return;
    const db = new Database(dbPath);
    try {
        const sets: string[] = [];
        const vals: unknown[] = [];
        if (payload.llmEndpoint !== undefined) {
            sets.push('llm_endpoint = ?');
            vals.push(payload.llmEndpoint || null);
        }
        if (payload.llmModel !== undefined) {
            sets.push('llm_model = ?');
            vals.push(payload.llmModel || null);
        }
        if (payload.llmSendCode !== undefined) {
            sets.push('llm_send_code = ?');
            vals.push(payload.llmSendCode ? 1 : 0);
        }
        if (sets.length > 0) {
            vals.push(projectPath);
            db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE path = ?`).run(...vals);
        }
    } finally {
        db.close();
    }
}

function disableEmbeddingsForProject(projectPath: string): void {
    const dbPath = join(homedir(), '.aidex', 'global.db');
    if (!existsSync(dbPath)) return;
    const db = new Database(dbPath);
    try {
        db.prepare(
            'UPDATE projects SET embedding_model_id = NULL WHERE path = ?'
        ).run(projectPath);
    } finally {
        db.close();
    }
}

function readMetadata(key: string): string | null {
    try {
        const dbPath = join(homedir(), '.aidex', 'global.db');
        if (!existsSync(dbPath)) return null;
        const db = new Database(dbPath, { readonly: true });
        try {
            const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as
                | { value: string }
                | undefined;
            return row?.value ?? null;
        } finally {
            db.close();
        }
    } catch {
        return null;
    }
}

function writeMetadata(key: string, value: string): void {
    try {
        const dbPath = join(homedir(), '.aidex', 'global.db');
        if (!existsSync(dbPath)) return;
        const db = new Database(dbPath);
        try {
            db.prepare(
                'INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)'
            ).run(key, value);
        } finally {
            db.close();
        }
    } catch {
        // ignore
    }
}

function getCurrentVersion(): string {
    return PRODUCT_VERSION || 'unknown';
}

export function markVersionSeen(): void {
    writeMetadata('last_seen_version', getCurrentVersion());
}

export function shouldShowUpdateNotification(): boolean {
    const seen = readMetadata('last_seen_version');
    const current = getCurrentVersion();
    if (!seen) return true; // first run after install
    return seen !== current;
}
