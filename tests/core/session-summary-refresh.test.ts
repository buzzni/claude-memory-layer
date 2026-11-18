import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  DEFAULT_SESSION_SUMMARY_REFRESH,
  MemoryIngestService
} from '../../src/core/engine/memory-ingest-service.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { sqliteAll } from '../../src/core/sqlite-wrapper.js';

const MIN_NEW = DEFAULT_SESSION_SUMMARY_REFRESH.minNewExchanges;

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cml-summary-refresh-'));
  tempDirs.push(dir);
  return join(dir, 'events.sqlite');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Issue #221: the first turn's summary used to be the only one a session ever
// got. Runs against a real store so "superseded" is proven on the read paths
// retrieval uses, not on a mock.
describe('LLM session summary refresh on a real store', () => {
  async function setup(summaries: string[]) {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const generator = vi.fn(async (_events: Array<{ eventType: string; content: string }>) => ({
      text: summaries.shift() ?? '- 결정: 더 없음',
      metadata: { generated: 'llm' }
    }));
    const service = new MemoryIngestService({
      initialize: async () => {},
      eventStore: store,
      markdownMirror: { append: async () => {} },
      createToolEmbedding: () => '',
      llmSummaryGenerator: generator
    });
    let tick = Date.parse('2026-11-17T00:00:00.000Z');
    const exchange = async (prompt: string, answer: string) => {
      await store.append({ eventType: 'user_prompt', sessionId: 's', timestamp: new Date(tick++), content: prompt });
      await store.append({ eventType: 'agent_response', sessionId: 's', timestamp: new Date(tick++), content: answer });
    };
    return { store, service, generator, exchange };
  }

  it('replaces the first-exchange summary once the session has grown, so retrieval returns only the new one', async () => {
    const { store, service, generator, exchange } = await setup([
      '- 결정: firstturnneedle 설정 추가',
      '- 실패: laterturnneedle 캐시가 원인'
    ]);

    await exchange('자동 업데이트가 왜 안 보이지', 'publish 설정 누락이 원인');
    await store.append({ eventType: 'tool_observation', sessionId: 's', timestamp: new Date(), content: '{}' });
    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(true);

    for (let i = 0; i < 5; i++) {
      await exchange(`후속 질문 ${i}`, `후속 답변 ${i}`);
    }
    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(true);
    expect(generator).toHaveBeenCalledTimes(2);
    expect(generator.mock.calls[1][0]).toContainEqual({ eventType: 'session_summary', content: '- 결정: firstturnneedle 설정 추가' });

    const summaries = (await store.getSessionEvents('s')).filter((e) => e.eventType === 'session_summary');
    expect(summaries.map((e) => e.content)).toEqual(['- 실패: laterturnneedle 캐시가 원인']);
    expect(await store.keywordSearch('firstturnneedle')).toHaveLength(0);
    expect(await store.keywordSearch('laterturnneedle')).toHaveLength(1);
    const recentSummaries = await store.getRecentEvents(10, { eventTypes: ['session_summary'] });
    expect(recentSummaries.map((e) => e.content)).toEqual(['- 실패: laterturnneedle 캐시가 원인']);

    await store.close();
  });

  it('does not call the provider again until enough new conversation has accumulated', async () => {
    const { store, service, generator, exchange } = await setup(['- 결정: 첫 요약']);

    await exchange('질문', '답변');
    await store.append({ eventType: 'tool_observation', sessionId: 's', timestamp: new Date(), content: '{}' });
    await service.generateLlmSessionSummary('s');

    for (let i = 0; i < 4; i++) {
      await exchange(`후속 질문 ${i}`, `후속 답변 ${i}`);
      await expect(service.generateLlmSessionSummary('s')).resolves.toBe(false);
    }
    expect(generator).toHaveBeenCalledTimes(1);

    await store.close();
  });

  it('does not ask again every turn when a refresh repeats the current summary', async () => {
    const { store, service, generator, exchange } = await setup(['- 결정: 같은 요약', '- 결정: 같은 요약']);

    await exchange('질문', '답변');
    await store.append({ eventType: 'tool_observation', sessionId: 's', timestamp: new Date(), content: '{}' });
    await service.generateLlmSessionSummary('s');
    for (let i = 0; i < 5; i++) await exchange(`후속 질문 ${i}`, `후속 답변 ${i}`);
    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(true);
    expect(generator).toHaveBeenCalledTimes(2);

    await exchange('한 번 더', '한 번 더 답변');
    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(false);
    expect(generator).toHaveBeenCalledTimes(2);
    const summaries = (await store.getSessionEvents('s')).filter((e) => e.eventType === 'session_summary');
    expect(summaries.map((e) => e.content)).toEqual(['- 결정: 같은 요약']);

    await store.close();
  });
});

