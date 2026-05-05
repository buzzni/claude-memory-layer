#!/usr/bin/env tsx
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  evaluateReplayFixture,
  formatReplayEvaluationMarkdown,
  type ReplayEvaluationFixture
} from '../src/core/replay-evaluator.js';
import type { RetrievalStrategy } from '../src/core/retriever.js';

const args = process.argv.slice(2);

void main(args);

async function main(argv: string[]): Promise<void> {
  let fixturePath = path.join('benchmarks', 'replay', 'anonymized-real-sessions.json');
  let outPath = '';
  let format: 'json' | 'markdown' = 'json';
  let includePerQuery = true;
  let strategy: RetrievalStrategy | undefined;
  let topK: number | undefined;
  let minScore: number | undefined;
  let positionalFixtureConsumed = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fixture') {
      fixturePath = argv[++i] ?? fixturePath;
    } else if (arg === '--out' || arg === '--report-out') {
      outPath = argv[++i] ?? '';
    } else if (arg === '--format') {
      const parsed = argv[++i];
      if (parsed === 'markdown' || parsed === 'json') format = parsed;
    } else if (arg === '--no-per-query') {
      includePerQuery = false;
    } else if (arg === '--strategy') {
      const parsed = argv[++i];
      if (parsed === 'auto' || parsed === 'fast' || parsed === 'deep') strategy = parsed;
    } else if (arg === '--top-k' || arg === '--topK') {
      const parsed = Number(argv[++i]);
      topK = Number.isFinite(parsed) ? parsed : undefined;
    } else if (arg === '--min-score') {
      const parsed = Number(argv[++i]);
      minScore = Number.isFinite(parsed) ? parsed : undefined;
    } else if (!arg.startsWith('--') && !positionalFixtureConsumed) {
      fixturePath = arg;
      positionalFixtureConsumed = true;
    }
  }

  const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as ReplayEvaluationFixture;
  const report = await evaluateReplayFixture(fixture, {
    includePerQuery,
    topK,
    retrievalOptions: {
      ...(strategy ? { strategy } : {}),
      ...(minScore !== undefined ? { minScore } : {})
    }
  });
  const output = format === 'markdown'
    ? formatReplayEvaluationMarkdown(report, { qrelsPath: fixturePath })
    : `${JSON.stringify(report, null, 2)}\n`;

  if (outPath) {
    await writeFile(outPath, output, 'utf8');
  } else {
    process.stdout.write(output);
  }
}
