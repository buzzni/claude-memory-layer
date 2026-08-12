/**
 * Local Embedding Generator using @huggingface/transformers
 * AXIOMMIND Principle 7: Standard JSON format for vectors
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire as createNodeRequire } from 'node:module';
import { dirname as pathDirname, join, parse } from 'node:path';
import { fileURLToPath as urlToFilePath, pathToFileURL } from 'node:url';

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
const MANAGED_EMBEDDING_BACKEND_DIR = '.claude-memory-layer-embedding-backend';

export class Embedder {
  private pipeline: (((input: string, options?: Record<string, unknown>) => Promise<{ data: Float32Array }>) & {
    dispose?: () => void | Promise<void>;
  }) | null = null;
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
      this.pipeline = await this.loadPipelineWithCorruptionRecovery(pipeline, this.modelName);
      this.activeModelName = this.modelName;
      this.initialized = true;
      return;
    } catch (primaryError) {
      const fallbackModel = process.env.CLAUDE_MEMORY_EMBEDDING_FALLBACK_MODEL || DEFAULT_EMBEDDING_FALLBACK_MODEL;
      if (fallbackModel === this.modelName) {
        throw primaryError;
      }

      console.warn(`[Embedder] Primary model failed (${this.modelName}). Falling back to ${fallbackModel}`);
      this.pipeline = await this.loadPipelineWithCorruptionRecovery(pipeline, fallbackModel);
      this.activeModelName = fallbackModel;
      this.initialized = true;
    }
  }

  /**
   * Load a model, self-healing a truncated/corrupted cache.
   *
   * @huggingface/transformers only checks whether a cached file *exists*
   * before skipping the download, not whether it is valid. A download
   * interrupted mid-write (killed process, lost connection) leaves a file
   * that exists but fails ONNX parsing — every future load hits the same
   * error forever, since nothing ever re-downloads it. This was observed on
   * a real machine after a global npm install: two ~450MB files, sizes not
   * matching the known-good ~470MB build, failing with
   * "Load model from <path> failed:Protobuf parsing failed." on every
   * attempt. Detecting that shape, clearing the specific model's cache
   * directory, and retrying once converts a permanently stuck install into
   * one that repairs itself on the next start.
   */
  private async loadPipelineWithCorruptionRecovery(
    pipeline: FeatureExtractionPipelineFactory,
    modelName: string
  ): Promise<NonNullable<Embedder['pipeline']>> {
    try {
      return await withSuppressedKnownTransformersWarnings(() => pipeline('feature-extraction', modelName));
    } catch (error) {
      if (!isCorruptedModelCacheError(error)) throw error;

      const cleared = await clearModelCacheDirectory(modelName);
      if (!cleared) throw error;

      console.warn(`[Embedder] Detected a corrupted cache for ${modelName}; cleared it and retrying.`);
      return await withSuppressedKnownTransformersWarnings(() => pipeline('feature-extraction', modelName));
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

  /** Release the native ONNX model so a long-lived but idle MCP process does not retain it. */
  async dispose(): Promise<void> {
    const pipeline = this.pipeline;
    this.pipeline = null;
    this.initialized = false;
    this.activeModelName = this.modelName;
    await pipeline?.dispose?.();
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

export async function disposeDefaultEmbedder(): Promise<void> {
  const embedder = defaultEmbedder;
  defaultEmbedder = null;
  await embedder?.dispose();
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
      '  ONNXRUNTIME_NODE_INSTALL_CUDA=skip node scripts/postinstall-embedding-backend.cjs'
    ].join('\n')
  ) as Error & { cause?: unknown };
  error.cause = cause;
  return error;
}

function findPackageRoot(startUrl: string = import.meta.url): string | undefined {
  let currentDir = pathDirname(urlToFilePath(startUrl));
  const filesystemRoot = parse(currentDir).root;

  while (currentDir !== filesystemRoot) {
    const manifestPath = join(currentDir, 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string };
        if (manifest.name === 'claude-memory-layer') return currentDir;
      } catch {
        // Continue upward when an unrelated package manifest is unreadable.
      }
    }
    currentDir = pathDirname(currentDir);
  }

  return undefined;
}

