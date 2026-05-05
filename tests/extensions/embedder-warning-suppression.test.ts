import { describe, expect, it, vi } from 'vitest';

import {
  isKnownBenignTransformersWarning,
  withSuppressedKnownTransformersWarnings
} from '../../src/extensions/vector/embedder.js';

describe('Embedder warning suppression', () => {
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
