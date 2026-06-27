/**
 * Retrieval Disclosure Service
 *
 * Provides a product-facing progressive disclosure surface on top of retrieval:
 * search -> expand -> source. Search returns compact, spec-aligned result
 * envelopes; expand adds surrounding context; source resolves to canonical raw
 * events or other source references.
 */

import type { RetrievalReason, RetrievalResultEnvelope, RetrievalResultType } from '../model/retrieval-result.js';
import { sanitizeGovernanceAuditValue } from '../operations/governance-audit.js';
import type { UnifiedRetrievalResult, MemoryWithContext, RetrievalDebugDetail } from '../retriever.js';
import type { MemoryEvent, SharedTroubleshootingEntry } from '../types.js';
import type { RetrieveMemoriesOptions } from './retrieval-orchestrator.js';

export type RetrievalDisclosureResultType = RetrievalResultType;
export type RetrievalDisclosureReason = RetrievalReason;
export type RetrievalDisclosureEnvelope = RetrievalResultEnvelope;
export type RetrievalDisclosureSourceType =
  | 'raw_event'
  | 'transcript'
  | 'tool_output'
  | 'imported_history'
  | 'shared_troubleshooting';

export interface RetrievalDisclosureSearchResponse {
  results: RetrievalResultEnvelope[];
  meta: {
    total: number;
    usedVector: boolean;
    usedKeyword: boolean;
    fallbackApplied: boolean;
    confidence?: UnifiedRetrievalResult['matchResult']['confidence'];
    totalTokens?: number;
    fallbackTrace?: string[];
  };
}

export interface RetrievalDisclosureSourceReference {
  sourceRef: string;
  sourceType: RetrievalDisclosureSourceType;
  eventIds: string[];
  metadata?: Record<string, unknown>;
}

export interface RetrievalDisclosureExpansion {
  target: RetrievalResultEnvelope;
  surroundingFacts?: RetrievalResultEnvelope[];
  summaries?: RetrievalResultEnvelope[];
  relatedSources?: RetrievalDisclosureSourceReference[];
  expandedContext?: string;
}

export interface RetrievalDisclosureSource extends RetrievalDisclosureSourceReference {
  rawEvents: MemoryEvent[];
  primaryEvent?: MemoryEvent;
}

export type RetrievalDisclosureSearchOptions = RetrieveMemoriesOptions;

export interface RetrievalDisclosureExpandOptions {
  windowSize?: number;
}

export interface RetrievalDisclosureOrchestrator {
  retrieveMemories(
    query: string,
    options?: RetrievalDisclosureSearchOptions
  ): Promise<UnifiedRetrievalResult>;
}

export interface RetrievalDisclosureEventStore {
  getEvent(id: string): Promise<MemoryEvent | null>;
  getSessionEvents(sessionId: string): Promise<MemoryEvent[]>;
}

export interface RetrievalDisclosureSharedStore {
  get(entryId: string): Promise<SharedTroubleshootingEntry | null>;
}

export interface RetrievalDisclosureServiceDeps {
  initialize: () => Promise<void>;
  retrievalOrchestrator: RetrievalDisclosureOrchestrator;
  eventStore: RetrievalDisclosureEventStore;
  sharedStore?: RetrievalDisclosureSharedStore;
}

export class RetrievalDisclosureService {
  constructor(private readonly deps: RetrievalDisclosureServiceDeps) {}

  async search(
    query: string,
    options?: RetrievalDisclosureSearchOptions
  ): Promise<RetrievalDisclosureSearchResponse> {
    const result = await this.deps.retrievalOrchestrator.retrieveMemories(query, options);
    const debugByEventId = this.buildDebugIndex(result);
    const projectResults = result.memories.map((memory) => this.memoryToEnvelope(
      memory,
      result,
      debugByEventId.get(memory.event.id)
    ));
    const sharedResults = (result.sharedMemories || []).map((entry) => this.sharedToEnvelope(entry));
    const results = [...projectResults, ...sharedResults];

    return {
      results,
      meta: {
        total: results.length,
        usedVector: this.usedVector(result),
        usedKeyword: this.usedKeyword(result),
        fallbackApplied: this.fallbackApplied(result),
        confidence: result.matchResult.confidence,
        totalTokens: result.totalTokens,
        fallbackTrace: result.fallbackTrace || []
      }
    };
  }

