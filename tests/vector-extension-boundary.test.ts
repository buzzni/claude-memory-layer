import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  Embedder as EmbedderFromExtension,
  getDefaultEmbedder as getDefaultEmbedderFromExtension
} from '../src/extensions/vector/index.js';
import {
  Embedder as EmbedderFromCompat,
  getDefaultEmbedder as getDefaultEmbedderFromCompat
} from '../src/core/embedder.js';

describe('vector extension boundary', () => {
  it('keeps Embedder implementation under extensions with a core compatibility re-export', () => {
    const compatSource = readFileSync('src/core/embedder.ts', 'utf8');

    expect(EmbedderFromCompat).toBe(EmbedderFromExtension);
    expect(getDefaultEmbedderFromCompat).toBe(getDefaultEmbedderFromExtension);
    expect(compatSource).toContain("../extensions/vector/index.js");
  });
});
