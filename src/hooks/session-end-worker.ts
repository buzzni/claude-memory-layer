#!/usr/bin/env node
/**
 * Detached worker the Claude session-end hook hands its work to.
 *
 * Kept light so it can acknowledge the job quickly; the session-end work is
 * loaded afterwards from session-end-handler.js next to it. A job it cannot
 * load that work for is kept and retried by a later worker.
 */
import * as fs from 'node:fs';

import { readStdin } from '../adapters/claude/hooks/hook-runtime.js';
import { runClaudeSessionEndWorker, SESSION_END_WORKER_ACK, type SessionEndHandler } from '../adapters/claude/hooks/session-end-handoff.js';
import { retryPendingSessionEndJobs, savePendingSessionEndJob } from '../adapters/claude/hooks/session-end-pending.js';

const handlerUrl = new URL('./session-end-handler.js', import.meta.url);

void runClaudeSessionEndWorker({
  readJob: () => readStdin(),
  handlerAvailable: () => fs.existsSync(handlerUrl),
  acknowledge: () => {
    // The hook may already have left; a closed pipe is not an error here.
    process.stdout.on('error', () => {});
    process.stdout.write(`${SESSION_END_WORKER_ACK}\n`);
  },
  loadHandler: async () => {
    const { handleClaudeSessionEnd } = await import(handlerUrl.href) as { handleClaudeSessionEnd: SessionEndHandler };
    return handleClaudeSessionEnd;
  },
  savePendingJob: (job, error) => savePendingSessionEndJob(job, error),
  retryPendingJobs: async (handle) => {
    await retryPendingSessionEndJobs(handle);
  }
});
