import { describe, expect, it } from 'vitest';

import type { ReplayEvaluationFixture } from '../../src/core/replay-evaluator.js';
import type { ReplayPromotionPlan, ReplayPromotionQuerySkeleton } from '../../src/core/replay-promotion.js';
import {
  buildReplayPromotionAppendReport,
  formatReplayPromotionAppendMarkdown
} from '../../src/core/replay-promotion-append.js';

const fixture: ReplayEvaluationFixture = {
  name: 'golden-memory-usefulness-v1',
  description: 'privacy-safe fixture',
  metadata: { rawContentIncluded: false, generatedAt: '2026-05-09T00:00:00.000Z' },
  ks: [1, 3, 5],
  queries: [
    {
      queryId: 'q-existing',
      category: 'existing',
      query: 'existing safe query',
      expectation: 'match',
      expectedIds: ['m-existing'],
      expectedRelevance: { 'm-existing': 2 }
    }
  ],
  memories: [
    { id: 'm-existing', content: 'Existing privacy-safe synthetic memory.' },
    { id: 'm-review-fix', content: 'Synthetic review fix memory.' }
  ]
};

function promotionPlanWithSkeleton(skeleton: ReplayPromotionQuerySkeleton): ReplayPromotionPlan {
  return {
    name: 'retrieval-review-golden-promotion-candidates',
    description: 'candidate plan',
    generatedAt: '2026-05-09T04:00:00.000Z',
    metadata: {
      rawContentIncluded: false,
      requiresHumanLabeling: true,
      source: 'retrieval-review-queue'
    },
    sourceSummary: {
      totalTraces: 1,
      reviewItems: 1,
      returnedItems: 1,
      candidateNoSelection: 1,
      emptyCandidateSet: 0,
      rewrittenNoSelection: 0,
      lowSelectionRate: 0
    },
    summary: {
      sourceReviewItems: 1,
      promotedCandidates: 1,
      requiresHumanLabeling: 1
    },
    candidates: [
      {
        candidateId: 'promo-trace-ready',
        sourceTraceId: 'trace-ready',
        reviewReason: 'candidate-no-selection',
        category: 'review-candidate-no-selection',
        priority: 90,
        suggestedExpectation: 'match',
        queryRewriteKind: 'none',
        rewritten: false,
        strategy: 'auto',
        candidateCount: 1,
        selectedCount: 0,
        candidateEventIds: ['candidate-a'],
        selectedEventIds: [],
        candidateDetails: [{ eventId: 'candidate-a', score: 0.9 }],
        selectedDetails: [],
        createdAt: '2026-05-09T03:00:00.000Z',
        replayQuerySkeleton: skeleton,
        manualLabelingChecklist: []
      }
    ]
  };
}

const labeledPlan = promotionPlanWithSkeleton({
  queryId: 'q-review-trace-ready',
  category: 'review-candidate-no-selection',
  query: 'synthetic prompt for retrieval review candidate no selection',
  expectation: 'match',
  expectedIds: ['m-review-fix'],
  expectedRelevance: { 'm-review-fix': 2 },
  forbiddenIds: []
});

const credentialCandidateIdFixture = 'tokenFixtureCandidateShouldNotLeak';
const credentialQueryIdFixture = 'tokenFixtureQueryShouldNotLeak';
const credentialQueryValueFixture = 'tokenFixtureQueryValueShouldNotLeak';
const bearerQueryFixture = 'Authorization: Bearer fixtureAuthorizationBearerShouldNotLeak';
const authorizationHeaderQueryFixture = 'Authorization: Token fixtureAuthorizationHeaderShouldNotLeak';

