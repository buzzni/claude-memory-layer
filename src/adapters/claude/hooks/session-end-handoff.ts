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
}

export async function runClaudeSessionEndWorker(deps: ClaudeSessionEndWorkerDeps): Promise<void> {
  try {
    const job = JSON.parse(await deps.readJob()) as ClaudeSessionEndJob;
    if (!job.sessionId || !deps.handlerAvailable()) return;
    deps.acknowledge();
    const handle = await deps.loadHandler();
    await handle(job);
  } catch (error) {
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('Session end worker error:', error);
    }
  }
}
