/**
 * Session Start Hook
 * Called when a new Claude Code session starts
 */

import { randomUUID } from 'crypto';
import { getLightweightMemoryServiceForProject } from '../../../services/memory-service.js';
import { registerSession } from '../../../core/registry/session-registry.js';
import { ensureDaemonRunning, scheduleSessionSummary } from './semantic-daemon-client.js';
import { isLlmSummaryEnabled } from '../../llm/session-summary-llm.js';
import { spawnToolObservationVectorAutoHealIfNeeded } from './tool-observation-vector-auto-heal-client.js';
import {
  resolveCanonicalMemoryActorId,
  type CanonicalMemoryInjection
} from '../../../core/operations/canonical-memory-injection-service.js';
import { readStdin } from './hook-runtime.js';
import { formatClaudeContextHookOutput, isHookEvaluationMode } from './hook-output.js';
import { isPromptOnlySessionSummary } from './prompt-injection-policy.js';
import {
  formatMemoryReferenceContext,
  memoryEventReferenceItem,
  memoryReferenceSummary
} from '../../../core/memory-reference-context.js';
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
 * Event types worth injecting at session start.
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
 * are excluded. The remaining two are NOT ranked against each other by type —
 * see SESSION_START_MAX_SUMMARIES for why.
 */
const SESSION_START_TIERS: EventType[] = ['session_summary', 'agent_response'];

/**
 * How many of the injected memories may be session summaries.
 *
 * This used to be unbounded, with event type as the *primary* sort key and
 * session_summary ranked above agent_response — on the theory that summaries
 * are durable outcomes while a response is a snapshot of one turn. A store
 * always has more than three summaries inside the scan window, so in practice
 * that meant agent_response was never injected at all.
 *
 * Measured across six active stores, that ranking cut session-start grounding
 * by an order of magnitude:
 *
 *   before (recency-led, mostly agent_response)  150 scored, overlap 0.0810, 12.0% grounded
 *   after  (type-led, entirely session_summary)   87 scored, overlap 0.0084,  1.1% grounded
 *
 * The reason shows up immediately in the injected text. An agent_response
 * carries the concrete tokens the next prompt reuses — file paths, PR numbers,
 * branch names, HEAD SHAs — and scored 0.53-0.94. A summary is abstract prose
 * ("- 결정: ... / - 제약: ...") that shares almost no literal token with what
 * the user types next, and scored 0.
 *
 * Summaries still earn one slot: they are the only thing that survives a
 * session boundary intact. They just cannot crowd out the grounded type.
 */
const SESSION_START_MAX_SUMMARIES = 1;

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
 * Collapses a memory to a comparison key so the same outcome is not injected
 * twice. Summaries get regenerated (Stop hook, then the crash backfill) and
 * land as distinct events with byte-identical text, which showed up in
 * production as the same bullet repeated back-to-back in one recap.
 */
