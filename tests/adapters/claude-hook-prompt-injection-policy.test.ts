import { describe, expect, it } from 'vitest';

import { MemoryQueryService } from '../../src/core/engine/memory-query-service.js';
import type { MemoryEvent } from '../../src/core/types.js';
import {
  filterHookInjectableMemories,
  getHookInjectionPolicy,
  summarizeHookInjectionConfidence,
  type HookMemoryCandidate
} from '../../src/adapters/claude/hooks/prompt-injection-policy.js';

function event(id: string, content = 'low confidence keyword result'): MemoryEvent {
  return {
    id,
    eventType: 'user_prompt',
    sessionId: 'session-1',
    timestamp: new Date('2026-05-02T00:00:00.000Z'),
    content,
    canonicalKey: `test/${id}`,
    dedupeKey: `session-1:${id}`,
    metadata: {}
  };
}

describe('Claude hook prompt injection policy', () => {
  it('filters low-confidence hook candidates before prompt injection', () => {
    const candidates: HookMemoryCandidate[] = [
      { id: 'low-semantic', type: 'agent_response', content: 'maybe related', score: 0.58, source: 'semantic' },
      { id: 'low-keyword', type: 'user_prompt', content: 'weak keyword rescue', score: 0.49, source: 'keyword' },
      { id: 'high-keyword', type: 'user_prompt', content: 'exact high-confidence keyword', score: 0.84, source: 'keyword' },
      { id: 'high-semantic', type: 'session_summary', content: 'high semantic match', score: 0.76, source: 'semantic' }
    ];

    expect(filterHookInjectableMemories(candidates, getHookInjectionPolicy())).toEqual([
      candidates[2],
      candidates[3]
    ]);
    expect(summarizeHookInjectionConfidence(candidates)).toBe('high');
    expect(summarizeHookInjectionConfidence([])).toBe('none');
  });

  it('keeps regular CLI/query search behavior independent from hook injection policy', async () => {
    const memory = event('regular-low');
    const service = new MemoryQueryService(
      async () => {},
      {
        keywordSearch: async () => [{ event: memory, rank: -0.5 }],
        getSessionEvents: async () => [memory],
        getRecentEvents: async () => [memory]
      }
    );

    const regularResults = await service.keywordSearch('weak keyword rescue', { topK: 1, minScore: 0.2 });
    expect(regularResults).toEqual([{ event: memory, score: 1 }]);

    const hookCandidates: HookMemoryCandidate[] = regularResults.map((result) => ({
      id: result.event.id,
      type: result.event.eventType,
      content: result.event.content,
      score: 0.5,
      source: 'keyword'
    }));
    expect(filterHookInjectableMemories(hookCandidates, getHookInjectionPolicy())).toEqual([]);
  });
});
