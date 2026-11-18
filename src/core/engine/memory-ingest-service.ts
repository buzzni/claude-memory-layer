import {
  IngestInterceptor,
  IngestInterceptorRegistry,
  mergeHierarchicalMetadata
} from '../ingest-interceptor.js';
import { normalizeTags } from '../tag-taxonomy.js';
import { createSummaryDeriver, type SummaryDeriver } from '../derive/summary-deriver.js';
import type { AppendOptions, EventReplacement, SessionSummaryCandidate } from '../sqlite-event-store.js';
import type {
  AppendResult,
  MemoryEvent,
  MemoryEventInput,
  MemoryOperationsConfig,
  ToolObservationPayload
} from '../types.js';

export interface PerspectiveDeriverLike {
  deriveFromEvent(
    event: MemoryEvent,
    options?: { projectHash?: string | null; projectPath?: string | null }
  ): Promise<unknown>;
}

export interface SourceFileDeriverLike {
  deriveFromToolObservation(
    event: MemoryEvent,
    payload: ToolObservationPayload,
    context?: { projectHash?: string | null; projectPath?: string | null }
  ): Promise<void>;
}

interface SessionRecord {
  id: string;
  startedAt?: Date;
  endedAt?: Date;
  projectPath?: string;
  summary?: string;
}

interface SessionUpsertStore {
  upsertSession(session: SessionRecord): Promise<void>;
  getSessionEvents(sessionId: string): Promise<MemoryEvent[]>;
  getSessionsWithoutSummary(currentSessionId: string, limit?: number): Promise<string[]>;
  getLlmSummaryCandidates(
    currentSessionId: string,
    options: { limit: number; refreshSince?: Date }
  ): Promise<SessionSummaryCandidate[]>;
}

interface IngestEventStore extends SessionUpsertStore {
  append(input: MemoryEventInput, options?: AppendOptions): Promise<AppendResult>;
  enqueueForEmbedding(eventId: string, content: string): Promise<unknown>;
  recordCaptureSkipped?(reason: string): Promise<void>;
  mergeEventMetadata(eventId: string, patch: Record<string, unknown>): Promise<boolean>;
}

export type IngestOperation = 'user_prompt' | 'agent_response' | 'session_summary' | 'tool_observation';

/** operations.json `sessionSummaryRefresh`. */
export type SessionSummaryRefreshPolicy = MemoryOperationsConfig['sessionSummaryRefresh'];

/**
 * Without a refresh the first turn's summary was the only one a session ever
 * got (#221). Ten prompt/answer events is about five turns; three refreshes
 * cover a session that grows by up to 39 after its first summary, which 94% of
 * summarized sessions in the measured stores did not exceed, and stop a longer
 * session at three refreshes.
 */
export const DEFAULT_SESSION_SUMMARY_REFRESH: SessionSummaryRefreshPolicy = {
  enabled: true,
  minNewExchanges: 10,
  maxRefreshesPerSession: 3
};

/**
 * How far back the session-start backfill looks for summaries due for a
 * refresh. Stop refreshes a live session; the backfill only catches sessions
 * whose last turns ended without it, so a week (the summary-pending queue's
 * limit too) is enough and keeps its query off every session in the store.
 */
export const SUMMARY_REFRESH_BACKFILL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Where a session stands against its newest summary; `summary` is absent when it has none. */
export interface SessionSummaryProgress {
  exchangeCount: number;
  summary?: {
    /** Prompt/answer events the summary, or the last refresh attempt, covered. */
    coveredExchanges: number;
    /** Refresh attempts the provider answered, the empty ones included. */
    refreshes: number;
  };
}

/**
 * The one judgment of whether a session needs an LLM summary call: Stop,
 * the summary-pending retries and the session-start backfill all go through it.
 */
export function isLlmSessionSummaryDue(
  progress: SessionSummaryProgress,
  policy: SessionSummaryRefreshPolicy
): boolean {
  if (!progress.summary) return true;
  if (!policy.enabled || progress.summary.refreshes >= policy.maxRefreshesPerSession) return false;
  return progress.exchangeCount - progress.summary.coveredExchanges >= policy.minNewExchanges;
}

function isExchangeEvent(event: MemoryEvent): boolean {
  return (event.eventType === 'user_prompt' || event.eventType === 'agent_response')
    && typeof event.content === 'string'
    && event.content.trim().length > 0;
}