describe('SQLiteEventStore.append replacing earlier events', () => {
  const replaces = (eventIds: string[]) => ({ replaces: { eventIds, metadataOnDuplicate: {} } });

  it('hides them from by-id, recent and session reads in the same transaction, never the new event', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const old = await store.append({ eventType: 'session_summary', sessionId: 's', timestamp: new Date(), content: '- old', metadata: { generated: 'llm' } });
    const next = await store.append(
      { eventType: 'session_summary', sessionId: 's', timestamp: new Date(), content: '- new' },
      replaces([old.eventId!])
    );

    expect(await store.getEvent(old.eventId!)).toBeNull();
    expect((await store.getEvents([old.eventId!, next.eventId!])).map((e) => e.id)).toEqual([next.eventId]);
    expect((await store.getRecentEvents(10)).map((e) => e.id)).toEqual([next.eventId]);
    const hidden = await store.getEvent(old.eventId!, { includeQuarantined: true });
    expect(hidden?.metadata).toMatchObject({
      generated: 'llm',
      quarantine: { status: 'active', category: 'superseded', supersededBy: next.eventId }
    });

    // One audit row for the one change, without the event's text (#228).
    const audit = sqliteAll<{ operation: string; target_id: string; after_json: string; source_event_ids: string }>(
      store.getDatabase(),
      `SELECT operation, target_id, after_json, source_event_ids FROM memory_governance_audit`
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ operation: 'quarantine', target_id: old.eventId });
    expect(JSON.parse(audit[0].source_event_ids)).toEqual([next.eventId]);
    expect(JSON.parse(audit[0].after_json)).toMatchObject({
      eventType: 'session_summary',
      quarantine: { status: 'active', category: 'superseded', supersededBy: next.eventId }
    });
    expect(audit[0].after_json).not.toContain('- old');

    await store.close();
  });

  it('stores nothing and hides nothing when hiding fails', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const old = await store.append({ eventType: 'session_summary', sessionId: 's', timestamp: new Date(), content: '- old' });
    failSuperseding(store);

    const result = await store.append(
      { eventType: 'session_summary', sessionId: 's', timestamp: new Date(), content: '- new' },
      replaces([old.eventId!])
    );

    expect(result.success).toBe(false);
    expect((await store.getSessionEvents('s')).map((e) => e.content)).toEqual(['- old']);
    expect(await store.getSessionEvents('s', { includeQuarantined: true })).toHaveLength(1);

    await store.close();
  });

  it('keeps an event hidden for another reason hidden when the new content repeats it', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const secret = await store.append({
      eventType: 'session_summary',
      sessionId: 's',
      timestamp: new Date(1),
      content: '- 같은 문구',
      metadata: { quarantine: { status: 'active', category: 'privacy' } }
    });
    const current = await store.append({ eventType: 'session_summary', sessionId: 's', timestamp: new Date(2), content: '- 지금 요약' });

    const result = await store.append(
      { eventType: 'session_summary', sessionId: 's', timestamp: new Date(3), content: '- 같은 문구' },
      { replaces: { eventIds: [current.eventId!], metadataOnDuplicate: { summarizedExchangeCount: 9 } } }
    );

    expect(result).toMatchObject({ success: true, eventId: secret.eventId, isDuplicate: true });
    const visible = await store.getSessionEvents('s');
    expect(visible.map((e) => e.id)).toEqual([current.eventId]);
    expect(visible[0].metadata).toMatchObject({ summarizedExchangeCount: 9 });

    await store.close();
  });
});

/** Every update that would hide an event as superseded fails, as a busy or full disk would. */
function failSuperseding(store: SQLiteEventStore): void {
  store.getDatabase().exec(`
    CREATE TRIGGER fail_superseding BEFORE UPDATE OF metadata ON events
    WHEN json_extract(NEW.metadata, '$.quarantine.category') = 'superseded'
      AND json_extract(NEW.metadata, '$.quarantine.status') = 'active'
    BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;
  `);
}

function recoverSuperseding(store: SQLiteEventStore): void {
  store.getDatabase().exec('DROP TRIGGER fail_superseding');
}

