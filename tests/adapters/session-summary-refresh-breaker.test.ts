import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ spawn: spawnMock }));

import { DEFAULT_SESSION_SUMMARY_REFRESH, MemoryIngestService } from '../../src/core/engine/memory-ingest-service.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { ProviderCircuitBreaker } from '../../src/adapters/llm/provider-circuit-breaker.js';
import { generateLlmSessionSummary } from '../../src/adapters/llm/session-summary-llm.js';

let homeDir: string;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-refresh-breaker-'));
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('CLAUDE_MEMORY_SUMMARY_PROVIDER', 'claude');
  vi.stubEnv('CLAUDE_MEMORY_LLM_BREAKER', 'on');
  spawnMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('summary refresh while the provider circuit is open', () => {
  it('does not start the CLI, and keeps the old summary as it was so the session stays due', async () => {
    const breaker = new ProviderCircuitBreaker();
    for (let i = 0; i < 3; i++) breaker.recordFailure('claude', 'provider-auth', { allowed: true, probe: false });

    const store = new SQLiteEventStore(path.join(homeDir, 'events.sqlite'));
    await store.initialize();
    let tick = Date.parse('2026-11-17T00:00:00.000Z');
    const exchange = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await store.append({ eventType: i % 2 ? 'agent_response' : 'user_prompt', sessionId: 's', timestamp: new Date(tick++), content: `대화 ${tick}` });
      }
    };
    await exchange(2);
    await store.append({ eventType: 'tool_observation', sessionId: 's', timestamp: new Date(tick++), content: '{}' });
    const old = await store.append({
      eventType: 'session_summary',
      sessionId: 's',
      timestamp: new Date(tick++),
      content: '- 결정: 첫 요약',
      metadata: { summarizedExchangeCount: 2 }
    });
    await exchange(DEFAULT_SESSION_SUMMARY_REFRESH.minNewExchanges);

    const service = new MemoryIngestService({
      initialize: async () => {},
      eventStore: store,
      markdownMirror: { append: async () => {} },
      createToolEmbedding: () => '',
      llmSummaryGenerator: (events) => generateLlmSessionSummary(events)
    });

    await expect(service.generateLlmSessionSummary('s')).rejects.toMatchObject({ code: 'provider-circuit-open' });
    expect(spawnMock).not.toHaveBeenCalled();
    const summaries = (await store.getSessionEvents('s')).filter((e) => e.eventType === 'session_summary');
    expect(summaries.map((e) => e.id)).toEqual([old.eventId]);
    expect(summaries[0].metadata).toEqual({ summarizedExchangeCount: 2 });

    await store.close();
  });
});
