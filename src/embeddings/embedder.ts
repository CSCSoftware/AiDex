/**
 * Embedder — wraps Transformers.js to produce sentence embeddings.
 *
 * Loads the model lazily via dynamic import so AiDex starts identically
 * fast for users that never enable embeddings.
 */

import { homedir } from 'os';
import { join } from 'path';

import type { EmbeddingModel } from './model-registry.js';

export interface Embedder {
    readonly model: EmbeddingModel;
    /** Embed a batch of texts. Returns one Float32Array per input (length = model.dim). */
    embed(texts: string[]): Promise<Float32Array[]>;
    /** Free model resources. */
    dispose(): Promise<void>;
}

interface TxPipeline {
    (texts: string[], opts: { pooling: 'mean'; normalize: boolean }): Promise<{
        data: Float32Array;
        dims: number[];
    }>;
}

class TransformersEmbedder implements Embedder {
    constructor(public readonly model: EmbeddingModel, private readonly pipe: TxPipeline) {}

    async embed(texts: string[]): Promise<Float32Array[]> {
        if (texts.length === 0) return [];
        const out = await this.pipe(texts, { pooling: 'mean', normalize: true });
        const dim = this.model.dim;
        const result: Float32Array[] = [];
        for (let i = 0; i < texts.length; i++) {
            // out.data is a flat Float32Array of shape [batch, dim]
            const slice = out.data.slice(i * dim, (i + 1) * dim);
            result.push(new Float32Array(slice));
        }
        return result;
    }

    async dispose(): Promise<void> {
        // Transformers.js does not currently expose explicit disposal;
        // GC handles it once the pipeline reference is dropped.
    }
}

export async function createEmbedder(model: EmbeddingModel): Promise<Embedder> {
    let transformers: any;
    try {
        transformers = await import('@xenova/transformers');
    } catch (err) {
        throw new Error(
            `@xenova/transformers is not installed. Run: npm install --save-optional @xenova/transformers`
        );
    }

    // Cache models under ~/.aidex/models so they survive npm reinstalls
    transformers.env.cacheDir = join(homedir(), '.aidex', 'models');
    transformers.env.allowLocalModels = true;

    const pipe = (await transformers.pipeline('feature-extraction', model.huggingfaceId, {
        // ONNX quantized weights are smaller and accurate enough for retrieval.
        quantized: true,
    })) as TxPipeline;

    return new TransformersEmbedder(model, pipe);
}
