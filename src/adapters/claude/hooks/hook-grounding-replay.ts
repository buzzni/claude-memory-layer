/**
 * Counterfactual grounding replay through the real UserPromptSubmit selection
 * path (#119).
 *
 * Each past hook trace in a store copy is replayed: the retrieval query is
 * rebuilt with the hook's own buildRetrievalQuery, selectHookInjection picks
 * the memories, and every injected excerpt is scored against the session's
 * later agent responses with computeMemoryUsageEvidence — the function the
 * helpfulness evaluator uses for content_overlap_score. Arms toggle the
 * retrieval experiment flags so their effect is measured on the hook path.
 *
 * The store copy is opened read-only. Events at or after each trace's time are
 * hidden from every lane, including the semantic retriever: reads are
 * over-fetched by the number of later events and filtered, so each list is the
 * one the hook saw then.
 */
import Database from 'better-sqlite3';
import * as path from 'path';

import { SQLiteEventStore } from '../../../core/sqlite-event-store.js';
import { MemoryQueryService } from '../../../core/engine/memory-query-service.js';
import { computeMemoryUsageEvidence, type ResponseDocument } from '../../../core/usefulness-evidence.js';
import type { MemoryEvent } from '../../../core/types.js';
import type { RetrievalDisclosureExpansion } from '../../../core/engine/retrieval-disclosure-service.js';
import type { VectorStore } from '../../../core/vector-store.js';
import { MemoryService } from '../../../services/memory-service.js';
import { DISABLED_SHARED_STORE_CONFIG } from '../../../services/memory-service-config.js';
import type { SemanticMemory } from './semantic-daemon-client.js';
import {
  buildRetrievalQuery,
  hookMemoryRefKind,
  memoryEvidencePreview,
  redactForStorage,
  selectHookInjection,
  shouldRunAdherenceCheck,
  type AdherenceDecision,
  type HookSelectionDeps,
  type HookSelectionMemoryService
} from './user-prompt-submit.js';

/** Same value the evaluator and measure-injection-grounding.mjs use for "grounded". */
const GROUNDED_OVERLAP = 0.3;
/** Mirrors readLastAssistantSnippet: 500 chars, ignored after two hours. */
const LAST_SNIPPET_CHARS = 500;
const LAST_SNIPPET_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const BOOTSTRAP_SAMPLES = 1000;

const FTS_ABSOLUTE_FLAG = 'CLAUDE_MEMORY_FTS_ABSOLUTE_SCORE_EXPERIMENT';
const QUERY_SANITIZER_FLAG = 'CLAUDE_MEMORY_RETRIEVAL_QUERY_SANITIZER_EXPERIMENT';

export interface ReplayArm {
  name: string;
  flags: Record<string, 'true' | undefined>;
}

export const DEFAULT_REPLAY_ARMS: ReplayArm[] = [
  { name: 'current', flags: { [FTS_ABSOLUTE_FLAG]: undefined, [QUERY_SANITIZER_FLAG]: undefined } },
  { name: 'fts-absolute (#121)', flags: { [FTS_ABSOLUTE_FLAG]: 'true', [QUERY_SANITIZER_FLAG]: undefined } },
  { name: 'query-sanitizer (#125)', flags: { [FTS_ABSOLUTE_FLAG]: undefined, [QUERY_SANITIZER_FLAG]: 'true' } },
  { name: '#121 + #125', flags: { [FTS_ABSOLUTE_FLAG]: 'true', [QUERY_SANITIZER_FLAG]: 'true' } }
];

export interface ReplayTurn {
  traceId: string;
  sessionId: string;
  /** Trace time; only events strictly before it are visible to the lanes. */
  asOf: Date;
  prompt: string;
  currentTurn: number;
  adherenceDecision: AdherenceDecision;
  /** True when no stored adherence metadata covered this turn and it was inferred. */
  adherenceReconstructed: boolean;
  previousUserPrompt: string | null;
  lastAssistantSnippet: string | null;
  /** Agent responses in the session after delivery: the evaluator's comparison set. */
  responses: ResponseDocument[];
  historicalQueryText: string;
  historicalSelectedIds: string[];
}

export interface ReplayInjection {
  kind: string;
  id: string;
  overlap: number | null;
}

export interface ReplayTurnResult {
  traceId: string;
  retrievalQuery: string;
  injections: ReplayInjection[];
  semanticDroppedAsFuture: number;
}

