#!/usr/bin/env tsx
/**
 * Hook-path grounding replay (#119).
 *
 *   npm run eval:hook-replay
 *   tsx scripts/replay-hook-grounding.ts --store /tmp/copy/projects/<hash> [--label A] [--limit 120] [--semantic off]
 *
 * --store must point at a COPY of a project store (`sqlite3 events.sqlite ".backup ..."`,
 * plus `vectors/` for the semantic lane). The copy is opened read-only. Output is
 * aggregate-only: no prompt, memory, or response text and no ids. The report is
 * titled with --label (default "store copy"), never the project hash.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  buildFixtureStore,
  formatReplayReport,
  loadReplayTurns,
  runHookGroundingReplay,
  type HookReplayFixture,
  type ReplayReport
} from '../src/adapters/claude/hooks/hook-grounding-replay.js';
import { buildProvenance, countRows, warnProvenance, withProvenanceHeader } from './eval-provenance.mjs';

interface ParsedArgs {
  fixturePath?: string;
  storePath?: string;
  projectHash?: string;
  label?: string;
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
    else if (arg === '--label') args.label = value();
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

/** Row counts of the tables the replay reads, plus the replayed traces' time span at the start. */
function snapshotStore(storagePath: string, limit?: number) {
  const db = new Database(path.join(storagePath, 'events.sqlite'), { readonly: true, fileMustExist: true });
  try {
    const turns = loadReplayTurns(db, limit);
    return {
      rows: countRows(db, ['events', 'retrieval_traces']) as Record<string, number | null>,
      inputRows: turns.length,
      window: { from: turns[0]?.asOf.toISOString() ?? null, to: turns.at(-1)?.asOf.toISOString() ?? null }
    };
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = { ...process.env };
  let report: ReplayReport;
  let start: ReturnType<typeof snapshotStore>;
  let end: ReturnType<typeof snapshotStore>;
  let storagePath: string;
  let semantic: 'retriever' | 'off';
  if (args.fixturePath) {
    const fixture = JSON.parse(readFileSync(args.fixturePath, 'utf8')) as HookReplayFixture;
    storagePath = mkdtempSync(path.join(tmpdir(), 'cml-hook-replay-'));
    semantic = args.semantic ?? 'off';
    try {
      await buildFixtureStore(fixture, storagePath);
      start = snapshotStore(storagePath, args.limit);
      report = await runHookGroundingReplay({
        storagePath,
        projectHash: fixture.projectHash,
        semantic,
        limit: args.limit,
        storeLabel: fixture.name
      });
      end = snapshotStore(storagePath, args.limit);
    } finally {
      rmSync(storagePath, { recursive: true, force: true });
    }
  } else {
    storagePath = path.resolve(args.storePath!);
    if (!existsSync(path.join(storagePath, 'events.sqlite'))) {
      throw new CliError(`no events.sqlite in ${storagePath}`);
    }
    semantic = args.semantic ?? (existsSync(path.join(storagePath, 'vectors')) ? 'retriever' : 'off');
    start = snapshotStore(storagePath, args.limit);
    report = await runHookGroundingReplay({
      storagePath,
      projectHash: args.projectHash ?? path.basename(storagePath),
      semantic,
      limit: args.limit,
      storeLabel: args.label
    });
    end = snapshotStore(storagePath, args.limit);
  }
  const provenance = buildProvenance({
    fixtures: args.fixturePath ? [args.fixturePath] : [],
    store: {
      // A fixture store is a throwaway temp copy; only a real store copy gets a (hashed) location.
      ...(args.storePath ? { ref: storagePath } : {}),
      rowsAtStart: start.rows,
      rowsAtEnd: end.rows,
      inputRows: start.inputRows,
      window: start.window
    },
    flags: { semantic, limit: args.limit },
    env
  });
  warnProvenance(provenance);
  // Per-turn results carry event ids, so JSON keeps the aggregates only.
  const withoutResults = (key: string, value: unknown) => (key === 'results' ? undefined : value);
  process.stdout.write(args.format === 'json'
    ? `${JSON.stringify({ ...report, provenance }, withoutResults, 2)}\n`
    : `${withProvenanceHeader(formatReplayReport(report), provenance)}\n`);
}

// Success lets the event loop drain instead of calling process.exit: exiting
// while the native embedding runtime is loaded aborts with
// "libc++abi: mutex lock failed" (exit 134).
main().catch((error) => {
  process.stderr.write(`${error instanceof CliError ? error.message : error?.stack ?? error}\n`);
  process.exit(error instanceof CliError ? 2 : 1);
});
