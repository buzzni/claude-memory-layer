import { createHash } from 'crypto';
import { z } from 'zod';

import { sqliteAll, type SQLiteDatabase } from '../sqlite-wrapper.js';
import { sanitizeGovernanceAuditValue } from './governance-audit.js';
import { LessonExtractionCache, lessonExtractionFingerprint } from './lesson-extraction-cache.js';

const NonEmptyStringSchema = z.string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1));

export const LessonCandidateInputSchema = z.object({
  projectHash: NonEmptyStringSchema,
  minSessions: z.number().int().min(2).max(10).default(2),
  limit: z.number().int().positive().max(100).default(25),
  eventLimit: z.number().int().positive().max(10_000).default(2_000),
  maxSourceEventIds: z.number().int().positive().max(100).default(20)
});
export type LessonCandidateInput = z.input<typeof LessonCandidateInputSchema>;

type ParsedLessonCandidateInput = z.output<typeof LessonCandidateInputSchema>;

export interface LessonCandidate {
  candidateId: string;
  projectHash: string;
  name: string;
  trigger: string;
  steps: string[];
  confidence: number;
  sourceSessionIds: string[];
  sourceEventIds: string[];
  failureModes: string[];
  skillCandidate: boolean;
  pattern: {
    tools: string[];
    fileCategories: string[];
    taskPatterns: string[];
  };
  reasons: string[];
}

export interface LessonCandidateResult {
  scannedSessions: number;
  eligibleSessions: number;
  skippedSessions: number;
  groupedPatterns: number;
  candidates: LessonCandidate[];
}

/**
 * Redacted material handed to the extractor. The transcript has already been
 * through `sanitizeGovernanceAuditValue`, so absolute paths and credential
 * assignments are replaced before anything leaves the process.
 */
export interface LessonExtractionSource {
  projectHash: string;
  candidateId: string;
  sessionCount: number;
  tools: string[];
  fileCategories: string[];
  taskPatterns: string[];
  transcript: string;
}

export interface ExtractedLesson {
  name: string;
  trigger: string;
  steps: string[];
  failureModes: string[];
}

/**
 * Injected so core stays free of child-process/CLI concerns. Returns null when
 * the session group holds no reusable procedure, which must emit no candidate
 * rather than fall back to templated text.
 */
export type LessonExtractor = (source: LessonExtractionSource) => Promise<ExtractedLesson | null>;

export interface LessonCandidateServiceOptions {
  lessonExtractor?: LessonExtractor;
}

interface EventRow {
  id: string;
  event_type: string;
  session_id: string;
  timestamp: string;
  content: string;
  metadata: string | null;
}

interface TranscriptEntry {
  eventType: string;
  content: string;
}

interface SessionProfile {
  sessionId: string;
  firstTimestamp: string;
  eventIds: string[];
  sourceEventIds: string[];
  successEventIds: string[];
  /** Intent-bearing events (prompts and answers) in chronological order. */
  narrative: TranscriptEntry[];
  /** Tool output that carried a success or failure signal — the procedure itself. */
  signals: TranscriptEntry[];
  tools: Set<ToolPattern>;
  fileCategories: Set<string>;
  taskPatterns: Set<string>;
  successSignals: Set<ToolPattern>;
  hasFailureSignal: boolean;
  /** Timestamps of the last failure/success signal, used to detect recovery. */
  lastFailureTimestamp: string | null;
  lastSuccessTimestamp: string | null;
  hasPrivacyConflict: boolean;
}

type ToolPattern = typeof TOOL_ORDER[number];

const TOOL_ORDER = [
  'focused-test',
  'typecheck',
  'build',
  'full-suite',
  'static-privacy-scan',
  'verified-commit',
  'diff-check'
] as const;

const TOOL_LABELS: Record<ToolPattern, string> = {
  'focused-test': 'focused tests',
  typecheck: 'typecheck',
  build: 'build',
  'full-suite': 'full suite',
  'static-privacy-scan': 'static/privacy scan',
  'verified-commit': 'verified commit',
  'diff-check': 'diff check'
};

function sanitizeString(value: string): string {
  return String(sanitizeGovernanceAuditValue(value)).trim();
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
    || tags.includes('private')
    || tags.includes('privacy:private');
}

