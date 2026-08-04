import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { CoreMemoryBlockRepository } from '../../src/core/operations/core-memory-block-repository.js';
import { sqliteAll } from '../../src/core/sqlite-wrapper.js';
import { CORE_MEMORY_BLOCK_MAX_CHARS, UpsertCoreMemoryBlockInputSchema } from '../../src/core/types.js';

const tempDirs: string[] = [];

async function createFixture(): Promise<{ store: SQLiteEventStore; repo: CoreMemoryBlockRepository }> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-core-memory-block-repo-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return { store, repo: new CoreMemoryBlockRepository(store.getDatabase()) };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('UpsertCoreMemoryBlockInputSchema', () => {
  it('rejects content longer than the max character cap', () => {
    expect(() => UpsertCoreMemoryBlockInputSchema.parse({
      blockKey: 'project',
      content: 'x'.repeat(CORE_MEMORY_BLOCK_MAX_CHARS + 1),
      sourceEventIds: []
    })).toThrow();
  });

  it('rejects an unknown block key', () => {
    expect(() => UpsertCoreMemoryBlockInputSchema.parse({
      blockKey: 'scratch',
      content: 'hello',
      sourceEventIds: []
    })).toThrow();
  });
});

describe('CoreMemoryBlockRepository', () => {
  it('creates a block, returns it via get and listByProject', async () => {
    const { store, repo } = await createFixture();
    try {
      const created = await repo.upsert({
        projectHash: 'proj-1',
        blockKey: 'project',
        content: 'This project uses SQLite + LanceDB; prefer plain function edits over new abstractions.',
        sourceEventIds: ['event-1'],
        updatedBy: 'agent'
      });

      expect(created.blockKey).toBe('project');
      expect(created.projectHash).toBe('proj-1');

      const fetched = await repo.get({ projectHash: 'proj-1', blockKey: 'project' });
      expect(fetched).toMatchObject({ content: created.content });

      const listed = await repo.listByProject('proj-1');
      expect(listed).toHaveLength(1);
      expect(listed[0].blockKey).toBe('project');
    } finally {
      await store.close();
    }
  });

  it('updates in place (upsert) rather than creating a duplicate row', async () => {
    const { store, repo } = await createFixture();
    try {
      await repo.upsert({
        projectHash: 'proj-1',
        blockKey: 'project',
        content: 'first version',
        sourceEventIds: [],
        updatedBy: 'agent'
      });
      const updated = await repo.upsert({
        projectHash: 'proj-1',
        blockKey: 'project',
        content: 'second version',
        sourceEventIds: [],
        updatedBy: 'agent'
      });

      expect(updated.content).toBe('second version');
      const listed = await repo.listByProject('proj-1');
      expect(listed).toHaveLength(1);
      expect(listed[0].content).toBe('second version');
    } finally {
      await store.close();
    }
  });

  it('keeps project and user blocks independent, and scopes by project hash', async () => {
    const { store, repo } = await createFixture();
    try {
      await repo.upsert({ projectHash: 'proj-1', blockKey: 'project', content: 'proj-1 project block', sourceEventIds: [] });
      await repo.upsert({ projectHash: 'proj-1', blockKey: 'user', content: 'proj-1 user block', sourceEventIds: [] });
      await repo.upsert({ projectHash: 'proj-2', blockKey: 'project', content: 'proj-2 project block', sourceEventIds: [] });

      const proj1Blocks = await repo.listByProject('proj-1');
      expect(proj1Blocks.map((b) => b.blockKey).sort()).toEqual(['project', 'user']);

      const proj2Blocks = await repo.listByProject('proj-2');
      expect(proj2Blocks).toHaveLength(1);
      expect(proj2Blocks[0].content).toBe('proj-2 project block');
    } finally {
      await store.close();
    }
  });

  it('writes an audited governance trail entry with before/after snapshots on update', async () => {
    const { store, repo } = await createFixture();
    try {
      await repo.upsert({
        projectHash: 'proj-1',
        blockKey: 'project',
        content: 'first version',
        sourceEventIds: [],
        updatedBy: 'agent-a'
      });
      await repo.upsert({
        projectHash: 'proj-1',
        blockKey: 'project',
        content: 'second version',
        sourceEventIds: [],
        updatedBy: 'agent-b'
      });

      const rows = sqliteAll<{ operation: string; actor: string; before_json: string | null; after_json: string | null }>(
        store.getDatabase(),
        `SELECT operation, actor, before_json, after_json FROM memory_governance_audit
         WHERE target_type = 'core_memory_block' ORDER BY created_at ASC`
      );

      expect(rows).toHaveLength(2);
      expect(rows[0].operation).toBe('core_memory_block_update');
      expect(rows[0].before_json).toBeNull();
      expect(JSON.parse(rows[0].after_json!)).toMatchObject({ content: 'first version' });

      expect(rows[1].actor).toBe('agent-b');
      expect(JSON.parse(rows[1].before_json!)).toMatchObject({ content: 'first version' });
      expect(JSON.parse(rows[1].after_json!)).toMatchObject({ content: 'second version' });
    } finally {
      await store.close();
    }
  });

  it('accepts empty content so a stale block can be retired (session start skips empty blocks)', async () => {
    const { store, repo } = await createFixture();
    try {
      await repo.upsert({
        projectHash: 'proj-1',
        blockKey: 'project',
        content: 'stale guidance that no longer applies',
        sourceEventIds: [],
        updatedBy: 'agent'
      });

      const cleared = await repo.upsert({
        projectHash: 'proj-1',
        blockKey: 'project',
        content: '',
        sourceEventIds: [],
        updatedBy: 'agent'
      });

      expect(cleared.content).toBe('');
      const fetched = await repo.get({ projectHash: 'proj-1', blockKey: 'project' });
      expect(fetched?.content).toBe('');
    } finally {
      await store.close();
    }
  });

  it('get returns null when no blockKey is supplied or nothing was stored', async () => {
    const { store, repo } = await createFixture();
    try {
      expect(await repo.get({ projectHash: 'proj-1' })).toBeNull();
      expect(await repo.get({ projectHash: 'proj-1', blockKey: 'project' })).toBeNull();
    } finally {
      await store.close();
    }
  });
});
