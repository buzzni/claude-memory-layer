import { describe, expect, it, vi } from 'vitest';

import { GraduationWorker } from '../../src/core/graduation-worker.js';
import type { EventStore } from '../../src/core/event-store.js';
import { GraduationPipeline, type GraduationPipeline as GraduationPipelineType } from '../../src/core/graduation.js';

function createStore(getEventsByLevel: EventStore['getEventsByLevel']) {
  return {
    getEventsByLevel,
    recordGraduationRun: vi.fn(async () => undefined)
  } as unknown as EventStore & { recordGraduationRun: ReturnType<typeof vi.fn> };
}

describe('GraduationWorker liveness telemetry', () => {
  it('records an aggregate not_eligible attempt when no memories can graduate', async () => {
    const store = createStore(vi.fn(async () => []));
    const worker = new GraduationWorker(store, {} as GraduationPipelineType);

    await expect(worker.forceRun()).resolves.toEqual({ evaluated: 0, graduated: 0, byLevel: {} });
    expect(store.recordGraduationRun).toHaveBeenCalledWith(expect.objectContaining({
      status: 'not_eligible',
      evaluated: 0,
      graduated: 0,
      startedAt: expect.any(Date),
      finishedAt: expect.any(Date)
    }));
  });

  it('records a failed attempt without retaining the thrown error text', async () => {
    const store = createStore(vi.fn(async () => {
      throw new Error('PRIVATE_GRADUATION_FAILURE');
    }));
    const worker = new GraduationWorker(store, {} as GraduationPipelineType);

    await expect(worker.forceRun()).rejects.toThrow('PRIVATE_GRADUATION_FAILURE');
    expect(store.recordGraduationRun).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      evaluated: 0,
      graduated: 0
    }));
    expect(JSON.stringify(store.recordGraduationRun.mock.calls)).not.toContain('PRIVATE_GRADUATION_FAILURE');
  });

  it('hydrates durable access evidence so a fresh bounded worker can promote an eligible event', async () => {
    const eventId = '00000000-0000-4000-8000-000000000001';
    const updateMemoryLevel = vi.fn(async () => undefined);
    const store = {
      getEventsByLevel: vi.fn(async (level: string) => level === 'L0'
        ? [{ id: eventId, eventType: 'user_prompt', sessionId: 'session', timestamp: new Date(), content: 'durable access', canonicalKey: 'access', dedupeKey: 'dedupe' }]
        : []),
      getGraduationMetrics: vi.fn(async () => [{
        eventId,
        accessCount: 1,
        lastAccessed: new Date(),
        crossSessionRefs: 0,
        confidence: 1
      }]),
      updateMemoryLevel,
      recordGraduationRun: vi.fn(async () => undefined)
    } as unknown as EventStore & { recordGraduationRun: ReturnType<typeof vi.fn> };
    const worker = new GraduationWorker(store, new GraduationPipeline(store));

    await expect(worker.forceRun()).resolves.toEqual({ evaluated: 1, graduated: 1, byLevel: { L0: 1 } });
    expect(updateMemoryLevel).toHaveBeenCalledWith(eventId, 'L1');
    expect(store.recordGraduationRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
  });

  it('uses access-prioritized graduation candidates when the store provides them', async () => {
    const eventId = '00000000-0000-4000-8000-000000000002';
    const getEventsByLevel = vi.fn(async () => []);
    const getGraduationCandidates = vi.fn(async (level: string) => level === 'L0'
      ? [{ id: eventId, eventType: 'agent_response', sessionId: 'old-session', timestamp: new Date(0), content: 'old but reused', canonicalKey: 'old', dedupeKey: 'old' }]
      : []);
    const updateMemoryLevel = vi.fn(async () => undefined);
    const store = {
      getEventsByLevel,
      getGraduationCandidates,
      getGraduationMetrics: vi.fn(async () => [{
        eventId,
        accessCount: 1,
        lastAccessed: new Date(),
        crossSessionRefs: 0,
        confidence: 1
      }]),
      updateMemoryLevel,
      recordGraduationRun: vi.fn(async () => undefined)
    } as unknown as EventStore;
    const worker = new GraduationWorker(store, new GraduationPipeline(store));

    await expect(worker.forceRun()).resolves.toEqual({ evaluated: 1, graduated: 1, byLevel: { L0: 1 } });
    expect(getGraduationCandidates).toHaveBeenCalledWith('L0', { limit: 50 });
    expect(getEventsByLevel).not.toHaveBeenCalled();
  });
});