function isFailureSignal(content: string): boolean {
  const lower = content.toLowerCase();
  return /\bexit[_ -]?code\s*[:=]?\s*[1-9]\d*\b/.test(lower)
    || /\bfailed\b|\bfailure\b|\berror\b|\bblocked\b/.test(lower)
    || /\[blocked\]/.test(lower);
}

function isSuccessSignal(content: string): boolean {
  const lower = content.toLowerCase();
  if (isFailureSignal(content)) return false;
  return /\bexit[_ -]?code\s*[:=]?\s*0\b/.test(lower)
    || /\bpassed\b|\bsuccess(?:ful)?\b|\bcompleted\b|\bcommitted\b|\[verified\]/.test(lower)
    || /\bstaged_static_scan_findings\s*=\s*0\b/.test(lower)
    || /\bdoc_static_scan_findings\s*=\s*0\b/.test(lower);
}

function extractToolPatterns(content: string): Set<ToolPattern> {
  const lower = content.toLowerCase();
  const tools = new Set<ToolPattern>();

  if (/\bnpm\s+(?:run\s+)?test\b|\bvitest\b|\bpytest\b/.test(lower)) {
    const focused = /\btests?\/|\.test\.|\.spec\.|--run\s+tests?\//.test(lower);
    tools.add(focused ? 'focused-test' : 'full-suite');
  }
  if (/\bnpm\s+run\s+typecheck\b|\btsc\s+--noemit\b|\btypecheck\b/.test(lower)) {
    tools.add('typecheck');
  }
  if (/\bnpm\s+run\s+build\b|\bpnpm\s+build\b|\byarn\s+build\b|\btsc\s+-b\b/.test(lower)) {
    tools.add('build');
  }
  if (/\bstaged_static_scan_findings\s*=\s*0\b|\bdoc_static_scan_findings\s*=\s*0\b|static\/privacy scan|secretlint/.test(lower)) {
    tools.add('static-privacy-scan');
  }
  if (/\bgit\s+commit\b|\[verified\]/.test(lower)) {
    tools.add('verified-commit');
  }
  if (/\bgit\s+diff\b.*--check/.test(lower)) {
    tools.add('diff-check');
  }

  return tools;
}

