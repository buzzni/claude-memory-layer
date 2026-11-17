#!/usr/bin/env tsx
/**
 * Hook-path grounding replay (#119).
 *
 *   npm run eval:hook-replay
 *   tsx scripts/replay-hook-grounding.ts --store /tmp/copy/projects/<hash> [--label A] [--limit 120] [--semantic off]
 *   ... --ranking-arms --model-cache <dir> [--reranker mmarco-minilm|bge-m3] [--download-models]
 *
 * --store must point at a COPY of a project store (`sqlite3 events.sqlite ".backup ..."`,
 * plus `vectors/` for the semantic lane). The copy is opened read-only. Output is
 * aggregate-only: no prompt, memory, or response text and no ids. The report is
 * titled with --label (default "store copy"), never the project hash.
 *
 * --ranking-arms replaces the flag arms with current, hook order (fidelity check),
 * rrf, and rrf + cross-encoder (T12); the reranker is loaded from --model-cache.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  buildFixtureStore,
  DEFAULT_REPLAY_ARMS,
  formatReplayReport,
  loadReplayTurns,
  RANKING_REPLAY_ARMS,
  runHookGroundingReplay,
  type HookGroundingReplayOptions,
  type HookReplayFixture
} from '../src/adapters/claude/hooks/hook-grounding-replay.js';
import { buildProvenance, countRows, pathRef, shortHash, warnProvenance, withProvenanceHeader } from './eval-provenance.mjs';
import { loadCrossEncoder, modelArtifactSha256 } from './cross-encoder-reranker.js';
import { DEFAULT_EMBEDDING_MODEL, resolveModelCacheDir } from '../src/extensions/vector/embedder.js';

interface ParsedArgs {
  fixturePath?: string;
  storePath?: string;
  projectHash?: string;
  label?: string;
  limit?: number;
  semantic?: 'retriever' | 'off';
  format: 'markdown' | 'json';
  rankingArms: boolean;
  reranker: string;
  modelCache?: string;
  downloadModels: boolean;
}

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { format: 'markdown', rankingArms: false, reranker: 'mmarco-minilm', downloadModels: false };
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
    } else if (arg === '--ranking-arms') args.rankingArms = true;
    else if (arg === '--reranker') args.reranker = value();
    else if (arg === '--model-cache') args.modelCache = value();
    else if (arg === '--download-models') args.downloadModels = true;
    else {
      throw new CliError(`unknown argument: ${arg}`);
    }
  }
  if (Boolean(args.fixturePath) === Boolean(args.storePath)) {
    throw new CliError('pass exactly one of --fixture or --store');
  }
  if (args.rankingArms && !args.modelCache) throw new CliError('--ranking-arms needs --model-cache');
  return args;
}

/** Tables the replay reads; their row counts are compared before and after the run. */
const STORE_TABLES = ['events', 'retrieval_traces', 'memory_lessons'];

function readStore<T>(storagePath: string, read: (db: Database.Database) => T): T {
  const db = new Database(path.join(storagePath, 'events.sqlite'), { readonly: true, fileMustExist: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/**
 * Replay with store row counts taken before and after, and the replayed traces' time span.
 * Only a real store copy passes storeRef; a fixture store is a throwaway temp dir.
 */
async function replayWithSnapshots(options: HookGroundingReplayOptions, storeRef?: string) {
  const start = readStore(options.storagePath, (db) => ({ rows: countRows(db, STORE_TABLES), turns: loadReplayTurns(db, options.limit) }));
  const report = await runHookGroundingReplay(options);
  return {
    report,
    store: {
      ...(storeRef ? { ref: storeRef } : {}),
      rowsAtStart: start.rows,
      rowsAtEnd: readStore(options.storagePath, (db) => countRows(db, STORE_TABLES)),
      inputRows: start.turns.length,
      window: { from: start.turns[0]?.asOf.toISOString() ?? null, to: start.turns.at(-1)?.asOf.toISOString() ?? null }
    }
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = { ...process.env };
  const reranker = args.rankingArms
    ? await loadCrossEncoder(args.reranker, path.resolve(args.modelCache!), { allowDownload: args.downloadModels })
    : null;
  const armOptions = reranker
    ? { arms: [DEFAULT_REPLAY_ARMS[0], ...RANKING_REPLAY_ARMS], reranker: reranker.score }
    : {};
  let run: Awaited<ReturnType<typeof replayWithSnapshots>>;
  let semantic: 'retriever' | 'off';
  let projectHash: string;
  if (args.fixturePath) {
    const fixture = JSON.parse(readFileSync(args.fixturePath, 'utf8')) as HookReplayFixture;
    const storagePath = mkdtempSync(path.join(tmpdir(), 'cml-hook-replay-'));
    semantic = args.semantic ?? 'off';
    try {
      await buildFixtureStore(fixture, storagePath);
      projectHash = fixture.projectHash;
      run = await replayWithSnapshots({
        storagePath,
        projectHash,
        semantic,
        limit: args.limit,
        storeLabel: fixture.name,
        ...armOptions
      });
    } finally {
      rmSync(storagePath, { recursive: true, force: true });
    }
  } else {
    const storagePath = path.resolve(args.storePath!);
    if (!existsSync(path.join(storagePath, 'events.sqlite'))) {
      throw new CliError(`no events.sqlite in ${storagePath}`);
    }
    semantic = args.semantic ?? (existsSync(path.join(storagePath, 'vectors')) ? 'retriever' : 'off');
    projectHash = args.projectHash ?? path.basename(storagePath);
    run = await replayWithSnapshots({
      storagePath,
      projectHash,
      semantic,
      limit: args.limit,
      storeLabel: args.label,
      ...armOptions
    }, storagePath);
  }
  const { report } = run;
  const provenance = buildProvenance({
    fixtures: args.fixturePath ? [args.fixturePath] : [],
    store: run.store,
    // Hashed like the report title avoids it: the scope is comparable, the project is not named.
    flags: {
      semantic,
      limit: args.limit,
      projectHash: shortHash(projectHash),
      ...(semantic === 'retriever'
        ? { embedderArtifactSha256: await modelArtifactSha256(resolveModelCacheDir(), DEFAULT_EMBEDDING_MODEL) }
        : {}),
      ...(reranker
        ? {
            rankingArms: true,
            reranker: reranker.preset.model,
            rerankerLoadOptions: reranker.preset.loadOptions,
            rerankerArtifactSha256: await modelArtifactSha256(path.resolve(args.modelCache!), reranker.preset.model),
            modelCache: pathRef(args.modelCache!)
          }
        : {})
    },
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
