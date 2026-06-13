import { describe, expect, it } from 'vitest';

import {
  analyzeLongMemEvalRetrievalReport,
  classifyLongMemEvalQueryFailure,
  formatLongMemEvalAnalysisMarkdown,
  type LongMemEvalFailureType
} from '../../src/core/longmemeval-analysis.js';
import type { ReplayEvaluationReport, ReplayEvaluationQueryMetrics } from '../../src/core/replay-evaluator.js';

function queryMetric(partial: Partial<ReplayEvaluationQueryMetrics> & Pick<ReplayEvaluationQueryMetrics, 'queryId' | 'retrievedIds' | 'candidateIds'>): ReplayEvaluationQueryMetrics {
  return {
    at: {},
    confidence: 'high',
    fallbackTrace: [],
    reciprocalRank: 0,
    ...partial
  } as ReplayEvaluationQueryMetrics;
}

describe('LongMemEval retrieval analysis', () => {
  it('computes official-style recall_any, recall_all, fractional recall, and failure breakdown at k', () => {
    const report = {
      name: 'longmemeval-analysis-unit',
      evaluator: 'unit',
      generatedAt: '2026-06-12T00:00:00.000Z',
      fixtureStats: { queryCount: 3, memoryCount: 7, ks: [1, 2] },
      summary: {} as ReplayEvaluationReport['summary'],
      perQuery: [
        queryMetric({
          queryId: 'q-full',
          category: 'multi-session',
          expectedIds: ['m-a', 'm-b'],
          retrievedIds: ['m-a', 'm-b'],
          candidateIds: ['m-a', 'm-b'],
          at: { 2: { precision: 1, recall: 1, hits: 2, ndcg: 1 } },
          reciprocalRank: 1
        } as Partial<ReplayEvaluationQueryMetrics> & Pick<ReplayEvaluationQueryMetrics, 'queryId' | 'retrievedIds' | 'candidateIds'>),
        queryMetric({
          queryId: 'q-partial',
          category: 'multi-session',
          expectedIds: ['m-c', 'm-d'],
          retrievedIds: ['m-c', 'm-noise'],
          candidateIds: ['m-c', 'm-d', 'm-noise'],
          at: { 2: { precision: 0.5, recall: 0.5, hits: 1, ndcg: 0.6131471927654584 } },
          reciprocalRank: 1
        } as Partial<ReplayEvaluationQueryMetrics> & Pick<ReplayEvaluationQueryMetrics, 'queryId' | 'retrievedIds' | 'candidateIds'>),
        queryMetric({
          queryId: 'q-empty',
          category: 'single-session-user',
          expectedIds: ['m-e'],
          retrievedIds: [],
          candidateIds: [],
          at: { 2: { precision: 0, recall: 0, hits: 0, ndcg: 0 } },
          reciprocalRank: 0
        } as Partial<ReplayEvaluationQueryMetrics> & Pick<ReplayEvaluationQueryMetrics, 'queryId' | 'retrievedIds' | 'candidateIds'>)
      ]
    } as ReplayEvaluationReport;

    const analysis = analyzeLongMemEvalRetrievalReport(report, { k: 2 });

    expect(analysis).toMatchObject({
      k: 2,
      queryCount: 3,
      recallAnyAtK: 2 / 3,
      recallAllAtK: 1 / 3,
      fractionalRecallAtK: 0.5,
      ndcgAtK: (1 + 0.6131471927654584 + 0) / 3,
      mrr: (1 + 1 + 0) / 3,
      failureBreakdown: {
        hit: 1,
        multi_evidence_partial: 1,
        no_candidate: 1
      }
    });
    expect(analysis.categoryBreakdown['multi-session']).toMatchObject({
      queryCount: 2,
      recallAnyAtK: 1,
      recallAllAtK: 0.5,
      fractionalRecallAtK: 0.75,
      failureBreakdown: {
        hit: 1,
        multi_evidence_partial: 1
      }
    });
    const markdown = formatLongMemEvalAnalysisMarkdown(analysis);
    expect(markdown).toContain('## LongMemEval official-style retrieval metrics');
    expect(markdown).toContain('Recall_any@2');
    expect(markdown).toContain('Recall_all@2');
    expect(markdown).toContain('multi_evidence_partial');
    expect(markdown).toContain('single-session-user');
    expect(JSON.stringify(analysis)).not.toContain('PRIVATE_');
  });

  it('classifies actionable miss types without raw query or memory text', () => {
    const cases: Array<{ name: string; metric: ReplayEvaluationQueryMetrics; expected: LongMemEvalFailureType }> = [
      {
        name: 'candidate selected below cutoff',
        expected: 'answer_below_k',
        metric: queryMetric({
          queryId: 'q-below-k',
          expectedIds: ['m-answer'],
          retrievedIds: ['m-noise-1', 'm-noise-2'],
          candidateIds: ['m-noise-1', 'm-noise-2', 'm-answer']
        } as Partial<ReplayEvaluationQueryMetrics> & Pick<ReplayEvaluationQueryMetrics, 'queryId' | 'retrievedIds' | 'candidateIds'>)
      },
      {
        name: 'candidate available but filtered before selected output',
        expected: 'candidate_but_filtered',
        metric: queryMetric({
          queryId: 'q-filtered',
          expectedIds: ['m-answer'],
          retrievedIds: [],
          candidateIds: ['m-answer', 'm-noise']
        } as Partial<ReplayEvaluationQueryMetrics> & Pick<ReplayEvaluationQueryMetrics, 'queryId' | 'retrievedIds' | 'candidateIds'>)
      },
      {
        name: 'candidates exist but none match qrels',
        expected: 'lexical_mismatch',
        metric: queryMetric({
          queryId: 'q-lexical',
          expectedIds: ['m-answer'],
          retrievedIds: ['m-noise'],
          candidateIds: ['m-noise']
        } as Partial<ReplayEvaluationQueryMetrics> & Pick<ReplayEvaluationQueryMetrics, 'queryId' | 'retrievedIds' | 'candidateIds'>)
      }
    ];

    for (const testCase of cases) {
      expect(classifyLongMemEvalQueryFailure(testCase.metric, { k: 2 }), testCase.name).toBe(testCase.expected);
    }
  });
});