function dedupeKeyFor(event: MemoryEvent): string {
  return event.content.trim().replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * Picks what to inject at session start.
 *
 * This lane used to take the 3 most recent events of any type. Because
 * tool_observation is ~84% of everything stored, recency alone meant the
 * recap was mostly raw `{"toolName":...}` JSON truncated mid-token — 118
 * such injections grounded exactly nothing.
 *
 * Selection is recency-first within the injectable types, with summaries
 * capped (see SESSION_START_MAX_SUMMARIES) rather than ranked above responses.
 */
export function selectSessionStartMemories(events: MemoryEvent[], limit: number): MemoryEvent[] {
  const usable = events.filter((event) => (
    SESSION_START_TIERS.includes(event.eventType)
    // The rule-based generator emits a table of contents ("Session with N
    // prompts. Topics discussed: ...") rather than an outcome. The prompt lane
    // already excludes it; this lane must too or it takes the summary slot away
    // from a real one.
    && !(event.eventType === 'session_summary' && isPromptOnlySessionSummary(event.content))
    && event.content.trim().length > 0
  ));

  const byRecency = usable
    .map((event, index) => ({ event, index }))
    .sort((a, b) => (
      (b.event.timestamp.getTime() - a.event.timestamp.getTime())
      || (a.index - b.index)
    ));

  const selected: MemoryEvent[] = [];
  const seen = new Set<string>();
  let summaries = 0;

  for (const { event } of byRecency) {
    if (selected.length >= limit) break;
    if (event.eventType === 'session_summary') {
      if (summaries >= SESSION_START_MAX_SUMMARIES) continue;
      summaries += 1;
    }
    const key = dedupeKeyFor(event);
    if (seen.has(key)) {
      if (event.eventType === 'session_summary') summaries -= 1;
      continue;
    }
    seen.add(key);
    selected.push(event);
  }

  return selected;
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
export function formatCoreMemoryBlockContext(
  blocks: Array<CoreMemoryBlock | CanonicalMemoryInjection<CoreMemoryBlock>>
): string {
  const injected = blocks.map((item): CanonicalMemoryInjection<CoreMemoryBlock> => (
    'value' in item
      ? item
      : { value: item, injectionMode: 'direct', priority: 0 }
  ));
  const nonEmpty = injected.filter(({ value }) => value.content.trim().length > 0);
  if (nonEmpty.length === 0) return '';

  let context = '## Core Memory\n\n';
  for (const { value: block, injectionMode } of nonEmpty) {
    const content = injectionMode === 'direct'
      ? block.content.trim()
      : injectionMode === 'summary'
        ? compactCoreMemorySummary(block.content)
        : `[reference: use mem-core-block-get for ${block.blockKey} block]`;
    context += `**${CORE_MEMORY_BLOCK_LABELS[block.blockKey]}**: ${content}\n\n`;
  }
  return context.trimEnd() + '\n';
}

function compactCoreMemorySummary(content: string): string {
  const normalized = content.trim().replace(/\s+/g, ' ');
  return normalized.length <= 320 ? normalized : `${normalized.slice(0, 317)}...`;
}

/**
 * specs/lesson-recall-hooks R1 — curated lesson index for the session prompt.
 *
 * Mirrors hermes' MEMORY.md snapshot (whole bounded file at session start, no
 * retrieval) crossed with its skills index (name + one-liner always, body on
 * demand). Only name and trigger go in; the body is fetched with mem-lesson-get.
 * Items keep repository order (confidence DESC, updated_at DESC) and fill until
 * the character budget would be exceeded.
 */
const SESSION_START_LESSON_BUDGET_DEFAULT = 2400;
const SESSION_START_LESSON_TRIGGER_CHARS = 90;

export function sessionStartLessonBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CLAUDE_MEMORY_SESSION_START_LESSON_BUDGET;
  if (raw === undefined || raw === '') return SESSION_START_LESSON_BUDGET_DEFAULT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : SESSION_START_LESSON_BUDGET_DEFAULT;
}

function clipLessonTrigger(trigger: string): string {
  const normalized = trigger.replace(/\s+/g, ' ').trim();
  return normalized.length <= SESSION_START_LESSON_TRIGGER_CHARS
    ? normalized
    : `${normalized.slice(0, SESSION_START_LESSON_TRIGGER_CHARS - 1)}…`;
}

export function formatLessonIndexContext(
  lessons: ReadonlyArray<{ name: string; trigger: string }>,
  options: { budgetChars: number; totalCount: number }
): string {
  const header = '## Project Lessons\n\n'
    + 'Curated lessons from earlier sessions in this project — the trigger says when each applies. '
    + 'When one matches the task at hand, open it with `mem-lesson-get` (name) before acting; '
    + '`mem-lesson-list` shows everything.\n\n';
  const footer = (shown: number) =>
    `\n(${shown} of ${options.totalCount} lessons shown; the rest are reachable with \`mem-lesson-list\`.)\n`;
  const items: string[] = [];
  for (const lesson of lessons) {
    const line = `- ${lesson.name.trim()} — ${clipLessonTrigger(lesson.trigger)}\n`;
    const candidate = header + items.join('') + line + footer(items.length + 1);
    if (candidate.length > options.budgetChars) break;
    items.push(line);
  }
  if (items.length === 0) return '';
  return header + items.join('') + footer(items.length);
}

export interface SessionStartMainOptions {
  contextPresentation?: 'evidence' | 'reference';
}

export function registerSessionBestEffort(
  sessionId: string,
  projectPath: string,
  register: typeof registerSession = registerSession
): boolean {
  try {
    register(sessionId, projectPath);
    return true;
  } catch (error) {
    // The explicit cwd remains authoritative for this hook. Registry failure
    // may reduce routing quality for later cwd-less hooks, but must not suppress
    // project-scoped session startup or context delivery now.
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('Memory session registration failed:', error);
    }
    return false;
  }
}