describe('session summary judgment shared by Stop, the pending retries and the session-start backfill', () => {
  const now = new Date('2026-11-18T00:00:00.000Z');
  const daysAgo = (days: number, offsetMs = 0) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000 + offsetMs);

  async function seed(store: SQLiteEventStore, sessionId: string, options: {
    at: Date;
    exchangesBefore: number;
    exchangesAfter: number;
    summary?: Record<string, unknown> | 'none';
  }) {
    let tick = options.at.getTime();
    const exchange = async (count: number) => {
      for (let i = 0; i < count; i++) {
        await store.append({
          eventType: i % 2 === 0 ? 'user_prompt' : 'agent_response',
          sessionId,
          timestamp: new Date(tick++),
          content: `${sessionId} 대화 ${tick}`
        });
      }
    };
    await exchange(options.exchangesBefore);
    await store.append({ eventType: 'tool_observation', sessionId, timestamp: new Date(tick++), content: '{}' });
    if (options.summary !== 'none') {
      await store.append({
        eventType: 'session_summary',
        sessionId,
        timestamp: new Date(tick++),
        content: `- 결정: ${sessionId} 요약`,
        metadata: options.summary ?? {}
      });
    }
    await exchange(options.exchangesAfter);
  }

  it('picks exactly the sessions whose own summary run would call the provider', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const recent = daysAgo(1);
    await seed(store, 'no-summary', { at: recent, exchangesBefore: 2, exchangesAfter: 0, summary: 'none' });
    await seed(store, 'grown', { at: recent, exchangesBefore: 2, exchangesAfter: MIN_NEW, summary: { summarizedExchangeCount: 2 } });
    await seed(store, 'one-short', { at: recent, exchangesBefore: 2, exchangesAfter: MIN_NEW - 1, summary: { summarizedExchangeCount: 2 } });
    await seed(store, 'capped', {
      at: recent,
      exchangesBefore: 2,
      exchangesAfter: 4 * MIN_NEW,
      summary: { summarizedExchangeCount: 2, summaryRefreshes: DEFAULT_SESSION_SUMMARY_REFRESH.maxRefreshesPerSession }
    });
    await seed(store, 'legacy-grown', { at: recent, exchangesBefore: 2, exchangesAfter: MIN_NEW, summary: { generated: 'llm' } });
    await seed(store, 'covered-by-empty-refresh', {
      at: recent,
      exchangesBefore: 2,
      exchangesAfter: MIN_NEW,
      summary: { summarizedExchangeCount: 2 + MIN_NEW, summaryRefreshes: 1 }
    });
    await seed(store, 'current', { at: recent, exchangesBefore: 2, exchangesAfter: MIN_NEW, summary: { summarizedExchangeCount: 2 } });
    const sessions = ['no-summary', 'grown', 'one-short', 'capped', 'legacy-grown', 'covered-by-empty-refresh'];

    const backfill = new MemoryIngestService({
      initialize: async () => {},
      eventStore: store,
      markdownMirror: { append: async () => {} },
      createToolEmbedding: () => '',
      now: () => now
    });
    const picked = await backfill.getSessionsDueForLlmSummary('current', 10);

    // Stop and the summary-pending retries both end in generateLlmSessionSummary.
    const called: string[] = [];
    for (const sessionId of sessions) {
      const service = new MemoryIngestService({
        initialize: async () => {},
        eventStore: store,
        markdownMirror: { append: async () => {} },
        createToolEmbedding: () => '',
        llmSummaryGenerator: async () => {
          called.push(sessionId);
          return null;
        }
      });
      await service.generateLlmSessionSummary(sessionId);
    }

    expect(picked.sort()).toEqual(['grown', 'legacy-grown', 'no-summary']);
    expect(called.sort()).toEqual(picked);

    await store.close();
  });

  it('leaves refreshes of sessions idle for longer than the window to their next Stop', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    await seed(store, 'idle-grown', { at: daysAgo(8), exchangesBefore: 2, exchangesAfter: MIN_NEW, summary: { summarizedExchangeCount: 2 } });
    await seed(store, 'idle-unsummarized', { at: daysAgo(30), exchangesBefore: 2, exchangesAfter: 0, summary: 'none' });
    const service = new MemoryIngestService({
      initialize: async () => {},
      eventStore: store,
      markdownMirror: { append: async () => {} },
      createToolEmbedding: () => '',
      now: () => now
    });

    // Unsummarized sessions keep having no window, as before refreshes existed.
    await expect(service.getSessionsDueForLlmSummary('current', 5)).resolves.toEqual(['idle-unsummarized']);

    await store.close();
  });

  it('counts only prompt/answer events that are not quarantined, as the summary run does', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    await seed(store, 's', { at: daysAgo(1), exchangesBefore: 2, exchangesAfter: MIN_NEW, summary: { summarizedExchangeCount: 2 } });
    const hiddenMetadata = { quarantine: { status: 'active', category: 'superseded' } };
    // Newer than the visible summary: read it and the coverage would be wrong.
    await store.append({ eventType: 'session_summary', sessionId: 's', timestamp: daysAgo(1, 60_000), content: '- 가려진 요약', metadata: hiddenMetadata });
    const prompt = (await store.getSessionEvents('s')).find((e) => e.eventType === 'user_prompt' && e.content.includes('대화'))!;
    store.getDatabase().prepare('UPDATE events SET metadata = ? WHERE id = ?').run(JSON.stringify(hiddenMetadata), prompt.id);
    await store.append({ eventType: 'user_prompt', sessionId: 's', timestamp: daysAgo(1, 500), content: '   ' });

    const [candidate] = await store.getLlmSummaryCandidates('current', { limit: 5, refreshSince: daysAgo(7) });
    expect(candidate).toMatchObject({
      sessionId: 's',
      summary: { exchangeCount: 1 + MIN_NEW, exchangesBeforeSummary: 1, metadata: { summarizedExchangeCount: 2 } }
    });

    await store.close();
  });
});