  async expand(
    resultId: string,
    options?: RetrievalDisclosureExpandOptions
  ): Promise<RetrievalDisclosureExpansion | null> {
    const parsedId = parseDisclosureResultRef(resultId);
    if (parsedId.kind === 'shared') {
      return this.expandShared(parsedId.entryId);
    }

    const targetEvent = await this.deps.eventStore.getEvent(parsedId.eventId);
    if (!targetEvent) return null;

    const windowSize = Math.max(0, options?.windowSize ?? 3);
    const sessionEvents = (await this.deps.eventStore.getSessionEvents(targetEvent.sessionId))
      .slice()
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const targetIndex = sessionEvents.findIndex((event) => event.id === targetEvent.id);
    const surroundingEvents = targetIndex === -1
      ? []
      : sessionEvents.slice(
          Math.max(0, targetIndex - windowSize),
          Math.min(sessionEvents.length, targetIndex + windowSize + 1)
        );
    const nearbyEvents = surroundingEvents.length > 0 ? surroundingEvents : [targetEvent];
    const nonTargetEvents = nearbyEvents.filter((event) => event.id !== targetEvent.id);

    return {
      target: this.eventToEnvelope(targetEvent, 1, ['continuity_link']),
      surroundingFacts: nonTargetEvents.map((event) => this.eventToEnvelope(event, 1, this.reasonsForContextEvent(event))),
      summaries: nonTargetEvents
        .filter((event) => event.eventType === 'session_summary')
        .map((event) => this.eventToEnvelope(event, 1, ['summary_fallback'])),
      relatedSources: nearbyEvents.map((event) => this.sourceReferenceForEvent(event)),
      expandedContext: this.formatTimelineContext(nearbyEvents)
    };
  }

  async source(resultId: string): Promise<RetrievalDisclosureSource | null> {
    const parsedId = parseDisclosureResultRef(resultId);
    if (parsedId.kind === 'shared') {
      return this.sourceShared(parsedId.entryId);
    }

    const rawEvent = await this.deps.eventStore.getEvent(parsedId.eventId);
    if (!rawEvent) return null;

    return {
      ...this.sourceReferenceForEvent(rawEvent),
      rawEvents: [rawEvent],
      primaryEvent: rawEvent
    };
  }

  private async expandShared(entryId: string): Promise<RetrievalDisclosureExpansion | null> {
    const entry = await this.deps.sharedStore?.get(entryId);
    if (!entry) return null;

    return {
      target: this.sharedToEnvelope(entry),
      surroundingFacts: [],
      summaries: [],
      relatedSources: [this.sourceReferenceForShared(entry)],
      expandedContext: this.formatSharedContext(entry)
    };
  }

  private async sourceShared(entryId: string): Promise<RetrievalDisclosureSource | null> {
    const entry = await this.deps.sharedStore?.get(entryId);
    if (!entry) return null;

    const sourceReference = this.sourceReferenceForShared(entry);
    return {
      ...sourceReference,
      rawEvents: [],
      metadata: {
        ...sourceReference.metadata,
        symptoms: entry.symptoms,
        rootCause: entry.rootCause,
        solution: entry.solution,
        technologies: entry.technologies,
        confidence: entry.confidence,
        usageCount: entry.usageCount
      }
    };
  }

