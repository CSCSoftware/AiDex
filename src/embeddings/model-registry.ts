/**
 * Embedding model registry — known models and their parameters.
 *
 * Keeping the registry in one place makes model migration explicit:
 * if a model changes, bump its `version` so existing embeddings get
 * detected as stale and can be re-indexed.
 */

export interface EmbeddingModel {
    id: string;
    huggingfaceId: string;
    dim: number;
    version: number;
    description: string;
    license: string;
}

export const MODEL_REGISTRY: Record<string, EmbeddingModel> = {
    'jina-code': {
        id: 'jina-code',
        huggingfaceId: 'jinaai/jina-embeddings-v2-base-code',
        dim: 768,
        version: 1,
        description: 'Code-specialized, trained on 30 programming languages. Best default for AiDex.',
        license: 'Apache-2.0',
    },
    'nomic-text': {
        id: 'nomic-text',
        huggingfaceId: 'nomic-ai/nomic-embed-text-v1.5',
        dim: 768,
        version: 1,
        description: 'General-purpose text embeddings with Matryoshka dimension truncation support.',
        license: 'Apache-2.0',
    },
    'bge-small': {
        id: 'bge-small',
        huggingfaceId: 'BAAI/bge-small-en-v1.5',
        dim: 384,
        version: 1,
        description: 'Compact and fast English text embeddings.',
        license: 'MIT',
    },
};

export const DEFAULT_MODEL_ID = 'jina-code';

export function getModel(id: string): EmbeddingModel {
    const m = MODEL_REGISTRY[id];
    if (!m) {
        const known = Object.keys(MODEL_REGISTRY).join(', ');
        throw new Error(`Unknown embedding model "${id}". Known: ${known}`);
    }
    return m;
}

export function listModels(): EmbeddingModel[] {
    return Object.values(MODEL_REGISTRY);
}
