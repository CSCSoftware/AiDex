/**
 * Provider abstraction — one interface, many backends.
 *
 * All backends speak the same simple "send a system prompt + user message,
 * get text back" protocol. We don't need streaming or tool use for translate/
 * expand/rerank.
 */

import type { LlmCreds } from './config.js';

export interface ProviderRequest {
    system: string;
    user: string;
    /** Hard cap on output tokens. */
    maxTokens: number;
    /** 0..1; lower = more deterministic. We default to 0.1. */
    temperature?: number;
}

export interface ProviderResponse {
    text: string;
    /** Total input + output tokens, when reported by the backend. */
    tokens: { input: number; output: number } | null;
}

export interface Provider {
    readonly creds: LlmCreds;
    call(req: ProviderRequest): Promise<ProviderResponse>;
}

interface ProviderSpec {
    readonly name: string;
    url(creds: LlmCreds): string;
    headers(creds: LlmCreds): Record<string, string>;
    buildBody(creds: LlmCreds, req: ProviderRequest): unknown;
    parseResponse(json: unknown): ProviderResponse;
    /** Optional hook for status-specific error messages (e.g. HF 503 cold-start). */
    formatError?(status: number, body: string): string | null;
}

async function makeRequest(spec: ProviderSpec, creds: LlmCreds, req: ProviderRequest): Promise<ProviderResponse> {
    const res = await fetch(spec.url(creds), {
        method: 'POST',
        headers: spec.headers(creds),
        body: JSON.stringify(spec.buildBody(creds, req)),
    });
    if (!res.ok) {
        const txt = await res.text();
        const custom = spec.formatError?.(res.status, txt);
        throw new Error(custom ?? `${spec.name} ${res.status}: ${txt}`);
    }
    return spec.parseResponse(await res.json());
}

const stripSlash = (s: string) => s.replace(/\/$/, '');

const anthropicSpec: ProviderSpec = {
    name: 'anthropic',
    url: (c) => stripSlash(c.endpoint) + '/v1/messages',
    headers: (c) => ({
        'content-type': 'application/json',
        'x-api-key': c.apiKey ?? '',
        'anthropic-version': '2023-06-01',
    }),
    buildBody: (c, r) => ({
        model: c.model,
        max_tokens: r.maxTokens,
        temperature: r.temperature ?? 0.1,
        system: r.system,
        messages: [{ role: 'user', content: r.user }],
    }),
    parseResponse: (raw) => {
        const json = raw as {
            content?: Array<{ type: string; text: string }>;
            usage?: { input_tokens: number; output_tokens: number };
        };
        const text = (json.content ?? []).map(c => (c.type === 'text' ? c.text : '')).join('').trim();
        return {
            text,
            tokens: json.usage ? { input: json.usage.input_tokens, output: json.usage.output_tokens } : null,
        };
    },
};

/** OpenAI-compatible chat-completions schema. Used for openai/openrouter/custom. */
function openAiCompatSpec(name: string, urlBuilder: (c: LlmCreds) => string): ProviderSpec {
    return {
        name,
        url: urlBuilder,
        headers: (c) => ({
            'content-type': 'application/json',
            authorization: `Bearer ${c.apiKey ?? ''}`,
        }),
        buildBody: (c, r) => ({
            model: c.model,
            max_tokens: r.maxTokens,
            temperature: r.temperature ?? 0.1,
            messages: [
                { role: 'system', content: r.system },
                { role: 'user', content: r.user },
            ],
        }),
        parseResponse: (raw) => {
            const json = raw as {
                choices?: Array<{ message?: { content?: string } }>;
                usage?: { prompt_tokens: number; completion_tokens: number };
            };
            const text = json.choices?.[0]?.message?.content?.trim() ?? '';
            return {
                text,
                tokens: json.usage ? { input: json.usage.prompt_tokens, output: json.usage.completion_tokens } : null,
            };
        },
    };
}

const openAiSpec = openAiCompatSpec('openai', (c) => stripSlash(c.endpoint) + '/chat/completions');

/**
 * HuggingFace Router — https://router.huggingface.co/v1/chat/completions
 * OpenAI-compatible schema; auth is `Bearer <HF_TOKEN>`.
 * 503 is HF's cold-start signal — surface it explicitly so callers can retry.
 */
const huggingFaceSpec: ProviderSpec = {
    ...openAiCompatSpec('huggingface', (c) => {
        const base = stripSlash(c.endpoint);
        return base.endsWith('/chat/completions') ? base : base + '/chat/completions';
    }),
    formatError: (status, body) =>
        status === 503 ? `huggingface 503 cold-start (model is loading): ${body}` : null,
};

const ollamaSpec: ProviderSpec = {
    name: 'ollama',
    url: (c) => stripSlash(c.endpoint) + '/api/chat',
    headers: () => ({ 'content-type': 'application/json' }),
    buildBody: (c, r) => ({
        model: c.model,
        stream: false,
        options: { temperature: r.temperature ?? 0.1, num_predict: r.maxTokens },
        messages: [
            { role: 'system', content: r.system },
            { role: 'user', content: r.user },
        ],
    }),
    parseResponse: (raw) => {
        const json = raw as {
            message?: { content: string };
            prompt_eval_count?: number;
            eval_count?: number;
        };
        return {
            text: (json.message?.content ?? '').trim(),
            tokens:
                json.prompt_eval_count !== undefined && json.eval_count !== undefined
                    ? { input: json.prompt_eval_count, output: json.eval_count }
                    : null,
        };
    },
};

class SpecProvider implements Provider {
    constructor(public readonly creds: LlmCreds, private readonly spec: ProviderSpec) {}
    call(req: ProviderRequest): Promise<ProviderResponse> {
        return makeRequest(this.spec, this.creds, req);
    }
}

export function createProvider(creds: LlmCreds): Provider {
    switch (creds.backend) {
        case 'anthropic':
            return new SpecProvider(creds, anthropicSpec);
        case 'openai':
        case 'openrouter':
        case 'custom':
            return new SpecProvider(creds, openAiSpec);
        case 'huggingface':
            return new SpecProvider(creds, huggingFaceSpec);
        case 'ollama':
            return new SpecProvider(creds, ollamaSpec);
    }
}
