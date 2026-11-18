import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { Matcher } from '../../src/core/matcher.js';
import { LessonRepository } from '../../src/core/operations/lesson-repository.js';
import { Retriever } from '../../src/core/retriever.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteAll } from '../../src/core/sqlite-wrapper.js';
import { VectorOutbox } from '../../src/core/vector-outbox.js';
import { VectorStore } from '../../src/core/vector-store.js';
import { VectorWorker, VectorWorkerV2 } from '../../src/core/vector-worker.js';
import { DISABLED_SHARED_STORE_CONFIG, MemoryService } from '../../src/services/memory-service.js';
import { SessionHistoryImporter } from '../../src/services/session-history-importer.js';

/**
 * #250, the vector part: a force reimport deleted the imported rows in SQLite
 * and put them back under new ids, but left the old rows' vectors in LanceDB,
 * in the legacy conversations table and in event_vectors_* tables. Each one
 * belonged to no event, took a search candidate slot and disk. The reimport
 * must delete exactly the vectors of the rows it deleted, keep those of the
 * rows it keeps, and the rows it puts back get one vector each.
 */

vi.mock('../../src/adapters/claude/hooks/semantic-daemon-client.js', () => ({
  scheduleSessionSummary: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('../../src/adapters/llm/session-summary-llm.js', () => ({ isLlmSummaryEnabled: () => false }));

// The vector outbox (event_vectors_* tables) is an opt-in SQLiteEventStore
// option nothing in MemoryService turns on; this turns it on for every
// writable store a test opens, the service's included.
const fixture = vi.hoisted(() => ({ vectorOutbox: false }));
vi.mock('../../src/core/sqlite-event-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/sqlite-event-store.js')>();
  class SQLiteEventStore extends actual.SQLiteEventStore {
    constructor(dbPath: string, options?: ConstructorParameters<typeof actual.SQLiteEventStore>[1]) {
      super(dbPath, fixture.vectorOutbox && !options?.readonly ? { ...options, vectorOutbox: options?.vectorOutbox ?? {} } : options);
    }
  }
  return { ...actual, SQLiteEventStore };
});

const SESSION = 'force-reimport-vectors';
const PAIRS = 3;

/** A vector that only the text decides, so the same text finds the same vector. */
function embedText(text: string): number[] {
  const vector = Array.from({ length: 8 }, (_, i) => 1 + [...text].reduce((sum, char, j) => sum + (j % 8 === i ? char.charCodeAt(0) : 0), 0) % 97);
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}

const embedder = {
  embed: async (text: string) => ({ vector: embedText(text) }),
  embedBatch: async (texts: string[]) => texts.map((text) => ({ vector: embedText(text) }))
};

let root = '';
let storagePath = '';
let transcriptPath = '';
let service: MemoryService | undefined;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'cml-force-reimport-vectors-'));
  storagePath = path.join(root, 'store');
  transcriptPath = path.join(root, `${SESSION}.jsonl`);
  vi.stubEnv('HOME', root);
  knownIds.clear();
  fixture.vectorOutbox = false;
  service = undefined;
  for (let i = 0; i < PAIRS; i++) {
    appendFileSync(transcriptPath, `${JSON.stringify({
      sessionId: SESSION, type: 'user', timestamp: new Date(Date.UTC(2026, 9, 1, 9, i, 0)).toISOString(),
      message: { role: 'user', content: `please review release step number ${i}` }
    })}\n`, 'utf8');
    appendFileSync(transcriptPath, `${JSON.stringify({
      sessionId: SESSION, type: 'assistant', timestamp: new Date(Date.UTC(2026, 9, 1, 9, i, 30)).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: `Step ${i}: the release guard checks the tag.` }] }
    })}\n`, 'utf8');
  }
});

