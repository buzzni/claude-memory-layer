import { sanitizeGovernanceAuditValue } from './governance-audit.js';
import type {
  MemoryActor,
  MemoryEvent,
  MemoryOperationsConfig,
  PerspectiveObservation,
  PerspectiveObservationCreatedBy,
  PerspectiveObservationLevel,
  SessionActor
} from '../types.js';

export interface PerspectiveObservationCandidate {
  content: string;
  confidence?: number;
  level?: PerspectiveObservationLevel;
  createdBy?: PerspectiveObservationCreatedBy;
  observedActorId?: string;
  metadata?: Record<string, unknown>;
}

export interface PerspectiveObservationExtractor {
  extract(
    event: MemoryEvent,
    context: { projectHash?: string; projectPath?: string | null }
  ): Promise<PerspectiveObservationCandidate[]>;
}

export interface PerspectiveDeriverActors {
  resolveFromEvent(event: MemoryEvent, options?: { projectHash?: string }): Promise<MemoryActor>;
}

export interface PerspectiveDeriverSessions {
  listBySession(input: { projectHash?: string; sessionId: string; limit?: number }): Promise<SessionActor[]>;
  upsertMembership(input: {
    projectHash?: string;
    sessionId: string;
    actorId: string;
    roleInSession: SessionActor['roleInSession'];
    observeSelf?: boolean;
    observeOthers?: boolean;
    metadata?: Record<string, unknown>;
  }): Promise<SessionActor>;
}

export interface PerspectiveDeriverObservations {
  create(input: {
    projectHash?: string;
    observerActorId: string;
    observedActorId: string;
    sessionId?: string;
    level?: PerspectiveObservationLevel;
    content: string;
    confidence?: number;
    sourceEventIds: string[];
    sourceObservationIds?: string[];
    createdBy?: PerspectiveObservationCreatedBy;
    metadata?: Record<string, unknown>;
    actor?: string;
  }): Promise<PerspectiveObservation>;
}

export interface PerspectiveDeriverOptions {
  actors: PerspectiveDeriverActors;
  sessions: PerspectiveDeriverSessions;
  observations: PerspectiveDeriverObservations;
  extractor?: PerspectiveObservationExtractor;
  config?: MemoryOperationsConfig['perspectiveMemory'];
}

export type PerspectiveDerivationResult =
  | { status: 'skipped'; reason: 'disabled' | 'unsupported_event' | 'no_candidates' | 'no_observers'; created: 0; updated: 0 }
  | { status: 'ok'; created: number; updated: number }
  | { status: 'failed'; reason: 'extract_failed' | 'persist_failed'; created: number; updated: number; error: string };

interface NormalizedPerspectiveDeriverConfig {
  enabled: boolean;
  deriver: {
    enabled: boolean;
    maxEventsPerBatch: number;
    maxObserversPerSession: number;
  };
}

const DEFAULT_CONFIG: NormalizedPerspectiveDeriverConfig = {
  enabled: false,
  deriver: {
    enabled: false,
    maxEventsPerBatch: 20,
    maxObserversPerSession: 5
  }
};

const MAX_OBSERVATION_CONTENT_CHARS = 600;

export class RuleBasedPerspectiveObservationExtractor implements PerspectiveObservationExtractor {
  async extract(event: MemoryEvent): Promise<PerspectiveObservationCandidate[]> {
    if (!isSupportedSourceEvent(event)) return [];
    const content = normalizeObservationContent(event.content);
    if (!content) return [];
    return [{
      content,
      confidence: 0.6,
      level: 'explicit',
      createdBy: 'rule',
      metadata: {
        extractor: 'rule-based-minimal',
        sourceEventType: event.eventType
      }
    }];
  }
}

export class PerspectiveDeriver {
  private readonly actors: PerspectiveDeriverActors;
  private readonly sessions: PerspectiveDeriverSessions;
  private readonly observations: PerspectiveDeriverObservations;
  private readonly extractor: PerspectiveObservationExtractor;
  private readonly config: NormalizedPerspectiveDeriverConfig;

  constructor(options: PerspectiveDeriverOptions) {
    this.actors = options.actors;
    this.sessions = options.sessions;
    this.observations = options.observations;
    this.extractor = options.extractor ?? new RuleBasedPerspectiveObservationExtractor();
    this.config = normalizeConfig(options.config);
  }

