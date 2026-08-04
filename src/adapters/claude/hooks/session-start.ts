/**
 * Session Start Hook
 * Called when a new Claude Code session starts
 */

import { randomUUID } from 'crypto';
import { getLightweightMemoryService } from '../../../services/memory-service.js';
import { registerSession } from '../../../core/registry/session-registry.js';
import { ensureDaemonRunning, scheduleSessionSummary } from './semantic-daemon-client.js';
import { isLlmSummaryEnabled } from '../../llm/session-summary-llm.js';
import { spawnToolObservationVectorAutoHealIfNeeded } from './tool-observation-vector-auto-heal-client.js';
import { readStdin } from './hook-runtime.js';
import { formatClaudeContextHookOutput, isHookEvaluationMode } from './hook-output.js';
import type { CoreMemoryBlock, SessionStartInput, SessionStartOutput } from '../../../core/types.js';

const CORE_MEMORY_BLOCK_LABELS: Record<CoreMemoryBlock['blockKey'], string> = {
  project: 'Project',
  user: 'User'
};

/**
 * Renders core memory blocks unconditionally (no query, no scoring) — the
 * Letta-style "always in context" section. Empty/missing blocks are skipped
 * silently so an unused block never pads out the context with nothing.
 */
export function formatCoreMemoryBlockContext(blocks: CoreMemoryBlock[]): string {
  const nonEmpty = blocks.filter((block) => block.content.trim().length > 0);
  if (nonEmpty.length === 0) return '';

  let context = '## Core Memory\n\n';
  for (const block of nonEmpty) {
    context += `**${CORE_MEMORY_BLOCK_LABELS[block.blockKey]}**: ${block.content.trim()}\n\n`;
  }
  return context.trimEnd() + '\n';
}

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

  // Self-heal stores that embedded tool_observation vectors before the
  // ingest-side fix existed. Cheap no-op once healed; the real cleanup (if
  // needed) runs detached so a large backlog can't block this hook.
  spawnToolObservationVectorAutoHealIfNeeded(input.cwd).catch(() => {
    // Best-effort; next session's cheap check will retry.
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
    //
    // Routed through the same daemon-scheduled LLM path Stop uses, not the
    // local rule-based generator: this backfill previously called
    // generateSessionSummary directly, which kept reintroducing the
    // table-of-contents summary shape the LLM path exists to replace, on
    // every session that needed a backfill.
    if (!isHookEvaluationMode()) {
      if (isLlmSummaryEnabled()) {
        memoryService.getSessionsWithoutSummary(input.session_id, 5)
          .then((sessionIds) => Promise.all(
            sessionIds.map((sessionId) => scheduleSessionSummary(sessionId).catch(() => {}))
          ))
          .catch(() => {});
      } else {
        memoryService.backfillMissingSummaries(input.session_id, 5).catch(() => {});
      }
    }

    // Core memory blocks are unconditional (no query, no scoring) and are
    // curated by the agent itself via mem-core-block-update, so they come
    // first — ahead of the incidental recent-events recap below.
    let context = '';
    if (process.env.CLAUDE_MEMORY_EVAL_DISABLE_SESSION_CONTEXT !== 'true') {
      try {
        const coreBlocks = await memoryService.getCoreMemoryBlocks();
        context = formatCoreMemoryBlockContext(coreBlocks);
      } catch {
        // Core memory injection is supplementary; never fail session start over it.
      }
    }

    // Get recent context for this project (now automatically scoped)
    const recentEvents = process.env.CLAUDE_MEMORY_EVAL_DISABLE_SESSION_CONTEXT === 'true'
      ? []
      : await memoryService.getRecentEvents(10);

    if (recentEvents.length > 0) {
      if (context) context += '\n';
      const injectedEvents = recentEvents.slice(0, 3);
      context += `## Previous Session Context\n\nYou have worked on this project before. Here are some relevant memories:\n\n`;
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
