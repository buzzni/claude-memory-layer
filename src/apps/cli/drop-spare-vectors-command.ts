import type { SpareVectorTablesResult } from '../../core/operations/spare-vector-tables.js';

export interface DropSpareVectorsCommandOptions {
  project?: string;
  apply?: boolean;
}

export interface ResolvedDropSpareVectorsOptions {
  projectPath: string;
  dryRun: boolean;
}

export function resolveDropSpareVectorsOptions(
  options: DropSpareVectorsCommandOptions,
  cwd: string = process.cwd()
): ResolvedDropSpareVectorsOptions {
  if (options.project !== undefined && options.project.trim().length === 0) {
    throw new Error('repair drop-spare-vectors --project must not be empty');
  }
  return {
    projectPath: options.project ?? cwd,
    dryRun: options.apply !== true
  };
}

export function formatDropSpareVectorsResult(result: SpareVectorTablesResult): string {
  const describe = (names: Array<{ name: string; rows: number }>) =>
    names.map(({ name, rows }) => `${name} (${rows} rows)`).join(', ');
  const lines = [
    'Drop spare event vector tables',
    `Mode: ${result.dryRun ? 'dry-run' : 'apply'}`,
    `Searchable: ${result.searchable} of ${result.embeddable} events${result.queued > 0 ? ` (${result.queued} waiting for embedding)` : ''}`
  ];

  if (result.refused === 'incomplete-coverage') {
    lines.push(
      'Refused: some events are neither searchable nor waiting for embedding, and a spare table may hold their only vector.',
      'Run claude-memory-layer repair backfill-vectors --apply first.'
    );
    return lines.join('\n');
  }
  if (result.tables.length === 0) {
    lines.push('No spare event vector tables.');
    return lines.join('\n');
  }
  if (result.dryRun) {
    lines.push(
      `Would drop: ${describe(result.tables)}`,
      'Dry-run only. Re-run with --apply to drop these tables. This cannot be undone.'
    );
    return lines.join('\n');
  }
  lines.push(`Dropped: ${describe(result.tables.filter(({ name }) => result.dropped.includes(name)))}`);
  return lines.join('\n');
}
