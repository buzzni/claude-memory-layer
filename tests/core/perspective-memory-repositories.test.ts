import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteAll, sqliteGet } from '../../src/core/sqlite-wrapper.js';
import {
  ActorCardRepository,
  ActorRepository,
  PerspectiveObservationRepository,
  SessionActorRepository
} from '../../src/core/operations/index.js';
import { MemoryEvent } from '../../src/core/types.js';

const tempDirs: string[] = [];

async function createFixture(): Promise<{
  store: SQLiteEventStore;
  actors: ActorRepository;
  sessions: SessionActorRepository;
  cards: ActorCardRepository;
  observations: PerspectiveObservationRepository;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-perspective-memory-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  const db = store.getDatabase();
  return {
    store,
    actors: new ActorRepository(db),
    sessions: new SessionActorRepository(db),
    cards: new ActorCardRepository(db),
    observations: new PerspectiveObservationRepository(db),
    cleanup: async () => store.close()
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Perspective memory schema tables', () => {
  it('creates actor, session actor, card, and observation tables with lookup indexes', async () => {
    const { store, cleanup } = await createFixture();
    const db = store.getDatabase();

    const actorColumns = sqliteAll<{ name: string }>(db, `PRAGMA table_info(memory_actors)`).map((row) => row.name);
    const sessionColumns = sqliteAll<{ name: string }>(db, `PRAGMA table_info(session_actors)`).map((row) => row.name);
    const cardColumns = sqliteAll<{ name: string }>(db, `PRAGMA table_info(actor_cards)`).map((row) => row.name);
    const observationColumns = sqliteAll<{ name: string }>(db, `PRAGMA table_info(perspective_observations)`).map((row) => row.name);
    const indexes = [
      ...sqliteAll<{ name: string }>(db, `PRAGMA index_list(memory_actors)`).map((row) => row.name),
      ...sqliteAll<{ name: string }>(db, `PRAGMA index_list(session_actors)`).map((row) => row.name),
      ...sqliteAll<{ name: string }>(db, `PRAGMA index_list(actor_cards)`).map((row) => row.name),
      ...sqliteAll<{ name: string }>(db, `PRAGMA index_list(perspective_observations)`).map((row) => row.name)
    ];
    await cleanup();

    expect(actorColumns).toEqual(['actor_id', 'project_hash', 'kind', 'display_name', 'source', 'metadata_json', 'created_at', 'updated_at']);
    expect(sessionColumns).toEqual(['project_hash', 'session_id', 'actor_id', 'role_in_session', 'observe_self', 'observe_others', 'joined_at', 'left_at', 'metadata_json']);
    expect(cardColumns).toEqual(['card_id', 'project_hash', 'observer_actor_id', 'observed_actor_id', 'entries_json', 'source_event_ids_json', 'updated_by', 'created_at', 'updated_at']);
    expect(observationColumns).toEqual(expect.arrayContaining([
      'observation_id', 'project_hash', 'observer_actor_id', 'observed_actor_id', 'session_id',
      'level', 'content', 'confidence', 'source_event_ids_json', 'source_observation_ids_json',
      'created_by', 'metadata_json', 'content_hash', 'source_hash', 'created_at', 'updated_at', 'deleted_at'
    ]));
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_memory_actors_project_kind',
      'idx_session_actors_session',
      'idx_actor_cards_perspective',
      'idx_perspective_observations_perspective_level',
      'idx_perspective_observations_session'
    ]));
  });
});

