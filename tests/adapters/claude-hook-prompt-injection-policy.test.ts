import { describe, expect, it } from 'vitest';

import { MemoryQueryService } from '../../src/core/engine/memory-query-service.js';
import type { MemoryEvent } from '../../src/core/types.js';
import {
  filterHookInjectableMemories,
  getHookInjectionPolicy,
  scoreGraduatedEvidence,
  selectHookEpisodeSeeds,
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
      scoreCliffGap: 0.08,
      maxMemories: 2
    });

    expect(filterHookInjectableMemories([
      { id: 'weak-unknown', type: 'user_prompt', content: 'weak unknown source', score: 0.1, source: 'unknown' },
      { id: 'fallback-too-weak', type: 'user_prompt', content: 'weak fallback', score: 0.79, source: 'keyword', fallback: true }
    ], policy)).toEqual([]);
  });

  it('abstains from a high-score candidate with no meaningful query overlap', () => {
    const candidates: HookMemoryCandidate[] = [
      { id: 'project-memory', type: 'agent_response', content: 'graduation worker and project health pipeline', score: 0.96, source: 'semantic' }
    ];

    expect(filterHookInjectableMemories(
      candidates,
      getHookInjectionPolicy(),
      '이번 주말 저녁 식사 메뉴와 장보기 목록을 추천해줘'
    )).toEqual([]);
  });

  it('abstains when a candidate shares only a generic request verb', () => {
    const candidates: HookMemoryCandidate[] = [
      { id: 'recsys', type: 'user_prompt', content: 'PROMPT_ADD_TO_BASKET 와 PROMPT_PURCHASE의 차이가 뭐야? 자세한 원리와 의도를 알려줘', score: 0.99, source: 'semantic' }
    ];

    expect(filterHookInjectableMemories(
      candidates,
      getHookInjectionPolicy(),
      '칠레 아타카마 사막에서 별을 관측하기 좋은 계절과 카메라 설정을 알려줘'
    )).toEqual([]);
  });

  it('abstains when a short unrelated query shares a domain word and question boilerplate', () => {
    const candidates: HookMemoryCandidate[] = [{
      id: 'runner-wait',
      type: 'agent_response',
      content: 'recsys CI runner가 무한 대기 중입니다. 지금 어떻게 할까요? ubuntu-latest로 돌리면 복구됩니다.',
      score: 0.99,
      source: 'semantic'
    }];

    expect(filterHookInjectableMemories(
      candidates,
      getHookInjectionPolicy(),
      '화성의 대기 조성은 어떻게 돼?'
    )).toEqual([]);
  });

  it('keeps only the high-score plateau before a score cliff for aligned memories', () => {
    const candidates: HookMemoryCandidate[] = [
      { id: 'best', type: 'agent_response', content: 'graduation pipeline health check', score: 0.96, source: 'semantic' },
      { id: 'second', type: 'agent_response', content: 'graduation worker health report', score: 0.91, source: 'semantic' },
      { id: 'tail', type: 'agent_response', content: 'graduation old health notes', score: 0.70, source: 'semantic' }
    ];

    expect(filterHookInjectableMemories(candidates, getHookInjectionPolicy(), 'graduation health 상태를 확인해줘'))
      .toEqual([candidates[0], candidates[1]]);
  });

  it('prefers answer evidence and drops a higher-scored prompt-only reminder', () => {
    const candidates: HookMemoryCandidate[] = [
      { id: 'request', type: 'user_prompt', content: 'PR 167 코드 리뷰 해줘', score: 0.94, source: 'semantic' },
      { id: 'answer', type: 'agent_response', content: 'PR 167 코드 리뷰 결과 null 처리 위험이 확인됐다', score: 0.84, source: 'semantic' }
    ];

    expect(filterHookInjectableMemories(candidates, getHookInjectionPolicy(), 'PR 167 코드 리뷰 결과를 알려줘'))
      .toEqual([candidates[1]]);
  });

  it('abstains from prompt-only evidence for an answer-seeking query', () => {
    const request: HookMemoryCandidate = {
      id: 'request-only', type: 'user_prompt', content: 'PR 167 코드 리뷰 해줘', score: 0.99, source: 'semantic'
    };
    expect(filterHookInjectableMemories([request], getHookInjectionPolicy(), 'PR 167 코드 리뷰 결과를 알려줘'))
      .toEqual([]);
  });

  it('accepts linked episode outcomes with multiple strong topic terms', () => {
    const outcome: HookMemoryCandidate = {
      id: 'episode-answer',
      type: 'agent_response',
      content: '두 단계의 배포 문제가 겹쳤고 현재 커밋은 빌드되지 않았다',
      score: 0.82,
      source: 'episode',
      episodeLinked: true
    };
    expect(filterHookInjectableMemories([outcome], getHookInjectionPolicy(), '배포 커밋이 빌드되지 않은 이유가 뭐였어'))
      .toEqual([outcome]);
  });

  it('selects an exact prompt seed independently from a higher answer candidate', () => {
    const prompt: HookMemoryCandidate = {
      id: 'prompt-seed', type: 'user_prompt',
      content: 'service-x deploy image-tag-17 failure root cause',
      score: 0.88, source: 'keyword'
    };
    const broadAnswer: HookMemoryCandidate = {
      id: 'broad-answer', type: 'agent_response',
      content: 'service-x deploy general failure guide',
      score: 0.98, source: 'semantic'
    };
    expect(selectHookEpisodeSeeds(
      [broadAnswer, prompt], getHookInjectionPolicy(),
      'service-x deploy image-tag-17 failure root cause 결과를 알려줘'
    )).toEqual([{ ...prompt, episodeSeedAligned: true, episodeSeedStrongAligned: true }]);
  });

  it('keeps the bounded top five aligned prompt seeds for ambiguous noisy recall', () => {
    const prompts: HookMemoryCandidate[] = Array.from({ length: 6 }, (_, index) => ({
      id: `prompt-${index}`,
      type: 'user_prompt',
      content: `service-x image-tag-17 rollout historical prompt ${index}`,
      score: 0.90 - index * 0.01,
      source: 'keyword'
    }));

    expect(selectHookEpisodeSeeds(
      prompts,
      { ...getHookInjectionPolicy(), maxMemories: 5 },
      'service-x image-tag-17 rollout 결과'
    )).toHaveLength(5);
  });

  it('allows a lower seed-only score only when every identifier anchor matches', () => {
    const aligned: HookMemoryCandidate = {
      id: 'aligned-low-seed',
      type: 'user_prompt',
      content: 'service-x image-tag-17 rollout failure analysis',
      score: 0,
      source: 'keyword'
    };
    const counterfactual: HookMemoryCandidate = {
      id: 'wrong-anchor-low-seed',
      type: 'user_prompt',
      content: 'service-x image-tag-18 rollout failure analysis',
      score: 0.52,
      source: 'keyword'
    };

    expect(selectHookEpisodeSeeds(
      [counterfactual, aligned],
      getHookInjectionPolicy(),
      'service-x image-tag-17 rollout failure 결과'
    )).toEqual([expect.objectContaining({
      id: 'aligned-low-seed',
      score: 0.67,
      episodeSeedAligned: true,
      episodeSeedStrongAligned: true
    })]);
  });

  it('lets a fully anchored episode answer outrank a high-scored direct lexical distractor', () => {
    const linked: HookMemoryCandidate = {
      id: 'strong-linked',
      type: 'agent_response',
      content: '최종 조치가 완료됐다',
      score: 0.65,
      source: 'episode',
      episodeLinked: true,
      episodeSeedAligned: true,
      episodeSeedStrongAligned: true
    };
    const distractor: HookMemoryCandidate = {
      id: 'lexical-distractor',
      type: 'agent_response',
      content: 'service-x image-tag-17 rollout failure 일반 참고 문서',
      score: 1,
      source: 'keyword'
    };

    expect(filterHookInjectableMemories(
      [distractor, linked],
      getHookInjectionPolicy(),
      'service-x image-tag-17 rollout failure 결과'
    )[0]?.id).toBe('strong-linked');
  });

  it('allows a response reached through a strongly aligned exact prompt seed', () => {
    const linked: HookMemoryCandidate = {
      id: 'linked-answer', type: 'agent_response',
      content: '상태를 확인한 후 이전 설정으로 돌려 복구했다',
      score: 0.86, source: 'episode', episodeLinked: true, episodeSeedAligned: true
    };
    expect(filterHookInjectableMemories(
      [linked], getHookInjectionPolicy(), 'service-x image-tag-17 rollout failure'
    )).toEqual([linked]);
  });

  it('ranks strongly linked episode evidence above a broad graduated answer', () => {
    const linked: HookMemoryCandidate = {
      id: 'linked', type: 'agent_response', content: '배포 상태를 되돌려 복구했다',
      score: 0.86, source: 'episode', episodeLinked: true, episodeSeedAligned: true
    };
    const broad: HookMemoryCandidate = {
      id: 'broad', type: 'agent_response', content: 'service-x image-tag-17 배포 일반 가이드',
      score: 0.94, source: 'graduated', memoryLevel: 'L2'
    };
    expect(filterHookInjectableMemories(
      [broad, linked], getHookInjectionPolicy(), 'service-x image-tag-17 배포 문제'
    )).toEqual([linked]);
  });

  it('does not treat short numbers plus planning boilerplate as strong alignment', () => {
    const candidate: HookMemoryCandidate = {
      id: 'model-training', type: 'agent_response',
      content: '모델 훈련 계획은 12 epoch로 설정했다', score: 0.99, source: 'semantic'
    };
    expect(filterHookInjectableMemories(
      [candidate], getHookInjectionPolicy(), '마라톤 첫 완주를 위한 12주 훈련 계획을 만들어줘'
    )).toEqual([]);
  });

  it('requires a query identifier anchor even for same-turn episode evidence', () => {
    const wrongEpisode: HookMemoryCandidate = {
      id: 'wrong-episode', type: 'agent_response', content: '다른 코드 리뷰 결론을 정리했다',
      score: 0.95, source: 'episode', episodeLinked: true
    };
    expect(filterHookInjectableMemories([wrongEpisode], getHookInjectionPolicy(), 'PR 167 코드 리뷰 결론'))
      .toEqual([]);
  });

  it('drops tool attempts when an answer exists unless the query asks for tool evidence', () => {
    const answer: HookMemoryCandidate = {
      id: 'answer', type: 'agent_response', content: 'Argo CD 배포 pod 원인은 sync 미반영이었다', score: 0.86, source: 'semantic'
    };
    const tool: HookMemoryCandidate = {
      id: 'tool', type: 'tool_observation', content: 'Argo CD 배포 pod 상태를 출력했다', score: 0.89, source: 'semantic'
    };
    const tail: HookMemoryCandidate = {
      id: 'tail', type: 'tool_observation', content: 'Argo CD 배포 pod 이전 로그', score: 0.68, source: 'semantic'
    };
    expect(filterHookInjectableMemories([answer, tool, tail], getHookInjectionPolicy(), 'Argo CD 배포 pod 원인을 알려줘'))
      .toEqual([answer]);
    expect(filterHookInjectableMemories([answer, tool, tail], getHookInjectionPolicy(), 'Argo CD 배포 pod kubectl 출력을 알려줘'))
      .toEqual([answer, tool]);
  });

  it('uses promoted answer evidence as a bounded prior rather than promoting raw requests', () => {
    const query = 'aiaas ssgshop benimaru v1 pod CrashLoopBackOff 직접 원인';
    const exact: HookMemoryCandidate = {
      id: 'exact', type: 'agent_response',
      content: 'aiaas ssgshop benimaru v1 pod의 CrashLoopBackOff 직접 원인은 API와 GPU timestamp 불일치였다',
      source: 'graduated', memoryLevel: 'L2', accessCount: 4
    };
    const wrongEntity: HookMemoryCandidate = {
      id: 'wrong', type: 'agent_response',
      content: 'aiaas wshop benimaru v3 pod의 CrashLoopBackOff 원인은 inference/apps/benimaru/v1 코드와 오래된 GPU 모델이었다',
      source: 'graduated', memoryLevel: 'L2', accessCount: 20
    };
    const promotedPrompt: HookMemoryCandidate = {
      id: 'prompt', type: 'user_prompt', content: query,
      source: 'graduated', memoryLevel: 'L4', accessCount: 100
    };

    const exactScore = scoreGraduatedEvidence(query, exact);
    const wrongScore = scoreGraduatedEvidence(query, wrongEntity);
    expect(exactScore).not.toBeNull();
    expect(wrongScore).not.toBeNull();
    expect(exactScore!).toBeGreaterThan(wrongScore!);
    expect(scoreGraduatedEvidence(query, promotedPrompt)).not.toBeNull();
    promotedPrompt.score = scoreGraduatedEvidence(query, promotedPrompt)!;
    expect(filterHookInjectableMemories([promotedPrompt], getHookInjectionPolicy(), query)).toEqual([]);

    exact.score = exactScore!;
    wrongEntity.score = wrongScore!;
    expect(filterHookInjectableMemories([wrongEntity, exact], getHookInjectionPolicy(), query)).toEqual([exact]);
  });

  it('rejects prompt-only generated summaries from the graduated answer lane', () => {
    expect(scoreGraduatedEvidence('PR 167 코드 리뷰 핵심 위험', {
      id: 'summary', type: 'session_summary', source: 'graduated', memoryLevel: 'L2', accessCount: 5,
      content: 'Session with 1 user prompts and 0 responses. Topics discussed: PR 167 코드 리뷰 해줘'
    })).toBeNull();
  });

  it('uses a tighter score cliff for calibrated graduated evidence', () => {
    const exact: HookMemoryCandidate = {
      id: 'exact-promoted', type: 'agent_response', content: 'TRIGGER_SEARCH query 필드 변경 결과',
      score: 0.94, source: 'graduated', memoryLevel: 'L2'
    };
    const broad: HookMemoryCandidate = {
      id: 'broad-promoted', type: 'agent_response', content: 'TRIGGER_SEARCH query 모델 변경 분석 결과',
      score: 0.91, source: 'graduated', memoryLevel: 'L2'
    };
    expect(filterHookInjectableMemories(
      [broad, exact], getHookInjectionPolicy(), 'TRIGGER_SEARCH query 필드 변경 결과'
    )).toEqual([exact]);
  });

  it('does not double-count level after graduated score calibration', () => {
    const exactL1: HookMemoryCandidate = {
      id: 'exact-l1', type: 'agent_response',
      content: '95b2c36 develop tag caused No changes',
      score: 0.93, source: 'graduated', memoryLevel: 'L1'
    };
    const broadL2: HookMemoryCandidate = {
      id: 'broad-l2', type: 'agent_response',
      content: '95b2c36 develop tag release overview',
      score: 0.91, source: 'graduated', memoryLevel: 'L2'
    };

    expect(filterHookInjectableMemories(
      [broadL2, exactL1], getHookInjectionPolicy(), '95b2c36 develop tag No changes'
    )).toEqual([exactL1]);
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
