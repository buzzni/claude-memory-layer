/**
 * List-relative FTS normalization hands the first hit 1.0 however weak the
 * match is, so a single common token clears the hook's minScore. The
 * CLAUDE_MEMORY_FTS_ABSOLUTE_SCORE_EXPERIMENT path scores real bm25 ranks on
 * a fixed scale instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { MemoryQueryService } from '../../src/core/engine/memory-query-service.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

describe('MemoryQueryService FTS scores on real bm25 ranks', () => {
  let tempDir: string;
  let store: SQLiteEventStore;
  let service: MemoryQueryService;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-memory-layer-test-'));
    store = new SQLiteEventStore(path.join(tempDir, 'events.sqlite'));
    await store.initialize();
    service = new MemoryQueryService(async () => {}, store);

    // "update" appears in half the corpus, so its IDF is close to zero.
    for (let i = 0; i < 40; i++) {
      await store.append({
        eventType: 'agent_response',
        sessionId: 'session-1',
        timestamp: new Date(Date.now() - 10_000 + i),
        content: i % 2 === 0 ? `Ran the update for batch ${i} and checked logs.` : `Reviewed note ${i} about release timing.`
      });
    }
    await store.append({
      eventType: 'agent_response',
      sessionId: 'session-1',
      timestamp: new Date(),
      content: 'Changed src/core/engine/memory-query-service.ts keywordSearch normalization.'
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    try { store.close(); } catch { /* already closed */ }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('gives a common-token match the top score without the experiment', async () => {
    const [top] = await service.keywordSearch('update');

    expect(top.score).toBe(1);
  });

  it('keeps a common-token match below the fallback floor with the experiment', async () => {
    vi.stubEnv('CLAUDE_MEMORY_FTS_ABSOLUTE_SCORE_EXPERIMENT', 'true');

    const results = await service.keywordSearch('update');

    expect(results.length).toBeGreaterThan(0);
    expect(Math.max(...results.map((r) => r.score))).toBeLessThan(0.3);
  });

  it('scores a path and identifier match above the default minScore with the experiment', async () => {
    vi.stubEnv('CLAUDE_MEMORY_FTS_ABSOLUTE_SCORE_EXPERIMENT', 'true');

    const [top] = await service.keywordSearch('src/core/engine/memory-query-service.ts keywordSearch');

    expect(top.event.content).toContain('memory-query-service.ts');
    expect(top.score).toBeGreaterThanOrEqual(0.5);
    expect(top.score).toBeLessThan(1);
  });
});
