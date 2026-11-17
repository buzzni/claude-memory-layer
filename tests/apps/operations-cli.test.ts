import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ActionRepository } from '../../src/core/operations/action-repository.js';
import { CheckpointRepository } from '../../src/core/operations/checkpoint-repository.js';
import { FacetRepository } from '../../src/core/operations/facet-repository.js';
import { LeaseRepository } from '../../src/core/operations/lease-repository.js';
import { hashProjectPath } from '../../src/core/registry/project-path.js';
import { sharedLessonId } from '../../src/core/operations/lesson-share.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { tsxArgs, tsxCommand } from '../helpers/tsx-process.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

const SLOW_CLI_TEST_TIMEOUT_MS = 60_000;

type JsonObject = Record<string, unknown>;

interface CliFixture {
  home: string;
  projectDir: string;
  projectHash: string;
  storagePath: string;
  dbPath: string;
}

function createCliFixture(name: string): CliFixture {
  const home = mkdtempSync(path.join(tmpdir(), `cml-operations-cli-${name}-`));
  const projectDir = `/opt/cml-operations-cli-${name}-project`;
  const projectHash = hashProjectPath(projectDir);
  const storagePath = path.join(home, '.claude-code', 'memory', 'projects', projectHash);
  const dbPath = path.join(storagePath, 'events.sqlite');
  mkdirSync(storagePath, { recursive: true });
  return { home, projectDir, projectHash, storagePath, dbPath };
}

async function openStore(fixture: CliFixture): Promise<SQLiteEventStore> {
  const store = new SQLiteEventStore(fixture.dbPath, { markdownMirrorRoot: fixture.storagePath });
  await store.initialize();
  return store;
}

function runCli(fixture: CliFixture, args: string[]) {
  return spawnSync(tsxCommand, tsxArgs('src/apps/cli/index.ts', ...args), {
    cwd: process.cwd(),
    env: { ...process.env, HOME: fixture.home },
    encoding: 'utf8'
  });
}

function expectJsonCommand(fixture: CliFixture, args: string[]): JsonObject {
  const result = runCli(fixture, args);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).not.toContain(fixture.projectDir);
  expect(result.stdout).not.toContain('password=dk');
  expect(result.stdout).not.toContain('token=dk');
  expect(result.stdout).not.toContain('apiToken');
  return JSON.parse(result.stdout) as JsonObject;
}

function expectFailedCommand(fixture: CliFixture, args: string[]) {
  const result = runCli(fixture, args);
  expect(result.status, result.stdout || result.stderr).not.toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toContain(fixture.projectDir);
  expect(result.stderr).not.toContain('password=dk');
  expect(result.stderr).not.toContain('token=dk');
  expect(result.stderr).not.toContain('apiToken');
  return result;
}

function createEmptySqliteFile(dbPath: string): void {
  const db = new Database(dbPath);
  db.close();
}

