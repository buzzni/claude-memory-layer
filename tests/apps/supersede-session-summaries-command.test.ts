import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  formatSupersedeSessionSummariesFailure,
  formatSupersedeSessionSummariesResult,
  resolveSupersedeSessionSummariesOptions,
  runSupersedeSessionSummaries
} from '../../src/apps/cli/supersede-session-summaries-command.js';
import { getProjectStoragePath } from '../../src/core/registry/project-path.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

describe('repair supersede-session-summaries options', () => {
  it('previews by default and writes only with --apply', () => {
    expect(resolveSupersedeSessionSummariesOptions({}, '/repo/app')).toEqual({ projectPath: '/repo/app', dryRun: true });
    expect(resolveSupersedeSessionSummariesOptions({ project: '/repo/b', apply: true })).toEqual({ projectPath: '/repo/b', dryRun: false });
    expect(() => resolveSupersedeSessionSummariesOptions({ project: '' })).toThrow('--project must not be empty');
  });
});

describe('repair supersede-session-summaries report', () => {
  const samples = [{ sessionId: 's1', keptEventId: 'e3', supersededEventIds: ['e2', 'e1'] }];
  const kinds = { keptByKind: { unlabeled: 2, llm: 1 }, supersededByKind: { 'rule-based': 3, unlabeled: 1 } };

  it('previews what it would hide', () => {
    expect(formatSupersedeSessionSummariesResult({ dryRun: true, sessions: 3, superseded: 4, ...kinds, samples })).toBe([
      'Supersede duplicate session summaries',
      'Mode: dry-run',
      'Sessions with 2+ visible summaries: 3',
      'Would hide: 4 summaries (each session keeps its newest LLM summary, else its newest)',
      'Kept by kind: llm 1, unlabeled 2',
      'Hidden by kind: rule-based 3, unlabeled 1',
      '  s1: keep e3, hide e2, e1',
      '  ... and 2 more sessions',
      'Dry-run only. Re-run with --apply to hide them. Rows are quarantined as superseded, not deleted.'
    ].join('\n'));
  });

  it('reports what it hid', () => {
    expect(formatSupersedeSessionSummariesResult({ dryRun: false, sessions: 1, superseded: 2, ...kinds, samples })).toBe([
      'Supersede duplicate session summaries',
      'Mode: apply',
      'Sessions with 2+ visible summaries: 1',
      'Hidden: 2 summaries (each session keeps its newest LLM summary, else its newest)',
      'Kept by kind: llm 1, unlabeled 2',
      'Hidden by kind: rule-based 3, unlabeled 1',
      '  s1: keep e3, hide e2, e1',
      'Rows are quarantined as superseded, not deleted; each has a governance audit row.'
    ].join('\n'));
  });

  it('says so when there is nothing to hide', () => {
    expect(formatSupersedeSessionSummariesResult({ dryRun: true, sessions: 0, superseded: 0, keptByKind: {}, supersededByKind: {}, samples: [] })).toBe([
      'Supersede duplicate session summaries',
      'Mode: dry-run',
      'No session holds more than one visible summary.'
    ].join('\n'));
  });
});

describe('repair supersede-session-summaries failure', () => {
  it('says nothing changed and to run it again', () => {
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    expect(formatSupersedeSessionSummariesFailure(busy)).toBe([
      'Supersede session summaries failed: database is locked',
      'Nothing was changed: the summaries are hidden in one transaction, rolled back on failure. Run the command again; '
        + 'if the store was busy, run it when no session is being written.'
    ].join('\n'));
  });

  it('says why a preview of a store reached through a symlink is refused and what to do instead', () => {
    const unsafe = Object.assign(new Error('Source database path must not traverse symlinks'), { code: 'SQLITE_SNAPSHOT_UNSAFE_SOURCE' });
    expect(formatSupersedeSessionSummariesFailure(unsafe)).toBe([
      'Supersede session summaries failed: Source database path must not traverse symlinks',
      'Nothing was changed. The preview reads a temporary copy of the store and does not copy a store reached through '
        + 'a symlink under ~/.claude-code/memory. Running it again gives the same result. --apply still works on this '
        + 'store but hides the summaries without a preview, so back up the project directory under '
        + '~/.claude-code/memory/projects first.'
    ].join('\n'));
  });
});

