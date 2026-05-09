import { describe, expect, it } from 'vitest';

import {
  buildReplayPromotionPlan,
  formatReplayPromotionMarkdown,
  type RetrievalReviewQueueExport
} from '../../src/core/replay-promotion.js';

const reviewQueue: RetrievalReviewQueueExport = {
  summary: {
    totalTraces: 3,
    reviewItems: 2,
    returnedItems: 2,
    candidateNoSelection: 1,
    emptyCandidateSet: 1,
    rewrittenNoSelection: 1,
    lowSelectionRate: 0
  },
  items: [
    {
      traceId: 'trace-rewrite-empty',
      reason: 'rewritten-query-no-selection',
      severity: 'warn',
      priority: 100,
      title: 'PRIVATE_TITLE_SHOULD_NOT_LEAK',
      detail: 'PRIVATE_DETAIL_SHOULD_NOT_LEAK',
      action: 'PRIVATE_ACTION_SHOULD_NOT_LEAK',
      rawQueryText: 'PRIVATE_RAW_QUERY_SHOULD_NOT_LEAK',
      queryText: 'PRIVATE_EFFECTIVE_QUERY_SHOULD_NOT_LEAK',
      queryRewriteKind: 'follow-up-context',
      rewritten: true,
      strategy: 'hybrid',
      candidateCount: 4,
      selectedCount: 0,
      candidateEventIds: ['candidate-a', 'candidate-b'],
      selectedEventIds: [],
      candidateDetails: [{ eventId: 'candidate-a', score: 0.8, semanticScore: 0.7, lexicalScore: 0.1 }],
      selectedDetails: [],
      createdAt: '2026-05-09T01:00:00.000Z'
    },
    {
      traceId: '/Users/private/trace-should-hash',
      reason: 'empty-candidate-set',
      severity: 'info',
      priority: 70,
      title: 'PRIVATE_EMPTY_TITLE_SHOULD_NOT_LEAK',
      detail: 'PRIVATE_EMPTY_DETAIL_SHOULD_NOT_LEAK',
      action: 'PRIVATE_EMPTY_ACTION_SHOULD_NOT_LEAK',
      rawQueryText: 'PRIVATE_EMPTY_RAW_QUERY_SHOULD_NOT_LEAK',
      queryText: 'PRIVATE_EMPTY_EFFECTIVE_QUERY_SHOULD_NOT_LEAK',
      queryRewriteKind: 'none',
      rewritten: false,
      strategy: 'auto',
      candidateCount: 0,
      selectedCount: 0,
      candidateEventIds: [],
      selectedEventIds: [],
      candidateDetails: [],
      selectedDetails: [],
      createdAt: '2026-05-09T00:30:00.000Z'
    }
  ]
};

