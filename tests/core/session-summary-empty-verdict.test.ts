import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { MemoryIngestService, type LlmSummaryGenerated } from '../../src/core/engine/memory-ingest-service.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

const tempDirs: string[] = [];
const stores: SQLiteEventStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Issue #206: a session whose first summary came back empty used to be sent
// to the provider again on every session start, and five of them held the
// backfill window ahead of every older session.
describe('empty first summary verdict on a real store', () => {
  const now = new Date('2026-11-21T00:00:00.000Z');
  let tick = now.getTime() - 24 * 60 * 60 * 1000;

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'cml-empty-summary-verdict-'));
    tempDirs.push(dir);
    const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
    stores.push(store);
    await store.initialize();
    const answers: Array<LlmSummaryGenerated | null> = [];
    const generator = vi.fn(async (_events: Array<{ eventType: string; content: string }>) => answers.shift() ?? null);
    const service = new MemoryIngestService({
      initialize: async () => {},
      eventStore: store,
      markdownMirror: { append: async () => {} },
      createToolEmbedding: () => '',
      llmSummaryGenerator: generator,
      now: () => now
    });
    const say = async (sessionId: string, content: string, eventType: 'user_prompt' | 'agent_response' = 'user_prompt') =>
      store.append({ eventType, sessionId, timestamp: new Date(tick++), content });
    const exchange = async (sessionId: string, label: string) => {
      await say(sessionId, `${label} 질문`);
      await say(sessionId, `${label} 답변`, 'agent_response');
    };
    const tool = (sessionId: string) =>
      store.append({ eventType: 'tool_observation', sessionId, timestamp: new Date(tick++), content: `{"n":${tick}}` });
    const due = (limit = 5) => service.getSessionsDueForLlmSummary('current', limit);
    return { store, service, generator, answers, say, exchange, tool, due };
  }

  it('is not sent again by Stop or the backfill until the session gains a prompt or answer', async () => {
    const { service, generator, exchange, tool, due } = await setup();
    await exchange('s', '첫');
    await tool('s');

    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(false);
    expect(generator).toHaveBeenCalledOnce();

    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(false);
    await tool('s');
    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(false);
    expect(generator).toHaveBeenCalledOnce();
    await expect(due()).resolves.toEqual([]);
  });

  it('lets older unsummarized sessions reach the backfill window', async () => {
    const { service, exchange, tool, due } = await setup();
    await exchange('older-failed', '오래된');
    await tool('older-failed');
    await exchange('recent-empty', '최근');
    await tool('recent-empty');
    await expect(due(1)).resolves.toEqual(['recent-empty']);

    await service.generateLlmSessionSummary('recent-empty');

    await expect(due(1)).resolves.toEqual(['older-failed']);
  });

  it('is sent again when the session is resumed, and a summary then replaces the verdict', async () => {
    const { service, generator, answers, store, exchange, say, tool, due } = await setup();
    await exchange('s', '첫');
    await tool('s');
    await service.generateLlmSessionSummary('s');

    await say('s', '이어서: 캐시 키를 바꾸기로 했다');
    await expect(due()).resolves.toEqual(['s']);

    answers.push({ text: '- 결정: 캐시 키 변경', metadata: { generated: 'llm' } });
    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(true);
    expect(generator).toHaveBeenCalledTimes(2);
    const summaries = (await store.getSessionEvents('s')).filter((e) => e.eventType === 'session_summary');
    expect(summaries.map((e) => e.content)).toEqual(['- 결정: 캐시 키 변경']);
  });

  it('is judged again when the resumed session still holds nothing durable, and then holds again', async () => {
    const { service, generator, exchange, tool, due } = await setup();
    await exchange('s', '첫');
    await tool('s');
    await service.generateLlmSessionSummary('s');

    await exchange('s', '둘째');
    await service.generateLlmSessionSummary('s');
    expect(generator).toHaveBeenCalledTimes(2);
    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(false);
    expect(generator).toHaveBeenCalledTimes(2);
    await expect(due()).resolves.toEqual([]);
  });

  it('counts a prompt stored while the provider was answering as new', async () => {
    const { store, say, exchange, tool, due } = await setup();
    await exchange('s', '첫');
    await tool('s');
    const service = new MemoryIngestService({
      initialize: async () => {},
      eventStore: store,
      markdownMirror: { append: async () => {} },
      createToolEmbedding: () => '',
      llmSummaryGenerator: async () => {
        await say('s', '그 사이에 들어온 질문');
        return null;
      },
      now: () => now
    });

    await service.generateLlmSessionSummary('s');

    await expect(due()).resolves.toEqual(['s']);
  });

  it('counts a prompt that arrives later with an older timestamp as new (a late Mongo pull)', async () => {
    const { store, service, generator, exchange, tool, due } = await setup();
    await exchange('s', '첫');
    await tool('s');
    await service.generateLlmSessionSummary('s');

    await store.append({ eventType: 'user_prompt', sessionId: 's', timestamp: new Date(tick - 60_000), content: '다른 머신에서 먼저 한 질문' });

    await expect(due()).resolves.toEqual(['s']);
    await service.generateLlmSessionSummary('s');
    expect(generator).toHaveBeenCalledTimes(2);
    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(false);
    expect(generator).toHaveBeenCalledTimes(2);
  });

  it('counts a prompt with an older timestamp stored while the provider was answering as new', async () => {
    const { store, exchange, tool, due } = await setup();
    await exchange('s', '첫');
    await tool('s');
    const service = new MemoryIngestService({
      initialize: async () => {},
      eventStore: store,
      markdownMirror: { append: async () => {} },
      createToolEmbedding: () => '',
      llmSummaryGenerator: async () => {
        await store.append({ eventType: 'user_prompt', sessionId: 's', timestamp: new Date(tick - 60_000), content: '늦게 온 질문' });
        return null;
      },
      now: () => now
    });

    await service.generateLlmSessionSummary('s');

    await expect(due()).resolves.toEqual(['s']);
  });

  it.each([
    ['not JSON', '{not json'],
    ['a JSON array', '[1]']
  ])('records no verdict on a row whose metadata is %s, so its origin stays unknown', async (_label, raw) => {
    const { store, service, generator, exchange, tool, due } = await setup();
    await exchange('s', '첫');
    await tool('s');
    const answer = (await store.getSessionEvents('s')).find((e) => e.eventType === 'agent_response')!;
    store.getDatabase().prepare('UPDATE events SET metadata = ? WHERE id = ?').run(raw, answer.id);
    expect((await store.getEvent(answer.id))?.origin).toBe('unknown');

    await service.generateLlmSessionSummary('s');

    expect((await store.getEvent(answer.id))?.origin).toBe('unknown');
    const stored = store.getDatabase().prepare('SELECT metadata FROM events WHERE id = ?').get(answer.id) as { metadata: string };
    expect(stored.metadata).toBe(raw);
    expect(generator).toHaveBeenCalledOnce();
    await expect(due()).resolves.toEqual(['s']);
  });

  it.each([
    ['false', false, true],
    ['a count given as text', { judgedAt: '2026-11-20T00:00:00.000Z', exchangeCount: '2' }, true],
    ['no judgedAt', { exchangeCount: 2 }, true],
    ['the recorded shape', { judgedAt: '2026-11-20T00:00:00.000Z', exchangeCount: 2 }, false]
  ])('treats a verdict of %s the same in the backfill and in the summary run', async (_label, verdict, isDue) => {
    const { store, service, generator, exchange, tool, due } = await setup();
    await exchange('s', '첫');
    await tool('s');
    const answer = (await store.getSessionEvents('s')).find((e) => e.eventType === 'agent_response')!;
    await store.mergeEventMetadata(answer.id, { emptySummaryVerdict: verdict });

    await expect(due()).resolves.toEqual(isDue ? ['s'] : []);
    await service.generateLlmSessionSummary('s');
    expect(generator).toHaveBeenCalledTimes(isDue ? 1 : 0);
  });

  it('is judged again after forget removes the prompt or answer it was recorded on, not after an older one', async () => {
    const { store, service, generator, exchange, tool, due } = await setup();
    await exchange('s', '첫');
    await exchange('s', '둘째');
    await tool('s');
    await service.generateLlmSessionSummary('s');
    const exchanges = (await store.getSessionEvents('s')).filter((e) => e.eventType !== 'tool_observation');

    await store.deleteEventById(exchanges[0].id);
    await expect(due()).resolves.toEqual([]);
    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(false);
    expect(generator).toHaveBeenCalledOnce();

    await store.deleteEventById(exchanges.at(-1)!.id);
    await expect(due()).resolves.toEqual(['s']);
    await service.generateLlmSessionSummary('s');
    expect(generator).toHaveBeenCalledTimes(2);
  });

  it('holds on an older verdict again once forget leaves exactly what it judged', async () => {
    const { store, service, generator, exchange, tool, due } = await setup();
    await exchange('s', '첫');
    await tool('s');
    await service.generateLlmSessionSummary('s');
    await exchange('s', '둘째');
    await service.generateLlmSessionSummary('s');
    expect(generator).toHaveBeenCalledTimes(2);
    const second = (await store.getSessionEvents('s')).filter((e) => e.content.startsWith('둘째'));

    for (const row of second) await store.deleteEventById(row.id);

    await expect(due()).resolves.toEqual([]);
    await expect(service.generateLlmSessionSummary('s')).resolves.toBe(false);
    expect(generator).toHaveBeenCalledTimes(2);
  });

  it('is judged again after a force reimport replaces the session rows', async () => {
    const { store, service, generator, exchange, tool, due } = await setup();
    await exchange('s', '첫');
    await tool('s');
    await service.generateLlmSessionSummary('s');
    const rows = await store.getSessionEvents('s');

    await store.deleteSessionEvents('s');
    for (const row of rows) {
      await store.append({ eventType: row.eventType, sessionId: 's', timestamp: row.timestamp, content: row.content });
    }

    await expect(due()).resolves.toEqual(['s']);
    await service.generateLlmSessionSummary('s');
    expect(generator).toHaveBeenCalledTimes(2);
  });

  it('is judged again when the event it was recorded on is quarantined', async () => {
    const { store, service, generator, exchange, tool, due } = await setup();
    await exchange('s', '첫');
    await exchange('s', '둘째');
    await tool('s');
    await service.generateLlmSessionSummary('s');
    const answer = (await store.getSessionEvents('s')).filter((e) => e.eventType === 'agent_response').at(-1)!;
    await store.mergeEventMetadata(answer.id, { quarantine: { status: 'active', category: 'secret' } });

    await expect(due()).resolves.toEqual(['s']);
    await service.generateLlmSessionSummary('s');
    expect(generator).toHaveBeenCalledTimes(2);
  });
});
