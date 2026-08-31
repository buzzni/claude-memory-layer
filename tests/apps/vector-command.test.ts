import { describe, expect, it } from 'vitest';

import {
  formatVectorStatusJsonReport,
  formatVectorStatusReport,
  isOwnedVectorDirectory,
  runVectorCompaction,
  resolveVectorStatusCommandOptions
} from '../../src/apps/cli/vector-command.js';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

describe('vector-status CLI helpers', () => {
  it('defaults to the current project path but rejects empty --project', () => {
    expect(resolveVectorStatusCommandOptions({}, '/repo/current')).toEqual({
      projectPath: '/repo/current',
      json: false
    });
    expect(resolveVectorStatusCommandOptions({ project: '/repo/selected', json: true }, '/repo/current')).toEqual({
      projectPath: '/repo/selected',
      json: true
    });
    expect(() => resolveVectorStatusCommandOptions({ project: '   ' }, '/repo/current')).toThrow('--project must not be empty');
  });

  it('formats aggregate-only vector status table and hides private queue details', () => {
    const output = formatVectorStatusReport({
      stats: {
        totalEvents: 123,
        vectorCount: 456,
        levelStats: []
      },
      outbox: {
        embedding: {
          pending: 1,
          processing: 2,
          failed: 3,
          retryableFailed: 1,
          quarantinedFailed: 2,
          stuckProcessing: 1,
          oldestProcessingAgeMs: 120_000,
          total: 6,
          rawError: 'PRIVATE_EMBED_ERROR_SENTINEL',
          rowId: 'embedding-row-private'
        } as never,
        vector: {
          pending: 4,
          processing: 5,
          failed: 0,
          retryableFailed: 0,
          quarantinedFailed: 0,
          stuckProcessing: 2,
          oldestProcessingAgeMs: 245_000,
          total: 11,
          itemId: 'PRIVATE_ITEM_ID_SENTINEL',
          sourceContent: 'PRIVATE_SOURCE_CONTENT_SENTINEL',
          rawIds: ['raw-vector-row']
        } as never
      }
    });

    expect(output).toContain('Vector Outbox Status');
    expect(output).toContain('Vector count: 456');
    expect(output).toContain('Embedding');
    expect(output).toContain('Vector');
    expect(output).toContain('Total');
    expect(output).toContain('pending=5');
    expect(output).toContain('processing=7');
    expect(output).toContain('failed=3');
    expect(output).toContain('retryableFailed=1');
    expect(output).toContain('quarantinedFailed=2');
    expect(output).toContain('stuck=3');
    expect(output).toContain('Oldest processing age: 4m');
    expect(output).toContain('Status: needs-attention');
    expect(output).toContain('claude-memory-layer process --dry-run-recovery');
    expect(output).not.toContain('/repo/');
    expect(output).not.toContain('PRIVATE_EMBED_ERROR_SENTINEL');
    expect(output).not.toContain('PRIVATE_ITEM_ID_SENTINEL');
    expect(output).not.toContain('PRIVATE_SOURCE_CONTENT_SENTINEL');
    expect(output).not.toContain('raw-vector-row');
    expect(output).not.toContain('embedding-row-private');
  });

  it('reports healthy aggregate status without recovery guidance when there is no failed or stuck work', () => {
    const output = formatVectorStatusReport({
      stats: { totalEvents: 10, vectorCount: 9, levelStats: [] },
      outbox: {
        embedding: { pending: 0, processing: 0, failed: 0, stuckProcessing: 0, oldestProcessingAgeMs: null, total: 0 },
        vector: { pending: 0, processing: 0, failed: 0, stuckProcessing: 0, oldestProcessingAgeMs: null, total: 0 }
      }
    });

    expect(output).toContain('Status: ok');
    expect(output).toContain('Oldest processing age: none');
    expect(output).not.toContain('dry-run-recovery');
  });

  it('shows unsupported physical metrics as unknown rather than zero', () => {
    const output = formatVectorStatusReport({
      stats: { totalEvents: 10, vectorCount: 9, levelStats: [] },
      outbox: {
        embedding: { pending: 0, processing: 0, failed: 0, stuckProcessing: 0, oldestProcessingAgeMs: null, total: 0 },
        vector: { pending: 0, processing: 0, failed: 0, stuckProcessing: 0, oldestProcessingAgeMs: null, total: 0 }
      },
      physicalHealth: {
        physicalBytes: null,
        tableCount: null,
        fragmentCount: null,
        versionCount: null,
        bytesPerLogicalVector: null,
        lastOptimizedAt: null,
        lastOptimizeOutcome: 'unsupported',
        amplificationState: 'unknown'
      }
    });
    expect(output).toContain('Physical bytes: unsupported');
    expect(output).toContain('Tables/fragments/versions: unsupported/unsupported/unsupported');
    expect(output).not.toContain('Physical bytes: 0');
  });

  it('keeps compaction preview read-only and applies only inside the project lock', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-vector-compact-'));
    const storagePath = path.join(root, 'projects', 'abc12345');
    mkdirSync(storagePath, { recursive: true });
    let optimizeCalls = 0;
    const lockStatesDuringCount: boolean[] = [];
    const fakeStore = {
      count: async () => {
        lockStatesDuringCount.push(existsSync(path.join(storagePath, 'vector-worker.lock')));
        return 12;
      },
      countAll: async () => {
        lockStatesDuringCount.push(existsSync(path.join(storagePath, 'vector-worker.lock')));
        return 20;
      },
      getPhysicalHealth: async () => ({
        physicalBytes: 300 * 1024 * 1024,
        tableCount: 1,
        fragmentCount: 4,
        versionCount: 9,
        bytesPerLogicalVector: 1024,
        lastOptimizedAt: null,
        lastOptimizeOutcome: 'never' as const,
        amplificationState: 'unknown' as const
      }),
      optimizeAll: async () => {
        optimizeCalls += 1;
        return {
          startedAt: '2026-08-31T00:00:00Z',
          finishedAt: '2026-08-31T00:00:01Z',
          supported: true,
          tablesScanned: 1,
          tablesOptimized: 1,
          failures: 0,
          beforeBytes: 300,
          afterBytes: 200,
          reclaimedBytes: 100,
          tableResults: [{ tableKind: 'conversations', outcome: 'optimized' as const }]
        };
      }
    };
    const deps = {
      storagePathForProject: () => storagePath,
      createVectorStore: () => fakeStore as never
    };

    const preview = await runVectorCompaction({ projectPath: '/repo/app' }, deps);
    expect(preview).toMatchObject({ mode: 'preview', eligible: true, smokeCheck: 'not_run' });
    expect(optimizeCalls).toBe(0);

    const applied = await runVectorCompaction({ projectPath: '/repo/app', apply: true }, deps);
    expect(applied).toMatchObject({ mode: 'apply', logicalCountBefore: 20, logicalCountAfter: 20, smokeCheck: 'passed' });
    expect(optimizeCalls).toBe(1);
    expect(lockStatesDuringCount).toEqual([false, true, true]);
  });

  it('does not compact an empty never-optimized store without a qualifying signal', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-vector-compact-empty-'));
    const storagePath = path.join(root, 'projects', 'abc12345');
    mkdirSync(storagePath, { recursive: true });
    let optimizeCalls = 0;
    const report = await runVectorCompaction({ projectPath: '/repo/app', apply: true }, {
      storagePathForProject: () => storagePath,
      createVectorStore: () => ({
        count: async () => 0,
        getPhysicalHealth: async () => ({
          physicalBytes: 0,
          tableCount: 0,
          fragmentCount: 0,
          versionCount: 0,
          bytesPerLogicalVector: null,
          lastOptimizedAt: null,
          lastOptimizeOutcome: 'never' as const,
          amplificationState: 'unknown' as const
        }),
        optimizeAll: async () => {
          optimizeCalls += 1;
          throw new Error('must not optimize');
        }
      }) as never
    });
    expect(report).toMatchObject({ eligible: false, reasons: [], smokeCheck: 'not_run' });
    expect(optimizeCalls).toBe(0);
  });

  it('does not create a missing vector directory during preview or apply', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-vector-compact-missing-'));
    const storagePath = path.join(root, 'projects', 'abc12345');
    mkdirSync(storagePath, { recursive: true });
    const vectorsPath = path.join(storagePath, 'vectors');
    const deps = { storagePathForProject: () => storagePath };

    expect(await runVectorCompaction({ projectPath: '/repo/app' }, deps))
      .toMatchObject({ mode: 'preview', eligible: false, logicalCountBefore: 0 });
    expect(await runVectorCompaction({ projectPath: '/repo/app', apply: true }, deps))
      .toMatchObject({ mode: 'apply', eligible: false, logicalCountBefore: 0 });
    expect(existsSync(vectorsPath)).toBe(false);
  });

  it('rejects a vector directory that leaves project storage through a symlink', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-vector-compact-link-'));
    const storagePath = path.join(root, 'projects', 'abc12345');
    const externalVectors = path.join(root, 'external-vectors');
    mkdirSync(storagePath, { recursive: true });
    mkdirSync(externalVectors);
    const vectorsPath = path.join(storagePath, 'vectors');
    symlinkSync(externalVectors, vectorsPath);

    expect(isOwnedVectorDirectory(storagePath, vectorsPath)).toBe(false);
  });

  it('reports an eligible but unsupported compaction as unsupported', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-vector-compact-unsupported-'));
    const storagePath = path.join(root, 'projects', 'abc12345');
    mkdirSync(storagePath, { recursive: true });
    const report = await runVectorCompaction({ projectPath: '/repo/app', apply: true }, {
      storagePathForProject: () => storagePath,
      createVectorStore: () => ({
        count: async () => 4,
        getPhysicalHealth: async () => ({
          physicalBytes: 300 * 1024 * 1024,
          tableCount: 1,
          fragmentCount: 1,
          versionCount: 1,
          bytesPerLogicalVector: 1024,
          lastOptimizedAt: null,
          lastOptimizeOutcome: 'never' as const,
          amplificationState: 'unknown' as const
        }),
        optimizeAll: async () => ({
          startedAt: '2026-08-31T00:00:00Z',
          finishedAt: '2026-08-31T00:00:01Z',
          supported: false,
          tablesScanned: 1,
          tablesOptimized: 0,
          failures: 0,
          beforeBytes: 300,
          afterBytes: 300,
          reclaimedBytes: 0,
          tableResults: [{ tableKind: 'conversations', outcome: 'unsupported' as const }]
        })
      }) as never
    });
    expect(report).toMatchObject({ eligible: true, smokeCheck: 'unsupported' });
  });

  it('reports an intact bounded partial compaction as budget exhausted', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-vector-compact-budget-'));
    const storagePath = path.join(root, 'projects', 'abc12345');
    mkdirSync(storagePath, { recursive: true });
    const report = await runVectorCompaction({ projectPath: '/repo/app', apply: true }, {
      storagePathForProject: () => storagePath,
      createVectorStore: () => ({
        count: async () => 4,
        countAll: async () => 4,
        createReadSmokeVerifier: async () => async () => true,
        getPhysicalHealth: async () => ({
          physicalBytes: 300 * 1024 * 1024,
          tableCount: 2,
          fragmentCount: 2,
          versionCount: 4,
          bytesPerLogicalVector: 1024,
          lastOptimizedAt: null,
          lastOptimizeOutcome: 'never' as const,
          amplificationState: 'unknown' as const
        }),
        optimizeAll: async () => ({
          startedAt: '2026-08-31T00:00:00Z',
          finishedAt: '2026-08-31T00:00:01Z',
          supported: true,
          tablesScanned: 2,
          tablesOptimized: 1,
          failures: 0,
          beforeBytes: 300,
          afterBytes: 250,
          reclaimedBytes: 50,
          budgetExhausted: true,
          tableResults: [
            { tableKind: 'events', outcome: 'optimized' as const },
            { tableKind: 'lessons', outcome: 'skipped' as const, safeErrorCode: 'budget_exhausted' }
          ]
        })
      }) as never
    });

    expect(report).toMatchObject({ eligible: true, smokeCheck: 'budget_exhausted' });
  });

  it('fails the compaction smoke check when a captured vector is no longer readable', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-vector-compact-smoke-'));
    const storagePath = path.join(root, 'projects', 'abc12345');
    mkdirSync(storagePath, { recursive: true });
    let persistedFailures = 0;
    const report = await runVectorCompaction({ projectPath: '/repo/app', apply: true }, {
      storagePathForProject: () => storagePath,
      createVectorStore: () => ({
        count: async () => 4,
        countAll: async () => 4,
        createReadSmokeVerifier: async () => async () => false,
        getPhysicalHealth: async () => ({
          physicalBytes: 300 * 1024 * 1024,
          tableCount: 1,
          fragmentCount: 1,
          versionCount: 2,
          bytesPerLogicalVector: 1024,
          lastOptimizedAt: null,
          lastOptimizeOutcome: 'never' as const,
          amplificationState: 'unknown' as const
        }),
        optimizeAll: async () => ({
          startedAt: '2026-08-31T00:00:00Z',
          finishedAt: '2026-08-31T00:00:01Z',
          supported: true,
          tablesScanned: 1,
          tablesOptimized: 1,
          failures: 0,
          beforeBytes: 300,
          afterBytes: 200,
          reclaimedBytes: 100,
          tableResults: [{ tableKind: 'conversations', outcome: 'optimized' as const }]
        }),
        persistOptimizeResult: (result: { failures: number }) => {
          persistedFailures = result.failures;
        }
      }) as never
    });
    expect(report).toMatchObject({
      logicalCountBefore: 4,
      logicalCountAfter: 4,
      smokeCheck: 'failed',
      optimize: {
        failures: 1,
        tableResults: expect.arrayContaining([
          expect.objectContaining({ safeErrorCode: 'read_smoke_failed' })
        ])
      }
    });
    expect(persistedFailures).toBe(1);
  });

  it('recommends investigation instead of recovery when failed work is fully quarantined', () => {
    const output = formatVectorStatusReport({
      stats: { totalEvents: 10, vectorCount: 9, levelStats: [] },
      outbox: {
        embedding: { pending: 0, processing: 0, failed: 3, retryableFailed: 0, quarantinedFailed: 3, stuckProcessing: 0, oldestProcessingAgeMs: null, total: 3 },
        vector: { pending: 0, processing: 0, failed: 2, retryableFailed: 0, quarantinedFailed: 2, stuckProcessing: 0, oldestProcessingAgeMs: null, total: 2 }
      }
    });

    expect(output).toContain('Status: needs-attention');
    expect(output).toContain('Next step: inspect quarantined outbox failures');
    expect(output).toContain('quarantinedFailed=5');
    expect(output).not.toContain('claude-memory-layer process --dry-run-recovery');
  });

  it('formats aggregate-only vector status JSON for automation without private queue details', () => {
    const output = formatVectorStatusJsonReport({
      stats: { totalEvents: 123, vectorCount: 456, levelStats: [] },
      outbox: {
        embedding: { pending: 0, processing: 0, failed: 3, retryableFailed: 0, quarantinedFailed: 3, stuckProcessing: 0, oldestProcessingAgeMs: null, total: 3, rawError: 'PRIVATE_EMBED_ERROR_SENTINEL' } as never,
        vector: { pending: 1, processing: 2, failed: 1, retryableFailed: 1, quarantinedFailed: 0, stuckProcessing: 1, oldestProcessingAgeMs: 120_000, total: 5, itemIds: ['PRIVATE_VECTOR_ID_SENTINEL'] } as never
      }
    });

    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({
      status: 'needs-attention',
      storage: { totalEvents: 123, vectorCount: 456 },
      outbox: {
        embedding: { pending: 0, processing: 0, failed: 3, retryableFailed: 0, quarantinedFailed: 3, stuckProcessing: 0, total: 3 },
        vector: { pending: 1, processing: 2, failed: 1, retryableFailed: 1, quarantinedFailed: 0, stuckProcessing: 1, total: 5 },
        totals: { pending: 1, processing: 2, failed: 4, retryableFailed: 1, quarantinedFailed: 3, stuckProcessing: 1, total: 8 }
      },
      recommendedAction: 'run-recovery'
    });
    expect(output).not.toContain('PRIVATE_EMBED_ERROR_SENTINEL');
    expect(output).not.toContain('PRIVATE_VECTOR_ID_SENTINEL');
  });
});
