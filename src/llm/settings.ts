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

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { PRODUCT_VERSION } from '../constants.js';
import {
    type LlmBackend,
    type LlmCreds,
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
}

export const PROVIDER_OPTIONS: ProviderOption[] = [
    {
        backend: 'anthropic',
        label: 'Anthropic (Claude)',
        defaultEndpoint: 'https://api.anthropic.com',
        suggestedModels: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'],
        needsKey: true,
    },
    {
        backend: 'openai',
        label: 'OpenAI (GPT)',
        defaultEndpoint: 'https://api.openai.com/v1',
        suggestedModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
        needsKey: true,
    },
    {
        backend: 'openrouter',
        label: 'OpenRouter (router for many models)',
        defaultEndpoint: 'https://openrouter.ai/api/v1',
        suggestedModels: ['anthropic/claude-3-5-haiku', 'openai/gpt-4o-mini', 'meta-llama/llama-3.1-8b-instruct'],
        needsKey: true,
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
    /** Currently active resolved config (or null if none works). */
    active: {
        backend: LlmBackend;
        endpoint: string;
        model: string;
        source: string;
        hasKey: boolean;
    } | null;
    /** What's stored in ~/.aidex/llm.json (user-controlled). */
    file: {
        endpoint: string | null;
        model: string | null;
        hasKey: boolean;
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
            active: creds
                ? {
                      backend: creds.backend,
                      endpoint: creds.endpoint,
                      model: creds.model,
                      source: creds.source,
                      hasKey: !!creds.apiKey || creds.backend === 'ollama',
                  }
                : null,
            file: {
                endpoint: file.endpoint ?? null,
                model: file.model ?? null,
                hasKey: !!file.api_key,
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
    llmEndpoint?: string | null;
    llmModel?: string | null;
    llmApiKey?: string | null;
    llmSendCode?: boolean;
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
            payload.llmEndpoint !== undefined ||
            payload.llmModel !== undefined ||
            payload.llmApiKey !== undefined
        ) {
            const current = readLlmConfigFile() ?? {};
            const next = { ...current };
            if (payload.llmEndpoint !== undefined) {
                if (payload.llmEndpoint) next.endpoint = payload.llmEndpoint;
                else delete next.endpoint;
            }
            if (payload.llmModel !== undefined) {
                if (payload.llmModel) next.model = payload.llmModel;
                else delete next.model;
            }
            if (payload.llmApiKey !== undefined) {
                if (payload.llmApiKey) next.api_key = payload.llmApiKey;
                else delete next.api_key;
            }
            writeLlmConfigFile(next);
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
    const creds = await resolveLlmCreds({ projectPath });
    if (!creds) {
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
        const fs = require('fs') as typeof import('fs');
        const entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
        return entries.some(e => e.isDirectory());
    } catch {
        return false;
    }
}

function readSendCodeFromDb(projectPath: string): boolean {
    try {
        const Database = require('better-sqlite3') as new (path: string, opts?: { readonly?: boolean }) => {
            prepare(sql: string): { get(...args: unknown[]): unknown };
            close(): void;
        };
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
    const Database = require('better-sqlite3') as new (path: string) => {
        prepare(sql: string): { run(...args: unknown[]): unknown };
        close(): void;
    };
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
    const Database = require('better-sqlite3') as new (path: string) => {
        prepare(sql: string): { run(...args: unknown[]): unknown };
        close(): void;
    };
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
        const Database = require('better-sqlite3') as new (path: string, opts?: { readonly?: boolean }) => {
            prepare(sql: string): { get(...args: unknown[]): unknown };
            close(): void;
        };
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
        const Database = require('better-sqlite3') as new (path: string) => {
            prepare(sql: string): { run(...args: unknown[]): unknown };
            close(): void;
        };
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
