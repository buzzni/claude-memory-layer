/**
 * Read-only lesson-usage, lesson-quality, and prompt-quality aggregates for
 * the memory audit (specs/memory-usage-followup-2026-10-03 R2/R3/R4).
 *
 * Different provenances are reported side by side and never summed:
 * - typed retrieval selections (what a hook or SessionStart listed),
 * - lesson-host selected / delivered / read traces (host acknowledgements),
 * - MCP mem-lesson-get body lookups observed as Claude tool observations.
 * None of them proves a lesson was applied, so applied/task success stay
 * unknown. Output carries only enums, counts, and hashes: no prompt text, tool
 * input/output, lesson body or name, path, or session/user id.
 *
 * Every reader tolerates missing tables/columns (reported as unsupported) and
 * pages through events so raw content is never accumulated.
 */

import { sqliteAll, sqliteGet, type SQLiteDatabase } from './sqlite-wrapper.js';
import { deliveredSelectionTraceId } from './lesson-host-lineage.js';
import {
  normalizeUserPrompt,
  PROMPT_CLASSIFIER_VERSION,
  PROMPT_SCAFFOLD_KINDS,
  type PromptScaffoldKind
} from './prompt-normalizer.js';

export const LESSON_USAGE_AUDIT_VERSION = 1;

/**
 * Exact tool names whose observations are MCP lesson body lookups: the bare
 * tool, the Claude MCP name for this server, its underscore spelling, and the
 * Claude plugin-scoped form (`mcp__plugin_<plugin>_<server>__<tool>`) in both
 * spellings. Mentions in content or near-miss names never count.
 */
export const LESSON_GET_TOOL_ALIASES: readonly string[] = [
  'mem-lesson-get',
  'mcp__claude-memory-layer__mem-lesson-get',
  'mcp__claude_memory_layer__mem_lesson_get',
  'mcp__plugin_claude-memory-layer_claude-memory-layer__mem-lesson-get',
  'mcp__plugin_claude_memory_layer_claude_memory_layer__mem_lesson_get'
];

const EVENT_PAGE_SIZE = 500;
/** Only recognizable semver (with optional prerelease/build) is printed; any other label collapses to `other`. */
const SEMVER_PATTERN = /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
/** A complete mem-lesson-get response is a few KB; anything larger was not stored whole. */
const MAX_LOOKUP_OUTPUT_CHARS = 256_000;
const TRUNCATION_MARKERS = ['characters truncated] ...', 'lines truncated] ...', '...[truncated]'];

export type Support = 'supported' | 'unsupported';

export interface PromptQualitySummary {
  support: Support;
  timeBasis: 'events.timestamp';
  classifierVersion: typeof PROMPT_CLASSIFIER_VERSION;
  /** Counts are what classifier v1 recognizes in stored text; they are not ground truth. */
  recognition: 'recognized-by-classifier';
  /** Every stored user_prompt row in the window. The counts below overlap and must not be summed. */
  userPrompts: number;
  automatedEnvelopes: number;
  withRecognizedScaffold: number;
  scaffoldOnly: number;
  requestAfterNormalization: number;
  scaffoldKinds: Record<PromptScaffoldKind, number>;
  /** Rows still containing a lesson-proposal wrapper (whose staging token is never printed). */
  withProposalWrapper: number;
  /** Rows written with promptClassifier metadata (new writers). */
  storedWithClassifierMetadata: number;
}

export interface LessonLookupSummary {
  support: Support;
  timeBasis: 'events.timestamp';
  /** Only Claude PostToolUse records MCP calls; other clients are not observed, not zero. */
  observedClients: ['claude'];
  unobservedClients: ['codex', 'hermes'];
  calls: number;
  found: number;
  notFound: number;
  errored: number;
  /** Truncated, oversized, malformed, or unrecognized outputs. success=true alone never means found. */
  unknown: number;
  /** Lookups whose response named another project; excluded from found/notFound. */
  otherProject: number;
}

