import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { hashProjectPath } from '../../src/core/registry/project-path.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import type { SQLiteDatabase } from '../../src/core/sqlite-wrapper.js';
import { statsRouter } from '../../src/server/api/stats.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

interface OperationsStatsFixture {
  home: string;
  projectDir: string;
  projectHash: string;
  storagePath: string;
  dbPath: string;
  previousHome: string | undefined;
}

const REQUIRED_OPERATION_TABLES = [
  'memory_facets',
  'memory_actions',
  'memory_leases',
  'memory_retention_scores',
  'memory_governance_audit',
  'memory_lessons'
];

function createApp() {
  const app = new Hono();
  app.route('/api/stats', statsRouter);
  return app;
}

function createFixture(name: string): OperationsStatsFixture {
  const previousHome = process.env.HOME;
  const home = mkdtempSync(path.join(tmpdir(), `cml-dashboard-operations-${name}-`));
  process.env.HOME = home;
  const projectDir = `/opt/cml-dashboard-operations-${name}-project`;
  const projectHash = hashProjectPath(projectDir);
  const storagePath = path.join(home, '.claude-code', 'memory', 'projects', projectHash);
  const dbPath = path.join(storagePath, 'events.sqlite');
  mkdirSync(storagePath, { recursive: true });
  return { home, projectDir, projectHash, storagePath, dbPath, previousHome };
}

async function openInitializedStore(fixture: OperationsStatsFixture): Promise<SQLiteEventStore> {
  const store = new SQLiteEventStore(fixture.dbPath, { markdownMirrorRoot: fixture.storagePath });
  await store.initialize();
  return store;
}

