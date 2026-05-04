import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RetrievalAnalyticsService } from '../../src/core/engine/retrieval-analytics-service.js';
import type {
  RetrievalAnalyticsStore,
  RetrievalTrace
} from '../../src/core/engine/retrieval-analytics-service.js';
import type { MemoryEvent } from '../../src/core/types.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function tempStoragePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'retrieval-analytics-service-'));
  tempDirs.push(dir);
  return dir;
}

function event(
  id: string,
  content: string,
  timestamp = new Date('2026-02-24T00:00:00.000Z')
): MemoryEvent & { access_count?: number; last_accessed_at?: string } {
  return {
    id,
    sessionId: 's1',
    eventType: 'user_prompt',
    content,
    canonicalKey: `test/${id}`,
    dedupeKey: `s1:${id}`,
    timestamp,
    metadata: {}
  };
}

function baseStore(overrides: Partial<RetrievalAnalyticsStore> = {}): RetrievalAnalyticsStore {
  return {
    getRetrievalTraceStats: async () => ({
      totalQueries: 0,
      avgCandidateCount: 0,
      avgSelectedCount: 0,
      selectionRate: 0
    }),
    getRecentRetrievalTraces: async (_limit = 50) => [],
    getMostAccessed: async (_limit = 10) => [],
    evaluateSessionHelpfulness: async (_sessionId: string) => {},
    getUnevaluatedSessions: async (_currentSessionId: string, _limit = 5) => [],
    getHelpfulMemories: async (_limit = 10) => [],
    getHelpfulnessStats: async () => ({
      avgScore: 0,
      totalEvaluated: 0,
      totalRetrievals: 0,
      helpful: 0,
      neutral: 0,
      unhelpful: 0
    }),
    ...overrides
  };
}

describe('RetrievalAnalyticsService', () => {
  it('maps most-accessed events to dashboard memories and extracts topics from content', async () => {
    let initialized = 0;
    let requestedLimit: number | undefined;
    const accessed = event(
      'e1',
      `${'x'.repeat(205)}\n## Thin Core Architecture\nUse **Retrieval Analytics** to keep MemoryService small.`
    );
    accessed.access_count = 3;
    accessed.last_accessed_at = '2026-02-25T00:00:00.000Z';
    const untouched = event('e2', 'plain content without explicit access metadata');

    const service = new RetrievalAnalyticsService({
      initialize: async () => { initialized += 1; },
      retrievalStore: baseStore({
        getMostAccessed: async (limit = 10) => {
          requestedLimit = limit;
          return [accessed, untouched];
        }
      })
    });

    const memories = await service.getMostAccessedMemories(7);

    expect(initialized).toBe(0);
    expect(requestedLimit).toBe(7);
    expect(memories).toHaveLength(2);
    expect(memories[0]).toMatchObject({
      memoryId: 'e1',
      summary: `${'x'.repeat(200)}...`,
      topics: ['Thin Core Architecture', 'Retrieval Analytics'],
      accessCount: 3,
      lastAccessed: '2026-02-25T00:00:00.000Z',
      confidence: 1.0,
      createdAt: accessed.timestamp
    });
    expect(memories[1]).toMatchObject({
      memoryId: 'e2',
      accessCount: 0,
      lastAccessed: null,
      confidence: 1.0,
      createdAt: untouched.timestamp
    });
  });

  it('evaluates pending sessions best-effort and ignores individual failures', async () => {
    let initialized = 0;
    const evaluated: string[] = [];

    const service = new RetrievalAnalyticsService({
      initialize: async () => { initialized += 1; },
      retrievalStore: baseStore({
        getUnevaluatedSessions: async (currentSessionId: string, limit = 5) => {
          expect(currentSessionId).toBe('current-session');
          expect(limit).toBe(5);
          return ['ok-1', 'fails', 'ok-2'];
        },
        evaluateSessionHelpfulness: async (sessionId: string) => {
          if (sessionId === 'fails') {
            throw new Error('transient evaluation failure');
          }
          evaluated.push(sessionId);
        }
      })
    });

    await service.evaluatePendingSessions('current-session');

    expect(initialized).toBe(1);
    expect(evaluated).toEqual(['ok-1', 'ok-2']);
  });

  it('delegates trace and helpfulness read-model methods after initialization', async () => {
    let initialized = 0;
    const traceStats = {
      totalQueries: 12,
      avgCandidateCount: 4,
      avgSelectedCount: 2,
      selectionRate: 0.5
    };
    const traceRows = [{
      traceId: 't1',
      sessionId: 's1',
      projectHash: 'project-hash',
      queryText: 'thin core',
      strategy: 'auto',
      candidateEventIds: ['e1', 'e2'],
      selectedEventIds: ['e1'],
      candidateDetails: [{ eventId: 'e1', score: 0.9 }],
      selectedDetails: [{ eventId: 'e1', score: 0.9 }],
      candidateCount: 2,
      selectedCount: 1,
      confidence: 'high',
      fallbackTrace: ['stage:primary:deep'],
      createdAt: new Date('2026-02-24T01:00:00.000Z')
    }] satisfies RetrievalTrace[];
    const helpfulMemories = [{
      eventId: 'e1',
      summary: 'helpful memory',
      helpfulnessScore: 0.8,
      accessCount: 4,
      evaluationCount: 2
    }];
    const helpfulnessStats = {
      avgScore: 0.75,
      totalEvaluated: 8,
      totalRetrievals: 10,
      helpful: 6,
      neutral: 1,
      unhelpful: 1
    };
    const evaluated: string[] = [];

    const service = new RetrievalAnalyticsService({
      initialize: async () => { initialized += 1; },
      retrievalStore: baseStore({
        getRetrievalTraceStats: async () => traceStats,
        getRecentRetrievalTraces: async (limit = 50) => {
          expect(limit).toBe(3);
          return traceRows;
        },
        evaluateSessionHelpfulness: async (sessionId: string) => { evaluated.push(sessionId); },
        getHelpfulMemories: async (limit = 10) => {
          expect(limit).toBe(2);
          return helpfulMemories;
        },
        getHelpfulnessStats: async () => helpfulnessStats
      })
    });

    await expect(service.getRetrievalTraceStats()).resolves.toEqual(traceStats);
    await expect(service.getRecentRetrievalTraces(3)).resolves.toEqual(traceRows);
    await service.evaluateSessionHelpfulness('s1');
    await expect(service.getHelpfulMemories(2)).resolves.toEqual(helpfulMemories);
    await expect(service.getHelpfulnessStats()).resolves.toEqual(helpfulnessStats);

    expect(evaluated).toEqual(['s1']);
    expect(initialized).toBe(5);
  });
});