export interface HostLineageSummary {
  /** Delivered rows linked to their selected trace through the idempotency ledger and a full binding/revision match. */
  exact: number;
  /** Distinct selected traces among exact links; repeated acks are not repeated deliveries. */
  exactDistinctSelections: number;
  /** An ack record exists but is malformed or names a selected trace that does not match the binding/revisions. */
  inconsistent: number;
  /** No idempotency record at all; exactly one selected trace matches the full binding, turn, and revisions. */
  legacyUnique: number;
  /** No idempotency record; several selected traces match. Not counted as linked. */
  ambiguous: number;
  unlinked: number;
}

export interface HostTraceSummary {
  support: Support;
  timeBasis: 'lesson_host_traces.created_at';
  selected: { traces: number; items: number };
  delivered: { traces: number; items: number };
  read: { traces: number; items: number };
  deliveryLineage: HostLineageSummary | 'unsupported';
}

export interface SelectionSummary {
  support: Support;
  timeBasis: 'retrieval_traces.created_at';
  traces: number;
  items: number;
  uniqueLessons: number;
  byPresentation: { reference: number; evidence: number; other: number };
  byTrigger: { session_start: number; user_prompt: number; other: number };
  /** The per-item injection mode is not recorded; trace presentation is not body delivery. */
  itemInjectionMode: 'unknown';
}

export interface LessonUsageSummary {
  auditVersion: typeof LESSON_USAGE_AUDIT_VERSION;
  selection: SelectionSummary;
  host: HostTraceSummary;
  mcpBodyLookups: LessonLookupSummary;
  /** mem-lesson-get reads a snapshot, so canonical navigation rows are never written for it. */
  mcpNavigation: 'unsupported';
  applied: 'unknown';
  taskSuccess: 'unknown';
  runtimeVersions: Array<{ version: string; traces: number }> | 'unsupported';
  notes: string[];
}

export interface LessonQualitySummary {
  support: Support;
  total: number;
  /** `active` counts recall_enabled only; it does not mean eligible (scope, permission, version gates are not applied). */
  activeBasis: 'recall_enabled';
  active: number;
  disabled: number;
  /** Rows whose project_hash is not this store's project; excluded from every other count. */
  otherScopeRows: number;
  evidence: { noRefs: number; localRefsFound: number; refsUnresolvedHere: number };
  withSessionRefs: number;
  withValidation: number | 'unsupported';
  withReconsiderWhen: number | 'unsupported';
  /** Distinct lessons selected in the window by either retrieval traces or host traces. */
  recentlySelectedUnique: number;
}

export interface LessonUsageAuditResult {
  promptQuality: PromptQualitySummary;
  lessonUsage: LessonUsageSummary;
  lessonQuality: LessonQualitySummary;
}

export interface LessonUsageAuditOptions {
  since?: Date;
  until?: Date;
  /** The store's project hash; null for the global store (no scope exclusion). */
  projectHash: string | null;
  pageSize?: number;
}

