import { describe, expect, it, vi } from 'vitest';

import { VectorWorker, VectorWorkerV2 } from '../../src/core/vector-worker.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('vector worker batch serialization', () => {
  it('shares one physical legacy batch across overlapping callers', async () => {
    const pending = deferred<never[]>();
    const getPendingOutboxItems = vi.fn(() => pending.promise);
    const worker = new VectorWorker(
      { getPendingOutboxItems } as never,
      {} as never,
      {} as never
    );

    const first = worker.processBatch();
    const second = worker.processBatch();

    expect(getPendingOutboxItems).toHaveBeenCalledTimes(1);
    pending.resolve([]);
    await expect(Promise.all([first, second])).resolves.toEqual([0, 0]);
  });

  it('shares one physical V2 batch across overlapping callers', async () => {
    const pending = deferred<never[]>();
    const claimJobs = vi.fn(() => pending.promise);
    const worker = new VectorWorkerV2(
      {} as never,
      {} as never,
      {} as never
    );
    (worker as unknown as { outbox: { claimJobs: typeof claimJobs } }).outbox = { claimJobs };

    const first = worker.processBatch();
    const second = worker.processBatch();

    expect(claimJobs).toHaveBeenCalledTimes(1);
    pending.resolve([]);
    await expect(Promise.all([first, second])).resolves.toEqual([0, 0]);
  });

  it.each([
    ['legacy', () => new VectorWorker({} as never, {} as never, {} as never)],
    ['V2', () => new VectorWorkerV2({} as never, {} as never, {} as never)]
  ])('stops draining %s work after the active batch completes during shutdown', async (_kind, createWorker) => {
    const worker = createWorker();
    let resolveFirst!: (value: number) => void;
    const first = new Promise<number>(resolve => {
      resolveFirst = resolve;
    });
    const processBatch = vi.spyOn(worker, 'processBatch')
      .mockImplementationOnce(() => first)
      .mockResolvedValue(1);

    const draining = worker.processAll();
    worker.stop();
    resolveFirst(1);

    await expect(draining).resolves.toBe(1);
    expect(processBatch).toHaveBeenCalledTimes(1);
  });
});
