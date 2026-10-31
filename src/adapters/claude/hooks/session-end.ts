/**
 * Session End Hook
 * Called when session ends - hands session-end work to a detached worker
 *
 * Claude Code waits for SessionEnd hooks while it shuts down, and reading a
 * long transcript again takes seconds, so the hook only records the job and
 * returns; session-end-worker.ts does the work.
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

export interface ClaudeSessionEndHookDeps extends SessionEndCapture {
  spawnWorker: (
    executable: string,
    args: string[],
    options: {
      detached: boolean;
      stdio: ['pipe', 'ignore', 'ignore'];
    }
  ) => Pick<ChildProcess, 'stdin' | 'unref'>;
  workerPath: string;
}

function defaultWorkerPath(): string {
  return path.join(path.dirname(nodeUrl.fileURLToPath(import.meta.url)), 'session-end-worker.js');
}

const realDeps: ClaudeSessionEndHookDeps = {
  spawnWorker: spawn,
  workerPath: defaultWorkerPath(),
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

export function launchClaudeSessionEndWorker(
  input: SessionEndInput,
  deps: ClaudeSessionEndHookDeps = realDeps
): boolean {
  const job = normalizeClaudeSessionEndJob(input, deps);
  if (!job) return false;

  const child = deps.spawnWorker(process.execPath, [deps.workerPath], {
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'ignore', 'ignore']
  });
  child.stdin?.on('error', () => {
    // Claude Code must not fail its shutdown when a detached worker exits early.
  });
  child.stdin?.end(JSON.stringify(job));
  child.unref();
  return true;
}

export async function main(): Promise<string> {
  try {
    // Read input from stdin (parse inside try so malformed JSON still emits a safe envelope)
    const input: SessionEndInput = JSON.parse(await readStdin());
    launchClaudeSessionEndWorker(input);
  } catch (error) {
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('Memory hook error:', error);
    }
  }
  return JSON.stringify({});
}
