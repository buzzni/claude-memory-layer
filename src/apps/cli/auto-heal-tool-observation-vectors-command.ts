import type { ToolObservationVectorPruneResult } from '../../core/operations/tool-observation-vector-backfill.js';

export interface AutoHealToolObservationVectorsCommandOptions {
  project?: string;
  lockPath?: string;
}

export interface ResolvedAutoHealToolObservationVectorsOptions {
  projectPath: string;
  lockPath?: string;
}

export function resolveAutoHealToolObservationVectorsOptions(
  options: AutoHealToolObservationVectorsCommandOptions,
  cwd: string = process.cwd()
): ResolvedAutoHealToolObservationVectorsOptions {
  if (options.project !== undefined && options.project.trim().length === 0) {
    throw new Error('auto-heal-tool-observation-vectors --project must not be empty');
  }
  return {
    projectPath: options.project ?? cwd,
    lockPath: options.lockPath
  };
}

export type AutoHealToolObservationVectorsOutcome =
  | { status: 'already-healed' }
  | { status: 'lock-busy' }
  | { status: 'no-store' }
  | { status: 'healed'; result: ToolObservationVectorPruneResult };

export function formatAutoHealToolObservationVectorsResult(
  outcome: AutoHealToolObservationVectorsOutcome
): string {
  switch (outcome.status) {
    case 'already-healed':
      return 'Auto-heal tool_observation vectors: already healed, nothing to do.';
    case 'lock-busy':
      return 'Auto-heal tool_observation vectors: another process is already healing this project, skipping.';
    case 'no-store':
      return 'Auto-heal tool_observation vectors: no store found for this project, nothing to do.';
    case 'healed':
      return [
        'Auto-heal tool_observation vectors: done.',
        `Vectors deleted: ${outcome.result.vectorsDeleted}`,
        `Outbox rows removed: ${outcome.result.outboxRowsRemoved}`
      ].join('\n');
  }
}
