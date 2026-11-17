import type { VectorCoverageBackfillResult } from '../../core/operations/vector-coverage-backfill.js';

export interface BackfillVectorsCommandOptions {
  project?: string;
  apply?: boolean;
}

export interface ResolvedBackfillVectorsOptions {
  projectPath: string;
  dryRun: boolean;
}

export function resolveBackfillVectorsOptions(
  options: BackfillVectorsCommandOptions,
  cwd: string = process.cwd()
): ResolvedBackfillVectorsOptions {
  if (options.project !== undefined && options.project.trim().length === 0) {
    throw new Error('repair backfill-vectors --project must not be empty');
  }
  return {
    projectPath: options.project ?? cwd,
    dryRun: options.apply !== true
  };
}

export function formatBackfillVectorsResult(result: VectorCoverageBackfillResult): string {
  const share = (count: number) =>
    `${count} (${(result.embeddable === 0 ? 100 : (100 * count) / result.embeddable).toFixed(1)}%)`;
  const lines = [
    'Backfill searchable vectors',
    `Mode: ${result.dryRun ? 'dry-run' : 'apply'}`,
    `Events worth searching: ${result.embeddable}`
  ];

  if (result.dryRun) {
    lines.push(
      `Searchable now: ${share(result.searchable)}`,
      `Would copy from an unread vector table: ${result.adopted}`,
      `Would queue for embedding: ${result.queued}`,
      `Already queued for embedding: ${result.alreadyQueued}`,
      'Dry-run only. Re-run with --apply to write these vectors.'
    );
    return lines.join('\n');
  }

  lines.push(
    `Searchable before: ${share(result.searchable)}`,
    `Copied from an unread vector table: ${result.adopted}`,
    `Queued for embedding: ${result.queued}`,
    `Already queued for embedding: ${result.alreadyQueued}`,
    `Searchable now: ${share(result.searchable + result.adopted)}`
  );
  if (result.queued + result.alreadyQueued > 0) {
    lines.push('Queued events become searchable once embedded: claude-memory-layer process');
  }
  return lines.join('\n');
}
