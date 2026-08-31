import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSQLiteDatabase, sqliteAll, sqliteClose, sqliteRun } from '../../src/core/sqlite-wrapper.js';
import { createSQLiteReadSnapshot } from '../../src/core/sqlite-read-snapshot.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

describe('createSQLiteDatabase readonly semantics', () => {
  let dir: string;
  let dbPath: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cml-ro-open-'));
    dbPath = path.join(dir, 'events.sqlite');
    const db = createSQLiteDatabase(dbPath, { walMode: true });
    sqliteRun(db, 'CREATE TABLE rows (id INTEGER PRIMARY KEY, v TEXT)', []);
    sqliteRun(db, "INSERT INTO rows (v) VALUES ('first')", []);
    sqliteClose(db);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('default readonly opens the live database, not a frozen copy', () => {
    // The semantic daemon caches a readonly store for its whole lifetime and
    // must keep seeing rows written after it opened. A copy-on-open here made
    // the daemon serve permanently stale memories (v2.2.16 regression).
    const reader = createSQLiteDatabase(dbPath, { readonly: true });
    try {
      expect(sqliteAll(reader, 'SELECT v FROM rows', [])).toHaveLength(1);

      const writer = createSQLiteDatabase(dbPath, { walMode: true });
      sqliteRun(writer, "INSERT INTO rows (v) VALUES ('second')", []);
      sqliteClose(writer);

      expect(sqliteAll(reader, 'SELECT v FROM rows', [])).toHaveLength(2);
    } finally {
      sqliteClose(reader);
    }
  });

  it('snapshot readonly opens an isolated copy that later writes cannot reach', () => {
    // Diagnostics keep the copy semantics: their guarantee is that reading
    // never touches the canonical memory root, and a point-in-time view is
    // acceptable for a one-shot inspection.
    const reader = createSQLiteDatabase(dbPath, { readonly: true, snapshot: true });
    try {
      const before = sqliteAll(reader, 'SELECT v FROM rows', []).length;

      const writer = createSQLiteDatabase(dbPath, { walMode: true });
      sqliteRun(writer, "INSERT INTO rows (v) VALUES ('after-snapshot')", []);
      sqliteClose(writer);

      expect(sqliteAll(reader, 'SELECT v FROM rows', [])).toHaveLength(before);
    } finally {
      sqliteClose(reader);
    }
  });

  it('allows snapshot cleanup to be called repeatedly', () => {
    const snapshot = createSQLiteReadSnapshot(dbPath);
    expect(() => {
      snapshot.cleanup();
      snapshot.cleanup();
    }).not.toThrow();
  });

  it('allows a symlink alias to a safe external snapshot directory', () => {
    const canonicalRoot = path.join(dir, 'canonical-safe-alias');
    mkdirSync(canonicalRoot);
    const canonicalDbPath = path.join(canonicalRoot, 'events.sqlite');
    const canonicalDb = createSQLiteDatabase(canonicalDbPath);
    sqliteRun(canonicalDb, 'CREATE TABLE rows (id INTEGER PRIMARY KEY)', []);
    sqliteClose(canonicalDb);
    const snapshotParent = path.join(dir, 'external-snapshot-parent');
    const snapshotAlias = path.join(dir, 'external-snapshot-alias');
    mkdirSync(snapshotParent);
    symlinkSync(snapshotParent, snapshotAlias);

    const reader = createSQLiteDatabase(canonicalDbPath, {
      readonly: true,
      snapshot: true,
      snapshotDirectory: snapshotAlias,
      canonicalMemoryRoot: canonicalRoot
    });
    try {
      expect(sqliteAll(reader, 'SELECT * FROM rows', [])).toEqual([]);
    } finally {
      sqliteClose(reader);
    }
  });

  it('rejects snapshot directories inside canonical storage and symlinked sources', () => {
    const canonicalRoot = path.join(dir, 'canonical-memory');
    const unsafeSnapshotParent = path.join(canonicalRoot, 'tmp');
    mkdirSync(unsafeSnapshotParent, { recursive: true });
    const canonicalDbPath = path.join(canonicalRoot, 'events.sqlite');
    const canonicalDb = createSQLiteDatabase(canonicalDbPath);
    sqliteRun(canonicalDb, 'CREATE TABLE rows (id INTEGER PRIMARY KEY)', []);
    sqliteClose(canonicalDb);
    expect(() => createSQLiteDatabase(canonicalDbPath, {
      readonly: true,
      snapshot: true,
      snapshotDirectory: unsafeSnapshotParent,
      canonicalMemoryRoot: canonicalRoot
    })).toThrowError(expect.objectContaining({ code: 'SQLITE_SNAPSHOT_UNSAFE_LOCATION' }));

    const aliasRoot = path.join(dir, 'snapshot-alias');
    symlinkSync(unsafeSnapshotParent, aliasRoot);
    const aliasChild = path.join(aliasRoot, 'nested');
    mkdirSync(path.join(unsafeSnapshotParent, 'nested'));
    expect(() => createSQLiteDatabase(canonicalDbPath, {
      readonly: true,
      snapshot: true,
      snapshotDirectory: aliasChild,
      canonicalMemoryRoot: canonicalRoot
    })).toThrowError(expect.objectContaining({ code: 'SQLITE_SNAPSHOT_UNSAFE_LOCATION' }));

    const linkedPath = path.join(dir, 'linked-events.sqlite');
    symlinkSync(dbPath, linkedPath);
    expect(() => createSQLiteDatabase(linkedPath, { readonly: true, snapshot: true }))
      .toThrowError(expect.objectContaining({ code: 'SQLITE_SNAPSHOT_UNSAFE_SOURCE' }));
  });

  it('rejects a source reached through a symlinked project-store directory', () => {
    const canonicalRoot = path.join(dir, 'canonical-source-root');
    const realStore = path.join(canonicalRoot, 'real-store');
    const projectsRoot = path.join(canonicalRoot, 'projects');
    mkdirSync(realStore, { recursive: true });
    mkdirSync(projectsRoot, { recursive: true });
    const realDbPath = path.join(realStore, 'events.sqlite');
    const db = createSQLiteDatabase(realDbPath);
    sqliteRun(db, 'CREATE TABLE owned (id INTEGER PRIMARY KEY)', []);
    sqliteClose(db);
    const linkedStore = path.join(projectsRoot, 'deadbeef');
    symlinkSync(realStore, linkedStore);

    expect(() => createSQLiteDatabase(path.join(linkedStore, 'events.sqlite'), {
      readonly: true,
      snapshot: true,
      canonicalMemoryRoot: canonicalRoot
    })).toThrowError(expect.objectContaining({ code: 'SQLITE_SNAPSHOT_UNSAFE_SOURCE' }));
  });

  it('forwards snapshot safety options through SQLiteEventStore', () => {
    const canonicalRoot = path.join(dir, 'event-store-canonical');
    const unsafeSnapshotParent = path.join(canonicalRoot, 'tmp');
    mkdirSync(unsafeSnapshotParent, { recursive: true });
    const canonicalDbPath = path.join(canonicalRoot, 'events.sqlite');
    const db = createSQLiteDatabase(canonicalDbPath);
    sqliteRun(db, 'CREATE TABLE events (id TEXT PRIMARY KEY)', []);
    sqliteClose(db);

    expect(() => new SQLiteEventStore(canonicalDbPath, {
      readonly: true,
      snapshot: true,
      snapshotDirectory: unsafeSnapshotParent,
      canonicalMemoryRoot: canonicalRoot
    })).toThrowError(expect.objectContaining({ code: 'SQLITE_SNAPSHOT_UNSAFE_LOCATION' }));
  });
});