describe('Perspective memory repositories', () => {
  it('upserts actors idempotently and resolves deterministic actors from events', async () => {
    const { actors, cleanup } = await createFixture();
    const first = await actors.upsert({
      projectHash: 'project-1',
      kind: 'user',
      displayName: ' 전하 ',
      source: 'discord',
      metadata: { platform: 'discord', token: 'dk' }
    });
    const second = await actors.upsert({
      actorId: first.actorId,
      projectHash: 'project-1',
      kind: 'user',
      displayName: '전하 updated',
      source: 'discord'
    });
    const event: MemoryEvent = {
      id: 'event-1',
      eventType: 'tool_observation',
      sessionId: 'session-a',
      timestamp: new Date('2026-05-23T00:00:00.000Z'),
      content: 'tool output',
      canonicalKey: 'canonical:event-1',
      dedupeKey: 'dedupe:event-1',
      metadata: { toolName: 'Read', source: 'claude' }
    };
    const resolved = await actors.resolveFromEvent(event, { projectHash: 'project-1' });
    const listed = await actors.list({ projectHash: 'project-1' });
    await cleanup();

    expect(second.actorId).toBe(first.actorId);
    expect(second.displayName).toBe('전하 updated');
    expect(JSON.stringify(first.metadata)).not.toContain('dk');
    expect(resolved.kind).toBe('tool');
    expect(resolved.displayName).toBe('Read');
    expect(listed.map((actor) => actor.actorId)).toEqual(expect.arrayContaining([first.actorId, resolved.actorId]));
  });

  it('tracks session actor membership and observation policy per project/session', async () => {
    const { sessions, cleanup } = await createFixture();
    await sessions.upsertMembership({
      projectHash: 'project-1',
      sessionId: 'session-a',
      actorId: 'user:default',
      roleInSession: 'speaker'
    });
    await sessions.upsertMembership({
      projectHash: 'project-1',
      sessionId: 'session-a',
      actorId: 'assistant:hermes',
      roleInSession: 'assistant',
      observeOthers: true
    });
    await sessions.setObservationPolicy({
      projectHash: 'project-1',
      sessionId: 'session-a',
      actorId: 'user:default',
      observeSelf: true,
      observeOthers: false
    });
    const members = await sessions.listBySession({ projectHash: 'project-1', sessionId: 'session-a' });
    await cleanup();

    expect(members).toHaveLength(2);
    expect(members.find((member) => member.actorId === 'user:default')?.observeSelf).toBe(true);
    expect(members.find((member) => member.actorId === 'user:default')?.observeOthers).toBe(false);
    expect(members.find((member) => member.actorId === 'assistant:hermes')?.observeOthers).toBe(true);
  });

  it('upserts actor cards with audit rows and project isolation', async () => {
    const { store, cards, cleanup } = await createFixture();
    const card = await cards.upsert({
      projectHash: 'project-1',
      observerActorId: 'assistant:hermes',
      observedActorId: 'user:default',
      entries: [
        'IDENTITY: founder of Buzzni',
        'INSTRUCTION: prefers autonomous Continue execution'
      ],
      sourceEventIds: ['event-1'],
      updatedBy: 'tester'
    });
    await cards.upsert({
      projectHash: 'project-2',
      observerActorId: 'assistant:hermes',
      observedActorId: 'user:default',
      entries: ['IDENTITY: other project only'],
      sourceEventIds: ['event-2'],
      updatedBy: 'tester'
    });
    const fetched = await cards.get({
      projectHash: 'project-1',
      observerActorId: 'assistant:hermes',
      observedActorId: 'user:default'
    });
    const auditRows = sqliteAll<Record<string, unknown>>(
      store.getDatabase(),
      `SELECT operation, actor, project_hash, target_type, target_id, after_json FROM memory_governance_audit WHERE target_type = 'actor_card'`
    );
    const cardAuditRow = auditRows.find((row) => row.target_id === card.cardId);
    await cleanup();

    expect(fetched?.cardId).toBe(card.cardId);
    expect(fetched?.entries).toEqual(card.entries);
    expect(fetched?.entries.join('\n')).not.toContain('other project');
    expect(auditRows).toHaveLength(2);
    expect(cardAuditRow?.operation).toBe('actor_card_upsert');
    expect(cardAuditRow?.actor).toBe('tester');
    expect(JSON.parse(String(cardAuditRow?.after_json)).entries).toEqual(card.entries);
  });

  it('creates, queries, orders, and soft-deletes perspective observations without cross-project leakage', async () => {
    const { store, observations, cleanup } = await createFixture();
    const explicit = await observations.create({
      projectHash: 'project-1',
      observerActorId: 'assistant:hermes',
      observedActorId: 'user:default',
      sessionId: 'session-a',
      level: 'explicit',
      content: 'User prefers TDD before implementation',
      confidence: 0.8,
      sourceEventIds: ['event-1'],
      createdBy: 'manual',
      actor: 'tester'
    });
    const contradiction = await observations.create({
      projectHash: 'project-1',
      observerActorId: 'assistant:hermes',
      observedActorId: 'user:default',
      sessionId: 'session-a',
      level: 'contradiction',
      content: 'Conflicting preference about auto-commit behavior',
      confidence: 0.9,
      sourceEventIds: ['event-2'],
      sourceObservationIds: [explicit.observationId],
      createdBy: 'manual',
      actor: 'tester'
    });
    await observations.create({
      projectHash: 'project-2',
      observerActorId: 'assistant:hermes',
      observedActorId: 'user:default',
      level: 'explicit',
      content: 'Other project secret should not leak',
      confidence: 1,
      sourceEventIds: ['event-other'],
      createdBy: 'manual',
      actor: 'tester'
    });

    const perspective = await observations.query({
      projectHash: 'project-1',
      observerActorId: 'assistant:hermes',
      observedActorId: 'user:default',
      query: 'preference conflicting',
      limit: 10
    });
    const bySource = await observations.listBySourceEvent({ projectHash: 'project-1', sourceEventId: 'event-1' });
    const deleted = await observations.deleteSoft({
      projectHash: 'project-1',
      observationId: explicit.observationId,
      actor: 'tester'
    });
    const afterDelete = await observations.query({
      projectHash: 'project-1',
      observerActorId: 'assistant:hermes',
      observedActorId: 'user:default',
      includeDeleted: false,
      limit: 10
    });
    const auditDelete = sqliteGet<Record<string, unknown>>(
      store.getDatabase(),
      `SELECT operation, actor, target_type, target_id FROM memory_governance_audit WHERE operation = 'perspective_observation_delete'`
    );
    await cleanup();

    expect(perspective.map((item) => item.observationId)).toEqual([contradiction.observationId, explicit.observationId]);
    expect(perspective.map((item) => item.content).join('\n')).not.toContain('Other project secret');
    expect(bySource.map((item) => item.observationId)).toEqual([explicit.observationId]);
    expect(deleted.deletedAt).toBeDefined();
    expect(afterDelete.map((item) => item.observationId)).toEqual([contradiction.observationId]);
    expect(auditDelete?.actor).toBe('tester');
  });

  it('sanitizes persisted perspective observations and matches literal source ids with LIKE wildcard characters', async () => {
    const { observations, cleanup } = await createFixture();
    const wildcardSourceId = 'event_%_1';
    const saved = await observations.create({
      projectHash: 'project-1',
      observerActorId: 'assistant:hermes',
      observedActorId: 'user:default',
      level: 'explicit',
      content: 'User pasted token=dk and path /Users/example/private',
      confidence: 0.7,
      sourceEventIds: [wildcardSourceId],
      createdBy: 'manual',
      actor: 'tester',
      metadata: {
        token: 'dk',
        nested: { localPath: '/Users/example/private' }
      }
    });
    const bySource = await observations.listBySourceEvent({ projectHash: 'project-1', sourceEventId: wildcardSourceId });
    await cleanup();

    const serialized = JSON.stringify(saved);
    expect(serialized).not.toContain('token=dk');
    expect(serialized).not.toContain('/Users/example/private');
    expect(serialized).toContain('[REDACTED]');
    expect(bySource.map((item) => item.observationId)).toEqual([saved.observationId]);
  });

  it('matches source event ids exactly before applying limits, including JSON-escaped ids', async () => {
    const { observations, cleanup } = await createFixture();
    await observations.create({
      projectHash: 'project-1',
      observerActorId: 'assistant:hermes',
      observedActorId: 'user:default',
      level: 'explicit',
      content: 'Prefix collision source event',
      confidence: 1,
      sourceEventIds: ['event-10'],
      createdBy: 'manual',
      actor: 'tester'
    });
    const exact = await observations.create({
      projectHash: 'project-1',
      observerActorId: 'assistant:hermes',
      observedActorId: 'user:default',
      level: 'explicit',
      content: 'Exact source event',
      confidence: 0.1,
      sourceEventIds: ['event-1'],
      createdBy: 'manual',
      actor: 'tester'
    });
    const escapedSourceId = 'event-"quoted"\\id';
    const escaped = await observations.create({
      projectHash: 'project-1',
      observerActorId: 'assistant:hermes',
      observedActorId: 'user:default',
      level: 'explicit',
      content: 'JSON escaped source event',
      confidence: 0.9,
      sourceEventIds: [escapedSourceId],
      createdBy: 'manual',
      actor: 'tester'
    });

    const exactLimited = await observations.listBySourceEvent({ projectHash: 'project-1', sourceEventId: 'event-1', limit: 1 });
    const escapedMatches = await observations.listBySourceEvent({ projectHash: 'project-1', sourceEventId: escapedSourceId });
    await cleanup();

    expect(exactLimited.map((item) => item.observationId)).toEqual([exact.observationId]);
    expect(escapedMatches.map((item) => item.observationId)).toEqual([escaped.observationId]);
  });
});
