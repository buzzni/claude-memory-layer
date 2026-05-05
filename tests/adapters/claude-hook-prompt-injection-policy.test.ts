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

  it('limits injected hook memories by highest confidence rather than first passing candidate', () => {
    const candidates: HookMemoryCandidate[] = [
      { id: 'medium-first', type: 'session_summary', content: 'passes but weaker', score: 0.67, source: 'semantic' },
      { id: 'best-later', type: 'user_prompt', content: 'best exact keyword', score: 0.93, source: 'keyword' },
      { id: 'second-best-later', type: 'agent_response', content: 'strong semantic match', score: 0.88, source: 'semantic' }
    ];

    expect(filterHookInjectableMemories(candidates, { ...getHookInjectionPolicy(), maxMemories: 2 }))
      .toEqual([candidates[1], candidates[2]]);
  });

  it('uses bounded hook policy thresholds so unsafe env overrides cannot inject weak memories', () => {
    const policy = getHookInjectionPolicy({
      CLAUDE_MEMORY_HOOK_INJECTION_MIN_SCORE: '-1',
      CLAUDE_MEMORY_HOOK_SEMANTIC_MIN_SCORE: '2',
      CLAUDE_MEMORY_HOOK_KEYWORD_MIN_SCORE: 'not-a-number',
      CLAUDE_MEMORY_HOOK_FALLBACK_KEYWORD_MIN_SCORE: '-0.2',
      CLAUDE_MEMORY_HOOK_MAX_INJECTED: '2'
    } as NodeJS.ProcessEnv);

    expect(policy).toEqual({
      minScore: 0.65,
      semanticMinScore: 0.65,
      keywordMinScore: 0.7,
      fallbackKeywordMinScore: 0.8,
      maxMemories: 2
    });

    expect(filterHookInjectableMemories([
      { id: 'weak-unknown', type: 'user_prompt', content: 'weak unknown source', score: 0.1, source: 'unknown' },
      { id: 'fallback-too-weak', type: 'user_prompt', content: 'weak fallback', score: 0.79, source: 'keyword', fallback: true }
    ], policy)).toEqual([]);
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
