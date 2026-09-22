import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { reportHookDelivery } from '../../src/adapters/claude/hooks/hook-output.js';

/**
 * End-to-end telemetry contract of the UserPromptSubmit hook
 * (specs/recent-memory-patterns-2026-09-06 R1-R3): typed trace items, a typed
 * access count, an honest outcome reason for an empty selection, and delivery
 * evidence recorded only after the envelope is written.
 */

const service = {
  evaluatePendingSessions: vi.fn().mockResolvedValue(undefined),
  searchGraduatedEvidence: vi.fn().mockResolvedValue([]),
  listProjectLessonInjections: vi.fn().mockResolvedValue([]),
  keywordSearch: vi.fn().mockResolvedValue([]),
  getEvent: vi.fn().mockResolvedValue(null),
  getRecentEvents: vi.fn().mockResolvedValue([]),
  incrementMemoryAccess: vi.fn().mockResolvedValue(undefined),
  recordRetrieval: vi.fn().mockResolvedValue(undefined),
  recordQueryTrace: vi.fn().mockResolvedValue('trace-id'),
  recordDeliveryOutcome: vi.fn().mockResolvedValue(1),
  storeUserPrompt: vi.fn().mockResolvedValue(undefined),
  getSessionHistory: vi.fn().mockResolvedValue([])
};

vi.mock('../../src/services/memory-service.js', () => ({
  getLightweightMemoryService: () => service,
  getLightweightMemoryServiceForProject: () => service
}));

vi.mock('../../src/adapters/claude/hooks/semantic-daemon-client.js', () => ({
  retrieveSemanticMemories: vi.fn().mockResolvedValue([]),
  scheduleSemanticGraduation: vi.fn().mockResolvedValue(undefined)
}));

const roots: string[] = [];

function isolatedHome(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cml-hook-telemetry-'));
  roots.push(root);
  return root;
}

async function runPromptHook(prompt: string): Promise<void> {
  const stdin = JSON.stringify({ session_id: 'session-telemetry', prompt, cwd: '/repo/app' });
  vi.spyOn(process.stdin, 'setEncoding').mockReturnValue(process.stdin);
  const { main } = await import('../../src/adapters/claude/hooks/user-prompt-submit.js');
  const readStdinModule = await import('../../src/adapters/claude/hooks/hook-runtime.js');
  vi.spyOn(readStdinModule, 'readStdin').mockResolvedValue(stdin);
  await main({ persistPrompt: false });
}

beforeEach(() => {
  vi.stubEnv('HOME', isolatedHome());
  vi.stubEnv('CLAUDE_MEMORY_EVAL_MODE', '');
  vi.stubEnv('CLAUDE_MEMORY_RETRIEVAL_MODE', 'keyword');
  for (const fn of Object.values(service)) fn.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('UserPromptSubmit telemetry contract', () => {
  it('types injected lessons separately from events and keeps them out of the event access write', async () => {
    service.listProjectLessonInjections.mockResolvedValue([
      {
        value: {
          lessonId: 'lesson-release',
          name: 'npm release runs through the tag push workflow',
          trigger: 'when publishing a release to npm from this repository',
          steps: ['push the version tag', 'watch the publish workflow'],
          failureModes: ['running npm publish locally'],
          confidence: 0.9
        },
        injectionMode: 'direct'
      }
    ]);

    await runPromptHook('How do I publish a release to npm with the tag push workflow?');

    const traceCall = service.recordQueryTrace.mock.calls[0]?.[0];
    expect(traceCall).toBeDefined();
    const lessonItem = traceCall.items.find((item: { id: string }) => item.id === 'lesson-release');
    expect(lessonItem?.kind).toBe('lesson');
    expect(traceCall.requestId).toMatch(/^claude-hook:session-telemetry:/);

    if (service.incrementMemoryAccess.mock.calls.length > 0) {
      const refs = service.incrementMemoryAccess.mock.calls[0][0];
      // Every ref carries a kind, so a lesson can no longer be used to update
      // events.access_count.
      for (const ref of refs) expect(['event', 'lesson']).toContain(ref.kind);
      expect(refs.some((ref: { kind: string; id: string }) => ref.kind === 'lesson' && ref.id === 'lesson-release')).toBe(true);
    }

    const lessonRetrieval = service.recordRetrieval.mock.calls
      .find((call) => call[0] === 'lesson-release');
    expect(lessonRetrieval?.[4]).toMatchObject({ memoryKind: 'lesson', deliveryStatus: 'formatted' });
  });

  it('classifies an empty selection with a real reason instead of runtime_error', async () => {
    await runPromptHook('Please explain the deployment approval workflow in detail.');

    const traceCall = service.recordQueryTrace.mock.calls[0]?.[0];
    expect(traceCall).toBeDefined();
    expect(traceCall.selectedEventIds).toEqual([]);
    expect(traceCall.outcomeDiagnostics.outcomeReason).not.toBe('runtime_error');
    // No events exist in the fixture store at all.
    expect(traceCall.outcomeDiagnostics.outcomeReason).toBe('no_project_events');
  });

  it('records delivery only once the hook envelope has actually been written', async () => {
    service.keywordSearch.mockResolvedValue([
      {
        score: 0.9,
        event: {
          id: 'event-deploy',
          eventType: 'agent_response',
          sessionId: 'past-session',
          content: 'Deployment approval workflow requires the release manager to approve the tag push.',
          timestamp: new Date('2026-09-01T00:00:00.000Z')
        }
      }
    ]);

    await runPromptHook('Explain the deployment approval workflow tag push release manager.');

    // Nothing is delivered at selection time.
    expect(service.recordDeliveryOutcome).not.toHaveBeenCalled();

    await reportHookDelivery({ status: 'emitted' });
    expect(service.recordDeliveryOutcome).toHaveBeenCalledWith(expect.objectContaining({
      status: 'emitted',
      evidence: 'hook_stdout'
    }));
  });
});