export function auditLessonUsage(db: SQLiteDatabase, options: LessonUsageAuditOptions): LessonUsageAuditResult {
  const pageSize = Math.max(1, Math.min(options.pageSize ?? EVENT_PAGE_SIZE, 5_000));
  const selectedLessonIds = new Set<string>();
  const selection = summarizeSelections(db, options, selectedLessonIds);
  const host = summarizeHostTraces(db, options, selectedLessonIds);
  return {
    promptQuality: summarizePromptQuality(db, options, pageSize),
    lessonUsage: {
      auditVersion: LESSON_USAGE_AUDIT_VERSION,
      selection,
      host,
      mcpBodyLookups: summarizeLessonLookups(db, options, pageSize),
      mcpNavigation: 'unsupported',
      applied: 'unknown',
      taskSuccess: 'unknown',
      runtimeVersions: summarizeRuntimeVersions(db, options),
      notes: [
        'selection, host traces, and MCP body lookups are separate provenances; they are not summed into one read total or adoption rate.',
        'A selected reference is a listing, not a delivered body; host delivered means a host acknowledged delivery, not that the lesson was read or applied.'
      ]
    },
    lessonQuality: summarizeLessonQuality(db, options, selectedLessonIds)
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function tableColumns(db: SQLiteDatabase, table: string): Set<string> {
  return new Set(sqliteAll<{ name: string }>(db, `SELECT name FROM pragma_table_info(?)`, [table]).map((row) => row.name));
}

function windowSql(column: string, options: { since?: Date; until?: Date }): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (options.since) {
    clauses.push(`julianday(${column}) >= julianday(?)`);
    params.push(options.since.toISOString());
  }
  if (options.until) {
    clauses.push(`julianday(${column}) < julianday(?)`);
    params.push(options.until.toISOString());
  }
  return { sql: clauses.map((clause) => ` AND ${clause}`).join(''), params };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Iterate rows by rowid in fixed-size pages; callers only aggregate. */
function forEachEventPage<T extends { rid: number }>(
  db: SQLiteDatabase,
  sql: (cursorClause: string) => string,
  params: unknown[],
  pageSize: number,
  visit: (row: T) => void
): void {
  let cursor = -1;
  for (;;) {
    const page = sqliteAll<T>(db, sql('rowid > ?'), [...params, cursor, pageSize]);
    for (const row of page) visit(row);
    if (page.length < pageSize) return;
    cursor = page[page.length - 1].rid;
  }
}

// ---------------------------------------------------------------------------
// Prompt quality
// ---------------------------------------------------------------------------

function summarizePromptQuality(db: SQLiteDatabase, options: LessonUsageAuditOptions, pageSize: number): PromptQualitySummary {
  const summary: PromptQualitySummary = {
    support: 'unsupported',
    timeBasis: 'events.timestamp',
    classifierVersion: PROMPT_CLASSIFIER_VERSION,
    recognition: 'recognized-by-classifier',
    userPrompts: 0,
    automatedEnvelopes: 0,
    withRecognizedScaffold: 0,
    scaffoldOnly: 0,
    requestAfterNormalization: 0,
    scaffoldKinds: Object.fromEntries(PROMPT_SCAFFOLD_KINDS.map((kind) => [kind, 0])) as Record<PromptScaffoldKind, number>,
    withProposalWrapper: 0,
    storedWithClassifierMetadata: 0
  };
  const columns = tableColumns(db, 'events');
  if (!['event_type', 'timestamp', 'content'].every((column) => columns.has(column))) return summary;
  summary.support = 'supported';
  const hasMetadata = columns.has('metadata');
  const window = windowSql('timestamp', options);
  forEachEventPage<{ rid: number; content: unknown; metadata: unknown }>(
    db,
    (cursor) => `SELECT rowid AS rid, content, ${hasMetadata ? 'metadata' : 'NULL AS metadata'} FROM events
                 WHERE event_type = 'user_prompt'${window.sql} AND ${cursor} ORDER BY rowid LIMIT ?`,
    window.params,
    pageSize,
    (row) => {
      summary.userPrompts += 1;
      const normalized = normalizeUserPrompt(typeof row.content === 'string' ? row.content : '');
      if (normalized.kind === 'task_notification') summary.automatedEnvelopes += 1;
      if (normalized.kind === 'scaffold_only') summary.scaffoldOnly += 1;
      if (normalized.kind === 'user' && normalized.requestText.length > 0) summary.requestAfterNormalization += 1;
      if (normalized.removedScaffolds.length > 0) summary.withRecognizedScaffold += 1;
      for (const kind of normalized.removedScaffolds) summary.scaffoldKinds[kind] += 1;
      if (normalized.removedScaffolds.includes('lesson_proposal_wrapper')) summary.withProposalWrapper += 1;
      const metadata = parseJson(row.metadata);
      if (isRecord(metadata) && isRecord(metadata.promptClassifier)) summary.storedWithClassifierMetadata += 1;
    }
  );
  return summary;
}

// ---------------------------------------------------------------------------
// MCP body lookups
// ---------------------------------------------------------------------------

export type LessonLookupOutcome = 'found' | 'not_found' | 'errored' | 'unknown' | 'other_project';

/**
 * Classify one stored mem-lesson-get output. Claude records MCP results as a
 * JSON array of content blocks whose text is the tool's JSON, so the useful
 * payload is usually double-encoded. Only a complete JSON object with
 * operation=mem-lesson-get and a boolean `found` is decisive.
 */
export function classifyLessonGetOutput(toolOutput: unknown, projectHash: string | null): LessonLookupOutcome {
  if (typeof toolOutput !== 'string' || toolOutput.length === 0 || toolOutput.length > MAX_LOOKUP_OUTPUT_CHARS) return 'unknown';
  if (TRUNCATION_MARKERS.some((marker) => toolOutput.includes(marker))) return 'unknown';
  let value: unknown = toolOutput;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof value === 'string') {
      const text = value.trim();
      if (text.startsWith('Error [')) return 'errored';
      if (!text.startsWith('{') && !text.startsWith('[') && !text.startsWith('"')) return 'unknown';
      value = parseJson(text);
      if (value === undefined) return 'unknown';
      continue;
    }
    if (Array.isArray(value)) {
      const texts = value.filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string');
      if (texts.length !== 1 || value.length !== 1) return 'unknown';
      value = (texts[0] as { text: string }).text;
      continue;
    }
    if (isRecord(value)) {
      if (value.operation !== 'mem-lesson-get' || typeof value.found !== 'boolean') return 'unknown';
      if (projectHash && typeof value.projectHash === 'string' && value.projectHash !== projectHash) return 'other_project';
      return value.found ? 'found' : 'not_found';
    }
    return 'unknown';
  }
  return 'unknown';
}

