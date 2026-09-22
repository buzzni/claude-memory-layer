import { readIngestSourceClocks, safeClientLabel } from '../../core/ingest-source-clocks.js';
/**
 * Per-project read-only memory audit
 * (specs/recent-memory-patterns-2026-09-06 R5).
 *
 * Two stores held 96.2% of the events in the 2026-09-06 sample, and
 * test-looking stores sat in the same totals as production ones, so a
 * machine-wide average said almost nothing about any individual project. This
 * report keeps the machine total *and* the per-store denominators, classifies
 * each store explicitly, and never hides a store it could not read: an
 * unreadable or unsupported store appears in coverage rather than silently
 * shrinking the denominator.
 *
 * Strictly read-only. It opens each store as a read-only snapshot and never
 * calls into `SQLiteEventStore`, whose `initialize()` would create tables and
 * run forward migrations on a user's database just because a report was run.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createSQLiteDatabase, sqliteAll, sqliteClose, sqliteGet, type SQLiteDatabase } from '../../core/sqlite-wrapper.js';
import {
  hashProjectPath,
  normalizeProjectPath,
  resolveMemoryRootMarkerPath
} from '../../core/registry/project-path.js';
import { loadSessionRegistry, type SessionRegistry } from '../../core/registry/session-registry.js';
import { summarizeTypedSelections } from '../../core/retrieval-trace-ledger.js';
import {
  emptyTypedSelectionSummary,
  CURRENT_USEFULNESS_EVALUATOR_VERSION,
  presentedOutcomeReason,
  type RetrievalOutcomeReason,
  type TypedSelectionSummary
} from '../../core/retrieval-telemetry.js';

export const MEMORY_AUDIT_SCHEMA_VERSION = 'memory-audit-v1';

export type MemoryAuditProjectClass = 'production' | 'test' | 'unknown';

export type MemoryAuditStoreState = 'read' | 'unreadable' | 'unsupported_schema' | 'empty';

export interface MemoryAuditStoreReport {
  storeHash: string;
  state: MemoryAuditStoreState;
  /** Failure text, redacted of absolute paths. Present only for `unreadable`. */
  error?: string;
  projectClass: MemoryAuditProjectClass;
  /** Why the class was chosen. A basename heuristic is a hint, never a verdict. */
  classificationBasis: 'explicit' | 'no-registry-entry' | 'global-store' | 'unclassified';
  classificationHint: 'test' | null;
  /** Canonical project hash the registry paths converge to, when it is unambiguous. */
  canonicalProjectHash: string | null;
  /** How the canonical hash was derived, reusing the git/marker convergence. */
  canonicalIdentityKind: 'memory-root-marker' | 'git-common-dir' | 'path-fallback' | 'unknown';
  /** Distinct registry paths that resolve to this store; >1 means aliases. */
  aliasPathCount: number;
  /** True when the aliases disagree about the canonical hash. */
  aliasConflict: boolean;
  schemaCapability: {
    events: boolean;
    retrievalTraces: boolean;
    typedTraceItems: boolean;
    usefulnessV2: boolean;
    memoryLessons: boolean;
    telemetrySchemaVersion: number | null;
  };
  events: { window: number; last24h: number; last48h: number; total: number };
  sources: ReturnType<typeof readIngestSourceClocks>;
  clients: Array<{ client: string; traces: number }>;
  traces: { window: number; withSelection: number; emptySelection: number };
  outcomeReasons: Array<{ reason: RetrievalOutcomeReason; traces: number }>;
  typedSelections: TypedSelectionSummary;
  evaluation: {
    /** evidence + user_prompt rows with an observed adoption. */
    evidencePromptEvaluated: number;
    evidencePromptGrounded: number;
    evidencePromptUnknown: number;
    /** Every v3 row in the window, for the unknown share. */
    observations: number;
    unknownAdoption: number;
    unknownShare: number | null;
    legacyAssumedDeliveryRows: number;
  };
  /** Read-only suggestion. Nothing is moved or merged by this report. */
  mergeSuggestion: string | null;
}