export interface ReplayMetrics {
  turns: number;
  turnsWithResponses: number;
  turnsWithInjection: number;
  injectedMemories: number;
  scoredMemories: number;
  meanOverlap: number | null;
  meanOverlapCi: [number, number] | null;
  groundedMemoryRate: number | null;
  groundedTurnRate: number | null;
}

export interface ReplayArmReport {
  arm: string;
  all: ReplayMetrics;
  /** Turns where the hook injected nothing at the time: free of the response bias. */
  historicallyUninjected: ReplayMetrics;
  queryChangedVsCurrent: number;
  selectionChangedVsCurrent: number;
  results: ReplayTurnResult[];
}

export interface ReplayReport {
  storeLabel: string;
  semantic: 'retriever' | 'off';
  turns: number;
  queryReproducedRate: number | null;
  selectionReproducedRate: number | null;
  adherenceReconstructedTurns: number;
  /** Safety net for the time bound; anything but 0 means a later event leaked. */
  semanticDroppedAsFuture: number;
  arms: ReplayArmReport[];
  caveats: string[];
}

export interface HookGroundingReplayOptions {
  storagePath: string;
  projectHash: string;
  /** 'retriever' runs the semantic lane in-process like the daemon; 'off' skips it (no embedder). */
  semantic: 'retriever' | 'off';
  limit?: number;
  arms?: ReplayArm[];
  storeLabel?: string;
}

interface TraceRow {
  trace_id: string;
  session_id: string | null;
  query_text: string;
  raw_query_text: string | null;
  selected_event_ids: string | null;
  created_at: string;
}

interface EventRow {
  id: string;
  content: string;
  timestamp: string;
  metadata: string | null;
}

export function parseTraceTime(createdAt: string): Date {
  return new Date(`${createdAt.replace(' ', 'T')}Z`);
}

