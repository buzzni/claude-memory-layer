#!/usr/bin/env tsx
/**
 * grep-level retrieval baseline for a replay fixture (docs/BENCHMARKS.md).
 *
 *   tsx benchmarks/public/grep-baseline.ts --fixture <replay-fixture.json> [--top-k N]
 *
 * A memory's score is the number of distinct query terms it contains as a
 * case-insensitive substring, like `grep -i -F -e term1 -e term2` counting which
 * patterns hit. Ties keep fixture order. Terms are the query's letter/digit
 * runs of two or more characters minus a fixed English stopword list. No
 * stemming, no weighting, no index.
 *
 * Memories that carry metadata.questionId (LongMemEval fixtures written by
 * --fixture-out) are searched per question, as the LongMemEval runner does.
 * Scoring goes through evaluateReplayFixture, so the metrics have the same
 * definitions as the CML runs. Output is JSON without per-query rows.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeLongMemEvalRetrievalReport } from '../../src/core/longmemeval-analysis.js';
import {
  determineTopK,
  evaluateReplayFixture,
  type ReplayEvaluationFixture,
  type ReplayEvaluationMemory,
  type ReplayRetrievalRunner
} from '../../src/core/replay-evaluator.js';
import { buildProvenance, warnProvenance } from '../../scripts/eval-provenance.mjs';

const STOPWORDS = new Set([
  'a', 'about', 'after', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'before', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'how', 'i', 'if', 'in', 'into', 'is',
  'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 'so', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'this', 'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your'
]);

export function grepTerms(query: string): string[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return [...new Set(words.filter((word) => word.length >= 2 && !STOPWORDS.has(word)))];
}

export function createGrepRunner(fixture: ReplayEvaluationFixture): ReplayRetrievalRunner {
  const haystack = (memory: ReplayEvaluationMemory) => (memory.searchContent?.trim() || memory.content).toLowerCase();
  const texts = new Map(fixture.memories.map((memory) => [memory.id, haystack(memory)]));

  return async (query, input) => {
    const own = fixture.memories.filter((memory) => memory.metadata?.questionId === input.query.queryId);
    const memories = own.length > 0 ? own : fixture.memories;
    const terms = grepTerms(query);
    const retrievedIds = memories
      .map((memory) => ({ id: memory.id, score: terms.filter((term) => texts.get(memory.id)!.includes(term)).length }))
      .filter((row) => row.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, input.topK)
      .map((row) => row.id);
    return { retrievedIds, confidence: retrievedIds.length > 0 ? 'high' : 'none' };
  };
}

async function main(argv: string[]): Promise<void> {
  let fixturePath: string | undefined;
  let topK: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fixture') fixturePath = argv[++i];
    else if (argv[i] === '--top-k') topK = Number(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!fixturePath) throw new Error('usage: tsx benchmarks/public/grep-baseline.ts --fixture <replay-fixture.json> [--top-k N]');

  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as ReplayEvaluationFixture;
  const k = determineTopK(fixture, topK);
  const report = await evaluateReplayFixture(fixture, {
    evaluator: 'grep-baseline-v1',
    topK: k,
    retrievalRunner: createGrepRunner(fixture)
  });
  const provenance = buildProvenance({
    generatedAt: report.generatedAt,
    fixtures: [fixturePath],
    retrieval: { topK: k, candidatePool: fixture.memories.length },
    flags: { topK }
  });
  warnProvenance(provenance);
  const longMemEvalAnalysis = analyzeLongMemEvalRetrievalReport(report, { k });
  process.stdout.write(`${JSON.stringify({ ...report, perQuery: [], longMemEvalAnalysis, provenance }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
