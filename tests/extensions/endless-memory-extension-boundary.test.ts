import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { createEndlessMemoryServices as createFromExtension } from '../../src/extensions/endless-memory/index.js';
import { createEndlessMemoryServices as createFromCompat } from '../../src/core/engine/endless-memory-services.js';

describe('endless-memory extension boundary', () => {
  it('keeps endless memory implementation under extensions with an engine compatibility re-export', () => {
    const compatSource = readFileSync('src/core/engine/endless-memory-services.ts', 'utf8');
    const memoryServiceSource = readFileSync('src/services/memory-service.ts', 'utf8');

    expect(createFromCompat).toBe(createFromExtension);
    expect(compatSource).toContain("../../extensions/endless-memory/index.js");
    expect(memoryServiceSource).not.toContain("../core/engine/endless-memory-services.js");
    expect(memoryServiceSource).toContain("../extensions/endless-memory/index.js");
  });
});
