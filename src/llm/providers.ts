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

class AnthropicProvider implements Provider {
    constructor(public readonly creds: LlmCreds) {}
    async call(req: ProviderRequest): Promise<ProviderResponse> {
        const url = this.creds.endpoint.replace(/\/$/, '') + '/v1/messages';
        const body = {
            model: this.creds.model,
            max_tokens: req.maxTokens,
            temperature: req.temperature ?? 0.1,
            system: req.system,
            messages: [{ role: 'user', content: req.user }],
        };
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': this.creds.apiKey ?? '',
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
        const json = (await res.json()) as {
            content?: Array<{ type: string; text: string }>;
            usage?: { input_tokens: number; output_tokens: number };
        };
        const text = (json.content ?? []).map(c => (c.type === 'text' ? c.text : '')).join('').trim();
        return {
            text,
            tokens: json.usage ? { input: json.usage.input_tokens, output: json.usage.output_tokens } : null,
        };
    }
}

class OpenAIProvider implements Provider {
    constructor(public readonly creds: LlmCreds) {}
    async call(req: ProviderRequest): Promise<ProviderResponse> {
        const url = this.creds.endpoint.replace(/\/$/, '') + '/chat/completions';
        const body = {
            model: this.creds.model,
            max_tokens: req.maxTokens,
            temperature: req.temperature ?? 0.1,
            messages: [
                { role: 'system', content: req.system },
                { role: 'user', content: req.user },
            ],
        };
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${this.creds.apiKey ?? ''}`,
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
        const json = (await res.json()) as {
            choices: Array<{ message: { content: string } }>;
            usage?: { prompt_tokens: number; completion_tokens: number };
        };
        const text = json.choices[0]?.message?.content?.trim() ?? '';
        return {
            text,
            tokens: json.usage ? { input: json.usage.prompt_tokens, output: json.usage.completion_tokens } : null,
        };
    }
}

/**
 * HuggingFace Router — https://router.huggingface.co/v1/chat/completions
 * OpenAI-compatible schema; auth is `Bearer <HF_TOKEN>`.
 * The serverless inference endpoint (api-inference.huggingface.co/models/...)
 * uses a different schema and is not handled here — users who want it can
 * pick the "custom" backend.
 */
class HuggingFaceProvider implements Provider {
    constructor(public readonly creds: LlmCreds) {}
    async call(req: ProviderRequest): Promise<ProviderResponse> {
        // Normalise endpoint: strip trailing slash; add /chat/completions if not present.
        const base = this.creds.endpoint.replace(/\/$/, '');
        const url = base.endsWith('/chat/completions') ? base : base + '/chat/completions';
        const body = {
            model: this.creds.model,
            max_tokens: req.maxTokens,
            temperature: req.temperature ?? 0.1,
            messages: [
                { role: 'system', content: req.system },
                { role: 'user', content: req.user },
            ],
        };
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${this.creds.apiKey ?? ''}`,
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const txt = await res.text();
            // 503 is HF's cold-start signal; surface it explicitly so callers can retry.
            if (res.status === 503) {
                throw new Error(`huggingface 503 cold-start (model is loading): ${txt}`);
            }
            throw new Error(`huggingface ${res.status}: ${txt}`);
        }
        const json = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
            usage?: { prompt_tokens: number; completion_tokens: number };
        };
        const text = json.choices?.[0]?.message?.content?.trim() ?? '';
        return {
            text,
            tokens: json.usage ? { input: json.usage.prompt_tokens, output: json.usage.completion_tokens } : null,
        };
    }
}

class OllamaProvider implements Provider {
    constructor(public readonly creds: LlmCreds) {}
    async call(req: ProviderRequest): Promise<ProviderResponse> {
        const url = this.creds.endpoint.replace(/\/$/, '') + '/api/chat';
        const body = {
            model: this.creds.model,
            stream: false,
            options: { temperature: req.temperature ?? 0.1, num_predict: req.maxTokens },
            messages: [
                { role: 'system', content: req.system },
                { role: 'user', content: req.user },
            ],
        };
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
        const json = (await res.json()) as {
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
    }
}

export function createProvider(creds: LlmCreds): Provider {
    switch (creds.backend) {
        case 'anthropic':
            return new AnthropicProvider(creds);
        case 'openai':
        case 'openrouter':
        case 'custom':
            return new OpenAIProvider(creds);
        case 'huggingface':
            return new HuggingFaceProvider(creds);
        case 'ollama':
            return new OllamaProvider(creds);
    }
}
