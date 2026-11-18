import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { formatPreviewableCommandFailure, openPreviewableStore } from '../../src/apps/cli/preview-store.js';
import { planSqliteRedaction } from '../../src/core/operations/index.js';
import { pruneToolObservationVectors } from '../../src/core/operations/tool-observation-vector-backfill.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

describe('previewable command failure', () => {
  it('prints the error alone when the store could be read', () => {
    expect(formatPreviewableCommandFailure('Repair failed', new Error('boom'))).toBe('Repair failed: boom');
  });

  it('says why a preview of a store reached through a symlink is refused and what to do instead', () => {
    const unsafe = Object.assign(new Error('Source database path must not traverse symlinks'), { code: 'SQLITE_SNAPSHOT_UNSAFE_SOURCE' });
    expect(formatPreviewableCommandFailure('Backfill vectors failed', unsafe)).toBe([
      'Backfill vectors failed: Source database path must not traverse symlinks',
      'Nothing was changed. The preview reads a temporary copy of the store and does not copy a store reached through '
        + 'a symlink under ~/.claude-code/memory. Running it again gives the same result. --apply still works on this '
        + 'store but changes it without a preview, so back up the project directory under '
        + '~/.claude-code/memory/projects first.'
    ].join('\n'));
  });
});

describe('previewable store', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function projectStore(): Promise<string> {
    // realpath: the snapshot refuses a source path that goes through a symlink (/var on macOS).
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cml-preview-store-')));
    roots.push(root);
    const storagePath = join(root, 'projects', 'abc12345');
    mkdirSync(storagePath, { recursive: true });
    const store = new SQLiteEventStore(join(storagePath, 'events.sqlite'));
    await store.initialize();
    await store.append({ eventType: 'user_prompt', sessionId: 's', timestamp: new Date('2026-08-01T00:00:00.000Z'), content: 'fix the build' });
    await store.append({ eventType: 'tool_observation', sessionId: 's', timestamp: new Date('2026-08-01T00:01:00.000Z'), content: 'npm test' });
    await store.close();
    return storagePath;
  }

  const fileState = (file: string) => existsSync(file)
    ? { size: statSync(file).size, mtimeMs: statSync(file).mtimeMs, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }
    : null;
  const storeFiles = (storagePath: string) => Object.fromEntries(
    ['events.sqlite', 'events.sqlite-wal', 'events.sqlite-shm'].map((name) => [name, fileState(join(storagePath, name))])
  );

  it('a read-only connection to the store itself creates -wal/-shm next to it', async () => {
    const storagePath = await projectStore();
    const store = new SQLiteEventStore(join(storagePath, 'events.sqlite'), { readonly: true });
    await store.listPendingEmbeddingEventIds();
    await store.close();

    expect(existsSync(join(storagePath, 'events.sqlite-shm'))).toBe(true);
  });

  // Each read the dry runs of the repair commands and `retrieval reevaluate` make.
  const previews: Array<[string, (store: SQLiteEventStore) => Promise<unknown>]> = [
    ['repair legacy-project-scope', (store) => store.repairLegacyProjectScope({ projectHash: 'abc12345', dryRun: true })],
    ['repair prune-tool-observation-vectors', (store) => pruneToolObservationVectors(store, {
      deleteEventEverywhere: () => { throw new Error('a preview deletes no vector'); }
    }, { dryRun: true })],
    ['repair backfill-vectors, repair drop-spare-vectors', async (store) => [
      await store.getRecentEvents(Number.MAX_SAFE_INTEGER),
      await store.listPendingEmbeddingEventIds()
    ]],
    ['repair backfill-trace-items', (store) => store.backfillRetrievalTraceItems({ dryRun: true, limit: 1000 })],
    ['repair redact-credentials', async (store) => {
      await store.initialize();
      return planSqliteRedaction(store.getDatabase());
    }],
    ['retrieval reevaluate', (store) => store.countPendingBoundedUsefulness()]
  ];

  it.each(previews)('%s previews from a copy, leaving the store file untouched and creating no sidecars', async (_name, preview) => {
    const storagePath = await projectStore();
    const before = storeFiles(storagePath);
    expect(before['events.sqlite-wal']).toBeNull();
    expect(before['events.sqlite-shm']).toBeNull();

    const store = openPreviewableStore(storagePath, true);
    try {
      await preview(store);
    } finally {
      await store.close();
    }

    expect(storeFiles(storagePath)).toEqual(before);
  });

  it('previews what the store holds, including rows still in its WAL', async () => {
    const storagePath = await projectStore();
    const writer = new SQLiteEventStore(join(storagePath, 'events.sqlite'));
    await writer.initialize();
    await writer.append({ eventType: 'user_prompt', sessionId: 's', timestamp: new Date('2026-08-01T00:02:00.000Z'), content: 'uncheckpointed' });

    const store = openPreviewableStore(storagePath, true);
    try {
      expect(await store.listEventIdsByType('user_prompt')).toHaveLength(2);
      expect(await store.listEventIdsByType('tool_observation')).toHaveLength(1);
    } finally {
      await store.close();
      await writer.close();
    }
  });

  it('opens the store itself with --apply', async () => {
    const storagePath = await projectStore();

    const store = openPreviewableStore(storagePath, false);
    try {
      await store.initialize();
      await store.append({ eventType: 'user_prompt', sessionId: 's', timestamp: new Date('2026-08-01T00:03:00.000Z'), content: 'applied' });
    } finally {
      await store.close();
    }

    const reader = new SQLiteEventStore(join(storagePath, 'events.sqlite'));
    expect(await reader.listEventIdsByType('user_prompt')).toHaveLength(2);
    await reader.close();
  });

  // The preview's snapshot refuses a store reached through a symlink (the read-only
  // diagnostics' policy); --apply opens the store itself and follows the link.
  it('refuses to preview a store whose directory is a symlink and changes nothing', async () => {
    const realStorage = await projectStore();
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cml-preview-link-')));
    roots.push(root);
    mkdirSync(join(root, 'projects'));
    const target = join(root, 'elsewhere');
    renameSync(realStorage, target);
    const linked = join(root, 'projects', 'abc12345');
    symlinkSync(target, linked);
    const before = storeFiles(target);

    expect(() => openPreviewableStore(linked, true)).toThrow(expect.objectContaining({ code: 'SQLITE_SNAPSHOT_UNSAFE_SOURCE' }));
    expect(storeFiles(target)).toEqual(before);
  });
});
