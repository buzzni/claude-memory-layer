import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cml-aggregates-'));
  tempDirs.push(dir);
  return join(dir, 'events.sqlite');
}

async function seed(store: SQLiteEventStore): Promise<void> {
  const day1 = new Date('2026-06-01T10:00:00.000Z');
  const day2 = new Date('2026-06-02T10:00:00.000Z');
  await store.append({ eventType: 'user_prompt', sessionId: 's1', timestamp: day1, content: 'prompt one' });
  await store.append({ eventType: 'agent_response', sessionId: 's1', timestamp: day1, content: 'response one' });
  await store.append({ eventType: 'user_prompt', sessionId: 's2', timestamp: day2, content: 'prompt two' });
  await store.append({ eventType: 'tool_observation', sessionId: 's2', timestamp: day2, content: 'tool two' });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('SQLiteEventStore SQL aggregates', () => {
  it('counts events by type', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    await seed(store);

    const counts = Object.fromEntries((await store.getEventTypeCounts()).map((c) => [c.eventType, c.count]));
    expect(counts).toMatchObject({ user_prompt: 2, agent_response: 1, tool_observation: 1 });

    await store.close();
  });

  it('counts distinct sessions', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    await seed(store);

    expect(await store.getDistinctSessionCount()).toBe(2);

    await store.close();
  });

  it('fetches events at/after a cutoff in ascending order, uncapped', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    await seed(store);

    // seed() spans 2026-06-01 (2 events) and 2026-06-02 (2 events).
    const all = await store.getEventsAfter('2026-06-01T00:00:00.000Z');
    expect(all).toHaveLength(4);
    // Ascending by timestamp.
    expect(all[0].timestamp.getTime()).toBeLessThanOrEqual(all[3].timestamp.getTime());

    // A later cutoff excludes the earlier day's events.
    const fromDay2 = await store.getEventsAfter('2026-06-02T00:00:00.000Z');
    expect(fromDay2).toHaveLength(2);
    expect(fromDay2.every((e) => e.timestamp.toISOString() >= '2026-06-02')).toBe(true);

    await store.close();
  });

  it('groups daily counts with a type breakdown and honours the cutoff', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    await seed(store);

    expect(await store.getDailyEventCounts('2026-06-01T00:00:00.000Z')).toEqual([
      { day: '2026-06-01', total: 2, prompts: 1, responses: 1, tools: 0 },
      { day: '2026-06-02', total: 2, prompts: 1, responses: 0, tools: 1 }
    ]);

    // A later cutoff excludes the first day.
    const fromDay2 = await store.getDailyEventCounts('2026-06-02T00:00:00.000Z');
    expect(fromDay2.map((d) => d.day)).toEqual(['2026-06-02']);

    await store.close();
  });

  it('returns safe aggregate graduation liveness without retaining raw failure text', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    await store.recordGraduationRun({
      startedAt: new Date('2026-07-14T00:00:00.000Z'),
      finishedAt: new Date('2026-07-14T00:00:01.000Z'),
      status: 'failed',
      evaluated: 4,
      graduated: 0
    });

    expect(await store.getDerivationLiveness()).toEqual({
      graduation: {
        attempts: 1,
        lastAttemptAt: '2026-07-14T00:00:01.000Z',
        lastSuccessAt: null,
        lastStatus: 'failed',
        lastErrorCategory: 'graduation_failed'
      },
      sources: { graduatedEvents: 0, curatedLessons: 0 }
    });

    await store.close();
  });

  it('excludes quarantined graduated events from Brief source readiness', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const appended = await store.append({
      eventType: 'user_prompt',
      sessionId: 's1',
      timestamp: new Date(),
      content: 'quarantined memory',
      metadata: { quarantine: { status: 'active' } }
    });
    await store.updateMemoryLevel(appended.eventId!, 'L1');

    expect((await store.getDerivationLiveness()).sources.graduatedEvents).toBe(0);
    await store.close();
  });

  it('limits curated source readiness to the requested project hash', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const db = store.getDatabase();
    db.prepare(`INSERT INTO memory_lessons (
      lesson_id, project_hash, name, trigger, steps_json, confidence,
      source_session_ids, source_event_ids, failure_modes_json, skill_candidate,
      source_class, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('lesson-other-project', 'other-project', 'other', 'other', '[]', 1, '[]', '[]', '[]', 0, 'curated', '2026-01-01', '2026-01-01');

    expect((await store.getDerivationLiveness('current-project')).sources.curatedLessons).toBe(0);
    expect((await store.getDerivationLiveness('other-project')).sources.curatedLessons).toBe(1);
    await store.close();
  });

  it('prioritizes accessed graduation candidates over newer unused events', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const old = await store.append({
      eventType: 'agent_response',
      sessionId: 'old-session',
      timestamp: new Date('2025-01-01T00:00:00.000Z'),
      content: 'old but useful answer'
    });
    await store.append({
      eventType: 'agent_response',
      sessionId: 'new-session',
      timestamp: new Date('2026-07-14T00:00:00.000Z'),
      content: 'new but unused answer'
    });
    await store.incrementAccessCount([old.eventId!]);

    const candidates = await store.getGraduationCandidates('L0', { limit: 10 });
    expect(candidates.map((event) => event.id)).toEqual([old.eventId]);
    await store.close();
  });

  it('hydrates distinct retrieval sessions as durable cross-session evidence', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const appended = await store.append({
      eventType: 'session_summary',
      sessionId: 'source-session',
      timestamp: new Date(),
      content: 'reused deployment rule'
    });
    await store.incrementAccessCount([appended.eventId!]);
    await store.recordRetrieval(appended.eventId!, 'consumer-a', 0.9, 'deployment rule');
    await store.recordRetrieval(appended.eventId!, 'consumer-b', 0.9, 'deployment rule');

    expect(await store.getGraduationMetrics([appended.eventId!])).toEqual([
      expect.objectContaining({
        eventId: appended.eventId,
        accessCount: 1,
        crossSessionRefs: 1,
        confidence: 1
      })
    ]);
    await store.close();
  });

  it('searches only answer-capable L1+ events in the graduated evidence lane', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const answer = await store.append({
      eventType: 'agent_response', sessionId: 'answer-session', timestamp: new Date(),
      content: 'ssgshop benimaru v1 CrashLoopBackOff timestamp mismatch resolution'
    });
    const prompt = await store.append({
      eventType: 'user_prompt', sessionId: 'prompt-session', timestamp: new Date(),
      content: 'ssgshop benimaru v1 CrashLoopBackOff 원인을 알려줘'
    });
    const tool = await store.append({
      eventType: 'tool_observation', sessionId: 'tool-session', timestamp: new Date(),
      content: 'ssgshop benimaru v1 CrashLoopBackOff kubectl output'
    });
    await store.updateMemoryLevel(answer.eventId!, 'L2');
    await store.updateMemoryLevel(prompt.eventId!, 'L2');
    await store.updateMemoryLevel(tool.eventId!, 'L2');
    await store.incrementAccessCount([answer.eventId!]);

    const results = await store.searchGraduatedEvidence('ssgshop benimaru v1 CrashLoopBackOff', 10);
    expect(results).toHaveLength(2);
    expect(results.find((result) => result.event.id === answer.eventId)).toMatchObject({
      level: 'L2', accessCount: 1,
      event: { id: answer.eventId, eventType: 'agent_response' }
    });
    expect(results.some((result) => result.event.id === prompt.eventId)).toBe(true);
    expect(results.some((result) => result.event.id === tool.eventId)).toBe(false);
    await store.close();
  });
});
