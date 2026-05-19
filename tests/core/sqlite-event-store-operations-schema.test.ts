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

  it('creates memory action, lease, and checkpoint projection tables with lookup indexes', async () => {
    const dbPath = tempDbPath();
    const store = new SQLiteEventStore(dbPath);
    await store.initialize();

    const db = new Database(dbPath);
    const actions = db.prepare(`PRAGMA table_info(memory_actions)`).all().map((row: any) => row.name);
    const actionEdges = db.prepare(`PRAGMA table_info(memory_action_edges)`).all().map((row: any) => row.name);
    const leases = db.prepare(`PRAGMA table_info(memory_leases)`).all().map((row: any) => row.name);
    const checkpoints = db.prepare(`PRAGMA table_info(memory_checkpoints)`).all().map((row: any) => row.name);
    const actionIndexes = db.prepare(`PRAGMA index_list(memory_actions)`).all().map((row: any) => row.name).sort();
    const leaseIndexes = db.prepare(`PRAGMA index_list(memory_leases)`).all().map((row: any) => row.name).sort();
    const checkpointIndexes = db.prepare(`PRAGMA index_list(memory_checkpoints)`).all().map((row: any) => row.name).sort();
    db.close();
    await store.close();

    expect(actions).toEqual([
      'action_id',
      'project_hash',
      'title',
      'status',
      'priority',
      'source_event_ids',
      'related_entity_ids',
      'current_checkpoint_id',
      'lease_id',
      'created_at',
      'updated_at'
    ]);
    expect(actionEdges).toEqual([
      'edge_id',
      'src_action_id',
      'rel_type',
      'dst_type',
      'dst_id',
      'confidence',
      'created_at'
    ]);
    expect(leases).toEqual([
      'lease_id',
      'target_type',
      'target_id',
      'holder',
      'expires_at',
      'metadata_json',
      'created_at',
      'renewed_at',
      'released_at'
    ]);
    expect(checkpoints).toEqual([
      'checkpoint_id',
      'project_hash',
      'action_id',
      'session_id',
      'title',
      'summary',
      'state_json',
      'source_event_ids',
      'created_at',
      'expires_at'
    ]);
    expect(actionIndexes).toContain('idx_memory_actions_project_status_priority');
    expect(leaseIndexes).toContain('idx_memory_leases_target_expires');
    expect(checkpointIndexes).toContain('idx_memory_checkpoints_project_action_created');
  });
});