function extractFileCategories(content: string): Set<string> {
  const categories = new Set<string>();
  const pathPattern = /(?:^|[\s`"'(])((?:src|tests|specs|docs)\/[A-Za-z0-9._/@-]+(?:\/[A-Za-z0-9._@-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|md|json|yaml|yml|py))/g;
  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(content)) !== null) {
    const path = match[1] ?? '';
    const extensionMatch = /\.([A-Za-z0-9]+)$/.exec(path);
    const extension = extensionMatch?.[1]?.toLowerCase();
    if (!extension) continue;
    if (path.startsWith('tests/')) {
      categories.add(`test:${extension}`);
    } else if (path.startsWith('src/')) {
      categories.add(`source:${extension}`);
    } else if (path.startsWith('docs/') || path.startsWith('specs/')) {
      categories.add(`docs:${extension}`);
    }
  }
  return categories;
}

function extractTaskPatterns(content: string): Set<string> {
  const lower = content.toLowerCase();
  const patterns = new Set<string>();
  if (/\bimplement\b|\bcreate\b|\badd\b|\bmodify\b|\bpatch\b|\bfix\b|\brefactor\b/.test(lower)) {
    patterns.add('code-change');
  }
  if (/\btest\b|\btypecheck\b|\bbuild\b|\bvalidation\b|\bvalidate\b/.test(lower)) {
    patterns.add('validation');
  }
  if (/\bcommit\b|\[verified\]/.test(lower)) {
    patterns.add('verified-commit');
  }
  if (/\bdoc(?:s|umentation)?\b|\bspec\b|\bplan\b/.test(lower)) {
    patterns.add('docs-or-spec');
  }
  return patterns;
}

function orderedTools(tools: Set<ToolPattern>): ToolPattern[] {
  return TOOL_ORDER.filter((tool) => tools.has(tool));
}

function maxTimestamp(current: string | null, candidate: string): string {
  if (!current) return candidate;
  return candidate.localeCompare(current) > 0 ? candidate : current;
}

function sortedStrings(values: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(values))).sort((a, b) => a.localeCompare(b));
}

function uniqueStrings(values: Iterable<string>, limit?: number): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of Array.from(values)) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
    if (limit !== undefined && unique.length >= limit) break;
  }
  return unique;
}

function profileSignature(profile: SessionProfile): string | null {
  const tools = orderedTools(profile.tools).filter((tool) => tool !== 'diff-check');
  const fileCategories = sortedStrings(profile.fileCategories);
  const taskPatterns = sortedStrings(profile.taskPatterns);
  if (tools.length < 2) return null;
  if (fileCategories.length === 0 && taskPatterns.length === 0) return null;
  const taskKey = taskPatterns.includes('code-change') ? 'code-change' : taskPatterns[0] ?? 'task';
  return `tools:${tools.join('+')}|files:${fileCategories.join('+') || 'none'}|task:${taskKey}`;
}

/**
 * A session qualifies when its workflow demonstrably ended in success.
 *
 * This deliberately does not veto every session that ever logged a failure.
 * The failure tokens (error/failed/blocked) appear somewhere in 93.7% of real
 * sessions — often inside unrelated tool output — so a whole-session veto made
 * nearly everything ineligible (measured: 120 of 121 sessions skipped). Worse,
 * it excluded exactly the sessions worth learning from: the ones that hit a
 * problem and then resolved it. What matters is recovery, so a failure only
 * disqualifies a session when no success signal follows it.
 */
function hasEnoughSuccess(profile: SessionProfile): boolean {
  if (profile.successEventIds.length === 0) return false;
  if (!hasRecoveredFromFailure(profile)) return false;
  const successTools = profile.successSignals;
  const testSignal = successTools.has('focused-test') || successTools.has('full-suite');
  const validationSignal = successTools.has('typecheck') || successTools.has('build') || successTools.has('static-privacy-scan');
  return successTools.has('verified-commit') || (testSignal && validationSignal);
}

function hasRecoveredFromFailure(profile: SessionProfile): boolean {
  if (!profile.hasFailureSignal) return true;
  if (!profile.lastSuccessTimestamp) return false;
  if (!profile.lastFailureTimestamp) return true;
  return profile.lastSuccessTimestamp.localeCompare(profile.lastFailureTimestamp) >= 0;
}

function confidenceForGroup(group: SessionProfile[], tools: ToolPattern[], fileCategories: string[], taskPatterns: string[]): number {
  const sessionBonus = Math.min(0.15, (group.length - 2) * 0.05);
  const toolBonus = Math.min(0.18, tools.length * 0.03);
  const evidenceBonus = fileCategories.length > 0 ? 0.04 : 0;
  const taskBonus = taskPatterns.length > 0 ? 0.03 : 0;
  return Math.min(0.95, Math.round((0.58 + sessionBonus + toolBonus + evidenceBonus + taskBonus) * 100) / 100);
}

function candidateIdFor(projectHash: string, signature: string): string {
  return `lesson-candidate:${createHash('sha256').update(`${projectHash}\n${signature}`).digest('hex').slice(0, 16)}`;
}

function sanitizeArray(values: string[]): string[] {
  return values.map(sanitizeString).filter((value) => value.length > 0);
}

/** Per-session caps that keep one long session from crowding out the others. */
const MAX_NARRATIVE_PER_SESSION = 12;
const MAX_SIGNALS_PER_SESSION = 10;
const MAX_ENTRY_CHARS = 800;
const MAX_TRANSCRIPT_CHARS = 14_000;

function transcriptLabel(eventType: string): string {
  if (eventType === 'user_prompt') return '사용자';
  if (eventType === 'agent_response') return '어시스턴트';
  return '도구';
}

/**
 * Builds the redacted transcript the extractor reads.
 *
 * Sessions are labelled positionally rather than by id: the id is an
 * identifier the lesson text must never carry, and it tells the model nothing.
 * Every line goes through the audit sanitizer first, so absolute paths and
 * credential assignments are gone before the text reaches a subprocess.
 */
function buildGroupTranscript(group: SessionProfile[]): string {
  const blocks: string[] = [];

  group.forEach((profile, index) => {
    const lines = [
      ...profile.narrative.slice(-MAX_NARRATIVE_PER_SESSION),
      ...profile.signals.slice(-MAX_SIGNALS_PER_SESSION)
    ]
      .map((entry) => {
        const content = sanitizeString(entry.content).replace(/\r?\n/g, ' ').trim();
        if (content.length === 0) return null;
        const clipped = content.length > MAX_ENTRY_CHARS
          ? `${content.slice(0, MAX_ENTRY_CHARS)}…`
          : content;
        return `[${transcriptLabel(entry.eventType)}] ${clipped}`;
      })
      .filter((line): line is string => line !== null);

    if (lines.length === 0) return;
    blocks.push([`## 세션 ${index + 1}`, ...lines].join('\n'));
  });

  const transcript = blocks.join('\n\n');
  return transcript.length > MAX_TRANSCRIPT_CHARS
    ? transcript.slice(0, MAX_TRANSCRIPT_CHARS)
    : transcript;
}

