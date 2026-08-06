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
import { isPromptOnlySessionSummary } from './prompt-injection-policy.js';
import type {
  CoreMemoryBlock,
  EventType,
  MemoryEvent,
  SessionStartInput,
  SessionStartOutput
} from '../../../core/types.js';

const CORE_MEMORY_BLOCK_LABELS: Record<CoreMemoryBlock['blockKey'], string> = {
  project: 'Project',
  user: 'User'
};

/**
 * Injection tiers for the session-start lane, best first.
 *
 * Unlike the prompt lane there is no query here, so candidates cannot be
 * scored — the only lever is which event types are worth injecting at all.
 * Measured over 222 session-start injections in August 2026:
 *
 *   tool_observation  118 injections, content_overlap_score 0.000
 *   agent_response     77 injections, content_overlap_score 0.123
 *   user_prompt        14 injections, content_overlap_score 0.000
 *   session_summary    13 injections, content_overlap_score 0.063
 *
 * tool_observation and user_prompt never grounded a single response, so they
 * are excluded rather than ranked. Summaries come first because they are the
 * only events written as durable outcomes; a raw agent_response is a snapshot
 * of one turn.
 */
const SESSION_START_TIERS: EventType[] = ['session_summary', 'agent_response'];

/** Per-type excerpt budgets. Summaries carry decisions, so they get more room. */
const SESSION_START_EXCERPT_BUDGET: Partial<Record<EventType, number>> = {
  session_summary: 900,
  agent_response: 400
};

const DEFAULT_EXCERPT_BUDGET = 400;

/** How many memories the recap injects. */
const SESSION_START_MAX_MEMORIES = 3;

/**
 * How many injectable-type events to scan for those memories. Counted after
 * the type filter, so this reaches weeks of history rather than hours.
 */
const SESSION_START_SCAN_WINDOW = 60;

/**
 * Picks what to inject at session start.
 *
 * This lane used to take the 3 most recent events of any type. Because
 * tool_observation is ~84% of everything stored, recency alone meant the
 * recap was mostly raw `{"toolName":...}` JSON truncated mid-token — 118
 * such injections grounded exactly nothing.
 */
export function selectSessionStartMemories(events: MemoryEvent[], limit: number): MemoryEvent[] {
  const usable = events.filter((event) => (
    SESSION_START_TIERS.includes(event.eventType)
    // The rule-based generator emits a table of contents ("Session with N
    // prompts. Topics discussed: ...") rather than an outcome. The prompt lane
    // already excludes it; this lane must too or it outranks real summaries on
    // type alone.
    && !(event.eventType === 'session_summary' && isPromptOnlySessionSummary(event.content))
    && event.content.trim().length > 0
  ));

  return usable
    .map((event, index) => ({ event, index }))
    .sort((a, b) => (
      (SESSION_START_TIERS.indexOf(a.event.eventType) - SESSION_START_TIERS.indexOf(b.event.eventType))
      || (b.event.timestamp.getTime() - a.event.timestamp.getTime())
      || (a.index - b.index)
    ))
    .slice(0, limit)
    .map((item) => item.event);
}

/**
 * Renders one memory as a single-line bullet.
 *
 * The old 150-character hard cut split JSON and sentences mid-token, leaving
 * the model a fragment it could not act on. Budgets are per type and the cut
 * backs off to the last sentence/clause boundary when there is one nearby.
 */
export function sessionStartExcerpt(event: MemoryEvent): string {
  const collapsed = event.content.trim().replace(/\s*\n+\s*/g, ' / ');
  const budget = SESSION_START_EXCERPT_BUDGET[event.eventType] ?? DEFAULT_EXCERPT_BUDGET;
  if (collapsed.length <= budget) return collapsed;

  const head = collapsed.slice(0, budget);
  const boundary = Math.max(head.lastIndexOf('. '), head.lastIndexOf(' / '), head.lastIndexOf('다 '));
  const cut = boundary >= budget * 0.6 ? head.slice(0, boundary + 1) : head;
  return `${cut.trimEnd()}...`;
}

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

    // Get recent context for this project (now automatically scoped).
    //
    // The scan is type-filtered and much wider than the 3 memories that get
    // injected. Injectable types are a small minority of a real store —
    // tool_observation alone is ~84% of events and session_summary about 2% —
    // so an unfiltered window either misses summaries entirely or has to load
    // thousands of large tool payloads to reach them.
    const recentEvents = process.env.CLAUDE_MEMORY_EVAL_DISABLE_SESSION_CONTEXT === 'true'
      ? []
      : await memoryService.getRecentEvents(SESSION_START_SCAN_WINDOW, {
        eventTypes: SESSION_START_TIERS
      });

    const injectedEvents = selectSessionStartMemories(recentEvents, SESSION_START_MAX_MEMORIES);

    if (injectedEvents.length > 0) {
      if (context) context += '\n';
      context += `## Previous Session Context\n\nYou have worked on this project before. Here are some relevant memories:\n\n`;
      const excerpts = new Map<string, string>();
      for (const event of injectedEvents) {
        const date = event.timestamp.toISOString().split('T')[0];
        const excerpt = sessionStartExcerpt(event);
        excerpts.set(event.id, excerpt);
        context += `- **${date}**: ${excerpt}\n`;
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
              // Grounding is measured against the exact text injected above,
              // not the full event.
              injectedContent: excerpts.get(event.id) ?? sessionStartExcerpt(event)
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
