import { createHash, randomUUID } from 'crypto';
import { isAbsolute, join } from 'path';
import { z } from 'zod';

import { rankCuratedLessonsHybrid } from '../extensions/mcp/hybrid-lesson-ranking.js';
import { applyPrivacyFilter } from '../core/privacy/index.js';
import { CanonicalMemoryAccessService } from '../core/operations/canonical-memory-access-service.js';
import { CanonicalMemoryInjectionService } from '../core/operations/canonical-memory-injection-service.js';
import { LessonRepository } from '../core/operations/lesson-repository.js';
import { writeGovernanceAuditEntrySync } from '../core/operations/governance-audit.js';
import type { MemoryEvent, MemoryLesson } from '../core/types.js';
import { sqliteAll, sqliteGet, sqliteRun, type SQLiteDatabase } from '../core/sqlite-wrapper.js';
import { SQLiteEventStore } from '../core/sqlite-event-store.js';
import { getProjectStoragePath, hashProjectPath, normalizeProjectPath } from '../core/registry/project-path.js';

// Hosts must check this installed-artifact capability before suppressing native lessons.
export const LESSON_HOST_CAPABILITIES = Object.freeze({ version: 1, nativeLessonOwnerMarker: true });

const Identifier = z.string().trim().min(1).max(240);
const Hash = z.string().regex(/^[a-f0-9]{64}$/i, 'payloadHash must be a SHA-256 hex digest');
const CandidatePayload = z.object({
  name: Identifier,
  trigger: Identifier,
  steps: z.array(Identifier).min(1).max(20),
  confidence: z.number().min(0).max(1),
  sourceSessionIds: z.array(Identifier).max(100),
  sourceEventIds: z.array(Identifier).min(1).max(100),
  failureModes: z.array(Identifier).max(20).default([]),
  skillCandidate: z.boolean().default(false),
  scope: Identifier,
  validation: z.array(Identifier).min(1).max(20),
  reconsiderWhen: Identifier,
  validVersions: z.array(Identifier).max(20).optional()
}).strict();
const BaseRequest = z.object({ version: z.number().int(), requestId: Identifier, binding: z.unknown() }).strict();
const MutationBase = BaseRequest.extend({ generation: z.number().int().nonnegative() }).strict();
const CandidateMutation = MutationBase.extend({
  candidateId: Identifier,
  expectedRevision: z.number().int().positive(),
  payloadHash: Hash
}).strict();

export interface VerifiedLessonHostBinding {
  projectHash: string;
  actorId: string;
  userId: string;
  machineId: string;
  sessionId: string;
  generation: number;
  capabilities: readonly ('lesson.read' | 'lesson.review' | 'lesson.manage')[];
  /** Verified host lifecycle state; DTOs cannot assert normal completion. */
  normalEndSessionIds?: readonly string[];
}

export interface LessonHostServiceOptions {
  db: SQLiteDatabase;
  verifyBinding(binding: unknown): Promise<VerifiedLessonHostBinding> | VerifiedLessonHostBinding;
  /** Existing canonical ingestion boundary, supplied by openLessonHostService. */
  eventStore?: Pick<SQLiteEventStore, 'importEvents' | 'getSessionEvents'>;
  /** Injectable only for deterministic deadline tests. */
  now?: () => number;
}

export interface OpenLessonHostServiceOptions {
  /** Canonical host-resolved project path; never accept this from a renderer DTO. */
  projectPath: string;
  verifyBinding(binding: unknown): Promise<VerifiedLessonHostBinding> | VerifiedLessonHostBinding;
  /** Test-only isolated root. Production uses CML's canonical project store. */
  isolatedStorageRoot?: string;
}

export interface OpenLessonHostServiceResult {
  projectHash: string;
  service: LessonHostService;
  close(): Promise<void>;
}

type Candidate = z.output<typeof CandidatePayload>;
type CandidateStatus = 'pending' | 'reviewed' | 'accepted' | 'rejected' | 'expired';
interface CandidateRow {
  candidate_id: string; project_hash: string; evidence_key: string; payload_hash: string;
  payload_json: string; evidence_refs_json: string; status: CandidateStatus; revision: number;
  generation: number; expires_at: string | null; duplicate_lesson_ids_json: string; created_at: string; updated_at: string;
}
interface TraceRow { trace_id: string; project_hash: string; session_id: string; actor_id: string; machine_id: string; turn_id: string; request_id: string; generation: number; lesson_ids_json: string; lesson_revisions_json: string; phase: string; outcome: string; created_at: string; }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function requestFingerprint(value: unknown): string {
  const { binding: _binding, ...intent } = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return createHash('sha256').update(stableJson(intent)).digest('hex');
}

