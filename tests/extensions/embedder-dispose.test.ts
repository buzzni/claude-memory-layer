import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_EMBEDDING_MODEL, Embedder } from '../../src/extensions/vector/embedder.js';

describe('Embedder disposal', () => {
  it('disposes the native pipeline and returns to an uninitialized state', async () => {
    const dispose = vi.fn(async () => undefined);
    const pipeline = Object.assign(
      async () => ({ data: new Float32Array([1]) }),
      { dispose }
    );
    const embedder = new Embedder();
    const state = embedder as unknown as {
      pipeline: typeof pipeline | null;
      initialized: boolean;
      activeModelName: string;
    };
    state.pipeline = pipeline;
    state.initialized = true;
    state.activeModelName = 'fallback/model';

    await embedder.dispose();

    expect(dispose).toHaveBeenCalledOnce();
    expect(embedder.isReady()).toBe(false);
    expect(embedder.getModelName()).toBe(DEFAULT_EMBEDDING_MODEL);
  });
});
