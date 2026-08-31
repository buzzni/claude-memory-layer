/**
 * Session End Hook
 * Called when session ends - generates and stores session summary
 */

import { getLightweightMemoryService } from '../../../services/memory-service.js';
import type { SessionEndInput } from '../../../core/types.js';
import {
  getSessionProject,
  markSessionTerminalIfCurrent
} from '../../../core/registry/session-registry.js';
import { readStdin } from './hook-runtime.js';

type SessionEndMemoryService = ReturnType<typeof getLightweightMemoryService>;

export interface ClaudeSessionEndDeps {
  getMemoryService?: (sessionId: string) => SessionEndMemoryService;
  getRegistrationId?: (sessionId: string) => string | null;
  markTerminal?: (sessionId: string, registrationId: string | null) => void;
}

export async function main(): Promise<string> {
  try {
    // Read input from stdin (parse inside try so malformed JSON still emits a safe envelope)
    const input: SessionEndInput = JSON.parse(await readStdin());
    await handleClaudeSessionEnd(input);
    return JSON.stringify({});
  } catch (error) {
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('Memory hook error:', error);
    }
    return JSON.stringify({});
  }
}

export async function handleClaudeSessionEnd(
  input: SessionEndInput,
  deps: ClaudeSessionEndDeps = {}
): Promise<void> {
  const registrationId = (deps.getRegistrationId
    ?? ((sessionId: string) => getSessionProject(sessionId)?.registrationId ?? null))(input.session_id);
  try {
    // Use lightweight service (SQLite only, no embedder/vector - FAST!)
    const memoryService = (deps.getMemoryService ?? getLightweightMemoryService)(input.session_id);

    // Get session history
    const sessionEvents = await memoryService.getSessionHistory(input.session_id);

    if (sessionEvents.length > 0) {
      // The Stop hook already asks the daemon to build the outcome-focused
      // summary (see stop.ts / session-summary-llm.ts). This hook used to
      // also generate its own rule-based table-of-contents summary and store
      // it unconditionally — with no check for an existing summary — which
      // measurably kept producing the "Session with N prompts..." text the
      // LLM summary was built to replace, sometimes racing ahead of it.
      // endSession's own `summary` column is separate bookkeeping (not an
      // injectable session_summary event) and is fine to leave unset here.
      await memoryService.endSession(input.session_id);

      // Evaluate helpfulness of memory retrievals in this session
      try {
        await memoryService.evaluateSessionHelpfulness(input.session_id);
      } catch { /* non-critical */ }

      // Process any pending embeddings
      await memoryService.processPendingEmbeddings();
    }
  } finally {
    try {
      (deps.markTerminal ?? markSessionTerminalIfCurrent)(input.session_id, registrationId);
    } catch (error) {
      if (process.env.CLAUDE_MEMORY_DEBUG) {
        console.error('Memory session terminal marker failed:', error);
      }
    }
  }
}
