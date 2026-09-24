import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VectorRecord } from '../../src/core/types.js';

const mocks = vi.hoisted(() => {
  const tables = new Map<string, {
    add: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    countRows: ReturnType<typeof vi.fn>;
    optimize: ReturnType<typeof vi.fn>;
  }>();

  const makeTable = (name: string) => {
    const existing = tables.get(name);
    if (existing) return existing;
    const table = {
      add: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      countRows: vi.fn().mockResolvedValue(0),
      optimize: vi.fn().mockResolvedValue({})
    };
    tables.set(name, table);
    return table;
  };

  const db = {
    tableNames: vi.fn(),
    openTable: vi.fn((name: string) => Promise.resolve(makeTable(name))),
    createTable: vi.fn((name: string, data: unknown[]) => {
      const table = makeTable(name);
      table.add.mockClear();
      return Promise.resolve(table);
    })
  };

  return {
    tables,
    makeTable,
    db,
    connect: vi.fn()
  };
});

vi.mock('@lancedb/lancedb', () => ({
  connect: mocks.connect
}));

const { VectorStore } = await import('../../src/core/vector-store.js');

function record(overrides: Partial<VectorRecord> = {}): VectorRecord {
  return {
    id: 'record-1',
    eventId: 'event-1',
    sessionId: 'session-1',
    eventType: 'event',
    content: 'private content stays in LanceDB only',
    vector: [0.1, 0.2, 0.3],
    timestamp: '2026-05-25T00:00:00.000Z',
    metadata: {},
    ...overrides
  };
}

describe('VectorStore V2 upsert', () => {
  beforeEach(() => {
    mocks.tables.clear();
    mocks.db.tableNames.mockReset().mockResolvedValue(['conversations']);
    mocks.db.openTable.mockClear();
    mocks.db.createTable.mockClear();
    mocks.connect.mockReset().mockResolvedValue(mocks.db);
  });

  it('updates existing default-table records with delete + add instead of append-only duplicates', async () => {
    const table = mocks.makeTable('conversations');
    const store = new VectorStore('/tmp/cml-vectors');

    await store.upsert(record({ id: "record-'one" }));

    expect(mocks.connect).toHaveBeenCalledWith('/tmp/cml-vectors');
    expect(mocks.db.openTable).toHaveBeenCalledWith('conversations');
    expect(table.delete).toHaveBeenCalledWith("id = 'record-''one'");
    expect(table.add).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "record-'one",
        eventId: 'event-1',
        content: 'private content stays in LanceDB only',
        metadata: '{}'
      })
    ]);
  });

  it('uses deterministic item-kind/version table names for vector outbox records', async () => {
    mocks.db.tableNames.mockResolvedValue([]);
    const store = new VectorStore('/tmp/cml-vectors');

    await store.upsert(record({
      id: 'obs-1',
      eventId: '',
      eventType: 'perspective_observation',
      metadata: {
        itemKind: 'perspective_observation',
        embeddingVersion: 'MiniLM-L6/v2.0',
        sourceEventCount: 2
      }
    }));

    expect(mocks.db.createTable).toHaveBeenCalledWith(
      'perspective_observation_vectors_minilm_l6_v2_0',
      [
        expect.objectContaining({
          id: 'obs-1',
          eventType: 'perspective_observation',
          metadata: JSON.stringify({
            itemKind: 'perspective_observation',
            embeddingVersion: 'MiniLM-L6/v2.0',
            sourceEventCount: 2
          })
        })
      ]
    );
    expect(mocks.db.openTable).not.toHaveBeenCalledWith('conversations');
  });

  it('batch upsert groups records by inferred versioned table and deletes every id in one commit before adding', async () => {
    mocks.db.tableNames.mockResolvedValue(['entry_vectors_v1', 'task_title_vectors_v1']);
    const entryTable = mocks.makeTable('entry_vectors_v1');
    const taskTable = mocks.makeTable('task_title_vectors_v1');
    const store = new VectorStore('/tmp/cml-vectors');

    await store.upsertBatch([
      record({ id: 'entry-1', metadata: { itemKind: 'entry', embeddingVersion: 'v1' } }),
      record({ id: 'entry-2', metadata: { itemKind: 'entry', embeddingVersion: 'v1' } }),
      record({ id: 'task-1', metadata: { itemKind: 'task_title', embeddingVersion: 'v1' } })
    ]);

    expect(mocks.db.openTable).toHaveBeenCalledWith('entry_vectors_v1');
    expect(mocks.db.openTable).toHaveBeenCalledWith('task_title_vectors_v1');
    expect(entryTable.delete).toHaveBeenCalledTimes(1);
    expect(entryTable.delete).toHaveBeenCalledWith("id IN ('entry-1', 'entry-2')");
    expect(entryTable.add).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'entry-1' }),
      expect.objectContaining({ id: 'entry-2' })
    ]);
    expect(taskTable.delete).toHaveBeenCalledWith("id = 'task-1'");
    expect(taskTable.add).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'task-1' })
    ]);
  });

  it('reopens and retries an idempotent upsert after a Lance commit conflict', async () => {
    const table = mocks.makeTable('conversations');
    table.delete.mockRejectedValueOnce(new Error(
      'lance error: Commit conflict: concurrent commit cannot be resolved. Please rerun the operation.'
    ));
    const store = new VectorStore('/tmp/cml-vectors');

    await expect(store.upsert(record())).resolves.toBeUndefined();

    expect(mocks.db.openTable).toHaveBeenCalledTimes(2);
    expect(table.delete).toHaveBeenCalledTimes(2);
    expect(table.add).toHaveBeenCalledTimes(1);
  });

  it('does not retry unrelated Lance write failures', async () => {
    const table = mocks.makeTable('conversations');
    table.delete.mockRejectedValueOnce(new Error('permission denied'));
    const store = new VectorStore('/tmp/cml-vectors');

    await expect(store.upsert(record())).rejects.toThrow('permission denied');

    expect(mocks.db.openTable).toHaveBeenCalledTimes(1);
    expect(table.delete).toHaveBeenCalledTimes(1);
    expect(table.add).not.toHaveBeenCalled();
  });

  it('deleteEventEverywhere removes the event from the legacy table and every event_vectors_* table, but not unrelated tables', async () => {
    mocks.db.tableNames.mockResolvedValue([
      'conversations',
      'event_vectors_v1',
      'event_vectors_minilm_l6_v2_0',
      'task_title_vectors_v1'
    ]);
    const legacyTable = mocks.makeTable('conversations');
    const eventTableV1 = mocks.makeTable('event_vectors_v1');
    const eventTableV2 = mocks.makeTable('event_vectors_minilm_l6_v2_0');
    const taskTable = mocks.makeTable('task_title_vectors_v1');
    const store = new VectorStore('/tmp/cml-vectors');

    await store.deleteEventEverywhere("tool-event-'1");

    expect(legacyTable.delete).toHaveBeenCalledWith("`eventId` = 'tool-event-''1'");
    expect(eventTableV1.delete).toHaveBeenCalledWith("`eventId` = 'tool-event-''1'");
    expect(eventTableV2.delete).toHaveBeenCalledWith("`eventId` = 'tool-event-''1'");
    expect(taskTable.delete).not.toHaveBeenCalled();
  });

  it('deleteEventEverywhere is a no-op when no matching tables exist', async () => {
    mocks.db.tableNames.mockResolvedValue(['task_title_vectors_v1']);
    const taskTable = mocks.makeTable('task_title_vectors_v1');
    const store = new VectorStore('/tmp/cml-vectors');

    await expect(store.deleteEventEverywhere('event-1')).resolves.toBeUndefined();
    expect(taskTable.delete).not.toHaveBeenCalled();
  });
});

