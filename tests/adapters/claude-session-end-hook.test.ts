import { describe, expect, it, vi } from 'vitest';

import { handleClaudeSessionEnd } from '../../src/adapters/claude/hooks/session-end.js';

describe('Claude SessionEnd hook', () => {
  it('marks the session terminal even when deferred embedding processing fails', async () => {
    const markTerminal = vi.fn();
    const memoryService = {
      getSessionHistory: vi.fn(async () => [{ id: 'event-1' }]),
      endSession: vi.fn(async () => undefined),
      evaluateSessionHelpfulness: vi.fn(async () => undefined),
      processPendingEmbeddings: vi.fn(async () => {
        throw new Error('injected embedding failure');
      })
    };

    await expect(handleClaudeSessionEnd({ session_id: 'session-1' } as never, {
      getMemoryService: () => memoryService as never,
      getRegistrationId: () => 'registration-1',
      markTerminal
    })).rejects.toThrow('injected embedding failure');
    expect(markTerminal).toHaveBeenCalledWith('session-1', 'registration-1');
  });

  it('keeps terminal-marker failures non-fatal to an otherwise successful hook', async () => {
    const memoryService = {
      getSessionHistory: vi.fn(async () => []),
      endSession: vi.fn(),
      evaluateSessionHelpfulness: vi.fn(),
      processPendingEmbeddings: vi.fn()
    };

    await expect(handleClaudeSessionEnd({ session_id: 'session-2' } as never, {
      getMemoryService: () => memoryService as never,
      markTerminal: () => {
        throw new Error('registry unavailable');
      }
    })).resolves.toBeUndefined();
  });

  it('does not let late SessionEnd work mark a resumed session terminal', async () => {
    let registrationId = 'registration-before-resume';
    let terminal = false;
    const memoryService = {
      getSessionHistory: vi.fn(async () => {
        registrationId = 'registration-after-resume';
        return [];
      }),
      endSession: vi.fn(),
      evaluateSessionHelpfulness: vi.fn(),
      processPendingEmbeddings: vi.fn()
    };

    await handleClaudeSessionEnd({ session_id: 'resumed-session' } as never, {
      getMemoryService: () => memoryService as never,
      getRegistrationId: () => registrationId,
      markTerminal: (_sessionId, expectedRegistrationId) => {
        if (registrationId === expectedRegistrationId) terminal = true;
      }
    });

    expect(terminal).toBe(false);
  });
});
