import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  normalizeClaudeSessionEndJob,
  runClaudeSessionEnd,
  sessionEndWorkerInstalled
} from '../../src/adapters/claude/hooks/session-end.js';
import {
  SESSION_END_WORKER_ACK,
  runClaudeSessionEndWorker
} from '../../src/adapters/claude/hooks/session-end-handoff.js';
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

});

/** A spawned worker as the hook sees it: pipes and process events it can fire. */
class FakeWorker extends EventEmitter {
  stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  exitCode: number | null = null;
  unref = vi.fn();
  kill = vi.fn(() => true);
}

describe('Claude SessionEnd hook hand-off', () => {
  const capture = {
    getRegistrationId: () => 'registration-1',
    getOpenTurn: () => null,
    getTranscriptBytes: () => 4096,
    now: () => new Date('2026-10-31T12:00:00.000Z')
  };

  function deps(worker: FakeWorker | (() => never), overrides: Record<string, unknown> = {}) {
    const runInline = vi.fn(async () => undefined);
    const spawnWorker = vi.fn(typeof worker === 'function' ? worker : () => worker);
    return {
      runInline,
      spawnWorker,
      deps: {
        ...capture,
        spawnWorker: spawnWorker as never,
        workerPath: '/plugin/hooks/session-end-worker.js',
        workerExists: () => true,
        ackTimeoutMs: 1_000,
        runInline,
        ...overrides
      }
    };
  }

  const inlineJob = { sessionId: 'session-1', registrationId: 'registration-1' };

  it('hands the job to a detached worker and leaves once the worker acknowledges it', async () => {
    const worker = new FakeWorker();
    const { deps: hookDeps, runInline, spawnWorker } = deps(worker);

    const run = runClaudeSessionEnd(validInput, hookDeps);
    worker.stdout.emit('data', Buffer.from(`${SESSION_END_WORKER_ACK}\n`));
    await run;

    expect(spawnWorker).toHaveBeenCalledWith(
      process.execPath,
      ['/plugin/hooks/session-end-worker.js'],
      { detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'] }
    );
    expect(JSON.parse(worker.stdin.end.mock.calls[0][0])).toEqual(normalizeClaudeSessionEndJob(validInput, capture));
    expect(worker.stdout.destroy).toHaveBeenCalled();
    expect(worker.unref).toHaveBeenCalled();
    expect(worker.kill).not.toHaveBeenCalled();
    expect(runInline).not.toHaveBeenCalled();
  });

  it('ends the session itself when the worker file is missing, as in an install built before the worker existed', async () => {
    const { deps: hookDeps, runInline, spawnWorker } = deps(new FakeWorker(), { workerExists: () => false });

    await runClaudeSessionEnd(validInput, hookDeps);

    expect(spawnWorker).not.toHaveBeenCalled();
    expect(runInline).toHaveBeenCalledWith(inlineJob);
  });

  it('ends the session itself when spawning throws', async () => {
    const { deps: hookDeps, runInline } = deps(() => {
      throw new Error('spawn EAGAIN');
    });

    await runClaudeSessionEnd(validInput, hookDeps);

    expect(runInline).toHaveBeenCalledWith(inlineJob);
  });

  it('ends the session itself when the worker process fails to start', async () => {
    const worker = new FakeWorker();
    const { deps: hookDeps, runInline } = deps(worker);

    const run = runClaudeSessionEnd(validInput, hookDeps);
    worker.emit('error', new Error('spawn ENOENT'));
    await run;

    expect(runInline).toHaveBeenCalledWith(inlineJob);
  });

  it('ends the session itself and stops the worker when the job cannot be written to it', async () => {
    const worker = new FakeWorker();
    const { deps: hookDeps, runInline } = deps(worker);

    const run = runClaudeSessionEnd(validInput, hookDeps);
    worker.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    await run;

    expect(worker.kill).toHaveBeenCalled();
    expect(runInline).toHaveBeenCalledWith(inlineJob);
  });

  it('ends the session itself when the worker exits before acknowledging the job', async () => {
    const worker = new FakeWorker();
    const { deps: hookDeps, runInline } = deps(worker);

    const run = runClaudeSessionEnd(validInput, hookDeps);
    worker.exitCode = 1;
    worker.emit('exit', 1, null);
    await run;

    expect(runInline).toHaveBeenCalledWith(inlineJob);
  });

  it('leaves a worker that is slow to acknowledge running instead of doing its work twice', async () => {
    const worker = new FakeWorker();
    const { deps: hookDeps, runInline } = deps(worker, { ackTimeoutMs: 5 });

    await runClaudeSessionEnd(validInput, hookDeps);

    expect(worker.unref).toHaveBeenCalled();
    expect(worker.kill).not.toHaveBeenCalled();
    expect(runInline).not.toHaveBeenCalled();
  });

  describe('with a real worker process', () => {
    let dir = '';
    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'cml-session-end-handoff-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function workerScript(source: string): string {
      const file = path.join(dir, 'worker.mjs');
      writeFileSync(file, source, 'utf8');
      return file;
    }

    it('counts the worker as installed only with the session-end work next to it', () => {
      const worker = workerScript('');
      expect(sessionEndWorkerInstalled(worker)).toBe(false);
      writeFileSync(path.join(dir, 'session-end-handler.js'), '', 'utf8');
      expect(sessionEndWorkerInstalled(worker)).toBe(true);
      expect(sessionEndWorkerInstalled(path.join(dir, 'missing-worker.js'))).toBe(false);
    });

    it('ends the session itself when the worker dies right after it starts', async () => {
      const { deps: hookDeps, runInline } = deps(new FakeWorker(), {
        spawnWorker: spawn,
        workerPath: workerScript('process.exit(1);')
      });

      await runClaudeSessionEnd(validInput, hookDeps);

      expect(runInline).toHaveBeenCalledWith(inlineJob);
    });

    it('leaves as soon as a real worker acknowledges the job', async () => {
      const received = path.join(dir, 'received.json');
      const { deps: hookDeps, runInline } = deps(new FakeWorker(), {
        spawnWorker: spawn,
        workerPath: workerScript(`
          import { writeFileSync } from 'node:fs';
          let data = '';
          process.stdin.on('data', (chunk) => { data += chunk; });
          process.stdin.on('end', () => {
            writeFileSync(${JSON.stringify(received)}, data);
            process.stdout.write(${JSON.stringify(`${SESSION_END_WORKER_ACK}\n`)});
          });
        `)
      });

      await runClaudeSessionEnd(validInput, hookDeps);

      expect(runInline).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(received, 'utf8')).sessionId).toBe('session-1');
    });
  });
});

