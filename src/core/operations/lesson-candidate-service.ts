import { createHash } from 'crypto';
import { z } from 'zod';

import { sqliteAll, type SQLiteDatabase } from '../sqlite-wrapper.js';
import { sanitizeGovernanceAuditValue } from './governance-audit.js';

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

interface EventRow {
  id: string;
  event_type: string;
  session_id: string;
  timestamp: string;
  content: string;
  metadata: string | null;
}

interface SessionProfile {
  sessionId: string;
  firstTimestamp: string;
  eventIds: string[];
  sourceEventIds: string[];
  successEventIds: string[];
  tools: Set<ToolPattern>;
  fileCategories: Set<string>;
  taskPatterns: Set<string>;
  successSignals: Set<ToolPattern>;
  hasFailureSignal: boolean;
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

const TOOL_STEPS: Record<ToolPattern, string> = {
  'focused-test': 'Run focused tests for the changed files',
  typecheck: 'Run typecheck',
  build: 'Run build',
  'full-suite': 'Run the full test suite',
  'static-privacy-scan': 'Run the static/privacy scan',
  'verified-commit': 'Commit verified changes',
  'diff-check': 'Run git diff checks'
};

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

function hasEnoughSuccess(profile: SessionProfile): boolean {
  if (profile.hasFailureSignal) return false;
  if (profile.successEventIds.length === 0) return false;
  const successTools = profile.successSignals;
  const testSignal = successTools.has('focused-test') || successTools.has('full-suite');
  const validationSignal = successTools.has('typecheck') || successTools.has('build') || successTools.has('static-privacy-scan');
  return successTools.has('verified-commit') || (testSignal && validationSignal);
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

function createCandidate(
  projectHash: string,
  signature: string,
  group: SessionProfile[],
  maxSourceEventIds: number
): LessonCandidate {
  const toolSets = group.map((profile) => profile.tools);
  const fileSets = group.map((profile) => profile.fileCategories);
  const taskSets = group.map((profile) => profile.taskPatterns);
  const tools = orderedTools(intersectionSets(toolSets)).filter((tool) => tool !== 'diff-check');
  const fileCategories = sortedStrings(intersectionSets(fileSets));
  const taskPatterns = sortedStrings(intersectionSets(taskSets));
  const sourceSessionIds = group.map((profile) => profile.sessionId).sort((a, b) => a.localeCompare(b));
  const sourceEventIds = uniqueStrings(
    group.flatMap((profile) => profile.successEventIds.length > 0 ? profile.successEventIds : profile.sourceEventIds),
    maxSourceEventIds
  );
  const labels = tools.map((tool) => TOOL_LABELS[tool]);
  const steps = tools.map((tool) => TOOL_STEPS[tool]);
  const name = `Workflow pattern: ${labels.slice(0, 4).join(' + ')}`;
  const trigger = `When ${taskPatterns.includes('code-change') ? 'code changes' : 'a project task'} repeat across ${group.length} successful sessions with ${labels.join(', ')}`;
  const reasons = [
    `${group.length} successful sessions share the same tool pattern`,
    fileCategories.length > 0 ? `Shared file categories: ${fileCategories.join(', ')}` : 'Shared task pattern without exposing source paths',
    `Successful signals include: ${labels.join(', ')}`
  ];

  return {
    candidateId: candidateIdFor(projectHash, signature),
    projectHash: sanitizeString(projectHash),
    name: sanitizeString(name),
    trigger: sanitizeString(trigger),
    steps: sanitizeArray(steps),
    confidence: confidenceForGroup(group, tools, fileCategories, taskPatterns),
    sourceSessionIds: sanitizeArray(sourceSessionIds),
    sourceEventIds: sanitizeArray(sourceEventIds),
    failureModes: sanitizeArray([
      'Do not promote if any source session is quarantined or privacy-tagged',
      'Resolve failed validation signals before treating the workflow as successful'
    ]),
    skillCandidate: true,
    pattern: {
      tools: sanitizeArray(tools),
      fileCategories: sanitizeArray(fileCategories),
      taskPatterns: sanitizeArray(taskPatterns)
    },
    reasons: sanitizeArray(reasons)
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
  constructor(private readonly db: SQLiteDatabase) {}

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
    const candidates = groups
      .map(([signature, group]) => createCandidate(parsed.projectHash, signature, group, parsed.maxSourceEventIds))
      .sort((a, b) => b.confidence - a.confidence
        || b.sourceSessionIds.length - a.sourceSessionIds.length
        || a.candidateId.localeCompare(b.candidateId))
      .slice(0, parsed.limit);

    return {
      scannedSessions,
      eligibleSessions: eligibleProfiles.length,
      skippedSessions,
      groupedPatterns: groups.length,
      candidates
    };
  }

  private buildSessionProfiles(input: ParsedLessonCandidateInput): SessionProfile[] {
    const rows = sqliteAll<EventRow>(
      this.db,
      `SELECT id, event_type, session_id, timestamp, content, metadata
       FROM events
       WHERE (
         json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.scope.project.hash') = ?
         OR json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.projectHash') = ?
       )
       ORDER BY timestamp ASC
       LIMIT ?`,
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
        tools: new Set<ToolPattern>(),
        fileCategories: new Set<string>(),
        taskPatterns: new Set<string>(),
        successSignals: new Set<ToolPattern>(),
        hasFailureSignal: false,
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
