/**
 * Session End Hand-off
 *
 * The worker side of the SessionEnd hook's hand-off. It must stay light: the
 * hook waits for the acknowledgement, so the worker acknowledges a job before
 * it loads the session-end work (the memory service and its native modules).
 * Until then it has done nothing, which is what lets the hook run that work
 * itself when no acknowledgement arrives.
 */

import type { ClaudeSessionEndJob } from './session-end.js';

/** Line the worker writes once it holds the job. */
export const SESSION_END_WORKER_ACK = 'cml-session-end-ack';

export type SessionEndHandler = (job: ClaudeSessionEndJob) => Promise<void>;

export interface ClaudeSessionEndWorkerDeps {
  readJob: () => Promise<string>;
  /** Whether the session-end work can be loaded; a worker that cannot load it leaves the job to the hook. */
  handlerAvailable: () => boolean;
  acknowledge: () => void;
  loadHandler: () => Promise<SessionEndHandler>;
  /** Keeps a job the worker acknowledged but could not load the work for; the hook has already left. */
  savePendingJob: (job: ClaudeSessionEndJob, error: unknown) => void;
  /** Ends the sessions earlier workers kept, once the work has loaded and ended this one. */
  retryPendingJobs: (handle: SessionEndHandler) => Promise<void>;
}

export async function runClaudeSessionEndWorker(deps: ClaudeSessionEndWorkerDeps): Promise<void> {
  try {
    const job = JSON.parse(await deps.readJob()) as ClaudeSessionEndJob;
    if (!job.sessionId || !deps.handlerAvailable()) return;
    deps.acknowledge();
    let handle: SessionEndHandler;
    try {
      handle = await deps.loadHandler();
    } catch (error) {
      deps.savePendingJob(job, error);
      throw error;
    }
    await handle(job);
    // Only after this job succeeded: a store that is broken for every
    // session would otherwise use up the kept jobs' retries.
    await deps.retryPendingJobs(handle);
  } catch (error) {
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('Session end worker error:', error);
    }
  }
}