  private memoryToEnvelope(
    memory: MemoryWithContext,
    result: UnifiedRetrievalResult,
    debug?: RetrievalDebugDetail
  ): RetrievalResultEnvelope {
    return this.eventToEnvelope(
      memory.event,
      memory.score,
      this.inferReasons(memory, result, debug),
      {
        semanticScore: debug?.semanticScore,
        lexicalScore: debug?.lexicalScore,
        recencyScore: debug?.recencyScore,
        ...(debug?.facetMatches && debug.facetMatches.length > 0 ? { facetMatches: debug.facetMatches } : {}),
        ...(debug?.graphPaths && debug.graphPaths.length > 0 ? { graphPaths: this.sanitizeGraphPaths(debug.graphPaths) } : {})
      }
    );
  }

  private sanitizeGraphPaths(graphPaths: RetrievalDebugDetail['graphPaths']): unknown {
    return sanitizeGovernanceAuditValue(graphPaths ?? []);
  }

  private eventToEnvelope(
    event: MemoryEvent,
    score: number,
    reasons: RetrievalDisclosureReason[],
    extraMetadata?: Record<string, unknown>
  ): RetrievalResultEnvelope {
    return {
      id: toDisclosureResultId(event.id),
      resultType: this.resultTypeForEvent(event),
      title: this.titleForEvent(event),
      snippet: this.preview(event.content, 240),
      score,
      reasons,
      sourceRef: toDisclosureResultId(event.id),
      sessionId: event.sessionId,
      metadata: {
        eventId: event.id,
        eventType: event.eventType,
        timestamp: event.timestamp.toISOString(),
        canonicalKey: event.canonicalKey,
        ...event.metadata,
        ...extraMetadata
      }
    };
  }

  private sharedToEnvelope(entry: SharedTroubleshootingEntry): RetrievalResultEnvelope {
    return {
      id: `shared:${entry.entryId}`,
      resultType: 'rule',
      title: entry.title,
      snippet: this.preview(entry.solution || entry.rootCause || entry.symptoms.join(' '), 240),
      score: entry.confidence,
      reasons: ['semantic_match'],
      sourceRef: `shared:${entry.entryId}`,
      metadata: {
        sourceProjectHash: entry.sourceProjectHash,
        sourceEntryId: entry.sourceEntryId,
        topics: entry.topics,
        technologies: entry.technologies,
        confidence: entry.confidence,
        usageCount: entry.usageCount
      }
    };
  }

  private buildDebugIndex(result: UnifiedRetrievalResult): Map<string, RetrievalDebugDetail> {
    const byEventId = new Map<string, RetrievalDebugDetail>();

    for (const detail of result.candidateDebug || []) {
      byEventId.set(detail.eventId, detail);
    }
    for (const detail of result.selectedDebug || []) {
      byEventId.set(detail.eventId, detail);
    }

    return byEventId;
  }

  private inferReasons(
    memory: MemoryWithContext,
    result: UnifiedRetrievalResult,
    debug?: RetrievalDebugDetail
  ): RetrievalDisclosureReason[] {
    const reasons = new Set<RetrievalDisclosureReason>();

    const usedVector = this.usedVector(result);
    const usedKeyword = this.usedKeyword(result);

    if (usedVector && (debug?.semanticScore ?? 0) > 0) reasons.add('semantic_match');
    if ((debug?.lexicalScore ?? 0) > 0 || usedKeyword) reasons.add('keyword_match');
    if ((debug?.recencyScore ?? 0) > 0) reasons.add('recent_relevance');
    if ((debug?.facetMatches || []).length > 0) reasons.add('facet_match');
    if ((debug?.graphPaths || []).length > 0) reasons.add('entity_overlap');
    if ((result.fallbackTrace || []).some((step) => step === 'fallback:summary')) reasons.add('summary_fallback');
    if (memory.sessionContext) reasons.add('continuity_link');
    if (memory.event.eventType === 'tool_observation') reasons.add('tool_followup');
    if (reasons.size === 0) reasons.add(usedVector ? 'semantic_match' : 'keyword_match');

    return Array.from(reasons);
  }

