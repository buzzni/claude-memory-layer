/**
 * Local Embedding Generator using @xenova/transformers
 * AXIOMMIND Principle 7: Standard JSON format for vectors
 */

import { pipeline, Pipeline } from '@xenova/transformers';

export interface EmbeddingResult {
  vector: number[];
  model: string;
  dimensions: number;
}

export class Embedder {
  private pipeline: Pipeline | null = null;
  private readonly modelName: string;
  private activeModelName: string;
  private initialized = false;

  constructor(modelName: string = 'jinaai/jina-embeddings-v5-text-nano-text-matching') {
    this.modelName = modelName;
    this.activeModelName = modelName;
  }

  /**
   * Initialize the embedding pipeline
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      this.pipeline = await pipeline('feature-extraction', this.modelName);
      this.activeModelName = this.modelName;
      this.initialized = true;
      return;
    } catch (primaryError) {
      const fallbackModel = process.env.CLAUDE_MEMORY_EMBEDDING_FALLBACK_MODEL || 'onnx-community/embeddinggemma-300m-ONNX';
      if (fallbackModel === this.modelName) {
        throw primaryError;
      }

      console.warn(`[Embedder] Primary model failed (${this.modelName}). Falling back to ${fallbackModel}`);
      this.pipeline = await pipeline('feature-extraction', fallbackModel);
      this.activeModelName = fallbackModel;
      this.initialized = true;
    }
  }

  /**
   * Generate embedding for a single text
   */
  async embed(text: string): Promise<EmbeddingResult> {
    await this.initialize();

    if (!this.pipeline) {
      throw new Error('Embedding pipeline not initialized');
    }

    const output = await this.pipeline(text, {
      pooling: 'mean',
      normalize: true
    });

    const vector = Array.from(output.data as Float32Array);

    return {
      vector,
      model: this.activeModelName,
      dimensions: vector.length
    };
  }

  /**
   * Generate embeddings for multiple texts in batch
   */
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    await this.initialize();

    if (!this.pipeline) {
      throw new Error('Embedding pipeline not initialized');
    }

    const results: EmbeddingResult[] = [];

    // Process in batches of 32 for memory efficiency
    const batchSize = 32;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);

      for (const text of batch) {
        const output = await this.pipeline(text, {
          pooling: 'mean',
          normalize: true
        });

        const vector = Array.from(output.data as Float32Array);

        results.push({
          vector,
          model: this.activeModelName,
          dimensions: vector.length
        });
      }
    }

    return results;
  }

  /**
   * Get embedding dimensions for the current model
   */
  async getDimensions(): Promise<number> {
    const result = await this.embed('test');
    return result.dimensions;
  }

  /**
   * Check if embedder is ready
   */
  isReady(): boolean {
    return this.initialized && this.pipeline !== null;
  }

  /**
   * Get model name
   */
  getModelName(): string {
    return this.activeModelName;
  }
}

// Singleton instance for reuse
let defaultEmbedder: Embedder | null = null;

export function getDefaultEmbedder(): Embedder {
  const envModel = process.env.CLAUDE_MEMORY_EMBEDDING_MODEL;
  if (!defaultEmbedder) {
    defaultEmbedder = new Embedder(envModel || undefined);
  }
  return defaultEmbedder;
}
