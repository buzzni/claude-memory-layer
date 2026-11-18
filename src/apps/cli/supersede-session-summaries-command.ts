import type { SessionSummarySupersedeResult } from '../../core/types.js';

export interface SupersedeSessionSummariesCommandOptions {
  project?: string;
  apply?: boolean;
}

export interface ResolvedSupersedeSessionSummariesOptions {
  projectPath: string;
  dryRun: boolean;
}

export function resolveSupersedeSessionSummariesOptions(
  options: SupersedeSessionSummariesCommandOptions,
  cwd: string = process.cwd()
): ResolvedSupersedeSessionSummariesOptions {
  if (options.project !== undefined && options.project.trim().length === 0) {
    throw new Error('repair supersede-session-summaries --project must not be empty');
  }
  return {
    projectPath: options.project ?? cwd,
    dryRun: options.apply !== true
  };
}

export function formatSupersedeSessionSummariesResult(result: SessionSummarySupersedeResult): string {
  const lines = [
    'Supersede duplicate session summaries',
    `Mode: ${result.dryRun ? 'dry-run' : 'apply'}`
  ];

  if (result.sessions === 0) {
    lines.push('No session holds more than one visible summary.');
    return lines.join('\n');
  }
  lines.push(
    `Sessions with 2+ visible summaries: ${result.sessions}`,
    `${result.dryRun ? 'Would hide' : 'Hidden'}: ${result.superseded} summaries (each session keeps its newest LLM summary, else its newest)`
  );
  for (const sample of result.samples) {
    lines.push(`  ${sample.sessionId}: keep ${sample.keptEventId}, hide ${sample.supersededEventIds.join(', ')}`);
  }
  if (result.sessions > result.samples.length) {
    lines.push(`  ... and ${result.sessions - result.samples.length} more sessions`);
  }
  lines.push(result.dryRun
    ? 'Dry-run only. Re-run with --apply to hide them. Rows are quarantined as superseded, not deleted.'
    : 'Rows are quarantined as superseded, not deleted; each has a governance audit row.');
  return lines.join('\n');
}
