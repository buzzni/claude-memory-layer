import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { Matcher } from '../../src/core/matcher.js';
import { Retriever } from '../../src/core/retriever.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteRun } from '../../src/core/sqlite-wrapper.js';
import type { MemoryEvent } from '../../src/core/types.js';

const tempDirs: string[] = [];
const FIXED_TIME = new Date('2026-05-20T00:00:00.000Z');

async function createStore(): Promise<SQLiteEventStore> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-retriever-file-link-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return store;
}

async function appendEvent(store: SQLiteEventStore, input: {
  content: string;
  eventType?: MemoryEvent['eventType'];
  sessionId?: string;
}): Promise<string> {
  const result = await store.append({
    eventType: input.eventType ?? 'agent_response',
    sessionId: input.sessionId ?? 's1',
    timestamp: FIXED_TIME,
    content: input.content,
    metadata: {}
  });
  if (!result.success) {
    throw new Error('error' in result ? result.error : 'append failed');
  }
  return result.eventId;
}

function insertSourceFileEntity(store: SQLiteEventStore, input: { entityId: string; canonicalKey: string; title: string }): void {
  sqliteRun(
    store.getDatabase(),
    `INSERT INTO entities (
      entity_id, entity_type, canonical_key, title, stage, status,
      current_json, title_norm, search_text, created_at, updated_at
    ) VALUES (?, 'source_file', ?, ?, 'raw', 'active', ?, ?, ?, ?, ?)`,
    [
      input.entityId,
      input.canonicalKey,
      input.title,
      JSON.stringify({ path: input.title }),
      input.title.toLowerCase(),
      input.title,
      FIXED_TIME.toISOString(),
      FIXED_TIME.toISOString()
    ]
  );
}

function insertTouchedInEdge(store: SQLiteEventStore, input: { edgeId: string; eventId: string; entityId: string; sessionId: string }): void {
  sqliteRun(
    store.getDatabase(),
    `INSERT INTO edges (edge_id, src_type, src_id, rel_type, dst_type, dst_id, meta_json, created_at)
     VALUES (?, 'event', ?, 'touched_in', 'entity', ?, ?, ?)`,
    [
      input.edgeId,
      input.eventId,
      input.entityId,
      JSON.stringify({ sessionId: input.sessionId, toolName: 'Edit', action: 'write', weight: 0.8 }),
      FIXED_TIME.toISOString()
    ]
  );
}

function createRetriever(store: SQLiteEventStore, sessionFileLinkEnabled = true): Retriever {
  const fakeVectorStore = { async search() { return []; } };
  const fakeEmbedder = { async embed() { return { vector: [0.1, 0.2] }; } };
  return new Retriever(store as any, fakeVectorStore as any, fakeEmbedder as any, new Matcher(), { sessionFileLinkEnabled });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Retriever session-file-link expansion (codify-lite)', () => {
  it('surfaces a past memory linked to a file the current session is touching', async () => {
    const store = await createStore();
    try {
      const pastEventId = await appendEvent(store, {
        content: 'Retry logic was added here because npm publish flaked under CI load.',
        sessionId: 's-past'
      });
      insertSourceFileEntity(store, {
        entityId: 'entity-file-release-script',
        canonicalKey: 'file:proj:abc123',
        title: 'scripts/release-npm.sh'
      });
      insertTouchedInEdge(store, {
        edgeId: 'edge-past-touch',
        eventId: pastEventId,
        entityId: 'entity-file-release-script',
        sessionId: 's-past'
      });
      insertTouchedInEdge(store, {
        edgeId: 'edge-current-touch',
        eventId: await appendEvent(store, { content: 'Editing release script now.', sessionId: 's-current' }),
        entityId: 'entity-file-release-script',
        sessionId: 's-current'
      });

      const out = await createRetriever(store, true).retrieve('unrelated query text', {
        strategy: 'fast',
        topK: 5,
        includeSessionContext: false,
        sessionId: 's-current',
        graphHop: { enabled: true, maxHops: 1, hopPenalty: 0.1 }
      });

      expect(out.memories.map((memory) => memory.event.id)).toContain(pastEventId);
    } finally {
      await store.close();
    }
  });

  it('resolves the session-file lookup through an index instead of scanning touched_in edges', async () => {
    const store = await createStore();
    try {
      const plan = store.getDatabase().prepare(
        `EXPLAIN QUERY PLAN
         SELECT DISTINCT dst_id FROM edges
         WHERE rel_type = 'touched_in' AND src_type = 'event' AND dst_type = 'entity'
           AND json_extract(meta_json, '$.sessionId') = ?
         LIMIT 20`
      ).all('s-current') as Array<{ detail: string }>;

      const details = plan.map((row) => row.detail).join(' | ');
      expect(details).toContain('idx_edges_touched_in_session');
      expect(details).not.toContain('SCAN edges');
    } finally {
      await store.close();
    }
  });

  it('does not expand via session-file-link when disabled', async () => {
    const store = await createStore();
    try {
      const pastEventId = await appendEvent(store, {
        content: 'Retry logic was added here because npm publish flaked under CI load.',
        sessionId: 's-past'
      });
      insertSourceFileEntity(store, {
        entityId: 'entity-file-release-script',
        canonicalKey: 'file:proj:abc123',
        title: 'scripts/release-npm.sh'
      });
      insertTouchedInEdge(store, {
        edgeId: 'edge-past-touch',
        eventId: pastEventId,
        entityId: 'entity-file-release-script',
        sessionId: 's-past'
      });
      insertTouchedInEdge(store, {
        edgeId: 'edge-current-touch',
        eventId: await appendEvent(store, { content: 'Editing release script now.', sessionId: 's-current' }),
        entityId: 'entity-file-release-script',
        sessionId: 's-current'
      });

      const out = await createRetriever(store, false).retrieve('unrelated query text', {
        strategy: 'fast',
        topK: 5,
        includeSessionContext: false,
        sessionId: 's-current',
        graphHop: { enabled: true, maxHops: 1, hopPenalty: 0.1 }
      });

      expect(out.memories.map((memory) => memory.event.id)).not.toContain(pastEventId);
    } finally {
      await store.close();
    }
  });
});
