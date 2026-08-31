import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { VectorStore } from '../../src/core/vector-store.js';

describe('VectorStore maintenance telemetry', () => {
  it('keeps a missing or escaped read-only vector index from creating or opening storage', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-vector-readonly-'));
    try {
      const missingPath = path.join(root, 'vectors');
      const missing = new VectorStore(missingPath, { readOnly: true, canonicalRoot: root });
      await expect(missing.countAll()).resolves.toBe(0);
      await expect(missing.count()).resolves.toBe(0);
      await expect(missing.search([0.1, 0.2, 0.3])).resolves.toEqual([]);
      await expect(missing.exists('missing-event')).resolves.toBe(false);
      expect(existsSync(missingPath)).toBe(false);
      await expect(missing.optimizeAll()).rejects.toThrow('VectorStore is read-only');

      const externalPath = path.join(root, 'external');
      mkdirSync(externalPath);
      symlinkSync(externalPath, missingPath);
      const escaped = new VectorStore(missingPath, { readOnly: true, canonicalRoot: root });
      await expect(escaped.countAll()).resolves.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('captures and verifies a real vector row without issuing a zero-dimensional search', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-vector-maintenance-smoke-'));
    try {
      const store = new VectorStore(path.join(root, 'vectors'));
      await store.upsert({
        id: 'vector-1',
        eventId: 'event-1',
        sessionId: 'session-1',
        eventType: 'agent_response',
        content: 'bounded smoke fixture',
        vector: [0.1, 0.2, 0.3],
        timestamp: '2026-08-31T00:00:00.000Z',
        metadata: {}
      });

      const verify = await store.createReadSmokeVerifier();
      await expect(verify()).resolves.toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns structured unsupported/empty optimization and physical health', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-vector-maintenance-'));
    try {
      const store = new VectorStore(path.join(root, 'vectors'));
      const result = await store.optimizeAll();
      expect(result).toMatchObject({
        supported: false,
        tablesScanned: 0,
        tablesOptimized: 0,
        failures: 0,
        reclaimedBytes: 0,
        tableResults: []
      });
      const health = await store.getPhysicalHealth(0);
      expect(health).toMatchObject({
        tableCount: 0,
        lastOptimizeOutcome: 'unsupported',
        amplificationState: 'unknown'
      });
      expect(health.physicalBytes).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores malformed optimize timestamps instead of suppressing maintenance forever', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-vector-maintenance-state-'));
    try {
      const vectorsPath = path.join(root, 'vectors');
      mkdirSync(vectorsPath);
      writeFileSync(path.join(vectorsPath, '.cml-optimize-state.json'), JSON.stringify({
        finishedAt: 'not-a-date',
        supported: true,
        failures: 0
      }));
      const health = await new VectorStore(vectorsPath).getPhysicalHealth(0);
      expect(health).toMatchObject({ lastOptimizedAt: null, lastOptimizeOutcome: 'never' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not report a pre-mutation budget deferral as provider unsupported', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-vector-maintenance-budget-state-'));
    try {
      const vectorsPath = path.join(root, 'vectors');
      mkdirSync(vectorsPath);
      writeFileSync(path.join(vectorsPath, '.cml-optimize-state.json'), JSON.stringify({
        finishedAt: '2026-08-31T00:00:00.000Z',
        supported: false,
        failures: 0,
        budgetExhausted: true
      }));
      const health = await new VectorStore(vectorsPath).getPhysicalHealth(0);
      expect(health).toMatchObject({ lastOptimizedAt: null, lastOptimizeOutcome: 'never' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists post-compaction integrity failures for later health checks', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-vector-maintenance-integrity-state-'));
    try {
      const vectorsPath = path.join(root, 'vectors');
      mkdirSync(vectorsPath);
      const store = new VectorStore(vectorsPath);
      store.persistOptimizeResult({
        startedAt: '2026-08-31T00:00:00.000Z',
        finishedAt: '2026-08-31T00:00:01.000Z',
        supported: true,
        tablesScanned: 1,
        tablesOptimized: 1,
        failures: 1,
        beforeBytes: 200,
        afterBytes: 100,
        reclaimedBytes: 100,
        tableResults: [{
          tableKind: 'integrity_check',
          outcome: 'failed',
          safeErrorCode: 'read_smoke_failed'
        }]
      });

      const health = await store.getPhysicalHealth(1);
      expect(health).toMatchObject({ lastOptimizeOutcome: 'failed', lastOptimizedAt: '2026-08-31T00:00:01.000Z' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid explicit optimize budgets before opening storage', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-vector-maintenance-budget-'));
    try {
      const store = new VectorStore(path.join(root, 'vectors'));
      await expect(store.optimizeAll({ maxTables: 0 })).rejects.toThrow(/optimize bound/);
      await expect(store.optimizeAll({ maxDurationMs: -1 })).rejects.toThrow(/optimize bound/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
