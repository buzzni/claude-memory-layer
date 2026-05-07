import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_EMBEDDING_MODEL,
  Embedder,
  createEmbeddingBackendUnavailableError,
  isKnownBenignTransformersWarning,
  isMissingTransformersDependencyError,
  withSuppressedKnownTransformersWarnings
} from '../../src/extensions/vector/embedder.js';
import { ConfigSchema } from '../../src/core/types.js';

describe('Embedder warning suppression', () => {
  it('uses a CPU-friendly multilingual Korean-capable default embedding model', () => {
    expect(DEFAULT_EMBEDDING_MODEL).toBe('Xenova/multilingual-e5-small');
    expect(new Embedder().getModelName()).toBe(DEFAULT_EMBEDDING_MODEL);

    const parsedConfig = ConfigSchema.parse({});
    expect(parsedConfig.embedding.model).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(parsedConfig.embedding.openaiModel).toBe(DEFAULT_EMBEDDING_MODEL);
  });

  it('turns missing optional @huggingface/transformers errors into actionable install guidance', () => {
    const missingBackendError = Object.assign(
      new Error("Cannot find package '@huggingface/transformers' imported from /tmp/dist/cli/index.js"),
      { code: 'ERR_MODULE_NOT_FOUND' }
    );

    expect(isMissingTransformersDependencyError(missingBackendError)).toBe(true);
    expect(isMissingTransformersDependencyError(new Error('network failure'))).toBe(false);

    const friendly = createEmbeddingBackendUnavailableError(missingBackendError);
    expect(friendly.message).toContain('Optional embedding backend is not installed');
    expect(friendly.message).toContain('ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install -g claude-memory-layer@latest');
    expect(friendly.message).toContain('ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install --no-save --no-package-lock --omit=dev @huggingface/transformers@3.8.1');
    expect(friendly.cause).toBe(missingBackendError);
  });

  it('recognizes known benign transformer warnings', () => {
    expect(isKnownBenignTransformersWarning('Unknown model class "eurobert", attempting to construct from base class.')).toBe(true);
    expect(isKnownBenignTransformersWarning('dtype not specified for "model". Using the default dtype (fp32).')).toBe(true);
    expect(isKnownBenignTransformersWarning('serious model load failure')).toBe(false);
  });

  it('suppresses known transformer warnings but keeps unrelated warnings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await withSuppressedKnownTransformersWarnings(async () => {
      console.warn('Unknown model class "eurobert", attempting to construct from base class.');
      console.warn('dtype not specified for "model". Using the default dtype (fp32).');
      console.warn('serious model load failure');
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('serious model load failure');
    warn.mockRestore();
  });

  it('restores console.warn only after overlapping suppressions complete', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const originalWarn = console.warn;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;

    const first = withSuppressedKnownTransformersWarnings(async () => {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    });
    const suppressedWarn = console.warn;
    const second = withSuppressedKnownTransformersWarnings(async () => {
      await new Promise<void>((resolve) => { releaseSecond = resolve; });
    });

    expect(console.warn).toBe(suppressedWarn);
    releaseFirst();
    await first;
    expect(console.warn).toBe(suppressedWarn);

    releaseSecond();
    await second;
    expect(console.warn).toBe(originalWarn);
    warn.mockRestore();
  });
});
