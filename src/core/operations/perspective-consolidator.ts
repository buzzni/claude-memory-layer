import {
  ActorCardEntrySchema,
  type ActorCard,
  type CreatePerspectiveObservationInput,
  type DeletePerspectiveObservationInput,
  type GetActorCardInput,
  type MemoryOperationsConfig,
  type PerspectiveConsolidationSpecialistKind,
  type PerspectiveObservation,
  type QueryPerspectiveObservationsInput,
  type UpsertActorCardInput
} from '../types.js';
import { sanitizeGovernanceAuditValue } from './governance-audit.js';

const CONSOLIDATOR_ACTOR = 'perspective-consolidator';
const MAX_ACTOR_CARD_ENTRIES = 40;
const DEFAULT_ENABLED_KINDS: PerspectiveConsolidationSpecialistKind[] = [
  'deduction',
  'induction',
  'contradiction',
  'actor_card_maintenance'
];

export interface PerspectiveConsolidatorObservationStore {
  query(input: QueryPerspectiveObservationsInput): Promise<PerspectiveObservation[]>;
  create(input: CreatePerspectiveObservationInput): Promise<PerspectiveObservation>;
  deleteSoft?(input: DeletePerspectiveObservationInput): Promise<PerspectiveObservation>;
}

export interface PerspectiveConsolidatorActorCardStore {
  get(input: GetActorCardInput): Promise<ActorCard | null>;
  upsert(input: UpsertActorCardInput): Promise<ActorCard>;
}

type PerspectiveSpecialistsConfig = NonNullable<
  NonNullable<MemoryOperationsConfig['perspectiveMemory']>['specialists']
>;

interface NormalizedPerspectiveSpecialistsConfig {
  enabled: boolean;
  enabledProjectHashes: string[];
  enabledKinds: PerspectiveConsolidationSpecialistKind[];
  maxSourceObservations: number;
  maxDerivedObservations: number;
  maxCardUpdates: number;
}

export interface PerspectiveConsolidatorOptions {
  observations: PerspectiveConsolidatorObservationStore;
  actorCards: PerspectiveConsolidatorActorCardStore;
  config?: Partial<PerspectiveSpecialistsConfig>;
}

export interface RunPerspectiveConsolidationInput {
  projectHash: string;
  observerActorId: string;
  observedActorId: string;
  sessionId?: string;
  actor?: string;
}

export interface PerspectiveSpecialistMetrics {
  observationsCreated: number;
  observationsDeleted: number;
  cardUpdates: number;
  rejectedCandidates: number;
}

export type PerspectiveSpecialistMetricsByKind = Record<
  PerspectiveConsolidationSpecialistKind,
  PerspectiveSpecialistMetrics
>;

export interface PerspectiveConsolidationMetrics {
  observationsExamined: number;
  observationsCreated: number;
  observationsDeleted: number;
  cardUpdates: number;
  rejectedCandidates: number;
  specialists: PerspectiveSpecialistMetricsByKind;
}

export type PerspectiveConsolidationSkipReason = 'disabled' | 'not_opted_in' | 'no_source_observations';

export type PerspectiveConsolidationResult =
  | { status: 'ok'; metrics: PerspectiveConsolidationMetrics }
  | { status: 'skipped'; reason: PerspectiveConsolidationSkipReason; metrics: PerspectiveConsolidationMetrics };

export class PerspectiveConsolidator {
  private readonly observations: PerspectiveConsolidatorObservationStore;
  private readonly actorCards: PerspectiveConsolidatorActorCardStore;
  private readonly config: NormalizedPerspectiveSpecialistsConfig;

  constructor(options: PerspectiveConsolidatorOptions) {
    this.observations = options.observations;
    this.actorCards = options.actorCards;
    this.config = normalizeConfig(options.config);
  }

