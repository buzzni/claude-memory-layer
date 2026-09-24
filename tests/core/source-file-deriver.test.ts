import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { EdgeRepo } from '../../src/core/edge-repo.js';
import { EntityRepo } from '../../src/core/entity-repo.js';
import { createSourceFileDeriver } from '../../src/core/derive/source-file-deriver.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import type { MemoryEvent, ToolObservationPayload } from '../../src/core/types.js';

const tempDirs: string[] = [];
const FIXED_TIME = new Date('2026-05-20T00:00:00.000Z');

async function createStore(): Promise<SQLiteEventStore> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-source-file-deriver-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return store;
}

function fakeEvent(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: 'event-1',
    eventType: 'tool_observation',
    sessionId: 's1',
    timestamp: FIXED_TIME,
    content: '',
    canonicalKey: 'event-1',
    dedupeKey: 'event-1',
    ...overrides
  };
}

function editPayload(filePath: string): ToolObservationPayload {
  return {
    toolName: 'Edit',
    toolInput: { file_path: filePath },
    toolOutput: 'ok',
    durationMs: 1,
    success: true,
    metadata: { filePath }
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('createSourceFileDeriver', () => {
  it('creates a source_file entity and a touched_in edge from a tool_observation event', async () => {
    const store = await createStore();
    try {
      const entities = new EntityRepo(store.getDatabase());
      const edges = new EdgeRepo(store.getDatabase());
      const deriver = createSourceFileDeriver({ entities, edges });

      const event = fakeEvent();
      await deriver.deriveFromToolObservation(event, editPayload('/repo/src/foo.ts'), {
        projectHash: 'proj-hash',
        projectPath: '/repo'
      });

      const [entity] = await entities.listByType('source_file');
      expect(entity).toBeDefined();
      expect(entity.title).toBe('src/foo.ts');

      const { incoming } = await edges.findByNode(entity.entityId);
      expect(incoming).toHaveLength(1);
      expect(incoming[0]).toMatchObject({
        srcType: 'event',
        srcId: 'event-1',
        relType: 'touched_in',
        dstType: 'entity',
        dstId: entity.entityId
      });
      expect(incoming[0].metaJson).toMatchObject({
        sessionId: 's1',
        toolName: 'Edit',
        action: 'write',
        weight: 0.8
      });
    } finally {
      await store.close();
    }
  });

  it('is idempotent for the same file across multiple touches (findOrCreate dedup)', async () => {
    const store = await createStore();
    try {
      const entities = new EntityRepo(store.getDatabase());
      const edges = new EdgeRepo(store.getDatabase());
      const deriver = createSourceFileDeriver({ entities, edges });

      await deriver.deriveFromToolObservation(
        fakeEvent({ id: 'event-1' }),
        editPayload('/repo/src/foo.ts'),
        { projectHash: 'proj-hash', projectPath: '/repo' }
      );
      await deriver.deriveFromToolObservation(
        fakeEvent({ id: 'event-2' }),
        editPayload('/repo/src/foo.ts'),
        { projectHash: 'proj-hash', projectPath: '/repo' }
      );

      const sourceFiles = await entities.listByType('source_file');
      expect(sourceFiles).toHaveLength(1);

      const { incoming } = await edges.findByNode(sourceFiles[0].entityId);
      expect(incoming.map((edge) => edge.srcId).sort()).toEqual(['event-1', 'event-2']);
    } finally {
      await store.close();
    }
  });

  it('does nothing when the tool observation has no file path (e.g. Bash without a target file)', async () => {
    const store = await createStore();
    try {
      const entities = new EntityRepo(store.getDatabase());
      const edges = new EdgeRepo(store.getDatabase());
      const deriver = createSourceFileDeriver({ entities, edges });

      await deriver.deriveFromToolObservation(
        fakeEvent(),
        {
          toolName: 'Bash',
          toolInput: { command: 'ls' },
          toolOutput: '',
          durationMs: 1,
          success: true
        },
        { projectHash: 'proj-hash', projectPath: '/repo' }
      );

      expect(await entities.listByType('source_file')).toHaveLength(0);
    } finally {
      await store.close();
    }
  });
});
