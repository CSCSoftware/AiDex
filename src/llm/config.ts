/**
 * Config / credential discovery for the LLM layer.
 *
 * Resolution order (first match wins):
 *   1. Per-project endpoint+model in projects.llm_endpoint / llm_model
 *   2. Env vars: ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY
 *   3. aidex_global_guideline keys: llm.api_key, llm.endpoint, llm.model
 *   4. ~/.aidex/llm.json
 *   5. Local Ollama at http://localhost:11434 (probed)
 *
 * If nothing matches, the module stays in stub mode.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import Database from 'better-sqlite3';

export type LlmBackend = 'anthropic' | 'openai' | 'openrouter' | 'ollama' | 'custom' | 'huggingface';

export interface LlmCreds {
    backend: LlmBackend;
    apiKey: string | null;        // null is OK only for ollama
    endpoint: string;             // full base URL
    model: string;
    /** Diagnostic: where this config came from. */
    source: 'env' | 'guideline' | 'config-file' | 'ollama-default' | 'project';
    /** Diagnostic: name of the env var when source==='env' or when file uses api_key_env. */
    envVarName?: string;
}

const DEFAULT_OLLAMA = 'http://localhost:11434';
const HUGGINGFACE_ENDPOINT = 'https://router.huggingface.co/v1';
const HUGGINGFACE_DEFAULT_MODEL = 'meta-llama/Llama-3.1-8B-Instruct';

const ENV_KEYS: Array<{ env: string; backend: LlmBackend; endpoint: string; defaultModel: string }> = [
    { env: 'ANTHROPIC_API_KEY',     backend: 'anthropic',   endpoint: 'https://api.anthropic.com',  defaultModel: 'claude-haiku-4-5' },
    { env: 'OPENAI_API_KEY',        backend: 'openai',      endpoint: 'https://api.openai.com/v1',  defaultModel: 'gpt-4o-mini' },
    { env: 'OPENROUTER_API_KEY',    backend: 'openrouter',  endpoint: 'https://openrouter.ai/api/v1', defaultModel: 'anthropic/claude-3-5-haiku' },
    { env: 'HF_TOKEN',              backend: 'huggingface', endpoint: HUGGINGFACE_ENDPOINT,         defaultModel: HUGGINGFACE_DEFAULT_MODEL },
    { env: 'HUGGINGFACE_API_KEY',   backend: 'huggingface', endpoint: HUGGINGFACE_ENDPOINT,         defaultModel: HUGGINGFACE_DEFAULT_MODEL },
];

export interface ResolveOptions {
    /** If supplied, project-level overrides take precedence over global settings. */
    projectPath?: string;
}

export async function resolveLlmCreds(opts: ResolveOptions = {}): Promise<LlmCreds | null> {
    // Master switch: if the user explicitly turned LLM off, no provider.
    if (!isLlmEnabled()) return null;

    // 1) Project-level (per-project override in projects.llm_endpoint)
    if (opts.projectPath) {
        const proj = readProjectConfig(opts.projectPath);
        if (proj) return proj;
    }

    // 2) ~/.aidex/llm.json — the user explicitly chose this provider in
    //    the Settings tab. It wins over ENV auto-detect: otherwise picking
    //    "Anthropic" while OPENAI_API_KEY is set would silently keep using
    //    OpenAI. If the file has an endpoint but no usable key, fall back
    //    to the env var that matches THAT backend, then guideline.
    const fromFile = readConfigFileSmart();
    if (fromFile) return fromFile;

    // 3) Env vars (auto-detect for first-time users who never opened Settings)
    for (const { env, backend, endpoint, defaultModel } of ENV_KEYS) {
        const key = process.env[env];
        if (key && key.trim()) {
            return {
                backend,
                apiKey: key,
                endpoint,
                model: process.env.AIDEX_LLM_MODEL || defaultModel,
                source: 'env',
                envVarName: env,
            };
        }
    }

    // 4) aidex_global_guideline
    const fromGuide = readGuideline();
    if (fromGuide) return fromGuide;

    // 5) Ollama probe
    if (await probeOllama(DEFAULT_OLLAMA)) {
        return {
            backend: 'ollama',
            apiKey: null,
            endpoint: DEFAULT_OLLAMA,
            model: 'llama3.1:8b',
            source: 'ollama-default',
        };
    }

    return null;
}

/**
 * Read config file and resolve key with backend-aware fallback.
 *
 * If the file has:
 *   - api_key (literal) → use it directly
 *   - api_key_env name → look up that var
 *   - neither, but has an endpoint → look up the env var conventional for
 *     this backend (e.g. file says endpoint=anthropic.com → try ANTHROPIC_API_KEY)
 *
 * Ollama needs no key. For anything else without a key, return null
 * so the next resolution stage gets a chance.
 */
