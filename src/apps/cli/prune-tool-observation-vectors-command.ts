import type { ToolObservationVectorPruneResult } from '../../core/operations/tool-observation-vector-backfill.js';

export interface PruneToolObservationVectorsCommandOptions {
  project?: string;
  apply?: boolean;
}

export interface ResolvedPruneToolObservationVectorsOptions {
  projectPath: string;
  dryRun: boolean;
}

export function resolvePruneToolObservationVectorsOptions(
  options: PruneToolObservationVectorsCommandOptions,
  cwd: string = process.cwd()
): ResolvedPruneToolObservationVectorsOptions {
  if (options.project !== undefined && options.project.trim().length === 0) {
    throw new Error('prune tool-observation-vectors --project must not be empty');
  }
  return {
    projectPath: options.project ?? cwd,
    dryRun: options.apply !== true
  };
}

export function formatPruneToolObservationVectorsResult(result: ToolObservationVectorPruneResult): string {
  const lines = [
    'Prune tool_observation vectors',
    `Mode: ${result.dryRun ? 'dry-run' : 'apply'}`,
    `Scanned: ${result.scanned}`,
    `Vectors deleted: ${result.vectorsDeleted}`,
    `Outbox rows removed: ${result.outboxRowsRemoved}`
  ];

  if (result.sampleEventIds.length > 0) {
    lines.push('Sample event IDs:');
    for (const eventId of result.sampleEventIds) {
      lines.push(`- ${eventId}`);
    }
  }

  if (result.dryRun) {
    lines.push('Dry-run only. Re-run with --apply to delete these vectors from LanceDB.');
  }

  return lines.join('\n');
}