function summarizeLessonLookups(db: SQLiteDatabase, options: LessonUsageAuditOptions, pageSize: number): LessonLookupSummary {
  const summary: LessonLookupSummary = {
    support: 'unsupported',
    timeBasis: 'events.timestamp',
    observedClients: ['claude'],
    unobservedClients: ['codex', 'hermes'],
    calls: 0,
    found: 0,
    notFound: 0,
    errored: 0,
    unknown: 0,
    otherProject: 0
  };
  const columns = tableColumns(db, 'events');
  if (!['event_type', 'timestamp', 'content', 'metadata'].every((column) => columns.has(column))) return summary;
  summary.support = 'supported';
  const window = windowSql('timestamp', options);
  const aliases = new Set(LESSON_GET_TOOL_ALIASES);
  // LIKE is only a prefilter; the exact toolName is checked on parsed metadata.
  forEachEventPage<{ rid: number; content: unknown; metadata: unknown }>(
    db,
    (cursor) => `SELECT rowid AS rid, content, metadata FROM events
                 WHERE event_type = 'tool_observation'
                   AND (metadata LIKE '%mem-lesson-get%' OR metadata LIKE '%mem\\_lesson\\_get%' ESCAPE '\\')${window.sql}
                   AND ${cursor} ORDER BY rowid LIMIT ?`,
    window.params,
    pageSize,
    (row) => {
      const metadata = parseJson(row.metadata);
      if (!isRecord(metadata) || typeof metadata.toolName !== 'string' || !aliases.has(metadata.toolName)) return;
      summary.calls += 1;
      const payload = parseJson(row.content);
      const outcome = isRecord(payload)
        ? classifyLessonGetOutput(payload.toolOutput, options.projectHash)
        : 'unknown';
      if (outcome === 'found') summary.found += 1;
      else if (outcome === 'not_found') summary.notFound += 1;
      else if (outcome === 'errored') summary.errored += 1;
      else if (outcome === 'other_project') summary.otherProject += 1;
      else summary.unknown += 1;
    }
  );
  return summary;
}

// ---------------------------------------------------------------------------
// Typed retrieval selections
// ---------------------------------------------------------------------------

