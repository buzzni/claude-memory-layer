import * as fs from 'fs';
import * as path from 'path';

import { SQLiteEventStore } from '../../core/sqlite-event-store.js';
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

export async function runSupersedeSessionSummaries(
  storagePath: string,
  dryRun: boolean
): Promise<SessionSummarySupersedeResult> {
  const dbPath = path.join(storagePath, 'events.sqlite');
  if (!fs.existsSync(dbPath)) {
    return { dryRun, sessions: 0, superseded: 0, keptByKind: {}, supersededByKind: {}, samples: [] };
  }
  // A read-only connection still creates -wal/-shm next to a WAL store, so the
  // dry run reads a temporary copy, as the read-only diagnostics do.
  const store = new SQLiteEventStore(dbPath, dryRun
    ? { readonly: true, snapshot: true, canonicalMemoryRoot: path.dirname(path.dirname(storagePath)) }
    : {});
  try {
    return await store.supersedeDuplicateSessionSummaries({ dryRun });
  } finally {
    await store.close().catch(() => undefined);
  }
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
    `${result.dryRun ? 'Would hide' : 'Hidden'}: ${result.superseded} summaries (each session keeps its newest LLM summary, else its newest)`,
    `Kept by kind: ${formatKinds(result.keptByKind)}`,
    `Hidden by kind: ${formatKinds(result.supersededByKind)}`
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

export function formatSupersedeSessionSummariesFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // The snapshot policy of the read-only diagnostics: running again cannot help.
  const hint = (error as { code?: unknown } | null)?.code === 'SQLITE_SNAPSHOT_UNSAFE_SOURCE'
    ? 'Nothing was changed. The preview reads a temporary copy of the store and does not copy a store reached through '
      + 'a symlink under ~/.claude-code/memory. Running it again gives the same result. --apply still works on this '
      + 'store but hides the summaries without a preview, so back up the project directory under '
      + '~/.claude-code/memory/projects first.'
    : 'Nothing was changed: the summaries are hidden in one transaction, rolled back on failure. Run the command again; '
      + 'if the store was busy, run it when no session is being written.';
  return [`Supersede session summaries failed: ${message}`, hint].join('\n');
}

/** `metadata.generated` values in name order, e.g. "llm 1, unlabeled 2". */
function formatKinds(kinds: Record<string, number>): string {
  return Object.keys(kinds).sort().map((kind) => `${kind} ${kinds[kind]}`).join(', ');
}