describe('replay promotion append validation', () => {
  it('builds a merged fixture draft from fully labeled promotion candidates', () => {
    const report = buildReplayPromotionAppendReport(labeledPlan, fixture, {
      generatedAt: '2026-05-09T05:00:00.000Z'
    });

    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.summary).toMatchObject({
      candidatesRead: 1,
      appendedQueries: 1,
      existingQueries: 1,
      memoryCount: 2
    });
    expect(report.mergedFixture?.metadata).toMatchObject({
      rawContentIncluded: false,
      generatedAt: '2026-05-09T05:00:00.000Z'
    });
    expect(report.mergedFixture?.queries.map((query) => query.queryId)).toEqual([
      'q-existing',
      'q-review-trace-ready'
    ]);
    expect(JSON.stringify(report)).not.toContain('TODO_');
  });

  it('rejects candidates with placeholders, missing expected memory ids, duplicates, or unsafe fields', () => {
    const unsafeCandidate = {
      ...labeledPlan.candidates[0],
      candidateId: '/Users/private/raw-query-should-not-leak',
      replayQuerySkeleton: {
        ...labeledPlan.candidates[0].replayQuerySkeleton,
        queryId: '/Users/private/q-unsafe-field'
      },
      rawQueryText: '/Users/private/raw-query-should-not-leak'
    };
    const badPlan: ReplayPromotionPlan = {
      ...labeledPlan,
      candidates: [
        {
          ...labeledPlan.candidates[0],
          candidateId: 'promo-placeholder',
          replayQuerySkeleton: {
            ...labeledPlan.candidates[0].replayQuerySkeleton,
            queryId: 'q-placeholder',
            query: 'TODO_REDACTED_SYNTHETIC_QUERY_trace-placeholder',
            expectedIds: ['TODO_EXPECTED_MEMORY_ID'],
            expectedRelevance: { TODO_EXPECTED_MEMORY_ID: 2 }
          }
        },
        {
          ...labeledPlan.candidates[0],
          candidateId: 'promo-missing-memory',
          replayQuerySkeleton: {
            ...labeledPlan.candidates[0].replayQuerySkeleton,
            queryId: 'q-missing-memory',
            expectedIds: ['m-does-not-exist'],
            expectedRelevance: { 'm-does-not-exist': 2 }
          }
        },
        {
          ...labeledPlan.candidates[0],
          candidateId: 'promo-duplicate-query',
          replayQuerySkeleton: {
            ...labeledPlan.candidates[0].replayQuerySkeleton,
            queryId: 'q-existing'
          }
        },
        unsafeCandidate
      ]
    };

    const report = buildReplayPromotionAppendReport(badPlan, fixture);
    const codes = report.issues.map((issue) => issue.code);
    const serialized = JSON.stringify(report);

    expect(report.ok).toBe(false);
    expect(report.mergedFixture).toBeUndefined();
    expect(codes).toEqual(expect.arrayContaining([
      'placeholder_remaining',
      'unknown_expected_id',
      'duplicate_query_id',
      'unsafe_field'
    ]));
    expect(serialized).not.toContain('/Users/private');
    expect(serialized).not.toContain('raw-query-should-not-leak');
    expect(serialized).not.toContain('TODO_REDACTED_SYNTHETIC_QUERY_trace-placeholder');
  });

  it('rejects placeholders in copied fixture fields and broad raw content keys', () => {
    const rawMemoryCandidate = {
      ...labeledPlan.candidates[0],
      candidateId: 'promo-raw-memory-content',
      rawMemoryContent: '/Users/private/raw-memory-should-not-leak',
      replayQuerySkeleton: {
        ...labeledPlan.candidates[0].replayQuerySkeleton,
        queryId: 'q-raw-memory-content'
      }
    };
    const pathKeyedRawMemoryCandidate = {
      ...labeledPlan.candidates[0],
      candidateId: 'promo-path-keyed-raw-memory-content',
      '/Users/private/rawMemoryContent': 'safe synthetic marker',
      replayQuerySkeleton: {
        ...labeledPlan.candidates[0].replayQuerySkeleton,
        queryId: 'q-path-keyed-raw-memory-content'
      }
    };
    const unsafePlan: ReplayPromotionPlan = {
      ...labeledPlan,
      candidates: [
        {
          ...labeledPlan.candidates[0],
          candidateId: 'promo-category-placeholder',
          replayQuerySkeleton: {
            ...labeledPlan.candidates[0].replayQuerySkeleton,
            queryId: 'q-category-placeholder',
            category: 'TODO_CATEGORY'
          }
        },
        rawMemoryCandidate,
        pathKeyedRawMemoryCandidate
      ]
    };

    const report = buildReplayPromotionAppendReport(unsafePlan, fixture);
    const codes = report.issues.map((issue) => issue.code);
    const serialized = JSON.stringify(report);

    expect(report.ok).toBe(false);
    expect(report.mergedFixture).toBeUndefined();
    expect(codes).toEqual(expect.arrayContaining(['placeholder_remaining', 'unsafe_field']));
    expect(serialized).not.toContain('TODO_CATEGORY');
    expect(serialized).not.toContain('/Users/private');
    expect(serialized).not.toContain('rawMemoryContent');
    expect(serialized).not.toContain('raw-memory-should-not-leak');
  });

  it('rejects candidate-level placeholders and sensitive field keys without exposing them', () => {
    const candidateWithUnsafeMetadata = {
      ...labeledPlan.candidates[0],
      candidateId: 'TODO_CANDIDATE_ID',
      metadataNote: 'TODO_METADATA_SHOULD_NOT_LEAK',
      privateKey: 'safe synthetic marker',
      Authorization: 'safe synthetic marker',
      replayQuerySkeleton: {
        ...labeledPlan.candidates[0].replayQuerySkeleton,
        queryId: 'q-candidate-level-privacy'
      }
    } as ReplayPromotionPlan['candidates'][number] & Record<string, unknown>;
    const unsafePlan: ReplayPromotionPlan = {
      ...labeledPlan,
      candidates: [candidateWithUnsafeMetadata]
    };

    const report = buildReplayPromotionAppendReport(unsafePlan, fixture);
    const codes = report.issues.map((issue) => issue.code);
    const serialized = JSON.stringify(report);

    expect(report.ok).toBe(false);
    expect(report.mergedFixture).toBeUndefined();
    expect(codes).toEqual(expect.arrayContaining(['placeholder_remaining', 'unsafe_field']));
    expect(serialized).not.toContain('TODO_CANDIDATE_ID');
    expect(serialized).not.toContain('TODO_METADATA_SHOULD_NOT_LEAK');
    expect(serialized).not.toContain('privateKey');
    expect(serialized).not.toContain('Authorization');
  });

  it('rejects credential-shaped values and unsafe object keys without exposing identifiers', () => {
    const unsafeCredentialCandidate = {
      ...labeledPlan.candidates[0],
      candidateId: credentialCandidateIdFixture,
      replayQuerySkeleton: {
        ...labeledPlan.candidates[0].replayQuerySkeleton,
        queryId: credentialQueryIdFixture,
        query: credentialQueryValueFixture,
        expectedIds: ['m-does-not-exist'],
        expectedRelevance: { 'm-does-not-exist': 2 }
      }
    };
    const unsafeKeyCandidate = {
      ...labeledPlan.candidates[0],
      candidateId: 'promo-local-path-key',
      '/Users/private/plainKey': 'safe synthetic marker',
      replayQuerySkeleton: {
        ...labeledPlan.candidates[0].replayQuerySkeleton,
        queryId: 'q-local-path-key'
      }
    };
    const unsafePlan: ReplayPromotionPlan = {
      ...labeledPlan,
      candidates: [unsafeCredentialCandidate, unsafeKeyCandidate]
    };

    const report = buildReplayPromotionAppendReport(unsafePlan, fixture);
    const codes = report.issues.map((issue) => issue.code);
    const serialized = JSON.stringify(report);

    expect(report.ok).toBe(false);
    expect(report.mergedFixture).toBeUndefined();
    expect(codes).toEqual(expect.arrayContaining(['unsafe_value', 'unsafe_field', 'unknown_expected_id']));
    expect(serialized).not.toContain(credentialCandidateIdFixture);
    expect(serialized).not.toContain(credentialQueryIdFixture);
    expect(serialized).not.toContain(credentialQueryValueFixture);
    expect(serialized).not.toContain('/Users/private');
    expect(serialized).not.toContain('plainKey');
  });

  it('rejects authorization bearer values before creating merged fixtures', () => {
    const bearerPlan: ReplayPromotionPlan = {
      ...labeledPlan,
      candidates: [
        {
          ...labeledPlan.candidates[0],
          candidateId: 'promo-bearer-query',
          replayQuerySkeleton: {
            ...labeledPlan.candidates[0].replayQuerySkeleton,
            queryId: 'q-bearer-query',
            query: bearerQueryFixture
          }
        }
      ]
    };

    const report = buildReplayPromotionAppendReport(bearerPlan, fixture);
    const serialized = JSON.stringify(report);

    expect(report.ok).toBe(false);
    expect(report.mergedFixture).toBeUndefined();
    expect(report.issues.map((issue) => issue.code)).toContain('unsafe_value');
    expect(serialized).not.toContain(bearerQueryFixture);
    expect(serialized).not.toContain('fixtureAuthorizationBearerShouldNotLeak');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('Bearer');
  });

  it('rejects non-bearer authorization header values before creating merged fixtures', () => {
    const authorizationHeaderPlan: ReplayPromotionPlan = {
      ...labeledPlan,
      candidates: [
        {
          ...labeledPlan.candidates[0],
          candidateId: 'promo-authorization-header-query',
          replayQuerySkeleton: {
            ...labeledPlan.candidates[0].replayQuerySkeleton,
            queryId: 'q-authorization-header-query',
            query: authorizationHeaderQueryFixture
          }
        }
      ]
    };

    const report = buildReplayPromotionAppendReport(authorizationHeaderPlan, fixture);
    const serialized = JSON.stringify(report);

    expect(report.ok).toBe(false);
    expect(report.mergedFixture).toBeUndefined();
    expect(report.issues.map((issue) => issue.code)).toContain('unsafe_value');
    expect(serialized).not.toContain(authorizationHeaderQueryFixture);
    expect(serialized).not.toContain('fixtureAuthorizationHeaderShouldNotLeak');
    expect(serialized).not.toContain('Authorization');
  });

  it('rejects bare TODO markers, sensitive public identifiers, and broad local path keys', () => {
    const broadPathKey = '~/private/plainKey';
    const broadPathCandidate = {
      ...labeledPlan.candidates[0],
      candidateId: 'promo-broad-path-key',
      [broadPathKey]: 'safe synthetic marker',
      replayQuerySkeleton: {
        ...labeledPlan.candidates[0].replayQuerySkeleton,
        queryId: 'q-broad-path-key'
      }
    } as ReplayPromotionPlan['candidates'][number] & Record<string, unknown>;
    const unsafePlan: ReplayPromotionPlan = {
      ...labeledPlan,
      candidates: [
        {
          ...labeledPlan.candidates[0],
          candidateId: 'promo-bare-todo',
          replayQuerySkeleton: {
            ...labeledPlan.candidates[0].replayQuerySkeleton,
            queryId: 'q-bare-todo',
            query: 'TODO',
            expectedIds: ['m-review-fix'],
            expectedRelevance: { 'm-review-fix': 2 }
          }
        },
        {
          ...labeledPlan.candidates[0],
          candidateId: 'privateKey',
          replayQuerySkeleton: {
            ...labeledPlan.candidates[0].replayQuerySkeleton,
            queryId: 'Authorization',
            expectedIds: ['m-does-not-exist'],
            expectedRelevance: { 'm-does-not-exist': 2 }
          }
        },
        broadPathCandidate
      ]
    };

    const report = buildReplayPromotionAppendReport(unsafePlan, fixture);
    const codes = report.issues.map((issue) => issue.code);
    const serialized = JSON.stringify(report);

    expect(report.ok).toBe(false);
    expect(report.mergedFixture).toBeUndefined();
    expect(codes).toEqual(expect.arrayContaining(['placeholder_remaining', 'unknown_expected_id', 'unsafe_field']));
    expect(serialized).not.toContain('TODO');
    expect(serialized).not.toContain('privateKey');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain(broadPathKey);
    expect(serialized).not.toContain('plainKey');
  });

  it('rejects bare absolute paths and sensitive copied primitive values before merging', () => {
    const barePathFixture = '/fixturepath';
    const unsafePlan: ReplayPromotionPlan = {
      ...labeledPlan,
      candidates: [
        {
          ...labeledPlan.candidates[0],
          candidateId: 'promo-bare-absolute-path',
          replayQuerySkeleton: {
            ...labeledPlan.candidates[0].replayQuerySkeleton,
            queryId: 'q-bare-absolute-path',
            query: barePathFixture,
            expectedIds: ['m-review-fix'],
            expectedRelevance: { 'm-review-fix': 2 }
          }
        },
        {
          ...labeledPlan.candidates[0],
          candidateId: 'promo-sensitive-copied-value',
          replayQuerySkeleton: {
            ...labeledPlan.candidates[0].replayQuerySkeleton,
            queryId: 'privateKey',
            category: 'Authorization',
            query: 'safe synthetic retrieval query',
            expectedIds: ['m-review-fix'],
            expectedRelevance: { 'm-review-fix': 2 }
          }
        }
      ]
    };

    const report = buildReplayPromotionAppendReport(unsafePlan, fixture);
    const serialized = JSON.stringify(report);

    expect(report.ok).toBe(false);
    expect(report.mergedFixture).toBeUndefined();
    expect(report.issues.map((issue) => issue.code)).toContain('unsafe_value');
    expect(serialized).not.toContain(barePathFixture);
    expect(serialized).not.toContain('fixtureSecretPathShouldNotLeak');
    expect(serialized).not.toContain('privateKey');
    expect(serialized).not.toContain('Authorization');
  });

  it('rejects embedded single-segment absolute POSIX path tokens before merging', () => {
    const embeddedPathFixture = 'safe synthetic /fixturepath marker';
    const unsafePlan: ReplayPromotionPlan = {
      ...labeledPlan,
      candidates: [
        {
          ...labeledPlan.candidates[0],
          candidateId: 'promo-embedded-path-token',
          replayQuerySkeleton: {
            ...labeledPlan.candidates[0].replayQuerySkeleton,
            queryId: 'q-embedded-path-token',
            query: embeddedPathFixture,
            expectedIds: ['m-review-fix'],
            expectedRelevance: { 'm-review-fix': 2 }
          }
        }
      ]
    };

    const report = buildReplayPromotionAppendReport(unsafePlan, fixture);
    const serialized = JSON.stringify(report);

    expect(report.ok).toBe(false);
    expect(report.mergedFixture).toBeUndefined();
    expect(report.issues.map((issue) => issue.code)).toContain('unsafe_value');
    expect(serialized).not.toContain(embeddedPathFixture);
    expect(serialized).not.toContain('/fixturepath');
  });

  it('rejects punctuation-delimited POSIX path tokens and hyphenated raw field keys', () => {
    const punctuatedPathFixture = 'safe synthetic (/fixturepath) marker';
    const hyphenatedRawField = 'raw-query-text';
    const unsafePlan: ReplayPromotionPlan = {
      ...labeledPlan,
      candidates: [
        {
          ...labeledPlan.candidates[0],
          candidateId: 'promo-punctuated-path-token',
          replayQuerySkeleton: {
            ...labeledPlan.candidates[0].replayQuerySkeleton,
            queryId: 'q-punctuated-path-token',
            query: punctuatedPathFixture,
            expectedIds: ['m-review-fix'],
            expectedRelevance: { 'm-review-fix': 2 }
          }
        },
        {
          ...labeledPlan.candidates[0],
          candidateId: 'promo-hyphenated-raw-field',
          [hyphenatedRawField]: 'safe synthetic marker',
          replayQuerySkeleton: {
            ...labeledPlan.candidates[0].replayQuerySkeleton,
            queryId: 'q-hyphenated-raw-field',
            expectedIds: ['m-review-fix'],
            expectedRelevance: { 'm-review-fix': 2 }
          }
        } as ReplayPromotionPlan['candidates'][number] & Record<string, unknown>
      ]
    };

    const report = buildReplayPromotionAppendReport(unsafePlan, fixture);
    const serialized = JSON.stringify(report);

    expect(report.ok).toBe(false);
    expect(report.mergedFixture).toBeUndefined();
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['unsafe_value', 'unsafe_field']));
    expect(serialized).not.toContain(punctuatedPathFixture);
    expect(serialized).not.toContain('/fixturepath');
    expect(serialized).not.toContain(hyphenatedRawField);
    expect(serialized).not.toContain('raw-query');
  });

  it('rejects bracket and symbol-delimited single-segment POSIX path tokens', () => {
    const pathFixtures = [
      'safe synthetic [/fixturepath] marker',
      'safe synthetic {/fixturepath} marker',
      'safe synthetic </fixturepath> marker',
      'safe synthetic `/fixturepath` marker',
      'safe synthetic |/fixturepath| marker'
    ];
    pathFixtures.forEach((pathFixture, index) => {
      const unsafePlan: ReplayPromotionPlan = {
        ...labeledPlan,
        candidates: [
          {
            ...labeledPlan.candidates[0],
            candidateId: `promo-symbol-path-token-${index}`,
            replayQuerySkeleton: {
              ...labeledPlan.candidates[0].replayQuerySkeleton,
              queryId: `q-symbol-path-token-${index}`,
              query: pathFixture,
              expectedIds: ['m-review-fix'],
              expectedRelevance: { 'm-review-fix': 2 }
            }
          }
        ]
      };

      const report = buildReplayPromotionAppendReport(unsafePlan, fixture);
      const serialized = JSON.stringify(report);

      expect(report.ok).toBe(false);
      expect(report.mergedFixture).toBeUndefined();
      expect(report.issues.map((issue) => issue.code)).toContain('unsafe_value');
      expect(serialized).not.toContain(pathFixture);
      expect(serialized).not.toContain('/fixturepath');
    });
  });

  it('rejects hyphen dot and underscore-delimited single-segment POSIX path tokens', () => {
    const pathFixtures = [
      'safe synthetic -/fixturepath- marker',
      'safe synthetic ./fixturepath. marker',
      'safe synthetic _/fixturepath_ marker'
    ];
    pathFixtures.forEach((pathFixture, index) => {
      const unsafePlan: ReplayPromotionPlan = {
        ...labeledPlan,
        candidates: [
          {
            ...labeledPlan.candidates[0],
            candidateId: `promo-posix-delimiter-${index}`,
            replayQuerySkeleton: {
              ...labeledPlan.candidates[0].replayQuerySkeleton,
              queryId: `q-posix-delimiter-${index}`,
              query: pathFixture,
              expectedIds: ['m-review-fix'],
              expectedRelevance: { 'm-review-fix': 2 }
            }
          }
        ]
      };

      const report = buildReplayPromotionAppendReport(unsafePlan, fixture);
      const serialized = JSON.stringify(report);

      expect(report.ok).toBe(false);
      expect(report.mergedFixture).toBeUndefined();
      expect(report.issues.map((issue) => issue.code)).toContain('unsafe_value');
      expect(serialized).not.toContain(pathFixture);
      expect(serialized).not.toContain('/fixturepath');
    });
  });

  it('rejects punctuation-separated sensitive object keys before merging', () => {
    const sensitiveKeys = ['raw.query.text', 'query.text', 'private.key', 'api.key', 'memory.content'];
    sensitiveKeys.forEach((sensitiveKey, index) => {
      const unsafePlan: ReplayPromotionPlan = {
        ...labeledPlan,
        candidates: [
          {
            ...labeledPlan.candidates[0],
            candidateId: `promo-sensitive-key-${index}`,
            [sensitiveKey]: 'safe synthetic marker',
            replayQuerySkeleton: {
              ...labeledPlan.candidates[0].replayQuerySkeleton,
              queryId: `q-sensitive-key-${index}`,
              expectedIds: ['m-review-fix'],
              expectedRelevance: { 'm-review-fix': 2 }
            }
          } as ReplayPromotionPlan['candidates'][number] & Record<string, unknown>
        ]
      };

      const report = buildReplayPromotionAppendReport(unsafePlan, fixture);
      const serialized = JSON.stringify(report);

      expect(report.ok).toBe(false);
      expect(report.mergedFixture).toBeUndefined();
      expect(report.issues.map((issue) => issue.code)).toContain('unsafe_field');
      expect(serialized).not.toContain(sensitiveKey);
    });
  });

  it('rejects alphanumeric-suffixed TODO placeholders before merging', () => {
    const placeholderFixture = 'TODOfixtureShouldNotLeak';
    const unsafePlan: ReplayPromotionPlan = {
      ...labeledPlan,
      candidates: [
        {
          ...labeledPlan.candidates[0],
          candidateId: 'promo-placeholder-suffix',
          replayQuerySkeleton: {
            ...labeledPlan.candidates[0].replayQuerySkeleton,
            queryId: 'q-placeholder-suffix',
            query: placeholderFixture,
            expectedIds: ['m-review-fix'],
            expectedRelevance: { 'm-review-fix': 2 }
          }
        }
      ]
    };

    const report = buildReplayPromotionAppendReport(unsafePlan, fixture);
    const serialized = JSON.stringify(report);

    expect(report.ok).toBe(false);
    expect(report.mergedFixture).toBeUndefined();
    expect(report.issues.map((issue) => issue.code)).toContain('placeholder_remaining');
    expect(serialized).not.toContain(placeholderFixture);
    expect(serialized).not.toContain('TODOfixture');
  });

  it('formats a privacy-safe markdown report with the replay gate reminder', () => {
    const markdown = formatReplayPromotionAppendMarkdown(
      buildReplayPromotionAppendReport(labeledPlan, fixture)
    );

    expect(markdown).toContain('# Replay Promotion Append Validation');
    expect(markdown).toContain('Status: PASS');
    expect(markdown).toContain('Run `npm run eval:retrieval-replay` after writing the merged fixture');
    expect(markdown).not.toContain('synthetic prompt for retrieval review candidate');
    expect(markdown).not.toContain('Synthetic review fix memory');
  });
});
