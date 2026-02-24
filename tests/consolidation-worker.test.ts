import { describe, it, expect } from 'vitest';

import { ConsolidationWorker } from '../src/core/consolidation-worker.js';
import type { EndlessModeConfig, MemoryEvent } from '../src/core/types.js';

function makeEvent(id: string, content: string, hoursAgo = 20): MemoryEvent {
  return {
    id,
    eventType: 'user_prompt',
    sessionId: 's1',
    timestamp: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
    content,
    canonicalKey: id,
    dedupeKey: id,
    metadata: {},
  };
}

describe('ConsolidationWorker hierarchy automation', () => {
  it('creates consolidated memories, promotes rules, and returns cost-quality report', async () => {
    const events = [
      makeEvent('e1', 'implement auth bug fix and add tests for token refresh'),
      makeEvent('e2', 'fix auth error in middleware and update tests'),
      makeEvent('e3', 'auth feature update with regression test and bug notes'),
      makeEvent('e4', 'implement retry logic for auth and fix issue with token cache'),
      makeEvent('e5', 'add integration test for auth flow and bug reproduction'),
    ];

    const created: Array<{ memoryId: string; summary: string; topics: string[]; sourceEvents: string[]; confidence: number }> = [];
    const rules: Array<{ rule: string; sourceMemoryIds: string[] }> = [];

    const workingSetStore = {
      async get() {
        return { recentEvents: events, lastActivity: new Date(), continuityScore: 0.8 };
      },
      async prune(_ids: string[]) {
        return;
      }
    };

    const consolidatedStore = {
      async isAlreadyConsolidated() { return false; },
      async create(input: any) {
        const memoryId = `m-${created.length + 1}`;
        created.push({ memoryId, ...input });
        return memoryId;
      },
      async get(memoryId: string) {
        return created.find((m) => m.memoryId === memoryId) || null;
      },
      async hasRuleForSourceMemory() { return false; },
      async createRule(input: any) {
        rules.push({ rule: input.rule, sourceMemoryIds: input.sourceMemoryIds });
        return `r-${rules.length}`;
      }
    };

    const config: EndlessModeConfig = {
      enabled: true,
      workingSet: { maxEvents: 100, timeWindowHours: 24, minRelevanceScore: 0.5 },
      consolidation: { triggerIntervalMs: 3600000, triggerEventCount: 3, triggerIdleMs: 1000, useLLMSummarization: false },
      continuity: { minScoreForSeamless: 0.7, topicDecayHours: 48 }
    };

    const worker = new ConsolidationWorker(workingSetStore as any, consolidatedStore as any, config);
    const out = await worker.forceRunWithReport();

    expect(out.consolidatedCount).toBeGreaterThan(0);
    expect(out.promotedRuleCount).toBeGreaterThan(0);
    expect(out.report.beforeTokenEstimate).toBeGreaterThan(0);
    expect(out.report.reductionRatio).toBeGreaterThanOrEqual(0);
    expect(out.report.qualityGuardPassed).toBe(true);
    expect(rules[0]?.sourceMemoryIds?.length).toBeGreaterThan(0);
  });
});
