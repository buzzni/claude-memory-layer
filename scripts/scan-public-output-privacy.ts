#!/usr/bin/env node
import {
  DEFAULT_PUBLIC_OUTPUT_SCAN_PATHS,
  formatPublicOutputScanMarkdown,
  scanPublicOutputFiles
} from '../src/core/privacy/public-output-scanner.js';

type ParsedArgs = {
  json: boolean;
  help: boolean;
  maxFindings?: number;
  targets: string[];
};

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { json: false, help: false, targets: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--max-findings') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing value for --max-findings');
      parsed.maxFindings = parsePositiveInteger(value, '--max-findings');
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      parsed.targets.push(arg);
    }
  }
  return parsed;
}

function parsePositiveInteger(value: string, optionName: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid ${optionName}: expected positive integer`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${optionName}: expected positive integer`);
  return parsed;
}

function usage(): string {
  return `Usage: tsx scripts/scan-public-output-privacy.ts [--json] [--max-findings N] [path ...]\n\n` +
    `Scans public markdown/report/export files for local user paths and credential-looking strings.\n` +
    `If no path is provided, scans: ${DEFAULT_PUBLIC_OUTPUT_SCAN_PATHS.join(', ')}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const report = scanPublicOutputFiles(args.targets, {
    cwd: process.cwd(),
    maxFindings: args.maxFindings
  });
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatPublicOutputScanMarkdown(report));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