afterEach(async () => {
  await service?.shutdown();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function startService(options: { vectorOutbox?: boolean } = {}): MemoryService {
  fixture.vectorOutbox = options.vectorOutbox ?? false;
  service = new MemoryService({
    storagePath,
    projectHash: 'force-reimport-vectors-project',
    lightweightMode: true,
    analyticsEnabled: false,
    sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG
  });
  return service;
}

function importSession(options: { force?: boolean } = {}) {
  return new SessionHistoryImporter(service!).importSessionFile(transcriptPath, options);
}

/** A second connection to the same store, as the daemon or another hook has. */
async function withStore<T>(fn: (store: SQLiteEventStore) => Promise<T>): Promise<T> {
  const store = new SQLiteEventStore(path.join(storagePath, 'events.sqlite'));
  await store.initialize();
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}

/** A new VectorStore each time: a table handle opened earlier would not see another instance's commits. */
function vectorStore(): VectorStore {
  return new VectorStore(path.join(storagePath, 'vectors'));
}

/** Embed every queued job: embedding_outbox into conversations, vector_outbox into event_vectors_*. */
async function embedPending(): Promise<void> {
  await withStore(async (store) => {
    const vectors = vectorStore();
    await new VectorWorker(store as never, vectors, embedder as never).processAll();
    await new VectorWorkerV2(store.getDatabase() as never, vectors, embedder as never).processAll();
  });
}

const knownIds = new Set<string>();

async function rows(): Promise<Array<{ id: string; eventType: string; content: string; importedFrom?: unknown }>> {
  const events = await withStore((store) => store.getSessionEvents(SESSION));
  for (const event of events) knownIds.add(event.id);
  return events.map((event) => ({ id: event.id, eventType: event.eventType, content: event.content, importedFrom: event.metadata?.importedFrom }));
}

/** Event ids that have a vector, per table, ids sorted (a repeated id shows up twice). */
async function vectorIdsByTable(): Promise<Record<string, string[]>> {
  const vectors = vectorStore();
  const tables = ['conversations', ...await vectors.listSpareEventTables()];
  const byTable: Record<string, string[]> = {};
  for (const table of tables) {
    byTable[table] = (await vectors.readRowsByEventIds(table, [...knownIds])).map((row) => row.eventId).sort();
  }
  return byTable;
}

function jobsFor(eventIds: string[]): Promise<Array<{ queue: string; id: string }>> {
  return withStore(async (store) => {
    const db = store.getDatabase();
    const placeholders = eventIds.map(() => '?').join(', ');
    return [
      ...sqliteAll<{ id: string }>(db, `SELECT event_id AS id FROM embedding_outbox WHERE event_id IN (${placeholders})`, eventIds)
        .map((row) => ({ queue: 'embedding_outbox', id: row.id })),
      ...sqliteAll<{ id: string }>(db, `SELECT item_id AS id FROM vector_outbox WHERE item_kind = 'event' AND item_id IN (${placeholders})`, eventIds)
        .map((row) => ({ queue: 'vector_outbox', id: row.id }))
    ];
  });
}

/**
 * The imported session, the rows the hooks wrote, a row pulled from another
 * machine and a row a lesson cites, each with a vector in conversations and,
 * as on a store that has or once had the vector outbox on, in event_vectors_*.
 */
async function seedEmbeddedSession(options: { vectorOutbox?: boolean } = {}) {
  const memoryService = startService(options);
  expect(await importSession()).toMatchObject({ importedPrompts: PAIRS, importedResponses: PAIRS, errors: [] });
  await memoryService.storeSessionSummary(SESSION, 'Reviewed every release step and fixed the tag guard.');
  await memoryService.storeToolObservation(SESSION, { toolName: 'Bash', toolInput: {}, toolOutput: 'ok', durationMs: 1, success: true });
  await withStore(async (store) => {
    const append = async (content: string, metadata: Record<string, unknown>) => {
      const result = await store.append({ eventType: 'agent_response', sessionId: SESSION, timestamp: new Date(), content, metadata });
      if (!result.success) throw new Error(result.error);
      await store.enqueueForEmbedding(result.eventId, content);
      return result.eventId;
    };
    await append('Pulled from the other laptop.', { importedFrom: transcriptPath, mongoSync: { remoteId: 'r1' } });
    const cited = await append('The guard must compare the tag with package.json.', { importedFrom: transcriptPath });
    await new LessonRepository(store.getDatabase()).upsert({
      projectHash: 'force-reimport-vectors-project', name: 'Release guard', trigger: 'When releasing', steps: ['Check the tag'],
      confidence: 0.8, sourceSessionIds: [SESSION], sourceEventIds: [cited], failureModes: [], skillCandidate: false, actor: 'tester'
    });
    const outbox = new VectorOutbox(store.getDatabase(), {});
    for (const event of await store.getSessionEvents(SESSION)) {
      if (event.eventType !== 'tool_observation') outbox.enqueueSync('event', event.id);
    }
  });
  await embedPending();

  const before = await rows();
  // What a force reimport from this transcript puts back: its own prompts and responses.
  const reimported = before.filter((row) => row.importedFrom === transcriptPath && /please review|^Step /.test(row.content));
  const kept = before.filter((row) => !reimported.includes(row));
  expect(reimported).toHaveLength(PAIRS * 2);
  expect(kept.map((row) => row.eventType).sort()).toEqual(['agent_response', 'agent_response', 'session_summary', 'tool_observation']);
  return { before, reimported, kept };
}

describe('force reimport and vectors (#250)', () => {
  for (const vectorOutbox of [false, true]) {
    it(`deletes the vectors and jobs of exactly the rows it deleted, keeps the others, and embeds the new rows once (vector outbox ${vectorOutbox ? 'on' : 'off'})`, async () => {
      const { before, reimported, kept } = await seedEmbeddedSession({ vectorOutbox });
      const vectorsBefore = await vectorIdsByTable();
      // Tool observations are never embedded: the summary and the two kept responses are.
      const embeddedKept = kept.filter((row) => row.eventType !== 'tool_observation');
      const eventTables = Object.keys(vectorsBefore).filter((table) => table.startsWith('event_vectors_'));
      expect(eventTables).toHaveLength(1);
      expect(vectorsBefore).toEqual({
        conversations: [...reimported, ...embeddedKept].map((row) => row.id).sort(),
        [eventTables[0]]: [...reimported, ...embeddedKept].map((row) => row.id).sort()
      });

      expect(await importSession({ force: true })).toMatchObject({ importedPrompts: PAIRS, importedResponses: PAIRS, errors: [] });

      const after = await rows();
      const recreated = after.filter((row) => !before.some((old) => old.id === row.id));
      expect(recreated.map((row) => row.content).sort()).toEqual(reimported.map((row) => row.content).sort());
      expect(after.filter((row) => before.some((old) => old.id === row.id)).map((row) => row.id).sort())
        .toEqual(kept.map((row) => row.id).sort());

      // No vector and no job left for a deleted row; the kept rows' vectors are untouched.
      expect(await vectorIdsByTable()).toEqual({
        conversations: embeddedKept.map((row) => row.id).sort(),
        [eventTables[0]]: embeddedKept.map((row) => row.id).sort()
      });
      expect(await jobsFor(reimported.map((row) => row.id))).toEqual([]);
      // The rows put back are queued for embedding like any new row, in the vector outbox too when it is on.
      const recreatedJobs = await jobsFor(recreated.map((row) => row.id));
      expect(recreatedJobs.filter((job) => job.queue === 'embedding_outbox')).toHaveLength(recreated.length);
      expect(recreatedJobs.filter((job) => job.queue === 'vector_outbox')).toHaveLength(vectorOutbox ? recreated.length : 0);

      await embedPending();

      // One vector per event: as many as before the reimport, the new ids in place of the old.
      const vectorsAfter = await vectorIdsByTable();
      expect(vectorsAfter.conversations).toEqual([...recreated, ...embeddedKept].map((row) => row.id).sort());
      expect(vectorsAfter.conversations).toHaveLength(vectorsBefore.conversations.length);
      expect(vectorsAfter[eventTables[0]]).toEqual((vectorOutbox ? [...recreated, ...embeddedKept] : embeddedKept).map((row) => row.id).sort());
    });
  }

  it('does not fail the reimport when the vectors cannot be deleted, and search does not return the vectors left behind', async () => {
    const { reimported } = await seedEmbeddedSession();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(VectorStore.prototype, 'deleteEvents').mockRejectedValue(new Error('lance is locked'));

    expect(await importSession({ force: true })).toMatchObject({ importedPrompts: PAIRS, importedResponses: PAIRS, errors: [] });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`session ${SESSION}`), 'lance is locked');
    const orphaned = reimported.map((row) => row.id);
    expect((await vectorIdsByTable()).conversations).toEqual(expect.arrayContaining(orphaned));
    await embedPending();

    // The old and the new row of the same text have the same vector; only the new one is found.
    const target = reimported.find((row) => row.content.startsWith('Step 1'))!;
    const recreated = (await rows()).find((row) => row.content === target.content && row.id !== target.id)!;
    await withStore(async (store) => {
      const retriever = new Retriever(store, vectorStore(), embedder as never, new Matcher());
      const out = await retriever.retrieve(target.content, { strategy: 'deep', topK: 3, minScore: 0.5, includeSessionContext: false });
      const ids = out.memories.map((memory) => memory.event.id);
      expect(ids[0]).toBe(recreated.id);
      expect(ids.filter((id) => orphaned.includes(id))).toEqual([]);
    });
  });
});
