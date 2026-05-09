#!/usr/bin/env tsx
import { readFile, writeFile } from 'node:fs/promises';
import {
  buildReplayPromotionPlan,
  formatReplayPromotionMarkdown,
  type RetrievalReviewQueueExport
} from '../src/core/replay-promotion.js';

interface ParsedArgs {
  reviewQueuePath: string;
  outPath: string;
  format: 'json' | 'markdown';
  maxItems?: number;
  generatedAt?: string;
}

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

void main(process.argv.slice(2)).catch((error) => {
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
  const args = parseArgs(argv);
  const reviewQueue = JSON.parse(await readFile(args.reviewQueuePath, 'utf8')) as RetrievalReviewQueueExport;
  const plan = buildReplayPromotionPlan(reviewQueue, {
    ...(args.generatedAt ? { generatedAt: args.generatedAt } : {}),
    ...(args.maxItems !== undefined ? { maxItems: args.maxItems } : {})
  });
  const output = args.format === 'markdown'
    ? formatReplayPromotionMarkdown(plan)
    : `${JSON.stringify(plan, null, 2)}\n`;

  if (args.outPath) {
    await writeFile(args.outPath, output, 'utf8');
  } else {
    process.stdout.write(output);
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    reviewQueuePath: '',
    outPath: '',
    format: 'json'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--review-queue' || arg === '--input' || arg === '--in') {
      parsed.reviewQueuePath = readOptionValue(argv, ++i, arg);
    } else if (arg === '--out' || arg === '--output') {
      parsed.outPath = readOptionValue(argv, ++i, arg);
    } else if (arg === '--format') {
      const value = readOptionValue(argv, ++i, arg);
      if (value !== 'json' && value !== 'markdown') {
        throw new CliError(`Invalid --format: expected json or markdown, got ${value}`);
      }
      parsed.format = value;
    } else if (arg === '--max-items') {
      parsed.maxItems = parsePositiveInteger(readOptionValue(argv, ++i, arg), arg);
    } else if (arg === '--generated-at') {
      parsed.generatedAt = parseIsoTimestamp(readOptionValue(argv, ++i, arg), arg);
    } else if (arg.startsWith('--')) {
      throw new CliError(`Unknown option: ${arg}`);
    } else if (!parsed.reviewQueuePath) {
      parsed.reviewQueuePath = arg;
    } else {
      throw new CliError(`Unexpected positional argument: ${arg}`);
    }
  }

  if (!parsed.reviewQueuePath) {
    throw new CliError('Missing required --review-queue <path>');
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

function parsePositiveInteger(value: string, optionName: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new CliError(`Invalid ${optionName}: expected a positive integer, got ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CliError(`Invalid ${optionName}: expected a safe positive integer, got ${value}`);
  }
  return parsed;
}

function parseIsoTimestamp(value: string, optionName: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new CliError(`Invalid ${optionName}: expected a canonical UTC ISO timestamp, got ${value}`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new CliError(`Invalid ${optionName}: expected a canonical UTC ISO timestamp, got ${value}`);
  }
  return value;
}