describe('retrieval review queue replay promotion', () => {
  it('builds privacy-safe golden replay promotion candidates from review queue items', () => {
    const plan = buildReplayPromotionPlan(reviewQueue, {
      generatedAt: '2026-05-09T02:00:00.000Z',
      maxItems: 2
    });
    const serialized = JSON.stringify(plan);

    expect(plan).toMatchObject({
      name: 'retrieval-review-golden-promotion-candidates',
      metadata: {
        rawContentIncluded: false,
        requiresHumanLabeling: true,
        source: 'retrieval-review-queue'
      },
      summary: {
        sourceReviewItems: 2,
        promotedCandidates: 2,
        requiresHumanLabeling: 2
      }
    });
    expect(plan.candidates[0]).toMatchObject({
      candidateId: 'promo-trace-rewrite-empty',
      sourceTraceId: 'trace-rewrite-empty',
      reviewReason: 'rewritten-query-no-selection',
      category: 'review-rewritten-query-no-selection',
      suggestedExpectation: 'match',
      queryRewriteKind: 'follow-up-context',
      candidateEventIds: ['candidate-a', 'candidate-b'],
      replayQuerySkeleton: {
        queryId: 'q-review-trace-rewrite-empty',
        category: 'review-rewritten-query-no-selection',
        query: 'TODO_REDACTED_SYNTHETIC_QUERY_trace-rewrite-empty',
        expectation: 'match',
        expectedIds: ['TODO_EXPECTED_MEMORY_ID'],
        expectedRelevance: { TODO_EXPECTED_MEMORY_ID: 2 }
      }
    });
    expect(plan.candidates[1].sourceTraceId).toMatch(/^trace-[a-f0-9]{12}$/);
    expect(plan.candidates[1].replayQuerySkeleton.query).toMatch(/^TODO_REDACTED_SYNTHETIC_QUERY_trace-[a-f0-9]{12}$/);
    expect(serialized).not.toContain('PRIVATE_');
    expect(serialized).not.toContain('/Users/private');
    expect(serialized).not.toContain('rawQueryText');
    expect(serialized).not.toContain('queryText');
    expect(serialized).not.toContain('title');
    expect(serialized).not.toContain('detail');
    expect(serialized).not.toContain('action');
  });

  it('redacts credential-like identifier fields before building candidates', () => {
    const plan = buildReplayPromotionPlan({
      summary: { totalTraces: 1, reviewItems: 1, returnedItems: 1 },
      items: [
        {
          traceId: 'ghp_FAKE_TRACE',
          reason: 'candidate-no-selection',
          priority: 90,
          queryRewriteKind: 'none',
          strategy: 'sk-fake-strategy',
          candidateCount: 1,
          selectedCount: 0,
          candidateEventIds: ['github_pat_FAKE_EVENT', 'gho_FAKE_EVENT', 'ghu_FAKE_EVENT'],
          selectedEventIds: ['xoxb-fake-selected', 'xoxc-fake-selected'],
          candidateDetails: [
            { eventId: 'AKIAFAKEDETAIL', score: 0.4 },
            { eventId: 'ASIAFAKEDETAIL', score: 0.5 },
            { eventId: 'ya29.fake-detail', score: 0.6 }
          ],
          selectedDetails: [
            { eventId: 'glpat-fake-selected-detail', score: 0.3 },
            { eventId: 'ghs_FAKE_SELECTED_DETAIL', score: 0.2 },
            { eventId: 'ghr_FAKE_SELECTED_DETAIL', score: 0.1 }
          ]
        }
      ]
    }, { generatedAt: '2026-05-09T02:00:00.000Z' });
    const serialized = JSON.stringify(plan);

    expect(plan.candidates[0].sourceTraceId).toMatch(/^trace-[a-f0-9]{12}$/);
    expect(plan.candidates[0].candidateEventIds[0]).toMatch(/^event-[a-f0-9]{12}$/);
    expect(plan.candidates[0].candidateEventIds[1]).toMatch(/^event-[a-f0-9]{12}$/);
    expect(plan.candidates[0].candidateEventIds[2]).toMatch(/^event-[a-f0-9]{12}$/);
    expect(plan.candidates[0].selectedEventIds[0]).toMatch(/^event-[a-f0-9]{12}$/);
    expect(plan.candidates[0].selectedEventIds[1]).toMatch(/^event-[a-f0-9]{12}$/);
    expect(plan.candidates[0].candidateDetails[0].eventId).toMatch(/^event-[a-f0-9]{12}$/);
    expect(plan.candidates[0].candidateDetails[1].eventId).toMatch(/^event-[a-f0-9]{12}$/);
    expect(plan.candidates[0].candidateDetails[2].eventId).toMatch(/^event-[a-f0-9]{12}$/);
    expect(plan.candidates[0].selectedDetails[0].eventId).toMatch(/^event-[a-f0-9]{12}$/);
    expect(plan.candidates[0].selectedDetails[1].eventId).toMatch(/^event-[a-f0-9]{12}$/);
    expect(plan.candidates[0].selectedDetails[2].eventId).toMatch(/^event-[a-f0-9]{12}$/);
    expect(plan.candidates[0].strategy).toMatch(/^value-[a-f0-9]{12}$/);
    expect(serialized).not.toMatch(/ghp_|github_pat_|gho_|ghu_|ghs_|ghr_|sk-|xoxb-|xoxc-|AKIA|ASIA|ya29\.|glpat-/i);
  });

  it('keeps candidate and query skeleton IDs unique when trace IDs are missing or duplicated', () => {
    const plan = buildReplayPromotionPlan({
      summary: { totalTraces: 4, reviewItems: 4, returnedItems: 4 },
      items: [
        { reason: 'empty-candidate-set', priority: 70, candidateCount: 0, selectedCount: 0 },
        { traceId: '', reason: 'candidate-no-selection', priority: 60, candidateCount: 1, selectedCount: 0 },
        { traceId: 'trace-duplicate', reason: 'candidate-no-selection', priority: 50, candidateCount: 1, selectedCount: 0 },
        { traceId: 'trace-duplicate', reason: 'candidate-no-selection', priority: 40, candidateCount: 1, selectedCount: 0 }
      ]
    }, { generatedAt: '2026-05-09T02:00:00.000Z' });
    const candidateIds = plan.candidates.map((candidate) => candidate.candidateId);
    const queryIds = plan.candidates.map((candidate) => candidate.replayQuerySkeleton.queryId);
    const placeholderQueries = plan.candidates.map((candidate) => candidate.replayQuerySkeleton.query);

    expect(new Set(candidateIds).size).toBe(candidateIds.length);
    expect(new Set(queryIds).size).toBe(queryIds.length);
    expect(new Set(placeholderQueries).size).toBe(placeholderQueries.length);
  });

  it('rejects malformed generatedAt values in the core helper', () => {
    for (const generatedAt of ['1', '05/09/2026', '2026-05-09 04:00:00', '2026-02-31T00:00:00.000Z']) {
      expect(() => buildReplayPromotionPlan(reviewQueue, { generatedAt })).toThrow('Invalid generatedAt');
    }
  });

  it('formats a markdown labeling checklist without raw query or memory content', () => {
    const plan = buildReplayPromotionPlan(reviewQueue, {
      generatedAt: '2026-05-09T02:00:00.000Z',
      maxItems: 1
    });
    const markdown = formatReplayPromotionMarkdown(plan);

    expect(markdown).toContain('# Retrieval Review Golden Promotion Candidates');
    expect(markdown).toContain('q-review-trace-rewrite-empty');
    expect(markdown).toContain('Fill `query` with a privacy-safe synthetic prompt');
    expect(markdown).toContain('Run `npm run eval:retrieval-replay` after promotion');
    expect(markdown).not.toContain('PRIVATE_');
    expect(markdown).not.toContain('/Users/private');
    expect(markdown).not.toContain('rawQueryText');
    expect(markdown).not.toContain('queryText');
  });
});
