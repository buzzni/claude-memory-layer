/**
 * Session End Bookkeeping
 * Ends the session, evaluates retrieval helpfulness, processes pending
 * embeddings and marks the session terminal in the registry: what the
 * SessionEnd hook did before the transcript reconcile, and still does itself
 * when no worker takes the job
 */

import { getLightweightMemoryService } from '../../../services/memory-service.js';
import {
  getSessionProject,
  markSessionTerminalIfCurrent
} from '../../../core/registry/session-registry.js';
import type { ClaudeSessionEndJob } from './session-end.js';

type SessionEndMemoryService = ReturnType<typeof getLightweightMemoryService>;

export interface SessionEndBookkeepingDeps {
  getMemoryService?: (sessionId: string) => SessionEndMemoryService;
  getRegistrationId?: (sessionId: string) => string | null;
  markTerminal?: (sessionId: string, registrationId: string | null) => void;
}

export async function endClaudeSession(
  job: Pick<ClaudeSessionEndJob, 'sessionId' | 'registrationId'>,
  deps: SessionEndBookkeepingDeps = {}
): Promise<void> {
  const { sessionId, registrationId } = job;
  try {
    // A session resumed while the worker ran is registered again under a new
    // id and is live; its own SessionEnd ends and evaluates it.
    const currentRegistrationId = (deps.getRegistrationId
      ?? ((id: string) => getSessionProject(id)?.registrationId ?? null))(sessionId);
    if (currentRegistrationId !== null && currentRegistrationId !== registrationId) return;

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
