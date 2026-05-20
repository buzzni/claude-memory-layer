import { z } from 'zod';

import { sqliteAll, type SQLiteDatabase } from '../sqlite-wrapper.js';
import type { MemoryLesson } from '../types.js';
import { LessonCandidateService, type LessonCandidate } from './lesson-candidate-service.js';
import { LessonRepository } from './lesson-repository.js';

const NonEmptyStringSchema = z.string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1));

const PromotionStringArraySchema = z.preprocess((value) => {
  if (!Array.isArray(value)) return value;
  return value
    .map((item) => typeof item === 'string' ? item.trim() : item)
    .filter((item) => typeof item !== 'string' || item.length > 0);
}, z.array(NonEmptyStringSchema).max(100));

const ReviewedLessonCandidateSchema = z.object({
  candidateId: NonEmptyStringSchema,
  projectHash: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  trigger: NonEmptyStringSchema,
  steps: PromotionStringArraySchema.refine((steps) => steps.length > 0, 'steps must contain at least one step'),
  confidence: z.number().min(0).max(1),
  sourceSessionIds: PromotionStringArraySchema.default([]),
  sourceEventIds: PromotionStringArraySchema.refine((sourceEventIds) => sourceEventIds.length > 0, 'sourceEventIds is required'),
  failureModes: PromotionStringArraySchema.default([]),
  skillCandidate: z.boolean().default(true)
}).passthrough();

type ReviewedLessonCandidate = z.output<typeof ReviewedLessonCandidateSchema>;

const CandidateSearchInputSchema = z.object({
  minSessions: z.number().int().min(2).max(10).optional(),
  limit: z.number().int().positive().max(100).optional(),
  eventLimit: z.number().int().positive().max(10_000).optional(),
  maxSourceEventIds: z.number().int().positive().max(100).optional()
}).default({});

export const PromoteLessonCandidateInputSchema = z.object({
  projectHash: NonEmptyStringSchema,
  actor: NonEmptyStringSchema,
  candidateId: NonEmptyStringSchema.optional(),
  candidate: ReviewedLessonCandidateSchema.optional(),
  approved: z.boolean().default(false),
  allowHighConfidenceRule: z.boolean().default(false),
  minHighConfidence: z.number().min(0).max(1).default(0.9),
  candidateSearch: CandidateSearchInputSchema
}).superRefine((value, ctx) => {
  if ((value.candidateId ? 1 : 0) + (value.candidate ? 1 : 0) !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['candidateId'],
      message: 'exactly one of candidateId or candidate is required'
    });
  }
});
export type PromoteLessonCandidateInput = z.input<typeof PromoteLessonCandidateInputSchema>;