function summarizeSelections(db: SQLiteDatabase, options: LessonUsageAuditOptions, selectedLessonIds: Set<string>): SelectionSummary {
  const summary: SelectionSummary = {
    support: 'unsupported',
    timeBasis: 'retrieval_traces.created_at',
    traces: 0,
    items: 0,
    uniqueLessons: 0,
    byPresentation: { reference: 0, evidence: 0, other: 0 },
    byTrigger: { session_start: 0, user_prompt: 0, other: 0 },
    itemInjectionMode: 'unknown'
  };
  const items = tableColumns(db, 'retrieval_trace_items');
  const traces = tableColumns(db, 'retrieval_traces');
  if (!['trace_id', 'memory_kind', 'memory_id', 'selected'].every((column) => items.has(column))
    || !['trace_id', 'created_at'].every((column) => traces.has(column))) {
    return summary;
  }
  summary.support = 'supported';
  const presentation = traces.has('presentation_mode') ? 't.presentation_mode' : `'unknown'`;
  const trigger = traces.has('trigger_type') ? 't.trigger_type' : `'unknown'`;
  const scoped = options.projectHash && items.has('project_id')
    ? ` AND (i.project_id IS NULL OR i.project_id = '' OR i.project_id = ?)`
    : '';
  const window = windowSql('t.created_at', options);
  const rows = sqliteAll<{ trace_id: string; memory_id: string; presentation: string | null; trigger: string | null }>(
    db,
    `SELECT i.trace_id, i.memory_id, ${presentation} AS presentation, ${trigger} AS trigger
     FROM retrieval_trace_items i JOIN retrieval_traces t ON t.trace_id = i.trace_id
     WHERE i.memory_kind = 'lesson' AND i.selected = 1${scoped}${window.sql}`,
    [...(scoped ? [options.projectHash] : []), ...window.params]
  );
  const traceIds = new Set<string>();
  const lessons = new Set<string>();
  for (const row of rows) {
    summary.items += 1;
    traceIds.add(row.trace_id);
    lessons.add(row.memory_id);
    selectedLessonIds.add(row.memory_id);
    if (row.presentation === 'reference' || row.presentation === 'evidence') summary.byPresentation[row.presentation] += 1;
    else summary.byPresentation.other += 1;
    if (row.trigger === 'session_start' || row.trigger === 'user_prompt') summary.byTrigger[row.trigger] += 1;
    else summary.byTrigger.other += 1;
  }
  summary.traces = traceIds.size;
  summary.uniqueLessons = lessons.size;
  return summary;
}

function summarizeRuntimeVersions(db: SQLiteDatabase, options: LessonUsageAuditOptions): LessonUsageSummary['runtimeVersions'] {
  const columns = tableColumns(db, 'retrieval_traces');
  if (!columns.has('runtime_version') || !columns.has('created_at')) return 'unsupported';
  const window = windowSql('created_at', options);
  const counts = new Map<string, number>();
  for (const row of sqliteAll<{ version: string | null; traces: number }>(
    db,
    `SELECT runtime_version AS version, COUNT(*) AS traces FROM retrieval_traces WHERE 1 = 1${window.sql} GROUP BY 1`,
    window.params
  )) {
    const version = typeof row.version === 'string' && row.version.length <= 64 && SEMVER_PATTERN.test(row.version)
      ? row.version
      : row.version ? 'other' : 'unknown';
    counts.set(version, (counts.get(version) ?? 0) + Number(row.traces));
  }
  return [...counts].map(([version, traces]) => ({ version, traces })).sort((a, b) => b.traces - a.traces || a.version.localeCompare(b.version));
}

// ---------------------------------------------------------------------------
// Lesson host traces and delivery lineage
// ---------------------------------------------------------------------------

interface HostTraceRow {
  trace_id: string;
  project_hash: string;
  session_id: string;
  actor_id: string;
  machine_id: string;
  generation: number;
  turn_id: string | null;
  request_id: string;
  phase: string;
  lesson_ids_json: string;
  lesson_revisions_json: string;
}

const HOST_TRACE_COLUMNS = ['trace_id', 'project_hash', 'session_id', 'actor_id', 'machine_id', 'generation', 'turn_id', 'request_id', 'phase', 'lesson_ids_json', 'created_at'];

