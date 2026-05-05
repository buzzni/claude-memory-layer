import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportResult } from '../../src/services/session-history-importer.js';

const { runCodexImportOnce } = await import('../../src/apps/cli/codex-import-runner.js');

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

describe('Codex import runner', () => {
  let projectService: ReturnType<typeof makeService>;
  let globalService: ReturnType<typeof makeService>;
  let importer: {
    importProject: ReturnType<typeof vi.fn>;
    importAll: ReturnType<typeof vi.fn>;
    importSessionFile: ReturnType<typeof vi.fn>;
  };
  let deps: Parameters<typeof runCodexImportOnce>[1];

  beforeEach(() => {
    projectService = makeService();
    globalService = makeService();
    importer = {
      importProject: vi.fn(async () => makeImportResult()),
      importAll: vi.fn(async () => makeImportResult({ totalSessions: 3 })),
      importSessionFile: vi.fn(async () => makeImportResult())
    };
    deps = {
      cwd: () => '/repo/current',
      getDefaultMemoryService: vi.fn(() => globalService as never),
      getMemoryServiceForProject: vi.fn(() => projectService as never),
      createImporter: vi.fn(() => importer as never),
      onProgress: vi.fn()
    };
  });

  it('imports the current project from Codex sessions into the project-scoped memory service', async () => {
    const outcome = await runCodexImportOnce({ sessionsDir: '/tmp/codex-sessions', limit: '9' }, deps);

    expect(deps?.getMemoryServiceForProject).toHaveBeenCalledWith('/repo/current');
    expect(deps?.getDefaultMemoryService).not.toHaveBeenCalled();
    expect(deps?.createImporter).toHaveBeenCalledWith(projectService, { sessionsDir: '/tmp/codex-sessions' });
    expect(projectService.initialize).toHaveBeenCalledTimes(1);
    expect(projectService.ensureEmbeddingModelForImport).toHaveBeenCalledWith({ autoMigrate: true });
    expect(importer.importProject).toHaveBeenCalledWith('/repo/current', expect.objectContaining({
      projectPath: '/repo/current',
      limit: 9,
      onProgress: deps?.onProgress
    }));
    expect(projectService.processPendingEmbeddings).toHaveBeenCalledTimes(1);
    expect(projectService.shutdown).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ mode: 'project', storageScope: 'project', embedCount: 2 });
  });

  it('uses global storage only for explicit all-session imports without a project', async () => {
    const outcome = await runCodexImportOnce({ all: true, processEmbeddings: false }, deps);

    expect(deps?.getDefaultMemoryService).toHaveBeenCalledTimes(1);
    expect(deps?.getMemoryServiceForProject).not.toHaveBeenCalled();
    expect(importer.importAll).toHaveBeenCalledWith(expect.objectContaining({ force: undefined }));
    expect(globalService.processPendingEmbeddings).not.toHaveBeenCalled();
    expect(globalService.shutdown).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ mode: 'all', storageScope: 'global', embedCount: 0 });
  });

  it('imports a single Codex session file into the selected project scope', async () => {
    await runCodexImportOnce({ project: '/repo/selected', session: '/tmp/session.jsonl', force: true }, deps);

    expect(deps?.getMemoryServiceForProject).toHaveBeenCalledWith('/repo/selected');
    expect(importer.importSessionFile).toHaveBeenCalledWith('/tmp/session.jsonl', expect.objectContaining({
      projectPath: '/repo/selected',
      force: true
    }));
  });
});
