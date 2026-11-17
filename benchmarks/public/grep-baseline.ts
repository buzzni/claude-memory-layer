#!/usr/bin/env tsx
/**
 * grep-level retrieval baseline for a replay fixture (docs/BENCHMARKS.md).
 *
 *   tsx benchmarks/public/grep-baseline.ts --fixture <replay-fixture.json> [--top-k N] [--mask-session-header]
 *
 * A memory's score is the number of distinct query terms it contains as a
 * case-insensitive substring, like `grep -i -F -e term1 -e term2` counting which
 * patterns hit. Ties keep fixture order. Terms are the query's letter/digit
 * runs of two or more characters minus a fixed English stopword list. No
 * stemming, no weighting, no index.
 *
 * Memories that carry metadata.questionId (LongMemEval fixtures written by
 * --fixture-out) are searched per question, as the LongMemEval runner does.
 * --mask-session-header replaces the session id in the header line the
 * LongMemEval converter writes (`[date] session <id>`), since evidence sessions
 * have ids starting with `answer_`. Scoring goes through evaluateReplayFixture,
 * so the metrics have the same definitions as the replay runs. Output is JSON
 * without per-query rows, plus the median scored length of evidence and other
 * memories.
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

/** Ids of the docs that contain a query term, most distinct terms first, ties in doc order. `text` must be lower case. */
export function grepRank(query: string, docs: ReadonlyArray<{ id: string; text: string }>, limit: number): string[] {
  const terms = grepTerms(query);
  return docs
    .map((doc) => ({ id: doc.id, score: terms.filter((term) => doc.text.includes(term)).length }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((row) => row.id);
}

/** Replaces the session id in a LongMemEval header line (`[date] session <id>[ turn N]`). */
export function maskSessionHeader(text: string): string {
  return text.replace(/^((?:\[[^\]\n]*\] )?session )\S+/, '$1#');
}

const scoredText = (memory: ReplayEvaluationMemory) => memory.searchContent?.trim() || memory.content;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Median scored length of memories some query expects, and of all the others. */
export function haystackLengths(fixture: ReplayEvaluationFixture) {
  const evidence = new Set(fixture.queries.flatMap((query) => query.expectedIds));
  const lengths = (keep: boolean) => fixture.memories.filter((memory) => evidence.has(memory.id) === keep).map((memory) => scoredText(memory).length);
  const summary = (values: number[]) => ({ count: values.length, medianChars: values.length ? median(values) : null });
  return { evidence: summary(lengths(true)), other: summary(lengths(false)) };
}

export function createGrepRunner(fixture: ReplayEvaluationFixture, options: { maskSessionHeader?: boolean } = {}): ReplayRetrievalRunner {
  const mask = options.maskSessionHeader ? maskSessionHeader : (text: string) => text;
  const docs = fixture.memories.map((memory) => ({ id: memory.id, text: mask(scoredText(memory)).toLowerCase() }));

  return async (query, input) => {
    const own = docs.filter((_, i) => fixture.memories[i].metadata?.questionId === input.query.queryId);
    const retrievedIds = grepRank(query, own.length > 0 ? own : docs, input.topK);
    return { retrievedIds, confidence: retrievedIds.length > 0 ? 'high' : 'none' };
  };
}

async function main(argv: string[]): Promise<void> {
  let fixturePath: string | undefined;
  let topK: number | undefined;
  let maskHeader = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fixture') fixturePath = argv[++i];
    else if (argv[i] === '--top-k') topK = Number(argv[++i]);
    else if (argv[i] === '--mask-session-header') maskHeader = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!fixturePath) throw new Error('usage: tsx benchmarks/public/grep-baseline.ts --fixture <replay-fixture.json> [--top-k N] [--mask-session-header]');

  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as ReplayEvaluationFixture;
  const k = determineTopK(fixture, topK);
  const report = await evaluateReplayFixture(fixture, {
    evaluator: maskHeader ? 'grep-baseline-masked-header-v1' : 'grep-baseline-v1',
    topK: k,
    retrievalRunner: createGrepRunner(fixture, { maskSessionHeader: maskHeader })
  });
  const provenance = buildProvenance({
    generatedAt: report.generatedAt,
    fixtures: [fixturePath],
    retrieval: { topK: k, candidatePool: fixture.memories.length },
    flags: { topK, maskSessionHeader: maskHeader }
  });
  warnProvenance(provenance);
  const longMemEvalAnalysis = analyzeLongMemEvalRetrievalReport(report, { k });
  const output = { ...report, perQuery: [], longMemEvalAnalysis, haystackLengths: haystackLengths(fixture), provenance };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
