import { describe, expect, it, vi } from 'vitest';

import {
  launchClaudeSessionEndWorker,
  normalizeClaudeSessionEndJob
} from '../../src/adapters/claude/hooks/session-end.js';
import { handleClaudeSessionEnd } from '../../src/adapters/claude/hooks/session-end-worker.js';
import type { SessionEndInput } from '../../src/core/types.js';

const validInput: SessionEndInput = {
  session_id: 'session-1',
  transcript_path: '/tmp/claude/session-1.jsonl',
  cwd: '/repo/project',
  hook_event_name: 'SessionEnd'
};

describe('Claude SessionEnd hook', () => {
  const atSessionEnd = {
    getRegistrationId: () => 'registration-1',
    getOpenTurn: () => ({ turnId: 'turn-open', turnTrigger: 'task_notification' as const }),
    getTranscriptBytes: () => 4096,
    now: () => new Date('2026-10-31T12:00:00.000Z')
  };

  it('captures the state at SessionEnd in the job it hands off, so a resume cannot change it', () => {
    expect(normalizeClaudeSessionEndJob(validInput, atSessionEnd)).toEqual({
      sessionId: 'session-1',
      registrationId: 'registration-1',
      transcriptPath: '/tmp/claude/session-1.jsonl',
      projectPath: '/repo/project',
      snapshot: {
        transcriptBytes: 4096,
        endedAt: '2026-10-31T12:00:00.000Z',
        openTurn: { turnId: 'turn-open', turnTrigger: 'task_notification' }
      }
    });
  });

  it('still ends a session without a transcript or with a relative project scope, but does not reconcile it', () => {
    expect(normalizeClaudeSessionEndJob({ session_id: 'session-1' }, atSessionEnd))
      .toEqual({ sessionId: 'session-1', registrationId: 'registration-1' });
    expect(normalizeClaudeSessionEndJob({ ...validInput, cwd: 'relative/project' }, atSessionEnd))
      .toEqual({ sessionId: 'session-1', registrationId: 'registration-1' });
    expect(normalizeClaudeSessionEndJob({ ...validInput, transcript_path: '/missing.jsonl' }, {
      ...atSessionEnd,
      getTranscriptBytes: () => null
    })).toEqual({ sessionId: 'session-1', registrationId: 'registration-1' });
    expect(normalizeClaudeSessionEndJob({ ...validInput, session_id: '' }, atSessionEnd)).toBeNull();
  });

  it('hands work to a detached worker and closes the payload pipe', () => {
    const on = vi.fn();
    const end = vi.fn();
    const unref = vi.fn();
    const spawnWorker = vi.fn(() => ({ stdin: { on, end }, unref }));

    const launched = launchClaudeSessionEndWorker(validInput, {
      ...atSessionEnd,
      spawnWorker: spawnWorker as never,
      workerPath: '/plugin/hooks/session-end-worker.js'
    });

    expect(launched).toBe(true);
    expect(spawnWorker).toHaveBeenCalledWith(
      process.execPath,
      ['/plugin/hooks/session-end-worker.js'],
      {
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'ignore', 'ignore']
      }
    );
    expect(on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(JSON.parse(end.mock.calls[0][0])).toEqual(normalizeClaudeSessionEndJob(validInput, atSessionEnd));
    expect(unref).toHaveBeenCalledTimes(1);
  });
});

