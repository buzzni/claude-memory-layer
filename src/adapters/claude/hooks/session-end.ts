/**
 * Session End Hook
 * Called when session ends - generates and stores session summary
 */

import { getLightweightMemoryService } from '../../../services/memory-service.js';
import type { SessionEndInput } from '../../../core/types.js';
import { readStdin } from './hook-runtime.js';

export async function main(): Promise<string> {
  try {
    // Read input from stdin (parse inside try so malformed JSON still emits a safe envelope)
    const input: SessionEndInput = JSON.parse(await readStdin());

    // Use lightweight service (SQLite only, no embedder/vector - FAST!)
    const memoryService = getLightweightMemoryService(input.session_id);

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

    return JSON.stringify({});
  } catch (error) {
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('Memory hook error:', error);
    }
    return JSON.stringify({});
  }
}
