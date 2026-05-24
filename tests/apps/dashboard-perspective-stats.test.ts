import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { hashProjectPath } from '../../src/core/registry/project-path.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import {
  ActorCardRepository,
  ActorRepository,
  PerspectiveObservationRepository,
  SessionActorRepository
} from '../../src/core/operations/index.js';
import { statsRouter } from '../../src/server/api/stats.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

interface PerspectiveStatsFixture {
  home: string;
  projectDir: string;
  projectHash: string;
  storagePath: string;
  dbPath: string;
  previousHome: string | undefined;
}

const REQUIRED_PERSPECTIVE_TABLES = [
  'memory_actors',
  'session_actors',
  'actor_cards',
  'perspective_observations'
];

function createApp() {
  const app = new Hono();
  app.route('/api/stats', statsRouter);
  return app;
}

function createFixture(name: string): PerspectiveStatsFixture {
  const previousHome = process.env.HOME;
  const home = mkdtempSync(path.join(tmpdir(), `cml-dashboard-perspective-${name}-`));
  process.env.HOME = home;
  const projectDir = `/opt/cml-dashboard-perspective-${name}-project`;
  const projectHash = hashProjectPath(projectDir);
  const storagePath = path.join(home, '.claude-code', 'memory', 'projects', projectHash);
  const dbPath = path.join(storagePath, 'events.sqlite');
  mkdirSync(storagePath, { recursive: true });
  return { home, projectDir, projectHash, storagePath, dbPath, previousHome };
}

