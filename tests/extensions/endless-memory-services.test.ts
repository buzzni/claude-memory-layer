import { describe, expect, it } from 'vitest';

import {
  createEndlessMemoryServices,
  type EndlessMemoryServicesFactories
} from '../../src/core/engine/endless-memory-services.js';
import type { EventStore } from '../../src/core/event-store.js';
import type {
  ConsolidatedMemory,
  EndlessModeConfig,
  MemoryEvent,
  WorkingSet
} from '../../src/core/types.js';

function event(id: string): MemoryEvent {
  return {
    id,
    sessionId: 'session-1',
    eventType: 'agent_response',
    content: `event ${id}`,
    canonicalKey: `event/${id}`,
    dedupeKey: `session-1:${id}`,
    timestamp: new Date('2026-05-02T00:00:00.000Z'),
    metadata: {}
  };
}

function consolidated(memoryId: string): ConsolidatedMemory {
  return {
    memoryId,
    summary: `summary ${memoryId}`,
    topics: ['thin-core'],
    sourceEvents: ['event-1'],
    confidence: 0.9,
    createdAt: new Date('2026-05-02T00:00:00.000Z'),
    accessCount: 0
  };
}

function makeHarness(options?: { savedMode?: 'session' | 'endless'; savedConfig?: EndlessModeConfig }) {
  let initializeCalls = 0;
  const starts: string[] = [];
  const stops: string[] = [];
  const activity: string[] = [];
  const forced: string[] = [];
  const added: Array<{ eventId: string; relevanceScore?: number }> = [];
  const searches: Array<{ query: string; options?: { topK?: number } }> = [];
  const getAllCalls: Array<{ limit?: number }> = [];
  const marked: string[] = [];
  const snapshots: Array<{ id: string; content: string; metadata?: { files?: string[]; entities?: string[] } }> = [];
  const created: Array<{ kind: string; config?: EndlessModeConfig }> = [];
  const setConfigCalls: Array<{ key: string; value: unknown }> = [];
  const configValues: Record<string, unknown> = {};
  if (options?.savedMode) configValues.mode = options.savedMode;
  if (options?.savedConfig) configValues.config = options.savedConfig;

  const workingSet: WorkingSet = {
    recentEvents: [event('event-1')],
    lastActivity: new Date('2026-05-02T00:00:00.000Z'),
    continuityScore: 0.82
  };
  const lastConsolidation = new Date('2026-05-02T01:00:00.000Z');

  const factories: EndlessMemoryServicesFactories = {
    createWorkingSetStore: (_eventStore, config) => {
      created.push({ kind: 'working-set', config });
      return {
        add: async (eventId, relevanceScore) => { added.push({ eventId, relevanceScore }); },
        get: async () => workingSet,
        count: async () => 7
      };
    },
    createConsolidatedStore: () => {
      created.push({ kind: 'consolidated' });
      return {
        search: async (query, searchOptions) => {
          searches.push({ query, options: searchOptions });
          return [consolidated('memory-1')];
        },
        getAll: async (getAllOptions) => {
          getAllCalls.push({ limit: getAllOptions?.limit });
          return [consolidated('memory-2')];
        },
        markAccessed: async (memoryId) => { marked.push(memoryId); },
        count: async () => 3,
        getLastConsolidationTime: async () => lastConsolidation
      };
    },
    createConsolidationWorker: () => {
      created.push({ kind: 'worker' });
      return {
        start: () => { starts.push('worker'); },
        stop: () => { stops.push('worker'); },
        recordActivity: () => { activity.push('worker'); },
        forceRun: async () => {
          forced.push('worker');
          return 5;
        }
      };
    },
    createContinuityManager: (_eventStore, config) => {
      created.push({ kind: 'continuity', config });
      return {
        createSnapshot: (id, content, metadata) => {
          snapshots.push({ id, content, metadata });
          return { id, content, metadata };
        },
        calculateScore: async () => ({ score: 0.91, transitionType: 'seamless' })
      };
    },
    randomUUID: () => 'snapshot-1'
  };

  const configStore = {
    getEndlessConfig: async (key: string) => configValues[key] ?? null,
    setEndlessConfig: async (key: string, value: unknown) => {
      setConfigCalls.push({ key, value });
      configValues[key] = value;
    }
  };

  const services = createEndlessMemoryServices({
    eventStore: { marker: 'event-store' } as unknown as EventStore,
    configStore,
    initialize: async () => { initializeCalls += 1; },
    factories
  });

  return {
    services,
    get initializeCalls() { return initializeCalls; },
    starts,
    stops,
    activity,
    forced,
    added,
    searches,
    getAllCalls,
    marked,
    snapshots,
    created,
    setConfigCalls,
    configValues,
    lastConsolidation
  };
}