function parseIds(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function parseAdherence(metadata: string | null): { turn: number; reason: string } | null {
  if (!metadata) return null;
  try {
    const adherence = JSON.parse(metadata)?.adherence;
    if (adherence && Number.isFinite(adherence.turn) && typeof adherence.reason === 'string') {
      return { turn: adherence.turn, reason: adherence.reason };
    }
  } catch { /* fall through to reconstruction */ }
  return null;
}

/**
 * Past Claude hook traces, rebuilt into replayable turns. The adherence turn
 * and reason come from the prompt event the hook stored right after retrieval;
 * prompts too short to be stored fall back to shouldRunAdherenceCheck.
 */
export function loadReplayTurns(db: Database.Database, limit?: number): ReplayTurn[] {
  const traces = db.prepare(`
    SELECT trace_id, session_id, query_text, raw_query_text, selected_event_ids, created_at
    FROM retrieval_traces
    WHERE trigger_type = 'user_prompt' AND delivery_client = 'claude-hook'
      AND presentation_mode = 'evidence' AND session_id IS NOT NULL
      AND raw_query_text IS NOT NULL AND length(raw_query_text) > 0
    ORDER BY created_at, trace_id
  `).all() as TraceRow[];
  const step = limit && traces.length > limit ? traces.length / limit : 1;
  const sampled = step === 1 ? traces : Array.from({ length: limit! }, (_, i) => traces[Math.floor(i * step)]);

  const promptEvent = db.prepare(`
    SELECT id, content, timestamp, metadata FROM events
    WHERE session_id = ? AND event_type = 'user_prompt' AND content = ? AND timestamp >= ?
    ORDER BY timestamp LIMIT 1
  `);
  const previousPrompt = db.prepare(`
    SELECT id, content, timestamp, metadata FROM events
    WHERE session_id = ? AND event_type = 'user_prompt' AND timestamp < ?
    ORDER BY timestamp DESC LIMIT 1
  `);
  const priorPromptCount = db.prepare(`
    SELECT count(*) AS n FROM events WHERE session_id = ? AND event_type = 'user_prompt' AND timestamp < ?
  `);
  // Stop keeps the previous human turn's snippet across replies to automated
  // notifications, so those replies are not the snippet the hook read.
  const lastResponse = db.prepare(`
    SELECT id, content, timestamp, metadata FROM events
    WHERE session_id = ? AND event_type = 'agent_response' AND timestamp < ?
      AND coalesce(json_extract(metadata, '$.turnTrigger'), 'user') = 'user'
    ORDER BY timestamp DESC LIMIT 1
  `);
  const laterResponses = db.prepare(`
    SELECT id, content, timestamp, metadata FROM events
    WHERE session_id = ? AND event_type = 'agent_response' AND timestamp > ?
    ORDER BY timestamp
  `);

  return sampled.map((trace) => {
    const sessionId = trace.session_id!;
    const asOf = parseTraceTime(trace.created_at);
    const asOfIso = asOf.toISOString();
    const prompt = trace.raw_query_text!;
    const stored = promptEvent.get(sessionId, prompt, asOfIso) as EventRow | undefined;
    const previous = previousPrompt.get(sessionId, asOfIso) as EventRow | undefined;
    const adherence = parseAdherence(stored?.metadata ?? null);
    // Prompts too short to be stored still advance the hook's turn count, so
    // the previous stored prompt's own turn is a closer floor than a row count.
    const previousTurn = parseAdherence(previous?.metadata ?? null)?.turn;
    const currentTurn = adherence?.turn
      ?? (previousTurn !== undefined ? previousTurn + 1 : (priorPromptCount.get(sessionId, asOfIso) as { n: number }).n + 1);
    const adherenceDecision: AdherenceDecision = adherence
      ? { run: true, reason: adherence.reason }
      : shouldRunAdherenceCheck(currentTurn, prompt, {
          sessionId,
          turnCount: currentTurn - 1,
          lastCheckedTurn: currentTurn - 1,
          lastPrompt: previous?.content ?? '',
          updatedAt: asOfIso
        });
    const last = lastResponse.get(sessionId, asOfIso) as EventRow | undefined;
    // The evaluator compares responses after delivery. The prompt row is stored
    // after retrieval and before the envelope is written; without it, skip the
    // trace's whole second so an earlier response in that second is not counted.
    const responsesAfter = stored?.timestamp ?? new Date(asOf.getTime() + 1000).toISOString();
    const lastAssistantSnippet = last && asOf.getTime() - new Date(last.timestamp).getTime() <= LAST_SNIPPET_MAX_AGE_MS
      ? last.content.slice(0, LAST_SNIPPET_CHARS)
      : null;
    return {
      traceId: trace.trace_id,
      sessionId,
      asOf,
      prompt,
      currentTurn,
      adherenceDecision,
      adherenceReconstructed: !adherence,
      previousUserPrompt: previous?.content ?? null,
      lastAssistantSnippet,
      responses: (laterResponses.all(sessionId, responsesAfter) as EventRow[]).map((row) => ({ id: row.id, content: row.content })),
      historicalQueryText: trace.query_text,
      historicalSelectedIds: parseIds(trace.selected_event_ids)
    };
  });
}

function before(asOf: Date) {
  return (event: MemoryEvent) => event.timestamp.getTime() < asOf.getTime();
}

type EventReader = Partial<Pick<SQLiteEventStore,
  'keywordSearch' | 'searchGraduatedEvidence' | 'getEventsByTurn' | 'getEvent' | 'getEvents' | 'getRecentEvents' | 'getSessionEvents'
>>;

/**
 * An event store that hides events at or after asOf. Ranked and recency reads
 * are over-fetched by the number of later events, which guarantees the first
 * `limit` visible rows are the ones the hook would have received.
 */
export function timeBoundEventStore<T extends EventReader>(store: T, asOf: Date, laterEventCount: number): T {
  const visible = before(asOf);
  const bounded = Object.create(store) as T;
  const reader: EventReader = bounded;
  if (store.keywordSearch) {
    reader.keywordSearch = async (query, limit = 10, options) =>
      (await store.keywordSearch!(query, limit + laterEventCount, options))
        .filter((row) => visible(row.event))
        .slice(0, limit);
  }
  if (store.searchGraduatedEvidence) {
    reader.searchGraduatedEvidence = async (query, limit = 10) =>
      (await store.searchGraduatedEvidence!(query, limit + laterEventCount))
        .filter((row) => visible(row.event))
        .slice(0, limit);
  }
  if (store.getRecentEvents) {
    reader.getRecentEvents = async (limit = 100, options) =>
      (await store.getRecentEvents!(limit + laterEventCount, options)).filter(visible).slice(0, limit);
  }
  if (store.getEvent) {
    reader.getEvent = async (id, options) => {
      const event = await store.getEvent!(id, options);
      return event && visible(event) ? event : null;
    };
  }
  if (store.getEvents) reader.getEvents = async (ids, options) => (await store.getEvents!(ids, options)).filter(visible);
  if (store.getSessionEvents) {
    reader.getSessionEvents = async (sessionId, options) => (await store.getSessionEvents!(sessionId, options)).filter(visible);
  }
  if (store.getEventsByTurn) reader.getEventsByTurn = async (turnId) => (await store.getEventsByTurn!(turnId)).filter(visible);
  return bounded;
}

export function timeBoundVectorStore(vectorStore: VectorStore, asOf: Date, laterEventCount: number): VectorStore {
  const bounded = Object.create(vectorStore) as VectorStore;
  bounded.search = async (queryVector, options = {}) => {
    const limit = options.limit ?? 5;
    return (await vectorStore.search(queryVector, { ...options, limit: limit + laterEventCount }))
      .filter((result) => new Date(result.timestamp).getTime() < asOf.getTime())
      .slice(0, limit);
  };
  return bounded;
}

/** The service's retriever, whose stores are swapped per turn. */
function retrieverStores(service: MemoryService): { eventStore: EventReader; vectorStore: VectorStore } {
  return (service as unknown as {
    retrievalOrchestrator: { deps: { retriever: { eventStore: EventReader; vectorStore: VectorStore } } };
  }).retrievalOrchestrator.deps.retriever;
}

function boundExpansion(expansion: RetrievalDisclosureExpansion | null, asOf: Date): RetrievalDisclosureExpansion | null {
  if (!expansion) return null;
  const visible = (envelope: { metadata?: Record<string, unknown> }) => {
    const timestamp = envelope.metadata?.timestamp;
    return typeof timestamp !== 'string' || new Date(timestamp).getTime() < asOf.getTime();
  };
  return {
    ...expansion,
    surroundingFacts: expansion.surroundingFacts?.filter(visible),
    summaries: expansion.summaries?.filter(visible)
  };
}

interface ReplaySources {
  db: Database.Database;
  store: SQLiteEventStore;
  service: MemoryService;
  projectHash: string;
  semantic: 'retriever' | 'off';
  semanticCache: Map<string, { memories: SemanticMemory[]; dropped: number }>;
}

function selectionDeps(sources: ReplaySources, turn: ReplayTurn, stats: { semanticDropped: number }): HookSelectionDeps {
  const asOfIso = turn.asOf.toISOString();
  const laterEventCount = (sources.db.prepare('SELECT count(*) AS n FROM events WHERE timestamp >= ?')
    .get(asOfIso) as { n: number }).n;
  const store = timeBoundEventStore(sources.store, turn.asOf, laterEventCount);
  const queryService = new MemoryQueryService(() => store.initialize(), store);
  const memoryService = {
    keywordSearch: (query, options) => queryService.keywordSearch(query, options),
    searchGraduatedEvidence: (query, limit) => queryService.searchGraduatedEvidence(query, limit),
    listProjectLessonInjections: async (actorId, limit) =>
      // A lesson saved later in the same conversation would otherwise answer
      // its own originating prompt.
      (await queryService.listProjectLessonInjections(sources.projectHash, actorId, limit))
        .filter((injection) => injection.value.createdAt.getTime() < turn.asOf.getTime()),
    expandDisclosure: async (resultId, options) =>
      boundExpansion(await sources.service.expandDisclosure(resultId, options), turn.asOf),
    getEventsByTurn: (turnId) => queryService.getEventsByTurn(turnId)
  } as HookSelectionMemoryService;

  const retrieveSemantic: HookSelectionDeps['retrieveSemantic'] = async (request) => {
    if (sources.semantic === 'off') return [];
    const key = `${turn.traceId}\u0000${request.prompt}`;
    let cached = sources.semanticCache.get(key);
    if (!cached) {
      // Same options as the daemon, with the retriever's own stores bounded
      // for the call so fallback and ranking never see a later event.
      const retriever = retrieverStores(sources.service);
      const original = { eventStore: retriever.eventStore, vectorStore: retriever.vectorStore };
      retriever.eventStore = timeBoundEventStore(original.eventStore, turn.asOf, laterEventCount);
      retriever.vectorStore = timeBoundVectorStore(original.vectorStore, turn.asOf, laterEventCount);
      let result: Awaited<ReturnType<MemoryService['retrieveMemories']>>;
      try {
        result = await sources.service.retrieveMemories(request.prompt, {
          topK: request.topK,
          minScore: request.minScore,
          sessionId: turn.sessionId,
          intentRewrite: true,
          adaptiveRerank: true,
          projectScopeMode: 'strict',
          recordTrace: false
        });
      } finally {
        retriever.eventStore = original.eventStore;
        retriever.vectorStore = original.vectorStore;
      }
      const visible = result.memories.filter((memory) => before(turn.asOf)(memory.event));
      cached = {
        memories: visible.map((memory) => ({
          type: memory.event.eventType,
          content: memory.event.content,
          id: memory.event.id,
          score: memory.score,
          sessionId: memory.event.sessionId
        })),
        dropped: result.memories.length - visible.length
      };
      sources.semanticCache.set(key, cached);
    }
    stats.semanticDropped += cached.dropped;
    return cached.memories;
  };

  return { memoryService, retrieveSemantic };
}

async function withFlags<T>(flags: ReplayArm['flags'], run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(flags).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(flags)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function replayTurn(sources: ReplaySources, turn: ReplayTurn): Promise<ReplayTurnResult> {
  const stats = { semanticDropped: 0 };
  const retrievalQuery = buildRetrievalQuery({
    prompt: turn.prompt,
    currentTurn: turn.currentTurn,
    previousUserPrompt: turn.previousUserPrompt,
    lastAssistantSnippet: turn.currentTurn > 1 ? turn.lastAssistantSnippet : null,
    adherenceDecision: turn.adherenceDecision
  });
  const selection = await selectHookInjection(selectionDeps(sources, turn, stats), {
    prompt: turn.prompt,
    retrievalQuery
  });
  const injections = selection.injectableMemories
    .filter((memory): memory is typeof memory & { id: string } => Boolean(memory.id))
    .map((memory) => ({
      kind: hookMemoryRefKind(memory),
      id: memory.id,
      overlap: turn.responses.length > 0
        ? computeMemoryUsageEvidence(memoryEvidencePreview(memory, retrievalQuery), turn.responses).contentOverlapScore
        : null
    }));
  return { traceId: turn.traceId, retrievalQuery, injections, semanticDroppedAsFuture: stats.semanticDropped };
}

/** Deterministic PRNG so the bootstrap interval is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapMeanCi(perTurn: number[][]): [number, number] | null {
  const turns = perTurn.filter((scores) => scores.length > 0);
  if (turns.length < 2) return null;
  const random = mulberry32(119);
  const means: number[] = [];
  for (let sample = 0; sample < BOOTSTRAP_SAMPLES; sample++) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < turns.length; i++) {
      const scores = turns[Math.floor(random() * turns.length)];
      for (const score of scores) sum += score;
      count += scores.length;
    }
    means.push(sum / count);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(BOOTSTRAP_SAMPLES * 0.025)], means[Math.floor(BOOTSTRAP_SAMPLES * 0.975)]];
}

export function summarizeReplay(turns: ReplayTurn[], results: ReplayTurnResult[]): ReplayMetrics {
  const byTrace = new Map(results.map((result) => [result.traceId, result]));
  const rows = turns.map((turn) => ({ turn, result: byTrace.get(turn.traceId)! }));
  const withResponses = rows.filter(({ turn }) => turn.responses.length > 0);
  const injectedTurns = withResponses.filter(({ result }) => result.injections.length > 0);
  const perTurn = injectedTurns.map(({ result }) => result.injections
    .map((injection) => injection.overlap)
    .filter((overlap): overlap is number => overlap !== null));
  const scores = perTurn.flat();
  return {
    turns: rows.length,
    turnsWithResponses: withResponses.length,
    turnsWithInjection: injectedTurns.length,
    injectedMemories: rows.reduce((sum, { result }) => sum + result.injections.length, 0),
    scoredMemories: scores.length,
    meanOverlap: scores.length > 0 ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
    meanOverlapCi: bootstrapMeanCi(perTurn),
    groundedMemoryRate: scores.length > 0 ? scores.filter((score) => score >= GROUNDED_OVERLAP).length / scores.length : null,
    groundedTurnRate: injectedTurns.length > 0
      ? perTurn.filter((turnScores) => turnScores.some((score) => score >= GROUNDED_OVERLAP)).length / injectedTurns.length
      : null
  };
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

export async function runHookGroundingReplay(options: HookGroundingReplayOptions): Promise<ReplayReport> {
  const dbPath = path.join(options.storagePath, 'events.sqlite');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const store = new SQLiteEventStore(dbPath, { readonly: true });
  // Same read-only configuration as the semantic daemon.
  const service = new MemoryService({
    storagePath: options.storagePath,
    projectHash: options.projectHash,
    readOnly: true,
    analyticsEnabled: false,
    sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG
  });
  const sources: ReplaySources = {
    db,
    store,
    service,
    projectHash: options.projectHash,
    semantic: options.semantic,
    semanticCache: new Map()
  };
  try {
    const turns = loadReplayTurns(db, options.limit);
    const arms = options.arms ?? DEFAULT_REPLAY_ARMS;
    const armResults: Array<{ arm: ReplayArm; results: ReplayTurnResult[] }> = [];
    for (const arm of arms) {
      const results: ReplayTurnResult[] = [];
      for (const turn of turns) {
        results.push(await withFlags(arm.flags, () => replayTurn(sources, turn)));
      }
      armResults.push({ arm, results });
    }

    const current = armResults[0].results;
    const uninjected = turns.filter((turn) => turn.historicalSelectedIds.length === 0);
    const reports = armResults.map(({ arm, results }) => ({
      arm: arm.name,
      all: summarizeReplay(turns, results),
      historicallyUninjected: summarizeReplay(uninjected, results),
      queryChangedVsCurrent: results.filter((result, i) => result.retrievalQuery !== current[i].retrievalQuery).length,
      selectionChangedVsCurrent: results.filter((result, i) => !sameIds(
        result.injections.map((injection) => injection.id),
        current[i].injections.map((injection) => injection.id)
      )).length,
      results
    }));

    // Fidelity of the first arm against what the hook recorded at the time.
    // Mismatches come from the approximations listed in the report.
    const baselineIsCurrent = arms[0].flags[FTS_ABSOLUTE_FLAG] === undefined
      && arms[0].flags[QUERY_SANITIZER_FLAG] === undefined;
    return {
      storeLabel: options.storeLabel ?? 'store copy',
      semantic: options.semantic,
      turns: turns.length,
      queryReproducedRate: baselineIsCurrent && turns.length > 0
        ? turns.filter((turn, i) => redactForStorage(current[i].retrievalQuery) === turn.historicalQueryText).length / turns.length
        : null,
      selectionReproducedRate: baselineIsCurrent && turns.length > 0
        ? turns.filter((turn, i) => sameIds(current[i].injections.map((injection) => injection.id), turn.historicalSelectedIds)).length / turns.length
        : null,
      adherenceReconstructedTurns: turns.filter((turn) => turn.adherenceReconstructed).length,
      semanticDroppedAsFuture: current.reduce((sum, result) => sum + result.semanticDroppedAsFuture, 0),
      arms: reports,
      caveats: REPLAY_CAVEATS
    };
  } finally {
    db.close();
    await store.close();
    await service.shutdown();
  }
}

export interface HookReplayFixture {
  name: string;
  projectHash: string;
  events: Array<{
    key: string;
    sessionId: string;
    eventType: MemoryEvent['eventType'];
    timestamp: string;
    content: string;
    metadata?: Record<string, unknown>;
  }>;
  lessons?: Array<{
    lessonId: string;
    name: string;
    trigger: string;
    steps: string[];
    confidence: number;
    createdAt: string;
  }>;
  traces: Array<{
    traceId: string;
    sessionId: string;
    createdAt: string;
    rawQueryText: string;
    queryText: string;
    selectedKeys: string[];
  }>;
}

/**
 * Materialize a fixture as a real project store (SQLite + FTS5), so CI runs the
 * same store-copy replay path as a local measurement. Returns event ids by
 * fixture key.
 */
export async function buildFixtureStore(fixture: HookReplayFixture, storagePath: string): Promise<Map<string, string>> {
  const dbPath = path.join(storagePath, 'events.sqlite');
  const store = new SQLiteEventStore(dbPath);
  const idByKey = new Map<string, string>();
  for (const event of fixture.events) {
    const result = await store.append({
      eventType: event.eventType,
      sessionId: event.sessionId,
      timestamp: new Date(event.timestamp),
      content: event.content,
      metadata: event.metadata
    });
    if (!result.success || !result.eventId) throw new Error(`fixture event ${event.key} was not stored`);
    idByKey.set(event.key, result.eventId);
  }
  await store.close();

  const db = new Database(dbPath);
  try {
    const insertLesson = db.prepare(`
      INSERT INTO memory_lessons (lesson_id, project_hash, name, trigger, steps_json, confidence, source_class, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'curated', ?, ?)
    `);
    for (const lesson of fixture.lessons ?? []) {
      insertLesson.run(lesson.lessonId, fixture.projectHash, lesson.name, lesson.trigger,
        JSON.stringify(lesson.steps), lesson.confidence, lesson.createdAt, lesson.createdAt);
    }
    const insertTrace = db.prepare(`
      INSERT INTO retrieval_traces (trace_id, session_id, project_hash, query_text, raw_query_text, strategy,
        selected_event_ids, presentation_mode, trigger_type, delivery_client, created_at)
      VALUES (?, ?, ?, ?, ?, 'hybrid', ?, 'evidence', 'user_prompt', 'claude-hook', ?)
    `);
    for (const trace of fixture.traces) {
      const selected = trace.selectedKeys.map((key) => {
        const id = idByKey.get(key);
        if (!id) throw new Error(`fixture trace ${trace.traceId} selects unknown event ${key}`);
        return id;
      });
      insertTrace.run(trace.traceId, trace.sessionId, fixture.projectHash, trace.queryText, trace.rawQueryText,
        JSON.stringify(selected), trace.createdAt);
    }
  } finally {
    db.close();
  }
  return idByKey;
}

const REPLAY_CAVEATS = [
  '**Counterfactual bias.** The responses scored here were written after the hook injected its *historical* selection, so the agent could copy from those memories and not from others. Overlap therefore favors whatever the historical selection contained: the `current` arm is advantaged and a changed arm is understated. The "historically uninjected" rows (turns where the hook injected nothing at the time) carry no such bias and are the fairer comparison.',
  '**Other approximations.** FTS bm25 statistics, memory levels, lesson revisions, and the adaptive rerank weights are those of the store copy, not of each trace time. The semantic lane runs in-process with the daemon options instead of through the daemon. Prompts are the redacted stored text. Lexical overlap also rewards responses that merely repeat query terms.'
];

function fmt(value: number | null, digits = 3): string {
  return value === null ? 'n/a' : value.toFixed(digits);
}

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function metricsRow(name: string, m: ReplayMetrics): string {
  const ci = m.meanOverlapCi ? `${fmt(m.meanOverlapCi[0])}–${fmt(m.meanOverlapCi[1])}` : 'n/a';
  return `| ${name} | ${m.turnsWithResponses} | ${m.turnsWithInjection} | ${m.scoredMemories} | ${fmt(m.meanOverlap)} | ${ci} | ${pct(m.groundedMemoryRate)} | ${pct(m.groundedTurnRate)} |`;
}

/** Aggregate-only report: no prompt, memory, or response text and no ids. */
export function formatReplayReport(report: ReplayReport): string {
  const header = '| arm | turns (with responses) | turns injected | memories scored | mean overlap | 95% CI | grounded memories | turns with a grounded memory |';
  const divider = '|---|---:|---:|---:|---:|---|---:|---:|';
  const lines = [
    `# Hook-path grounding replay: ${report.storeLabel}`,
    '',
    `- Turns replayed: ${report.turns} (semantic lane: ${report.semantic})`,
    `- Fidelity of \`current\` vs. the recorded trace: query reproduced ${pct(report.queryReproducedRate)}, selection reproduced ${pct(report.selectionReproducedRate)}`,
    `- Turns whose adherence was inferred (prompt not stored): ${report.adherenceReconstructedTurns}`,
    `- Semantic results later than the trace (time-bound check, expected 0): ${report.semanticDroppedAsFuture}`,
    '',
    '## All turns',
    '',
    header,
    divider,
    ...report.arms.map((arm) => metricsRow(arm.arm, arm.all)),
    '',
    '## Historically uninjected turns',
    '',
    header,
    divider,
    ...report.arms.map((arm) => metricsRow(arm.arm, arm.historicallyUninjected)),
    '',
    '## Change vs. current',
    '',
    '| arm | query changed | selection changed |',
    '|---|---:|---:|',
    ...report.arms.map((arm) => `| ${arm.arm} | ${arm.queryChangedVsCurrent} | ${arm.selectionChangedVsCurrent} |`),
    '',
    ...report.caveats.flatMap((note) => [note, ''])
  ];
  return lines.join('\n');
}
