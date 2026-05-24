import { generateCitationId } from '../citation-generator.js';
import { applyPrivacyFilter } from '../privacy/filter.js';
import type {
  ActorCard,
  Config,
  MemoryEvent,
  PerspectiveObservation,
  PerspectiveObservationLevel,
  SessionActor
} from '../types.js';
import { sanitizeGovernanceAuditValue } from './governance-audit.js';

export type PerspectiveQueryReasoningLevel = 'minimal' | 'low' | 'high';

export type PerspectiveQueryToolName =
  | 'search_perspective_observations'
  | 'search_raw_events'
  | 'expand_source_refs'
  | 'read_actor_card'
  | 'list_session_actors';

export interface PerspectiveQueryObservationSearchInput {
  projectHash?: string;
  observerActorId?: string;
  observedActorId?: string;
  sessionId?: string;
  levels?: PerspectiveObservationLevel[];
  query: string;
  limit: number;
}

export interface PerspectiveQueryRawEventSearchInput {
  projectHash?: string;
  sessionId?: string;
  query: string;
  limit: number;
}

export interface PerspectiveQuerySourceRefExpansionInput {
  projectHash?: string;
  sourceRefs: string[];
  limit: number;
}

export interface PerspectiveQueryActorCardInput {
  projectHash?: string;
  observerActorId: string;
  observedActorId: string;
}

export interface PerspectiveQuerySessionActorsInput {
  projectHash?: string;
  sessionId: string;
  limit: number;
}

export interface PerspectiveQueryRawEventResult {
  event: MemoryEvent;
  score?: number;
  rank?: number;
}

export interface PerspectiveQueryExpandedSourceRef {
  sourceRef: string;
  preview?: string;
  eventIds?: string[];
}

export interface PerspectiveQueryAgentTools {
  searchPerspectiveObservations(input: PerspectiveQueryObservationSearchInput): Promise<PerspectiveObservation[]>;
  searchRawEvents(input: PerspectiveQueryRawEventSearchInput): Promise<PerspectiveQueryRawEventResult[]>;
  expandSourceRefs?(input: PerspectiveQuerySourceRefExpansionInput): Promise<PerspectiveQueryExpandedSourceRef[]>;
  readActorCard?(input: PerspectiveQueryActorCardInput): Promise<ActorCard | null>;
  listSessionActors?(input: PerspectiveQuerySessionActorsInput): Promise<SessionActor[]>;
}

export interface PerspectiveQueryAgentOptions {
  tools: PerspectiveQueryAgentTools;
  maxToolIterationsByReasoningLevel?: Partial<Record<PerspectiveQueryReasoningLevel, number>>;
  limits?: {
    minimalSearchLimit?: number;
    lowSearchLimit?: number;
    highSearchLimit?: number;
  };
}

export interface PerspectiveQueryRequest {
  projectHash?: string;
  observerActorId?: string;
  observedActorId?: string;
  sessionId?: string;
  question: string;
  reasoningLevel?: PerspectiveQueryReasoningLevel;
}

export interface PerspectiveQueryToolCall {
  name: PerspectiveQueryToolName;
  input: Record<string, unknown>;
  resultCount: number;
}

export interface PerspectiveQueryAnswer {
  answer: string;
  reasoningLevel: PerspectiveQueryReasoningLevel;
  sourceRefs: string[];
  toolCalls: PerspectiveQueryToolCall[];
  hitToolIterationCap: boolean;
}

interface EvidenceItem {
  kind: 'perspective_observation' | 'raw_event' | 'actor_card' | 'session_actor' | 'expanded_source';
  text: string;
  confidence?: number;
  sourceRefs: string[];
}

const DEFAULT_TOOL_CAPS: Record<PerspectiveQueryReasoningLevel, number> = {
  minimal: 2,
  low: 4,
  high: 6
};

const DEFAULT_SEARCH_LIMITS: Record<PerspectiveQueryReasoningLevel, number> = {
  minimal: 3,
  low: 6,
  high: 12
};

const QUERY_AGENT_PRIVACY_CONFIG: Config['privacy'] = {
  excludePatterns: ['password', 'secret', 'api_key', 'api-key', 'token', 'bearer'],
  anonymize: false,
  privateTags: {
    enabled: true,
    marker: '[PRIVATE]',
    preserveLineCount: false,
    supportedFormats: ['xml']
  }
};

export class PerspectiveQueryAgent {
  private readonly tools: PerspectiveQueryAgentTools;
  private readonly caps: Record<PerspectiveQueryReasoningLevel, number>;
  private readonly searchLimits: Record<PerspectiveQueryReasoningLevel, number>;