  async deriveFromEvent(
    event: MemoryEvent,
    context: { projectHash?: string | null; projectPath?: string | null } = {}
  ): Promise<PerspectiveDerivationResult> {
    if (!this.config.enabled || !this.config.deriver.enabled) {
      return { status: 'skipped', reason: 'disabled', created: 0, updated: 0 };
    }
    if (!isSupportedSourceEvent(event)) {
      return { status: 'skipped', reason: 'unsupported_event', created: 0, updated: 0 };
    }

    const projectHash = normalizeOptionalString(context.projectHash);
    const projectPath = context.projectPath ?? null;
    let candidates: PerspectiveObservationCandidate[];
    try {
      // Extraction may be backed by an LLM. Keep it before persistence writes so
      // no long-lived SQLite transaction can span an external model call.
      candidates = (await this.extractor.extract(event, { projectHash, projectPath }))
        .map(normalizeCandidate)
        .filter((candidate): candidate is NormalizedPerspectiveObservationCandidate => candidate !== null);
    } catch (error) {
      return { status: 'failed', reason: 'extract_failed', created: 0, updated: 0, error: safeErrorMessage(error) };
    }
    if (candidates.length === 0) {
      return { status: 'skipped', reason: 'no_candidates', created: 0, updated: 0 };
    }

    try {
      const sourceActor = await this.actors.resolveFromEvent(event, { projectHash });
      let members = await this.sessions.listBySession({
        projectHash,
        sessionId: event.sessionId,
        limit: this.config.deriver.maxObserversPerSession * 2
      });
      if (!members.some((member) => member.actorId === sourceActor.actorId)) {
        await this.sessions.upsertMembership({
          projectHash,
          sessionId: event.sessionId,
          actorId: sourceActor.actorId,
          roleInSession: roleForEvent(event),
          observeSelf: true,
          observeOthers: false,
          metadata: { source: 'perspective-deriver' }
        });
        members = await this.sessions.listBySession({
          projectHash,
          sessionId: event.sessionId,
          limit: this.config.deriver.maxObserversPerSession * 2
        });
      }

      let saved = 0;
      for (const candidate of candidates) {
        const observedActorId = candidate.observedActorId ?? sourceActor.actorId;
        const observers = selectObservers(members, observedActorId, this.config.deriver.maxObserversPerSession);
        if (observers.length === 0) continue;
        for (const observerActorId of observers) {
          await this.observations.create({
            projectHash,
            observerActorId,
            observedActorId,
            sessionId: event.sessionId,
            level: candidate.level,
            content: candidate.content,
            confidence: candidate.confidence,
            sourceEventIds: [event.id],
            sourceObservationIds: [],
            createdBy: candidate.createdBy,
            metadata: {
              deriver: 'minimal-perspective-deriver',
              sourceEventType: event.eventType,
              ...(candidate.metadata ?? {})
            },
            actor: 'perspective-deriver'
          });
          saved += 1;
        }
      }

      if (saved === 0) {
        return { status: 'skipped', reason: 'no_observers', created: 0, updated: 0 };
      }
      return { status: 'ok', created: saved, updated: 0 };
    } catch (error) {
      return { status: 'failed', reason: 'persist_failed', created: 0, updated: 0, error: safeErrorMessage(error) };
    }
  }
}

interface NormalizedPerspectiveObservationCandidate {
  content: string;
  confidence: number;
  level: PerspectiveObservationLevel;
  createdBy: PerspectiveObservationCreatedBy;
  observedActorId?: string;
  metadata?: Record<string, unknown>;
}

function normalizeConfig(config: MemoryOperationsConfig['perspectiveMemory'] | undefined): NormalizedPerspectiveDeriverConfig {
  return {
    enabled: config?.enabled ?? DEFAULT_CONFIG.enabled,
    deriver: {
      enabled: config?.deriver?.enabled ?? DEFAULT_CONFIG.deriver.enabled,
      maxEventsPerBatch: clampInteger(
        config?.deriver?.maxEventsPerBatch,
        DEFAULT_CONFIG.deriver.maxEventsPerBatch,
        1,
        100
      ),
      maxObserversPerSession: clampInteger(
        config?.deriver?.maxObserversPerSession,
        DEFAULT_CONFIG.deriver.maxObserversPerSession,
        1,
        50
      )
    }
  };
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(Number(value))));
}

function isSupportedSourceEvent(event: MemoryEvent): boolean {
  return event.eventType === 'user_prompt' || event.eventType === 'agent_response';
}

function roleForEvent(event: MemoryEvent): SessionActor['roleInSession'] {
  if (event.eventType === 'user_prompt') return 'speaker';
  if (event.eventType === 'agent_response') return 'assistant';
  if (event.eventType === 'tool_observation') return 'tool';
  if (event.eventType === 'session_summary') return 'system';
  return 'unknown';
}

function normalizeCandidate(candidate: PerspectiveObservationCandidate): NormalizedPerspectiveObservationCandidate | null {
  const content = normalizeObservationContent(candidate.content);
  if (!content) return null;
  return {
    content,
    confidence: clampNumber(candidate.confidence, 0.6, 0, 1),
    level: candidate.level ?? 'explicit',
    createdBy: candidate.createdBy ?? 'rule',
    observedActorId: normalizeOptionalString(candidate.observedActorId),
    metadata: sanitizeCandidateMetadata(candidate.metadata)
  };
}

function normalizeObservationContent(content: string): string | null {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.slice(0, MAX_OBSERVATION_CONTENT_CHARS);
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : undefined;
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Number(value)));
}

function sanitizeCandidateMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function selectObservers(members: SessionActor[], observedActorId: string, maxObservers: number): string[] {
  const selected: string[] = [];
  for (const member of members) {
    const canObserve = member.actorId === observedActorId ? member.observeSelf : member.observeOthers;
    if (!canObserve) continue;
    if (!selected.includes(member.actorId)) selected.push(member.actorId);
    if (selected.length >= maxObservers) break;
  }
  return selected;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = sanitizeGovernanceAuditValue(message);
  return String(sanitized).replace(/\s+/g, ' ').slice(0, 160);
}

export function createPerspectiveDeriver(options: PerspectiveDeriverOptions): PerspectiveDeriver {
  return new PerspectiveDeriver(options);
}
