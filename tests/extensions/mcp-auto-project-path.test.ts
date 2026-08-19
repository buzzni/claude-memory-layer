import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Callers that omit `projectPath` used to be routed to the global store, which
 * nothing writes to in a hook-driven install — every hook writes per-project.
 * These tests pin the cwd-derived fallback that replaced it, and the guard
 * that keeps it from inventing stores for non-project directories.
 *
 * `getProjectStoragePath` is mocked so store existence is decided inside a
 * temp directory. The real implementation resolves under the developer's
 * `~/.claude-code/memory`, and a test must not create anything there.
 */

const mocks = vi.hoisted(() => {
  function createService() {
    return {
      storeStatus: 'existing',
      initialize: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
      getStats: vi.fn(async () => ({ totalEvents: 0, vectorCount: 0 })),
      getDistinctSessionCount: vi.fn(async () => 0),
      getEventTypeCounts: vi.fn(async () => []),
      getOutboxStats: vi.fn(async () => ({
        embedding: { pending: 0, processing: 0, failed: 0, total: 0, stuckProcessing: 0, oldestProcessingAgeMs: null },
        vector: { pending: 0, processing: 0, failed: 0, total: 0, stuckProcessing: 0, oldestProcessingAgeMs: null }
      }))
    };
  }

  return {
    defaultService: createService(),
    projectService: createService(),
    getDefaultMemoryService: vi.fn(),
    getMemoryServiceForProject: vi.fn(),
    createReadOnlyDiagnosticsService: vi.fn(),
    // Counts store-location lookups so the caching test can assert the
    // resolver runs once per cwd rather than once per tool call.
    getProjectStoragePath: vi.fn(),
    // Set per test: maps a cwd to the directory that would hold its store.
    storageRoot: { value: '' }
  };
});

vi.mock('../../src/services/memory-service.js', () => ({
  getDefaultMemoryService: mocks.getDefaultMemoryService,
  getMemoryServiceForProject: mocks.getMemoryServiceForProject,
  shutdownMemoryServices: vi.fn(async () => undefined)
}));

vi.mock('../../src/services/read-only-diagnostics-service.js', () => ({
  createReadOnlyDiagnosticsService: mocks.createReadOnlyDiagnosticsService
}));

vi.mock('../../src/core/registry/project-path.js', () => ({
  getProjectStoragePath: mocks.getProjectStoragePath,
  hashProjectPath: (projectPath: string) => encodeURIComponent(projectPath).slice(0, 8),
  resolveMemoryRootMarkerPath: () => null
}));

function storageDirFor(projectPath: string): string {
  return path.join(mocks.storageRoot.value, encodeURIComponent(projectPath));
}

const { handleToolCall } = await import('../../src/extensions/mcp/handlers.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-auto-project-'));
mocks.storageRoot.value = tmpRoot;

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Each test uses a distinct cwd on purpose: the resolver caches per cwd for
 * the life of the process (the server's cwd never changes), so reusing one
 * would leak the previous test's answer.
 */
let cwdSeq = 0;
function useCwd(options: { withStore: boolean }): string {
  cwdSeq += 1;
  const cwd = path.join(tmpRoot, 'cwd', `project-${cwdSeq}`);
  fs.mkdirSync(cwd, { recursive: true });
  if (options.withStore) {
    const storeDir = storageDirFor(cwd);
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, 'events.sqlite'), '');
  }
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  return cwd;
}

describe('MCP projectPath auto-resolution from cwd', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.getDefaultMemoryService.mockReset().mockReturnValue(mocks.defaultService);
    mocks.getMemoryServiceForProject.mockReset().mockReturnValue(mocks.projectService);
    mocks.createReadOnlyDiagnosticsService.mockReset().mockImplementation((projectPath?: string) => (
      projectPath ? mocks.projectService : mocks.defaultService
    ));
    mocks.getProjectStoragePath.mockReset().mockImplementation(storageDirFor);
  });

  it('routes to the project store for the cwd when projectPath is omitted', async () => {
    const cwd = useCwd({ withStore: true });

    await handleToolCall('mem-stats', {});

    expect(mocks.createReadOnlyDiagnosticsService).toHaveBeenCalledWith(cwd);
    expect(mocks.getMemoryServiceForProject).not.toHaveBeenCalled();
    expect(mocks.getDefaultMemoryService).not.toHaveBeenCalled();
  });

  it('stays on the global store when the cwd has no store, rather than creating one', async () => {
    useCwd({ withStore: false });

    await handleToolCall('mem-stats', {});

    // getMemoryServiceForProject creates a store for whatever path it gets, so
    // never reaching it is the point: a server started outside a project must
    // not litter projects/ with empty stores.
    expect(mocks.getMemoryServiceForProject).not.toHaveBeenCalled();
    expect(mocks.getDefaultMemoryService).not.toHaveBeenCalled();
    expect(mocks.createReadOnlyDiagnosticsService).toHaveBeenCalledWith(undefined);
  });

  it('never overrides an explicitly supplied projectPath', async () => {
    useCwd({ withStore: true });

    await handleToolCall('mem-stats', { projectPath: '/explicit/project' });

    expect(mocks.createReadOnlyDiagnosticsService).toHaveBeenCalledWith('/explicit/project');
  });

  it('resolves once per cwd instead of on every tool call', async () => {
    // Resolution shells out to git via hashProjectPath, so repeating it for
    // every call would tax a long-lived server for no new information — its
    // cwd cannot change.
    const cwd = useCwd({ withStore: true });

    await handleToolCall('mem-stats', {});
    await handleToolCall('mem-stats', {});
    await handleToolCall('mem-stats', {});

    expect(mocks.getProjectStoragePath).toHaveBeenCalledTimes(1);
    expect(mocks.createReadOnlyDiagnosticsService).toHaveBeenCalledTimes(3);
    expect(mocks.createReadOnlyDiagnosticsService).toHaveBeenNthCalledWith(3, cwd);
  });
});