function cleanupFixture(fixture: OperationsStatsFixture | null): void {
  if (!fixture) return;
  if (fixture.previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = fixture.previousHome;
  rmSync(fixture.home, { recursive: true, force: true });
}

function insertOperationRows(db: SQLiteDatabase, projectHash: string): void {
  const otherProjectHash = 'deadbeef';

  const insertFacet = db.prepare(`
    INSERT INTO memory_facets (
      id, target_type, target_id, dimension, value, confidence, source,
      evidence_event_ids, project_hash, created_at, updated_at
    ) VALUES (?, 'event', ?, ?, ?, 1, 'manual', '[]', ?, ?, ?)
  `);
  insertFacet.run('facet-api-1', 'event-api-1', 'topic', 'api', projectHash, '2026-05-19T10:00:00.000Z', '2026-05-19T10:00:00.000Z');
  insertFacet.run('facet-api-2', 'event-api-2', 'topic', 'api', projectHash, '2026-05-19T11:00:00.000Z', '2026-05-19T11:00:00.000Z');
  insertFacet.run('facet-ui', 'event-ui', 'topic', 'ui', projectHash, '2026-05-20T10:00:00.000Z', '2026-05-20T10:00:00.000Z');
  insertFacet.run('facet-ops', 'event-ops', 'topic', 'ops', projectHash, '2026-05-20T11:00:00.000Z', '2026-05-20T11:00:00.000Z');
  insertFacet.run(
    'facet-private',
    'event-private',
    'runtime',
    '/Users/alice/secret-project password=dk token=dk',
    projectHash,
    '2026-05-20T12:00:00.000Z',
    '2026-05-20T12:00:00.000Z'
  );
  insertFacet.run('facet-other-project', 'event-other', 'topic', 'api', otherProjectHash, '2026-05-20T12:30:00.000Z', '2026-05-20T12:30:00.000Z');

  const insertAction = db.prepare(`
    INSERT INTO memory_actions (
      action_id, project_hash, title, status, priority, source_event_ids,
      related_entity_ids, current_checkpoint_id, lease_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, '[]', '[]', NULL, NULL, ?, ?)
  `);
  insertAction.run('action-pending-1', projectHash, 'action-secret-title password=dk', 'pending', '2026-05-20T09:00:00.000Z', '2026-05-20T09:00:00.000Z');
  insertAction.run('action-pending-2', projectHash, 'second pending', 'pending', '2026-05-20T09:10:00.000Z', '2026-05-20T09:10:00.000Z');
  insertAction.run('action-progress', projectHash, 'in progress', 'in_progress', '2026-05-20T09:20:00.000Z', '2026-05-20T09:20:00.000Z');
  insertAction.run('action-done', projectHash, 'done', 'done', '2026-05-20T09:30:00.000Z', '2026-05-20T09:30:00.000Z');
  insertAction.run('action-other-project', otherProjectHash, 'other project', 'pending', '2026-05-20T09:40:00.000Z', '2026-05-20T09:40:00.000Z');

  const insertLease = db.prepare(`
    INSERT INTO memory_leases (
      lease_id, target_type, target_id, holder, expires_at, metadata_json, created_at, renewed_at, released_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `);
  insertLease.run('lease-action-active', 'action', 'action-pending-1', 'worker-1', '2026-05-22T00:00:00.000Z', '{"note":"password=dk"}', '2026-05-21T09:00:00.000Z', null);
  insertLease.run('lease-routine-active', 'routine', 'routine-daily', 'worker-2', '2026-05-22T00:00:00.000Z', null, '2026-05-21T09:10:00.000Z', null);
  insertLease.run('lease-expired', 'checkpoint', 'checkpoint-old', 'worker-3', '2026-05-20T00:00:00.000Z', null, '2026-05-19T09:10:00.000Z', null);
  insertLease.run('lease-released', 'action', 'action-done', 'worker-4', '2026-05-22T00:00:00.000Z', null, '2026-05-21T09:20:00.000Z', '2026-05-21T10:00:00.000Z');

  const insertRetention = db.prepare(`
    INSERT INTO memory_retention_scores (
      score_id, target_type, target_id, project_hash, policy_version, decision,
      lifecycle_score, factors_json, reasons_json, dry_run_diff_json,
      source_event_ids, evaluated_at, created_at, updated_at
    ) VALUES (?, 'event', ?, ?, 'v1', ?, ?, '{}', '[]', '{}', '[]', ?, ?, ?)
  `);
  insertRetention.run('score-keep-1', 'event-1', projectHash, 'keep', 0.92, '2026-05-20T08:00:00.000Z', '2026-05-20T08:00:00.000Z', '2026-05-20T08:00:00.000Z');
  insertRetention.run('score-keep-2', 'event-2', projectHash, 'keep', 0.82, '2026-05-20T08:10:00.000Z', '2026-05-20T08:10:00.000Z', '2026-05-20T08:10:00.000Z');
  insertRetention.run('score-review', 'event-3', projectHash, 'review', 0.44, '2026-05-20T08:20:00.000Z', '2026-05-20T08:20:00.000Z', '2026-05-20T08:20:00.000Z');
  insertRetention.run('score-other-project', 'event-4', otherProjectHash, 'keep', 0.99, '2026-05-20T08:30:00.000Z', '2026-05-20T08:30:00.000Z', '2026-05-20T08:30:00.000Z');

  const insertAudit = db.prepare(`
    INSERT INTO memory_governance_audit (
      audit_id, operation, actor, project_hash, target_type, target_id,
      before_json, after_json, source_event_ids, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
  `);
  insertAudit.run('audit-facet', 'facet_tag', 'system', projectHash, 'event', 'target-secret-password=dk', '{"path":"/Users/alice/secret-project"}', '["source-secret-token=dk"]', '2026-05-20T01:00:00.000Z');
  insertAudit.run('audit-action', 'action_update', 'system', projectHash, 'action', 'action-pending-1', '{}', '[]', '2026-05-20T02:00:00.000Z');
  insertAudit.run('audit-lesson', 'lesson_promote', 'system', projectHash, 'lesson', 'lesson-high', '{}', '[]', '2026-05-21T02:00:00.000Z');
  insertAudit.run('audit-old', 'verify', 'system', projectHash, 'event', 'old', '{}', '[]', '2026-04-01T02:00:00.000Z');
  insertAudit.run('audit-other-project', 'facet_tag', 'system', otherProjectHash, 'event', 'other', '{}', '[]', '2026-05-21T03:00:00.000Z');

  const insertLesson = db.prepare(`
    INSERT INTO memory_lessons (
      lesson_id, project_hash, name, trigger, steps_json, confidence,
      source_session_ids, source_event_ids, failure_modes_json, skill_candidate, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '["step"]', ?, '[]', '["event"]', '[]', 0, ?, ?)
  `);
  insertLesson.run('lesson-low', projectHash, 'lesson low', 'trigger low', 0.1, '2026-05-20T07:00:00.000Z', '2026-05-20T07:00:00.000Z');
  insertLesson.run('lesson-mid-low', projectHash, 'lesson mid low', 'trigger mid low', 0.35, '2026-05-20T07:10:00.000Z', '2026-05-20T07:10:00.000Z');
  insertLesson.run('lesson-mid-high', projectHash, 'lesson mid high', 'trigger mid high', 0.65, '2026-05-20T07:20:00.000Z', '2026-05-20T07:20:00.000Z');
  insertLesson.run('lesson-high', projectHash, 'lesson secret /Users/alice/secret-project', 'trigger high token=dk', 0.9, '2026-05-20T07:30:00.000Z', '2026-05-20T07:30:00.000Z');
  insertLesson.run('lesson-other-project', otherProjectHash, 'other project', 'trigger', 0.9, '2026-05-20T07:40:00.000Z', '2026-05-20T07:40:00.000Z');
}

function createEmptyLegacyDatabase(fixture: OperationsStatsFixture): void {
  const db = new Database(fixture.dbPath);
  try {
    db.prepare('CREATE TABLE legacy_only (id TEXT PRIMARY KEY)').run();
  } finally {
    db.close();
  }
}

describe('dashboard operations stats API', () => {
  let fixture: OperationsStatsFixture | null = null;

  afterEach(() => {
    vi.useRealTimers();
    cleanupFixture(fixture);
    fixture = null;
  });

  it('returns aggregate-only operation stats for all projection buckets', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T12:00:00.000Z'));
    fixture = createFixture('aggregate');
    const store = await openInitializedStore(fixture);
    try {
      insertOperationRows(store.getDatabase(), fixture.projectHash);
      await store.close();

      const res = await createApp().request(`/api/stats/operations?project=${encodeURIComponent(fixture.projectDir)}&windowDays=7&topFacetValues=2`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.generatedAt).toBe('2026-05-21T12:00:00.000Z');
      expect(body.windowDays).toBe(7);
      expect(body.projectHash).toBe(fixture.projectHash);
      expect(body.projection).toEqual({
        databaseExists: true,
        available: true,
        missingTables: []
      });

      expect(body.facets.totalAssignments).toBe(5);
      expect(body.facets.distribution).toEqual([
        {
          dimension: 'runtime',
          values: [{ value: '[REDACTED]', count: 1 }],
          other: 0
        },
        {
          dimension: 'topic',
          values: [
            { value: 'api', count: 2 },
            { value: 'ops', count: 1 }
          ],
          other: 1
        }
      ]);
      expect(body.actions).toEqual({
        total: 4,
        byStatus: [
          { status: 'pending', count: 2 },
          { status: 'done', count: 1 },
          { status: 'in_progress', count: 1 }
        ]
      });
      expect(body.leases).toEqual({
        totalActive: 2,
        activeByTargetType: [
          { targetType: 'action', count: 1 },
          { targetType: 'routine', count: 1 }
        ]
      });
      expect(body.retention).toEqual({
        total: 3,
        byDecision: [
          { decision: 'keep', count: 2 },
          { decision: 'review', count: 1 }
        ]
      });
      expect(body.governanceAudit).toEqual({
        total: 3,
        operationsByDay: [
          {
            date: '2026-05-20',
            total: 2,
            operations: [
              { operation: 'action_update', count: 1 },
              { operation: 'facet_tag', count: 1 }
            ]
          },
          {
            date: '2026-05-21',
            total: 1,
            operations: [{ operation: 'lesson_promote', count: 1 }]
          }
        ]
      });
      expect(body.lessons).toEqual({
        total: 4,
        confidenceBuckets: [
          { bucket: '0.00-0.25', count: 1 },
          { bucket: '0.25-0.50', count: 1 },
          { bucket: '0.50-0.75', count: 1 },
          { bucket: '0.75-1.00', count: 1 }
        ]
      });

      const json = JSON.stringify(body);
      expect(json).not.toContain(fixture.projectDir);
      expect(json).not.toContain('/Users/alice/secret-project');
      expect(json).not.toContain('password=dk');
      expect(json).not.toContain('token=dk');
      expect(json).not.toContain('action-secret-title');
      expect(json).not.toContain('lesson secret');
      expect(json).not.toContain('target-secret');
      expect(json).not.toContain('source-secret');
      expect(json).not.toContain('metadata_json');
      expect(json).not.toContain('content');
      expect(json).not.toContain('event-api-1');
      expect(json).not.toContain('action-pending-1');
    } finally {
      if (existsSync(fixture.dbPath)) {
        try {
          await store.close();
        } catch {
          // Store may already be closed after seeding.
        }
      }
    }
  });

  it('returns empty aggregate buckets for legacy databases without operation projection tables', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T12:00:00.000Z'));
    fixture = createFixture('legacy');
    createEmptyLegacyDatabase(fixture);

    const res = await createApp().request(`/api/stats/operations?project=${fixture.projectHash}&windowDays=7`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.generatedAt).toBe('2026-05-21T12:00:00.000Z');
    expect(body.projection).toEqual({
      databaseExists: true,
      available: false,
      missingTables: REQUIRED_OPERATION_TABLES
    });
    expect(body.facets).toEqual({ totalAssignments: 0, distribution: [] });
    expect(body.actions).toEqual({ total: 0, byStatus: [] });
    expect(body.leases).toEqual({ totalActive: 0, activeByTargetType: [] });
    expect(body.retention).toEqual({ total: 0, byDecision: [] });
    expect(body.governanceAudit).toEqual({ total: 0, operationsByDay: [] });
    expect(body.lessons).toEqual({
      total: 0,
      confidenceBuckets: [
        { bucket: '0.00-0.25', count: 0 },
        { bucket: '0.25-0.50', count: 0 },
        { bucket: '0.50-0.75', count: 0 },
        { bucket: '0.75-1.00', count: 0 }
      ]
    });

    const db = new Database(fixture.dbPath, { readonly: true });
    try {
      const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
      expect(tableNames.map((row) => row.name)).toEqual(['legacy_only']);
    } finally {
      db.close();
    }
  });
});