function summarizeHostTraces(db: SQLiteDatabase, options: LessonUsageAuditOptions, selectedLessonIds: Set<string>): HostTraceSummary {
  const summary: HostTraceSummary = {
    support: 'unsupported',
    timeBasis: 'lesson_host_traces.created_at',
    selected: { traces: 0, items: 0 },
    delivered: { traces: 0, items: 0 },
    read: { traces: 0, items: 0 },
    deliveryLineage: 'unsupported'
  };
  const columns = tableColumns(db, 'lesson_host_traces');
  if (!HOST_TRACE_COLUMNS.every((column) => columns.has(column))) return summary;
  summary.support = 'supported';
  const revisions = columns.has('lesson_revisions_json') ? 'lesson_revisions_json' : `'[]' AS lesson_revisions_json`;
  const scope = options.projectHash ? ' AND project_hash = ?' : '';
  const window = windowSql('created_at', options);
  const select = `SELECT trace_id, project_hash, session_id, actor_id, machine_id, generation, turn_id, request_id, phase, lesson_ids_json, ${revisions} FROM lesson_host_traces`;
  const rows = sqliteAll<HostTraceRow>(
    db,
    `${select} WHERE 1 = 1${scope}${window.sql}`,
    [...(options.projectHash ? [options.projectHash] : []), ...window.params]
  );
  const delivered: HostTraceRow[] = [];
  for (const row of rows) {
    const items = stringArray(row.lesson_ids_json);
    const bucket = row.phase === 'selected' ? summary.selected : row.phase === 'delivered' ? summary.delivered : row.phase === 'read' ? summary.read : null;
    if (!bucket) continue;
    bucket.traces += 1;
    bucket.items += items.length;
    if (row.phase === 'selected') for (const id of items) selectedLessonIds.add(id);
    if (row.phase === 'delivered') delivered.push(row);
  }

  // Without recorded revisions a full binding/revision match cannot be
  // verified, so lineage is unsupported rather than matched on '[]'.
  const idempotency = tableColumns(db, 'lesson_host_idempotency');
  if (!columns.has('lesson_revisions_json')
    || !['project_hash', 'actor_id', 'request_id', 'operation', 'result_json'].every((column) => idempotency.has(column))) {
    return summary;
  }
  const lineage: HostLineageSummary = { exact: 0, exactDistinctSelections: 0, inconsistent: 0, legacyUnique: 0, ambiguous: 0, unlinked: 0 };
  const exactSelections = new Set<string>();
  const matchesBinding = (selected: HostTraceRow, row: HostTraceRow) => selected.phase === 'selected'
    && selected.project_hash === row.project_hash
    && selected.session_id === row.session_id
    && selected.actor_id === row.actor_id
    && selected.machine_id === row.machine_id
    && Number(selected.generation) === Number(row.generation)
    && selected.turn_id === row.turn_id
    && sameStrict(strictLessonSnapshot(selected), strictLessonSnapshot(row));
  for (const row of delivered) {
    const ack = sqliteGet<{ result_json: string }>(
      db,
      `SELECT result_json FROM lesson_host_idempotency WHERE project_hash = ? AND actor_id = ? AND request_id = ? AND operation = 'delivered'`,
      [row.project_hash, row.actor_id, row.request_id]
    );
    if (ack) {
      // Ack evidence exists, so the legacy fallback is not allowed: a
      // malformed or non-delivered result is inconsistent, never inferred.
      const selectionTraceId = deliveredSelectionTraceId(ack.result_json);
      // The selected trace may sit outside the audit window; look it up directly.
      const selected = selectionTraceId ? sqliteGet<HostTraceRow>(db, `${select} WHERE trace_id = ?`, [selectionTraceId]) : undefined;
      if (selectionTraceId && selected && matchesBinding(selected, row)) {
        lineage.exact += 1;
        exactSelections.add(selectionTraceId);
      } else {
        lineage.inconsistent += 1;
      }
      continue;
    }
    // Legacy rows: no recoverable ack record. Match on the full binding, turn,
    // and revisions; requestIds are independent and are never compared.
    const candidates = sqliteAll<HostTraceRow>(
      db,
      `${select} WHERE phase = 'selected' AND project_hash = ? AND session_id = ? AND actor_id = ? AND machine_id = ? AND generation = ? AND turn_id IS ?`,
      [row.project_hash, row.session_id, row.actor_id, row.machine_id, row.generation, row.turn_id]
    ).filter((selected) => matchesBinding(selected, row));
    if (candidates.length === 1) lineage.legacyUnique += 1;
    else if (candidates.length > 1) lineage.ambiguous += 1;
    else lineage.unlinked += 1;
  }
  lineage.exactDistinctSelections = exactSelections.size;
  summary.deliveryLineage = lineage;
  return summary;
}

/**
 * Canonical versioned lesson snapshot, or null unless every unique id has one
 * positive integer revision. The native writer emits both arrays in the same
 * order; validating them together prevents missing or foreign revisions from
 * certifying a delivery. Two empty arrays are a valid zero-item snapshot.
 */