interface CandidateFacts {
  candidateId: string;
  tools: ToolPattern[];
  fileCategories: string[];
  taskPatterns: string[];
  sourceSessionIds: string[];
  sourceEventIds: string[];
  confidence: number;
  reasons: string[];
  transcript: string;
}

/**
 * The deterministic half of a candidate: which sessions grouped, what they have
 * in common, and how confident the grouping is. Only the human-readable lesson
 * text is left for the extractor.
 */
function deriveCandidateFacts(
  projectHash: string,
  signature: string,
  group: SessionProfile[],
  maxSourceEventIds: number
): CandidateFacts {
  const tools = orderedTools(intersectionSets(group.map((profile) => profile.tools)))
    .filter((tool) => tool !== 'diff-check');
  const fileCategories = sortedStrings(intersectionSets(group.map((profile) => profile.fileCategories)));
  const taskPatterns = sortedStrings(intersectionSets(group.map((profile) => profile.taskPatterns)));
  const sourceSessionIds = group.map((profile) => profile.sessionId).sort((a, b) => a.localeCompare(b));
  const sourceEventIds = uniqueStrings(
    group.flatMap((profile) => profile.successEventIds.length > 0 ? profile.successEventIds : profile.sourceEventIds),
    maxSourceEventIds
  );
  const labels = tools.map((tool) => TOOL_LABELS[tool]);

  return {
    candidateId: candidateIdFor(projectHash, signature),
    tools,
    fileCategories,
    taskPatterns,
    sourceSessionIds,
    sourceEventIds,
    confidence: confidenceForGroup(group, tools, fileCategories, taskPatterns),
    reasons: [
      `${group.length} successful sessions share the same tool pattern`,
      fileCategories.length > 0
        ? `Shared file categories: ${fileCategories.join(', ')}`
        : 'Shared task pattern without exposing source paths',
      `Successful signals include: ${labels.join(', ')}`
    ],
    transcript: buildGroupTranscript(group)
  };
}

function assembleCandidate(
  projectHash: string,
  facts: CandidateFacts,
  extraction: ExtractedLesson
): LessonCandidate {
  return {
    candidateId: facts.candidateId,
    projectHash: sanitizeString(projectHash),
    name: sanitizeString(extraction.name),
    trigger: sanitizeString(extraction.trigger),
    steps: sanitizeArray(extraction.steps),
    confidence: facts.confidence,
    sourceSessionIds: sanitizeArray(facts.sourceSessionIds),
    sourceEventIds: sanitizeArray(facts.sourceEventIds),
    failureModes: sanitizeArray(extraction.failureModes),
    skillCandidate: true,
    pattern: {
      tools: sanitizeArray(facts.tools),
      fileCategories: sanitizeArray(facts.fileCategories),
      taskPatterns: sanitizeArray(facts.taskPatterns)
    },
    reasons: sanitizeArray(facts.reasons)
  };
}

function intersectionSets<T>(sets: Array<Set<T>>): Set<T> {
  if (sets.length === 0) return new Set<T>();
  const [first, ...rest] = sets;
  const result = new Set<T>();
  for (const value of Array.from(first)) {
    if (rest.every((set) => set.has(value))) result.add(value);
  }
  return result;
}

