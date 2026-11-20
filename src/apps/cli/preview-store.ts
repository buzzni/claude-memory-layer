import * as path from 'path';

import { SQLiteEventStore } from '../../core/sqlite-event-store.js';

/**
 * Opens the project store of a command that previews by default. A read-only
 * connection still creates -wal/-shm next to a WAL store, so the preview reads
 * a temporary copy, as the read-only diagnostics do; --apply opens the store.
 */
export function openPreviewableStore(storagePath: string, dryRun: boolean): SQLiteEventStore {
  return new SQLiteEventStore(path.join(storagePath, 'events.sqlite'), dryRun
    ? { readonly: true, snapshot: true, canonicalMemoryRoot: path.dirname(path.dirname(storagePath)) }
    : {});
}

export function formatPreviewableCommandFailure(label: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // The snapshot policy of the read-only diagnostics: running again cannot help.
  if ((error as { code?: unknown } | null)?.code !== 'SQLITE_SNAPSHOT_UNSAFE_SOURCE') return `${label}: ${message}`;
  return [
    `${label}: ${message}`,
    'Nothing was changed. The preview reads a temporary copy of the store and does not copy a store reached through '
      + 'a symlink under ~/.claude-code/memory. Running it again gives the same result. --apply still works on this '
      + 'store but changes it without a preview, so back up the project directory under '
      + '~/.claude-code/memory/projects first.'
  ].join('\n');
}
