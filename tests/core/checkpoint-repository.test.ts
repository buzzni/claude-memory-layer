import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { CheckpointRepository } from '../../src/core/operations/checkpoint-repository.js';
import { sqliteAll, sqliteGet } from '../../src/core/sqlite-wrapper.js';

const tempDirs: string[] = [];

async function createFixture(): Promise<{ store: SQLiteEventStore; repo: CheckpointRepository; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-checkpoint-repo-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return { store, repo: new CheckpointRepository(store.getDatabase()), cleanup: async () => store.close() };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('CheckpointRepository', () => {
  it('creates redacted project-scoped checkpoints and writes audit entries', async () => {
    const { store, repo, cleanup } = await createFixture();

    const checkpoint = await repo.create({
      projectHash: 'project-1',
      actionId: 'action-1',
      sessionId: 'session-1',
      title: 'Phase handoff',
      summary: 'Ready to resume',
      stateJson: {
        next: 'run tests',
        token: 'fixture',
        nested: { localPath: ['/Users', 'fixture-user', 'note.md'].join('/') }
      },
      sourceEventIds: ['event-1'],
      actor: 'tester'
    });

    const row = sqliteGet<Record<string, unknown>>(
      store.getDatabase(),
      `SELECT state_json, source_event_ids FROM memory_checkpoints WHERE checkpoint_id = ?`,
      [checkpoint.checkpointId]
    );
    const auditRows = sqliteAll<Record<string, unknown>>(
      store.getDatabase(),
      `SELECT operation, target_type, target_id FROM memory_governance_audit WHERE target_type = 'checkpoint'`
    );
    await cleanup();

    const state = JSON.parse(String(row?.state_json));
    expect(checkpoint.stateJson.token).toBe('[REDACTED]');
    expect(String(state.nested.localPath)).not.toContain('fixture-user');
    expect(JSON.parse(String(row?.source_event_ids))).toEqual(['event-1']);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].operation).toBe('checkpoint_create');
    expect(auditRows[0].target_id).toBe(checkpoint.checkpointId);
  });

  it('lists checkpoints by project, action, and session without cross-project leakage', async () => {
    const { repo, cleanup } = await createFixture();
    await repo.create({
      projectHash: 'project-1',
      actionId: 'action-1',
      sessionId: 'session-1',
      title: 'Keep',
      summary: 'Project one checkpoint',
      stateJson: { step: 1 }
    });
    await repo.create({
      projectHash: 'project-1',
      actionId: 'action-2',
      sessionId: 'session-2',
      title: 'Other action',
      summary: 'Project one other checkpoint',
      stateJson: { step: 2 }
    });
    await repo.create({
      projectHash: 'project-2',
      actionId: 'action-1',
      sessionId: 'session-1',
      title: 'Leak candidate',
      summary: 'Different project checkpoint',
      stateJson: { step: 3 }
    });

    const byAction = await repo.list({ projectHash: 'project-1', actionId: 'action-1' });
    const bySession = await repo.list({ projectHash: 'project-1', sessionId: 'session-1' });
    await cleanup();

    expect(byAction.map((checkpoint) => checkpoint.title)).toEqual(['Keep']);
    expect(bySession.map((checkpoint) => checkpoint.title)).toEqual(['Keep']);
  });
});
