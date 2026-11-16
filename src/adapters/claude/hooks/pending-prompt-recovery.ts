import { clearPendingPrompt, readPendingPrompt } from '../../../core/turn-state.js';
import type { getLightweightMemoryServiceForProject } from '../../../services/memory-service.js';

type PromptStore = Pick<ReturnType<typeof getLightweightMemoryServiceForProject>, 'storeUserPrompt'>;

/**
 * Store the prompt a killed UserPromptSubmit hook left on disk (see the
 * pending prompt state in turn-state.ts). Called by the session's next hook.
 * A store that throws keeps the file, so the hook after that tries again;
 * storing the same prompt twice is harmless, events dedupe on session + content.
 */
export async function recoverPendingPrompt(memoryService: PromptStore, sessionId: string): Promise<void> {
  const pending = readPendingPrompt(sessionId);
  if (!pending) return;
  try {
    await memoryService.storeUserPrompt(sessionId, pending.content, {
      ...pending.metadata,
      // Stored late; keep when it was asked, as Stop does for responses.
      originalTimestamp: pending.createdAt
    });
    clearPendingPrompt(sessionId);
  } catch {
    // Left for the next hook.
  }
}
