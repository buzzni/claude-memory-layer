import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  discoverMaintenanceTargets,
  formatMaintenanceLastRunStatus,
  formatMaintenanceRunReport,
  maintenanceRunRequiresAttention,
  parseMaintenanceMinFreeBytes,
  readMaintenanceLastRunStatus,
  runMaintenanceCycle,
  writeMaintenanceLastRunStatus,
  type MaintenanceTarget
} from '../../src/apps/cli/maintenance-runner.js';
import type { OutboxStats } from '../../src/core/types.js';
import { diffMemoryRootSnapshots, snapshotMemoryRoot } from '../helpers/memory-root-snapshot.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('maintenance runner', () => {
  it('discovers global and validated project stores without following arbitrary directories', () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-maintenance-runner-'));
    tempDirs.push(homeDir);
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    mkdirSync(path.join(memoryRoot, 'projects', 'deadbeef'), { recursive: true });
    mkdirSync(path.join(memoryRoot, 'projects', 'not-a-hash'), { recursive: true });
    const externalStore = path.join(homeDir, 'external-store');
    mkdirSync(externalStore);
    writeFileSync(path.join(memoryRoot, 'events.sqlite'), '');
    writeFileSync(path.join(memoryRoot, 'projects', 'deadbeef', 'events.sqlite'), '');
    writeFileSync(path.join(memoryRoot, 'projects', 'not-a-hash', 'events.sqlite'), '');
    writeFileSync(path.join(externalStore, 'events.sqlite'), '');
    symlinkSync(externalStore, path.join(memoryRoot, 'projects', 'cafebabe'));
    writeFileSync(path.join(memoryRoot, 'session-registry.json'), JSON.stringify({
      version: 1,
      sessions: {
        old: { projectPath: '/repo/old', projectHash: 'deadbeef', registeredAt: '2026-01-01T00:00:00Z' },
        recent: { projectPath: '/repo/new', projectHash: 'deadbeef', registeredAt: '2026-01-02T00:00:00Z' }
      }
    }));

    const targets = discoverMaintenanceTargets({ homeDir });
    expect(targets.map((target) => target.key).sort()).toEqual(['__global__', 'deadbeef']);
    expect(targets.find((target) => target.key === 'deadbeef')?.projectPath).toBe('/repo/new');
  });

  it('does not initialize or migrate empty project skeletons during discovery', () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-maintenance-skeleton-'));
    tempDirs.push(homeDir);
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    mkdirSync(path.join(memoryRoot, 'projects', 'abc12345'), { recursive: true });
    const before = snapshotMemoryRoot(memoryRoot);

    expect(discoverMaintenanceTargets({ homeDir })).toEqual([]);
    expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(memoryRoot))).toEqual([]);
  });

  it('processes actionable stores, preserves quarantined jobs, and continues past busy/error stores', async () => {
    const targets: MaintenanceTarget[] = ['pending', 'quarantined', 'busy', 'error'].map((key) => ({
      key,
      storagePath: `/private/${key}`,
      modifiedAtMs: 1
    }));
    const report = await runMaintenanceCycle({}, {
      discoverTargets: () => targets,
      inspectTarget: async (target) => {
        if (target.key === 'pending') return stats({ embeddingPending: 5 });
        if (target.key === 'quarantined') return stats({ embeddingFailed: 3, embeddingQuarantined: 3 });
        if (target.key === 'busy') return stats({ vectorPending: 2 });
        throw new Error('/Users/private/secret/database failed with PRIVATE_PAYLOAD');
      },
      processTarget: async (target) => {
        if (target.key === 'busy') throw new Error('worker busy:123');
        return {
          processed: 5,
          recovery: {
            embedding: { recoveredProcessing: 1, retriedFailed: 0 },
            vector: { recoveredProcessing: 0, retriedFailed: 0 }
          },
          stats: stats({})
        };
      },
      getDiskStatus: () => healthyDisk(),
      now: () => new Date('2026-08-11T00:00:00Z')
    });

    expect(report).toMatchObject({
      scanned: 4,
      processed: 5,
      recovered: 1,
      busy: 1,
      blocked: 0,
      errors: 1,
      pendingRemaining: 2,
      retryableRemaining: 0,
      quarantined: 3
    });
    expect(report.results.find((item) => item.key === 'quarantined')?.status).toBe('needs-attention');
    expect(report.results.find((item) => item.key === 'busy')?.status).toBe('busy');
    expect(report.results.find((item) => item.key === 'busy')).toMatchObject({
      pendingBefore: 2,
      pendingAfter: 2
    });
    const error = report.results.find((item) => item.key === 'error')?.error ?? '';
    expect(error).toBe('SQLite maintenance failed');
    expect(error).not.toContain('/Users/private/secret');
    expect(JSON.stringify(report)).not.toContain('PRIVATE_PAYLOAD');

    const output = formatMaintenanceRunReport(report);
    expect(output).toContain('Quarantined jobs: 3');
    expect(output).not.toContain('PRIVATE_PAYLOAD');
  });

  it('rejects invalid scan and batch bounds before processing', async () => {
    expect(() => discoverMaintenanceTargets({ homeDir: '/tmp', maxProjects: 0 })).toThrow('--max-projects');
    await expect(runMaintenanceCycle({ maxBatches: 0 }, { discoverTargets: () => [] }))
      .rejects.toThrow('--max-batches');
  });

  it('validates the configurable free-space threshold', () => {
    expect(parseMaintenanceMinFreeBytes(undefined)).toBe(5 * 1024 * 1024 * 1024);
    expect(parseMaintenanceMinFreeBytes('0')).toBe(0);
    expect(parseMaintenanceMinFreeBytes('1.5')).toBe(Math.floor(1.5 * 1024 * 1024 * 1024));
    expect(() => parseMaintenanceMinFreeBytes('   ')).toThrow('--min-free-gb');
    expect(() => parseMaintenanceMinFreeBytes('-1')).toThrow('--min-free-gb');
    expect(() => parseMaintenanceMinFreeBytes('invalid')).toThrow('--min-free-gb');
  });

  it('reports actionable queues but blocks writes under disk pressure', async () => {
    let processCalls = 0;
    const report = await runMaintenanceCycle({}, {
      discoverTargets: () => [{ key: 'pending', storagePath: '/private/pending', modifiedAtMs: 1 }],
      inspectTarget: async (_target, options) => {
        expect(options.allowMigration).toBe(false);
        return stats({ embeddingPending: 7 });
      },
      processTarget: async () => {
        processCalls += 1;
        throw new Error('must not run');
      },
      getDiskStatus: () => ({
        availableBytes: 1024,
        totalBytes: 10_000,
        minRequiredBytes: 2048,
        healthy: false
      }),
      now: () => new Date('2026-08-11T00:00:00Z')
    });

    expect(processCalls).toBe(0);
    expect(report).toMatchObject({
      blocked: 1,
      errors: 0,
      pendingRemaining: 7,
      disk: { healthy: false }
    });
    expect(report.results[0]).toMatchObject({ status: 'blocked', pendingAfter: 7 });
    expect(formatMaintenanceRunReport(report)).toContain('Disk-pressure stores blocked: 1');
  });

  it('rechecks free space between stores and stops new writes mid-cycle', async () => {
    const processed: string[] = [];
    let diskChecks = 0;
    const report = await runMaintenanceCycle({}, {
      discoverTargets: () => ['first', 'second'].map((key) => ({
        key,
        storagePath: `/private/${key}`,
        modifiedAtMs: 1
      })),
      inspectTarget: async () => stats({ embeddingPending: 1 }),
      processTarget: async (target) => {
        processed.push(target.key);
        return {
          processed: 1,
          recovery: {
            embedding: { recoveredProcessing: 0, retriedFailed: 0 },
            vector: { recoveredProcessing: 0, retriedFailed: 0 }
          },
          stats: stats({})
        };
      },
      getDiskStatus: () => {
        diskChecks += 1;
        const healthy = diskChecks === 1;
        return {
          availableBytes: healthy ? 10_000 : 1_000,
          totalBytes: 20_000,
          minRequiredBytes: 5_000,
          healthy
        };
      },
      now: () => new Date('2026-08-11T00:00:00Z')
    });

    expect(processed).toEqual(['first']);
    expect(report).toMatchObject({ processed: 1, blocked: 1, disk: { healthy: false } });
    expect(maintenanceRunRequiresAttention(report)).toBe(true);
    expect(diskChecks).toBe(3);
  });

  it('requires attention when the final disk check crosses the threshold', async () => {
    let diskChecks = 0;
    const report = await runMaintenanceCycle({}, {
      discoverTargets: () => [],
      getDiskStatus: () => {
        diskChecks += 1;
        return {
          availableBytes: 1_000,
          totalBytes: 20_000,
          minRequiredBytes: 5_000,
          healthy: false
        };
      }
    });

    expect(report).toMatchObject({ scanned: 0, blocked: 0, disk: { healthy: false } });
    expect(maintenanceRunRequiresAttention(report)).toBe(true);
    expect(diskChecks).toBe(1);
  });

  it('uses WAL activity when limiting scans to the most recently written stores', () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-maintenance-wal-'));
    tempDirs.push(homeDir);
    const projectsRoot = path.join(homeDir, '.claude-code', 'memory', 'projects');
    const oldDbStore = path.join(projectsRoot, '11111111');
    const activeWalStore = path.join(projectsRoot, '22222222');
    mkdirSync(oldDbStore, { recursive: true });
    mkdirSync(activeWalStore, { recursive: true });
    const oldDb = path.join(oldDbStore, 'events.sqlite');
    const activeDb = path.join(activeWalStore, 'events.sqlite');
    const activeWal = `${activeDb}-wal`;
    writeFileSync(oldDb, '');
    writeFileSync(activeDb, '');
    writeFileSync(activeWal, '');
    utimesSync(oldDb, new Date('2026-08-10T00:00:00Z'), new Date('2026-08-10T00:00:00Z'));
    utimesSync(activeDb, new Date('2026-08-09T00:00:00Z'), new Date('2026-08-09T00:00:00Z'));
    utimesSync(activeWal, new Date('2026-08-11T00:00:00Z'), new Date('2026-08-11T00:00:00Z'));

    expect(discoverMaintenanceTargets({ homeDir, maxProjects: 1 })[0]?.key).toBe('22222222');
  });

  it('persists only aggregate last-run status without project results or payloads', () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-maintenance-status-'));
    tempDirs.push(homeDir);
    const report = {
      startedAt: '2026-08-11T00:00:00.000Z',
      finishedAt: '2026-08-11T00:01:00.000Z',
      scanned: 2,
      processed: 5,
      recovered: 1,
      busy: 0,
      blocked: 0,
      errors: 0,
      pendingRemaining: 2,
      retryableRemaining: 1,
      quarantined: 3,
      disk: healthyDisk(),
      results: [{
        key: 'PRIVATE_PROJECT_HASH',
        status: 'needs-attention' as const,
        processed: 0,
        recovered: 0,
        pendingBefore: 0,
        retryableBefore: 0,
        pendingAfter: 0,
        retryableAfter: 0,
        quarantined: 3,
        error: 'PRIVATE_PAYLOAD'
      }]
    };

    const statusPath = writeMaintenanceLastRunStatus(report, homeDir);
    const persisted = readMaintenanceLastRunStatus(homeDir);
    expect(persisted).toMatchObject({ processed: 5, quarantined: 3 });
    expect(formatMaintenanceLastRunStatus(persisted)).toContain('quarantined=3');
    const raw = requireStatusFile(statusPath);
    expect(raw).not.toContain('PRIVATE_PROJECT_HASH');
    expect(raw).not.toContain('PRIVATE_PAYLOAD');
  });

  it('reads pre-disk-pressure version 1 status without inventing free-space data', () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-maintenance-legacy-status-'));
    tempDirs.push(homeDir);
    const statusPath = path.join(homeDir, '.claude-code', 'memory', 'maintenance-status.json');
    mkdirSync(path.dirname(statusPath), { recursive: true });
    writeFileSync(statusPath, JSON.stringify({
      version: 1,
      startedAt: '2026-08-11T00:00:00.000Z',
      finishedAt: '2026-08-11T00:01:00.000Z',
      scanned: 2,
      processed: 0,
      recovered: 0,
      busy: 0,
      errors: 0,
      pendingRemaining: 0,
      retryableRemaining: 0,
      quarantined: 3
    }));

    const status = readMaintenanceLastRunStatus(homeDir);
    expect(status).toMatchObject({ blocked: 0, disk: null });
    expect(formatMaintenanceLastRunStatus(status)).toContain('disk=not recorded');
  });
});

function stats(input: {
  embeddingPending?: number;
  vectorPending?: number;
  embeddingFailed?: number;
  embeddingQuarantined?: number;
}): OutboxStats {
  return {
    embedding: {
      pending: input.embeddingPending ?? 0,
      processing: 0,
      failed: input.embeddingFailed ?? 0,
      retryableFailed: 0,
      quarantinedFailed: input.embeddingQuarantined ?? 0,
      total: (input.embeddingPending ?? 0) + (input.embeddingFailed ?? 0),
      stuckProcessing: 0,
      oldestProcessingAgeMs: null
    },
    vector: {
      pending: input.vectorPending ?? 0,
      processing: 0,
      failed: 0,
      retryableFailed: 0,
      quarantinedFailed: 0,
      total: input.vectorPending ?? 0,
      stuckProcessing: 0,
      oldestProcessingAgeMs: null
    }
  };
}

function requireStatusFile(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

function healthyDisk() {
  return {
    availableBytes: 10 * 1024 * 1024 * 1024,
    totalBytes: 100 * 1024 * 1024 * 1024,
    minRequiredBytes: 5 * 1024 * 1024 * 1024,
    healthy: true
  };
}