function strictLessonSnapshot(row: HostTraceRow): string | null {
  const ids = parseJson(row.lesson_ids_json);
  const revisions = parseJson(row.lesson_revisions_json);
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id.length > 0)
    || new Set(ids).size !== ids.length || !Array.isArray(revisions) || revisions.length !== ids.length) return null;
  const entries: Array<{ lessonId: string; revision: number }> = [];
  for (const [index, entry] of revisions.entries()) {
    if (!isRecord(entry) || entry.lessonId !== ids[index]
      || typeof entry.revision !== 'number' || !Number.isInteger(entry.revision) || entry.revision < 1) {
      return null;
    }
    entries.push({ lessonId: ids[index], revision: entry.revision });
  }
  return JSON.stringify(entries);
}

/** Equal and valid on both sides; corrupt payloads never certify a link. */
function sameStrict(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && left === right;
}

// ---------------------------------------------------------------------------
// Lesson quality
// ---------------------------------------------------------------------------

function summarizeLessonQuality(db: SQLiteDatabase, options: LessonUsageAuditOptions, selectedLessonIds: Set<string>): LessonQualitySummary {
  const summary: LessonQualitySummary = {
    support: 'unsupported',
    total: 0,
    activeBasis: 'recall_enabled',
    active: 0,
    disabled: 0,
    otherScopeRows: 0,
    evidence: { noRefs: 0, localRefsFound: 0, refsUnresolvedHere: 0 },
    withSessionRefs: 0,
    withValidation: 'unsupported',
    withReconsiderWhen: 'unsupported',
    recentlySelectedUnique: 0
  };
  const columns = tableColumns(db, 'memory_lessons');
  if (!['lesson_id', 'project_hash', 'source_event_ids'].every((column) => columns.has(column))) return summary;
  summary.support = 'supported';
  const hasValidation = columns.has('validation_json');
  const hasReconsider = columns.has('reconsider_when');
  if (hasValidation) summary.withValidation = 0;
  if (hasReconsider) summary.withReconsiderWhen = 0;
  const eventIds = tableColumns(db, 'events').has('id');
  const rows = sqliteAll<{
    lesson_id: string;
    project_hash: string;
    source_event_ids: string;
    source_session_ids: string | null;
    recall_enabled: number | null;
    validation_json: string | null;
    reconsider_when: string | null;
  }>(
    db,
    `SELECT lesson_id, project_hash, source_event_ids,
            ${columns.has('source_session_ids') ? 'source_session_ids' : 'NULL AS source_session_ids'},
            ${columns.has('recall_enabled') ? 'recall_enabled' : '1 AS recall_enabled'},
            ${hasValidation ? 'validation_json' : 'NULL AS validation_json'},
            ${hasReconsider ? 'reconsider_when' : 'NULL AS reconsider_when'}
     FROM memory_lessons`
  );
  const inScope = new Set<string>();
  for (const row of rows) {
    if (options.projectHash && row.project_hash !== options.projectHash) {
      summary.otherScopeRows += 1;
      continue;
    }
    inScope.add(row.lesson_id);
    summary.total += 1;
    if (Number(row.recall_enabled ?? 1) === 1) summary.active += 1;
    else summary.disabled += 1;
    const refs = stringArray(row.source_event_ids);
    if (refs.length === 0) {
      summary.evidence.noRefs += 1;
    } else if (eventIds && refs.some((id) => sqliteGet(db, `SELECT 1 AS present FROM events WHERE id = ?`, [id]))) {
      summary.evidence.localRefsFound += 1;
    } else {
      // Refs may live in another alias store or a pruned window; this is not a verdict on the lesson.
      summary.evidence.refsUnresolvedHere += 1;
    }
    if (stringArray(row.source_session_ids).length > 0) summary.withSessionRefs += 1;
    if (hasValidation && stringArray(row.validation_json).length > 0) (summary.withValidation as number)++;
    if (hasReconsider && typeof row.reconsider_when === 'string' && row.reconsider_when.trim().length > 0) (summary.withReconsiderWhen as number)++;
  }
  summary.recentlySelectedUnique = [...selectedLessonIds].filter((id) => inScope.has(id)).length;
  return summary;
}
