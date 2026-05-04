import {
  IngestInterceptor,
  IngestInterceptorRegistry,
  mergeHierarchicalMetadata
} from '../ingest-interceptor.js';
import { normalizeTags } from '../tag-taxonomy.js';
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

interface IngestEventStore extends SessionUpsertStore {
  append(input: MemoryEventInput): Promise<AppendResult>;
  enqueueForEmbedding(eventId: string, content: string): Promise<unknown>;
}

interface IngestMarkdownMirror {
  append(event: MemoryEventInput, eventId?: string): Promise<void>;
}

export type IngestOperation = 'user_prompt' | 'agent_response' | 'session_summary' | 'tool_observation';

export interface MemoryIngestServiceOptions {
  initialize: () => Promise<void>;
  eventStore: IngestEventStore;
  markdownMirror: IngestMarkdownMirror;
  createToolEmbedding: (payload: ToolObservationPayload) => string;
  getProjectHash?: () => string | null;
  getProjectPath?: () => string | null;
  summaryDeriver?: SummaryDeriver;
}

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
  private readonly markdownMirror: IngestMarkdownMirror;
  private readonly createToolEmbedding: (payload: ToolObservationPayload) => string;
  private readonly getProjectHash: () => string | null;
  private readonly getProjectPath: () => string | null;
  private readonly summaryDeriver: SummaryDeriver;
  private readonly ingestInterceptors = new IngestInterceptorRegistry();

  constructor(options: MemoryIngestServiceOptions) {
    this.initialize = options.initialize;
    this.eventStore = options.eventStore;
    this.markdownMirror = options.markdownMirror;
    this.createToolEmbedding = options.createToolEmbedding;
    this.getProjectHash = options.getProjectHash ?? (() => null);
    this.getProjectPath = options.getProjectPath ?? (() => null);
    this.summaryDeriver = options.summaryDeriver ?? createSummaryDeriver();
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

  private async ingestEvent(options: {
    operation: IngestOperation;
    input: MemoryEventInput;
    embeddingContent?: string;
  }): Promise<AppendResult> {
    const normalizedInput = this.normalizeInput(options.operation, options.input);

    await this.ingestInterceptors.run('before', {
      operation: options.operation,
      sessionId: normalizedInput.sessionId,
      event: normalizedInput
    });

    try {
      const result = await this.eventStore.append(normalizedInput);
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
        if (options.embeddingContent) {
          await this.eventStore.enqueueForEmbedding(result.eventId, options.embeddingContent);
        }
        try {
          await this.markdownMirror.append(normalizedInput, result.eventId);
        } catch {
          // non-breaking markdown mirror write
        }
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

  private normalizeInput(operation: IngestOperation, input: MemoryEventInput): MemoryEventInput {
    const projectHash = this.getProjectHash();
    const projectPath = this.getProjectPath();
    const normalizedInput: MemoryEventInput = {
      ...input,
      metadata: mergeHierarchicalMetadata(
        {
          ingest: {
            operation,
            pipeline: 'default',
            ts: new Date().toISOString()
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