/**
 * Reads a summary's coverage. Summaries written before refreshes existed carry
 * no count; for them it is the prompt/answer events stored before the summary.
 */
function summaryCoverage(
  metadata: Record<string, unknown> | undefined,
  exchangesBeforeSummary: number
): NonNullable<SessionSummaryProgress['summary']> {
  const recorded = metadata?.summarizedExchangeCount;
  const refreshes = metadata?.summaryRefreshes;
  return {
    coveredExchanges: typeof recorded === 'number' && Number.isFinite(recorded) ? recorded : exchangesBeforeSummary,
    refreshes: typeof refreshes === 'number' && Number.isFinite(refreshes) ? refreshes : 0
  };
}

export interface MemoryIngestServiceOptions {
  initialize: () => Promise<void>;
  eventStore: IngestEventStore;
  createToolEmbedding: (payload: ToolObservationPayload) => string;
  getProjectHash?: () => string | null;
  getProjectPath?: () => string | null;
  summaryDeriver?: SummaryDeriver;
  perspectiveDeriver?: PerspectiveDeriverLike;
  sourceFileDeriver?: SourceFileDeriverLike;
  /**
   * Injected so core stays free of child-process/CLI concerns. Returns null
   * when the session holds nothing durable, which must store nothing rather
   * than fall back to the rule-based text.
   */
  llmSummaryGenerator?: LlmSummaryGenerator;
  /** operations.json `sessionSummaryRefresh`; DEFAULT_SESSION_SUMMARY_REFRESH when absent. */
  summaryRefresh?: SessionSummaryRefreshPolicy;
  now?: () => Date;
}

export interface LlmSummaryGenerated {
  text: string;
  metadata: Record<string, unknown>;
}

export type LlmSummaryGenerator = (
  events: Array<{ eventType: string; content: string }>
) => Promise<LlmSummaryGenerated | null>;

/**
 * Thin-core ingest service for session lifecycle and event writes.
 *
 * Owns the ingest normalization/interceptor/append pipeline so the public
 * MemoryService facade can delegate ingest behavior without coordinating
 * storage-side effects itself.
 */
export class MemoryIngestService {
  private readonly initialize: () => Promise<void>;
  private readonly eventStore: IngestEventStore;
  private readonly createToolEmbedding: (payload: ToolObservationPayload) => string;
  private readonly getProjectHash: () => string | null;
  private readonly getProjectPath: () => string | null;
  private readonly summaryDeriver: SummaryDeriver;
  private readonly perspectiveDeriver?: PerspectiveDeriverLike;
  private readonly sourceFileDeriver?: SourceFileDeriverLike;
  private readonly llmSummaryGenerator?: LlmSummaryGenerator;
  private readonly summaryRefresh: SessionSummaryRefreshPolicy;
  private readonly now: () => Date;
  private readonly ingestInterceptors = new IngestInterceptorRegistry();

  constructor(options: MemoryIngestServiceOptions) {
    this.initialize = options.initialize;
    this.eventStore = options.eventStore;
    this.createToolEmbedding = options.createToolEmbedding;
    this.getProjectHash = options.getProjectHash ?? (() => null);
    this.getProjectPath = options.getProjectPath ?? (() => null);
    this.summaryDeriver = options.summaryDeriver ?? createSummaryDeriver();
    this.perspectiveDeriver = options.perspectiveDeriver;
    this.sourceFileDeriver = options.sourceFileDeriver;
    this.llmSummaryGenerator = options.llmSummaryGenerator;
    this.summaryRefresh = options.summaryRefresh ?? DEFAULT_SESSION_SUMMARY_REFRESH;
    this.now = options.now ?? (() => new Date());
  }

  registerIngestBefore(interceptor: IngestInterceptor): () => void {
    return this.ingestInterceptors.registerBefore(interceptor);
  }

  registerIngestAfter(interceptor: IngestInterceptor): () => void {
    return this.ingestInterceptors.registerAfter(interceptor);
  }

  registerIngestOnError(interceptor: IngestInterceptor): () => void {
    return this.ingestInterceptors.registerOnError(interceptor);
  }

  async startSession(sessionId: string, projectPath?: string): Promise<void> {
    await this.initialize();

    await this.eventStore.upsertSession({
      id: sessionId,
      startedAt: new Date(),
      projectPath
    });
  }

