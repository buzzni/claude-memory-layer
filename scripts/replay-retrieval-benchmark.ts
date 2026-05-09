#!/usr/bin/env tsx
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  evaluateReplayFixture,
  formatReplayEvaluationMarkdown,
  type ReplayEvaluationFixture,
  type ReplayEvaluationReport
} from '../src/core/replay-evaluator.js';
import type { RetrievalStrategy } from '../src/core/retriever.js';

interface ReplayThresholds {
  minQueryYieldRate?: number;
  minNoMatchAccuracy?: number;
  maxForbiddenHitCount?: number;
  maxFailedQueryCount?: number;
}

interface ParsedReplayArgs {
  fixturePath: string;
  outPath: string;
  format: 'json' | 'markdown';
  includePerQuery: boolean;
  strategy?: RetrievalStrategy;
  topK?: number;
  minScore?: number;
  thresholds: ReplayThresholds;
}

interface ThresholdViolation {
  metric: string;
  actual: number;
  expected: string;
}

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

const args = process.argv.slice(2);

void main(args).catch((error) => {
  if (error instanceof CliError) {
    process.stderr.write(`${error.message}\n`);
  } else if (error instanceof Error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
  } else {
    process.stderr.write(`${String(error)}\n`);
  }
  process.exitCode = 1;
});

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const fixture = JSON.parse(await readFile(options.fixturePath, 'utf8')) as ReplayEvaluationFixture;
  const report = await evaluateReplayFixture(fixture, {
    includePerQuery: options.includePerQuery,
    topK: options.topK,
    retrievalOptions: {
      ...(options.strategy ? { strategy: options.strategy } : {}),
      ...(options.minScore !== undefined ? { minScore: options.minScore } : {})
    }
  });
  const output = options.format === 'markdown'
    ? formatReplayEvaluationMarkdown(report, { qrelsPath: options.fixturePath })
    : `${JSON.stringify(report, null, 2)}\n`;

  if (options.outPath) {
    await writeFile(options.outPath, output, 'utf8');
  } else {
    process.stdout.write(output);
  }

  const violations = evaluateThresholds(report, options.thresholds);
  if (violations.length > 0) {
    process.stderr.write(formatThresholdViolations(violations));
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): ParsedReplayArgs {
  const parsed: ParsedReplayArgs = {
    fixturePath: path.join('benchmarks', 'replay', 'anonymized-real-sessions.json'),
    outPath: '',
    format: 'json',
    includePerQuery: true,
    thresholds: {}
  };
  let positionalFixtureConsumed = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fixture') {
      parsed.fixturePath = readOptionValue(argv, ++i, arg);
    } else if (arg === '--out' || arg === '--report-out') {
      parsed.outPath = readOptionValue(argv, ++i, arg);
    } else if (arg === '--format') {
      const value = readOptionValue(argv, ++i, arg);
      if (value !== 'markdown' && value !== 'json') {
        throw new CliError(`Invalid --format: expected markdown or json, got ${value}`);
      }
      parsed.format = value;
    } else if (arg === '--no-per-query') {
      parsed.includePerQuery = false;
    } else if (arg === '--strategy') {
      const value = readOptionValue(argv, ++i, arg);
      if (value !== 'auto' && value !== 'fast' && value !== 'deep') {
        throw new CliError(`Invalid --strategy: expected auto, fast, or deep, got ${value}`);
      }
      parsed.strategy = value;
    } else if (arg === '--top-k' || arg === '--topK') {
      parsed.topK = parseNonNegativeInteger(readOptionValue(argv, ++i, arg), arg, { min: 1 });
    } else if (arg === '--min-score') {
      parsed.minScore = parseRate(readOptionValue(argv, ++i, arg), arg);
    } else if (arg === '--min-query-yield') {
      parsed.thresholds.minQueryYieldRate = parseRate(readOptionValue(argv, ++i, arg), arg);
    } else if (arg === '--min-no-match-accuracy') {
      parsed.thresholds.minNoMatchAccuracy = parseRate(readOptionValue(argv, ++i, arg), arg);
    } else if (arg === '--max-forbidden-hits') {
      parsed.thresholds.maxForbiddenHitCount = parseNonNegativeInteger(readOptionValue(argv, ++i, arg), arg);
    } else if (arg === '--max-failed-queries') {
      parsed.thresholds.maxFailedQueryCount = parseNonNegativeInteger(readOptionValue(argv, ++i, arg), arg);
    } else if (arg.startsWith('--')) {
      throw new CliError(`Unknown option: ${arg}`);
    } else if (!positionalFixtureConsumed) {
      parsed.fixturePath = arg;
      positionalFixtureConsumed = true;
    } else {
      throw new CliError(`Unexpected positional argument: ${arg}`);
    }
  }

  return parsed;
}

function readOptionValue(argv: string[], index: number, optionName: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new CliError(`Missing value for ${optionName}`);
  }
  return value;
}

function parseRate(value: string, optionName: string): number {
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)) {
    throw new CliError(`Invalid ${optionName}: expected a number between 0 and 1, got ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new CliError(`Invalid ${optionName}: expected a number between 0 and 1, got ${value}`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, optionName: string, bounds: { min?: number } = {}): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new CliError(`Invalid ${optionName}: expected a non-negative integer, got ${value}`);
  }
  const parsed = Number(value);
  const min = bounds.min ?? 0;
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new CliError(`Invalid ${optionName}: expected an integer >= ${min}, got ${value}`);
  }
  return parsed;
}

function evaluateThresholds(
  report: ReplayEvaluationReport,
  thresholds: ReplayThresholds
): ThresholdViolation[] {
  const summary = report.summary;
  const violations: ThresholdViolation[] = [];

  if (thresholds.minQueryYieldRate !== undefined && summary.queryYieldRate < thresholds.minQueryYieldRate) {
    violations.push({
      metric: 'queryYieldRate',
      actual: summary.queryYieldRate,
      expected: `>= ${formatNumber(thresholds.minQueryYieldRate)}`
    });
  }
  if (thresholds.minNoMatchAccuracy !== undefined && summary.noMatchAccuracy < thresholds.minNoMatchAccuracy) {
    violations.push({
      metric: 'noMatchAccuracy',
      actual: summary.noMatchAccuracy,
      expected: `>= ${formatNumber(thresholds.minNoMatchAccuracy)}`
    });
  }
  if (thresholds.maxForbiddenHitCount !== undefined && summary.forbiddenHitCount > thresholds.maxForbiddenHitCount) {
    violations.push({
      metric: 'forbiddenHitCount',
      actual: summary.forbiddenHitCount,
      expected: `<= ${formatNumber(thresholds.maxForbiddenHitCount)}`
    });
  }
  if (thresholds.maxFailedQueryCount !== undefined && summary.failedQueryCount > thresholds.maxFailedQueryCount) {
    violations.push({
      metric: 'failedQueryCount',
      actual: summary.failedQueryCount,
      expected: `<= ${formatNumber(thresholds.maxFailedQueryCount)}`
    });
  }

  return violations;
}

function formatThresholdViolations(violations: ThresholdViolation[]): string {
  const lines = ['Replay threshold gate failed:'];
  for (const violation of violations) {
    lines.push(`- ${violation.metric}: actual ${formatNumber(violation.actual)} expected ${violation.expected}`);
  }
  return `${lines.join('\n')}\n`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}