export function resolveTransformersModuleSpecifier(
  packageRoot: string | undefined = findPackageRoot()
): string {
  if (!packageRoot) return '@huggingface/transformers';

  const backendRoot = join(packageRoot, 'node_modules', MANAGED_EMBEDDING_BACKEND_DIR);
  const backendManifest = join(backendRoot, 'package.json');
  if (!existsSync(backendManifest)) return '@huggingface/transformers';

  try {
    const backendRequire = createNodeRequire(pathToFileURL(backendManifest));
    return pathToFileURL(backendRequire.resolve('@huggingface/transformers')).href;
  } catch {
    return '@huggingface/transformers';
  }
}

interface TransformersModuleLike {
  pipeline: unknown;
  env?: { cacheDir?: string };
  default?: TransformersModuleLike;
}

/**
 * CJS interop: the managed-backend specifier is resolved with require
 * semantics, which picks transformers' `require` condition
 * (dist/transformers.node.cjs). `import()` of that CJS file exposes the real
 * exports under `default` when cjs-module-lexer cannot lex them as named
 * exports — leaving `namespace.pipeline` undefined ("pipeline is not a
 * function" at embed time). Unwrap `default` whenever it, not the namespace,
 * carries the pipeline.
 */
export function normalizeTransformersNamespace(namespace: TransformersModuleLike): TransformersModuleLike {
  if (typeof namespace.pipeline === 'function') return namespace;
  if (namespace.default && typeof namespace.default.pipeline === 'function') return namespace.default;
  return namespace;
}

async function loadTransformersModule(): Promise<TransformersModuleLike> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string
  ) => Promise<TransformersModuleLike>;
  return normalizeTransformersNamespace(await dynamicImport(resolveTransformersModuleSpecifier()));
}

async function loadTransformersPipeline(): Promise<FeatureExtractionPipelineFactory> {
  // Keep @huggingface/transformers lazy so importing MemoryService or pure
  // adapter helpers does not eagerly dlopen onnxruntime native bindings.
  const transformers = await loadTransformersModule();
  return transformers.pipeline as FeatureExtractionPipelineFactory;
}

/**
 * Matches ONNX Runtime's model-load failure text, which is how a truncated
 * download surfaces: the file exists (so nothing re-downloads it) but is not
 * a valid protobuf. Intentionally narrow — only errors that name onnx/protobuf
 * loading are treated as a corrupted cache; a model that is merely missing or
 * a network failure during download should surface as-is.
 */
export function isCorruptedModelCacheError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /load model from .*failed/i.test(message)
    || /protobuf parsing failed/i.test(message)
    || /invalid[_ ]protobuf/i.test(message)
    || /onnxruntime[^a-z]*error/i.test(message);
}

async function resolveTransformersCacheDir(): Promise<string | undefined> {
  const transformers = await loadTransformersModule();
  return transformers.env?.cacheDir;
}

/**
 * Delete a model's cache directory so the library re-downloads it from
 * scratch. Returns false (not true-with-no-op) when the cache directory
 * cannot even be determined, so the caller knows recovery was not actually
 * attempted and should surface the original error instead of retrying
 * against the same corrupted files.
 *
 * `cacheDir` is injectable so tests can exercise the path-safety logic
 * directly: the production caller (below) resolves it via an indirect
 * dynamic import of @huggingface/transformers, which — like the rest of this
 * file's lazy loading — does not share module state with a bundler/test
 * runner's own transformed import of the same package.
 */
export async function clearModelCacheDirectory(
  modelName: string,
  cacheDir?: string
): Promise<boolean> {
  try {
    const resolvedCacheDirInput = cacheDir ?? await resolveTransformersCacheDir();
    if (!resolvedCacheDirInput) return false;

    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const modelDir = path.join(resolvedCacheDirInput, modelName);

    // Guard against a misconfigured cacheDir turning this into `rm -rf` of
    // something unrelated: only remove a path that actually resolves inside
    // the resolved cache directory.
    const resolvedCacheDir = path.resolve(resolvedCacheDirInput);
    const resolvedModelDir = path.resolve(modelDir);
    if (!resolvedModelDir.startsWith(resolvedCacheDir + path.sep)) return false;

    await fs.rm(resolvedModelDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
