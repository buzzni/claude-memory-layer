/**
 * Session Start Hook
 * Called when a new Claude Code session starts
 */

import { getLightweightMemoryService } from '../../../services/memory-service.js';
import { registerSession } from '../../../core/registry/session-registry.js';
import { ensureDaemonRunning } from './semantic-daemon-client.js';
import { readStdin } from './hook-runtime.js';
import { formatClaudeContextHookOutput, isHookEvaluationMode } from './hook-output.js';
import type { SessionStartInput, SessionStartOutput } from '../../../core/types.js';

export async function main(): Promise<string> {
  // Read input from stdin. Guard the parse so a malformed/empty body still emits
  // a valid envelope instead of throwing past the hook into an unhandled rejection.
  let input: SessionStartInput;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return formatClaudeContextHookOutput('SessionStart', '');
  }

  // Register session with project path for other hooks to find
  registerSession(input.session_id, input.cwd);

  // Start semantic daemon in the background (non-blocking) so VectorWorker
  // can process any pending embedding_outbox items immediately.
  ensureDaemonRunning().catch(() => {
    // Ignore - daemon will start on first prompt if needed
  });

  // Use lightweight service to avoid starting background workers in hook process
  const memoryService = getLightweightMemoryService(input.session_id);

  try {
    // Start session in memory service
    if (!isHookEvaluationMode()) {
      await memoryService.startSession(input.session_id, input.cwd);
    }

    // Backfill session summaries for recent sessions that ended without Stop hook
    // (crash, force-close, etc.). Run in background - non-blocking.
    if (!isHookEvaluationMode()) {
      memoryService.backfillMissingSummaries(input.session_id, 5).catch(() => {});
    }

    // Get recent context for this project (now automatically scoped)
    const recentEvents = process.env.CLAUDE_MEMORY_EVAL_DISABLE_SESSION_CONTEXT === 'true'
      ? []
      : await memoryService.getRecentEvents(10);

    let context = '';
    if (recentEvents.length > 0) {
      context = `## Previous Session Context\n\nYou have worked on this project before. Here are some relevant memories:\n\n`;
      for (const event of recentEvents.slice(0, 3)) {
        const date = event.timestamp.toISOString().split('T')[0];
        context += `- **${date}**: ${event.content.slice(0, 150)}...\n`;
      }
    }

    const output: SessionStartOutput = JSON.parse(formatClaudeContextHookOutput('SessionStart', context));
    return JSON.stringify(output);
  } catch (error) {
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('Memory hook error:', error);
    }
    return formatClaudeContextHookOutput('SessionStart', '');
  } finally {
    try {
      await memoryService.close();
    } catch {
      // Best-effort cleanup
    }
  }
}
