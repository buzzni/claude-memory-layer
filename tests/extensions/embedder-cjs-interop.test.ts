import { describe, expect, it } from 'vitest';
import { normalizeTransformersNamespace } from '../../src/extensions/vector/embedder.js';

const pipeline = () => Promise.resolve({ data: new Float32Array() });

describe('normalizeTransformersNamespace (CJS interop)', () => {
  it('returns the namespace as-is when pipeline is a top-level named export (ESM entry)', () => {
    const ns = { pipeline, env: { cacheDir: '/cache' } };
    expect(normalizeTransformersNamespace(ns)).toBe(ns);
  });

  it('unwraps default when the CJS entry hides pipeline under it (transformers.node.cjs)', () => {
    const inner = { pipeline, env: { cacheDir: '/cache' } };
    const ns = { pipeline: undefined, default: inner };
    expect(normalizeTransformersNamespace(ns)).toBe(inner);
  });

  it('keeps the namespace when neither level has a callable pipeline (missing-dependency case)', () => {
    const ns = { pipeline: undefined, default: { pipeline: undefined } };
    expect(normalizeTransformersNamespace(ns)).toBe(ns);
  });
});
