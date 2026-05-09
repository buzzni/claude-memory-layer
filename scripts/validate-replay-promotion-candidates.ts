#!/usr/bin/env tsx
import { readFile, writeFile } from 'node:fs/promises';
import {
  buildReplayPromotionAppendReport,
  formatReplayPromotionAppendMarkdown,
  stripMergedFixtureFromReport
} from '../src/core/replay-promotion-append.js';
import type { ReplayEvaluationFixture } from '../src/core/replay-evaluator.js';
import type { ReplayPromotionPlan } from '../src/core/replay-promotion.js';

interface CliOptions {
  fixture?: string;
  promotion?: string;
  out?: string;
  format: 'json' | 'markdown';
  generatedAt?: string;
}

class CliError extends Error {
  readonly exitCode = 1;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.fixture) throw new CliError('Missing required --fixture');
  if (!options.promotion) throw new CliError('Missing required --promotion');

  const fixture = await readJsonFile<ReplayEvaluationFixture>(options.fixture, 'fixture');
  const promotion = await readJsonFile<ReplayPromotionPlan>(options.promotion, 'promotion');
  const report = buildReplayPromotionAppendReport(promotion, fixture, {
    generatedAt: options.generatedAt
  });

  if (!report.ok) {
    process.stdout.write(formatReport(report, options.format));
    throw new CliError('Promotion candidate validation failed');
  }

  if (options.out && report.mergedFixture) {
    await writeOutput(options.out, `${JSON.stringify(report.mergedFixture, null, 2)}\n`);
  }

  process.stdout.write(formatReport(stripMergedFixtureFromReport(report), options.format));
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { format: 'json' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    switch (arg) {
      case '--fixture':
        if (!value || value.startsWith('--')) throw new CliError('Missing value for --fixture');
        options.fixture = value;
        index += 1;
        break;
      case '--promotion':
        if (!value || value.startsWith('--')) throw new CliError('Missing value for --promotion');
        options.promotion = value;
        index += 1;
        break;
      case '--out':
        if (!value || value.startsWith('--')) throw new CliError('Missing value for --out');
        options.out = value;
        index += 1;
        break;
      case '--format':
        if (!value || value.startsWith('--')) throw new CliError('Missing value for --format');
        if (value !== 'json' && value !== 'markdown') throw new CliError('Invalid --format: expected json or markdown');
        options.format = value;
        index += 1;
        break;
      case '--generated-at':
        if (!value || value.startsWith('--')) throw new CliError('Missing value for --generated-at');
        options.generatedAt = parseIsoTimestamp(value, '--generated-at');
        index += 1;
        break;
      default:
        if (arg.startsWith('--')) throw new CliError('Unknown option');
        throw new CliError('Unexpected positional argument');
    }
  }
  return options;
}

async function readJsonFile<T>(filePath: string, label: string): Promise<T> {
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch {
    throw new CliError(`Unable to read ${label} input`);
  }
  try {
    return JSON.parse(contents) as T;
  } catch {
    throw new CliError(`Invalid ${label} JSON`);
  }
}

async function writeOutput(filePath: string, contents: string): Promise<void> {
  try {
    await writeFile(filePath, contents, 'utf8');
  } catch {
    throw new CliError('Unable to write merged fixture output');
  }
}

function formatReport(report: unknown, format: 'json' | 'markdown'): string {
  if (format === 'markdown') {
    return formatReplayPromotionAppendMarkdown(report as Parameters<typeof formatReplayPromotionAppendMarkdown>[0]);
  }
  return `${JSON.stringify(report, null, 2)}\n`;
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

main().catch((error: unknown) => {
  if (error instanceof CliError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write('Unexpected error while validating promotion candidates\n');
  }
  process.exitCode = 1;
});