describe('a refresh whose replacement fails', () => {
  it('leaves the old summary as the only one, and the session-start backfill picks the session up again', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const now = new Date('2026-11-18T00:00:00.000Z');
    const generator = vi.fn(async () => ({ text: '- 결정: 새 요약', metadata: { generated: 'llm' } }));
    const service = new MemoryIngestService({
      initialize: async () => {},
      eventStore: store,
      markdownMirror: { append: async () => {} },
      createToolEmbedding: () => '',
      llmSummaryGenerator: generator,
      now: () => now
    });
    let tick = Date.parse('2026-11-17T00:00:00.000Z');
    const exchange = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await store.append({ eventType: i % 2 ? 'agent_response' : 'user_prompt', sessionId: 's', timestamp: new Date(tick++), content: `대화 ${tick}` });
      }
    };
    await exchange(2);
    await store.append({ eventType: 'tool_observation', sessionId: 's', timestamp: new Date(tick++), content: '{}' });
    await store.append({ eventType: 'session_summary', sessionId: 's', timestamp: new Date(tick++), content: '- 결정: 첫 요약', metadata: { summarizedExchangeCount: 2 } });
    await exchange(MIN_NEW);
    const summaries = async () => (await store.getSessionEvents('s'))
      .filter((e) => e.eventType === 'session_summary')
      .map((e) => e.content);

    failSuperseding(store);
    await expect(service.generateLlmSessionSummary('s')).rejects.toThrow('disk I/O error');
    expect(await summaries()).toEqual(['- 결정: 첫 요약']);
    recoverSuperseding(store);

    // The session-start backfill, then the daemon run it schedules.
    const due = await service.getSessionsDueForLlmSummary('another-session', 5);
    expect(due).toEqual(['s']);
    for (const sessionId of due) await service.generateLlmSessionSummary(sessionId);

    expect(generator).toHaveBeenCalledTimes(2);
    expect(await summaries()).toEqual(['- 결정: 새 요약']);

    await store.close();
  });
});

describe('a refresh that repeats an earlier summary', () => {
  it('shows that earlier summary again instead of keeping the one in between (A, B, then A)', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const answers = ['- 결정: aneedle 방식', '- 결정: bneedle 방식', '- 결정: aneedle 방식'];
    const generator = vi.fn(async () => ({ text: answers.shift()!, metadata: { generated: 'llm' } }));
    const service = new MemoryIngestService({
      initialize: async () => {},
      eventStore: store,
      markdownMirror: { append: async () => {} },
      createToolEmbedding: () => '',
      llmSummaryGenerator: generator
    });
    let tick = Date.parse('2026-11-17T00:00:00.000Z');
    const exchange = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await store.append({ eventType: i % 2 ? 'agent_response' : 'user_prompt', sessionId: 's', timestamp: new Date(tick++), content: `대화 ${tick}` });
      }
    };
    const visible = async () => (await store.getSessionEvents('s')).filter((e) => e.eventType === 'session_summary');

    await exchange(2);
    await store.append({ eventType: 'tool_observation', sessionId: 's', timestamp: new Date(tick++), content: '{}' });
    await service.generateLlmSessionSummary('s');
    const first = (await visible())[0];
    await exchange(MIN_NEW);
    await service.generateLlmSessionSummary('s');
    expect((await visible()).map((e) => e.content)).toEqual(['- 결정: bneedle 방식']);
    await exchange(MIN_NEW);
    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(true);

    const shown = await visible();
    expect(shown.map((e) => e.id)).toEqual([first.id]);
    expect(shown[0].metadata).toMatchObject({
      summarizedExchangeCount: 2 + 2 * MIN_NEW,
      summaryRefreshes: 2,
      quarantine: { status: 'released' }
    });
    expect(shown[0].metadata?.tags ?? []).not.toContain('quarantine:superseded');
    expect(await store.keywordSearch('bneedle')).toHaveLength(0);
    expect((await store.keywordSearch('aneedle')).map((row) => row.event.id)).toEqual([first.id]);

    // Coverage moved with it: the next turn does not call the provider.
    await exchange(2);
    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(false);
    expect(generator).toHaveBeenCalledTimes(3);

    await store.close();
  });
});