export class LessonCandidateService {
  private readonly lessonExtractor?: LessonExtractor;
  private readonly extractionCache: LessonExtractionCache;

  constructor(private readonly db: SQLiteDatabase, options: LessonCandidateServiceOptions = {}) {
    this.lessonExtractor = options.lessonExtractor;
    this.extractionCache = new LessonExtractionCache(db);
  }

  async findCandidates(input: unknown): Promise<LessonCandidateResult> {
    const parsed = LessonCandidateInputSchema.parse(input);
    const profiles = this.buildSessionProfiles(parsed);
    const scannedSessions = profiles.length;
    const eligibleProfiles: SessionProfile[] = [];
    let skippedSessions = 0;

    for (const profile of profiles) {
      if (this.isEligibleProfile(profile)) {
        eligibleProfiles.push(profile);
      } else {
        skippedSessions += 1;
      }
    }

    const groups = this.groupProfiles(eligibleProfiles, parsed.minSessions);
    // Rank on the deterministic facts before extracting, so a slow extractor
    // runs only for the groups that can still make the caller's limit.
    const ranked = groups
      .map(([signature, group]) => deriveCandidateFacts(
        parsed.projectHash,
        signature,
        group,
        parsed.maxSourceEventIds
      ))
      .sort((a, b) => b.confidence - a.confidence
        || b.sourceSessionIds.length - a.sourceSessionIds.length
        || a.candidateId.localeCompare(b.candidateId))
      .slice(0, parsed.limit);

    const candidates: LessonCandidate[] = [];
    for (const facts of ranked) {
      const extraction = await this.resolveExtraction(parsed.projectHash, facts);
      if (!extraction) continue;
      candidates.push(assembleCandidate(parsed.projectHash, facts, extraction));
    }

    return {
      scannedSessions,
      eligibleSessions: eligibleProfiles.length,
      skippedSessions,
      groupedPatterns: groups.length,
      candidates
    };
  }

  /**
   * Cache first, extractor second. Serving repeat calls from the cache is what
   * lets promotion re-derive a candidate and get back the same text a reviewer
   * approved; a fresh extraction each time would let the two diverge.
   *
   * Returns null whenever no lesson text can be produced — no extractor wired,
   * the provider failed, or the group held nothing reusable. The candidate is
   * then omitted rather than falling back to templated text.
   */
  private async resolveExtraction(
    projectHash: string,
    facts: CandidateFacts
  ): Promise<ExtractedLesson | null> {
    if (facts.transcript.trim().length === 0) return null;

    const fingerprint = lessonExtractionFingerprint({
      sourceSessionIds: facts.sourceSessionIds,
      sourceEventIds: facts.sourceEventIds,
      transcript: facts.transcript
    });

    const cached = this.extractionCache.read(facts.candidateId, fingerprint);
    if (cached) return cached;

    if (!this.lessonExtractor) return null;

    let extraction: ExtractedLesson | null;
    try {
      extraction = await this.lessonExtractor({
        projectHash,
        candidateId: facts.candidateId,
        sessionCount: facts.sourceSessionIds.length,
        tools: facts.tools.map((tool) => TOOL_LABELS[tool]),
        fileCategories: facts.fileCategories,
        taskPatterns: facts.taskPatterns,
        transcript: facts.transcript
      });
    } catch {
      // A provider outage must not fail the whole listing: other groups may
      // still be served from cache.
      return null;
    }

    if (!extraction) return null;

    this.extractionCache.write({
      candidateId: facts.candidateId,
      projectHash,
      fingerprint,
      extraction
    });
    return extraction;
  }

