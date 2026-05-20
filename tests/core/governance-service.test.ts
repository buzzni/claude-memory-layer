import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { GovernanceService } from '../../src/core/operations/governance-service.js';
import { hashProjectPath } from '../../src/core/registry/project-path.js';
import { sqliteAll, sqliteGet, sqliteRun } from '../../src/core/sqlite-wrapper.js';
import type { MemoryEvent } from '../../src/core/types.js';

const tempDirs: string[] = [];

function tempDb(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-governance-service-'));
  tempDirs.push(dir);
  return { dir, dbPath: path.join(dir, 'events.sqlite') };
}

function scopedEvent(
  id: string,
  content: string,
  projectHash: string,
  projectPath: string,
  metadata: Record<string, unknown> = {}
): MemoryEvent {
  return {
    id,
    eventType: 'user_prompt',
    sessionId: `session-${id}`,
    timestamp: new Date('2026-05-20T00:00:00.000Z'),
    content,
    canonicalKey: `canonical-${id}`,
    dedupeKey: `dedupe-${id}`,
    metadata: {
      ...metadata,
      scope: { project: { hash: projectHash, path: projectPath } },
      tags: [`proj:${projectHash}`],
      turnId: `turn-${id}`
    }
  };
}

function unscopedEvent(id: string, content: string, metadata: Record<string, unknown> = {}): MemoryEvent {
  return {
    id,
    eventType: 'user_prompt',
    sessionId: `session-${id}`,
    timestamp: new Date('2026-05-20T00:00:00.000Z'),
    content,
    canonicalKey: `canonical-${id}`,
    dedupeKey: `dedupe-${id}`,
    metadata
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('GovernanceService quarantine', () => {
  it('quarantines a project-scoped event with audit and suppresses default read paths without deleting the row', async () => {
    const { dir, dbPath } = tempDb();
    const store = new SQLiteEventStore(dbPath);
    const projectPath = '/repo/claude-memory-layer';
    const projectHash = hashProjectPath(projectPath);

    try {
      await store.importEvents([
        scopedEvent(
          'event-explicit-quarantine',
          'EXPLICIT_QUARANTINE_TOKEN should disappear from default reads',
          projectHash,
          projectPath
        )
      ]);

      const service = new GovernanceService(store.getDatabase());
      const result = await service.quarantine({
        targetType: 'event',
        targetId: 'event-explicit-quarantine',
        projectHash,
        actor: 'hermes-test',
        category: 'retention',
        reason: 'manual-review',
        sourceEventIds: ['source-review-1'],
        now: new Date('2026-05-20T01:02:03.000Z')
      });

      expect(result).toMatchObject({
        targetType: 'event',
        targetId: 'event-explicit-quarantine',
        projectHash,
        changed: true,
        quarantine: {
          status: 'active',
          category: 'retention',
          reason: 'manual-review',
          actor: 'hermes-test',
          expectedProjectHash: projectHash,
          quarantinedAt: '2026-05-20T01:02:03.000Z'
        }
      });

      expect(await store.getEvent('event-explicit-quarantine')).toBeNull();
      const included = await store.getEvent('event-explicit-quarantine', { includeQuarantined: true });
      expect(included?.metadata).toMatchObject({
        quarantine: {
          status: 'active',
          category: 'retention',
          reason: 'manual-review',
          actor: 'hermes-test',
          expectedProjectHash: projectHash
        }
      });
      expect(included?.metadata?.tags).toContain('quarantine:retention');

      expect((await store.getRecentEvents(10)).map((event) => event.content).join('\n')).not.toContain('EXPLICIT_QUARANTINE_TOKEN');
      expect((await store.keywordSearch('EXPLICIT_QUARANTINE_TOKEN', 10)).map((result) => result.event.id)).toEqual([]);
      expect(await store.countEvents()).toBe(0);
      expect(await store.countEvents({ includeQuarantined: true })).toBe(1);
      expect((await store.getSessionEvents('session-event-explicit-quarantine')).map((event) => event.id)).toEqual([]);
      expect((await store.getSessionEvents('session-event-explicit-quarantine', { includeQuarantined: true })).map((event) => event.id)).toEqual(['event-explicit-quarantine']);

      const rawRow = sqliteGet<{ count: number }>(
        store.getDatabase(),
        `SELECT COUNT(*) AS count FROM events WHERE id = ?`,
        ['event-explicit-quarantine']
      );
      expect(rawRow?.count).toBe(1);

      const audits = sqliteAll<Record<string, unknown>>(
        store.getDatabase(),
        `SELECT * FROM memory_governance_audit WHERE operation = 'quarantine'`
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actor: 'hermes-test',
        project_hash: projectHash,
        target_type: 'event',
        target_id: 'event-explicit-quarantine'
      });
      expect(JSON.parse(String(audits[0].source_event_ids))).toEqual(['source-review-1']);
      const beforeJson = JSON.parse(String(audits[0].before_json));
      const afterJson = JSON.parse(String(audits[0].after_json));
      expect(beforeJson.metadata.quarantine).toBeUndefined();
      expect(JSON.stringify(beforeJson)).not.toContain(projectPath);
      expect(JSON.stringify(afterJson)).not.toContain(projectPath);
      expect(afterJson.metadata.quarantine).toMatchObject({
        status: 'active',
        category: 'retention',
        reason: 'manual-review',
        expectedProjectHash: projectHash
      });
    } finally {
      await store.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('redacts path-shaped and credential-shaped quarantine audit target columns', async () => {
    const { dir, dbPath } = tempDb();
    const store = new SQLiteEventStore(dbPath);
    const projectPath = '/repo/claude-memory-layer';
    const projectHash = hashProjectPath(projectPath);
    const localPath = ['/opt', 'cml-governance-private', 'event-note.txt'].join('/');
    const credentialParam = ['token', 'fixture-value'].join('=');
    const rawEventId = `${localPath}?${credentialParam}`;
    const windowsSourceId = String.raw`C:\Users\fixture-user\source.txt`;

    try {
      await store.importEvents([
        scopedEvent(rawEventId, 'Audit target id should be redacted before persistence', projectHash, projectPath)
      ]);

      const service = new GovernanceService(store.getDatabase());
      await service.quarantine({
        targetType: 'event',
        targetId: rawEventId,
        projectHash,
        actor: 'hermes-test',
        category: 'privacy',
        reason: 'manual-review',
        sourceEventIds: [windowsSourceId, `${localPath}#source?${credentialParam}`]
      });

      const audit = sqliteGet<Record<string, unknown>>(
        store.getDatabase(),
        `SELECT target_id, source_event_ids FROM memory_governance_audit WHERE operation = 'quarantine'`
      );
      const sourceEventIds = JSON.parse(String(audit?.source_event_ids));

      expect(String(audit?.target_id)).not.toContain(localPath);
      expect(String(audit?.target_id)).not.toContain(credentialParam);
      expect(sourceEventIds.join(' ')).not.toContain(localPath);
      expect(sourceEventIds.join(' ')).not.toContain(windowsSourceId);
      expect(sourceEventIds.join(' ')).not.toContain(credentialParam);
      expect(await store.getEvent(rawEventId)).toBeNull();
      expect(await store.getEvent(rawEventId, { includeQuarantined: true })).not.toBeNull();
    } finally {
      await store.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when event metadata changes after validation but before quarantine write', async () => {
    const { dir, dbPath } = tempDb();
    const store = new SQLiteEventStore(dbPath);
    const projectPath = '/repo/claude-memory-layer';
    const projectHash = hashProjectPath(projectPath);
    const otherProjectPath = '/repo/other-project';
    const otherProjectHash = hashProjectPath(otherProjectPath);

    try {
      await store.importEvents([
        scopedEvent('event-stale-write', 'Stale write should roll back without audit', projectHash, projectPath)
      ]);

      const service = new GovernanceService(store.getDatabase(), {
        beforeQuarantineUpdate: () => {
          sqliteRun(
            store.getDatabase(),
            `UPDATE events SET metadata = ? WHERE id = ?`,
            [
              JSON.stringify({
                scope: { project: { hash: otherProjectHash, path: otherProjectPath } },
                tags: [`proj:${otherProjectHash}`]
              }),
              'event-stale-write'
            ]
          );
        }
      });

      await expect(service.quarantine({
        targetType: 'event',
        targetId: 'event-stale-write',
        projectHash,
        actor: 'hermes-test',
        category: 'retention',
        reason: 'manual-review'
      })).rejects.toThrow(/changed during quarantine validation/i);

      const event = await store.getEvent('event-stale-write');
      expect(event?.metadata?.quarantine).toBeUndefined();
      expect(event?.metadata?.scope).toMatchObject({ project: { hash: projectHash } });
      const auditCount = sqliteGet<{ count: number }>(
        store.getDatabase(),
        `SELECT COUNT(*) AS count FROM memory_governance_audit WHERE operation = 'quarantine'`
      );
      expect(auditCount?.count).toBe(0);
    } finally {
      await store.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed for unscoped or cross-project events before metadata or audit mutation', async () => {
    const { dir, dbPath } = tempDb();
    const store = new SQLiteEventStore(dbPath);
    const projectPath = '/repo/claude-memory-layer';
    const projectHash = hashProjectPath(projectPath);
    const otherProjectPath = '/repo/other-project';
    const otherProjectHash = hashProjectPath(otherProjectPath);

    try {
      await store.importEvents([
        unscopedEvent('event-unscoped', 'Unscoped row must not be quarantined by a scoped governance action'),
        scopedEvent('event-foreign', 'Foreign scoped row must not be mutated', otherProjectHash, otherProjectPath)
      ]);

      const service = new GovernanceService(store.getDatabase());
      await expect(service.quarantine({
        targetType: 'event',
        targetId: 'event-unscoped',
        projectHash,
        actor: 'hermes-test',
        reason: 'manual-review'
      })).rejects.toThrow(/project scope/i);
      await expect(service.quarantine({
        targetType: 'event',
        targetId: 'event-foreign',
        projectHash,
        actor: 'hermes-test',
        reason: 'manual-review'
      })).rejects.toThrow(/projectHash mismatch/i);

      expect((await store.getEvent('event-unscoped'))?.metadata?.quarantine).toBeUndefined();
      expect((await store.getEvent('event-foreign'))?.metadata?.quarantine).toBeUndefined();
      const auditCount = sqliteGet<{ count: number }>(
        store.getDatabase(),
        `SELECT COUNT(*) AS count FROM memory_governance_audit WHERE operation = 'quarantine'`
      );
      expect(auditCount?.count).toBe(0);
    } finally {
      await store.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unsafe free-form quarantine reasons before writing metadata or audit rows', async () => {
    const { dir, dbPath } = tempDb();
    const store = new SQLiteEventStore(dbPath);
    const projectPath = '/repo/claude-memory-layer';
    const projectHash = hashProjectPath(projectPath);
    const localPath = ['/opt', 'cml-governance-private', 'note.txt'].join('/');
    const credentialParam = ['token', 'fixture-value'].join('=');

    try {
      await store.importEvents([
        scopedEvent('event-unsafe-reason', 'Unsafe reason should be rejected before quarantine', projectHash, projectPath)
      ]);

      const service = new GovernanceService(store.getDatabase());
      await expect(service.quarantine({
        targetType: 'event',
        targetId: 'event-unsafe-reason',
        projectHash,
        actor: 'hermes-test',
        reason: `manual note ${localPath}?${credentialParam}`
      })).rejects.toThrow(/reason/i);

      expect((await store.getEvent('event-unsafe-reason'))?.metadata?.quarantine).toBeUndefined();
      const auditCount = sqliteGet<{ count: number }>(
        store.getDatabase(),
        `SELECT COUNT(*) AS count FROM memory_governance_audit WHERE operation = 'quarantine'`
      );
      expect(auditCount?.count).toBe(0);
    } finally {
      await store.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
