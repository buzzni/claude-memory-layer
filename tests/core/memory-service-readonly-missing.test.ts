import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getProjectStoragePath } from '../../src/core/registry/project-path.js';
import { getReadOnlyMemoryServiceForProject } from '../../src/services/memory-service.js';

describe('read-only MemoryService missing-store behavior', () => {
  it('returns an empty context reader without creating canonical project storage', async () => {
    const projectPath = mkdtempSync(path.join(tmpdir(), 'cml-readonly-missing-project-'));
    const storagePath = getProjectStoragePath(projectPath);
    try {
      expect(existsSync(storagePath)).toBe(false);
      const service = getReadOnlyMemoryServiceForProject(projectPath);
      await service.initialize();
      await expect(service.getRecentEvents(5)).resolves.toEqual([]);
      await expect(service.getSessionHistory('missing-session')).resolves.toEqual([]);
      await expect(service.retrieveMemories('missing project context', { topK: 5 })).resolves.toMatchObject({
        memories: [],
        outcomeDiagnostics: { outcomeReason: 'no_project_events' }
      });
      await service.shutdown();
      expect(existsSync(storagePath)).toBe(false);
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });
});
