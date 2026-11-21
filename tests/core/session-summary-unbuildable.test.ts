import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { buildSummaryPrompt } from '../../src/adapters/llm/session-summary-llm.js';
import {
  DEFAULT_SESSION_SUMMARY_REFRESH,
  MemoryIngestService
} from '../../src/core/engine/memory-ingest-service.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

const tempDirs: string[] = [];
const stores: SQLiteEventStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every character String.prototype.trim() strips, which is what buildSummaryPrompt calls empty. */
const TRIMMED_CHARS = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code))
  .filter((char) => !/[\uD800-\uDFFF]/.test(char) && char.trim() === '');

// Issue #284: a session the summary prompt cannot be built for never reaches the
// provider and so never gets a summary, yet the LLM backfill picked it at every
// session start, where it held one of the window's places ahead of older sessions.
describe('LLM summary backfill and sessions the summary prompt cannot be built for', () => {
  const now = new Date('2026-11-21T00:00:00.000Z');
  const hidden = { quarantine: { status: 'active', category: 'secret' } };
  let tick = now.getTime() - 24 * 60 * 60 * 1000;

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'cml-summary-unbuildable-'));
    tempDirs.push(dir);
    const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
    stores.push(store);
    await store.initialize();
    const add = (sessionId: string, eventType: string, content: string, metadata?: Record<string, unknown>) =>
      store.append({ eventType, sessionId, timestamp: new Date(tick++), content, metadata });
    const exchange = async (sessionId: string, label: string) => {
      await add(sessionId, 'user_prompt', `${label} 질문`);
      await add(sessionId, 'agent_response', `${label} 답변`);
    };
    const tool = (sessionId: string, metadata?: Record<string, unknown>) =>
      add(sessionId, 'tool_observation', `{"n":${tick}}`, metadata);
    // What the daemon passes: the provider is reached only when the prompt can be built.
    const reached: string[] = [];
    const run = async (sessionId: string) => {
      const service = new MemoryIngestService({
        initialize: async () => {},
        eventStore: store,
        markdownMirror: { append: async () => {} },
        createToolEmbedding: () => '',
        llmSummaryGenerator: async (events) => {
          if (buildSummaryPrompt(events)) reached.push(sessionId);
          return null;
        },
        now: () => now
      });
      await service.generateLlmSessionSummary(sessionId);
    };
    const backfill = new MemoryIngestService({
      initialize: async () => {},
      eventStore: store,
      markdownMirror: { append: async () => {} },
      createToolEmbedding: () => '',
      now: () => now
    });
    const due = (limit: number) => backfill.getSessionsDueForLlmSummary('current', limit);
    return { store, add, exchange, tool, run, reached, due };
  }

  it('picks exactly the unsummarized sessions whose summary run would reach the provider', async () => {
    const { add, exchange, tool, run, reached, due } = await setup();
    await exchange('buildable', '보통');
    await tool('buildable');
    for (let i = 0; i < 3; i++) await tool('tools-only');
    await add('blank', 'user_prompt', '진짜 질문');
    for (const char of TRIMMED_CHARS) await add('blank', 'agent_response', char.repeat(3));
    await add('quarantined', 'user_prompt', '보이는 질문');
    await add('quarantined', 'agent_response', '가려진 답변', hidden);
    await add('quarantined', 'user_prompt', '가려진 질문', hidden);
    await tool('quarantined');
    await add('one-exchange', 'user_prompt', '하나뿐인 질문');
    await tool('one-exchange');
    await tool('one-exchange');
    // The run reads quarantined events no more than the prompt does: two events left.
    await exchange('two-visible-events', '둘');
    await tool('two-visible-events', hidden);
    // Characters trim() keeps are content, even when they do not show.
    await add('invisible-content', 'user_prompt', '​');
    await add('invisible-content', 'agent_response', '\u0085');
    await tool('invisible-content');
    const sessions = ['buildable', 'tools-only', 'blank', 'quarantined', 'one-exchange', 'two-visible-events', 'invisible-content'];

    const picked = await due(sessions.length);
    for (const sessionId of sessions) await run(sessionId);

    expect(picked.sort()).toEqual(['buildable', 'invisible-content']);
    expect(reached.sort()).toEqual(picked);
  });

  it('keeps them out of the window, so older sessions that can be summarized are picked', async () => {
    const { exchange, tool, due } = await setup();
    await exchange('older-1', '오래된 1');
    await tool('older-1');
    await exchange('older-2', '오래된 2');
    await tool('older-2');
    for (const sessionId of ['newer-tools-1', 'newer-tools-2', 'newer-tools-3']) {
      for (let i = 0; i < 3; i++) await tool(sessionId);
    }

    await expect(due(2)).resolves.toEqual(['older-2', 'older-1']);
  });

  it('picks such a session again once it gains the prompts and answers a summary needs', async () => {
    const { store, add, tool, due } = await setup();
    for (let i = 0; i < 3; i++) await tool('tools-only');
    await add('one-exchange', 'user_prompt', '하나뿐인 질문');
    await tool('one-exchange');
    await tool('one-exchange');
    await expect(due(5)).resolves.toEqual([]);

    await add('one-exchange', 'agent_response', '이제 답변도 있음');
    await expect(due(5)).resolves.toEqual(['one-exchange']);
    await add('tools-only', 'user_prompt', '도구 뒤의 질문');
    await add('tools-only', 'agent_response', '도구 뒤의 답변');
    await expect(due(5)).resolves.toEqual(['tools-only', 'one-exchange']);
    // The rule-based backfill keeps its own selection.
    await expect(store.getSessionsWithoutSummary('current', 5)).resolves.toHaveLength(2);
  });

  it('does not count a prompt only trim() calls empty as new toward an empty verdict or a refresh', async () => {
    const { add, exchange, tool, run, reached, due } = await setup();
    await exchange('judged', '판정');
    await tool('judged');
    await run('judged');
    await add('judged', 'user_prompt', '　');
    await exchange('summarized', '요약됨');
    await tool('summarized');
    await add('summarized', 'session_summary', '- 결정: 요약', { summarizedExchangeCount: 2 });
    for (let i = 0; i < DEFAULT_SESSION_SUMMARY_REFRESH.minNewExchanges - 1; i++) {
      await add('summarized', 'user_prompt', `후속 ${i}`);
    }
    await add('summarized', 'agent_response', ' ');
    reached.length = 0;

    const picked = await due(5);
    await run('judged');
    await run('summarized');

    expect(picked).toEqual([]);
    expect(reached).toEqual([]);
  });
});