  async run(input: RunPerspectiveConsolidationInput): Promise<PerspectiveConsolidationResult> {
    const metrics = createEmptyMetrics();
    const projectHash = normalizeRequired(input.projectHash);
    if (!this.config.enabled) {
      return { status: 'skipped', reason: 'disabled', metrics };
    }
    if (!this.config.enabledProjectHashes.includes(projectHash)) {
      return { status: 'skipped', reason: 'not_opted_in', metrics };
    }

    const sources = await this.observations.query({
      projectHash,
      observerActorId: normalizeRequired(input.observerActorId),
      observedActorId: normalizeRequired(input.observedActorId),
      sessionId: normalizeOptional(input.sessionId),
      levels: ['explicit'],
      limit: this.config.maxSourceObservations
    });
    metrics.observationsExamined = sources.length;
    if (sources.length === 0) {
      return { status: 'skipped', reason: 'no_source_observations', metrics };
    }

    await this.runDeduction(input, sources, metrics);
    await this.runInduction(input, sources, metrics);
    await this.runContradiction(input, sources, metrics);
    await this.runActorCardMaintenance(input, sources, metrics);

    return { status: 'ok', metrics };
  }

  private isKindEnabled(kind: PerspectiveConsolidationSpecialistKind): boolean {
    return this.config.enabledKinds.includes(kind);
  }

  private canCreateDerived(metrics: PerspectiveConsolidationMetrics): boolean {
    return metrics.observationsCreated < this.config.maxDerivedObservations;
  }

  private async runDeduction(
    input: RunPerspectiveConsolidationInput,
    sources: PerspectiveObservation[],
    metrics: PerspectiveConsolidationMetrics
  ): Promise<void> {
    const kind: PerspectiveConsolidationSpecialistKind = 'deduction';
    if (!this.isKindEnabled(kind)) return;

    for (const source of sources) {
      if (!this.canCreateDerived(metrics)) break;
      if (!hasObservationEvidence(source)) {
        recordRejected(metrics, kind);
        continue;
      }
      const content = normalizeGeneratedContent(
        `Deduction: evidence supports a durable perspective claim — ${source.content}`
      );
      await this.createDerivedObservation(input, [source], 'deductive', content, kind, metrics, source.confidence);
    }
  }

  private async runInduction(
    input: RunPerspectiveConsolidationInput,
    sources: PerspectiveObservation[],
    metrics: PerspectiveConsolidationMetrics
  ): Promise<void> {
    const kind: PerspectiveConsolidationSpecialistKind = 'induction';
    if (!this.isKindEnabled(kind) || !this.canCreateDerived(metrics)) return;
    const evidenceSources = sources.filter(hasObservationEvidence).slice(0, Math.max(2, this.config.maxSourceObservations));
    if (evidenceSources.length < 2) {
      recordRejected(metrics, kind);
      return;
    }

    const content = normalizeGeneratedContent(
      `Induction: ${evidenceSources.length} explicit observations suggest a recurring pattern for this actor perspective.`
    );
    const confidence = Math.min(0.95, averageConfidence(evidenceSources));
    await this.createDerivedObservation(input, evidenceSources, 'inductive', content, kind, metrics, confidence);
  }

  private async runContradiction(
    input: RunPerspectiveConsolidationInput,
    sources: PerspectiveObservation[],
    metrics: PerspectiveConsolidationMetrics
  ): Promise<void> {
    const kind: PerspectiveConsolidationSpecialistKind = 'contradiction';
    if (!this.isKindEnabled(kind)) return;
    const claims = sources
      .map((source) => ({ source, claim: extractPreferenceClaim(source.content) }))
      .filter((entry): entry is { source: PerspectiveObservation; claim: PreferenceClaim } => entry.claim !== null);

    for (let outer = 0; outer < claims.length; outer += 1) {
      if (!this.canCreateDerived(metrics)) break;
      for (let inner = outer + 1; inner < claims.length; inner += 1) {
        if (!this.canCreateDerived(metrics)) break;
        const first = claims[outer];
        const second = claims[inner];
        if (first.claim.key !== second.claim.key || first.claim.negated === second.claim.negated) continue;
        if (!hasObservationEvidence(first.source) || !hasObservationEvidence(second.source)) {
          recordRejected(metrics, kind);
          continue;
        }
        const content = normalizeGeneratedContent(
          `Contradiction: source observations conflict about preference "${first.claim.label}".`
        );
        const confidence = Math.min(first.source.confidence, second.source.confidence);
        await this.createDerivedObservation(input, [first.source, second.source], 'contradiction', content, kind, metrics, confidence);
      }
    }
  }