interface SourceEventRow {
  id: string;
  session_id: string;
  metadata: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function nestedValue(root: Record<string, unknown> | undefined, path: string[]): unknown {
  let cursor: unknown = root;
  for (const key of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function nestedString(root: Record<string, unknown> | undefined, path: string[]): string | undefined {
  const value = nestedValue(root, path);
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function projectHashFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  const direct = typeof metadata?.projectHash === 'string' ? metadata.projectHash.trim() : undefined;
  return nestedString(metadata, ['scope', 'project', 'hash']) ?? direct;
}

function hasActiveQuarantine(metadata: Record<string, unknown> | undefined): boolean {
  const quarantine = nestedValue(metadata, ['quarantine']);
  return isRecord(quarantine) && quarantine.status === 'active';
}

function numericMetadataValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function privacyFilterHasConflict(privacyMetadata: unknown): boolean {
  if (!isRecord(privacyMetadata)) return false;
  return privacyMetadata.hasPrivateTags === true
    || privacyMetadata.hasUnmatchedTags === true
    || numericMetadataValue(privacyMetadata.privateTagCount) > 0
    || numericMetadataValue(privacyMetadata.patternMatchCount) > 0;
}

function hasPrivacyConflict(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  const tags = Array.isArray(metadata.tags)
    ? metadata.tags.map((tag) => String(tag).toLowerCase())
    : [];
  const privacy = nestedString(metadata, ['privacy', 'classification'])
    ?? nestedString(metadata, ['privacy', 'level'])
    ?? (typeof metadata.privacy === 'string' ? metadata.privacy : undefined);
  return hasActiveQuarantine(metadata)
    || metadata.private === true
    || metadata.isPrivate === true
    || metadata.visibility === 'private'
    || privacy === 'private'
    || privacyFilterHasConflict(metadata.privacy)
    || privacyFilterHasConflict(metadata)
    || tags.includes('private')
    || tags.includes('privacy:private');
}

function uniqueStrings(values: string[]): string[] {
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

function candidateToLessonInput(candidate: ReviewedLessonCandidate, actor: string): Record<string, unknown> {
  return {
    projectHash: candidate.projectHash,
    name: candidate.name,
    trigger: candidate.trigger,
    steps: candidate.steps,
    confidence: candidate.confidence,
    sourceSessionIds: candidate.sourceSessionIds,
    sourceEventIds: candidate.sourceEventIds,
    failureModes: candidate.failureModes,
    skillCandidate: candidate.skillCandidate,
    actor
  };
}

function normalizeGeneratedCandidate(candidate: LessonCandidate): ReviewedLessonCandidate {
  return ReviewedLessonCandidateSchema.parse(candidate);
}

export class LessonService {
  private readonly candidateService: LessonCandidateService;
  private readonly lessonRepository: LessonRepository;

  constructor(private readonly db: SQLiteDatabase) {
    this.candidateService = new LessonCandidateService(db);
    this.lessonRepository = new LessonRepository(db);
  }

  async promoteCandidate(input: unknown): Promise<MemoryLesson> {
    const parsed = PromoteLessonCandidateInputSchema.parse(input);
    const candidate = parsed.candidate
      ? ReviewedLessonCandidateSchema.parse(parsed.candidate)
      : await this.resolveGeneratedCandidate(parsed.projectHash, parsed.candidateId!, parsed.candidateSearch);

    if (candidate.projectHash !== parsed.projectHash) {
      throw new Error('candidate projectHash mismatch');
    }
    if (!parsed.approved && !(parsed.allowHighConfidenceRule && candidate.confidence >= parsed.minHighConfidence)) {
      throw new Error('explicit approval or high-confidence rule is required for lesson promotion');
    }

    this.validateSourceEvents(candidate.projectHash, candidate.sourceEventIds);

    return this.lessonRepository.upsert(candidateToLessonInput(candidate, parsed.actor));
  }

  private async resolveGeneratedCandidate(
    projectHash: string,
    candidateId: string,
    candidateSearch: z.output<typeof CandidateSearchInputSchema>
  ): Promise<ReviewedLessonCandidate> {
    const result = await this.candidateService.findCandidates({
      projectHash,
      ...candidateSearch
    });
    const candidate = result.candidates.find((item) => item.candidateId === candidateId);
    if (!candidate) {
      throw new Error('lesson candidate not found for projectHash');
    }
    return normalizeGeneratedCandidate(candidate);
  }

  private validateSourceEvents(projectHash: string, sourceEventIds: string[]): void {
    const ids = uniqueStrings(sourceEventIds);
    if (ids.length === 0) {
      throw new Error('sourceEventIds is required for lesson promotion');
    }
    const placeholders = ids.map(() => '?').join(', ');
    const rows = sqliteAll<SourceEventRow>(
      this.db,
      `SELECT id, session_id, metadata FROM events WHERE id IN (${placeholders})`,
      ids
    );
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const missing = ids.filter((id) => !rowsById.has(id));
    if (missing.length > 0) {
      throw new Error('source event refs are unavailable for lesson promotion');
    }

    for (const row of rows) {
      const metadata = parseMetadata(row.metadata);
      const sourceProjectHash = projectHashFromMetadata(metadata);
      if (sourceProjectHash !== projectHash) {
        throw new Error('source event project mismatch for lesson promotion');
      }
      if (hasPrivacyConflict(metadata)) {
        throw new Error('source event privacy conflict for lesson promotion');
      }
    }
  }
}