describe('VectorStore version pruning', () => {
  beforeEach(() => {
    mocks.tables.clear();
    mocks.db.tableNames.mockReset().mockResolvedValue(['conversations']);
    mocks.db.openTable.mockClear();
    mocks.db.createTable.mockClear();
    mocks.connect.mockReset().mockResolvedValue(mocks.db);
    delete process.env.CLAUDE_MEMORY_LANCE_OPTIMIZE_EVERY;
    delete process.env.CLAUDE_MEMORY_LANCE_VERSION_RETENTION_MS;
  });

  afterEach(() => {
    delete process.env.CLAUDE_MEMORY_LANCE_OPTIMIZE_EVERY;
    delete process.env.CLAUDE_MEMORY_LANCE_VERSION_RETENTION_MS;
  });

  it('prunes superseded versions once the accumulated commit count crosses the threshold', async () => {
    process.env.CLAUDE_MEMORY_LANCE_OPTIMIZE_EVERY = '4';
    const table = mocks.makeTable('conversations');
    const store = new VectorStore('/tmp/cml-vectors');

    // Each upsert is 2 commits (one batched delete + one add).
    await store.upsert(record({ id: 'a' }));
    expect(table.optimize).not.toHaveBeenCalled();

    await store.upsert(record({ id: 'b' }));
    expect(table.optimize).toHaveBeenCalledTimes(1);
    expect(table.optimize).toHaveBeenCalledWith({ cleanupOlderThan: expect.any(Date) });

    // Counter resets, so the next crossing needs another 4 commits.
    await store.upsert(record({ id: 'c' }));
    expect(table.optimize).toHaveBeenCalledTimes(1);
  });

  it('never prunes when the interval is disabled', async () => {
    process.env.CLAUDE_MEMORY_LANCE_OPTIMIZE_EVERY = '0';
    const table = mocks.makeTable('conversations');
    const store = new VectorStore('/tmp/cml-vectors');

    for (let i = 0; i < 10; i++) {
      await store.upsert(record({ id: `id-${i}` }));
    }

    expect(table.optimize).not.toHaveBeenCalled();
  });

  it('keeps the write successful when pruning fails', async () => {
    process.env.CLAUDE_MEMORY_LANCE_OPTIMIZE_EVERY = '1';
    const table = mocks.makeTable('conversations');
    table.optimize.mockRejectedValue(new Error('optimize unavailable'));
    const store = new VectorStore('/tmp/cml-vectors');

    await expect(store.upsert(record())).resolves.toBeUndefined();
    expect(table.add).toHaveBeenCalledTimes(1);
  });

  it('optimizeAll prunes every table so pre-existing version bloat can be reclaimed', async () => {
    mocks.db.tableNames.mockResolvedValue(['conversations', 'event_vectors_v1']);
    const legacyTable = mocks.makeTable('conversations');
    const eventTable = mocks.makeTable('event_vectors_v1');
    const store = new VectorStore('/tmp/cml-vectors');

    await store.optimizeAll();

    expect(legacyTable.optimize).toHaveBeenCalledTimes(1);
    expect(eventTable.optimize).toHaveBeenCalledTimes(1);
  });
});
