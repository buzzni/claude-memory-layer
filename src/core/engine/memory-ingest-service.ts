import { createSummaryDeriver, type SummaryDeriver } from '../derive/summary-deriver.js';
import type { AppendResult, MemoryEvent, MemoryEventInput, ToolObservationPayload } from '../types.js';

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
}

type IngestOperation = 'user_prompt' | 'agent_response' | 'session_summary' | 'tool_observation';

interface IngestEventOptions {
  operation: IngestOperation;
  input: MemoryEventInput;
  embeddingContent?: string;
}

/**
 * Thin-core ingest service for session lifecycle and event writes.
 *
 * This service owns public ingest-facing methods first, while delegating the
 * lower-level interceptor/append pipeline back to the current orchestration
 * layer during incremental migration.
 */
export class MemoryIngestService {
  constructor(
    private readonly initialize: () => Promise<void>,
    private readonly sessionStore: SessionUpsertStore,
    private readonly ingestEvent: (options: IngestEventOptions) => Promise<AppendResult>,
    private readonly createToolEmbedding: (payload: ToolObservationPayload) => string,
    private readonly summaryDeriver: SummaryDeriver = createSummaryDeriver()
  ) {}

  async startSession(sessionId: string, projectPath?: string): Promise<void> {
    await this.initialize();

    await this.sessionStore.upsertSession({
      id: sessionId,
      startedAt: new Date(),
      projectPath
    });
  }

  async endSession(sessionId: string, summary?: string): Promise<void> {
    await this.initialize();

    await this.sessionStore.upsertSession({
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

  async storeSessionSummary(
    sessionId: string,
    summary: string,
    metadata?: Record<string, unknown>
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
      embeddingContent: summary
    });
  }

  /**
   * Backfill session summaries for recent sessions that are missing them.
   * Called from session-start hook to catch sessions that ended without Stop hook.
   */
  async backfillMissingSummaries(currentSessionId: string, limit = 5): Promise<void> {
    await this.initialize();

    const recentSessionIds = await this.sessionStore.getSessionsWithoutSummary(currentSessionId, limit);
    for (const sessionId of recentSessionIds) {
      try {
        await this.generateSessionSummary(sessionId);
      } catch {
        // non-critical backfill path
      }
    }
  }

  /**
   * Generate a rule-based session summary from stored events.
   * Skips short sessions and sessions that already contain a summary event.
   */
  async generateSessionSummary(sessionId: string): Promise<void> {
    await this.initialize();

    const events = await this.sessionStore.getSessionEvents(sessionId);
    const summary = this.summaryDeriver.deriveSessionSummary(events);
    if (!summary) return;

    await this.storeSessionSummary(sessionId, summary.text, summary.metadata);
  }

  async storeToolObservation(
    sessionId: string,
    payload: ToolObservationPayload
  ): Promise<AppendResult> {
    const content = JSON.stringify(payload);
    const turnId = (payload.metadata as Record<string, unknown> | undefined)?.turnId;

    return this.ingestEvent({
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
  }
}
