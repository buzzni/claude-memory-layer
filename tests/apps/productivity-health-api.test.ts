import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => {
  const service = {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    getStats: vi.fn(),
    getOutboxStats: vi.fn(),
  };
  return {
    service,
    existsSync: vi.fn(() => true),
    getServiceFromQuery: vi.fn(() => {
      throw new Error('full service must not initialize productivity health');
    }),
    getLightweightServiceFromQuery: vi.fn(() => service),
    getWritableServiceFromQuery: vi.fn(() => service),
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: mocks.existsSync,
  };
});

vi.mock('../../src/apps/server/api/utils.js', () => ({
  getServiceFromQuery: mocks.getServiceFromQuery,
  getLightweightServiceFromQuery: mocks.getLightweightServiceFromQuery,
  getWritableServiceFromQuery: mocks.getWritableServiceFromQuery,
}));

const { healthRouter } = await import('../../src/apps/server/api/health.js');

function createApp() {
  const app = new Hono();
  app.route('/api/health', healthRouter);
  return app;
}

function defaultStats() {
  return {
    totalEvents: 42,
    vectorCount: 40,
    levelStats: [
      { level: 'L1', count: 12 },
      { level: 'L2', count: 8 },
      { level: 'L3', count: 6 },
      { level: 'L4', count: 3 },
    ],
    storagePath: '/Users/private/raw-storage-path-should-not-leak',
  };
}

function defaultOutbox() {
  return {
    embedding: { pending: 0, processing: 0, failed: 0, retryableFailed: 0, quarantinedFailed: 0, total: 4, stuckProcessing: 0, oldestProcessingAgeMs: null, rawIds: ['PRIVATE_EMBED_ID_SHOULD_NOT_LEAK'] },
    vector: { pending: 0, processing: 0, failed: 0, retryableFailed: 0, quarantinedFailed: 0, total: 4, stuckProcessing: 0, oldestProcessingAgeMs: null, rawError: 'PRIVATE_VECTOR_ERROR_SHOULD_NOT_LEAK' },
  };
}

