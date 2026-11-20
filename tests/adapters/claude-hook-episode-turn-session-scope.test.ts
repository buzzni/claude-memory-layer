import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import {
  selectHookInjection,
  type HookSelectionDeps
} from '../../src/adapters/claude/hooks/user-prompt-submit.js';

/**
 * A forked or re-imported Codex transcript keeps the host's native turn ids
 * under a new session id (#207). Episode expansion reads the matched prompt's
 * turn, and must not pull the other session's answer for the same turn id.
 */

const prompt = 'How does the release workflow publish-npm.yml run on tag push?';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function seedSharedTurn(store: SQLiteEventStore): Promise<string> {
  const promptRow = await store.append({
    eventType: 'user_prompt',
    sessionId: 'session-a',
    timestamp: new Date(Date.UTC(2026, 10, 1, 0, 0)),
    content: 'how does the release workflow publish-npm.yml run on tag push?',
    metadata: { turnId: 'shared' }
  });
  await store.append({
    eventType: 'agent_response',
    sessionId: 'session-a',
    timestamp: new Date(Date.UTC(2026, 10, 1, 0, 1)),
    content: 'Session a: tag push v2.4.17 starts publish-npm.yml; watch it with gh run watch.',
    metadata: { turnId: 'shared' }
  });
  await store.append({
    eventType: 'agent_response',
    sessionId: 'session-b',
    timestamp: new Date(Date.UTC(2026, 10, 2, 0, 1)),
    content: 'Session b: an unrelated answer recorded under the same native turn id.',
    metadata: { turnId: 'shared' }
  });
  return promptRow.eventId;
}

describe('UserPromptSubmit episode expansion turn session scope', () => {
  it('expands a matched prompt only with answers from its own session', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-hook-turn-scope-'));
    roots.push(root);
    const store = new SQLiteEventStore(path.join(root, 'events.sqlite'));
    await store.initialize();
    const promptId = await seedSharedTurn(store);
    const promptEvent = (await store.getEvent(promptId))!;

    const deps: HookSelectionDeps = {
      retrieveSemantic: async () => [],
      memoryService: {
        searchGraduatedEvidence: async () => [],
        listProjectLessonInjections: async () => [],
        keywordSearch: async () => [{ event: promptEvent, score: 1 }],
        expandDisclosure: async () => ({ target: promptEvent, summaries: [], surroundingFacts: [] }),
        getEventsByTurn: (turnId: string, options?: { sessionId?: string }) => store.getEventsByTurn(turnId, options),
        getEvent: (id: string) => store.getEvent(id)
      } as unknown as HookSelectionDeps['memoryService']
    };

    const selection = await selectHookInjection(deps, { prompt, retrievalQuery: prompt, sessionId: 'current' });
    const episode = selection.injectionPool.filter((memory) => memory.source === 'episode');

    expect(episode.map((memory) => memory.content)).toEqual([
      'Session a: tag push v2.4.17 starts publish-npm.yml; watch it with gh run watch.'
    ]);
    await store.close();
  });
});
