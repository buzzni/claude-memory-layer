/**
 * Local Embedding Generator using @huggingface/transformers
 * AXIOMMIND Principle 7: Standard JSON format for vectors
 */

export interface EmbeddingResult {
  vector: number[];
  model: string;
  dimensions: number;
}

type FeatureExtractionPipelineFactory = (
  task: 'feature-extraction',
  model: string
) => Promise<NonNullable<Embedder['pipeline']>>;

export const DEFAULT_EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';
export const DEFAULT_EMBEDDING_FALLBACK_MODEL = 'intfloat/multilingual-e5-small';

export class Embedder {
  private pipeline: ((input: string, options?: Record<string, unknown>) => Promise<{ data: Float32Array }>) | null = null;
  private readonly modelName: string;
  private activeModelName: string;
  private initialized = false;

  constructor(modelName: string = DEFAULT_EMBEDDING_MODEL) {
    this.modelName = modelName;
    this.activeModelName = modelName;
  }

  /**
   * Initialize the embedding pipeline
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const pipeline = await withSuppressedKnownTransformersWarnings(async () => {
      try {
        return await loadTransformersPipeline();
      } catch (error) {
        if (isMissingTransformersDependencyError(error)) {
          throw createEmbeddingBackendUnavailableError(error);
        }
        throw error;
      }
    });

    try {
      this.pipeline = await withSuppressedKnownTransformersWarnings(() => pipeline('feature-extraction', this.modelName));
      this.activeModelName = this.modelName;
      this.initialized = true;
      return;
    } catch (primaryError) {
      const fallbackModel = process.env.CLAUDE_MEMORY_EMBEDDING_FALLBACK_MODEL || DEFAULT_EMBEDDING_FALLBACK_MODEL;
      if (fallbackModel === this.modelName) {
        throw primaryError;
      }

      console.warn(`[Embedder] Primary model failed (${this.modelName}). Falling back to ${fallbackModel}`);
      this.pipeline = await withSuppressedKnownTransformersWarnings(() => pipeline('feature-extraction', fallbackModel));
      this.activeModelName = fallbackModel;
      this.initialized = true;
    }
  }

  // ~4 chars per token; 512 tokens * 4 = 2048, use 2000 to be safe
  private static readonly MAX_CHARS = 2000;

  private truncate(text: string): string {
    return text.length > Embedder.MAX_CHARS ? text.slice(0, Embedder.MAX_CHARS) : text;
  }

  /**
   * Generate embedding for a single text
   */
  async embed(text: string): Promise<EmbeddingResult> {
    await this.initialize();

    if (!this.pipeline) {
      throw new Error('Embedding pipeline not initialized');
    }

    const output = await this.pipeline(this.truncate(text), {
      pooling: 'mean',
      normalize: true,
      truncation: true,
      max_length: 512
    });

    const vector = Array.from(output.data);

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
        const output = await this.pipeline(this.truncate(text), {
          pooling: 'mean',
          normalize: true,
          truncation: true,
          max_length: 512
        });

        const vector = Array.from(output.data);

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

let transformersWarningSuppressionDepth = 0;
let originalConsoleWarn: typeof console.warn | null = null;

export async function withSuppressedKnownTransformersWarnings<T>(fn: () => Promise<T>): Promise<T> {
  if (transformersWarningSuppressionDepth === 0) {
    originalConsoleWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const message = args.map(String).join(' ');
      if (isKnownBenignTransformersWarning(message)) return;
      (originalConsoleWarn ?? console.warn)(...args);
    };
  }
  transformersWarningSuppressionDepth += 1;

  try {
    return await fn();
  } finally {
    transformersWarningSuppressionDepth -= 1;
    if (transformersWarningSuppressionDepth === 0 && originalConsoleWarn) {
      console.warn = originalConsoleWarn;
      originalConsoleWarn = null;
    }
  }
}

export function isKnownBenignTransformersWarning(message: string): boolean {
  return message.includes('Unknown model class "eurobert"') ||
    message.includes('dtype not specified for "model"');
}

export function isMissingTransformersDependencyError(error: unknown): boolean {
  const maybeError = error as { code?: unknown; message?: unknown } | null;
  const message = typeof maybeError?.message === 'string' ? maybeError.message : '';
  return maybeError?.code === 'ERR_MODULE_NOT_FOUND' &&
    message.includes("@huggingface/transformers");
}

export function createEmbeddingBackendUnavailableError(cause: unknown): Error & { cause?: unknown } {
  const error = new Error(
    [
      'Required embedding backend is not installed.',
      '',
      'Claude Memory Layer requires @huggingface/transformers for local semantic/vector embeddings.',
      'The backend runs on CPU-only ONNX Runtime; CUDA is not required.',
      'Reinstall globally with:',
      '  ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install -g claude-memory-layer@latest',
      '',
      'If you are inside a local checkout or package directory, repair only the backend with:',
      '  ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install --no-save --no-package-lock --omit=dev @huggingface/transformers@3.8.1'
    ].join('\n')
  ) as Error & { cause?: unknown };
  error.cause = cause;
  return error;
}

async function loadTransformersPipeline(): Promise<FeatureExtractionPipelineFactory> {
  // Keep @huggingface/transformers lazy so importing MemoryService or pure
  // adapter helpers does not eagerly dlopen onnxruntime native bindings.
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string
  ) => Promise<{ pipeline: unknown }>;
  const transformers = await dynamicImport('@huggingface/transformers');
  return transformers.pipeline as FeatureExtractionPipelineFactory;
}