function readConfigFileSmart(): LlmCreds | null {
    const data = readLlmConfigFile();
    if (!data) return null;

    const endpoint = data.endpoint ?? null;
    if (!endpoint) {
        // No endpoint stored → file isn't really configured. Fall through.
        // (A literal api_key alone without endpoint is ambiguous and rare.)
        if (!data.api_key && !data.api_key_env) return null;
    }

    const finalEndpoint = endpoint ?? 'https://api.anthropic.com';
    const backend = inferBackend(finalEndpoint);
    const model = data.model ?? defaultModelFor(backend);

    if (backend === 'ollama') {
        return { backend, apiKey: null, endpoint: finalEndpoint, model, source: 'config-file' };
    }

    // Resolve key: literal api_key wins, then api_key_env, then env var
    // matching this backend.
    let apiKey: string | null = null;
    let envVarName: string | undefined;
    if (data.api_key && data.api_key.trim()) {
        apiKey = data.api_key.trim();
    } else if (data.api_key_env && data.api_key_env.trim()) {
        envVarName = data.api_key_env.trim();
        apiKey = process.env[envVarName] ?? null;
    } else {
        // No explicit key in file — fall back to the env var conventional
        // for the chosen backend.
        const conventional = ENV_KEYS.find(k => k.backend === backend);
        if (conventional) {
            envVarName = conventional.env;
            apiKey = process.env[conventional.env] ?? null;
        }
    }

    if (!apiKey) return null; // can't use the file config without a key

    return {
        backend,
        apiKey,
        endpoint: finalEndpoint,
        model,
        source: 'config-file',
        envVarName,
    };
}

function readProjectConfig(projectPath: string): LlmCreds | null {
    try {
        const dbPath = join(homedir(), '.aidex', 'global.db');
        if (!existsSync(dbPath)) return null;
        const db = new Database(dbPath, { readonly: true });
        try {
            const cols = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
            const have = new Set(cols.map(c => c.name));
            if (!have.has('llm_endpoint')) return null;

            const row = db
                .prepare(
                    `SELECT llm_endpoint, llm_model FROM projects WHERE path = ?`
                )
                .get(projectPath) as { llm_endpoint: string | null; llm_model: string | null } | undefined;
            if (!row || !row.llm_endpoint) return null;

            const backend = inferBackend(row.llm_endpoint);
            // For non-ollama backends we still need a key — fall back to env if available.
            let apiKey: string | null = null;
            if (backend !== 'ollama') {
                const envKey = ENV_KEYS.find(k => k.backend === backend)?.env;
                apiKey = (envKey && process.env[envKey]) || null;
                if (!apiKey) {
                    const guide = readGuidelineKey('llm.api_key');
                    if (guide) apiKey = guide;
                }
                if (!apiKey) return null; // can't use it without a key
            }
            return {
                backend,
                apiKey,
                endpoint: row.llm_endpoint,
                model: row.llm_model || defaultModelFor(backend),
                source: 'project',
            };
        } finally {
            db.close();
        }
    } catch {
        return null;
    }
}

function inferBackend(endpoint: string): LlmBackend {
    const e = endpoint.toLowerCase();
    if (e.includes('anthropic.com')) return 'anthropic';
    if (e.includes('openai.com')) return 'openai';
    if (e.includes('openrouter')) return 'openrouter';
    if (e.includes('huggingface.co')) return 'huggingface';
    // Localhost / 127.x / private network → assume Ollama (no key required).
    if (/^https?:\/\/(localhost|127\.|192\.168\.|10\.|::1)/.test(endpoint)) return 'ollama';
    // Anything else with an https URL: treat as a custom OpenAI-compatible API.
    return 'custom';
}

function defaultModelFor(b: LlmBackend): string {
    if (b === 'custom') return 'gpt-4o-mini'; // sensible default name for OpenAI-compatible APIs
    if (b === 'ollama') return 'llama3.1:8b';
    if (b === 'huggingface') return HUGGINGFACE_DEFAULT_MODEL;
    return ENV_KEYS.find(k => k.backend === b)?.defaultModel ?? 'gpt-4o-mini';
}

