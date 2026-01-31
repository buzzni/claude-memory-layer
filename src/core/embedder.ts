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
  private initialized = false;

  constructor(modelName: string = 'Xenova/all-MiniLM-L6-v2') {
    this.modelName = modelName;
  }

  /**
   * Initialize the embedding pipeline
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.pipeline = await pipeline('feature-extraction', this.modelName);
    this.initialized = true;
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
      model: this.modelName,
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
          model: this.modelName,
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
    return this.modelName;
  }
}

// Singleton instance for reuse
let defaultEmbedder: Embedder | null = null;

export function getDefaultEmbedder(): Embedder {
  if (!defaultEmbedder) {
    defaultEmbedder = new Embedder();
  }
  return defaultEmbedder;
}