  private async runActorCardMaintenance(
    input: RunPerspectiveConsolidationInput,
    sources: PerspectiveObservation[],
    metrics: PerspectiveConsolidationMetrics
  ): Promise<void> {
    const kind: PerspectiveConsolidationSpecialistKind = 'actor_card_maintenance';
    if (!this.isKindEnabled(kind) || this.config.maxCardUpdates === 0) return;

    const card = await this.actorCards.get({
      projectHash: normalizeRequired(input.projectHash),
      observerActorId: normalizeRequired(input.observerActorId),
      observedActorId: normalizeRequired(input.observedActorId)
    });
    const entries = [...(card?.entries ?? [])];
    const sourceEventIds = new Set(card?.sourceEventIds ?? []);
    let updates = 0;

    for (const source of sources) {
      if (updates >= this.config.maxCardUpdates || entries.length >= MAX_ACTOR_CARD_ENTRIES) break;
      if (source.sourceEventIds.length === 0) {
        recordRejected(metrics, kind);
        continue;
      }
      const entry = actorCardEntryFromObservation(source);
      if (!entry || entries.includes(entry)) {
        recordRejected(metrics, kind);
        continue;
      }
      entries.push(entry);
      for (const sourceEventId of source.sourceEventIds) sourceEventIds.add(sourceEventId);
      updates += 1;
    }

    if (updates === 0) return;
    await this.actorCards.upsert({
      projectHash: normalizeRequired(input.projectHash),
      observerActorId: normalizeRequired(input.observerActorId),
      observedActorId: normalizeRequired(input.observedActorId),
      entries,
      sourceEventIds: Array.from(sourceEventIds),
      updatedBy: normalizeOptional(input.actor) ?? CONSOLIDATOR_ACTOR
    });
    metrics.cardUpdates += updates;
    metrics.specialists[kind].cardUpdates += updates;
  }

  private async createDerivedObservation(
    input: RunPerspectiveConsolidationInput,
    sources: PerspectiveObservation[],
    level: 'deductive' | 'inductive' | 'contradiction',
    content: string,
    specialist: PerspectiveConsolidationSpecialistKind,
    metrics: PerspectiveConsolidationMetrics,
    confidence: number
  ): Promise<void> {
    const sourceObservationIds = uniqueStrings(sources.map((source) => source.observationId));
    const sourceEventIds = uniqueStrings(sources.flatMap((source) => source.sourceEventIds));
    if (sourceObservationIds.length === 0 && sourceEventIds.length === 0) {
      recordRejected(metrics, specialist);
      return;
    }

    await this.observations.create({
      projectHash: normalizeRequired(input.projectHash),
      observerActorId: normalizeRequired(input.observerActorId),
      observedActorId: normalizeRequired(input.observedActorId),
      sessionId: normalizeOptional(input.sessionId),
      level,
      content,
      confidence: clampConfidence(confidence),
      sourceEventIds,
      sourceObservationIds,
      createdBy: 'rule',
      metadata: {
        specialist,
        sourceObservationCount: sourceObservationIds.length
      },
      actor: CONSOLIDATOR_ACTOR
    });
    metrics.observationsCreated += 1;
    metrics.specialists[specialist].observationsCreated += 1;
  }
}

export function createPerspectiveConsolidator(options: PerspectiveConsolidatorOptions): PerspectiveConsolidator {
  return new PerspectiveConsolidator(options);
}

function normalizeConfig(config: Partial<PerspectiveSpecialistsConfig> | undefined): NormalizedPerspectiveSpecialistsConfig {
  return {
    enabled: config?.enabled === true,
    enabledProjectHashes: uniqueStrings((config?.enabledProjectHashes ?? []).map((projectHash) => projectHash.trim())),
    enabledKinds: normalizeKinds(config?.enabledKinds),
    maxSourceObservations: clampInteger(config?.maxSourceObservations, 20, 1, 100),
    maxDerivedObservations: clampInteger(config?.maxDerivedObservations, 5, 0, 20),
    maxCardUpdates: clampInteger(config?.maxCardUpdates, 3, 0, 40)
  };
}

