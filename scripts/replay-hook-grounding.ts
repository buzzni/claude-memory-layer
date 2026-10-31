#!/usr/bin/env tsx
/**
 * Hook-path grounding replay (#119).
 *
 *   npm run eval:hook-replay
 *   tsx scripts/replay-hook-grounding.ts --store /tmp/copy/projects/<hash> [--limit 120] [--semantic off]
 *
 * --store must point at a COPY of a project store (`sqlite3 events.sqlite ".backup ..."`,
 * plus `vectors/` for the semantic lane). The copy is opened read-only. Output is
 * aggregate-only: no prompt, memory, or response text and no ids.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  buildFixtureStore,
  formatReplayReport,
  runHookGroundingReplay,
  type HookReplayFixture,
  type ReplayReport
} from '../src/adapters/claude/hooks/hook-grounding-replay.js';

interface ParsedArgs {
  fixturePath?: string;
  storePath?: string;
  projectHash?: string;
  limit?: number;
  semantic?: 'retriever' | 'off';
  format: 'markdown' | 'json';
}

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { format: 'markdown' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new CliError(`${arg} needs a value`);
      return next;
    };
    if (arg === '--fixture') args.fixturePath = value();
    else if (arg === '--store') args.storePath = value();
    else if (arg === '--project-hash') args.projectHash = value();
    else if (arg === '--limit') {
      args.limit = Number(value());
      if (!Number.isInteger(args.limit) || args.limit < 1) throw new CliError('--limit must be a positive integer');
    } else if (arg === '--semantic') {
      const mode = value();
      if (mode !== 'retriever' && mode !== 'off') throw new CliError('--semantic must be retriever or off');
      args.semantic = mode;
    } else if (arg === '--format') {
      const format = value();
      if (format !== 'markdown' && format !== 'json') throw new CliError('--format must be markdown or json');
      args.format = format;
    } else {
      throw new CliError(`unknown argument: ${arg}`);
    }
  }
  if (Boolean(args.fixturePath) === Boolean(args.storePath)) {
    throw new CliError('pass exactly one of --fixture or --store');
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let report: ReplayReport;
  if (args.fixturePath) {
    const fixture = JSON.parse(readFileSync(args.fixturePath, 'utf8')) as HookReplayFixture;
    const storagePath = mkdtempSync(path.join(tmpdir(), 'cml-hook-replay-'));
    try {
      await buildFixtureStore(fixture, storagePath);
      report = await runHookGroundingReplay({
        storagePath,
        projectHash: fixture.projectHash,
        semantic: args.semantic ?? 'off',
        limit: args.limit,
        storeLabel: fixture.name
      });
    } finally {
      rmSync(storagePath, { recursive: true, force: true });
    }
  } else {
    const storagePath = path.resolve(args.storePath!);
    if (!existsSync(path.join(storagePath, 'events.sqlite'))) {
      throw new CliError(`no events.sqlite in ${storagePath}`);
    }
    report = await runHookGroundingReplay({
      storagePath,
      projectHash: args.projectHash ?? path.basename(storagePath),
      semantic: args.semantic ?? (existsSync(path.join(storagePath, 'vectors')) ? 'retriever' : 'off'),
      limit: args.limit
    });
  }
  // Per-turn results carry event ids, so JSON keeps the aggregates only.
  const withoutResults = (key: string, value: unknown) => (key === 'results' ? undefined : value);
  process.stdout.write(args.format === 'json'
    ? `${JSON.stringify(report, withoutResults, 2)}\n`
    : `${formatReplayReport(report)}\n`);
}

// Success lets the event loop drain instead of calling process.exit: exiting
// while the native embedding runtime is loaded aborts with
// "libc++abi: mutex lock failed" (exit 134).
main().catch((error) => {
  process.stderr.write(`${error instanceof CliError ? error.message : error?.stack ?? error}\n`);
  process.exit(error instanceof CliError ? 2 : 1);
});