export interface MemoryAuditReport {
  schemaVersion: typeof MEMORY_AUDIT_SCHEMA_VERSION;
  mode: 'read-only';
  window: { since: string | null; until: string | null };
  coverage: {
    storesDiscovered: number;
    storesRead: number;
    storesUnreadable: number;
    storesUnsupportedSchema: number;
    unreadableRoots: number;
  };
  totals: {
    events: number;
    traces: number;
    selections: number;
    evidencePromptEvaluated: number;
    evidencePromptGrounded: number;
  };
  byProjectClass: Record<MemoryAuditProjectClass, {
    stores: number;
    events: number;
    traces: number;
    selections: number;
    evidencePromptEvaluated: number;
    evidencePromptGrounded: number;
  }>;
  stores: MemoryAuditStoreReport[];
  notes: string[];
}

export interface MemoryAuditOptions {
  homeDir?: string;
  since?: Date;
  until?: Date;
  /** Audit every store under the memory root. Without it, only the cwd project. */
  allProjects?: boolean;
  projectPath?: string;
  now?: Date;
  projectClasses?: Record<string, MemoryAuditProjectClass>;
}

/**
 * Names that *look* like scratch or test work. Deliberately advisory: the spec
 * forbids treating a basename as proof. Only classificationHint may use it;
 * projectClass remains unknown until explicitly configured by the caller.
 */
const TEST_NAME_PATTERN = /(^|[-_])(?:tmp|temp|test|testing|fixture|scratch|sandbox|playground|happy-testing-ground|happy-codex-instructions)([-_]|$)/i;

function redactPath(value: string): string {
  // Reports must not carry the user's absolute paths (specs R5).
  return value.replace(/(^|[\s"'([])(?:[A-Za-z]:)?[\\/][^\s"')\]]+/g, '$1<path>');
}

function tableExists(db: SQLiteDatabase, table: string): boolean {
  return sqliteAll<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [table]
  ).length > 0;
}

function columnExists(db: SQLiteDatabase, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  return sqliteAll<{ name: string }>(db, `PRAGMA table_info(${table})`).some((row) => row.name === column);
}

interface DiscoveredStore {
  storeHash: string;
  dbPath: string;
}

export function discoverMemoryStores(memoryRoot: string): { stores: DiscoveredStore[]; unreadableRoots: number } {
  const stores: DiscoveredStore[] = [];
  let unreadableRoots = 0;

  const globalDbPath = path.join(memoryRoot, 'events.sqlite');
  if (isLocalFile(globalDbPath)) stores.push({ storeHash: '__global__', dbPath: globalDbPath });

  const projectsRoot = path.join(memoryRoot, 'projects');
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.existsSync(projectsRoot) ? fs.readdirSync(projectsRoot, { withFileTypes: true }) : [];
  } catch {
    unreadableRoots += 1;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9]{8}$/.test(entry.name)) continue;
    const dbPath = path.join(projectsRoot, entry.name, 'events.sqlite');
    if (!isLocalFile(dbPath)) continue;
    stores.push({ storeHash: entry.name, dbPath });
  }
  return { stores, unreadableRoots };
}