function normalizeKinds(kinds: readonly PerspectiveConsolidationSpecialistKind[] | undefined): PerspectiveConsolidationSpecialistKind[] {
  const input = kinds ?? DEFAULT_ENABLED_KINDS;
  const allowed = new Set(DEFAULT_ENABLED_KINDS);
  return uniqueStrings(input).filter((kind): kind is PerspectiveConsolidationSpecialistKind => allowed.has(kind as PerspectiveConsolidationSpecialistKind));
}

function createEmptyMetrics(): PerspectiveConsolidationMetrics {
  return {
    observationsExamined: 0,
    observationsCreated: 0,
    observationsDeleted: 0,
    cardUpdates: 0,
    rejectedCandidates: 0,
    specialists: {
      deduction: createEmptySpecialistMetrics(),
      induction: createEmptySpecialistMetrics(),
      contradiction: createEmptySpecialistMetrics(),
      actor_card_maintenance: createEmptySpecialistMetrics()
    }
  };
}

function createEmptySpecialistMetrics(): PerspectiveSpecialistMetrics {
  return {
    observationsCreated: 0,
    observationsDeleted: 0,
    cardUpdates: 0,
    rejectedCandidates: 0
  };
}

function recordRejected(metrics: PerspectiveConsolidationMetrics, kind: PerspectiveConsolidationSpecialistKind): void {
  metrics.rejectedCandidates += 1;
  metrics.specialists[kind].rejectedCandidates += 1;
}

function hasObservationEvidence(source: PerspectiveObservation): boolean {
  return source.sourceEventIds.length > 0 || source.sourceObservationIds.length > 0;
}

function normalizeGeneratedContent(value: string): string {
  const sanitized = sanitizeGovernanceAuditValue(value);
  const text = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);
  return text.replace(/\s+/g, ' ').trim().slice(0, 600);
}

function actorCardEntryFromObservation(source: PerspectiveObservation): string | null {
  const content = normalizeGeneratedContent(source.content).replace(/[.!?]+$/, '');
  const preference = content.match(/^(?:user|they|the user)\s+(?:strongly\s+)?prefers?\s+(.+)$/i);
  if (preference?.[1]) {
    return parseActorCardEntry(`INSTRUCTION: Prefers ${preference[1].trim()}.`);
  }

  const identity = content.match(/^(?:user|they|the user)\s+is\s+(.+)$/i);
  if (identity?.[1]) {
    return parseActorCardEntry(`IDENTITY: Is ${sentenceCase(identity[1])}.`);
  }

  return null;
}

function parseActorCardEntry(entry: string): string | null {
  if (/\[REDACTED\]/i.test(entry)) return null;
  const parsed = ActorCardEntrySchema.safeParse(entry);
  return parsed.success ? parsed.data : null;
}

interface PreferenceClaim {
  key: string;
  label: string;
  negated: boolean;
}

function extractPreferenceClaim(content: string): PreferenceClaim | null {
  const normalized = normalizeGeneratedContent(content).replace(/[.!?]+$/, '');
  const match = normalized.match(/^(?:user|they|the user)\s+(does\s+not\s+prefer|prefers?)\s+(.+)$/i);
  if (!match?.[1] || !match?.[2]) return null;
  const negated = /does\s+not/i.test(match[1]);
  const label = match[2].trim().replace(/[.!?]+$/, '');
  if (!label) return null;
  return {
    key: label.toLowerCase().replace(/\s+/g, ' '),
    label,
    negated
  };
}

function sentenceCase(value: string): string {
  const normalized = value.trim();
  if (!normalized) return normalized;
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

function averageConfidence(sources: PerspectiveObservation[]): number {
  if (sources.length === 0) return 0.5;
  return sources.reduce((sum, source) => sum + source.confidence, 0) / sources.length;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const normalized = value;
  if (typeof normalized !== 'number' || !Number.isInteger(normalized)) return fallback;
  return Math.max(min, Math.min(max, normalized));
}

function normalizeRequired(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('Perspective consolidation scope field is required');
  return normalized;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}
