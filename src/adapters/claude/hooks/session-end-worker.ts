/**
 * Session End Worker
 * Runs detached from the SessionEnd hook: stores the transcript messages Stop
 * missed, ends the session, evaluates retrieval helpfulness, and marks the
 * session terminal in the registry
 */

import {
  getLightweightMemoryService,
  getLightweightMemoryServiceForProject
} from '../../../services/memory-service.js';
import { markSessionTerminalIfCurrent } from '../../../core/registry/session-registry.js';
import { readStdin } from './hook-runtime.js';
import { reconcileSessionTranscript, type ReconcileMemoryService } from './session-end-reconcile.js';
import type { ClaudeSessionEndJob } from './session-end.js';

type SessionEndMemoryService = ReturnType<typeof getLightweightMemoryService>;

export interface ClaudeSessionEndDeps {
  getMemoryService?: (sessionId: string) => SessionEndMemoryService;
  getProjectMemoryService?: (projectPath: string) => ReconcileMemoryService;
  reconcile?: typeof reconcileSessionTranscript;
  markTerminal?: (sessionId: string, registrationId: string | null) => void;
}

export async function handleClaudeSessionEnd(
  job: ClaudeSessionEndJob,
  deps: ClaudeSessionEndDeps = {}
): Promise<void> {
  const { sessionId, registrationId } = job;
  try {
    // First, so the helpfulness evaluation below sees every response. The
    // project store is the one Stop writes to (it is keyed by cwd as well).
    if (job.transcriptPath && job.projectPath) {
      try {
        const projectService = (deps.getProjectMemoryService ?? getLightweightMemoryServiceForProject)(job.projectPath);
        const result = await (deps.reconcile ?? reconcileSessionTranscript)(projectService, sessionId, job.transcriptPath);
        if (process.env.CLAUDE_MEMORY_DEBUG) {
          console.error('Session end transcript reconcile:', result);
        }
      } catch (error) {
        if (process.env.CLAUDE_MEMORY_DEBUG) {
          console.error('Session end transcript reconcile failed:', error);
        }
      }
    }

    // Use lightweight service (SQLite only, no embedder/vector - FAST!)
    const memoryService = (deps.getMemoryService ?? getLightweightMemoryService)(sessionId);

    // Get session history
    const sessionEvents = await memoryService.getSessionHistory(sessionId);

    if (sessionEvents.length > 0) {
      // The Stop hook already asks the daemon to build the outcome-focused
      // summary (see stop.ts / session-summary-llm.ts). This hook used to
      // also generate its own rule-based table-of-contents summary and store
      // it unconditionally — with no check for an existing summary — which
      // measurably kept producing the "Session with N prompts..." text the
      // LLM summary was built to replace, sometimes racing ahead of it.
      // endSession's own `summary` column is separate bookkeeping (not an
      // injectable session_summary event) and is fine to leave unset here.
      await memoryService.endSession(sessionId);

      // Evaluate helpfulness of memory retrievals in this session
      try {
        await memoryService.evaluateSessionHelpfulness(sessionId);
      } catch { /* non-critical */ }

      // Process any pending embeddings
      await memoryService.processPendingEmbeddings();
    }
  } finally {
    try {
      (deps.markTerminal ?? markSessionTerminalIfCurrent)(sessionId, registrationId);
    } catch (error) {
      if (process.env.CLAUDE_MEMORY_DEBUG) {
        console.error('Memory session terminal marker failed:', error);
      }
    }
  }
}

export async function main(): Promise<void> {
  try {
    const job = JSON.parse(await readStdin()) as ClaudeSessionEndJob;
    if (!job.sessionId) return;
    await handleClaudeSessionEnd(job);
  } catch (error) {
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('Session end worker error:', error);
    }
  }
}
