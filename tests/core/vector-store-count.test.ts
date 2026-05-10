import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const table = {
    countRows: vi.fn()
  };
  const db = {
    tableNames: vi.fn(),
    openTable: vi.fn()
  };

  return {
    table,
    db,
    connect: vi.fn()
  };
});

vi.mock('@lancedb/lancedb', () => ({
  connect: mocks.connect
}));

const { VectorStore } = await import('../../src/core/vector-store.js');

describe('VectorStore.count', () => {
  beforeEach(() => {
    mocks.table.countRows.mockReset().mockResolvedValue(51);
    mocks.db.tableNames.mockReset().mockResolvedValue(['conversations']);
    mocks.db.openTable.mockReset().mockResolvedValue(mocks.table);
    mocks.connect.mockReset().mockResolvedValue(mocks.db);
  });

  it('initializes the vector table before counting rows', async () => {
    const store = new VectorStore('/tmp/cml-vectors');

    await expect(store.count()).resolves.toBe(51);

    expect(mocks.connect).toHaveBeenCalledWith('/tmp/cml-vectors');
    expect(mocks.db.openTable).toHaveBeenCalledWith('conversations');
    expect(mocks.table.countRows).toHaveBeenCalledTimes(1);
  });

  it('returns zero when the conversations table does not exist yet', async () => {
    mocks.db.tableNames.mockResolvedValue([]);
    const store = new VectorStore('/tmp/cml-empty-vectors');

    await expect(store.count()).resolves.toBe(0);

    expect(mocks.connect).toHaveBeenCalledWith('/tmp/cml-empty-vectors');
    expect(mocks.table.countRows).not.toHaveBeenCalled();
  });
});