export function hashLessonCandidatePayload(payload: unknown): string {
  return createHash('sha256').update(stableJson(CandidatePayload.parse(payload))).digest('hex');
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
function sameBinding(left: VerifiedLessonHostBinding, right: VerifiedLessonHostBinding): boolean {
  return left.projectHash === right.projectHash && left.actorId === right.actorId && left.machineId === right.machineId && left.sessionId === right.sessionId && left.generation === right.generation;
}

function candidateFromRow(row: CandidateRow) {
  return {
    candidateId: row.candidate_id, evidenceKey: row.evidence_key, payloadHash: row.payload_hash,
    status: row.status, revision: row.revision, generation: row.generation,
    expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at,
    evidenceRefs: parseJson<string[]>(row.evidence_refs_json, []), duplicateLessonIds: parseJson<string[]>(row.duplicate_lesson_ids_json, []), candidate: parseJson<Candidate>(row.payload_json, {} as Candidate)
  };
}

function assertCandidateSafe(candidate: Candidate): void {
  const text = [candidate.name, candidate.trigger, candidate.scope, candidate.reconsiderWhen, ...candidate.steps, ...candidate.validation, ...candidate.failureModes, ...(candidate.validVersions ?? [])].join('\n');
  const privacy = applyPrivacyFilter(text, { excludePatterns: [], anonymize: false, privateTags: { enabled: true, marker: '[PRIVATE]', preserveLineCount: false, supportedFormats: ['xml'] } });
  const environmentSecret = /\b(?:export\s+)?[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*(?!\$[A-Z_])[\S]+/;
  const credentialRule = /\b(?:store|save|persist|remember|reuse|repeat)\b.{0,80}\b(?:credential|password|secret|api[ -]?key|access token)\b|\b(?:credential|password|secret|api[ -]?key|access token)\b.{0,80}\b(?:store|save|persist|remember|reuse|repeat)\b/i;
  if (privacy.metadata.hasPrivateTags || privacy.metadata.hasUnmatchedTags || privacy.metadata.patternMatchCount > 0 || environmentSecret.test(text) || credentialRule.test(text) || /ignore (all )?previous instructions|system prompt|developer message/i.test(text)) {
    throw new Error('candidate contains private, credential-like, or forbidden instruction content');
  }
}

export class LessonHostService {
  constructor(private readonly options: LessonHostServiceOptions) {}

  async recall(input: unknown) {
    const request = BaseRequest.extend({ turnId: Identifier, query: z.string().trim().min(1).max(8_000), limit: z.number().int().min(1).max(3).default(3) }).strict().parse(input);
    if (request.version !== 1) return { outcome: 'unsupported_version' as const };
    const binding = await this.readBinding(request.binding, 'lesson.read');
    const deadline = this.now() + 900;
    const repo = new LessonRepository(this.options.db);
    const eligible: Array<{ lesson: MemoryLesson; injectionMode: 'direct' | 'summary' | 'reference' }> = [];
    for (let offset = 0; ; offset += 100) {
      if (this.now() >= deadline) return { outcome: 'timeout' as const, lessonIds: [], lessons: [] };
      const page = await repo.list({ projectHash: binding.projectHash, limit: 100, offset });
      if (!page.length) break;
      const allowed = new CanonicalMemoryInjectionService(this.options.db).select({ projectHash: binding.projectHash, actorId: binding.actorId, lane: 'prompt', candidates: page.filter((lesson) => lesson.recallEnabled).map((value) => ({ canonicalType: 'lesson' as const, canonicalId: value.lessonId, value })) }).items;
      for (const item of allowed) eligible.push({ lesson: item.value, injectionMode: item.injectionMode });
      if (this.now() >= deadline) return { outcome: 'timeout' as const, lessonIds: [], lessons: [] };
      if (page.length < 100) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (this.now() >= deadline) return { outcome: 'timeout' as const, lessonIds: [], lessons: [] };
    const selected = await rankCuratedLessonsHybrid(eligible.map(({ lesson }) => lesson), request.query, request.limit);
    const lessons = selected.map((lesson) => ({ lesson, injectionMode: eligible.find((item) => item.lesson.lessonId === lesson.lessonId)!.injectionMode }));
    if (this.now() >= deadline) return { outcome: 'timeout' as const, lessonIds: [], lessons: [] };
    const finalBinding = await this.readBinding(request.binding, 'lesson.read');
    if (!sameBinding(binding, finalBinding)) throw new Error('binding changed during recall');
    if (this.now() >= deadline) return { outcome: 'timeout' as const, lessonIds: [], lessons: [] };
    if (!this.validRecallSelection(lessons, finalBinding)) return { outcome: 'no_match' as const, lessonIds: [], lessons: [] };
    const traceId = randomUUID();
    const response = { outcome: lessons.length ? 'selected' as const : 'no_match' as const, traceId, lessonIds: lessons.map(({ lesson }) => lesson.lessonId), lessons: lessons.map(({ lesson, injectionMode }) => lessonBody(lesson, injectionMode)) };
    const fingerprint = requestFingerprint({ version: request.version, requestId: request.requestId, turnId: request.turnId, query: request.query, limit: request.limit });
    return this.options.db.transaction(() => { const replay = this.idempotent(request.requestId, finalBinding, 'recall', fingerprint); if (replay) return this.validRecallReplay(replay, finalBinding) ? replay : { outcome: 'no_match' as const, lessonIds: [], lessons: [] }; if (!this.validRecallSelection(lessons, finalBinding)) return { outcome: 'no_match' as const, lessonIds: [], lessons: [] }; this.writeTrace({ traceId, requestId: request.requestId, binding: finalBinding, turnId: request.turnId, phase: 'selected', outcome: response.outcome, lessons: lessons.map(({ lesson }) => lesson) }); this.remember(request.requestId, finalBinding, 'recall', fingerprint, response); return response; })();
  }

  async get(input: unknown) {
    const request = BaseRequest.extend({ lessonId: Identifier }).strict().parse(input);
    if (request.version !== 1) return { outcome: 'unsupported_version' as const };
    const binding = await this.readBinding(request.binding, 'lesson.read');
    const lesson = new LessonRepository(this.options.db).get(request.lessonId);
    if (!lesson || lesson.projectHash !== binding.projectHash || !this.canReadLesson(binding, lesson.lessonId)) return { outcome: 'not_found' as const };
    const response = { outcome: 'found' as const, lesson: lessonBody(lesson) };
    const fingerprint = requestFingerprint(request); return this.options.db.transaction(() => { const replay = this.idempotent(request.requestId, binding, 'get', fingerprint); if (replay) { const cached = replay as { lesson?: { lessonId?: string; revision?: number } }; return cached.lesson?.lessonId === lesson.lessonId && cached.lesson.revision === lesson.revision ? replay : { outcome: 'not_found' as const }; } this.writeTrace({ traceId: randomUUID(), requestId: request.requestId, binding, phase: 'read', outcome: 'read', lessons: [lesson] }); this.remember(request.requestId, binding, 'get', fingerprint, response); return response; })();
  }

  async recordRead(input: unknown) {
    const request = BaseRequest.extend({ lessonId: Identifier }).strict().parse(input);
    if (request.version !== 1) return { outcome: 'unsupported_version' as const };
    const binding = await this.readBinding(request.binding, 'lesson.read');
    const lesson = new LessonRepository(this.options.db).get(request.lessonId);
    if (!lesson || lesson.projectHash !== binding.projectHash || !this.canReadLesson(binding, lesson.lessonId)) return { outcome: 'not_found' as const };
    const traceId = randomUUID(); const response = { outcome: 'read' as const, traceId };
    const fingerprint = requestFingerprint(request); return this.options.db.transaction(() => { const replay = this.idempotent(request.requestId, binding, 'read', fingerprint); if (replay) return replay; this.writeTrace({ traceId, requestId: request.requestId, binding, phase: 'read', outcome: 'read', lessons: [lesson] }); this.remember(request.requestId, binding, 'read', fingerprint, response); return response; })();
  }

  async ackDelivery(input: unknown) {
    const request = BaseRequest.extend({ turnId: Identifier, traceId: Identifier, lessonIds: z.array(Identifier).max(3), lessonRevisions: z.array(z.object({ lessonId: Identifier, revision: z.number().int().positive() }).strict()).max(3) }).strict().parse(input);
    if (request.version !== 1) return { outcome: 'unsupported_version' as const };
    const binding = await this.readBinding(request.binding, 'lesson.read');
    const selected = sqliteGet<TraceRow>(this.options.db, `SELECT * FROM lesson_host_traces WHERE trace_id = ?`, [request.traceId]);
    const revisions = request.lessonRevisions.map(({ lessonId, revision }) => ({ lessonId, revision }));
    const current = revisions.every(({ lessonId, revision }) => { const lesson = new LessonRepository(this.options.db).get(lessonId); return lesson?.projectHash === binding.projectHash && lesson.revision === revision; });
    if (!selected || selected.project_hash !== binding.projectHash || selected.session_id !== binding.sessionId || selected.actor_id !== binding.actorId || selected.machine_id !== binding.machineId || selected.generation !== binding.generation || selected.turn_id !== request.turnId || selected.phase !== 'selected' || JSON.stringify(parseJson<string[]>(selected.lesson_ids_json, [])) !== JSON.stringify(request.lessonIds) || JSON.stringify(parseJson(selected.lesson_revisions_json, [])) !== JSON.stringify(revisions) || !current) return { outcome: 'invalid_ack' as const };
    const response = { outcome: 'delivered' as const, traceId: request.traceId };
    const fingerprint = requestFingerprint(request); return this.options.db.transaction(() => { const replay = this.idempotent(request.requestId, binding, 'delivered', fingerprint); if (replay) return replay; this.writeTrace({ traceId: randomUUID(), requestId: request.requestId, binding, turnId: request.turnId, phase: 'delivered', outcome: 'delivered', lessons: revisions.map(({ lessonId }) => new LessonRepository(this.options.db).get(lessonId)!) }); this.remember(request.requestId, binding, 'delivered', fingerprint, response); return response; })();
  }

  async enqueueCandidate(input: unknown) {
    const request = MutationBase.extend({ evidenceKey: Identifier, payloadHash: Hash.optional(), candidate: CandidatePayload, expiresAt: z.string().datetime().optional() }).strict().parse(input);
    if (request.version !== 1) return { outcome: 'unsupported_version' as const };
    const binding = await this.writeBinding(request.binding, request.generation, 'lesson.review');
    const candidate = CandidatePayload.parse(request.candidate); assertCandidateSafe(candidate); this.assertSourceEvents(binding.projectHash, candidate.sourceEventIds, candidate.sourceSessionIds);
    const computedHash = hashLessonCandidatePayload(candidate);
    if (request.payloadHash && request.payloadHash !== computedHash) throw new Error('payloadHash does not match canonical candidate payload');
    const fingerprint = requestFingerprint({ ...request, payloadHash: computedHash });
    return this.options.db.transaction(() => {
      const replay = this.idempotent(request.requestId, binding, 'enqueue', fingerprint); if (replay) return replay;
      this.expireCandidates(binding.projectHash);
      const existing = sqliteGet<CandidateRow>(this.options.db, `SELECT * FROM lesson_review_candidates WHERE project_hash = ? AND evidence_key = ?`, [binding.projectHash, request.evidenceKey]);
      if (!existing && sqliteGet<{ count: number }>(this.options.db, `SELECT COUNT(*) AS count FROM lesson_review_candidates WHERE project_hash=? AND status IN ('pending','reviewed')`, [binding.projectHash])!.count >= 20) throw new Error('pending candidate cap reached');
      const result = existing ? candidateFromRow(existing) : this.insertCandidate(binding, request.evidenceKey, computedHash, candidate, request.expiresAt);
      const response = { outcome: result.status, ...result }; this.remember(request.requestId, binding, 'enqueue', fingerprint, response); return response;
    })();
  }

  async appendNormalEndEvidence(input: unknown) {
    const request = MutationBase.extend({ evidenceKey: Identifier, sessionId: Identifier, content: z.string().trim().min(1).max(8_000), occurredAt: z.string().datetime().optional() }).strict().parse(input);
    if (request.version !== 1) return { outcome: 'unsupported_version' as const };
    const binding = await this.writeBinding(request.binding, request.generation, 'lesson.review');
    if (!this.options.eventStore || request.sessionId !== binding.sessionId || !binding.normalEndSessionIds?.includes(request.sessionId)) throw new Error('verified normal session completion is required');
    const filtered = applyPrivacyFilter(request.content, { excludePatterns: [], anonymize: false, privateTags: { enabled: true, marker: '[PRIVATE]', preserveLineCount: false, supportedFormats: ['xml'] } });
    if (filtered.metadata.hasPrivateTags || filtered.metadata.hasUnmatchedTags || /\[PRIVATE\]/.test(filtered.content) || Buffer.byteLength(filtered.content, 'utf8') > 8_000 || filtered.content.length === 0) throw new Error('evidence is not safely appendable');
    const fingerprint = requestFingerprint({ ...request, content: filtered.content });
    const replay = this.idempotent(request.requestId, binding, 'append-normal-end-evidence', fingerprint); if (replay) return replay;
    const contentHash = createHash('sha256').update(filtered.content).digest('hex');
    const prior = (await this.options.eventStore.getSessionEvents(request.sessionId)).find((event) => (event.metadata as { evidenceKey?: string; contentHash?: string } | undefined)?.evidenceKey === request.evidenceKey);
    if (prior) {
      if ((prior.metadata as { contentHash?: string } | undefined)?.contentHash !== contentHash || (prior.metadata as { scope?: { project?: { hash?: string } } } | undefined)?.scope?.project?.hash !== binding.projectHash) throw new Error('evidenceKey payload conflict');
      const response = { outcome: 'persisted' as const, eventId: prior.id, evidenceKey: request.evidenceKey, redacted: filtered.content !== request.content };
      this.options.db.transaction(() => this.remember(request.requestId, binding, 'append-normal-end-evidence', fingerprint, response))(); return response;
    }
    const finalBinding = await this.writeBinding(request.binding, request.generation, 'lesson.review');
    const eventId = randomUUID();
    const event: MemoryEvent = { id: eventId, eventType: 'tool_observation', sessionId: request.sessionId, timestamp: request.occurredAt ? new Date(request.occurredAt) : new Date(), content: filtered.content, canonicalKey: `host-normal-end:${finalBinding.projectHash}:${request.evidenceKey}`, dedupeKey: `host-normal-end:${finalBinding.projectHash}:${request.evidenceKey}`, metadata: { scope: { project: { hash: finalBinding.projectHash } }, source: 'lesson-host-normal-end', evidenceKey: request.evidenceKey, contentHash } };
    const persisted = await this.options.eventStore.importEvents([event]);
    if (persisted.inserted !== 1) throw new Error('evidenceKey already exists without a recoverable host idempotency record');
    const response = { outcome: 'persisted' as const, eventId, evidenceKey: request.evidenceKey, redacted: filtered.content !== request.content };
    this.options.db.transaction(() => { this.remember(request.requestId, binding, 'append-normal-end-evidence', fingerprint, response); })();
    return response;
  }

  async markReviewed(input: unknown) { return this.transition(input, 'reviewed', 'lesson.review'); }
  async rejectCandidate(input: unknown) { return this.transition(input, 'rejected', 'lesson.manage'); }

  async approveCandidate(input: unknown) {
    const request = CandidateMutation.parse(input);
    if (request.version !== 1) return { outcome: 'unsupported_version' as const };
    await this.writeBinding(request.binding, request.generation, 'lesson.manage');
    const fingerprint = requestFingerprint(request);
    // The final verifier call is immediately followed by the synchronous SQLite transaction.
    const finalBinding = await this.writeBinding(request.binding, request.generation, 'lesson.manage');
    const transaction = this.options.db.transaction(() => {
      const replay = this.idempotent(request.requestId, finalBinding, 'approve', fingerprint); if (replay) return replay;
      const row = this.requireCandidate(request.candidateId, finalBinding, request.expectedRevision, request.payloadHash, 'reviewed', false);
      const candidate = CandidatePayload.parse(parseJson(row.payload_json, {})); assertCandidateSafe(candidate); this.assertSourceEvents(finalBinding.projectHash, candidate.sourceEventIds, candidate.sourceSessionIds);
      const existing = sqliteGet<{ lesson_id: string; revision: number; recall_enabled: number }>(this.options.db, `SELECT lesson_id, revision, recall_enabled FROM memory_lessons WHERE project_hash = ? AND name = ?`, [finalBinding.projectHash, candidate.name]);
      if (existing) { const error = new Error('existing lesson requires an explicit merge proposal and lesson revision CAS') as Error & { code?: string }; error.code = 'merge_required'; throw error; }
      const now = new Date().toISOString(); const lessonId = randomUUID();
      sqliteRun(this.options.db, `INSERT INTO memory_lessons (lesson_id, project_hash, name, trigger, steps_json, confidence, source_session_ids, source_event_ids, failure_modes_json, skill_candidate, source_class, revision, recall_enabled, scope, validation_json, reconsider_when, valid_versions_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'curated', 1, 1, ?, ?, ?, ?, ?, ?)`, [lessonId, finalBinding.projectHash, candidate.name, candidate.trigger, JSON.stringify(candidate.steps), candidate.confidence, JSON.stringify(candidate.sourceSessionIds), JSON.stringify(candidate.sourceEventIds), JSON.stringify(candidate.failureModes), candidate.skillCandidate ? 1 : 0, candidate.scope, JSON.stringify(candidate.validation), candidate.reconsiderWhen, JSON.stringify(candidate.validVersions ?? []), now, now]);
      writeGovernanceAuditEntrySync(this.options.db, { operation: 'lesson_promote', actor: finalBinding.actorId, projectHash: finalBinding.projectHash, targetType: 'lesson', targetId: lessonId, afterJson: { lessonId, name: candidate.name, trigger: candidate.trigger, steps: candidate.steps, sourceClass: 'curated' }, sourceEventIds: candidate.sourceEventIds });
      const changed = sqliteRun(this.options.db, `UPDATE lesson_review_candidates SET status='accepted', revision=revision+1, updated_at=? WHERE candidate_id=? AND project_hash=? AND revision=? AND payload_hash=? AND status='reviewed'`, [now, row.candidate_id, finalBinding.projectHash, request.expectedRevision, request.payloadHash]);
      if (changed.changes !== 1) throw new Error('candidate changed before approval');
      const lesson = new LessonRepository(this.options.db).get(lessonId)!;
      const result = { outcome: 'accepted' as const, candidateId: row.candidate_id, lessonId, lessonRevision: lesson.revision }; this.remember(request.requestId, finalBinding, 'approve', fingerprint, result); return result;
    });
    return transaction();
  }

  async setRecallEnabled(input: unknown) {
    const request = MutationBase.extend({ lessonId: Identifier, expectedRevision: z.number().int().positive(), enabled: z.boolean() }).strict().parse(input);
    if (request.version !== 1) return { outcome: 'unsupported_version' as const };
    await this.writeBinding(request.binding, request.generation, 'lesson.manage');
    const binding = await this.writeBinding(request.binding, request.generation, 'lesson.manage');
    const fingerprint = requestFingerprint(request);
    return this.options.db.transaction(() => {
      const replay = this.idempotent(request.requestId, binding, 'set-recall', fingerprint); if (replay) return replay;
      const result = new LessonRepository(this.options.db).setRecallEnabled({ lessonId: request.lessonId, projectHash: binding.projectHash, expectedRevision: request.expectedRevision, enabled: request.enabled });
      if (!result) throw new Error('lesson revision conflict or lesson not found');
      const response = { outcome: 'updated' as const, lessonId: result.lessonId, revision: result.revision, recallEnabled: result.recallEnabled };
      this.remember(request.requestId, binding, 'set-recall', fingerprint, response); return response;
    })();
  }

  async listCandidates(input: unknown) {
    const request = BaseRequest.extend({ limit: z.number().int().min(1).max(100).default(100), offset: z.number().int().nonnegative().default(0) }).strict().parse(input); if (request.version !== 1) return { outcome: 'unsupported_version' as const };
    const binding = await this.readBinding(request.binding, 'lesson.manage'); this.expireCandidates(binding.projectHash);
    const rows = sqliteAll<CandidateRow>(this.options.db, `SELECT * FROM lesson_review_candidates WHERE project_hash = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`, [binding.projectHash, request.limit + 1, request.offset]);
    return { outcome: 'ok' as const, candidates: rows.slice(0, request.limit).map(candidateFromRow), nextOffset: rows.length > request.limit ? request.offset + request.limit : null };
  }

  async reviewStatus(input: unknown) {
    const request = BaseRequest.extend({ candidateId: Identifier }).strict().parse(input); if (request.version !== 1) return { outcome: 'unsupported_version' as const };
    const binding = await this.readBinding(request.binding, 'lesson.manage'); this.expireCandidates(binding.projectHash);
    const candidate = sqliteGet<CandidateRow>(this.options.db, `SELECT * FROM lesson_review_candidates WHERE candidate_id=? AND project_hash=?`, [request.candidateId, binding.projectHash]);
    return candidate ? { outcome: 'found' as const, candidate: candidateFromRow(candidate) } : { outcome: 'not_found' as const };
  }

  async listLessons(input: unknown) {
    const request = BaseRequest.extend({ limit: z.number().int().min(1).max(100).default(100), offset: z.number().int().nonnegative().default(0) }).strict().parse(input); if (request.version !== 1) return { outcome: 'unsupported_version' as const };
    const binding = await this.readBinding(request.binding, 'lesson.manage'); const lessons = await new LessonRepository(this.options.db).list({ projectHash: binding.projectHash, limit: request.limit + 1, offset: request.offset });
    return { outcome: 'ok' as const, lessons: lessons.slice(0, request.limit).map((lesson) => { const traces = sqliteAll<{ phase: string; created_at: string }>(this.options.db, `SELECT t.phase, t.created_at FROM lesson_host_traces t JOIN json_each(t.lesson_ids_json) ids ON ids.value=? WHERE t.project_hash=? ORDER BY t.created_at DESC`, [lesson.lessonId, binding.projectHash]); const latest = (phase: string) => traces.find((trace) => trace.phase === phase)?.created_at ?? null; return { lessonId: lesson.lessonId, name: lesson.name, trigger: lesson.trigger, steps: lesson.steps, failureModes: lesson.failureModes, scope: lesson.scope, validation: lesson.validation, reconsiderWhen: lesson.reconsiderWhen, validVersions: lesson.validVersions, revision: lesson.revision, recallEnabled: lesson.recallEnabled, sourceSessionIds: lesson.sourceSessionIds, sourceEventIds: lesson.sourceEventIds, createdAt: lesson.createdAt.toISOString(), updatedAt: lesson.updatedAt.toISOString(), lastSelectedAt: latest('selected'), lastDeliveredAt: latest('delivered'), lastReadAt: latest('read') }; }), nextOffset: lessons.length > request.limit ? request.offset + request.limit : null };
  }

  async listTraces(input: unknown) {
    const request = BaseRequest.extend({ limit: z.number().int().min(1).max(100).default(100), offset: z.number().int().nonnegative().default(0) }).strict().parse(input); if (request.version !== 1) return { outcome: 'unsupported_version' as const };
    const binding = await this.readBinding(request.binding, 'lesson.manage');
    const rows = sqliteAll<TraceRow>(this.options.db, `SELECT trace_id, project_hash, session_id, actor_id, machine_id, turn_id, request_id, generation, lesson_ids_json, lesson_revisions_json, phase, outcome, created_at FROM lesson_host_traces WHERE project_hash=? ORDER BY created_at DESC LIMIT ? OFFSET ?`, [binding.projectHash, request.limit + 1, request.offset]);
    return { outcome: 'ok' as const, traces: rows.slice(0, request.limit).map((row) => ({ traceId: row.trace_id, requestId: row.request_id, sessionId: row.session_id, actorId: row.actor_id, machineId: row.machine_id, turnId: row.turn_id, generation: row.generation, phase: row.phase, outcome: row.outcome, lessonIds: parseJson<string[]>(row.lesson_ids_json, []), lessonRevisions: parseJson<Array<{ lessonId: string; revision: number }>>(row.lesson_revisions_json, []), createdAt: row.created_at })), nextOffset: rows.length > request.limit ? request.offset + request.limit : null };
  }

  private async transition(input: unknown, target: 'reviewed' | 'rejected', capability: 'lesson.review' | 'lesson.manage') {
    const request = CandidateMutation.parse(input); if (request.version !== 1) return { outcome: 'unsupported_version' as const };
    const binding = await this.writeBinding(request.binding, request.generation, capability); const fingerprint = requestFingerprint(request);
    const current = target === 'reviewed' ? 'pending' : 'reviewed'; const now = new Date().toISOString(); await this.writeBinding(request.binding, request.generation, capability);
    return this.options.db.transaction(() => {
      const replay = this.idempotent(request.requestId, binding, target, fingerprint); if (replay) return replay;
      const requireGeneration = target === 'reviewed';
      this.requireCandidate(request.candidateId, binding, request.expectedRevision, request.payloadHash, current, requireGeneration);
      const changed = requireGeneration
        ? sqliteRun(this.options.db, `UPDATE lesson_review_candidates SET status=?, revision=revision+1, updated_at=? WHERE candidate_id=? AND project_hash=? AND revision=? AND payload_hash=? AND generation=? AND status=?`, [target, now, request.candidateId, binding.projectHash, request.expectedRevision, request.payloadHash, binding.generation, current])
        : sqliteRun(this.options.db, `UPDATE lesson_review_candidates SET status=?, revision=revision+1, updated_at=? WHERE candidate_id=? AND project_hash=? AND revision=? AND payload_hash=? AND status=?`, [target, now, request.candidateId, binding.projectHash, request.expectedRevision, request.payloadHash, current]);
      if (changed.changes !== 1) throw new Error('candidate revision, generation, or status conflict');
      const result = candidateFromRow(sqliteGet<CandidateRow>(this.options.db, `SELECT * FROM lesson_review_candidates WHERE candidate_id = ?`, [request.candidateId])!); const response = { outcome: target, ...result }; this.remember(request.requestId, binding, target, fingerprint, response); return response;
    })();
  }

  private async readBinding(token: unknown, capability: VerifiedLessonHostBinding['capabilities'][number]) { const binding = await this.options.verifyBinding(token); this.assertBinding(binding, capability); return binding; }
  private async writeBinding(token: unknown, generation: number, capability: VerifiedLessonHostBinding['capabilities'][number]) { const binding = await this.readBinding(token, capability); if (binding.generation !== generation) throw new Error('binding generation mismatch'); return binding; }
  private assertBinding(binding: VerifiedLessonHostBinding, capability: string) { if (!Identifier.safeParse(binding.projectHash).success || !Identifier.safeParse(binding.actorId).success || !binding.capabilities.includes(capability as never)) throw new Error('untrusted or unauthorized host binding'); }
  private canReadLesson(binding: VerifiedLessonHostBinding, lessonId: string): boolean { try { return new CanonicalMemoryAccessService(this.options.db).check({ projectHash: binding.projectHash, canonicalType: 'lesson', canonicalId: lessonId, requesterActorId: binding.actorId, permission: 'read' }).allowed; } catch { return false; } }
  private assertSourceEvents(projectHash: string, ids: string[], sourceSessionIds?: string[]) { const rows = sqliteAll<{ id: string; session_id: string; metadata: string }>(this.options.db, `SELECT id, session_id, metadata FROM events WHERE id IN (${ids.map(() => '?').join(',')})`, ids); if (rows.length !== ids.length) throw new Error('source event refs are unavailable'); for (const row of rows) { const metadata = parseJson<Record<string, unknown>>(row.metadata, {}); if ((metadata.scope as { project?: { hash?: string } } | undefined)?.project?.hash !== projectHash) throw new Error('source event project mismatch'); } if (sourceSessionIds) { const expected = new Set(rows.map((row) => row.session_id)); if (sourceSessionIds.length !== expected.size || sourceSessionIds.some((id) => !expected.has(id))) throw new Error('source session refs do not match source events'); } }
  private insertCandidate(binding: VerifiedLessonHostBinding, evidenceKey: string, payloadHash: string, candidate: Candidate, expiresAt?: string) { const candidateId = randomUUID(); const now = new Date().toISOString(); const maxExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); const expires = expiresAt && expiresAt < maxExpiry ? expiresAt : maxExpiry; const duplicateLessonIds = this.findDuplicateLessonIds(binding.projectHash, candidate); sqliteRun(this.options.db, `INSERT INTO lesson_review_candidates (candidate_id, project_hash, evidence_key, payload_hash, payload_json, evidence_refs_json, duplicate_lesson_ids_json, status, revision, generation, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?)`, [candidateId, binding.projectHash, evidenceKey, payloadHash, stableJson(candidate), JSON.stringify(candidate.sourceEventIds), JSON.stringify(duplicateLessonIds), binding.generation, expires, now, now]); return candidateFromRow(sqliteGet<CandidateRow>(this.options.db, `SELECT * FROM lesson_review_candidates WHERE candidate_id = ?`, [candidateId])!); }
  private requireCandidate(id: string, binding: VerifiedLessonHostBinding, revision: number, hash: string, status: CandidateStatus, requireGeneration: boolean) { const row = sqliteGet<CandidateRow>(this.options.db, `SELECT * FROM lesson_review_candidates WHERE candidate_id = ?`, [id]); if (!row || row.project_hash !== binding.projectHash || row.revision !== revision || row.payload_hash !== hash || row.status !== status || (requireGeneration && row.generation !== binding.generation)) throw new Error('candidate revision, generation, payload, or status conflict'); if (row.expires_at && row.expires_at <= new Date().toISOString()) { sqliteRun(this.options.db, `UPDATE lesson_review_candidates SET status='expired', revision=revision+1, updated_at=? WHERE candidate_id=?`, [new Date().toISOString(), id]); throw new Error('candidate has expired'); } return row; }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private validRecallReplay(replay: unknown, binding: VerifiedLessonHostBinding): boolean { const body = replay as { lessons?: Array<{ lessonId?: string; revision?: number; injectionMode?: 'direct' | 'summary' | 'reference' }> }; if (!Array.isArray(body.lessons)) return false; const current = body.lessons.map((item) => typeof item.lessonId === 'string' ? new LessonRepository(this.options.db).get(item.lessonId) : undefined); if (current.some((lesson, index) => !lesson || lesson.revision !== body.lessons![index]!.revision)) return false; return this.validRecallSelection(current.map((lesson, index) => ({ lesson: lesson!, injectionMode: body.lessons![index]!.injectionMode ?? 'direct' })), binding); }
  private validRecallSelection(selection: Array<{ lesson: MemoryLesson; injectionMode: 'direct' | 'summary' | 'reference' }>, binding: VerifiedLessonHostBinding): boolean { const current = selection.map(({ lesson }) => new LessonRepository(this.options.db).get(lesson.lessonId)); if (current.some((lesson, index) => !lesson || lesson.projectHash !== binding.projectHash || lesson.revision !== selection[index]!.lesson.revision || !lesson.recallEnabled || !this.canReadLesson(binding, lesson.lessonId))) return false; const allowed = new CanonicalMemoryInjectionService(this.options.db).select({ projectHash: binding.projectHash, actorId: binding.actorId, lane: 'prompt', candidates: current.map((lesson) => ({ canonicalType: 'lesson' as const, canonicalId: lesson!.lessonId, value: lesson! })) }).items; return allowed.length === selection.length && selection.every(({ lesson, injectionMode }) => allowed.some((item) => item.value.lessonId === lesson.lessonId && item.injectionMode === injectionMode)); }
  private findDuplicateLessonIds(projectHash: string, candidate: Candidate): string[] { const terms = new Set(`${candidate.name} ${candidate.trigger}`.toLowerCase().match(/[a-z0-9가-힣]{2,}/g) ?? []); return sqliteAll<{ lesson_id: string; name: string; trigger: string }>(this.options.db, `SELECT lesson_id, name, trigger FROM memory_lessons WHERE project_hash=?`, [projectHash]).filter((lesson) => { const other = new Set(`${lesson.name} ${lesson.trigger}`.toLowerCase().match(/[a-z0-9가-힣]{2,}/g) ?? []); let overlap = 0; for (const term of terms) if (other.has(term)) overlap += 1; return lesson.name === candidate.name || overlap >= 2 && overlap / Math.max(terms.size, other.size) >= 0.5; }).map((lesson) => lesson.lesson_id); }
  private expireCandidates(projectHash: string) { sqliteRun(this.options.db, `UPDATE lesson_review_candidates SET status='expired', revision=revision+1, updated_at=? WHERE project_hash=? AND status IN ('pending','reviewed') AND expires_at IS NOT NULL AND expires_at <= ?`, [new Date().toISOString(), projectHash, new Date().toISOString()]); }
  private writeTrace(input: { traceId: string; requestId: string; binding: VerifiedLessonHostBinding; turnId?: string; phase: string; outcome: string; lessons: MemoryLesson[] }) { sqliteRun(this.options.db, `INSERT INTO lesson_host_traces (trace_id, project_hash, session_id, actor_id, machine_id, generation, turn_id, request_id, phase, outcome, lesson_ids_json, lesson_revisions_json, query_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`, [input.traceId, input.binding.projectHash, input.binding.sessionId, input.binding.actorId, input.binding.machineId, input.binding.generation, input.turnId ?? null, input.requestId, input.phase, input.outcome, JSON.stringify(input.lessons.map((lesson) => lesson.lessonId)), JSON.stringify(input.lessons.map((lesson) => ({ lessonId: lesson.lessonId, revision: lesson.revision }))), new Date().toISOString()]); }
  private idempotent(requestId: string, binding: VerifiedLessonHostBinding, operation: string, fingerprint: string): unknown | null { const row = sqliteGet<{ operation: string; fingerprint: string; result_json: string }>(this.options.db, `SELECT operation, fingerprint, result_json FROM lesson_host_idempotency WHERE project_hash=? AND actor_id=? AND request_id=?`, [binding.projectHash, binding.actorId, requestId]); if (!row) return null; if (row.operation !== operation || row.fingerprint !== fingerprint) throw new Error('requestId payload conflict'); return parseJson(row.result_json, null); }
  private remember(requestId: string, binding: VerifiedLessonHostBinding, operation: string, fingerprint: string, result: unknown) { sqliteRun(this.options.db, `INSERT INTO lesson_host_idempotency (project_hash, actor_id, request_id, operation, fingerprint, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [binding.projectHash, binding.actorId, requestId, operation, fingerprint, JSON.stringify(result), new Date().toISOString()]); }
}

function lessonBody(lesson: MemoryLesson, injectionMode: 'direct' | 'summary' | 'reference' = 'direct') { if (injectionMode === 'reference') return { lessonId: lesson.lessonId, revision: lesson.revision, name: lesson.name, injectionMode }; if (injectionMode === 'summary') return { lessonId: lesson.lessonId, revision: lesson.revision, name: lesson.name, trigger: lesson.trigger, steps: lesson.steps.slice(0, 2), scope: lesson.scope, validation: lesson.validation, reconsiderWhen: lesson.reconsiderWhen, validVersions: lesson.validVersions, truncated: lesson.steps.length > 2 || lesson.failureModes.length > 0, detailReference: 'mem-lesson-get', injectionMode }; return { lessonId: lesson.lessonId, revision: lesson.revision, name: lesson.name, trigger: lesson.trigger, steps: lesson.steps, failureModes: lesson.failureModes, scope: lesson.scope, validation: lesson.validation, reconsiderWhen: lesson.reconsiderWhen, validVersions: lesson.validVersions, sourceSessionIds: lesson.sourceSessionIds, sourceEventIds: lesson.sourceEventIds, injectionMode }; }
export function createLessonHostService(options: LessonHostServiceOptions): LessonHostService { return new LessonHostService(options); }

/**
 * Stable host-only opening boundary. Desktop/Happy supplies the canonical
 * project path after its own IPC/auth checks; renderer/model DTOs never open a
 * store. The optional isolated root exists solely for fixture stores.
 */
export async function openLessonHostService(options: OpenLessonHostServiceOptions): Promise<OpenLessonHostServiceResult> {
  if (!isAbsolute(options.projectPath)) throw new Error('host projectPath must be absolute');
  const projectPath = normalizeProjectPath(options.projectPath);
  const projectHash = hashProjectPath(projectPath);
  if (options.isolatedStorageRoot !== undefined && !isAbsolute(options.isolatedStorageRoot)) throw new Error('isolatedStorageRoot must be absolute');
  const storagePath = options.isolatedStorageRoot ? join(options.isolatedStorageRoot, projectHash) : getProjectStoragePath(projectPath);
  const store = new SQLiteEventStore(join(storagePath, 'events.sqlite'));
  await store.initialize();
  return { projectHash, service: createLessonHostService({ db: store.getDatabase(), verifyBinding: options.verifyBinding, eventStore: store }), close: async () => store.close() };
}
