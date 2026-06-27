import { describe, expect, it } from 'vitest';

import {
  formatVectorStatusJsonReport,
  formatVectorStatusReport,
  resolveVectorStatusCommandOptions
} from '../../src/apps/cli/vector-command.js';

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
