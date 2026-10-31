import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/**
 * Byte-level guard for the UserPromptSubmit selection path. The snapshots were
 * recorded before selectHookInjection was extracted from main(), so any
 * drift in stdout or in what the hook hands to telemetry fails here.
 */

const service = {
  evaluatePendingSessions: vi.fn(),
  searchGraduatedEvidence: vi.fn(),
  listProjectLessonInjections: vi.fn(),
  keywordSearch: vi.fn(),
  expandDisclosure: vi.fn(),
  getEventsByTurn: vi.fn(),
  getEvent: vi.fn(),
  getRecentEvents: vi.fn(),
  incrementMemoryAccess: vi.fn(),
  recordRetrieval: vi.fn(),
  recordQueryTrace: vi.fn(),
  recordDeliveryOutcome: vi.fn(),
  storeUserPrompt: vi.fn(),
  getSessionHistory: vi.fn()
};

const daemon = {
  retrieveSemanticMemories: vi.fn(),
  scheduleSemanticGraduation: vi.fn()
};

vi.mock('../../src/services/memory-service.js', () => ({
  getLightweightMemoryService: () => service,
  getLightweightMemoryServiceForProject: () => service
}));

vi.mock('../../src/adapters/claude/hooks/semantic-daemon-client.js', () => ({
  retrieveSemanticMemories: (...args: unknown[]) => daemon.retrieveSemanticMemories(...args),
  scheduleSemanticGraduation: (...args: unknown[]) => daemon.scheduleSemanticGraduation(...args)
}));

const roots: string[] = [];
const at = new Date('2026-09-01T00:00:00.000Z');

function event(id: string, eventType: string, content: string, extra: Record<string, unknown> = {}) {
  return { id, eventType, sessionId: 'past-session', content, timestamp: at, ...extra };
}

function resetService(): void {
  service.evaluatePendingSessions.mockReset().mockResolvedValue(undefined);
  service.searchGraduatedEvidence.mockReset().mockResolvedValue([]);
  service.listProjectLessonInjections.mockReset().mockResolvedValue([]);
  service.keywordSearch.mockReset().mockResolvedValue([]);
  service.expandDisclosure.mockReset().mockResolvedValue(null);
  service.getEventsByTurn.mockReset().mockResolvedValue([]);
  service.getEvent.mockReset().mockResolvedValue(null);
  service.getRecentEvents.mockReset().mockResolvedValue([]);
  service.incrementMemoryAccess.mockReset().mockResolvedValue(undefined);
  service.recordRetrieval.mockReset().mockResolvedValue(undefined);
  service.recordQueryTrace.mockReset().mockResolvedValue('trace-id');
  service.recordDeliveryOutcome.mockReset().mockResolvedValue(1);
  service.storeUserPrompt.mockReset().mockResolvedValue(undefined);
  service.getSessionHistory.mockReset().mockResolvedValue([]);
  daemon.retrieveSemanticMemories.mockReset().mockResolvedValue([]);
  daemon.scheduleSemanticGraduation.mockReset().mockResolvedValue(undefined);
}

/** Random ids are replaced by stable placeholders; everything else is kept verbatim. */
function stable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, v) => {
    if (key === 'traceId' && typeof v === 'string') return '<trace-id>';
    if (key === 'requestId' && typeof v === 'string') return v.replace(/:[^:]+$/, ':<turn-id>');
    return v;
  }));
}

async function runHook(prompt: string): Promise<unknown> {
  const stdin = JSON.stringify({ session_id: 'session-golden', prompt, cwd: '/repo/app' });
  vi.spyOn(process.stdin, 'setEncoding').mockReturnValue(process.stdin);
  const { main } = await import('../../src/adapters/claude/hooks/user-prompt-submit.js');
  const runtime = await import('../../src/adapters/claude/hooks/hook-runtime.js');
  vi.spyOn(runtime, 'readStdin').mockResolvedValue(stdin);
  const stdout = await main({ persistPrompt: false, maintenance: false });
  return stable({
    stdout,
    semanticRequests: daemon.retrieveSemanticMemories.mock.calls,
    keywordRequests: service.keywordSearch.mock.calls,
    graduatedRequests: service.searchGraduatedEvidence.mock.calls,
    lessonRequests: service.listProjectLessonInjections.mock.calls,
    episodeRequests: service.expandDisclosure.mock.calls,
    turnRequests: service.getEventsByTurn.mock.calls,
    accessWrites: service.incrementMemoryAccess.mock.calls,
    retrievals: service.recordRetrieval.mock.calls,
    traces: service.recordQueryTrace.mock.calls
  });
}