  constructor(options: PerspectiveQueryAgentOptions) {
    this.tools = options.tools;
    this.caps = { ...DEFAULT_TOOL_CAPS, ...options.maxToolIterationsByReasoningLevel };
    this.searchLimits = {
      minimal: options.limits?.minimalSearchLimit ?? DEFAULT_SEARCH_LIMITS.minimal,
      low: options.limits?.lowSearchLimit ?? DEFAULT_SEARCH_LIMITS.low,
      high: options.limits?.highSearchLimit ?? DEFAULT_SEARCH_LIMITS.high
    };
  }

  async answer(request: PerspectiveQueryRequest): Promise<PerspectiveQueryAnswer> {
    const reasoningLevel = request.reasoningLevel ?? 'minimal';
    const toolCalls: PerspectiveQueryToolCall[] = [];
    const evidence: EvidenceItem[] = [];
    let hitToolIterationCap = false;

    const question = normalizeQuestion(request.question);
    const limit = this.searchLimits[reasoningLevel];
    const canCallTool = () => {
      if (toolCalls.length >= Math.max(0, this.caps[reasoningLevel])) {
        hitToolIterationCap = true;
        return false;
      }
      return true;
    };

    const runTool = async <T>(
      name: PerspectiveQueryToolName,
      input: object,
      tool: () => Promise<T>,
      count: (result: T) => number
    ): Promise<T | undefined> => {
      if (!canCallTool()) return undefined;
      const result = await tool();
      toolCalls.push({ name, input: sanitizeToolInput(input), resultCount: count(result) });
      return result;
    };

    const observationInput: PerspectiveQueryObservationSearchInput = omitUndefined({
      projectHash: request.projectHash,
      observerActorId: request.observerActorId,
      observedActorId: request.observedActorId,
      sessionId: request.sessionId,
      query: question,
      limit
    });
    const observations = await runTool(
      'search_perspective_observations',
      observationInput,
      () => this.tools.searchPerspectiveObservations(observationInput),
      (result) => result.length
    );
    if (observations) evidence.push(...observations.map(observationEvidence));

    const rawInput: PerspectiveQueryRawEventSearchInput = omitUndefined({
      projectHash: request.projectHash,
      sessionId: request.sessionId,
      query: question,
      limit
    });
    const rawEvents = await runTool(
      'search_raw_events',
      rawInput,
      () => this.tools.searchRawEvents(rawInput),
      (result) => result.length
    );
    if (rawEvents) evidence.push(...rawEvents.map(rawEventEvidence));

    if (reasoningLevel !== 'minimal') {
      await this.collectNonMinimalEvidence(request, reasoningLevel, runTool, evidence);
    }

    const sourceRefs = uniqueStrings(evidence.flatMap((item) => item.sourceRefs));
    return {
      answer: renderAnswer(question, reasoningLevel, evidence, sourceRefs, hitToolIterationCap),
      reasoningLevel,
      sourceRefs,
      toolCalls,
      hitToolIterationCap
    };
  }

  private async collectNonMinimalEvidence(
    request: PerspectiveQueryRequest,
    reasoningLevel: PerspectiveQueryReasoningLevel,
    runTool: <T>(
      name: PerspectiveQueryToolName,
      input: object,
      tool: () => Promise<T>,
      count: (result: T) => number
    ) => Promise<T | undefined>,
    evidence: EvidenceItem[]
  ): Promise<void> {
    if (request.observerActorId && request.observedActorId && this.tools.readActorCard) {
      const input: PerspectiveQueryActorCardInput = omitUndefined({
        projectHash: request.projectHash,
        observerActorId: request.observerActorId,
        observedActorId: request.observedActorId
      });
      const card = await runTool('read_actor_card', input, () => this.tools.readActorCard!(input), (result) => result ? 1 : 0);
      if (card) evidence.push(actorCardEvidence(card));
    }

    if (request.sessionId && reasoningLevel === 'high' && this.tools.listSessionActors) {
      const input: PerspectiveQuerySessionActorsInput = omitUndefined({
        projectHash: request.projectHash,
        sessionId: request.sessionId,
        limit: this.searchLimits.high
      });
      const actors = await runTool('list_session_actors', input, () => this.tools.listSessionActors!(input), (result) => result.length);
      if (actors) evidence.push(...actors.map(sessionActorEvidence));
    }

    if (reasoningLevel === 'high' && this.tools.expandSourceRefs) {
      const sourceRefs = uniqueStrings(evidence.flatMap((item) => item.sourceRefs));
      if (sourceRefs.length > 0) {
        const input: PerspectiveQuerySourceRefExpansionInput = omitUndefined({
          projectHash: request.projectHash,
          sourceRefs,
          limit: this.searchLimits.high
        });
        const expanded = await runTool('expand_source_refs', input, () => this.tools.expandSourceRefs!(input), (result) => result.length);
        if (expanded) evidence.push(...expanded.map(expandedSourceEvidence));
      }
    }
  }
}