  private reasonsForContextEvent(event: MemoryEvent): RetrievalDisclosureReason[] {
    if (event.eventType === 'tool_observation') return ['tool_followup'];
    if (event.eventType === 'session_summary') return ['summary_fallback'];
    return ['continuity_link'];
  }

  private resultTypeForEvent(event: MemoryEvent): RetrievalDisclosureResultType {
    if (event.eventType === 'session_summary') return 'summary';
    if (event.eventType === 'tool_observation') return 'tool_evidence';
    return 'source';
  }

  private sourceReferenceForEvent(event: MemoryEvent): RetrievalDisclosureSourceReference {
    return {
      sourceRef: toDisclosureResultId(event.id),
      sourceType: this.sourceTypeForEvent(event),
      eventIds: [event.id]
    };
  }

  private sourceReferenceForShared(entry: SharedTroubleshootingEntry): RetrievalDisclosureSourceReference {
    return {
      sourceRef: `shared:${entry.entryId}`,
      sourceType: 'shared_troubleshooting',
      eventIds: [],
      metadata: {
        sourceProjectHash: entry.sourceProjectHash,
        sourceEntryId: entry.sourceEntryId,
        topics: entry.topics
      }
    };
  }

  private sourceTypeForEvent(event: MemoryEvent): RetrievalDisclosureSourceType {
    const metadata = event.metadata || {};
    if (event.eventType === 'tool_observation') return 'tool_output';
    if (typeof metadata.transcriptPath === 'string') return 'transcript';
    if (typeof metadata.importedFrom === 'string') return 'imported_history';
    return 'raw_event';
  }

  private titleForEvent(event: MemoryEvent): string {
    if (event.eventType === 'session_summary') return 'Session summary';
    if (event.eventType === 'tool_observation') return 'Tool evidence';
    if (event.eventType === 'agent_response') return 'Agent response';
    return 'User prompt';
  }

  private usedVector(result: UnifiedRetrievalResult): boolean {
    return (result.fallbackTrace || []).some((step) => step.includes(':deep'));
  }

  private usedKeyword(result: UnifiedRetrievalResult): boolean {
    return (result.fallbackTrace || []).some((step) => step.includes(':fast')) ||
      [...(result.selectedDebug || []), ...(result.candidateDebug || [])]
        .some((detail) => (detail.lexicalScore ?? 0) > 0);
  }

  private fallbackApplied(result: UnifiedRetrievalResult): boolean {
    return (result.fallbackTrace || []).some((step) => step.includes('fallback'));
  }

  private formatTimelineContext(events: MemoryEvent[]): string {
    return events
      .map((event) => `[${event.eventType}] ${event.content}`)
      .join('\n\n');
  }

  private formatSharedContext(entry: SharedTroubleshootingEntry): string {
    return [
      `[shared_troubleshooting] ${entry.title}`,
      `Symptoms: ${entry.symptoms.join('; ')}`,
      `Root cause: ${entry.rootCause}`,
      `Solution: ${entry.solution}`,
      `Topics: ${entry.topics.join(', ')}`
    ].join('\n');
  }

  private preview(content: string, maxLength: number): string {
    const normalized = content.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
  }
}

export function toDisclosureResultId(eventId: string): string {
  return eventId.startsWith('event:') ? eventId : `event:${eventId}`;
}

export type ParsedDisclosureResultId =
  | { kind: 'event'; eventId: string }
  | { kind: 'shared'; entryId: string };

export function parseDisclosureResultId(resultId: string): string {
  return resultId.startsWith('event:') ? resultId.slice('event:'.length) : resultId;
}

export function parseDisclosureResultRef(resultId: string): ParsedDisclosureResultId {
  if (resultId.startsWith('shared:')) {
    return { kind: 'shared', entryId: resultId.slice('shared:'.length) };
  }
  return {
    kind: 'event',
    eventId: parseDisclosureResultId(resultId)
  };
}

export function createRetrievalDisclosureService(
  deps: RetrievalDisclosureServiceDeps
): RetrievalDisclosureService {
  return new RetrievalDisclosureService(deps);
}
