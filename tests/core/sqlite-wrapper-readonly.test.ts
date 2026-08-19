import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSQLiteDatabase, sqliteAll, sqliteClose, sqliteRun } from '../../src/core/sqlite-wrapper.js';

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
});
