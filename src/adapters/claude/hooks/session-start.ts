/**
 * Session Start Hook
 * Called when a new Claude Code session starts
 */

import { randomUUID } from 'crypto';
import { getLightweightMemoryService } from '../../../services/memory-service.js';
import { registerSession } from '../../../core/registry/session-registry.js';
import { ensureDaemonRunning } from './semantic-daemon-client.js';
import { readStdin } from './hook-runtime.js';
import type { SessionStartInput, SessionStartOutput } from '../../../core/types.js';

export async function main(): Promise<string> {
  // Read input from stdin. Guard the parse so a malformed/empty body still emits
  // a valid envelope instead of throwing past the hook into an unhandled rejection.
  let input: SessionStartInput;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return JSON.stringify({ context: '' });
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
    await memoryService.startSession(input.session_id, input.cwd);

    // Backfill session summaries for recent sessions that ended without Stop hook
    // (crash, force-close, etc.). Run in background - non-blocking.
    memoryService.backfillMissingSummaries(input.session_id, 5).catch(() => {});

    // Get recent context for this project (now automatically scoped)
    const recentEvents = await memoryService.getRecentEvents(10);

    let context = '';
    if (recentEvents.length > 0) {
      const injectedEvents = recentEvents.slice(0, 3);
      context = `## Previous Session Context\n\nYou have worked on this project before. Here are some relevant memories:\n\n`;
      for (const event of injectedEvents) {
        const date = event.timestamp.toISOString().split('T')[0];
        context += `- **${date}**: ${event.content.slice(0, 150)}...\n`;
      }

      // Session-start injections used to be invisible to usefulness metrics.
      // Track them like prompt-time retrievals so helpfulness evaluation and
      // the evidence history cover this injection path too. One shared batch
      // id groups the injected memories into a single history entry.
      const batchTraceId = randomUUID();
      for (const event of injectedEvents) {
        try {
          await memoryService.recordRetrieval(
            event.id,
            input.session_id,
            0.5,
            '[session-start] recent project context',
            {
              traceId: batchTraceId,
              source: 'session_start',
              // Only the first 150 chars are injected above — grounding must
              // be measured against that snapshot, not the full event.
              injectedContent: event.content.slice(0, 150)
            }
          );
        } catch { /* non-critical telemetry */ }
      }
    }

    const output: SessionStartOutput = { context };
    return JSON.stringify(output);
  } catch (error) {
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('Memory hook error:', error);
    }
    return JSON.stringify({ context: '' });
  } finally {
    try {
      await memoryService.close();
    } catch {
      // Best-effort cleanup
    }
  }
}