beforeEach(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'cml-hook-golden-'));
  roots.push(root);
  vi.stubEnv('HOME', root);
  vi.stubEnv('CLAUDE_MEMORY_EVAL_MODE', '');
  vi.stubEnv('CLAUDE_MEMORY_FTS_ABSOLUTE_SCORE_EXPERIMENT', '');
  vi.stubEnv('CLAUDE_MEMORY_RETRIEVAL_QUERY_SANITIZER_EXPERIMENT', '');
  vi.stubEnv('CLAUDE_MEMORY_LESSON_OWNER', '');
  resetService();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('UserPromptSubmit selection golden output', () => {
  it('merges semantic, graduated, keyword, episode, and lesson lanes in hybrid mode', async () => {
    vi.stubEnv('CLAUDE_MEMORY_RETRIEVAL_MODE', 'hybrid');
    daemon.retrieveSemanticMemories.mockResolvedValue([
      { id: 'ev-answer', type: 'agent_response', content: 'The release workflow publishes on tag push: push v2.4.17 and watch the publish-npm.yml workflow run.', score: 0.71, sessionId: 'past-session' },
      { id: 'ev-tool', type: 'tool_observation', content: 'gh run watch publish-npm.yml release workflow completed', score: 0.69, sessionId: 'past-session' }
    ]);
    service.searchGraduatedEvidence.mockResolvedValue([
      { event: event('ev-answer', 'agent_response', 'The release workflow publishes on tag push: push v2.4.17 and watch the publish-npm.yml workflow run.'), rank: -40, level: 'L2', accessCount: 3 },
      { event: event('ev-summary', 'session_summary', 'Release workflow decision: publish-npm.yml runs on tag push, never npm publish locally.'), rank: -12, level: 'L1', accessCount: 0 }
    ]);
    service.keywordSearch.mockResolvedValue([
      { event: event('ev-prompt', 'user_prompt', 'how does the release workflow publish-npm.yml run on tag push?', { metadata: { turnId: 'turn-1' } }), score: 1 },
      { event: event('ev-answer', 'agent_response', 'The release workflow publishes on tag push: push v2.4.17 and watch the publish-npm.yml workflow run.'), score: 0.92 },
      { event: event('ev-weak', 'agent_response', 'Unrelated note about the dashboard theme colors.'), score: 0.35 }
    ]);
    service.expandDisclosure.mockResolvedValue({
      target: { metadata: { turnId: 'turn-1' } },
      summaries: [],
      surroundingFacts: []
    });
    service.getEventsByTurn.mockResolvedValue([
      event('ev-turn-answer', 'agent_response', 'For publish-npm.yml: tag push v2.4.17 starts the release workflow; check it with gh run watch.')
    ]);
    service.listProjectLessonInjections.mockResolvedValue([{
      value: {
        lessonId: 'lesson-release',
        name: 'release workflow runs from tag push',
        trigger: 'when publishing a release with publish-npm.yml on tag push',
        steps: ['push the version tag', 'watch publish-npm.yml'],
        failureModes: ['running npm publish locally'],
        confidence: 0.9
      },
      injectionMode: 'direct'
    }]);

    await expect(JSON.stringify(await runHook('How does the release workflow publish-npm.yml run on tag push?'), null, 2))
      .toMatchFileSnapshot('__snapshots__/hook-selection-golden-hybrid.json');
  });

  it('falls back to the keyword floor when every keyword hit is below the tuned minimum', async () => {
    vi.stubEnv('CLAUDE_MEMORY_RETRIEVAL_MODE', 'keyword');
    service.keywordSearch.mockResolvedValue([
      { event: event('ev-a', 'agent_response', 'Vector outbox drain stalls when the worker lock is held by a dead pid.'), score: 0.36 },
      { event: event('ev-b', 'agent_response', 'The vector outbox worker lock is released on process exit.'), score: 0.33 },
      { event: event('ev-c', 'user_prompt', 'why does the vector outbox drain stall?'), score: 0.1 }
    ]);

    await expect(JSON.stringify(await runHook('Why does the vector outbox drain stall with a held worker lock?'), null, 2))
      .toMatchFileSnapshot('__snapshots__/hook-selection-golden-keyword-floor.json');
  });

  it('keeps answering from the keyword lane when the semantic daemon fails', async () => {
    vi.stubEnv('CLAUDE_MEMORY_RETRIEVAL_MODE', 'hybrid');
    daemon.retrieveSemanticMemories.mockRejectedValue(new Error('daemon down'));
    service.keywordSearch.mockResolvedValue([
      { event: event('ev-k', 'agent_response', 'SessionStart grounding recovered to 0.19 after PR #57 restored the ranking.'), score: 1 },
      { event: event('ev-k2', 'agent_response', 'PR #55 replaced SessionStart ranking and overlap fell to 0.008.'), score: 0.8 }
    ]);

    await expect(JSON.stringify(await runHook('What happened to SessionStart grounding after PR #55 and PR #57?'), null, 2))
      .toMatchFileSnapshot('__snapshots__/hook-selection-golden-daemon-down.json');
  });

  it('records an empty selection when no lane finds anything', async () => {
    vi.stubEnv('CLAUDE_MEMORY_RETRIEVAL_MODE', 'hybrid');

    await expect(JSON.stringify(await runHook('Explain the deployment approval workflow for the mobile app.'), null, 2))
      .toMatchFileSnapshot('__snapshots__/hook-selection-golden-empty.json');
  });
});
