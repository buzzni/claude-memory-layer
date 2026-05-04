import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  createSharedMemoryServices as createFromExtension,
  SharedMemoryServices as SharedMemoryServicesFromExtension
} from '../../src/extensions/shared-memory/index.js';
import {
  createSharedMemoryServices as createFromCompat,
  SharedMemoryServices as SharedMemoryServicesFromCompat
} from '../../src/core/engine/shared-memory-services.js';

describe('shared-memory extension boundary', () => {
  it('keeps shared memory implementation under extensions with an engine compatibility re-export', () => {
    const compatSource = readFileSync('src/core/engine/shared-memory-services.ts', 'utf8');
    const implementationSource = readFileSync('src/extensions/shared-memory/shared-memory-services.ts', 'utf8');

    expect(createFromCompat).toBe(createFromExtension);
    expect(SharedMemoryServicesFromCompat).toBe(SharedMemoryServicesFromExtension);
    expect(compatSource).toContain("../../extensions/shared-memory/index.js");
    expect(implementationSource).not.toContain("../../core/embedder.js");
    expect(implementationSource).toContain("../vector/index.js");
  });
});