describe('createEndlessMemoryServices', () => {
  it('loads saved endless mode and starts the consolidation worker', async () => {
    const harness = makeHarness({ savedMode: 'endless' });

    await harness.services.initializeFromSavedMode();

    expect(harness.services.getMode()).toBe('endless');
    expect(harness.services.isEndlessModeActive()).toBe(true);
    expect(harness.created.map((entry) => entry.kind)).toEqual([
      'working-set',
      'consolidated',
      'worker',
      'continuity'
    ]);
    expect(harness.starts).toEqual(['worker']);
  });

  it('persists mode changes and clears endless components when returning to session mode', async () => {
    const harness = makeHarness();

    await harness.services.setMode('endless');
    await harness.services.addToWorkingSet('event-1', 0.7);
    await expect(harness.services.getWorkingSet()).resolves.toMatchObject({ continuityScore: 0.82 });
    await expect(harness.services.searchConsolidated('thin core', { topK: 2 })).resolves.toMatchObject([
      { memoryId: 'memory-1' }
    ]);

    await harness.services.setMode('session');

    expect(harness.initializeCalls).toBe(2);
    expect(harness.setConfigCalls.map((call) => call.value)).toEqual(['endless', 'session']);
    expect(harness.added).toEqual([{ eventId: 'event-1', relevanceScore: 0.7 }]);
    expect(harness.searches).toEqual([{ query: 'thin core', options: { topK: 2 } }]);
    expect(harness.stops).toEqual(['worker']);
    expect(harness.services.getMode()).toBe('session');
    await expect(harness.services.getWorkingSet()).resolves.toBeNull();
    await expect(harness.services.searchConsolidated('thin core')).resolves.toEqual([]);
    await expect(harness.services.forceConsolidation()).resolves.toBe(0);
  });

  it('formats no endless context while session mode is active', async () => {
    await expect(makeHarness().services.formatEndlessContext('continue refactor')).resolves.toBe('');
  });

  it('formats endless context from continuity, working set, and consolidated memories', async () => {
    const harness = makeHarness();
    await harness.services.setMode('endless');
    const initializeCallsAfterModeSwitch = harness.initializeCalls;

    const formatted = await harness.services.formatEndlessContext('continue refactor');

    expect(formatted).toContain('🔗 Context: seamless (score: 0.91)');
    expect(formatted).toContain('## Recent Context (Working Set)');
    expect(formatted).toContain('[agent_response] event event-1');
    expect(formatted).toContain('## Related Knowledge (Consolidated)');
    expect(formatted).toContain('thin-core: summary memory-1...');
    expect(harness.searches).toEqual([
      { query: 'continue refactor', options: { topK: 3 } }
    ]);
    expect(harness.snapshots).toEqual([
      { id: 'snapshot-1', content: 'continue refactor', metadata: undefined }
    ]);
    expect(harness.initializeCalls).toBe(initializeCallsAfterModeSwitch);
  });

  it('delegates config, continuity, activity, consolidation, and status operations', async () => {
    const harness = makeHarness();

    await expect(harness.services.getEndlessConfig()).resolves.toMatchObject({
      enabled: true,
      workingSet: { maxEvents: 100 },
      continuity: { minScoreForSeamless: 0.7 }
    });
    await harness.services.setEndlessConfig({
      consolidation: {
        triggerIntervalMs: 100,
        triggerEventCount: 10,
        triggerIdleMs: 50,
        useLLMSummarization: true
      }
    });
    await harness.services.setMode('endless');

    await expect(harness.services.getConsolidatedMemories(4)).resolves.toMatchObject([
      { memoryId: 'memory-2' }
    ]);
    await harness.services.markMemoryAccessed('memory-2');
    await expect(harness.services.calculateContinuity('continue refactor', { files: ['src/a.ts'] })).resolves.toEqual({
      score: 0.91,
      transitionType: 'seamless'
    });
    harness.services.recordActivity();
    await expect(harness.services.forceConsolidation()).resolves.toBe(5);
    await expect(harness.services.getEndlessModeStatus()).resolves.toEqual({
      mode: 'endless',
      workingSetSize: 7,
      continuityScore: 0.82,
      consolidatedCount: 3,
      lastConsolidation: harness.lastConsolidation
    });
    harness.services.shutdown();

    expect(harness.getAllCalls).toEqual([{ limit: 4 }]);
    expect(harness.marked).toEqual(['memory-2']);
    expect(harness.snapshots).toEqual([{ id: 'snapshot-1', content: 'continue refactor', metadata: { files: ['src/a.ts'] } }]);
    expect(harness.activity).toEqual(['worker']);
    expect(harness.forced).toEqual(['worker']);
    expect(harness.initializeCalls).toBe(2);
    expect(harness.stops).toEqual(['worker']);
  });

  it('does not keep partial endless state when component startup fails', async () => {
    const harness = makeHarness();
    let failContinuityCreation = true;
    const baseCreateContinuityManager = harness.created;

    const factories: EndlessMemoryServicesFactories = {
      createWorkingSetStore: (_eventStore, _config) => {
        baseCreateContinuityManager.push({ kind: 'working-set' });
        return {
          add: async () => {},
          get: async () => ({ recentEvents: [], lastActivity: new Date('2026-05-02T00:00:00.000Z'), continuityScore: 0.5 }),
          count: async () => 0
        };
      },
      createConsolidatedStore: () => {
        baseCreateContinuityManager.push({ kind: 'consolidated' });
        return {
          search: async () => [],
          getAll: async () => [],
          markAccessed: async () => {},
          count: async () => 0,
          getLastConsolidationTime: async () => null
        };
      },
      createConsolidationWorker: () => {
        baseCreateContinuityManager.push({ kind: 'worker' });
        return {
          start: () => { harness.starts.push('worker'); },
          stop: () => { harness.stops.push('worker'); },
          recordActivity: () => {},
          forceRun: async () => 1
        };
      },
      createContinuityManager: () => {
        baseCreateContinuityManager.push({ kind: 'continuity' });
        if (failContinuityCreation) {
          failContinuityCreation = false;
          throw new Error('continuity unavailable');
        }
        return {
          createSnapshot: () => ({}),
          calculateScore: async () => ({ score: 0.5, transitionType: 'break' })
        };
      },
      randomUUID: () => 'snapshot-1'
    };

    const services = createEndlessMemoryServices({
      eventStore: { marker: 'event-store' } as unknown as EventStore,
      configStore: {
        getEndlessConfig: async () => null,
        setEndlessConfig: async () => {}
      },
      initialize: async () => {},
      factories
    });

    await expect(services.initializeEndlessMode()).rejects.toThrow('continuity unavailable');
    expect(harness.starts).toEqual([]);
    await expect(services.forceConsolidation()).resolves.toBe(0);

    await expect(services.initializeEndlessMode()).resolves.toBeUndefined();
    expect(harness.starts).toEqual(['worker']);
    await expect(services.forceConsolidation()).resolves.toBe(1);
  });

});
