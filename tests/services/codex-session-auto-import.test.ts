import { describe, expect, it, vi } from 'vitest';

import { importCodexSessionAtEnd } from '../../src/services/codex-session-auto-import.js';
import type { ImportResult } from '../../src/services/session-history-importer.js';

function result(): ImportResult {
  return {
    totalSessions: 1,
    totalMessages: 4,
    importedPrompts: 1,
    importedResponses: 1,
    skippedDuplicates: 0,
    errors: []
  };
}

describe('Codex session automatic import', () => {
  it('imports only the completed transcript into its project store without embedding in the hook worker', async () => {
    const memoryService = {
      initialize: vi.fn(async () => undefined),
      ensureEmbeddingModelForImport: vi.fn(async () => ({ changed: false })),
      shutdown: vi.fn(async () => undefined)
    };
    const importer = {
      importSessionFile: vi.fn(async () => result())
    };
    const getMemoryServiceForProject = vi.fn(() => memoryService);
    const createImporter = vi.fn(() => importer);
    const writeStatus = vi.fn();

    const outcome = await importCodexSessionAtEnd({
      transcriptPath: '/tmp/codex/rollout.jsonl',
      projectPath: '/repo/project'
    }, {
      getMemoryServiceForProject: getMemoryServiceForProject as never,
      createImporter: createImporter as never,
      statTranscript: () => ({ isFile: () => true }),
      writeStatus
    });

    expect(getMemoryServiceForProject).toHaveBeenCalledWith('/repo/project');
    expect(memoryService.initialize).toHaveBeenCalledTimes(1);
    expect(memoryService.ensureEmbeddingModelForImport).toHaveBeenCalledWith({ autoMigrate: true });
    expect(importer.importSessionFile).toHaveBeenCalledWith('/tmp/codex/rollout.jsonl', {
      projectPath: '/repo/project'
    });
    expect(memoryService.shutdown).toHaveBeenCalledTimes(1);
    expect(writeStatus).toHaveBeenCalledWith('/repo/project', expect.objectContaining({
      status: 'success',
      importedPrompts: 1,
      importedResponses: 1
    }));
    expect(outcome.result.importedResponses).toBe(1);
  });

  it('always closes the project service when import fails', async () => {
    const memoryService = {
      initialize: vi.fn(async () => undefined),
      ensureEmbeddingModelForImport: vi.fn(async () => ({ changed: false })),
      shutdown: vi.fn(async () => undefined)
    };
    const importer = {
      importSessionFile: vi.fn(async () => { throw new Error('broken transcript'); })
    };
    const writeStatus = vi.fn();

    await expect(importCodexSessionAtEnd({
      transcriptPath: '/tmp/codex/rollout.jsonl',
      projectPath: '/repo/project'
    }, {
      getMemoryServiceForProject: (() => memoryService) as never,
      createImporter: (() => importer) as never,
      statTranscript: () => ({ isFile: () => true }),
      writeStatus
    })).rejects.toThrow('broken transcript');

    expect(memoryService.shutdown).toHaveBeenCalledTimes(1);
    expect(writeStatus).toHaveBeenCalledWith('/repo/project', expect.objectContaining({
      status: 'failed',
      error: 'broken transcript'
    }));
  });

  it('does not initialize project storage when the transcript is missing', async () => {
    const getMemoryServiceForProject = vi.fn();
    const writeStatus = vi.fn();

    await expect(importCodexSessionAtEnd({
      transcriptPath: '/tmp/codex/missing.jsonl',
      projectPath: '/repo/project'
    }, {
      getMemoryServiceForProject: getMemoryServiceForProject as never,
      createImporter: vi.fn() as never,
      statTranscript: () => { throw new Error('ENOENT'); },
      writeStatus
    })).rejects.toThrow('transcript does not exist');

    expect(getMemoryServiceForProject).not.toHaveBeenCalled();
    expect(writeStatus).toHaveBeenCalledWith('/repo/project', expect.objectContaining({ status: 'failed' }));
  });

  it('treats importer error results as failed automatic imports', async () => {
    const memoryService = {
      initialize: vi.fn(async () => undefined),
      ensureEmbeddingModelForImport: vi.fn(async () => ({ changed: false })),
      shutdown: vi.fn(async () => undefined)
    };
    const writeStatus = vi.fn();

    await expect(importCodexSessionAtEnd({
      transcriptPath: '/tmp/codex/rollout.jsonl',
      projectPath: '/repo/project'
    }, {
      getMemoryServiceForProject: (() => memoryService) as never,
      createImporter: (() => ({ importSessionFile: async () => resultWithErrors() })) as never,
      statTranscript: () => ({ isFile: () => true }),
      writeStatus
    })).rejects.toThrow('reported 1 error');

    expect(writeStatus).toHaveBeenCalledWith('/repo/project', expect.objectContaining({ status: 'failed' }));
    expect(memoryService.shutdown).toHaveBeenCalledTimes(1);
  });
});

function resultWithErrors(): ImportResult {
  return { ...result(), errors: ['parse failure'] };
}
