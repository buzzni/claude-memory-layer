import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { MemoryIngestService } from '../../src/core/engine/memory-ingest-service.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

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

describe('SQLiteEventStore.markEventsSuperseded', () => {
  it('hides the events from by-id, recent and session reads, but never the replacing event', async () => {
    const store = new SQLiteEventStore(tempDbPath());
    await store.initialize();
    const old = await store.append({ eventType: 'session_summary', sessionId: 's', timestamp: new Date(), content: '- old', metadata: { generated: 'llm' } });
    const next = await store.append({ eventType: 'session_summary', sessionId: 's', timestamp: new Date(), content: '- new' });

    await expect(store.markEventsSuperseded([old.eventId!, next.eventId!], next.eventId!)).resolves.toBe(1);

    expect(await store.getEvent(old.eventId!)).toBeNull();
    expect((await store.getEvents([old.eventId!, next.eventId!])).map((e) => e.id)).toEqual([next.eventId]);
    expect((await store.getRecentEvents(10)).map((e) => e.id)).toEqual([next.eventId]);
    const hidden = await store.getEvent(old.eventId!, { includeQuarantined: true });
    expect(hidden?.metadata).toMatchObject({
      generated: 'llm',
      quarantine: { status: 'active', category: 'superseded', supersededBy: next.eventId }
    });

    // Idempotent: an already-hidden event is not rewritten.
    await expect(store.markEventsSuperseded([old.eventId!], 'another')).resolves.toBe(0);

    await store.close();
  });
});
