/**
 * Session End Worker
 * Runs detached from the SessionEnd hook: stores the transcript messages Stop
 * missed, then does the session-end bookkeeping
 */

import { getLightweightMemoryServiceForProject } from '../../../services/memory-service.js';
import { endClaudeSession, type SessionEndBookkeepingDeps } from './session-end-bookkeeping.js';
import { reconcileSessionTranscript, type ReconcileMemoryService } from './session-end-reconcile.js';
import type { ClaudeSessionEndJob } from './session-end.js';

export interface ClaudeSessionEndDeps extends SessionEndBookkeepingDeps {
  getProjectMemoryService?: (projectPath: string) => ReconcileMemoryService;
  reconcile?: typeof reconcileSessionTranscript;
}

export async function handleClaudeSessionEnd(
  job: ClaudeSessionEndJob,
  deps: ClaudeSessionEndDeps = {}
): Promise<void> {
  // First, so the helpfulness evaluation sees every response. The project
  // store is the one Stop writes to (it is keyed by cwd as well).
  if (job.transcriptPath && job.projectPath && job.snapshot) {
    try {
      const projectService = (deps.getProjectMemoryService ?? getLightweightMemoryServiceForProject)(job.projectPath);
      const result = await (deps.reconcile ?? reconcileSessionTranscript)(
        projectService,
        job.sessionId,
        job.transcriptPath,
        job.snapshot
      );
      if (process.env.CLAUDE_MEMORY_DEBUG) {
        console.error('Session end transcript reconcile:', result);
      }
    } catch (error) {
      if (process.env.CLAUDE_MEMORY_DEBUG) {
        console.error('Session end transcript reconcile failed:', error);
      }
    }
  }

  await endClaudeSession(job, deps);
}
