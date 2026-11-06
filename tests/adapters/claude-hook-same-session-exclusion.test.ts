import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  selectHookInjection,
  type HookSelectionDeps
} from '../../src/adapters/claude/hooks/user-prompt-submit.js';

/**
 * An event written earlier in the session the prompt belongs to is still in
 * the agent's context, so re-injecting it spends the budget on nothing new.
 */

const at = new Date('2026-11-01T00:00:00.000Z');
const answer = 'The release workflow publishes on tag push: push v2.4.17 and watch the publish-npm.yml workflow run.';
const prompt = 'How does the release workflow publish-npm.yml run on tag push?';

function event(id: string, sessionId: string, eventType = 'agent_response', content = answer) {
  return { id, eventType, sessionId, content, timestamp: at };
}

function deps(): HookSelectionDeps {
  return {
    retrieveSemantic: async () => [
      { id: 'sem-current', type: 'agent_response', content: answer, score: 0.71, sessionId: 'current' },
      { id: 'sem-past', type: 'agent_response', content: answer, score: 0.70, sessionId: 'past' }
    ],
    memoryService: {
      searchGraduatedEvidence: async () => [
        { event: event('grad-current', 'current'), rank: -40, level: 'L2', accessCount: 3 },
        { event: event('grad-past', 'past'), rank: -30, level: 'L2', accessCount: 3 }
      ],
      listProjectLessonInjections: async () => [],
      keywordSearch: async () => [
        { event: event('kw-current', 'current', 'user_prompt', prompt), score: 1 },
        { event: event('kw-past', 'past'), score: 0.92 }
      ],
      expandDisclosure: async () => null,
      getEventsByTurn: async () => []
    } as unknown as HookSelectionDeps['memoryService']
  };
}

const ids = (memories: Array<{ id?: string }>) => memories.map((memory) => memory.id);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('selectHookInjection same-session exclusion', () => {
  it('drops events from the current session in every event lane', async () => {
    const selection = await selectHookInjection(deps(), { prompt, retrievalQuery: prompt, sessionId: 'current' });

    expect(ids(selection.mergedMemories)).not.toEqual(expect.arrayContaining(['sem-current']));
    expect(ids(selection.mergedMemories)).not.toEqual(expect.arrayContaining(['grad-current']));
    expect(ids(selection.mergedMemories)).not.toEqual(expect.arrayContaining(['kw-current']));
    expect(ids(selection.mergedMemories)).toEqual(expect.arrayContaining(['sem-past', 'grad-past', 'kw-past']));
    expect(selection.injectableMemories.every((memory) => memory.sessionId !== 'current')).toBe(true);
  });

  it('keeps current-session events when the caller names no session', async () => {
    const selection = await selectHookInjection(deps(), { prompt, retrievalQuery: prompt });

    expect(ids(selection.mergedMemories)).toEqual(expect.arrayContaining(['sem-current', 'grad-current', 'kw-current']));
  });

  it('keeps current-session events when CLAUDE_MEMORY_INJECT_SAME_SESSION=true', async () => {
    vi.stubEnv('CLAUDE_MEMORY_INJECT_SAME_SESSION', 'true');
    const selection = await selectHookInjection(deps(), { prompt, retrievalQuery: prompt, sessionId: 'current' });

    expect(ids(selection.mergedMemories)).toEqual(expect.arrayContaining(['sem-current', 'grad-current', 'kw-current']));
  });
});
