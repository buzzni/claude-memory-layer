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
  } else {
    process.stderr.write('Unexpected error while promoting review queue\n');
  }
  process.exitCode = 1;
});

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const reviewQueue = await readReviewQueueInput(args.reviewQueuePath);
  const plan = buildReplayPromotionPlan(reviewQueue, {
    ...(args.generatedAt ? { generatedAt: args.generatedAt } : {}),
    ...(args.maxItems !== undefined ? { maxItems: args.maxItems } : {})
  });
  const output = args.format === 'markdown'
    ? formatReplayPromotionMarkdown(plan)
    : `${JSON.stringify(plan, null, 2)}\n`;

  if (args.outPath) {
    try {
      await writeFile(args.outPath, output, 'utf8');
    } catch {
      throw new CliError('Unable to write promotion output');
    }
  } else {
    process.stdout.write(output);
  }
}

async function readReviewQueueInput(reviewQueuePath: string): Promise<RetrievalReviewQueueExport> {
  let rawJson: string;
  try {
    rawJson = await readFile(reviewQueuePath, 'utf8');
  } catch {
    throw new CliError('Unable to read review queue input');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new CliError('Invalid review queue JSON: expected a parseable object');
  }

  return validateReviewQueueExport(parsed);
}

function validateReviewQueueExport(value: unknown): RetrievalReviewQueueExport {
  if (!isRecord(value)) {
    throw new CliError('Invalid review queue JSON: expected an object');
  }
  if ('summary' in value && value.summary !== undefined && !isRecord(value.summary)) {
    throw new CliError('Invalid review queue JSON: expected summary to be an object');
  }
  if ('items' in value && value.items !== undefined && !Array.isArray(value.items)) {
    throw new CliError('Invalid review queue JSON: expected items to be an array');
  }
  if (Array.isArray(value.items)) {
    for (const item of value.items) {
      if (!isRecord(item)) {
        throw new CliError('Invalid review queue JSON: expected each item to be an object');
      }
      validateDetailArray(item.candidateDetails, 'candidateDetails');
      validateDetailArray(item.selectedDetails, 'selectedDetails');
    }
  }
  return value as RetrievalReviewQueueExport;
}

function validateDetailArray(value: unknown, fieldName: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new CliError(`Invalid review queue JSON: expected ${fieldName} to be an array`);
  }
  if (value.some((detail) => !isRecord(detail))) {
    throw new CliError(`Invalid review queue JSON: expected each ${fieldName} item to be an object`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
        throw new CliError('Invalid --format: expected json or markdown');
      }
      parsed.format = value;
    } else if (arg === '--max-items') {
      parsed.maxItems = parsePositiveInteger(readOptionValue(argv, ++i, arg), arg);
    } else if (arg === '--generated-at') {
      parsed.generatedAt = parseIsoTimestamp(readOptionValue(argv, ++i, arg), arg);
    } else if (arg.startsWith('--')) {
      throw new CliError('Unknown option');
    } else if (!parsed.reviewQueuePath) {
      parsed.reviewQueuePath = arg;
    } else {
      throw new CliError('Unexpected positional argument');
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
    throw new CliError(`Invalid ${optionName}: expected a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CliError(`Invalid ${optionName}: expected a safe positive integer`);
  }
  return parsed;
}

function parseIsoTimestamp(value: string, optionName: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new CliError(`Invalid ${optionName}: expected a canonical UTC ISO timestamp`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new CliError(`Invalid ${optionName}: expected a canonical UTC ISO timestamp`);
  }
  return value;
}
