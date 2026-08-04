import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { EntityRepo } from '../../src/core/entity-repo.js';

const tempDirs: string[] = [];

async function createFixture(): Promise<{ store: SQLiteEventStore; entities: EntityRepo }> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-entity-find-or-create-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return { store, entities: new EntityRepo(store.getDatabase()) };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('EntityRepo.findOrCreate', () => {
  it('returns the existing entity on a second call instead of creating a duplicate', async () => {
    const { store, entities } = await createFixture();
    try {
      const first = await entities.findOrCreate({
        entityType: 'source_file', title: 'src/foo.ts', project: 'proj-1', currentJson: { path: 'src/foo.ts' }
      });
      const second = await entities.findOrCreate({
        entityType: 'source_file', title: 'src/foo.ts', project: 'proj-1', currentJson: { path: 'src/foo.ts' }
      });

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.entity.entityId).toBe(first.entity.entityId);
    } finally {
      await store.close();
    }
  });

  it('converges on the alias winner when a concurrent racer already claimed the canonical key', async () => {
    const { store, entities } = await createFixture();
    try {
      // Racer A wins the entity_aliases PK first.
      const winner = await entities.create({
        entityType: 'source_file', title: 'src/foo.ts', project: 'proj-1', currentJson: { path: 'src/foo.ts' }
      });

      // Racer B got past its own lookup before A committed, so it still calls
      // create(); it must resolve back to A rather than returning its own row.
      const raced = await entities.findOrCreate({
        entityType: 'source_file', title: 'src/foo.ts', project: 'proj-1', currentJson: { path: 'src/foo.ts' }
      });

      expect(raced.entity.entityId).toBe(winner.entityId);
      expect(raced.created).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('keeps the same file path in different projects as distinct entities', async () => {
    const { store, entities } = await createFixture();
    try {
      const a = await entities.findOrCreate({
        entityType: 'source_file', title: 'src/foo.ts', project: 'proj-1', currentJson: {}
      });
      const b = await entities.findOrCreate({
        entityType: 'source_file', title: 'src/foo.ts', project: 'proj-2', currentJson: {}
      });

      expect(b.created).toBe(true);
      expect(b.entity.entityId).not.toBe(a.entity.entityId);
    } finally {
      await store.close();
    }
  });
});