export async function main(options: SessionStartMainOptions = {}): Promise<string> {
  // Read input from stdin. Guard the parse so a malformed/empty body still emits
  // a valid envelope instead of throwing past the hook into an unhandled rejection.
  let input: SessionStartInput;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return formatClaudeContextHookOutput('SessionStart', '');
  }

  // Register session with project path for other hooks to find
  registerSessionBestEffort(input.session_id, input.cwd);

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
  // SessionStart already carries the authoritative cwd. Resolve from it
  // directly so a missing/stale auxiliary registry can never route this hook
  // into another project's store.
  const memoryService = getLightweightMemoryServiceForProject(input.cwd);

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

    // Core memory blocks remain a no-query/no-scoring lane and come before
    // incidental recent events. Once asset enforcement is enabled, the
    // service filters this lane through the active actor binding.
    let context = '';
    if (process.env.CLAUDE_MEMORY_EVAL_DISABLE_SESSION_CONTEXT !== 'true') {
      try {
        const coreBlocks = await memoryService.getCoreMemoryBlockInjections(
          resolveCanonicalMemoryActorId(input.actor_id)
        );
        context = formatCoreMemoryBlockContext(coreBlocks);
        const deliveredCoreBlockIds = coreBlocks
          .filter((item) => ('value' in item ? item.value : item).content.trim().length > 0)
          .map((item) => `core:${('value' in item ? item.value : item).blockKey}`);
        if (!isHookEvaluationMode() && deliveredCoreBlockIds.length > 0) {
          await memoryService.recordQueryTrace({
            sessionId: input.session_id,
            queryText: '[session-start] core memory',
            strategy: 'core-memory',
            candidateEventIds: deliveredCoreBlockIds,
            selectedEventIds: deliveredCoreBlockIds,
            confidence: 'core',
            presentationMode: 'core',
            triggerType: 'session_start',
            deliveryClient: 'claude-hook'
          });
        }
      } catch {
        // Core memory injection is supplementary; never fail session start over it.
      }
    }

    // specs/lesson-recall-hooks R1 — lesson index. Bounded like the core lane,
    // never query-scored; the per-turn lane handles relevance for what is cut here.
    const lessonBudget = sessionStartLessonBudget();
    if (lessonBudget > 0 && process.env.CLAUDE_MEMORY_EVAL_DISABLE_SESSION_CONTEXT !== 'true') {
      try {
        const injections = await memoryService.listProjectLessonInjections(
          resolveCanonicalMemoryActorId(input.actor_id),
          500
        );
        const lessons = injections.map((item) => item.value);
        const lessonContext = formatLessonIndexContext(lessons, { budgetChars: lessonBudget, totalCount: lessons.length });
        if (lessonContext) {
          if (context) context += '\n';
          context += lessonContext;
          // Recorded so lesson usage becomes measurable: before this, lesson
          // injection left no row in retrieval_traces/memory_helpfulness.
          const shownIds = lessons
            .filter((lesson) => lessonContext.includes(`- ${lesson.name.trim()} — `))
            .map((lesson) => lesson.lessonId);
          if (!isHookEvaluationMode() && shownIds.length > 0) {
            const lessonTraceId = randomUUID();
            await memoryService.recordQueryTrace({
              traceId: lessonTraceId,
              sessionId: input.session_id,
              queryText: '[session-start] lesson index',
              strategy: 'session-start-lessons',
              candidateEventIds: lessons.map((lesson) => lesson.lessonId),
              selectedEventIds: shownIds,
              confidence: 'session-start',
              presentationMode: 'reference',
              triggerType: 'session_start',
              deliveryClient: 'claude-hook'
            }).catch(() => undefined);
            for (const lesson of lessons) {
              if (!shownIds.includes(lesson.lessonId)) continue;
              await memoryService.recordRetrieval(
                lesson.lessonId,
                input.session_id,
                0.5,
                '[session-start] lesson index',
                {
                  traceId: lessonTraceId,
                  source: 'session_start',
                  presentationMode: 'reference',
                  triggerType: 'session_start',
                  deliveryClient: 'claude-hook',
                  injectedContent: `${lesson.name} — ${lesson.trigger}`
                }
              ).catch(() => undefined);
            }
          }
        }
      } catch {
        // Lesson index is supplementary; never fail session start over it.
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
      const excerpts = new Map<string, string>();
      if (options.contextPresentation === 'reference') {
        context += formatMemoryReferenceContext(
          injectedEvents.map(memoryEventReferenceItem),
          {
            heading: 'Previous session memory index',
            introduction: 'These recent project memories are navigation hints, not evidence. Open a source only when it is relevant to the current task.'
          }
        );
        for (const event of injectedEvents) {
          excerpts.set(event.id, memoryReferenceSummary(event.content));
        }
      } else {
        context += `## Previous Session Context\n\nYou have worked on this project before. Here are some relevant memories:\n\n`;
        for (const event of injectedEvents) {
          const date = event.timestamp.toISOString().split('T')[0];
          const excerpt = sessionStartExcerpt(event);
          excerpts.set(event.id, excerpt);
          context += `- **${date}**: ${excerpt}\n`;
        }
      }

      // Session-start injections used to be invisible to usefulness metrics.
      // Track them like prompt-time retrievals so helpfulness evaluation and
      // the evidence history cover this injection path too. One shared batch
      // id groups the injected memories into a single history entry.
      const batchTraceId = randomUUID();
      const presentationMode = options.contextPresentation ?? 'evidence';
      if (!isHookEvaluationMode()) {
        try {
          await memoryService.recordQueryTrace({
            traceId: batchTraceId,
            sessionId: input.session_id,
            queryText: '[session-start] recent project context',
            strategy: 'session-start-hook',
            candidateEventIds: injectedEvents.map((event) => event.id),
            selectedEventIds: injectedEvents.map((event) => event.id),
            confidence: 'session-start',
            presentationMode,
            triggerType: 'session_start',
            deliveryClient: 'claude-hook'
          });
        } catch { /* non-critical telemetry */ }
      }
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
              presentationMode,
              triggerType: 'session_start',
              deliveryClient: 'claude-hook',
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