  private buildSessionProfiles(input: ParsedLessonCandidateInput): SessionProfile[] {
    // Take the newest events, then restore chronological order for profiling.
    // Scanning `timestamp ASC LIMIT n` meant a long-lived project only ever
    // inspected its oldest window: with the 2000-event default this project saw
    // 32 of 207 sessions, all of them ancient. Recent work is what carries
    // reusable patterns.
    const rows = sqliteAll<EventRow>(
      this.db,
      `SELECT id, event_type, session_id, timestamp, content, metadata
       FROM (
         SELECT id, event_type, session_id, timestamp, content, metadata
         FROM events
         WHERE (
           json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.scope.project.hash') = ?
           OR json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.projectHash') = ?
         )
         ORDER BY timestamp DESC
         LIMIT ?
       )
       ORDER BY timestamp ASC`,
      [input.projectHash, input.projectHash, input.eventLimit]
    );
    const profilesBySession = new Map<string, SessionProfile>();

    for (const row of rows) {
      const metadata = parseMetadata(row.metadata);
      if (projectHashFromMetadata(metadata) !== input.projectHash) continue;
      const profile = this.ensureProfile(profilesBySession, row);
      profile.eventIds.push(row.id);
      profile.sourceEventIds.push(row.id);
      profile.hasPrivacyConflict ||= hasPrivacyConflict(metadata);
      profile.hasFailureSignal ||= isFailureSignal(row.content);

      const tools = extractToolPatterns(row.content);
      const success = isSuccessSignal(row.content);
      const failure = isFailureSignal(row.content);

      // Prompts and answers carry intent and decisions; tool output only earns
      // a place when it actually resolved to a signal, which is what makes the
      // procedure legible. Unsignalled tool output is the bulk of stored volume
      // and would crowd the extractor's context with noise.
      if (row.event_type === 'user_prompt' || row.event_type === 'agent_response') {
        profile.narrative.push({ eventType: row.event_type, content: row.content });
      } else if (success || failure) {
        profile.signals.push({ eventType: row.event_type, content: row.content });
      }

      if (failure) {
        profile.lastFailureTimestamp = maxTimestamp(profile.lastFailureTimestamp, row.timestamp);
      }
      if (success) {
        profile.lastSuccessTimestamp = maxTimestamp(profile.lastSuccessTimestamp, row.timestamp);
      }
      for (const tool of Array.from(tools)) {
        profile.tools.add(tool);
        if (success) profile.successSignals.add(tool);
      }
      for (const category of Array.from(extractFileCategories(row.content))) profile.fileCategories.add(category);
      for (const taskPattern of Array.from(extractTaskPatterns(row.content))) profile.taskPatterns.add(taskPattern);
      if (success) profile.successEventIds.push(row.id);
    }

    return Array.from(profilesBySession.values()).sort((a, b) => a.firstTimestamp.localeCompare(b.firstTimestamp));
  }

  private ensureProfile(profilesBySession: Map<string, SessionProfile>, row: EventRow): SessionProfile {
    let profile = profilesBySession.get(row.session_id);
    if (!profile) {
      profile = {
        sessionId: row.session_id,
        firstTimestamp: row.timestamp,
        eventIds: [],
        sourceEventIds: [],
        successEventIds: [],
        narrative: [],
        signals: [],
        tools: new Set<ToolPattern>(),
        fileCategories: new Set<string>(),
        taskPatterns: new Set<string>(),
        successSignals: new Set<ToolPattern>(),
        hasFailureSignal: false,
        lastFailureTimestamp: null,
        lastSuccessTimestamp: null,
        hasPrivacyConflict: false
      };
      profilesBySession.set(row.session_id, profile);
    }
    if (row.timestamp.localeCompare(profile.firstTimestamp) < 0) profile.firstTimestamp = row.timestamp;
    return profile;
  }

  private isEligibleProfile(profile: SessionProfile): boolean {
    return !profile.hasPrivacyConflict
      && profile.sourceEventIds.length > 0
      && hasEnoughSuccess(profile)
      && profileSignature(profile) !== null;
  }

  private groupProfiles(profiles: SessionProfile[], minSessions: number): Array<[string, SessionProfile[]]> {
    const grouped = new Map<string, SessionProfile[]>();
    for (const profile of profiles) {
      const signature = profileSignature(profile);
      if (!signature) continue;
      const group = grouped.get(signature) ?? [];
      group.push(profile);
      grouped.set(signature, group);
    }
    return Array.from(grouped.entries())
      .map(([signature, group]) => [
        signature,
        group.sort((a, b) => a.firstTimestamp.localeCompare(b.firstTimestamp))
      ] as [string, SessionProfile[]])
      .filter(([, group]) => group.length >= minSessions)
      .sort(([signatureA, groupA], [signatureB, groupB]) => groupB.length - groupA.length || signatureA.localeCompare(signatureB));
  }
}