describe('Claude SessionEnd worker', () => {
  function bookkeepingService(history: unknown[] = [{ id: 'event-1' }]) {
    return {
      getSessionHistory: vi.fn(async () => history),
      endSession: vi.fn(async () => undefined),
      evaluateSessionHelpfulness: vi.fn(async () => undefined),
      processPendingEmbeddings: vi.fn(async () => undefined)
    };
  }

  const snapshot = { transcriptBytes: 4096, endedAt: '2026-10-31T12:00:00.000Z', openTurn: null };

  it('reconciles the transcript in the project store before evaluating the session', async () => {
    const order: string[] = [];
    const memoryService = bookkeepingService();
    memoryService.evaluateSessionHelpfulness.mockImplementation(async () => { order.push('evaluate'); });
    const projectService = { tag: 'project' };
    const reconcile = vi.fn(async () => {
      order.push('reconcile');
      return { recovered: 1, alreadyStored: 0, failed: 0 };
    });

    await handleClaudeSessionEnd({
      sessionId: 'session-1',
      registrationId: null,
      transcriptPath: '/tmp/claude/session-1.jsonl',
      projectPath: '/repo/project',
      snapshot
    }, {
      getMemoryService: () => memoryService as never,
      getProjectMemoryService: (projectPath) => {
        expect(projectPath).toBe('/repo/project');
        return projectService as never;
      },
      reconcile: reconcile as never,
      markTerminal: vi.fn()
    });

    expect(reconcile).toHaveBeenCalledWith(projectService, 'session-1', '/tmp/claude/session-1.jsonl', snapshot);
    expect(order).toEqual(['reconcile', 'evaluate']);
  });

  it('keeps ending the session when the reconcile fails', async () => {
    const memoryService = bookkeepingService();

    await handleClaudeSessionEnd({
      sessionId: 'session-1',
      registrationId: null,
      transcriptPath: '/tmp/claude/session-1.jsonl',
      projectPath: '/repo/project',
      snapshot
    }, {
      getMemoryService: () => memoryService as never,
      getProjectMemoryService: () => ({}) as never,
      reconcile: vi.fn(async () => { throw new Error('transcript unreadable'); }) as never,
      markTerminal: vi.fn()
    });

    expect(memoryService.endSession).toHaveBeenCalledWith('session-1');
  });

  it('marks the session terminal even when deferred embedding processing fails', async () => {
    const markTerminal = vi.fn();
    const memoryService = bookkeepingService();
    memoryService.processPendingEmbeddings.mockRejectedValue(new Error('injected embedding failure'));

    await expect(handleClaudeSessionEnd({ sessionId: 'session-1', registrationId: 'registration-1' }, {
      getMemoryService: () => memoryService as never,
      markTerminal
    })).rejects.toThrow('injected embedding failure');
    expect(markTerminal).toHaveBeenCalledWith('session-1', 'registration-1');
  });

  it('keeps terminal-marker failures non-fatal to an otherwise successful hook', async () => {
    await expect(handleClaudeSessionEnd({ sessionId: 'session-2', registrationId: null }, {
      getMemoryService: () => bookkeepingService([]) as never,
      markTerminal: () => {
        throw new Error('registry unavailable');
      }
    })).resolves.toBeUndefined();
  });

  it('does not let late SessionEnd work mark a resumed session terminal', async () => {
    let registrationId = 'registration-before-resume';
    let terminal = false;
    const memoryService = bookkeepingService([]);
    memoryService.getSessionHistory.mockImplementation(async () => {
      registrationId = 'registration-after-resume';
      return [];
    });

    await handleClaudeSessionEnd({ sessionId: 'resumed-session', registrationId: 'registration-before-resume' }, {
      getMemoryService: () => memoryService as never,
      markTerminal: (_sessionId, expectedRegistrationId) => {
        if (registrationId === expectedRegistrationId) terminal = true;
      }
    });

    expect(terminal).toBe(false);
  });

  it('leaves ending and evaluating a session resumed while the worker ran to that session', async () => {
    const memoryService = bookkeepingService();

    await handleClaudeSessionEnd({ sessionId: 'resumed-session', registrationId: 'registration-before-resume' }, {
      getMemoryService: () => memoryService as never,
      getRegistrationId: () => 'registration-after-resume',
      markTerminal: vi.fn()
    });

    expect(memoryService.endSession).not.toHaveBeenCalled();
    expect(memoryService.evaluateSessionHelpfulness).not.toHaveBeenCalled();
  });
});
