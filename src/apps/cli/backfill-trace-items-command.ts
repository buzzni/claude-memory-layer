import type { TraceItemBackfillResult } from '../../core/retrieval-trace-ledger.js';

export interface BackfillTraceItemsCommandOptions {
  project?: string;
  apply?: boolean;
  limit?: string;
  since?: string;
}

export interface ResolvedBackfillTraceItemsOptions {
  projectPath: string;
  dryRun: boolean;
  limit: number;
  since?: Date;
}

/**
 * Options for the typed trace-item backfill (specs R1).
 *
 * The backfill is a separate, explicitly invoked command and defaults to a dry
 * run: reports resolve legacy traces read-only and must never trigger a write
 * to a user's store as a side effect of being read.
 */
export function resolveBackfillTraceItemsOptions(
  options: BackfillTraceItemsCommandOptions,
  cwd: string = process.cwd()
): ResolvedBackfillTraceItemsOptions {
  if (options.project !== undefined && options.project.trim().length === 0) {
    throw new Error('backfill trace-items --project must not be empty');
  }
  const limit = options.limit === undefined ? 1000 : Number(options.limit);
  if ((options.limit !== undefined && !/^\d+$/.test(options.limit.trim())) || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('backfill trace-items --limit must be a positive integer');
  }
  let since: Date | undefined;
  if (options.since !== undefined) {
    since = new Date(options.since);
    if (Number.isNaN(since.getTime())) {
      throw new Error('backfill trace-items --since must be an ISO timestamp');
    }
  }
  return {
    projectPath: options.project ?? cwd,
    dryRun: options.apply !== true,
    limit,
    since
  };
}

export function formatBackfillTraceItemsResult(result: TraceItemBackfillResult): string {
  const lines = [
    'Backfill typed retrieval trace items',
    `Mode: ${result.dryRun ? 'dry-run' : 'apply'}`,
    `Traces scanned: ${result.scannedTraces}`,
    `Traces with items: ${result.tracesWithItems}`,
    `Items: ${result.writtenItems}`,
    `By kind: ${Object.entries(result.byKind).map(([kind, count]) => `${kind}=${count}`).join(' ')}`,
    `Unresolved: ${result.unresolved}`,
    `Ambiguous: ${result.ambiguous}`
  ];
  if (result.dryRun) {
    lines.push('Dry-run only. Re-run with --apply to write these typed items.');
  }
  return lines.join('\n');
}