function isLocalFile(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch (error) {
    // A known store path that cannot be inspected must not disappear from
    // coverage. Opening it will produce a redacted unreadable-store report.
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

interface StoreAliasInfo {
  paths: string[];
  canonicalHashes: Set<string>;
  identityKind: MemoryAuditStoreReport['canonicalIdentityKind'];
  looksLikeTest: boolean;
}

/**
 * Registry paths that hash to each store, resolved through the existing
 * git-common-dir / memory-root-marker convergence rather than a second copy of
 * that logic.
 */
export function aliasesByStore(registry: SessionRegistry): Map<string, StoreAliasInfo> {
  const byStore = new Map<string, StoreAliasInfo>();
  const seenPaths = new Set<string>();
  for (const entry of Object.values(registry.sessions)) {
    if (!entry?.projectPath) continue;
    const normalized = normalizeProjectPath(entry.projectPath);
    const key = `${entry.projectHash}::${normalized}`;
    if (seenPaths.has(key)) continue;
    seenPaths.add(key);

    let canonical: string;
    let identityKind: MemoryAuditStoreReport['canonicalIdentityKind'];
    try {
      canonical = hashProjectPath(normalized);
      identityKind = resolveMemoryRootMarkerPath(normalized) !== null
        ? 'memory-root-marker'
        : entry.identityKind ?? 'path-fallback';
    } catch {
      // A path that no longer resolves cannot be converged; the registered
      // hash is still the store it wrote to.
      canonical = entry.projectHash;
      identityKind = 'unknown';
    }

    for (const storeHash of new Set([entry.projectHash, canonical])) {
      const info = byStore.get(storeHash)
        ?? { paths: [], canonicalHashes: new Set<string>(), identityKind, looksLikeTest: false };
      info.paths.push(normalized);
      info.canonicalHashes.add(canonical);
      if (info.identityKind === 'unknown') info.identityKind = identityKind;
      info.looksLikeTest ||= TEST_NAME_PATTERN.test(path.basename(normalized));
      byStore.set(storeHash, info);
    }
  }
  return byStore;
}

function windowClause(alias: string, column: string, since?: Date, until?: Date): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (since) {
    clauses.push(`julianday(${alias}${column}) >= julianday(?)`);
    params.push(since.toISOString());
  }
  if (until) {
    clauses.push(`julianday(${alias}${column}) < julianday(?)`);
    params.push(until.toISOString());
  }
  return { sql: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

function auditOneStore(
  store: DiscoveredStore,
  options: { memoryRoot: string; since?: Date; until?: Date; now: Date; alias?: StoreAliasInfo; projectClass?: MemoryAuditProjectClass }
): MemoryAuditStoreReport {
  const alias = options.alias;
  const canonicalHashes = alias ? Array.from(alias.canonicalHashes) : [];
  const base: MemoryAuditStoreReport = {
    storeHash: store.storeHash,
    state: 'read',
    projectClass: options.projectClass ?? 'unknown',
    classificationHint: alias?.looksLikeTest ? 'test' : null,
    classificationBasis: options.projectClass !== undefined ? 'explicit' : store.storeHash === '__global__'
      ? 'global-store'
      : alias
        ? 'unclassified'
        : 'no-registry-entry',
    canonicalProjectHash: canonicalHashes.length === 1 ? canonicalHashes[0] : null,
    canonicalIdentityKind: alias?.identityKind ?? 'unknown',
    aliasPathCount: alias ? new Set(alias.paths).size : 0,
    aliasConflict: canonicalHashes.length > 1,
    schemaCapability: {
      events: false,
      retrievalTraces: false,
      typedTraceItems: false,
      usefulnessV2: false,
      memoryLessons: false,
      telemetrySchemaVersion: null
    },
    events: { window: 0, last24h: 0, last48h: 0, total: 0 },
    sources: [],
    clients: [],
    traces: { window: 0, withSelection: 0, emptySelection: 0 },
    outcomeReasons: [],
    typedSelections: emptyTypedSelectionSummary(),
    evaluation: {
      evidencePromptEvaluated: 0,
      evidencePromptGrounded: 0,
      evidencePromptUnknown: 0,
      observations: 0,
      unknownAdoption: 0,
      unknownShare: null,
      legacyAssumedDeliveryRows: 0
    },
    mergeSuggestion: canonicalHashes.length > 1
      ? `Registry paths for this store converge to more than one canonical hash (${canonicalHashes.sort().join(', ')}). `
        + 'Inspect before doing anything; this report never moves or merges a store.'
      : canonicalHashes.length === 1 && canonicalHashes[0] !== store.storeHash
        ? `Store hash differs from the canonical hash its registry paths resolve to (${canonicalHashes[0]}). `
          + 'Likely a worktree alias; verify the marker and the active store before consolidating.'
        : null
  };

  let db: SQLiteDatabase | undefined;
  try {
    // Read-only snapshot: no WAL recovery, no schema creation, no migration.
    db = createSQLiteDatabase(store.dbPath, {
      readonly: true,
      snapshot: true,
      canonicalMemoryRoot: options.memoryRoot,
      walMode: false
    });

    base.schemaCapability = {
      events: tableExists(db, 'events'),
      retrievalTraces: tableExists(db, 'retrieval_traces'),
      typedTraceItems: tableExists(db, 'retrieval_trace_items'),
      usefulnessV2: tableExists(db, 'memory_usefulness_observations_v2'),
      memoryLessons: tableExists(db, 'memory_lessons'),
      telemetrySchemaVersion: null
    };
    if (!base.schemaCapability.events) {
      base.state = 'unsupported_schema';
      return base;
    }

    const eventWindow = windowClause('', 'timestamp', options.since, options.until);
    base.events.window = Number(sqliteGet<{ count: number }>(
      db,
      `SELECT COUNT(*) AS count FROM events${eventWindow.sql}`,
      eventWindow.params
    )?.count ?? 0);
    base.events.total = Number(sqliteGet<{ count: number }>(db, `SELECT COUNT(*) AS count FROM events`)?.count ?? 0);
    const end = options.until ?? options.now;
    const rollingCount = (hours: number) => {
      const window = windowClause('', 'timestamp', new Date(end.getTime() - hours * 3_600_000), end);
      return Number(sqliteGet<{ count: number }>(db!, `SELECT COUNT(*) AS count FROM events${window.sql}`, window.params)?.count ?? 0);
    };
    base.events.last24h = rollingCount(24);
    base.events.last48h = rollingCount(48);
    base.sources = readIngestSourceClocks(db, { since: options.since, until: options.until });

    if (base.schemaCapability.retrievalTraces) {
      const traceWindow = windowClause('', 'created_at', options.since, options.until);
      const hasClient = columnExists(db, 'retrieval_traces', 'delivery_client');
      const hasOutcome = columnExists(db, 'retrieval_traces', 'outcome_reason');
      const hasSchemaVersion = columnExists(db, 'retrieval_traces', 'telemetry_schema_version');

      const traceTotals = sqliteGet<{ total: number; selected: number }>(
        db,
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN COALESCE(selected_count, 0) > 0 THEN 1 ELSE 0 END) AS selected
         FROM retrieval_traces${traceWindow.sql}`,
        traceWindow.params
      );
      base.traces.window = Number(traceTotals?.total ?? 0);
      base.traces.withSelection = Number(traceTotals?.selected ?? 0);
      base.traces.emptySelection = base.traces.window - base.traces.withSelection;

      if (hasClient) {
        base.clients = sqliteAll<{ client: string | null; traces: number }>(
          db,
          `SELECT COALESCE(delivery_client, 'unknown') AS client, COUNT(*) AS traces
           FROM retrieval_traces${traceWindow.sql}
           GROUP BY 1 ORDER BY traces DESC`,
          traceWindow.params
        ).reduce<MemoryAuditStoreReport['clients']>((clients, row) => {
          const client = safeClientLabel(row.client);
          const existing = clients.find((entry) => entry.client === client);
          if (existing) existing.traces += Number(row.traces);
          else clients.push({ client, traces: Number(row.traces) });
          return clients;
        }, []);
      }

      if (hasOutcome) {
        base.outcomeReasons = sqliteAll<{ reason: string; version: number | null; traces: number }>(
          db,
          `SELECT outcome_reason AS reason,
                  ${hasSchemaVersion ? 'telemetry_schema_version' : 'NULL'} AS version,
                  COUNT(*) AS traces
           FROM retrieval_traces${traceWindow.sql}
           GROUP BY 1, 2`,
          traceWindow.params
        ).reduce<Array<{ reason: RetrievalOutcomeReason; traces: number }>>((acc, row) => {
          // A stored `runtime_error` written before the honest-default
          // migration is presented as legacy_unclassified, never re-classified
          // in the store (specs R2).
          const reason = presentedOutcomeReason(row.reason, row.version);
          const existing = acc.find((entry) => entry.reason === reason);
          if (existing) existing.traces += Number(row.traces);
          else acc.push({ reason, traces: Number(row.traces) });
          return acc;
        }, []).sort((a, b) => b.traces - a.traces);
      }

      if (hasSchemaVersion) {
        base.schemaCapability.telemetrySchemaVersion = Number(sqliteGet<{ version: number }>(
          db,
          `SELECT MAX(telemetry_schema_version) AS version FROM retrieval_traces`
        )?.version ?? 0);
      }

      base.typedSelections = summarizeTypedSelections(db, { since: options.since, until: options.until });
    }

    if (base.schemaCapability.usefulnessV2) {
      const hasTrigger = columnExists(db, 'memory_usefulness_observations_v2', 'trigger_type');
      const observations = sqliteAll<{
        presentation_mode: string;
        trigger_type: string | null;
        adoption: string;
        evaluator_version: string;
      }>(
        db,
        `SELECT o.presentation_mode, ${hasTrigger ? 'o.trigger_type' : `'unknown' AS trigger_type`},
                o.adoption, o.evaluator_version
         FROM memory_usefulness_observations_v2 o
         LEFT JOIN retrieval_traces t ON t.trace_id = o.trace_id
         ${options.since || options.until
          ? `WHERE ${[
            options.since ? 'julianday(COALESCE(t.created_at, o.evaluated_at)) >= julianday(?)' : null,
            options.until ? 'julianday(COALESCE(t.created_at, o.evaluated_at)) < julianday(?)' : null
          ].filter(Boolean).join(' AND ')}`
          : ''}`,
        [
          ...(options.since ? [options.since.toISOString()] : []),
          ...(options.until ? [options.until.toISOString()] : [])
        ]
      );
      const current = observations.filter((row) => row.evaluator_version === CURRENT_USEFULNESS_EVALUATOR_VERSION);
      const evidencePrompt = current.filter((row) =>
        row.presentation_mode === 'evidence' && row.trigger_type === 'user_prompt');
      base.evaluation.observations = current.length;
      base.evaluation.evidencePromptGrounded = evidencePrompt.filter((row) => row.adoption === 'grounded').length;
      base.evaluation.evidencePromptEvaluated = evidencePrompt.filter((row) =>
        row.adoption === 'grounded' || row.adoption === 'not_observed').length;
      base.evaluation.evidencePromptUnknown = evidencePrompt.length - base.evaluation.evidencePromptEvaluated;
      base.evaluation.unknownAdoption = current.filter((row) => row.adoption === 'unknown').length;
      base.evaluation.unknownShare = current.length > 0
        ? Math.round((base.evaluation.unknownAdoption / current.length) * 10_000) / 10_000
        : null;
      base.evaluation.legacyAssumedDeliveryRows = observations.filter((row) => row.evaluator_version === 'v2').length;
    }

    const hasTraceRows = base.schemaCapability.retrievalTraces && Number(sqliteGet<{ count: number }>(
      db,
      'SELECT COUNT(*) AS count FROM retrieval_traces'
    )?.count ?? 0) > 0;
    const hasLessonRows = base.schemaCapability.memoryLessons && Number(sqliteGet<{ count: number }>(
      db,
      'SELECT COUNT(*) AS count FROM memory_lessons'
    )?.count ?? 0) > 0;
    if (base.events.total === 0 && !hasTraceRows && !hasLessonRows) base.state = 'empty';
    return base;
  } catch (error) {
    base.state = 'unreadable';
    base.error = redactPath(error instanceof Error ? error.message : String(error)).slice(0, 300);
    return base;
  } finally {
    if (db) {
      try {
        sqliteClose(db);
      } catch {
        // A close failure does not invalidate what was already read.
      }
    }
  }
}

export function buildMemoryAuditReport(options: MemoryAuditOptions = {}): MemoryAuditReport {
  const projectClasses = validateProjectClasses(options.projectClasses ?? {});
  const homeDir = options.homeDir ?? os.homedir();
  const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
  const now = options.now ?? new Date();
  const discovered = discoverMemoryStores(memoryRoot);
  const registry = loadSessionRegistry({ homeDir });
  const aliases = aliasesByStore(registry);

  let stores = discovered.stores;
  if (!options.allProjects) {
    const projectHash = hashProjectPath(options.projectPath ?? process.cwd());
    stores = stores.filter((store) => store.storeHash === projectHash);
  }

  const reports = stores.map((store) => auditOneStore(store, {
    memoryRoot,
    since: options.since,
    until: options.until,
    now,
    alias: aliases.get(store.storeHash),
    projectClass: projectClasses[store.storeHash]
  }));

  const byProjectClass: MemoryAuditReport['byProjectClass'] = {
    production: { stores: 0, events: 0, traces: 0, selections: 0, evidencePromptEvaluated: 0, evidencePromptGrounded: 0 },
    test: { stores: 0, events: 0, traces: 0, selections: 0, evidencePromptEvaluated: 0, evidencePromptGrounded: 0 },
    unknown: { stores: 0, events: 0, traces: 0, selections: 0, evidencePromptEvaluated: 0, evidencePromptGrounded: 0 }
  };
  const totals = {
    events: 0,
    traces: 0,
    selections: 0,
    evidencePromptEvaluated: 0,
    evidencePromptGrounded: 0
  };
  for (const report of reports) {
    const bucket = byProjectClass[report.projectClass];
    bucket.stores += 1;
    bucket.events += report.events.window;
    bucket.traces += report.traces.window;
    bucket.selections += report.typedSelections.total;
    bucket.evidencePromptEvaluated += report.evaluation.evidencePromptEvaluated;
    bucket.evidencePromptGrounded += report.evaluation.evidencePromptGrounded;
    totals.events += report.events.window;
    totals.traces += report.traces.window;
    totals.selections += report.typedSelections.total;
    totals.evidencePromptEvaluated += report.evaluation.evidencePromptEvaluated;
    totals.evidencePromptGrounded += report.evaluation.evidencePromptGrounded;
  }

  const notes = [
    'Read-only. No store was created, migrated, imported, embedded or checkpointed by this report.',
    'project_class is explicit or unknown. A basename heuristic appears only as classificationHint; '
      + 'machine totals and explicitly classified totals are both reported.',
    'Alias and worktree observations are suggestions only; nothing is moved or merged.'
  ];
  if (discovered.unreadableRoots > 0) {
    notes.push(`${discovered.unreadableRoots} store root(s) could not be listed and are excluded from discovery.`);
  }

  return {
    schemaVersion: MEMORY_AUDIT_SCHEMA_VERSION,
    mode: 'read-only',
    window: {
      since: options.since?.toISOString() ?? null,
      until: options.until?.toISOString() ?? null
    },
    coverage: {
      storesDiscovered: reports.length,
      storesRead: reports.filter((report) => report.state === 'read' || report.state === 'empty').length,
      storesUnreadable: reports.filter((report) => report.state === 'unreadable').length,
      storesUnsupportedSchema: reports.filter((report) => report.state === 'unsupported_schema').length,
      unreadableRoots: discovered.unreadableRoots
    },
    totals,
    byProjectClass,
    stores: reports.sort((a, b) => b.events.window - a.events.window || a.storeHash.localeCompare(b.storeHash)),
    notes
  };
}

export function formatMemoryAuditMarkdown(report: MemoryAuditReport): string {
  const lines: string[] = [
    '# Memory audit (read-only)',
    '',
    `Window: ${report.window.since ?? 'all'} .. ${report.window.until ?? 'now'}`,
    `Stores: ${report.coverage.storesDiscovered} discovered · ${report.coverage.storesRead} read · `
      + `${report.coverage.storesUnreadable} unreadable · ${report.coverage.storesUnsupportedSchema} unsupported schema`,
    '',
    '## Totals',
    '',
    '| Scope | Stores | Events | Traces | Selections | evidence/user_prompt grounded / evaluated |',
    '|---|---:|---:|---:|---:|---:|',
    `| machine | ${report.coverage.storesDiscovered} | ${report.totals.events} | ${report.totals.traces} `
      + `| ${report.totals.selections} | ${report.totals.evidencePromptGrounded} / ${report.totals.evidencePromptEvaluated} |`
  ];
  for (const [projectClass, bucket] of Object.entries(report.byProjectClass)) {
    lines.push(`| ${projectClass} | ${bucket.stores} | ${bucket.events} | ${bucket.traces} | ${bucket.selections} `
      + `| ${bucket.evidencePromptGrounded} / ${bucket.evidencePromptEvaluated} |`);
  }

  lines.push('', '## Stores', '');
  lines.push('| Store | State | Class | Aliases | Typed schema | Events (win/24h/48h) | Traces (empty) | Selections (event/lesson/unknown) | grounded/evaluated | unknown share |');
  lines.push('|---|---|---|---:|---|---|---|---|---|---:|');
  for (const store of report.stores) {
    const typed = store.typedSelections;
    lines.push(
      `| ${store.storeHash} | ${store.state} | ${store.projectClass} | ${store.aliasPathCount}`
      + `${store.aliasConflict ? ' ⚠' : ''} | ${store.schemaCapability.typedTraceItems ? 'typed' : 'legacy'}`
      + ` v${store.schemaCapability.telemetrySchemaVersion ?? '?'} | `
      + `${store.events.window}/${store.events.last24h}/${store.events.last48h} | `
      + `${store.traces.window} (${store.traces.emptySelection}) | `
      + `${typed.byKind.event}/${typed.byKind.lesson}/${typed.byKind.unknown} | `
      + `${store.evaluation.evidencePromptGrounded}/${store.evaluation.evidencePromptEvaluated} | `
      + `${store.evaluation.unknownShare === null ? 'n/a' : store.evaluation.unknownShare} |`
    );
  }

  const suggestions = report.stores.filter((store) => store.mergeSuggestion);
  lines.push('', '## Source clocks', '',
    '| Store | Source | Events | Known / unknown source clocks | Median / max lag (ms) | Latest occurred / ingested |',
    '|---|---|---:|---|---|---|');
  for (const store of report.stores) {
    for (const source of store.sources) {
      lines.push(`| ${store.storeHash} | ${source.source} | ${source.events} | ${source.withSourceClock} / ${source.unknownSourceClock} | `
        + `${source.medianLagMs ?? 'unknown'} / ${source.maxLagMs ?? 'unknown'} | `
        + `${source.latestOccurredAt ?? 'unknown'} / ${source.latestIngestedAt ?? 'unknown'} |`);
    }
  }
  lines.push('', 'Importer cursor: unknown; observed source timestamps above are not importer progress or backlog measurements.');
  if (suggestions.length > 0) {
    lines.push('', '## Suggestions (no action taken)', '');
    for (const store of suggestions) lines.push(`- \`${store.storeHash}\`: ${store.mergeSuggestion}`);
  }
  const failures = report.stores.filter((store) => store.state === 'unreadable' || store.state === 'unsupported_schema');
  if (failures.length > 0) {
    lines.push('', '## Stores counted but not measurable', '');
    for (const store of failures) {
      lines.push(`- \`${store.storeHash}\`: ${store.state}${store.error ? ` — ${store.error}` : ''}`);
    }
  }

  lines.push('', '## Notes', '');
  for (const note of report.notes) lines.push(`- ${note}`);
  return lines.join('\n');
}

export interface MemoryAuditCommandOptions {
  since?: string;
  until?: string;
  allProjects?: boolean;
  readOnly?: boolean;
  format?: string;
  project?: string;
  classify?: string[];
}

export interface ResolvedMemoryAuditOptions {
  since?: Date;
  until?: Date;
  allProjects: boolean;
  format: 'json' | 'markdown';
  projectPath?: string;
  projectClasses: Record<string, MemoryAuditProjectClass>;
}

function validateProjectClasses(input: Record<string, MemoryAuditProjectClass>): Record<string, MemoryAuditProjectClass> {
  const result: Record<string, MemoryAuditProjectClass> = {};
  for (const [hash, value] of Object.entries(input)) {
    if (!/^(?:[a-f0-9]{8}|__global__)$/.test(hash) || !['production', 'test', 'unknown'].includes(value)) {
      throw new Error('audit --classify requires HASH=production|test|unknown (8-digit store hash or __global__)');
    }
    result[hash] = value;
  }
  return result;
}

export function resolveMemoryAuditOptions(
  options: MemoryAuditCommandOptions
): ResolvedMemoryAuditOptions {
  const parseBoundary = (value: string | undefined, flag: string): Date | undefined => {
    if (value === undefined) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error(`${flag} must be an ISO timestamp`);
    return parsed;
  };
  const since = parseBoundary(options.since, 'audit --since');
  const until = parseBoundary(options.until, 'audit --until');
  if (since && until && since.getTime() > until.getTime()) {
    throw new Error('audit --since must not be after --until');
  }
  const format = options.format ?? 'markdown';
  if (format !== 'json' && format !== 'markdown') {
    throw new Error('audit --format must be json or markdown');
  }
  // `--read-only` is accepted and is the only mode: the flag documents the
  // contract at the call site, it never unlocks a writing mode.
  if (options.readOnly === false) {
    throw new Error('memory audit is read-only; there is no writing mode to disable');
  }
  return {
    since,
    until,
    allProjects: options.allProjects === true,
    format,
    projectPath: options.project,
    projectClasses: validateProjectClasses(Object.fromEntries((options.classify ?? []).map((assignment) => {
      const separator = assignment.indexOf('=');
      return [assignment.slice(0, separator), assignment.slice(separator + 1)] as [string, MemoryAuditProjectClass];
    })))
  };
}
