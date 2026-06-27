/**
 * Session End Hook
 * Called when session ends - generates and stores session summary
 */

import { getLightweightMemoryService } from '../../../services/memory-service.js';
import type { SessionEndInput } from '../../../core/types.js';
import { generateSessionSummary } from '../transcript/turn-reconstructor.js';
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
      // Generate a simple session summary
      const summary = generateSessionSummary(sessionEvents);

      // Store session summary
      await memoryService.storeSessionSummary(input.session_id, summary);

      // End session with summary
      await memoryService.endSession(input.session_id, summary);

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