function queryCount(dbPath: string, sql: string, params: unknown[] = []): number {
  const db = new Database(dbPath);
  try {
    const row = db.prepare(sql).get(...params) as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

describe('memory operations CLI commands', () => {
  it('exposes facet/action/frontier/checkpoint read commands as privacy-safe JSON', async () => {
    const fixture = createCliFixture('read');
    try {
      const store = await openStore(fixture);
      const event = await store.append({
        eventType: 'tool_observation',
        sessionId: 'session-operations-cli-read',
        timestamp: new Date('2026-05-20T00:00:00.000Z'),
        content: `debug output password=dk from ${fixture.projectDir}`,
        metadata: { scope: { project: { hash: fixture.projectHash, path: fixture.projectDir } } }
      });
      if (event.success !== true || !event.eventId) throw new Error('append failed');

      const db = store.getDatabase();
      const actions = new ActionRepository(db);
      const facets = new FacetRepository(db);
      const checkpoints = new CheckpointRepository(db);
      const leases = new LeaseRepository(db);

      const action = await actions.upsert({
        projectHash: fixture.projectHash,
        title: 'Ship operations CLI',
        priority: 7,
        sourceEventIds: [event.eventId],
        actor: 'test'
      });
      await actions.upsert({
        projectHash: fixture.projectHash,
        title: 'Done operation task',
        status: 'done',
        priority: 100,
        actor: 'test'
      });
      await actions.upsert({ projectHash: 'other-project', title: 'Foreign operation task', priority: 100, actor: 'test' });
      await facets.assign({
        projectHash: fixture.projectHash,
        targetType: 'action',
        targetId: action.actionId,
        dimension: 'workflow',
        value: 'release',
        confidence: 0.95,
        source: 'manual',
        evidenceEventIds: [event.eventId],
        actor: 'test'
      });
      await checkpoints.create({
        projectHash: fixture.projectHash,
        actionId: action.actionId,
        title: 'Resume operations CLI',
        summary: 'Resume operations CLI',
        stateJson: { step: 'verify', cwd: fixture.projectDir, apiToken: 'dk' },
        sourceEventIds: [event.eventId],
        actor: 'test'
      });
      await leases.acquire({
        targetType: 'action',
        targetId: action.actionId,
        holder: 'agent-a',
        expiresAt: new Date(Date.now() + 60_000),
        actor: 'test',
        projectHash: fixture.projectHash
      });
      await store.close();

      const facetPayload = expectJsonCommand(fixture, [
        'facet', 'query',
        '--project', fixture.projectDir,
        '--target-type', 'action',
        '--target-id', action.actionId,
        '--dimension', 'workflow',
        '--value', 'release',
        '--json'
      ]);
      expect(facetPayload).toMatchObject({ operation: 'mem-facet-query', projectHash: fixture.projectHash, count: 1 });
      expect((facetPayload.facets as JsonObject[])[0]).toMatchObject({ targetId: action.actionId, value: 'release' });

      const actionPayload = expectJsonCommand(fixture, [
        'action', 'list',
        '--project', fixture.projectDir,
        '--status', 'pending',
        '--json'
      ]);
      expect(actionPayload).toMatchObject({ operation: 'mem-action-list', projectHash: fixture.projectHash, count: 1 });
      expect(JSON.stringify(actionPayload)).toContain('Ship operations CLI');
      expect(JSON.stringify(actionPayload)).not.toContain('Done operation task');
      expect(JSON.stringify(actionPayload)).not.toContain('Foreign operation task');

      const frontierPayload = expectJsonCommand(fixture, [
        'frontier',
        '--project', fixture.projectDir,
        '--limit', '5',
        '--json'
      ]);
      expect(frontierPayload).toMatchObject({ operation: 'mem-frontier', projectHash: fixture.projectHash, count: 1 });
      expect(JSON.stringify(frontierPayload)).toContain('active_lease:agent-a');

      const checkpointPayload = expectJsonCommand(fixture, [
        'checkpoint', 'list',
        '--project', fixture.projectDir,
        '--target-type', 'action',
        '--target-id', action.actionId,
        '--json'
      ]);
      expect(checkpointPayload).toMatchObject({ operation: 'mem-checkpoint-list', projectHash: fixture.projectHash, count: 1 });
      expect(JSON.stringify(checkpointPayload)).toContain('Resume operations CLI');
      expect(JSON.stringify(checkpointPayload)).not.toContain('token=dk');
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
    }
  }, SLOW_CLI_TEST_TIMEOUT_MS);

  it('defaults mutating facet/action/checkpoint commands to dry-run JSON without writing operation rows', async () => {
    const fixture = createCliFixture('dry-run');
    try {
      const store = await openStore(fixture);
      const event = await store.append({
        eventType: 'user_prompt',
        sessionId: 'session-operations-cli-dry-run',
        timestamp: new Date('2026-05-20T01:00:00.000Z'),
        content: `please mutate from ${fixture.projectDir} with token=dk`,
        metadata: { scope: { project: { hash: fixture.projectHash, path: fixture.projectDir } } }
      });
      if (event.success !== true || !event.eventId) throw new Error('append failed');
      const action = await new ActionRepository(store.getDatabase()).upsert({
        projectHash: fixture.projectHash,
        title: 'Dry-run action',
        priority: 1,
        sourceEventIds: [event.eventId],
        actor: 'test'
      });
      await store.close();

      const beforeFacets = queryCount(fixture.dbPath, 'SELECT COUNT(*) AS count FROM memory_facets');
      const beforeCheckpoints = queryCount(fixture.dbPath, 'SELECT COUNT(*) AS count FROM memory_checkpoints');
      const beforeAudits = queryCount(fixture.dbPath, 'SELECT COUNT(*) AS count FROM memory_governance_audit');

      const facetDryRun = expectJsonCommand(fixture, [
        'facet', 'tag',
        '--project', fixture.projectDir,
        '--target-type', 'action',
        '--target-id', action.actionId,
        '--dimension', 'workflow',
        '--value', `release from ${fixture.projectDir} token=dk`,
        '--source-event-ids', event.eventId,
        '--actor', 'test',
        '--json'
      ]);
      expect(facetDryRun).toMatchObject({ operation: 'mem-facet-tag', dryRun: true, projectHash: fixture.projectHash });

      const actionDryRun = expectJsonCommand(fixture, [
        'action', 'update',
        '--project', fixture.projectDir,
        '--action-id', action.actionId,
        '--status', 'done',
        '--note', `done from ${fixture.projectDir} token=dk`,
        '--actor', 'test',
        '--json'
      ]);
      expect(actionDryRun).toMatchObject({ operation: 'mem-action-update', dryRun: true, projectHash: fixture.projectHash });

      const checkpointDryRun = expectJsonCommand(fixture, [
        'checkpoint', 'create',
        '--project', fixture.projectDir,
        '--target-type', 'action',
        '--target-id', action.actionId,
        '--label', `resume ${fixture.projectDir}`,
        '--state-json', JSON.stringify({ cwd: fixture.projectDir, apiToken: 'dk' }),
        '--source-event-ids', event.eventId,
        '--actor', 'test',
        '--json'
      ]);
      expect(checkpointDryRun).toMatchObject({ operation: 'mem-checkpoint-create', dryRun: true, projectHash: fixture.projectHash });

      expect(queryCount(fixture.dbPath, 'SELECT COUNT(*) AS count FROM memory_facets')).toBe(beforeFacets);
      expect(queryCount(fixture.dbPath, 'SELECT COUNT(*) AS count FROM memory_checkpoints')).toBe(beforeCheckpoints);
      expect(queryCount(fixture.dbPath, 'SELECT COUNT(*) AS count FROM memory_governance_audit')).toBe(beforeAudits);
      const db = new Database(fixture.dbPath);
      try {
        const row = db.prepare('SELECT status FROM memory_actions WHERE action_id = ?').get(action.actionId) as { status: string };
        expect(row.status).toBe('pending');
      } finally {
        db.close();
      }
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it('applies mutating commands only when --apply is supplied', async () => {
    const fixture = createCliFixture('apply');
    try {
      const store = await openStore(fixture);
      const event = await store.append({
        eventType: 'user_prompt',
        sessionId: 'session-operations-cli-apply',
        timestamp: new Date('2026-05-20T02:00:00.000Z'),
        content: 'apply operations cli commands',
        metadata: { scope: { project: { hash: fixture.projectHash, path: fixture.projectDir } } }
      });
      if (event.success !== true || !event.eventId) throw new Error('append failed');
      const action = await new ActionRepository(store.getDatabase()).upsert({
        projectHash: fixture.projectHash,
        title: 'Apply action',
        priority: 1,
        sourceEventIds: [event.eventId],
        actor: 'test'
      });
      await store.close();

      const facetApplied = expectJsonCommand(fixture, [
        'facet', 'tag',
        '--project', fixture.projectDir,
        '--target-type', 'action',
        '--target-id', action.actionId,
        '--dimension', 'quality',
        '--value', 'verified',
        '--confidence', '0.9',
        '--source-event-ids', event.eventId,
        '--actor', 'test',
        '--apply',
        '--json'
      ]);
      expect(facetApplied).toMatchObject({ operation: 'mem-facet-tag', dryRun: false, projectHash: fixture.projectHash });

      const actionApplied = expectJsonCommand(fixture, [
        'action', 'update',
        '--project', fixture.projectDir,
        '--action-id', action.actionId,
        '--status', 'done',
        '--source-event-ids', event.eventId,
        '--actor', 'test',
        '--apply',
        '--json'
      ]);
      expect(actionApplied).toMatchObject({ operation: 'mem-action-update', dryRun: false, projectHash: fixture.projectHash });

      const checkpointApplied = expectJsonCommand(fixture, [
        'checkpoint', 'create',
        '--project', fixture.projectDir,
        '--target-type', 'action',
        '--target-id', action.actionId,
        '--label', 'Applied checkpoint',
        '--state-json', JSON.stringify({ step: 'green' }),
        '--source-event-ids', event.eventId,
        '--actor', 'test',
        '--apply',
        '--json'
      ]);
      expect(checkpointApplied).toMatchObject({ operation: 'mem-checkpoint-create', dryRun: false, projectHash: fixture.projectHash });

      expect(queryCount(fixture.dbPath, "SELECT COUNT(*) AS count FROM memory_facets WHERE target_id = ? AND dimension = 'quality'", [action.actionId])).toBe(1);
      expect(queryCount(fixture.dbPath, 'SELECT COUNT(*) AS count FROM memory_checkpoints WHERE action_id = ?', [action.actionId])).toBe(1);
      const db = new Database(fixture.dbPath);
      try {
        const row = db.prepare('SELECT status FROM memory_actions WHERE action_id = ?').get(action.actionId) as { status: string };
        expect(row.status).toBe('done');
      } finally {
        db.close();
      }
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it('captures and lists an explicit curated lesson without requiring a raw event', async () => {
    const fixture = createCliFixture('curated-lesson');
    try {
      const dryRun = expectJsonCommand(fixture, [
        'lesson', 'add',
        '--project', fixture.projectDir,
        '--name', 'Deploy GPU before API',
        '--trigger', 'When rolling out the runtime split',
        '--steps', 'Roll out GPU,Verify readiness,Roll out API',
        '--actor', 'operator',
        '--json'
      ]);
      expect(dryRun).toMatchObject({ operation: 'mem-lesson-save', dryRun: true, projectHash: fixture.projectHash });
      expect(existsSync(fixture.dbPath)).toBe(false);

      const saved = expectJsonCommand(fixture, [
        'lesson', 'add',
        '--project', fixture.projectDir,
        '--name', 'Deploy GPU before API',
        '--trigger', 'When rolling out the runtime split',
        '--steps', 'Roll out GPU,Verify readiness,Roll out API',
        '--actor', 'operator',
        '--apply',
        '--json'
      ]);
      expect(saved).toMatchObject({
        operation: 'mem-lesson-save',
        dryRun: false,
        projectHash: fixture.projectHash,
        lesson: { sourceClass: 'curated', sourceSessionIds: ['curated:operator'] }
      });
      expect(queryCount(fixture.dbPath, "SELECT COUNT(*) AS count FROM memory_lessons WHERE source_class = 'curated'")).toBe(1);
      expect(queryCount(fixture.dbPath, "SELECT COUNT(*) AS count FROM memory_governance_audit WHERE operation = 'lesson_capture'")).toBe(1);

      const listed = expectJsonCommand(fixture, [
        'lesson', 'list',
        '--project', fixture.projectDir,
        '--curated-only',
        '--json'
      ]);
      expect(listed).toMatchObject({ operation: 'mem-lesson-list', projectHash: fixture.projectHash, count: 1 });
      expect((listed.lessons as JsonObject[])[0]).toMatchObject({ name: 'Deploy GPU before API', sourceClass: 'curated' });
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
    }
  }, SLOW_CLI_TEST_TIMEOUT_MS);

  it('exports curated lessons to files and imports them into another store as imported lessons', () => {
    // Real project directories: the default lesson directory lives inside the project.
    const withProject = (fixture: CliFixture): CliFixture => {
      const projectDir = path.join(fixture.home, 'checkout');
      mkdirSync(projectDir);
      const projectHash = hashProjectPath(projectDir);
      const storagePath = path.join(fixture.home, '.claude-code', 'memory', 'projects', projectHash);
      return { ...fixture, projectDir, projectHash, storagePath, dbPath: path.join(storagePath, 'events.sqlite') };
    };
    const source = withProject(createCliFixture('lesson-export'));
    const target = withProject(createCliFixture('lesson-import'));
    const lessonsDir = (fixture: CliFixture) => path.join(fixture.projectDir, '.claude-memory-layer', 'lessons');
    const filesIn = (dir: string) => Object.fromEntries(readdirSync(dir).sort().map((file) => [file, readFileSync(path.join(dir, file), 'utf8')]));
    try {
      expectJsonCommand(source, ['lesson', 'add', '--project', source.projectDir, '--name', 'Deploy GPU before API',
        '--trigger', 'When rolling out the runtime split', '--steps', 'Roll out GPU,Verify readiness,Roll out API', '--apply', '--json']);
      const noSelection = expectFailedCommand(source, ['lesson', 'export', '--project', source.projectDir, '--json']);
      expect(noSelection.stderr).toContain('select lessons with --lesson or --all-curated');

      const exportPreview = expectJsonCommand(source, ['lesson', 'export', '--project', source.projectDir, '--all-curated', '--json']);
      expect(exportPreview).toMatchObject({ operation: 'lesson-export', dryRun: true, dir: path.join('.claude-memory-layer', 'lessons'), counts: { add: 1 } });
      expect(existsSync(lessonsDir(source))).toBe(false);
      expectJsonCommand(source, ['lesson', 'export', '--project', source.projectDir, '--all-curated', '--apply', '--json']);

      // git commit + checkout on the other machine.
      cpSync(lessonsDir(source), lessonsDir(target), { recursive: true });

      const importPreview = expectJsonCommand(target, ['lesson', 'import', '--project', target.projectDir, '--json']);
      expect(importPreview).toMatchObject({ operation: 'lesson-import', dryRun: true, counts: { add: 1 } });
      expect(existsSync(target.dbPath)).toBe(false);

      const imported = expectJsonCommand(target, ['lesson', 'import', '--project', target.projectDir, '--actor', 'teammate', '--apply', '--json']);
      expect(imported).toMatchObject({ dryRun: false, counts: { add: 1 } });
      expect(queryCount(target.dbPath, "SELECT COUNT(*) AS count FROM memory_lessons WHERE source_class = 'imported'")).toBe(1);
      expect(queryCount(target.dbPath, "SELECT COUNT(*) AS count FROM memory_governance_audit WHERE operation = 'lesson_import' AND actor = 'teammate'")).toBe(1);
      expect(expectJsonCommand(target, ['lesson', 'import', '--project', target.projectDir, '--apply', '--json']))
        .toMatchObject({ counts: { unchanged: 1 } });
      const listed = expectJsonCommand(target, ['lesson', 'list', '--project', target.projectDir, '--json']);
      expect((listed.lessons as JsonObject[])[0]).toMatchObject({ name: 'Deploy GPU before API', sourceClass: 'imported', sourceSessionIds: [] });

      const reexport = expectJsonCommand(target, ['lesson', 'export', '--project', target.projectDir, '--all-curated', '--apply', '--json']);
      expect(reexport).toMatchObject({ counts: { unchanged: 1 } });
      expect(filesIn(lessonsDir(target))).toEqual(filesIn(lessonsDir(source)));
    } finally {
      rmSync(source.home, { recursive: true, force: true });
      rmSync(target.home, { recursive: true, force: true });
    }
  }, SLOW_CLI_TEST_TIMEOUT_MS);

  it('previews an import against an old store without changing it, and exits 2 when an entry conflicts', () => {
    const fixture = createCliFixture('lesson-import-old-store');
    const projectDir = path.join(fixture.home, 'checkout');
    const lessonsDir = path.join(projectDir, '.claude-memory-layer', 'lessons');
    // Created before hashing: the CLI hashes the existing directory.
    mkdirSync(lessonsDir, { recursive: true });
    const projectHash = hashProjectPath(projectDir);
    const storagePath = path.join(fixture.home, '.claude-code', 'memory', 'projects', projectHash);
    const target = { ...fixture, projectDir, projectHash, storagePath, dbPath: path.join(storagePath, 'events.sqlite') };
    try {
      mkdirSync(storagePath, { recursive: true });
      const name = 'Deploy GPU before API';
      const id = sharedLessonId(name);
      writeFileSync(path.join(lessonsDir, `${id}.json`), `${JSON.stringify({
        format: 'claude-memory-layer/lesson@1', id, name, trigger: 'When rolling out', steps: ['Roll out GPU'],
        failureModes: [], validation: [], validVersions: [], confidence: 1, skillCandidate: true
      }, null, 2)}\n`);
      // A store from before source_class, revision and the governance audit existed.
      const old = new Database(target.dbPath);
      old.exec(`CREATE TABLE memory_lessons (lesson_id TEXT PRIMARY KEY, project_hash TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, trigger TEXT NOT NULL,
        steps_json TEXT NOT NULL, confidence REAL NOT NULL, source_session_ids TEXT NOT NULL DEFAULT '[]', source_event_ids TEXT NOT NULL DEFAULT '[]',
        failure_modes_json TEXT NOT NULL DEFAULT '[]', skill_candidate INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_hash, name))`);
      old.prepare(`INSERT INTO memory_lessons (lesson_id, project_hash, name, trigger, steps_json, confidence, created_at, updated_at)
        VALUES ('00000000-0000-4000-8000-000000000009', ?, ?, 'When rolling out', '["Something else"]', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run(projectHash, name);
      old.close();
      const before = readFileSync(target.dbPath);

      const result = runCli(target, ['lesson', 'import', '--project', projectDir, '--json']);
      expect(result.status, result.stderr).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, projectHash, counts: { conflict: 1 } });
      expect(readFileSync(target.dbPath).equals(before)).toBe(true);
      expect(readdirSync(storagePath)).toEqual(['events.sqlite']);
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
    }
  }, SLOW_CLI_TEST_TIMEOUT_MS);

  it('consolidates approved runbook drafts only with --apply, and reverts them', () => {
    const fixture = createCliFixture('lesson-consolidate');
    try {
      const earlyDrafts = path.join(fixture.home, 'early.json');
      writeFileSync(earlyDrafts, JSON.stringify({ runbooks: [{ lessonId: 'rb-0', name: 'n', trigger: 't', steps: ['s'], validation: ['v'], scope: 's', reconsiderWhen: 'r', absorbs: [{ lessonId: 'x', revision: 1 }] }] }));
      const preview = expectJsonCommand(fixture, ['lesson', 'consolidate', '--project', fixture.projectDir, '--drafts', earlyDrafts, '--json']);
      expect(preview).toMatchObject({ dryRun: true, problems: ['this project has no lesson store'] });
      expect(existsSync(fixture.dbPath)).toBe(false);

      const add = (name: string) => expectJsonCommand(fixture, ['lesson', 'add', '--project', fixture.projectDir, '--name', name,
        '--trigger', `when ${name}`, '--steps', `do ${name}`, '--apply', '--json']).lesson as JsonObject;
      const first = add('rebase-before-push');
      const second = add('push-rejected-retry');
      const draftsPath = path.join(fixture.home, 'drafts.json');
      writeFileSync(draftsPath, JSON.stringify({ runbooks: [{
        lessonId: 'rb-1', name: 'prepare-and-push-pr-branch', trigger: 'PR 브랜치를 push할 때', steps: ['브랜치를 확인한다'],
        failureModes: [], validation: ['0 behind'], scope: '브랜치 작업', reconsiderWhen: '브랜치 정책이 바뀔 때',
        absorbs: [{ lessonId: first.lessonId, revision: 1 }, { lessonId: second.lessonId, revision: 1 }]
      }] }));
      const enabled = () => queryCount(fixture.dbPath, 'SELECT COUNT(*) AS count FROM memory_lessons WHERE recall_enabled = 1');

      const dryRun = expectJsonCommand(fixture, ['lesson', 'consolidate', '--project', fixture.projectDir, '--drafts', draftsPath, '--json']);
      expect(dryRun).toMatchObject({ operation: 'lesson-consolidate', dryRun: true, problems: [] });
      expect(enabled()).toBe(2);

      const applied = expectJsonCommand(fixture, ['lesson', 'consolidate', '--project', fixture.projectDir, '--drafts', draftsPath, '--apply', '--json']);
      const runbookId = ((applied.runbooks as JsonObject[])[0]).lessonId as string;
      expect(enabled()).toBe(1);
      expect(queryCount(fixture.dbPath, 'SELECT COUNT(*) AS count FROM memory_lessons WHERE absorbed_into = ?', [runbookId])).toBe(2);

      const again = expectJsonCommand(fixture, ['lesson', 'consolidate', '--project', fixture.projectDir, '--drafts', draftsPath, '--json']);
      expect((again.problems as string[]).length).toBeGreaterThan(0);

      const revertPreview = expectJsonCommand(fixture, ['lesson', 'revert-consolidation', '--project', fixture.projectDir, '--runbook', runbookId, '--json']);
      expect((revertPreview.restore as JsonObject[]).length).toBe(2);
      expect(enabled()).toBe(1);
      expectJsonCommand(fixture, ['lesson', 'revert-consolidation', '--project', fixture.projectDir, '--runbook', runbookId, '--apply', '--json']);
      expect(enabled()).toBe(2);
      expectFailedCommand(fixture, ['lesson', 'revert-consolidation', '--project', fixture.projectDir, '--runbook', runbookId, '--json']);
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
    }
  }, SLOW_CLI_TEST_TIMEOUT_MS);

  it('validates dry-run mutation input before reporting success or opening storage', () => {
    const fixture = createCliFixture('invalid-dry-run');
    rmSync(fixture.home, { recursive: true, force: true });
    try {
      const actionResult = expectFailedCommand(fixture, [
        'action', 'update',
        '--project', fixture.projectDir,
        '--action-id', 'not-a-uuid',
        '--status', 'bogus',
        '--note', `token=dk from ${fixture.projectDir}`,
        '--json'
      ]);
      expect(actionResult.stderr).toContain('Action update failed');
      expect(existsSync(fixture.dbPath)).toBe(false);

      const facetResult = expectFailedCommand(fixture, [
        'facet', 'tag',
        '--project', fixture.projectDir,
        '--target-type', 'session',
        '--target-id', 'target-1',
        '--dimension', 'Bad Dimension',
        '--value', `password=dk from ${fixture.projectDir}`,
        '--json'
      ]);
      expect(facetResult.stderr).toContain('Facet tag failed');
      expect(existsSync(fixture.dbPath)).toBe(false);
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it('validates read options before returning empty results for projects without operation storage', () => {
    const fixture = createCliFixture('invalid-read-options');
    rmSync(fixture.home, { recursive: true, force: true });
    try {
      expectFailedCommand(fixture, [
        'action', 'list',
        '--project', fixture.projectDir,
        '--status', 'bogus',
        '--json'
      ]);
      expectFailedCommand(fixture, [
        'frontier',
        '--project', fixture.projectDir,
        '--limit', '1e2',
        '--json'
      ]);
      expectFailedCommand(fixture, [
        'facet', 'query',
        '--project', fixture.projectDir,
        '--target-type', 'session',
        '--json'
      ]);
      expect(existsSync(fixture.dbPath)).toBe(false);
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it('returns empty read payloads for existing legacy DBs without operation tables', () => {
    const fixture = createCliFixture('legacy-empty-db');
    try {
      createEmptySqliteFile(fixture.dbPath);

      const actionPayload = expectJsonCommand(fixture, [
        'action', 'list',
        '--project', fixture.projectDir,
        '--json'
      ]);
      expect(actionPayload).toMatchObject({ operation: 'mem-action-list', projectHash: fixture.projectHash, count: 0, actions: [] });

      const facetPayload = expectJsonCommand(fixture, [
        'facet', 'query',
        '--project', fixture.projectDir,
        '--json'
      ]);
      expect(facetPayload).toMatchObject({ operation: 'mem-facet-query', projectHash: fixture.projectHash, count: 0, facets: [] });

      const frontierPayload = expectJsonCommand(fixture, [
        'frontier',
        '--project', fixture.projectDir,
        '--json'
      ]);
      expect(frontierPayload).toMatchObject({ operation: 'mem-frontier', projectHash: fixture.projectHash, count: 0, frontier: [] });

      const checkpointPayload = expectJsonCommand(fixture, [
        'checkpoint', 'list',
        '--project', fixture.projectDir,
        '--json'
      ]);
      expect(checkpointPayload).toMatchObject({ operation: 'mem-checkpoint-list', projectHash: fixture.projectHash, count: 0, checkpoints: [] });
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  it('prints operation command help without creating project storage', () => {
    const fixture = createCliFixture('help');
    rmSync(fixture.home, { recursive: true, force: true });
    const home = mkdtempSync(path.join(tmpdir(), 'cml-operations-cli-help-home-'));
    try {
      const result = spawnSync(tsxCommand, tsxArgs('src/apps/cli/index.ts', '--help'), {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        encoding: 'utf8'
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('facet');
      expect(result.stdout).toContain('action');
      expect(result.stdout).toContain('frontier');
      expect(result.stdout).toContain('checkpoint');
      expect(existsSync(path.join(home, '.claude-code'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
