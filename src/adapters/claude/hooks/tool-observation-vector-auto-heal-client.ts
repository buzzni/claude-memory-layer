/**
 * SessionStart-side trigger for the one-time tool_observation vector cleanup.
 *
 * The check is a single indexed SQLite read against a readonly connection, so
 * it's cheap enough for every session once healed. The actual cleanup (prune
 * + Lance compaction) can take a long time on a large backlog, so it must
 * never run inside this hook process: it's spawned detached, mirroring
 * ensureDaemonRunning's pattern, so a slow migration can't block the hook's
 * response or get cut short by the hook's own watchdog/close().
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getProjectStoragePath } from '../../../core/registry/project-path.js';
import { SQLiteEventStore } from '../../../core/sqlite-event-store.js';
import { needsToolObservationVectorAutoHeal } from '../../../core/operations/tool-observation-vector-auto-heal.js';

function getCliScriptPath(): string {
  return path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'cli', 'index.js');
}

/** Best-effort: any failure here must never affect SessionStart's own output. */
export async function spawnToolObservationVectorAutoHealIfNeeded(projectPath: string): Promise<void> {
  const storagePath = getProjectStoragePath(projectPath);
  const dbPath = path.join(storagePath, 'events.sqlite');
  if (!fs.existsSync(dbPath)) return;

  let store: SQLiteEventStore | undefined;
  try {
    store = new SQLiteEventStore(dbPath, { readonly: true });
    if (!(await needsToolObservationVectorAutoHeal(store))) return;
  } catch {
    return;
  } finally {
    await store?.close().catch(() => undefined);
  }

  const cliScriptPath = getCliScriptPath();
  if (!fs.existsSync(cliScriptPath)) return;

  try {
    const child = spawn(
      process.execPath,
      [cliScriptPath, 'repair', 'auto-heal-tool-observation-vectors', '--project', projectPath],
      { detached: true, stdio: 'ignore', env: process.env }
    );
    child.unref();
  } catch {
    // Next session's cheap check will retry.
  }
}
