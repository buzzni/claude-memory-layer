import type { AppendResult, MemoryEventInput, ToolObservationPayload } from '../types.js';

interface SessionRecord {
  id: string;
  startedAt?: Date;
  endedAt?: Date;
  projectPath?: string;
  summary?: string;
}

interface SessionUpsertStore {
  upsertSession(session: SessionRecord): Promise<void>;
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
    private readonly createToolEmbedding: (payload: ToolObservationPayload) => string
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
