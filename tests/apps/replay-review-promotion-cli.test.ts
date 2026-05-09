import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

function writeReviewQueue(name: string, reviewQueue: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-review-promo-'));
  const reviewQueuePath = path.join(dir, `${name}.json`);
  writeFileSync(reviewQueuePath, `${JSON.stringify(reviewQueue, null, 2)}\n`, 'utf8');
  return reviewQueuePath;
}

function runPromotionCli(args: string[]) {
  return spawnSync('npx', ['tsx', 'scripts/promote-retrieval-review-queue.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
}

describe('retrieval review queue promotion CLI', () => {
  it('exports a privacy-safe promotion plan as JSON', () => {
    const inputPath = writeReviewQueue('review-queue', {
      summary: { totalTraces: 1, reviewItems: 1, returnedItems: 1 },
      items: [
        {
          traceId: 'trace-rewrite-empty',
          reason: 'rewritten-query-no-selection',
          priority: 100,
          rawQueryText: 'PRIVATE_RAW_QUERY_SHOULD_NOT_LEAK',
          queryText: 'PRIVATE_EFFECTIVE_QUERY_SHOULD_NOT_LEAK',
          title: 'PRIVATE_TITLE_SHOULD_NOT_LEAK',
          detail: 'PRIVATE_DETAIL_SHOULD_NOT_LEAK',
          action: 'PRIVATE_ACTION_SHOULD_NOT_LEAK',
          queryRewriteKind: 'intent-rewrite',
          strategy: 'auto',
          candidateCount: 3,
          selectedCount: 0,
          candidateEventIds: ['candidate-a'],
          selectedEventIds: [],
          candidateDetails: [{ eventId: 'candidate-a', score: 0.9 }],
          selectedDetails: [],
          createdAt: '2026-05-09T03:00:00.000Z'
        }
      ]
    });

    const result = runPromotionCli([
      '--review-queue', inputPath,
      '--generated-at', '2026-05-09T04:00:00.000Z',
      '--format', 'json'
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const plan = JSON.parse(result.stdout);
    expect(plan.candidates[0].replayQuerySkeleton.queryId).toBe('q-review-trace-rewrite-empty');
    expect(result.stdout).not.toContain('PRIVATE_');
    expect(result.stdout).not.toContain('rawQueryText');
    expect(result.stdout).not.toContain('queryText');
  });

  it('writes markdown output to a file when requested', () => {
    const inputPath = writeReviewQueue('review-queue-md', {
      summary: { totalTraces: 1, reviewItems: 1, returnedItems: 1 },
      items: [{ traceId: 'trace-empty', reason: 'empty-candidate-set', priority: 70, candidateCount: 0, selectedCount: 0 }]
    });
    const outPath = path.join(path.dirname(inputPath), 'promotion.md');

    const result = runPromotionCli([
      '--review-queue', inputPath,
      '--out', outPath,
      '--format', 'markdown',
      '--max-items', '1'
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    const markdown = readFileSync(outPath, 'utf8');
    expect(markdown).toContain('# Retrieval Review Golden Promotion Candidates');
    expect(markdown).toContain('q-review-trace-empty');
    expect(markdown).toContain('Report intentionally omits raw query and memory text');
  });

  it('fails closed on malformed numeric options before reading input', () => {
    const result = runPromotionCli([
      '--review-queue', '/path/that/should/not/be/read.json',
      '--max-items', '2oops'
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid --max-items');
    expect(result.stderr).not.toContain('ENOENT');
    expect(result.stdout).toBe('');
  });

  it('fails closed on malformed generated-at timestamps before reading input', () => {
    for (const invalidTimestamp of ['1', '05/09/2026', '2026-05-09 04:00:00', '2026-02-31T00:00:00.000Z']) {
      const result = runPromotionCli([
        '--review-queue', '/path/that/should/not/be/read.json',
        '--generated-at', invalidTimestamp
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Invalid --generated-at');
      expect(result.stderr).not.toContain('ENOENT');
      expect(result.stdout).toBe('');
    }
  });
});
