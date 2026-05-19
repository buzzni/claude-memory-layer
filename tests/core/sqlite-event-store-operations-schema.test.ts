import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cml-operations-schema-'));
  tempDirs.push(dir);
  return join(dir, 'events.sqlite');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('SQLiteEventStore memory operations schema', () => {
  it('creates memory facet projection table and lookup indexes', async () => {
    const dbPath = tempDbPath();
    const store = new SQLiteEventStore(dbPath);
    await store.initialize();

    const db = new Database(dbPath);
    const columns = db.prepare(`PRAGMA table_info(memory_facets)`).all().map((row: any) => row.name);
    const indexes = db.prepare(`PRAGMA index_list(memory_facets)`).all().map((row: any) => row.name).sort();
    db.close();
    await store.close();

    expect(columns).toEqual([
      'id',
      'target_type',
      'target_id',
      'dimension',
      'value',
      'confidence',
      'source',
      'evidence_event_ids',
      'project_hash',
      'created_at',
      'updated_at'
    ]);
    expect(indexes).toContain('idx_memory_facets_project_dimension_value');
    expect(indexes).toContain('idx_memory_facets_target');
    expect(indexes).toContain('idx_memory_facets_dimension_value_confidence');
  });

  it('creates memory governance audit table scoped by project and operation', async () => {
    const dbPath = tempDbPath();
    const store = new SQLiteEventStore(dbPath);
    await store.initialize();

    const db = new Database(dbPath);
    const columns = db.prepare(`PRAGMA table_info(memory_governance_audit)`).all().map((row: any) => row.name);
    const indexes = db.prepare(`PRAGMA index_list(memory_governance_audit)`).all().map((row: any) => row.name).sort();
    db.close();
    await store.close();

    expect(columns).toEqual([
      'audit_id',
      'operation',
      'actor',
      'project_hash',
      'target_type',
      'target_id',
      'before_json',
      'after_json',
      'source_event_ids',
      'created_at'
    ]);
    expect(indexes).toContain('idx_memory_governance_audit_project_operation');
    expect(indexes).toContain('idx_memory_governance_audit_target');
  });
});
