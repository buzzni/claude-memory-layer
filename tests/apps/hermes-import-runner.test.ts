import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportResult } from '../../src/services/session-history-importer.js';

const { runHermesImportOnce } = await import('../../src/apps/cli/hermes-import-runner.js');

function makeImportResult(overrides: Partial<ImportResult> = {}): ImportResult {
  return {
    totalSessions: 1,
    totalMessages: 2,
    importedPrompts: 1,
    importedResponses: 1,
    skippedDuplicates: 0,
    errors: [],
    ...overrides
  };
}

function makeService() {
  return {
    initialize: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    processPendingEmbeddings: vi.fn(async () => 2),
    ensureEmbeddingModelForImport: vi.fn(async () => ({ changed: false, previousModel: null, currentModel: 'test', enqueued: 0 }))
  };
}

describe('Hermes import runner', () => {
  let projectService: ReturnType<typeof makeService>;
  let globalService: ReturnType<typeof makeService>;
  let importer: {
    importProject: ReturnType<typeof vi.fn>;
    importAll: ReturnType<typeof vi.fn>;
    importSession: ReturnType<typeof vi.fn>;
  };
  let deps: Parameters<typeof runHermesImportOnce>[1];

  beforeEach(() => {
    projectService = makeService();
    globalService = makeService();
    importer = {
      importProject: vi.fn(async () => makeImportResult()),
      importAll: vi.fn(async () => makeImportResult({ totalSessions: 3 })),
      importSession: vi.fn(async () => makeImportResult())
    };
    deps = {
      cwd: () => '/repo/current',
      getDefaultMemoryService: vi.fn(() => globalService as never),
      getMemoryServiceForProject: vi.fn(() => projectService as never),
      createImporter: vi.fn(() => importer as never),
      onProgress: vi.fn()
    };
  });

  it('imports the current project from Hermes state.db into the project-scoped memory service', async () => {
    const outcome = await runHermesImportOnce({ stateDb: '/tmp/hermes-state.db', limit: '9', sessionLimit: '1' }, deps);

    expect(deps?.getMemoryServiceForProject).toHaveBeenCalledWith('/repo/current');
    expect(deps?.getDefaultMemoryService).not.toHaveBeenCalled();
    expect(deps?.createImporter).toHaveBeenCalledWith(projectService, { stateDbPath: '/tmp/hermes-state.db' });
    expect(projectService.initialize).toHaveBeenCalledTimes(1);
    expect(projectService.ensureEmbeddingModelForImport).toHaveBeenCalledWith({ autoMigrate: true });
    expect(importer.importProject).toHaveBeenCalledWith('/repo/current', expect.objectContaining({
      projectPath: '/repo/current',
      limit: 9,
      sessionLimit: 1,
      onProgress: deps?.onProgress
    }));
    expect(projectService.processPendingEmbeddings).toHaveBeenCalledTimes(1);
    expect(projectService.shutdown).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ mode: 'project', storageScope: 'project', embedCount: 2 });
  });

  it('uses global storage only for explicit all-session imports without a project', async () => {
    const outcome = await runHermesImportOnce({ all: true, processEmbeddings: false }, deps);

    expect(deps?.getDefaultMemoryService).toHaveBeenCalledTimes(1);
    expect(deps?.getMemoryServiceForProject).not.toHaveBeenCalled();
    expect(importer.importAll).toHaveBeenCalledWith(expect.objectContaining({ force: undefined }));
    expect(globalService.processPendingEmbeddings).not.toHaveBeenCalled();
    expect(globalService.shutdown).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ mode: 'all', storageScope: 'global', embedCount: 0 });
  });

  it('imports a single Hermes session into the selected project scope', async () => {
    await runHermesImportOnce({ project: '/repo/selected', session: '20260505_010203_abcd1234', force: true }, deps);

    expect(deps?.getMemoryServiceForProject).toHaveBeenCalledWith('/repo/selected');
    expect(importer.importSession).toHaveBeenCalledWith('20260505_010203_abcd1234', expect.objectContaining({
      projectPath: '/repo/selected',
      force: true
    }));
  });

  it('rejects non-decimal integer limits instead of partially parsing them', async () => {
    await expect(runHermesImportOnce({ limit: '1foo' }, deps)).rejects.toThrow('Invalid --limit');
    await expect(runHermesImportOnce({ sessionLimit: '1.5' }, deps)).rejects.toThrow('Invalid --session-limit');
    await expect(runHermesImportOnce({ sessionLimit: '1e2' }, deps)).rejects.toThrow('Invalid --session-limit');
  });

  it('shuts down the writable service when embedding migration setup fails', async () => {
    projectService.ensureEmbeddingModelForImport.mockRejectedValueOnce(new Error('migration failed'));

    await expect(runHermesImportOnce({}, deps)).rejects.toThrow('migration failed');

    expect(projectService.shutdown).toHaveBeenCalledTimes(1);
    expect(importer.importProject).not.toHaveBeenCalled();
  });
});