  async endSession(sessionId: string, summary?: string): Promise<void> {
    await this.initialize();

    await this.eventStore.upsertSession({
      id: sessionId,
      endedAt: new Date(),
      summary
    });
  }

  async storeUserPrompt(
    sessionId: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<AppendResult> {
    return this.ingestEvent({
      operation: 'user_prompt',
      input: {
        eventType: 'user_prompt',
        sessionId,
        timestamp: new Date(),
        content,
        metadata
      },
      embeddingContent: content
    });
  }

  async storeAgentResponse(
    sessionId: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<AppendResult> {
    return this.ingestEvent({
      operation: 'agent_response',
      input: {
        eventType: 'agent_response',
        sessionId,
        timestamp: new Date(),
        content,
        metadata
      },
      embeddingContent: content
    });
  }

  /** `replaces`: the summaries this one replaces, hidden in the same transaction (see EventReplacement). */
  async storeSessionSummary(
    sessionId: string,
    summary: string,
    metadata?: Record<string, unknown>,
    replaces?: EventReplacement
  ): Promise<AppendResult> {
    return this.ingestEvent({
      operation: 'session_summary',
      input: {
        eventType: 'session_summary',
        sessionId,
        timestamp: new Date(),
        content: summary,
        metadata
      },
      embeddingContent: summary,
      appendOptions: replaces ? { replaces } : undefined
    });
  }

  /**
   * Backfill session summaries for recent sessions that are missing them.
   * Called from session-start hook to catch sessions that ended without Stop hook.
   */
  async backfillMissingSummaries(currentSessionId: string, limit = 5): Promise<void> {
    await this.initialize();

    const recentSessionIds = await this.eventStore.getSessionsWithoutSummary(currentSessionId, limit);
    for (const sessionId of recentSessionIds) {
      try {
        await this.generateSessionSummary(sessionId);
      } catch {
        // non-critical backfill path
      }
    }
  }

  /**
   * Session ids an LLM summary call is due for (isLlmSessionSummaryDue), most
   * recent first, for callers that backfill through the LLM path (see
   * semantic-daemon-client's scheduleSessionSummary) rather than this class's
   * own rule-based generateSessionSummary: sessions without a summary, and
   * sessions active within SUMMARY_REFRESH_BACKFILL_WINDOW_MS whose summary is
   * due for a refresh.
   */
  async getSessionsDueForLlmSummary(currentSessionId: string, limit = 5): Promise<string[]> {
    await this.initialize();
    const refreshSince = this.summaryRefresh.enabled
      ? new Date(this.now().getTime() - SUMMARY_REFRESH_BACKFILL_WINDOW_MS)
      : undefined;
    const candidates = await this.eventStore.getLlmSummaryCandidates(currentSessionId, { limit, refreshSince });
    return candidates
      .filter((candidate) => isLlmSessionSummaryDue({
        exchangeCount: candidate.summary?.exchangeCount ?? 0,
        summary: candidate.summary
          && summaryCoverage(candidate.summary.metadata, candidate.summary.exchangesBeforeSummary)
      }, this.summaryRefresh))
      .slice(0, limit)
      .map((candidate) => candidate.sessionId);
  }

  /**
   * Generate a rule-based session summary from stored events.
   * Skips short sessions and sessions that already contain a summary event.
   */
  async generateSessionSummary(sessionId: string): Promise<void> {
    await this.initialize();

    const events = await this.eventStore.getSessionEvents(sessionId);
    const summary = this.summaryDeriver.deriveSessionSummary(events);
    if (!summary) return;

    await this.storeSessionSummary(sessionId, summary.text, summary.metadata);
  }

  /**
   * Generate an outcome-focused summary through the injected LLM generator.
   *
   * Slow by nature, so callers must keep it off any hook response path. On
   * failure or when the session holds nothing durable this stores nothing: the
   * session then still has no summary and stays eligible for a later backfill
   * attempt. It deliberately does not fall back to the rule-based text, whose
   * table-of-contents shape is the reason this path exists.
   *
   * A session that already has a summary is summarized again when
   * isLlmSessionSummaryDue says so (the summaryRefresh policy). The generator
   * then also receives the previous summary, and the new one supersedes it so
   * retrieval does not return both. A failed call (an open provider circuit
   * included) throws and changes nothing, so the old summary stays.
   */
  async generateLlmSessionSummary(sessionId: string): Promise<boolean> {
    await this.initialize();
    if (!this.llmSummaryGenerator) return false;

    const events = await this.eventStore.getSessionEvents(sessionId);
    if (events.length < 3) return false;
    const previousSummaries = events.filter((event) => event.eventType === 'session_summary');
    const exchangeCount = events.filter(isExchangeEvent).length;
    const latestSummary = previousSummaries.at(-1);
    const coverage = latestSummary && summaryCoverage(
      latestSummary.metadata,
      events.slice(0, events.indexOf(latestSummary)).filter(isExchangeEvent).length
    );
    if (!isLlmSessionSummaryDue({ exchangeCount, summary: coverage }, this.summaryRefresh)) return false;

    // Recorded on the new summary, or on the one that stays when the refresh
    // brings nothing new; otherwise every later turn would call the provider
    // again, and an empty answer would never count toward the cap.
    const covered = {
      summarizedExchangeCount: exchangeCount,
      ...(coverage ? { summaryRefreshes: coverage.refreshes + 1 } : {})
    };

    const summary = await this.llmSummaryGenerator(
      events.map((event) => ({ eventType: event.eventType, content: event.content }))
    );
    if (!summary) {
      if (latestSummary) await this.eventStore.mergeEventMetadata(latestSummary.id, covered);
      return false;
    }

    // The store reports write failures as a result, not an exception; true
    // must mean the summary is on disk (or already was), because callers
    // treat it as done and stop retrying. The old summaries are hidden in the
    // transaction that stores the new one, so a failure changes nothing and
    // the session stays due. A summary the session already has (the current
    // one, or an earlier one the conversation went back to) becomes the
    // current one instead of a second copy.
    const stored = await this.storeSessionSummary(
      sessionId,
      summary.text,
      { ...summary.metadata, ...covered },
      { eventIds: previousSummaries.map((event) => event.id), metadataOnDuplicate: covered }
    );
    if (!stored.success) {
      throw new Error(`session summary could not be stored: ${stored.error}`);
    }
    return true;
  }

  /** Counts a hook input the capture policy kept out of the store. */
  async recordCaptureSkipped(reason: string): Promise<void> {
    await this.initialize();
    await this.eventStore.recordCaptureSkipped?.(reason);
  }

  async storeToolObservation(
    sessionId: string,
    payload: ToolObservationPayload
  ): Promise<AppendResult> {
    const content = JSON.stringify(payload);
    const turnId = (payload.metadata as Record<string, unknown> | undefined)?.turnId;

    const result = await this.ingestEvent({
      operation: 'tool_observation',
      input: {
        eventType: 'tool_observation',
        sessionId,
        timestamp: new Date(),
        content,
        metadata: {
          toolName: payload.toolName,
          success: payload.success,
          ...(typeof turnId === 'string' && turnId.length > 0 ? { turnId } : {})
        }
      },
      embeddingContent: this.createToolEmbedding(payload)
    });

    if (result.success !== false && !result.isDuplicate) {
      await this.runSourceFileDeriver(result.eventId, sessionId, payload);
    }

    return result;
  }

  private async runSourceFileDeriver(
    eventId: string,
    sessionId: string,
    payload: ToolObservationPayload
  ): Promise<void> {
    if (!this.sourceFileDeriver) return;
    try {
      await this.sourceFileDeriver.deriveFromToolObservation(
        {
          id: eventId,
          eventType: 'tool_observation',
          sessionId,
          timestamp: new Date(),
          content: '',
          canonicalKey: eventId,
          dedupeKey: eventId
        },
        payload,
        {
          projectHash: this.getProjectHash(),
          projectPath: this.getProjectPath()
        }
      );
    } catch {
      // Optional codify-lite derivation must never block normal memory ingestion.
    }
  }

  private async ingestEvent(options: {
    operation: IngestOperation;
    input: MemoryEventInput;
    embeddingContent?: string;
    appendOptions?: AppendOptions;
  }): Promise<AppendResult> {
    const normalizedInput = this.normalizeInput(options.operation, options.input);

    await this.ingestInterceptors.run('before', {
      operation: options.operation,
      sessionId: normalizedInput.sessionId,
      event: normalizedInput
    });

    try {
      const result = await this.eventStore.append(normalizedInput, options.appendOptions);
      if (result.success === false) {
        await this.ingestInterceptors.run('error', {
          operation: options.operation,
          sessionId: normalizedInput.sessionId,
          event: normalizedInput,
          error: new Error(result.error)
        });
        return result;
      }

      if (!result.isDuplicate) {
        // tool_observation is excluded from semantic embedding (see the V2
        // vector_outbox skip in SQLiteEventStore.append()) — raw tool output,
        // including full Agent/Task subagent responses, otherwise dominates
        // and outranks actual prompts/answers in mem-search. This is the
        // parallel legacy embedding_outbox path; it must skip the same way.
        if (options.embeddingContent && options.operation !== 'tool_observation') {
          await this.eventStore.enqueueForEmbedding(result.eventId, options.embeddingContent);
        }
        await this.runPerspectiveDeriver(normalizedInput, result.eventId, options.operation);
      }

      await this.ingestInterceptors.run('after', {
        operation: options.operation,
        sessionId: normalizedInput.sessionId,
        event: normalizedInput
      });

      return result;
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      await this.ingestInterceptors.run('error', {
        operation: options.operation,
        sessionId: normalizedInput.sessionId,
        event: normalizedInput,
        error: normalizedError
      });
      throw error;
    }
  }

  private async runPerspectiveDeriver(
    input: MemoryEventInput,
    eventId: string,
    operation: IngestOperation
  ): Promise<void> {
    if (!this.perspectiveDeriver) return;
    if (operation !== 'user_prompt' && operation !== 'agent_response') return;
    const event: MemoryEvent = {
      id: eventId,
      eventType: input.eventType,
      sessionId: input.sessionId,
      timestamp: input.timestamp,
      content: input.content,
      canonicalKey: eventId,
      dedupeKey: eventId,
      metadata: input.metadata
    };
    try {
      await this.perspectiveDeriver.deriveFromEvent(event, {
        projectHash: this.getProjectHash(),
        projectPath: this.getProjectPath()
      });
    } catch {
      // Optional perspective derivation must never block normal memory ingestion.
    }
  }

  private normalizeInput(operation: IngestOperation, input: MemoryEventInput): MemoryEventInput {
    const projectHash = this.getProjectHash();
    const projectPath = this.getProjectPath();
    // Store time and source time are two different clocks (specs R4). An
    // importer replaying an old transcript passes the original instant as
    // `originalTimestamp`; without recording both, a backlog is invisible and
    // "the memory is two days old" can mean either thing.
    const ingestedAt = new Date().toISOString();
    const occurredAt = readOriginalTimestamp(input) ?? isoOrNull(input.timestamp);
    const sourceLagMs = occurredAt !== null && Date.parse(occurredAt) <= Date.parse(ingestedAt)
      ? Date.parse(ingestedAt) - Date.parse(occurredAt)
      : null;
    const normalizedInput: MemoryEventInput = {
      ...input,
      metadata: mergeHierarchicalMetadata(
        {
          ingest: {
            operation,
            pipeline: 'default',
            ts: ingestedAt,
            ingestedAt,
            ...(occurredAt ? { occurredAt } : {}),
            ...(sourceLagMs === null ? {} : { sourceLagMs })
          },
          ...(projectHash
            ? {
                scope: {
                  project: {
                    hash: projectHash,
                    ...(projectPath ? { path: projectPath } : {})
                  }
                },
                tags: [`proj:${projectHash}`]
              }
            : {})
        },
        input.metadata
      )
    };

    if (projectHash && normalizedInput.metadata) {
      const meta = normalizedInput.metadata as Record<string, unknown>;
      const currentTags = Array.isArray(meta.tags)
        ? meta.tags.filter((x): x is string => typeof x === 'string')
        : [];
      const projectTag = `proj:${projectHash}`;
      if (!currentTags.includes(projectTag)) {
        meta.tags = [...currentTags, projectTag];
      }
    }

    if (normalizedInput.metadata) {
      const meta = normalizedInput.metadata as Record<string, unknown>;
      const normalizedTags = normalizeTags(meta.tags);
      if (normalizedTags.length > 0) {
        meta.tags = normalizedTags;
      }
    }

    return normalizedInput;
  }
}

/**
 * The original conversation instant, when an importer supplied one. Absent for
 * live capture, where the store time is the source time.
 */
function readOriginalTimestamp(input: MemoryEventInput): string | null {
  const metadata = input.metadata as Record<string, unknown> | undefined;
  const raw = metadata?.originalTimestamp;
  if (typeof raw !== 'string') return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}