function readGuideline(): LlmCreds | null {
    const apiKey = readGuidelineKey('llm.api_key');
    if (!apiKey) return null;
    const endpoint = readGuidelineKey('llm.endpoint') ?? 'https://api.anthropic.com';
    const model = readGuidelineKey('llm.model') ?? defaultModelFor(inferBackend(endpoint));
    return {
        backend: inferBackend(endpoint),
        apiKey,
        endpoint,
        model,
        source: 'guideline',
    };
}

function readGuidelineKey(key: string): string | null {
    try {
        const dbPath = join(homedir(), '.aidex', 'global.db');
        if (!existsSync(dbPath)) return null;
        const db = new Database(dbPath, { readonly: true });
        try {
            const row = db.prepare('SELECT value FROM guidelines WHERE key = ?').get(key) as
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

async function probeOllama(endpoint: string): Promise<boolean> {
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 250);
        const res = await fetch(endpoint + '/api/tags', { signal: ctrl.signal });
        clearTimeout(timer);
        return res.ok;
    } catch {
        return false;
    }
}

/** Read the global LLM config file (~/.aidex/llm.json). */
export interface LlmConfigFile {
    /** Master switch. If false: LLM layer is disabled, no provider is resolved. */
    enabled?: boolean;
    /** A literal API key (e.g. "sk-proj-..."). Mutually exclusive with api_key_env. */
    api_key?: string;
    /** Name of an environment variable to read the key from (e.g. "OPENAI_API_KEY"). */
    api_key_env?: string;
    endpoint?: string;
    model?: string;
}

/**
 * The "is LLM layer on?" decision.
 *
 * Backwards compatibility: existing users have no `enabled` field in their
 * file. If a key is resolvable (literal, api_key_env, or auto-detected ENV),
 * we treat them as "on" — so an update doesn't silently turn off LLM for
 * users who were already using it. New installs without any config end up
 * "off" by default.
 */
export function isLlmEnabled(): boolean {
    const data = readLlmConfigFile();
    if (data && typeof data.enabled === 'boolean') return data.enabled;
    // Legacy: infer from presence of resolvable key.
    if (data) {
        if (data.api_key && data.api_key.trim()) return true;
        if (data.api_key_env && process.env[data.api_key_env]) return true;
    }
    // Auto-detect ENV
    for (const { env } of ENV_KEYS) {
        if (process.env[env] && process.env[env]!.trim()) return true;
    }
    return false;
}

/** Pattern for valid env-var names: uppercase letter start, then [A-Z0-9_]. */
export const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** Detect whether a user-typed string looks like an env-var name vs. a real key. */
export function isEnvVarName(input: string): boolean {
    return ENV_VAR_NAME_RE.test(input.trim()) && input.trim().length <= 64;
}

export function llmConfigPath(): string {
    return join(homedir(), '.aidex', 'llm.json');
}

export function readLlmConfigFile(): LlmConfigFile | null {
    const path = llmConfigPath();
    if (!existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, 'utf-8')) as LlmConfigFile;
    } catch {
        return null;
    }
}

export function writeLlmConfigFile(cfg: LlmConfigFile): void {
    const path = llmConfigPath();
    const dir = join(homedir(), '.aidex');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // api_key and api_key_env are mutually exclusive — last write wins.
    const clean: LlmConfigFile = {};
    if (typeof cfg.enabled === 'boolean') clean.enabled = cfg.enabled;
    if (cfg.api_key && cfg.api_key.trim()) {
        clean.api_key = cfg.api_key.trim();
    } else if (cfg.api_key_env && cfg.api_key_env.trim()) {
        clean.api_key_env = cfg.api_key_env.trim();
    }
    if (cfg.endpoint && cfg.endpoint.trim()) clean.endpoint = cfg.endpoint.trim();
    if (cfg.model && cfg.model.trim()) clean.model = cfg.model.trim();

    writeFileSync(path, JSON.stringify(clean, null, 2), 'utf-8');
    // Best-effort chmod 600 (no-op on Windows).
    try { chmodSync(path, 0o600); } catch { /* ignore */ }
}

/** Per-project lookup of the privacy switch llm_send_code. */
export function readLlmSendCode(projectPath: string): boolean {
    try {
        const dbPath = join(homedir(), '.aidex', 'global.db');
        if (!existsSync(dbPath)) return false;
        const db = new Database(dbPath, { readonly: true });
        try {
            const cols = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
            if (!cols.some(c => c.name === 'llm_send_code')) return false;
            const row = db.prepare('SELECT llm_send_code FROM projects WHERE path = ?').get(projectPath) as
                | { llm_send_code: number | null }
                | undefined;
            return (row?.llm_send_code ?? 0) === 1;
        } finally {
            db.close();
        }
    } catch {
        return false;
    }
}
