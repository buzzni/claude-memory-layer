import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'cml-replay-promotion-append-'));
}

function writeJson(dir: string, name: string, value: unknown): string {
  const filePath = path.join(dir, name);
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return filePath;
}

function fixture() {
  return {
    name: 'golden-memory-usefulness-v1',
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
}

function promotionPlan(queryPatch: Record<string, unknown> = {}, candidatePatch: Record<string, unknown> = {}) {
  return {
    name: 'retrieval-review-golden-promotion-candidates',
    generatedAt: '2026-05-09T04:00:00.000Z',
    metadata: { rawContentIncluded: false, requiresHumanLabeling: true, source: 'retrieval-review-queue' },
    summary: { sourceReviewItems: 1, promotedCandidates: 1, requiresHumanLabeling: 1 },
    sourceSummary: { totalTraces: 1, reviewItems: 1, returnedItems: 1, candidateNoSelection: 1, emptyCandidateSet: 0, rewrittenNoSelection: 0, lowSelectionRate: 0 },
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
        replayQuerySkeleton: {
          queryId: 'q-review-trace-ready',
          category: 'review-candidate-no-selection',
          query: 'synthetic prompt for retrieval review candidate no selection',
          expectation: 'match',
          expectedIds: ['m-review-fix'],
          expectedRelevance: { 'm-review-fix': 2 },
          forbiddenIds: [],
          ...queryPatch
        },
        ...candidatePatch
      }
    ]
  };
}

function runAppendCli(args: string[]) {
  return spawnSync('npx', ['tsx', 'scripts/validate-replay-promotion-candidates.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
}

const credentialCandidateIdFixture = 'tokenFixtureCandidateShouldNotLeak';
const credentialQueryIdFixture = 'tokenFixtureQueryShouldNotLeak';
const credentialQueryValueFixture = 'tokenFixtureQueryValueShouldNotLeak';
const bearerQueryFixture = 'Authorization: Bearer fixtureAuthorizationBearerShouldNotLeak';

describe('replay promotion append CLI', () => {
  it('validates labeled candidates and writes a merged fixture draft', () => {
    const dir = tempDir();
    const fixturePath = writeJson(dir, 'fixture.json', fixture());
    const promotionPath = writeJson(dir, 'promotion.json', promotionPlan());
    const outPath = path.join(dir, 'merged-fixture.json');

    const result = runAppendCli([
      '--fixture', fixturePath,
      '--promotion', promotionPath,
      '--out', outPath,
      '--generated-at', '2026-05-09T05:00:00.000Z'
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    const merged = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(report.ok).toBe(true);
    expect(report).not.toHaveProperty('mergedFixture');
    expect(result.stdout).not.toContain('synthetic prompt for retrieval review candidate no selection');
    expect(result.stdout).not.toContain('Synthetic review fix memory');
    expect(report.summary.appendedQueries).toBe(1);
    expect(merged.queries.map((query: { queryId: string }) => query.queryId)).toEqual([
      'q-existing',
      'q-review-trace-ready'
    ]);
    expect(JSON.stringify(merged)).not.toContain('TODO_');
  });

  it('fails closed without writing when placeholders or unknown expected ids remain', () => {
    const dir = tempDir();
    const fixturePath = writeJson(dir, 'fixture.json', fixture());
    const promotionPath = writeJson(dir, 'promotion.json', promotionPlan({
      query: 'TODO_REDACTED_SYNTHETIC_QUERY_trace-ready',
      expectedIds: ['m-missing'],
      expectedRelevance: { 'm-missing': 2 }
    }));
    const outPath = path.join(dir, 'should-not-exist.json');

    const result = runAppendCli(['--fixture', fixturePath, '--promotion', promotionPath, '--out', outPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Promotion candidate validation failed');
    expect(result.stderr).not.toContain('TODO_REDACTED_SYNTHETIC_QUERY_trace-ready');
    expect(result.stdout).toContain('placeholder_remaining');
    expect(result.stdout).toContain('unknown_expected_id');
    expect(existsSync(outPath)).toBe(false);
  });

  it('reports privacy issues without echoing local paths or raw fields', () => {
    const dir = tempDir();
    const fixturePath = writeJson(dir, 'fixture.json', fixture());
    const promotionPath = writeJson(dir, 'promotion.json', promotionPlan({
      queryId: credentialQueryIdFixture,
      query: credentialQueryValueFixture,
      expectedIds: ['m-missing'],
      expectedRelevance: { 'm-missing': 2 }
    }, {
      candidateId: credentialCandidateIdFixture,
      rawQueryText: '/Users/private/raw-query-should-not-leak',
      '/Users/private/rawMemoryContent': 'safe synthetic marker',
      '/Users/private/plainKey': 'safe synthetic marker'
    }));

    const result = runAppendCli(['--fixture', fixturePath, '--promotion', promotionPath]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('unsafe_field');
    expect(result.stdout).not.toContain('/Users/private');
    expect(result.stdout).not.toContain('rawQueryText');
    expect(result.stdout).not.toContain('rawMemoryContent');
    expect(result.stdout).not.toContain('raw-query-should-not-leak');
    expect(result.stdout).not.toContain(credentialCandidateIdFixture);
    expect(result.stdout).not.toContain(credentialQueryIdFixture);
    expect(result.stdout).not.toContain(credentialQueryValueFixture);
    expect(result.stdout).not.toContain('plainKey');
    expect(result.stderr).not.toContain(credentialCandidateIdFixture);
    expect(result.stderr).not.toContain(credentialQueryIdFixture);
    expect(result.stderr).not.toContain(credentialQueryValueFixture);
    expect(result.stderr).not.toContain('/Users/private');
  });

  it('fails bearer authorization values without writing the merged fixture', () => {
    const dir = tempDir();
    const fixturePath = writeJson(dir, 'fixture.json', fixture());
    const promotionPath = writeJson(dir, 'promotion.json', promotionPlan({
      queryId: 'q-bearer-query',
      query: bearerQueryFixture
    }));
    const outPath = path.join(dir, 'should-not-exist-bearer.json');

    const result = runAppendCli(['--fixture', fixturePath, '--promotion', promotionPath, '--out', outPath]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('unsafe_value');
    expect(result.stdout).not.toContain(bearerQueryFixture);
    expect(result.stdout).not.toContain('fixtureAuthorizationBearerShouldNotLeak');
    expect(result.stdout).not.toContain('Authorization');
    expect(result.stdout).not.toContain('Bearer');
    expect(result.stderr).not.toContain(bearerQueryFixture);
    expect(result.stderr).not.toContain('fixtureAuthorizationBearerShouldNotLeak');
    expect(existsSync(outPath)).toBe(false);
  });

  it('fails malformed options before reading inputs without echoing raw values', () => {
    const result = runAppendCli([
      '--fixture', '/path/that/should/not/be/read.json',
      '--promotion', '/path/that/should/not/be/read-promotion.json',
      '--generated-at', '/Users/private/2026-05-09'
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid --generated-at');
    expect(result.stderr).not.toContain('/Users/private');
    expect(result.stderr).not.toContain('Unable to read');
    expect(result.stdout).toBe('');
  });
});
