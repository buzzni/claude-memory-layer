/**
 * Session End Hook
 * Called when session ends - hands session-end work to a detached worker
 *
 * Claude Code waits for SessionEnd hooks while it shuts down, and reading a
 * long transcript again takes seconds, so the hook only records the job and
 * returns; session-end-worker.ts does the work. The worker acknowledges the
 * job on stdout before it does anything; a worker that is missing, fails to
 * start, cannot take the job or exits first never does any of it, so the hook
 * then runs the session-end bookkeeping itself, as it did before the worker.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as nodeUrl from 'node:url';
import * as path from 'node:path';

import type { SessionEndInput } from '../../../core/types.js';
import { getSessionProject } from '../../../core/registry/session-registry.js';
import { readTurnStateDetails } from '../../../core/turn-state.js';
import { readStdin } from './hook-runtime.js';
import type { SessionEndSnapshot } from './session-end-reconcile.js';
import { SESSION_END_WORKER_ACK, type SessionEndHandler } from './session-end-handoff.js';

/** A worker slower than this to acknowledge (a loaded machine) is left to run. */
const WORKER_ACK_TIMEOUT_MS = 1_000;

export interface ClaudeSessionEndJob {
  sessionId: string;
  /** Registration current at SessionEnd; a session resumed while the worker runs is not marked terminal. */
  registrationId: string | null;
  /** All present only when the transcript can be reconciled into the project store Stop writes to. */
  transcriptPath?: string;
  projectPath?: string;
  snapshot?: SessionEndSnapshot;
}

/** Reads of the state at SessionEnd; a session resumed while the worker runs changes all of them. */
export interface SessionEndCapture {
  getRegistrationId: (sessionId: string) => string | null;
  getOpenTurn: (sessionId: string) => SessionEndSnapshot['openTurn'];
  getTranscriptBytes: (transcriptPath: string) => number | null;
  now: () => Date;
}

type SessionEndWorkerProcess = Pick<ChildProcess, 'stdin' | 'stdout' | 'exitCode' | 'on' | 'kill' | 'unref'>;

export interface ClaudeSessionEndHookDeps extends SessionEndCapture {
  spawnWorker: (
    executable: string,
    args: string[],
    options: {
      detached: boolean;
      stdio: ['pipe', 'pipe', 'ignore'];
    }
  ) => SessionEndWorkerProcess;
  workerPath: string;
  workerExists: (workerPath: string) => boolean;
  ackTimeoutMs: number;
  /** The session-end bookkeeping, run in the hook when no worker took the job. */
  runInline: SessionEndHandler;
}

/**
 * Bundled into the hook, so the hook alone can still end a session whatever
 * else is missing from the install. Evaluated only when the worker did not
 * take the job.
 */
async function runSessionEndInline(job: ClaudeSessionEndJob): Promise<void> {
  const { endClaudeSession } = await import('./session-end-bookkeeping.js');
  await endClaudeSession(job);
}

function defaultWorkerPath(): string {
  return path.join(path.dirname(nodeUrl.fileURLToPath(import.meta.url)), 'session-end-worker.js');
}

const realDeps: ClaudeSessionEndHookDeps = {
  spawnWorker: spawn,
  workerPath: defaultWorkerPath(),
  workerExists: fs.existsSync,
  ackTimeoutMs: WORKER_ACK_TIMEOUT_MS,
  runInline: runSessionEndInline,
  getRegistrationId: (sessionId) => getSessionProject(sessionId)?.registrationId ?? null,
  getOpenTurn: readTurnStateDetails,
  getTranscriptBytes: (transcriptPath) => {
    try {
      return fs.statSync(transcriptPath).size;
    } catch {
      return null;
    }
  },
  now: () => new Date()
};

export function normalizeClaudeSessionEndJob(
  input: SessionEndInput,
  capture: SessionEndCapture
): ClaudeSessionEndJob | null {
  const sessionId = typeof input.session_id === 'string' ? input.session_id.trim() : '';
  if (!sessionId) return null;

  const job: ClaudeSessionEndJob = { sessionId, registrationId: capture.getRegistrationId(sessionId) };
  const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path.trim() : '';
  const projectPath = typeof input.cwd === 'string' ? input.cwd.trim() : '';
  if (!transcriptPath || !projectPath || !path.isAbsolute(projectPath)) return job;

  const transcriptBytes = capture.getTranscriptBytes(transcriptPath);
  if (transcriptBytes === null) return job;
  job.transcriptPath = transcriptPath;
  job.projectPath = projectPath;
  job.snapshot = {
    transcriptBytes,
    endedAt: capture.now().toISOString(),
    openTurn: capture.getOpenTurn(sessionId)
  };
  return job;
}

/**
 * Give the job to a detached worker. Resolves true once the worker holds it
 * (or is still starting when the wait ends), false when it never got it.
 */
function handOffToWorker(job: ClaudeSessionEndJob, deps: ClaudeSessionEndHookDeps): Promise<boolean> {
  if (!deps.workerExists(deps.workerPath)) return Promise.resolve(false);

  let child: SessionEndWorkerProcess;
  try {
    child = deps.spawnWorker(process.execPath, [deps.workerPath], {
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'ignore']
    });
  } catch {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    const settle = (handedOff: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      // A worker that never acknowledged has done nothing; stop it so the
      // hook's own run is the only one.
      if (!handedOff && child.exitCode === null) {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
      }
      child.unref();
      resolve(handedOff);
    };
    const timer = setTimeout(() => settle(true), deps.ackTimeoutMs);

    child.on('error', () => settle(false));
    child.on('exit', () => settle(false));
    child.stdout?.on('data', (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes(SESSION_END_WORKER_ACK)) settle(true);
    });
    child.stdin?.on('error', () => settle(false));
    child.stdin?.end(JSON.stringify(job));
  });
}

export async function runClaudeSessionEnd(
  input: SessionEndInput,
  deps: ClaudeSessionEndHookDeps = realDeps
): Promise<void> {
  const job = normalizeClaudeSessionEndJob(input, deps);
  if (!job) return;
  if (await handOffToWorker(job, deps)) return;

  // The transcript reconcile is left out: it can take seconds, which Claude
  // Code does not wait for at shutdown.
  await deps.runInline({ sessionId: job.sessionId, registrationId: job.registrationId });
}

export async function main(): Promise<string> {
  try {
    // Read input from stdin (parse inside try so malformed JSON still emits a safe envelope)
    const input: SessionEndInput = JSON.parse(await readStdin());
    await runClaudeSessionEnd(input);
  } catch (error) {
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('Memory hook error:', error);
    }
  }
  return JSON.stringify({});
}