describe('repair supersede-session-summaries run', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function storeWithDuplicates(): Promise<string> {
    // realpath: the snapshot refuses a source path that goes through a symlink (/var on macOS).
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cml-supersede-run-')));
    roots.push(root);
    const storagePath = join(root, 'projects', 'abc123');
    mkdirSync(storagePath, { recursive: true });
    const store = new SQLiteEventStore(join(storagePath, 'events.sqlite'));
    await store.initialize();
    await store.append({ eventType: 'session_summary', sessionId: 's', timestamp: new Date('2026-08-01T00:00:00.000Z'), content: '- old' });
    await store.append({ eventType: 'session_summary', sessionId: 's', timestamp: new Date('2026-08-01T00:01:00.000Z'), content: '- new' });
    await store.close();
    return storagePath;
  }

  const fileState = (file: string) => existsSync(file)
    ? { size: statSync(file).size, mtimeMs: statSync(file).mtimeMs, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }
    : null;
  const storeFiles = (storagePath: string) => Object.fromEntries(
    ['events.sqlite', 'events.sqlite-wal', 'events.sqlite-shm'].map((name) => [name, fileState(join(storagePath, name))])
  );

  // A read-only SQLite connection still creates -wal/-shm next to a WAL database.
  it('previews from a copy, leaving the store file untouched and creating no sidecars', async () => {
    const storagePath = await storeWithDuplicates();
    const before = storeFiles(storagePath);
    expect(before['events.sqlite-wal']).toBeNull();
    expect(before['events.sqlite-shm']).toBeNull();

    const preview = await runSupersedeSessionSummaries(storagePath, true);

    expect(preview).toMatchObject({ dryRun: true, sessions: 1, superseded: 1 });
    expect(storeFiles(storagePath)).toEqual(before);
  });

  it('hides the summaries in the store itself with --apply', async () => {
    const storagePath = await storeWithDuplicates();

    expect(await runSupersedeSessionSummaries(storagePath, false)).toMatchObject({ dryRun: false, superseded: 1 });
    expect(await runSupersedeSessionSummaries(storagePath, true)).toMatchObject({ sessions: 0, superseded: 0 });
  });

  it('reports nothing to hide when the project has no store', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cml-supersede-run-')));
    roots.push(root);

    expect(await runSupersedeSessionSummaries(join(root, 'projects', 'none'), true)).toEqual({
      dryRun: true, sessions: 0, superseded: 0, keptByKind: {}, supersededByKind: {}, samples: []
    });
    expect(existsSync(join(root, 'projects'))).toBe(false);
  });
  // The preview's snapshot refuses a store reached through a symlink (the read-only
  // diagnostics' policy); --apply opens the store itself and follows the link.
  it('refuses to preview a store whose directory is a symlink, while --apply changes the store it points to', async () => {
    const realStorage = await storeWithDuplicates();
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cml-supersede-link-')));
    roots.push(root);
    const linked = join(root, 'projects', 'abc123');
    mkdirSync(join(root, 'projects'));
    const target = join(root, 'elsewhere');
    renameSync(realStorage, target);
    symlinkSync(target, linked);
    const before = storeFiles(target);

    await expect(runSupersedeSessionSummaries(linked, true)).rejects.toMatchObject({ code: 'SQLITE_SNAPSHOT_UNSAFE_SOURCE' });
    expect(storeFiles(target)).toEqual(before);

    expect(await runSupersedeSessionSummaries(linked, false)).toMatchObject({ dryRun: false, superseded: 1 });
    const store = new SQLiteEventStore(join(target, 'events.sqlite'));
    expect((await store.getSessionEvents('s')).map((event) => event.content)).toEqual(['- new']);
    await store.close();
  });

  it('uses the same store for a project path that is a symlink as for its target', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cml-supersede-project-')));
    roots.push(root);
    mkdirSync(join(root, 'project'));
    symlinkSync(join(root, 'project'), join(root, 'project-link'));

    expect(getProjectStoragePath(join(root, 'project-link'))).toBe(getProjectStoragePath(join(root, 'project')));
  });
});