function cleanupFixture(fixture: PerspectiveStatsFixture | null): void {
  if (!fixture) return;
  if (fixture.previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = fixture.previousHome;
  rmSync(fixture.home, { recursive: true, force: true });
}

async function seedPerspectiveRows(fixture: PerspectiveStatsFixture): Promise<void> {
  const store = new SQLiteEventStore(fixture.dbPath, { markdownMirrorRoot: fixture.storagePath });
  await store.initialize();
  const db = store.getDatabase();
  const actors = new ActorRepository(db);
  const sessions = new SessionActorRepository(db);
  const cards = new ActorCardRepository(db);
  const observations = new PerspectiveObservationRepository(db);
  const otherProjectHash = 'deadbeef';

  try {
    await actors.upsert({
      actorId: 'actor:user:founder',
      projectHash: fixture.projectHash,
      kind: 'user',
      displayName: 'PRIVATE_DISPLAY_SENTINEL',
      source: 'discord',
      metadata: { note: 'PRIVATE_METADATA_SENTINEL' }
    });
    await actors.upsert({
      actorId: 'actor:assistant:hermes',
      projectHash: fixture.projectHash,
      kind: 'assistant',
      displayName: 'Hermes',
      source: 'hermes'
    });
    await actors.upsert({
      actorId: 'actor:subagent:reviewer',
      projectHash: fixture.projectHash,
      kind: 'subagent',
      displayName: 'Reviewer',
      source: 'delegate_task'
    });
    await actors.upsert({
      actorId: 'actor:user:other-project',
      projectHash: otherProjectHash,
      kind: 'user',
      displayName: 'Other Project User',
      source: 'discord'
    });

    await sessions.upsertMembership({
      projectHash: fixture.projectHash,
      sessionId: 'session-alpha',
      actorId: 'actor:user:founder',
      roleInSession: 'speaker',
      observeSelf: true,
      observeOthers: false,
      metadata: { raw: 'PRIVATE_SESSION_METADATA_SENTINEL' }
    });
    await sessions.upsertMembership({
      projectHash: fixture.projectHash,
      sessionId: 'session-alpha',
      actorId: 'actor:assistant:hermes',
      roleInSession: 'assistant',
      observeSelf: true,
      observeOthers: true
    });
    await sessions.upsertMembership({
      projectHash: fixture.projectHash,
      sessionId: 'session-alpha',
      actorId: 'actor:subagent:reviewer',
      roleInSession: 'observer',
      observeSelf: false,
      observeOthers: true
    });
    await sessions.upsertMembership({
      projectHash: otherProjectHash,
      sessionId: 'session-other',
      actorId: 'actor:user:other-project',
      roleInSession: 'speaker'
    });

    await cards.upsert({
      projectHash: fixture.projectHash,
      observerActorId: 'actor:assistant:hermes',
      observedActorId: 'actor:user:founder',
      entries: [
        'IDENTITY: founder and primary user',
        'INSTRUCTION: prefers TDD and autonomous Continue execution'
      ],
      sourceEventIds: ['event-alpha-private-sentinel'],
      updatedBy: 'actor:assistant:hermes'
    });
    await cards.upsert({
      projectHash: otherProjectHash,
      observerActorId: 'actor:assistant:hermes',
      observedActorId: 'actor:user:other-project',
      entries: ['ATTRIBUTE: other project only'],
      sourceEventIds: ['event-other-private-sentinel'],
      updatedBy: 'actor:assistant:hermes'
    });

    const explicit = await observations.create({
      projectHash: fixture.projectHash,
      observerActorId: 'actor:assistant:hermes',
      observedActorId: 'actor:user:founder',
      sessionId: 'session-alpha',
      level: 'explicit',
      content: 'PRIVATE_OBSERVATION_CONTENT_SENTINEL user asked for TDD.',
      confidence: 0.93,
      sourceEventIds: ['event-alpha-private-sentinel'],
      createdBy: 'manual',
      actor: 'actor:assistant:hermes'
    });
    await observations.create({
      projectHash: fixture.projectHash,
      observerActorId: 'actor:assistant:hermes',
      observedActorId: 'actor:user:founder',
      sessionId: 'session-alpha',
      level: 'deductive',
      content: 'PRIVATE_DEDUCTIVE_CONTENT_SENTINEL',
      confidence: 0.81,
      sourceObservationIds: [explicit.observationId],
      createdBy: 'rule',
      actor: 'actor:assistant:hermes'
    });
    await observations.create({
      projectHash: fixture.projectHash,
      observerActorId: 'actor:assistant:hermes',
      observedActorId: 'actor:user:founder',
      sessionId: 'session-alpha',
      level: 'inductive',
      content: 'PRIVATE_INDUCTIVE_CONTENT_SENTINEL',
      confidence: 0.74,
      sourceEventIds: ['event-alpha-private-sentinel-2'],
      createdBy: 'llm',
      actor: 'actor:assistant:hermes'
    });
    await observations.create({
      projectHash: fixture.projectHash,
      observerActorId: 'actor:assistant:hermes',
      observedActorId: 'actor:user:founder',
      sessionId: 'session-alpha',
      level: 'contradiction',
      content: 'PRIVATE_CONTRADICTION_CONTENT_SENTINEL',
      confidence: 0.88,
      sourceEventIds: ['event-alpha-private-sentinel-3'],
      sourceObservationIds: [explicit.observationId],
      createdBy: 'rule',
      actor: 'actor:assistant:hermes'
    });
    await observations.create({
      projectHash: otherProjectHash,
      observerActorId: 'actor:assistant:hermes',
      observedActorId: 'actor:user:other-project',
      sessionId: 'session-other',
      level: 'explicit',
      content: 'OTHER_PROJECT_PRIVATE_CONTENT_SENTINEL',
      confidence: 0.9,
      sourceEventIds: ['event-other-private-sentinel'],
      createdBy: 'manual',
      actor: 'actor:assistant:hermes'
    });
  } finally {
    await store.close();
  }
}

function createEmptyLegacyDatabase(fixture: PerspectiveStatsFixture): void {
  const db = new Database(fixture.dbPath);
  try {
    db.prepare('CREATE TABLE legacy_only (id TEXT PRIMARY KEY)').run();
  } finally {
    db.close();
  }
}

describe('dashboard perspective stats API', () => {
  let fixture: PerspectiveStatsFixture | null = null;

  afterEach(() => {
    vi.useRealTimers();
    cleanupFixture(fixture);
    fixture = null;
  });

  it('returns aggregate-only perspective memory stats and contradiction queue items', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T12:00:00.000Z'));
    fixture = createFixture('aggregate');
    await seedPerspectiveRows(fixture);

    const res = await createApp().request(`/api/stats/perspective?project=${encodeURIComponent(fixture.projectDir)}&windowDays=30&contradictionLimit=5`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.generatedAt).toBe('2026-05-21T12:00:00.000Z');
    expect(body.windowDays).toBe(30);
    expect(body.projectHash).toBe(fixture.projectHash);
    expect(body.projection).toEqual({
      databaseExists: true,
      available: true,
      missingTables: []
    });

    expect(body.actors).toEqual({
      total: 3,
      byKind: [
        { kind: 'assistant', count: 1 },
        { kind: 'subagent', count: 1 },
        { kind: 'user', count: 1 }
      ]
    });
    expect(body.sessionActors).toEqual({
      total: 3,
      observeSelfEnabled: 2,
      observeOthersEnabled: 2,
      byRole: [
        { role: 'assistant', count: 1 },
        { role: 'observer', count: 1 },
        { role: 'speaker', count: 1 }
      ]
    });
    expect(body.actorCards).toEqual({
      total: 1,
      totalEntries: 2,
      averageEntries: 2,
      fullCards: 0
    });
    expect(body.observations.total).toBe(4);
    expect(body.observations.byLevel).toEqual([
      { level: 'contradiction', count: 1 },
      { level: 'deductive', count: 1 },
      { level: 'explicit', count: 1 },
      { level: 'inductive', count: 1 }
    ]);
    expect(body.observations.byCreatedBy).toEqual([
      { createdBy: 'rule', count: 2 },
      { createdBy: 'llm', count: 1 },
      { createdBy: 'manual', count: 1 }
    ]);
    expect(body.contradictions.summary).toEqual({ total: 1, returnedItems: 1 });
    expect(body.contradictions.items).toEqual([
      expect.objectContaining({
        observationId: expect.any(String),
        observerActorId: 'actor:assistant:hermes',
        observedActorId: 'actor:user:founder',
        confidence: 0.88,
        sourceEventCount: 1,
        sourceObservationCount: 1
      })
    ]);
    expect(body.recentActivity.byDay).toEqual([
      {
        date: '2026-05-21',
        total: 4,
        levels: [
          { level: 'contradiction', count: 1 },
          { level: 'deductive', count: 1 },
          { level: 'explicit', count: 1 },
          { level: 'inductive', count: 1 }
        ]
      }
    ]);

    const json = JSON.stringify(body);
    expect(json).not.toContain(fixture.projectDir);
    expect(json).not.toContain('PRIVATE_DISPLAY_SENTINEL');
    expect(json).not.toContain('PRIVATE_METADATA_SENTINEL');
    expect(json).not.toContain('PRIVATE_SESSION_METADATA_SENTINEL');
    expect(json).not.toContain('PRIVATE_OBSERVATION_CONTENT_SENTINEL');
    expect(json).not.toContain('PRIVATE_DEDUCTIVE_CONTENT_SENTINEL');
    expect(json).not.toContain('PRIVATE_INDUCTIVE_CONTENT_SENTINEL');
    expect(json).not.toContain('PRIVATE_CONTRADICTION_CONTENT_SENTINEL');
    expect(json).not.toContain('OTHER_PROJECT_PRIVATE_CONTENT_SENTINEL');
    expect(json).not.toContain('event-alpha-private-sentinel');
    expect(json).not.toContain('event-other-private-sentinel');
    expect(json).not.toContain('founder and primary user');
    expect(json).not.toContain('autonomous Continue execution');
  });

  it('returns empty read-only aggregates when the perspective database is missing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T12:00:00.000Z'));
    fixture = createFixture('missing-db');
    rmSync(fixture.storagePath, { recursive: true, force: true });

    const res = await createApp().request(`/api/stats/perspective?project=${encodeURIComponent(fixture.projectDir)}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projection).toEqual({
      databaseExists: false,
      available: false,
      missingTables: REQUIRED_PERSPECTIVE_TABLES
    });
    expect(body.actors.total).toBe(0);
    expect(body.actorCards.totalEntries).toBe(0);
    expect(body.contradictions.items).toEqual([]);
  });

  it('does not initialize schemas for a legacy database missing perspective tables', async () => {
    fixture = createFixture('legacy');
    createEmptyLegacyDatabase(fixture);

    const res = await createApp().request(`/api/stats/perspective?project=${encodeURIComponent(fixture.projectDir)}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projection.databaseExists).toBe(true);
    expect(body.projection.available).toBe(false);
    expect(body.projection.missingTables).toEqual(REQUIRED_PERSPECTIVE_TABLES);

    const db = new Database(fixture.dbPath, { readonly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual(['legacy_only']);
    } finally {
      db.close();
    }
  });
});
