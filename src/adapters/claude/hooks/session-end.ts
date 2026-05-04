/**
 * Session End Hook
 * Called when session ends - generates and stores session summary
 */

import { getLightweightMemoryService } from '../../../services/memory-service.js';
import type { SessionEndInput } from '../../../core/types.js';
import { generateSessionSummary } from '../transcript/turn-reconstructor.js';

export async function main(): Promise<void> {
  // Read input from stdin
  const inputData = await readStdin();
  const input: SessionEndInput = JSON.parse(inputData);

  // Use lightweight service (SQLite only, no embedder/vector - FAST!)
  const memoryService = getLightweightMemoryService(input.session_id);

  try {
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

    console.log(JSON.stringify({}));
  } catch (error) {
    console.error('Memory hook error:', error);
    console.log(JSON.stringify({}));
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
  });
}