export function createPerspectiveQueryAgent(options: PerspectiveQueryAgentOptions): PerspectiveQueryAgent {
  return new PerspectiveQueryAgent(options);
}

function normalizeQuestion(question: string): string {
  const normalized = safeText(question, 500);
  if (!normalized) throw new Error('question is required');
  return normalized;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function sanitizeToolInput(input: object): Record<string, unknown> {
  return sanitizeGovernanceAuditValue(input) as Record<string, unknown>;
}

function safeText(value: unknown, maxLength: number): string {
  const rawText = typeof value === 'string' ? value : String(value ?? '');
  const privacyFiltered = applyPrivacyFilter(rawText, QUERY_AGENT_PRIVACY_CONFIG).content;
  const sanitized = sanitizeGovernanceAuditValue(privacyFiltered);
  const text = typeof sanitized === 'string' ? sanitized : String(sanitized ?? '');
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function eventRef(eventId: string): string {
  return `mem:${generateCitationId(eventId)}`;
}

function sourceRefsFromObservation(observation: PerspectiveObservation): string[] {
  const eventRefs = observation.sourceEventIds.map(eventRef);
  const observationRefs = observation.sourceObservationIds.map((sourceObservationId) => `observation:${safeText(sourceObservationId, 120)}`);
  const refs = [...eventRefs, ...observationRefs];
  return refs.length > 0 ? refs : [`observation:${safeText(observation.observationId, 120)}`];
}

function observationEvidence(observation: PerspectiveObservation): EvidenceItem {
  return {
    kind: 'perspective_observation',
    text: safeText(observation.content, 320),
    confidence: observation.confidence,
    sourceRefs: sourceRefsFromObservation(observation)
  };
}

function rawEventEvidence(result: PerspectiveQueryRawEventResult): EvidenceItem {
  return {
    kind: 'raw_event',
    text: safeText(result.event.content, 320),
    confidence: typeof result.score === 'number' ? result.score : undefined,
    sourceRefs: [eventRef(result.event.id)]
  };
}

function actorCardEvidence(card: ActorCard): EvidenceItem {
  const sourceRefs = card.sourceEventIds.map(eventRef);
  return {
    kind: 'actor_card',
    text: card.entries.map((entry) => safeText(entry, 220)).filter(Boolean).join('; '),
    sourceRefs: sourceRefs.length > 0 ? sourceRefs : [`actor-card:${safeText(card.cardId, 120)}`]
  };
}

function sessionActorEvidence(actor: SessionActor): EvidenceItem {
  return {
    kind: 'session_actor',
    text: safeText(`${actor.actorId} (${actor.roleInSession})`, 220),
    sourceRefs: [`session-actor:${safeText(actor.sessionId, 120)}:${safeText(actor.actorId, 120)}`]
  };
}

function expandedSourceEvidence(source: PerspectiveQueryExpandedSourceRef): EvidenceItem {
  return {
    kind: 'expanded_source',
    text: safeText(source.preview ?? source.sourceRef, 320),
    sourceRefs: [safeText(source.sourceRef, 120), ...(source.eventIds ?? []).map(eventRef)]
  };
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const normalized = safeText(value, 160);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function renderAnswer(
  question: string,
  reasoningLevel: PerspectiveQueryReasoningLevel,
  evidence: EvidenceItem[],
  sourceRefs: string[],
  hitToolIterationCap: boolean
): string {
  if (evidence.length === 0) {
    const suffix = hitToolIterationCap ? ' Tool iteration cap was reached before all tools could run.' : '';
    return `No matching memory evidence found for: ${question}.${suffix}\n\nSources: none`;
  }

  const lines = [
    `Answer (${reasoningLevel}, read-only):`,
    ...evidence.slice(0, 6).map((item) => {
      const refs = item.sourceRefs.length > 0 ? ` ${formatSourceRefs(item.sourceRefs)}` : '';
      const confidence = typeof item.confidence === 'number' ? ` confidence=${item.confidence.toFixed(2)}` : '';
      return `- ${item.kind}${confidence}: ${item.text}${refs}`;
    })
  ];
  if (hitToolIterationCap) {
    lines.push('- Note: tool iteration cap reached; answer may be incomplete.');
  }
  lines.push('', `Sources: ${sourceRefs.length > 0 ? formatSourceRefs(sourceRefs) : 'none'}`);
  return lines.join('\n');
}

function formatSourceRefs(sourceRefs: string[]): string {
  return uniqueStrings(sourceRefs).map((sourceRef) => `[${sourceRef}]`).join(' ');
}