describe('Claude SessionEnd worker hand-off', () => {
  const validJob = async () => JSON.stringify({ sessionId: 'session-1', registrationId: null });

  it('acknowledges a job before loading the session-end work, and only a valid one', async () => {
    const order: string[] = [];
    const handle = vi.fn(async () => { order.push('handle'); });

    await runClaudeSessionEndWorker({
      readJob: validJob,
      handlerAvailable: () => true,
      acknowledge: () => order.push('ack'),
      loadHandler: async () => {
        order.push('load');
        return handle;
      }
    });
    await runClaudeSessionEndWorker({
      readJob: async () => 'not json',
      handlerAvailable: () => true,
      acknowledge: () => order.push('ack-invalid'),
      loadHandler: async () => handle
    });

    expect(order).toEqual(['ack', 'load', 'handle']);
    expect(handle).toHaveBeenCalledWith({ sessionId: 'session-1', registrationId: null });
  });

  it('leaves the job to the hook when the session-end work it would load is missing', async () => {
    const acknowledge = vi.fn();
    const loadHandler = vi.fn();

    await runClaudeSessionEndWorker({ readJob: validJob, handlerAvailable: () => false, acknowledge, loadHandler });

    expect(acknowledge).not.toHaveBeenCalled();
    expect(loadHandler).not.toHaveBeenCalled();
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