describe('productivity health API', () => {
  beforeEach(() => {
    mocks.service.initialize.mockReset().mockResolvedValue(undefined);
    mocks.service.shutdown.mockReset().mockResolvedValue(undefined);
    mocks.service.getStats.mockReset().mockResolvedValue(defaultStats());
    mocks.service.getOutboxStats.mockReset().mockResolvedValue(defaultOutbox());
    mocks.getLightweightServiceFromQuery.mockClear();
    mocks.getServiceFromQuery.mockClear();
    mocks.getWritableServiceFromQuery.mockClear();
    mocks.existsSync.mockReset().mockReturnValue(true);
  });

  it('returns a safe aggregate Project Health Report from the lightweight service', async () => {
    const res = await createApp().request('/api/health/productivity?project=abc12345&profile=coder&mode=preview');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      schemaVersion: 'agent-productivity-health-v1',
      status: 'ok',
      profile: 'coder',
      mode: 'preview',
      project: { scope: 'project', id: 'abc12345' },
      signals: {
        storage: { totalEvents: 42, vectorCount: 40 },
        outbox: {
          totals: { pending: 0, processing: 0, failed: 0, retryableFailed: 0, quarantinedFailed: 0, stuckProcessing: 0, total: 8, oldestProcessingAgeMs: null },
        },
      },
      riskGates: [
        { id: 'project-scope-known', severity: 'blocker', status: 'pass' },
        { id: 'outbox-healthy', severity: 'warning', status: 'pass' },
        { id: 'memory-density', severity: 'warning', status: 'pass' },
      ],
      nextBestAction: 'No immediate maintenance action required.',
    });
    expect(body.generatedAt).toEqual(expect.any(String));
    expect(body.summary.warningReasons).toEqual([]);
    expect(mocks.getLightweightServiceFromQuery).toHaveBeenCalledTimes(1);
    expect(mocks.getServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.getWritableServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.service.shutdown).toHaveBeenCalledTimes(1);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('/Users/private');
    expect(serialized).not.toContain('PRIVATE_EMBED_ID_SHOULD_NOT_LEAK');
    expect(serialized).not.toContain('PRIVATE_VECTOR_ERROR_SHOULD_NOT_LEAK');
  });

  it('marks risk gates as warning when outbox or memory density require attention', async () => {
    mocks.service.getStats.mockResolvedValueOnce({ totalEvents: 0, vectorCount: 0, levelStats: [] });
    mocks.service.getOutboxStats.mockResolvedValueOnce({
      embedding: { pending: 3, processing: 1, failed: 1, retryableFailed: 1, quarantinedFailed: 0, total: 5, stuckProcessing: 1, oldestProcessingAgeMs: 900000 },
      vector: { pending: 0, processing: 0, failed: 1, retryableFailed: 0, quarantinedFailed: 1, total: 2, stuckProcessing: 0, oldestProcessingAgeMs: null },
    });

    const res = await createApp().request('/api/health/productivity?mode=enforce');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('needs-attention');
    expect(body.mode).toBe('enforce');
    expect(body.project).toEqual({ scope: 'global', id: 'global' });
    expect(body.summary.warningReasons).toEqual(expect.arrayContaining(['project_scope_unknown', 'outbox_requires_attention', 'memory_density_low']));
    expect(body.riskGates).toEqual(expect.arrayContaining([
      { id: 'project-scope-known', severity: 'blocker', status: 'warn', message: 'No project parameter supplied; report uses global memory scope.' },
      { id: 'outbox-healthy', severity: 'warning', status: 'warn', message: 'Outbox has failed or stuck processing items; run recovery before trusting retrieval freshness.' },
      { id: 'memory-density', severity: 'warning', status: 'warn', message: 'No memories are available for this scope yet.' },
    ]));
    expect(body.nextBestAction).toBe('Run claude-memory-layer process --dry-run-recovery, then process pending embeddings.');
  });

  it('returns a zero aggregate report for missing project storage without constructing a service', async () => {
    mocks.existsSync.mockReturnValueOnce(false);
    const missingProject = join(mkdtempSync(join(tmpdir(), 'cml-health-missing-project-')), 'project with spaces');

    const res = await createApp().request(`/api/health/productivity?project=${encodeURIComponent(missingProject)}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('needs-attention');
    expect(body.project.scope).toBe('project');
    expect(body.project.id).toMatch(/^[a-f0-9]{8}$/);
    expect(body.signals.storage).toEqual({ totalEvents: 0, vectorCount: 0, levelStats: [] });
    expect(body.signals.outbox.totals).toMatchObject({ pending: 0, processing: 0, failed: 0, total: 0, stuckProcessing: 0, oldestProcessingAgeMs: null });
    expect(body.summary.warningReasons).toEqual(['memory_density_low']);
    expect(body.nextBestAction).toBe('Import or capture project context before relying on productivity memory guidance.');
    expect(mocks.getLightweightServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.service.initialize).not.toHaveBeenCalled();
    expect(mocks.service.shutdown).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain(missingProject);
  });

  it('validates productivity options before resolving project storage services', async () => {
    const res = await createApp().request('/api/health/productivity?project=abc12345&profile=operator');

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({
      status: 'error',
      timestamp: expect.any(String),
      error: 'Invalid productivity health option',
    });
    expect(mocks.getLightweightServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.service.initialize).not.toHaveBeenCalled();
    expect(mocks.service.shutdown).not.toHaveBeenCalled();
  });

  it('does not leak raw productivity health errors', async () => {
    mocks.service.getStats.mockRejectedValueOnce(new Error('PRIVATE_PRODUCTIVITY_HEALTH_ERROR /Users/private/raw.sqlite'));

    const res = await createApp().request('/api/health/productivity?project=abc12345');

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      status: 'error',
      timestamp: expect.any(String),
      error: 'Productivity health check failed',
    });
    expect(JSON.stringify(body)).not.toContain('PRIVATE_PRODUCTIVITY_HEALTH_ERROR');
    expect(JSON.stringify(body)).not.toContain('/Users/private/raw.sqlite');
    expect(mocks.service.shutdown).toHaveBeenCalledTimes(1);
  });
});
