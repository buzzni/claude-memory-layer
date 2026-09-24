import { describe, expect, it } from 'vitest';
import {
  buildMemoryFieldDataset,
  evaluateMemoryFieldExecutions,
  type MemoryFieldExecution,
  type MemoryFieldPair
} from '../../src/core/memory-field-evaluation.js';

function pairs(count = 220): MemoryFieldPair[] {
  return Array.from({ length: count }, (_, index) => ({
    promptId: `prompt-${index}`,
    prompt: `service-${index} deploy failure-${index} 원인을 확인하고 해결해줘`,
    answerId: `answer-${index}`,
    answer: `service-${index} deploy failure-${index}의 원인은 image tag 불일치였고 tag-${index}로 교체해 해결했습니다. 검증 결과 rollout도 성공했습니다.`,
    answerLevel: index < 35 ? (index % 3 === 0 ? 'L2' : 'L1') : 'L0',
    sessionId: `session-${index % 50}`,
    timestamp: new Date(2026, 0, 1, 0, index).toISOString()
  }));
}

describe('memory field evaluation', () => {
  it('builds a deterministic diverse 200-case local dataset with hard query styles', () => {
    const first = buildMemoryFieldDataset(pairs(), { generatedAt: '2026-07-14T00:00:00.000Z' });
    const second = buildMemoryFieldDataset(pairs(), { generatedAt: '2026-07-14T00:00:00.000Z' });

    expect(first).toEqual(second);
    expect(first.cases).toHaveLength(200);
    expect(first.generation).toMatchObject({
      positiveCases: 150,
      counterfactualCases: 25,
      unrelatedCases: 25,
      promotedPositiveCases: 35,
      difficultyCounts: { easy: 30, standard: 40, hard: 130 },
      queryStyleCounts: {
        exact: 30,
        contextual: 30,
        compressed_clues: 30,
        paraphrased_clues: 30,
        noisy_clues: 30,
        plausible_counterfactual: 25,
        unrelated: 25
      }
    });
    expect(first.generation.sourceSessions).toBeGreaterThan(20);
    expect(first.cases.filter((item) => item.kind === 'counterfactual')
      .every((item) => item.queryStyle === 'plausible_counterfactual' && item.difficulty === 'hard')).toBe(true);
    expect(first.cases.filter((item) => item.queryStyle === 'paraphrased_clues')
      .every((item) => !item.query.includes('deploy failure'))).toBe(true);
    expect(first.cases.filter((item) => item.queryStyle === 'noisy_clues')).toHaveLength(30);
  });

  it('excludes credential-bearing source pairs', () => {
    const source = pairs(81);
    source[0] = {
      ...source[0]!,
      prompt: 'service deploy password=do-not-store 원인을 확인해줘'
    };
    const dataset = buildMemoryFieldDataset(source, {
      totalCases: 10,
      positiveCases: 8,
      counterfactualCases: 1,
      unrelatedCases: 1,
      generatedAt: '2026-07-14T00:00:00.000Z'
    });
    expect(dataset.cases.some((item) => item.expectedEventIds.includes('answer-0'))).toBe(false);
  });

  it('reports positive, no-match, latency, and immutable-store metrics without query text', () => {
    const dataset = buildMemoryFieldDataset(pairs(), { generatedAt: '2026-07-14T00:00:00.000Z' });
    const executions: MemoryFieldExecution[] = dataset.cases.map((item, index) => ({
      caseId: item.caseId,
      selectedEventIds: item.kind === 'positive' ? [item.expectedEventIds[0]!] : [],
      hasContext: item.kind === 'positive',
      latencyMs: 100 + index
    }));
    const snapshot = { events: 1000, retrievalTraces: 20, levels: { L0: 900, L1: 90, L2: 10 } };
    const report = evaluateMemoryFieldExecutions(dataset, executions, snapshot, snapshot, '2026-07-14T00:00:00.000Z');

    expect(report.metrics).toMatchObject({
      overallAccuracy: 1,
      positiveHitRate: 1,
      positiveTop1Accuracy: 1,
      noMatchAccuracy: 1,
      unexpectedInjectionCount: 0,
      executionErrorCount: 0,
      latencyP50Ms: 199,
      latencyP95Ms: 289
    });
    expect(report.byDifficulty).toMatchObject({
      easy: { cases: 30, hitRate: 1, top1Accuracy: 1 },
      standard: { cases: 40, hitRate: 1, top1Accuracy: 1 },
      hard: { cases: 130, hitRate: 1, top1Accuracy: 1 }
    });
    expect(report.byQueryStyle.noisy_clues).toEqual({ cases: 30, hitRate: 1, top1Accuracy: 1 });
    expect(report.storeImmutable).toBe(true);
    expect(JSON.stringify(report)).not.toContain('service-0 deploy');
  });
});
