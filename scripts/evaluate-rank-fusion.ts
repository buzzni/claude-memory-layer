#!/usr/bin/env tsx
/**
 * Offline ranking-arm comparison on a qrels fixture (T12, #141).
 *
 *   npm run eval:rank-fusion -- --fixture <replay-or-session-qrels.json> --model-cache <dir> [--reranker mmarco-minilm|bge-m3|none]
 *
 * The fixture's memories go into a throwaway SQLite store (the production FTS
 * lane) and are embedded with the production embedder (the vector lane).
 * `current` is the production retriever called with the semantic daemon's
 * options. Two comparisons follow, for each query with expected ids:
 *
 * - Pipeline comparison: arms that build their own candidates. vector and
 *   keyword are each lane alone (top --pool); rrf fuses the two lanes
 *   (reciprocal rank fusion, k=60); rrf+ce reranks the rrf head with a local
 *   cross-encoder. These differ from current in candidate generation and
 *   filtering as well as in order.
 * - Common-pool comparison: order only. The pool is the retriever's own
 *   filtered candidate list (its debug candidates, up to max(3*topK, 20)).
 *   rrf orders that pool by RRF over each candidate's global vector rank and
 *   FTS rank (top 1000); rrf+ce reranks the head of that order.
 *
 * Both are scored at each query's own budget, the length of current's list
 * (k varies per query; nDCG is normalized at that k). The pipeline arms are
 * also scored at fixed k. Queries without expected ids (no-match traps) count
 * forbidden memories inside current's budget.
 *
 * Output is aggregate-only: metrics, latency, counts, model hashes. No query,
 * memory or id. --model-cache must already hold the models unless
 * --download-models is passed.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createRetrievalServices } from '../src/core/engine/retrieval-services.js';
import { Matcher } from '../src/core/matcher.js';
import { reciprocalRankFusion, rerankHead } from '../src/core/rank-fusion.js';
import {
  latencySummary,
  summarizeAtBaselineBudget,
  summarizeRankArms,
  type BudgetSummary,
  type RankArmQuery,
  type RankArmRun,
  type RankArmSummary
} from '../src/core/rank-fusion-eval.js';
import { SQLiteEventStore } from '../src/core/sqlite-event-store.js';
import type { Embedder } from '../src/core/embedder.js';
import type { MemoryEvent } from '../src/core/types.js';
import type { SearchResult, VectorStore } from '../src/core/vector-store.js';
import { DEFAULT_EMBEDDING_MODEL } from '../src/extensions/vector/embedder.js';
import { CROSS_ENCODER_PRESETS, loadCrossEncoder, modelArtifactSha256, type CrossEncoder } from './cross-encoder-reranker.js';
import { buildProvenance, pathRef, redactPaths, warnProvenance } from './eval-provenance.mjs';

interface FixtureMemory {
  id: string;
  content: string;
  searchContent?: string;
  sourceSessionId?: string;
  timestamp?: string;
  eventType?: MemoryEvent['eventType'];
}

interface FixtureQuery {
  queryId: string;
  query: string;
  expectedIds: string[];
  expectedRelevance?: Record<string, number>;
  expectation?: 'match' | 'no_match';
  forbiddenIds?: string[];
}

interface Fixture {
  name: string;
  ks?: number[];
  queries: FixtureQuery[];
  memories: FixtureMemory[];
}

interface Args {
  fixturePath: string;
  modelCache: string;
  label?: string;
  reranker: string;
  downloadModels: boolean;
  pool: number;
  rerankDepth: number;
  topK: number;
  minScore: number;
  repeat: number;
  limit?: number;
  sweep: boolean;
  format: 'json' | 'markdown';
}

class CliError extends Error {}

const PIPELINE_ARMS = ['current', 'vector', 'keyword', 'rrf', 'rrf+ce'] as const;
const POOL_ARMS = ['current', 'rrf', 'rrf+ce'] as const;
/** FTS depth used to give common-pool candidates their keyword-lane rank. */
const FTS_RANK_DEPTH = 1000;
const SWEEP_SIZES = [5, 10, 20, 40];
const SWEEP_QUERIES = 30;

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> & Pick<Args, 'reranker' | 'downloadModels' | 'pool' | 'rerankDepth' | 'topK' | 'minScore' | 'repeat' | 'sweep' | 'format'> = {
    reranker: 'mmarco-minilm', downloadModels: false, pool: 30, rerankDepth: 20, topK: 10, minScore: 0.4, repeat: 2, sweep: false, format: 'markdown'
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new CliError(`${arg} needs a value`);
      return next;
    };
    const positive = () => {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1) throw new CliError(`${arg} must be a positive integer`);
      return n;
    };
    if (arg === '--fixture') args.fixturePath = value();
    else if (arg === '--model-cache') args.modelCache = value();
    else if (arg === '--label') args.label = value();
    else if (arg === '--reranker') args.reranker = value();
    else if (arg === '--download-models') args.downloadModels = true;
    else if (arg === '--pool') args.pool = positive();
    else if (arg === '--rerank-depth') args.rerankDepth = positive();
    else if (arg === '--top-k') args.topK = positive();
    else if (arg === '--min-score') args.minScore = Number(value());
    else if (arg === '--repeat') args.repeat = positive();
    else if (arg === '--limit') args.limit = positive();
    else if (arg === '--sweep') args.sweep = true;
    else if (arg === '--format') {
      const format = value();
      if (format !== 'json' && format !== 'markdown') throw new CliError('--format must be json or markdown');
      args.format = format;
    } else throw new CliError(`unknown argument: ${arg}`);
  }
  if (!args.fixturePath || !args.modelCache) throw new CliError('--fixture and --model-cache are required');
  if (args.reranker !== 'none' && !CROSS_ENCODER_PRESETS[args.reranker]) {
    throw new CliError(`--reranker must be none or one of ${Object.keys(CROSS_ENCODER_PRESETS).join(', ')}`);
  }
  return args as Args;
}

/** Exact cosine search over in-memory embeddings: what LanceDB returns for a small table. */
class MemoryVectorStore {
  constructor(private readonly rows: Array<Omit<SearchResult, 'score'> & { vector: number[] }>) {}

  async search(queryVector: number[], options: { limit?: number; minScore?: number; sessionId?: string } = {}): Promise<SearchResult[]> {
    return this.rows
      .filter((row) => !options.sessionId || row.sessionId === options.sessionId)
      .map(({ vector, ...row }) => ({ ...row, score: dot(queryVector, vector) }))
      .filter((row) => row.score >= (options.minScore ?? 0))
      .sort((a, b) => b.score - a.score || a.eventId.localeCompare(b.eventId))
      .slice(0, options.limit ?? 5);
  }

  async count(): Promise<number> {
    return this.rows.length;
  }
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * (b[i] ?? 0);
  return sum;
}

async function loadEmbedder(cacheDir: string, allowDownload: boolean): Promise<Embedder> {
  const { Embedder, normalizeTransformersNamespace, resolveTransformersModuleSpecifier } = await import('../src/extensions/vector/embedder.js');
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
  const transformers = normalizeTransformersNamespace(await dynamicImport(resolveTransformersModuleSpecifier()) as never) as unknown as {
    pipeline: unknown;
    env: { cacheDir?: string; allowRemoteModels?: boolean; allowLocalModels?: boolean };
  };
  transformers.env.cacheDir = cacheDir;
  transformers.env.allowRemoteModels = allowDownload;
  transformers.env.allowLocalModels = true;
  return new Embedder(undefined, { loadPipeline: async () => transformers.pipeline as never }) as unknown as Embedder;
}

interface Corpus {
  store: SQLiteEventStore;
  vectorStore: MemoryVectorStore;
  fixtureIdByEventId: Map<string, string>;
  contentByEventId: Map<string, string>;
  notStored: number;
  embedMs: number;
}

async function buildCorpus(fixture: Fixture, dir: string, embedder: Embedder): Promise<Corpus> {
  const store = new SQLiteEventStore(path.join(dir, 'events.sqlite'));
  const fixtureIdByEventId = new Map<string, string>();
  const contentByEventId = new Map<string, string>();
  const stored: Array<{ eventId: string; memory: FixtureMemory; event: Omit<SearchResult, 'score' | 'id' | 'eventId'> }> = [];
  let notStored = 0;
  for (const [index, memory] of fixture.memories.entries()) {
    const content = memory.searchContent?.trim() || memory.content;
    const sessionId = memory.sourceSessionId ?? 'fixture';
    const eventType = memory.eventType ?? 'agent_response';
    const timestamp = memory.timestamp ? new Date(memory.timestamp) : new Date(Date.UTC(2026, 0, 1, 0, 0, index));
    const result = await store.append({ eventType, sessionId, timestamp, content });
    // Identical content dedupes onto the first row; the later fixture id is unreachable.
    if (!result.success || !result.eventId || fixtureIdByEventId.has(result.eventId)) {
      notStored += 1;
      continue;
    }
    fixtureIdByEventId.set(result.eventId, memory.id);
    contentByEventId.set(result.eventId, content);
    stored.push({ eventId: result.eventId, memory, event: { content, sessionId, eventType, timestamp: timestamp.toISOString() } });
  }
  const startedAt = performance.now();
  const vectors = await embedder.embedBatch(stored.map(({ event }) => event.content));
  const embedMs = performance.now() - startedAt;
  const vectorStore = new MemoryVectorStore(stored.map(({ eventId, event }, i) => ({
    id: `vector-${eventId}`, eventId, ...event, vector: vectors[i].vector
  })));
  return { store, vectorStore, fixtureIdByEventId, contentByEventId, notStored, embedMs };
}

interface QueryTiming {
  currentMs: number;
  vectorLaneMs: number;
  keywordLaneMs: number;
  rrfMs: number;
  rerankMs: number | null;
  rerankCpuMs: number | null;
}

interface PassResult {
  pipeline: RankArmRun[];
  pool: RankArmRun[];
  timings: QueryTiming[];
  poolSizes: number[];
  /** Queries whose list from current is not the head of its own debug candidates. */
  currentNotPoolHead: number;
}

/** Cross-encoder scores for one query, cached by event id so both comparisons share them. */
function scoreCache(reranker: CrossEncoder, query: string, contentOf: (id: string) => string) {
  const scores = new Map<string, number>();
  return async (ids: string[]): Promise<number[]> => {
    const missing = ids.filter((id) => !scores.has(id));
    if (missing.length > 0) {
      const fresh = await reranker.score(query, missing.map(contentOf));
      missing.forEach((id, i) => scores.set(id, fresh[i]));
    }
    return ids.map((id) => scores.get(id)!);
  };
}

async function runPass(
  queries: FixtureQuery[],
  corpus: Corpus,
  embedder: Embedder,
  reranker: CrossEncoder | null,
  args: Args
): Promise<PassResult> {
  const services = createRetrievalServices({
    initialize: () => corpus.store.initialize(),
    eventStore: corpus.store as never,
    vectorStore: corpus.vectorStore as unknown as VectorStore,
    embedder,
    matcher: new Matcher(),
    getProjectHash: () => null,
    hasSharedStore: () => false
  });
  const toFixtureIds = (eventIds: string[]) => eventIds
    .map((id) => corpus.fixtureIdByEventId.get(id))
    .filter((id): id is string => Boolean(id));
  const corpusSize = await corpus.vectorStore.count();
  const result: PassResult = { pipeline: [], pool: [], timings: [], poolSizes: [], currentNotPoolHead: 0 };

  for (const query of queries) {
    let startedAt = performance.now();
    // The semantic daemon's options (semantic-daemon.ts), minus the session filter.
    const current = await services.retrievalOrchestrator.retrieveMemories(query.query, {
      topK: args.topK,
      minScore: args.minScore,
      intentRewrite: true,
      adaptiveRerank: true,
      projectScopeMode: 'strict',
      recordTrace: false,
      includeShared: false
    });
    const currentMs = performance.now() - startedAt;
    const currentIds = current.memories.map((memory) => memory.event.id);

    startedAt = performance.now();
    const queryVector = (await embedder.embed(query.query)).vector;
    const vectorLane = (await corpus.vectorStore.search(queryVector, { limit: args.pool })).map((row) => row.eventId);
    const vectorLaneMs = performance.now() - startedAt;

    startedAt = performance.now();
    const keywordLane = (await corpus.store.keywordSearch(query.query, args.pool)).map((row) => row.event.id);
    const keywordLaneMs = performance.now() - startedAt;

    startedAt = performance.now();
    const fused = reciprocalRankFusion([vectorLane, keywordLane]);
    const rrfMs = performance.now() - startedAt;

    // Common pool: the retriever's filtered candidates in its order, ranked again by
    // RRF over each candidate's rank in the whole vector lane and a deep FTS lane.
    const pool = [...new Set((current.candidateDebug ?? []).map((detail) => detail.eventId))];
    const inPool = new Set(pool);
    const vectorAll = (await corpus.vectorStore.search(queryVector, { limit: corpusSize })).map((row) => row.eventId);
    const keywordDeep = (await corpus.store.keywordSearch(query.query, FTS_RANK_DEPTH)).map((row) => row.event.id);
    const poolFused = reciprocalRankFusion([vectorAll, keywordDeep]).filter((id) => inPool.has(id));
    if (currentIds.some((id, i) => pool[i] !== id)) result.currentNotPoolHead += 1;

    const pipelineRun: RankArmRun = {
      current: toFixtureIds(currentIds),
      vector: toFixtureIds(vectorLane),
      keyword: toFixtureIds(keywordLane),
      rrf: toFixtureIds(fused)
    };
    const poolRun: RankArmRun = { current: toFixtureIds(currentIds), rrf: toFixtureIds(poolFused) };

    let rerankMs: number | null = null;
    let rerankCpuMs: number | null = null;
    if (reranker) {
      const score = scoreCache(reranker, query.query, (id) => corpus.contentByEventId.get(id) ?? '');
      const head = fused.slice(0, args.rerankDepth);
      if (head.length > 0) {
        // Timed on the pipeline head, which the cache has not seen: a full call.
        const cpuBefore = process.cpuUsage();
        startedAt = performance.now();
        const scores = await score(head);
        rerankMs = performance.now() - startedAt;
        const cpu = process.cpuUsage(cpuBefore);
        rerankCpuMs = (cpu.user + cpu.system) / 1000;
        pipelineRun['rrf+ce'] = toFixtureIds(rerankHead(fused, scores));
      } else {
        pipelineRun['rrf+ce'] = [];
      }
      const poolHead = poolFused.slice(0, args.rerankDepth);
      poolRun['rrf+ce'] = toFixtureIds(poolHead.length > 0 ? rerankHead(poolFused, await score(poolHead)) : poolFused);
    }

    result.pipeline.push(pipelineRun);
    result.pool.push(poolRun);
    result.poolSizes.push(pool.length);
    result.timings.push({ currentMs, vectorLaneMs, keywordLaneMs, rrfMs, rerankMs, rerankCpuMs });
  }
  return result;
}

/** Cross-encoder time per candidate count, on real candidate texts from the pool. */
async function rerankSweep(queries: FixtureQuery[], corpus: Corpus, embedder: Embedder, reranker: CrossEncoder) {
  const rows: Record<number, ReturnType<typeof latencySummary> & { cpuMsMean: number | null }> = {};
  for (const size of SWEEP_SIZES) {
    const times: number[] = [];
    let cpuTotal = 0;
    for (const query of queries.slice(0, SWEEP_QUERIES)) {
      const vector = (await embedder.embed(query.query)).vector;
      const docs = (await corpus.vectorStore.search(vector, { limit: size })).map((row) => row.content);
      if (docs.length < size) continue;
      const cpuBefore = process.cpuUsage();
      const startedAt = performance.now();
      await reranker.score(query.query, docs);
      times.push(performance.now() - startedAt);
      const cpu = process.cpuUsage(cpuBefore);
      cpuTotal += (cpu.user + cpu.system) / 1000;
    }
    rows[size] = { ...latencySummary(times), cpuMsMean: times.length ? cpuTotal / times.length : null };
  }
  return rows;
}

interface PassSummary {
  pipeline: RankArmSummary;
  pipelineAtBudget: BudgetSummary;
  poolAtBudget: BudgetSummary;
}

function summarizePass(queries: RankArmQuery[], pass: PassResult, ks: number[]): PassSummary {
  return {
    pipeline: summarizeRankArms(queries, pass.pipeline, { ks, baseline: 'current' }),
    pipelineAtBudget: summarizeAtBaselineBudget(queries, pass.pipeline, { baseline: 'current' }),
    poolAtBudget: summarizeAtBaselineBudget(queries, pass.pool, { baseline: 'current' })
  };
}

/** Largest absolute difference of any metric between two passes. */
function maxRerunDelta(first: PassSummary, other: PassSummary): number {
  let delta = 0;
  for (const [arm, metrics] of Object.entries(first.pipeline.arms)) {
    const again = other.pipeline.arms[arm];
    for (const key of ['recallAtK', 'ndcgAtK', 'hitAtK'] as const) {
      for (const [k, value] of Object.entries(metrics[key])) delta = Math.max(delta, Math.abs(value - again[key][Number(k)]));
    }
    delta = Math.max(delta, Math.abs(metrics.mrr - again.mrr));
  }
  for (const key of ['pipelineAtBudget', 'poolAtBudget'] as const) {
    for (const [arm, metrics] of Object.entries(first[key].arms)) {
      const again = other[key].arms[arm];
      delta = Math.max(delta, Math.abs(metrics.recall - again.recall), Math.abs(metrics.ndcg - again.ndcg));
    }
  }
  return delta;
}

/** Per arm, the trap queries whose list, cut to current's length, contains a forbidden memory. */
function forbiddenHits(queries: FixtureQuery[], runs: RankArmRun[]): { queries: number; currentReturnedAny: number; hits: Record<string, number> } {
  const hits: Record<string, number> = {};
  for (const arm of PIPELINE_ARMS) {
    hits[arm] = runs.filter((run, i) => (run[arm] ?? []).slice(0, run.current.length).some((id) => queries[i].forbiddenIds!.includes(id))).length;
  }
  return { queries: queries.length, currentReturnedAny: runs.filter((run) => run.current.length > 0).length, hits };
}

function pick<T>(rows: T[], get: (row: T) => number | null) {
  return latencySummary(rows.map(get).filter((value): value is number => value !== null));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fixture = JSON.parse(readFileSync(args.fixturePath, 'utf8')) as Fixture;
  const ks = [...new Set([1, 3, 5, 10, ...(fixture.ks ?? [])])].filter((k) => k <= args.topK).sort((a, b) => a - b);
  const isMatch = (query: FixtureQuery) => query.expectation !== 'no_match' && query.expectedIds.length > 0;
  const matchQueries = fixture.queries.filter(isMatch);
  const queries = args.limit ? matchQueries.slice(0, args.limit) : matchQueries;
  const trapQueries = fixture.queries.filter((query) => !isMatch(query) && (query.forbiddenIds?.length ?? 0) > 0);
  const cacheDir = path.resolve(args.modelCache);
  const preset = args.reranker === 'none' ? null : CROSS_ENCODER_PRESETS[args.reranker];
  const provenance = buildProvenance({
    fixtures: [args.fixturePath],
    retrieval: { topK: args.topK, candidatePool: fixture.memories.length },
    flags: {
      label: args.label, reranker: args.reranker, rerankerLoadOptions: preset?.loadOptions, pool: args.pool,
      rerankDepth: args.rerankDepth, ftsRankDepth: FTS_RANK_DEPTH, topK: args.topK, minScore: args.minScore,
      repeat: args.repeat, limit: args.limit, sweep: args.sweep, downloadModels: args.downloadModels, modelCache: pathRef(cacheDir)
    }
  });
  warnProvenance(provenance);

  const dir = mkdtempSync(path.join(tmpdir(), 'cml-rank-fusion-'));
  const embedder = await loadEmbedder(cacheDir, args.downloadModels);
  let corpus: Corpus | null = null;
  try {
    corpus = await buildCorpus(fixture, dir, embedder);
    const reranker = preset ? await loadCrossEncoder(args.reranker, cacheDir, { allowDownload: args.downloadModels }) : null;
    // The first scoring call pays the ONNX session warm-up; time it on its own.
    let firstRerankMs: number | null = null;
    if (reranker && queries.length > 0) {
      const startedAt = performance.now();
      await reranker.score(queries[0].query, [corpus.contentByEventId.values().next().value ?? '']);
      firstRerankMs = performance.now() - startedAt;
    }

    const passes: PassResult[] = [];
    for (let i = 0; i < args.repeat; i++) passes.push(await runPass(queries, corpus, embedder, reranker, args));
    const summaries = passes.map((pass) => summarizePass(queries as RankArmQuery[], pass, ks));
    const traps = trapQueries.length > 0 ? await runPass(trapQueries, corpus, embedder, reranker, args) : null;
    const timings = passes.flatMap((pass) => pass.timings);
    const report = {
      label: args.label ?? fixture.name,
      queries: queries.length,
      memories: fixture.memories.length,
      memoriesNotStored: corpus.notStored,
      ks,
      pipelineArms: PIPELINE_ARMS.filter((arm) => arm in summaries[0].pipeline.arms),
      poolArms: POOL_ARMS.filter((arm) => arm in summaries[0].poolAtBudget.arms),
      ...summaries[0],
      commonPool: {
        size: latencySummary(passes[0].poolSizes),
        currentNotPoolHead: passes[0].currentNotPoolHead
      },
      noMatchTraps: traps ? forbiddenHits(trapQueries, traps.pipeline) : null,
      rerunMaxAbsDelta: summaries.slice(1).reduce((max, other) => Math.max(max, maxRerunDelta(summaries[0], other)), 0),
      models: {
        embedder: { model: DEFAULT_EMBEDDING_MODEL, artifactSha256: await modelArtifactSha256(cacheDir, DEFAULT_EMBEDDING_MODEL) },
        reranker: reranker
          ? { name: args.reranker, ...reranker.preset, artifactSha256: await modelArtifactSha256(cacheDir, reranker.preset.model) }
          : null
      },
      latencyMs: {
        embedCorpus: corpus.embedMs,
        rerankerLoad: reranker?.loadMs ?? null,
        rerankerFirstCall: firstRerankMs,
        current: pick(timings, (row) => row.currentMs),
        vectorLane: pick(timings, (row) => row.vectorLaneMs),
        keywordLane: pick(timings, (row) => row.keywordLaneMs),
        rrf: pick(timings, (row) => row.rrfMs),
        rerank: pick(timings, (row) => row.rerankMs),
        rerankCpu: pick(timings, (row) => row.rerankCpuMs)
      },
      rerankSweep: reranker && args.sweep ? await rerankSweep(queries, corpus, embedder, reranker) : null,
      provenance
    };
    process.stdout.write(args.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : `${formatMarkdown(report)}\n`);
  } finally {
    await corpus?.store.close();
    await embedder.dispose('manual');
    rmSync(dir, { recursive: true, force: true });
  }
}

type Latency = ReturnType<typeof latencySummary>;
type Report = PassSummary & {
  label: string; queries: number; memories: number; memoriesNotStored: number; ks: number[];
  pipelineArms: string[]; poolArms: string[];
  commonPool: { size: Latency; currentNotPoolHead: number };
  noMatchTraps: { queries: number; currentReturnedAny: number; hits: Record<string, number> } | null;
  rerunMaxAbsDelta: number;
  models: { embedder: { model: string; artifactSha256: string | null }; reranker: { model: string; depth?: number; artifactSha256: string | null } | null };
  latencyMs: Record<string, number | null | Latency>;
  rerankSweep: Record<number, Latency & { cpuMsMean: number | null }> | null;
};

function formatMarkdown(report: Report): string {
  const f = (value: number | null | undefined, digits = 3) => (value === null || value === undefined ? 'n/a' : value.toFixed(digits));
  const signed = (value: number) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}`;
  const cell = (x?: { mean: number; ci: [number, number] }) => (x ? `${signed(x.mean)} (${signed(x.ci[0])}..${signed(x.ci[1])})` : '—');
  const budgetRows = (summary: BudgetSummary, arms: string[]) => arms.map((arm) => {
    const m = summary.arms[arm];
    return `| ${arm} | ${f(m.recall)} | ${f(m.ndcg)} | ${cell(m.vsBaseline?.recall)} | ${cell(m.vsBaseline?.ndcg)} |`;
  });
  const budgetHeader = ['| arm | recall@budget | nDCG@budget | Δrecall %p (95% CI) | ΔnDCG %p (95% CI) |', '|---|---:|---:|---|---|'];
  const lines = [
    `# Ranking arms: ${report.label}`,
    '',
    `- Queries with expected ids: ${report.queries}; memories: ${report.memories} (not stored: ${report.memoriesNotStored})`,
    `- Budget = current's list length per query; ${report.pipelineAtBudget.emptyBaseline} queries where current returned nothing are left out of the budget rows`,
    `- Rerun max |Δ| over all metrics: ${report.rerunMaxAbsDelta.toFixed(4)}`,
    `- Embedder ${report.models.embedder.model} sha256 ${report.models.embedder.artifactSha256?.slice(0, 12) ?? 'n/a'}; reranker ${report.models.reranker ? `${report.models.reranker.model} sha256 ${report.models.reranker.artifactSha256?.slice(0, 12) ?? 'n/a'}` : 'none'}`,
    '',
    '## Common pool (order only)',
    '',
    `Pool: current's filtered candidates, size p50 ${report.commonPool.size.p50}, max ${report.commonPool.size.max}. Queries where current's list is not the head of that pool: ${report.commonPool.currentNotPoolHead}.`,
    '',
    ...budgetHeader,
    ...budgetRows(report.poolAtBudget, report.poolArms),
    '',
    '## Pipeline comparison (candidates and order)',
    '',
    ...budgetHeader,
    ...budgetRows(report.pipelineAtBudget, report.pipelineArms),
    '',
    `| arm | ${report.ks.map((k) => `R@${k}`).join(' | ')} | ${report.ks.map((k) => `nDCG@${k}`).join(' | ')} | MRR |`,
    `|---|${report.ks.map(() => '---:').join('|')}|${report.ks.map(() => '---:').join('|')}|---:|`,
    ...report.pipelineArms.map((arm) => {
      const m = report.pipeline.arms[arm];
      return `| ${arm} | ${report.ks.map((k) => f(m.recallAtK[k])).join(' | ')} | ${report.ks.map((k) => f(m.ndcgAtK[k])).join(' | ')} | ${f(m.mrr)} |`;
    }),
    '',
    report.noMatchTraps
      ? `No-match traps (${report.noMatchTraps.queries} queries, current returned something for ${report.noMatchTraps.currentReturnedAny}); forbidden memory within current's budget: ${report.pipelineArms.map((arm) => `${arm} ${report.noMatchTraps!.hits[arm]}`).join(', ')}`
      : 'No-match traps: none in this fixture',
    '',
    '| latency (ms) | n | p50 | p90 | max |',
    '|---|---:|---:|---:|---:|',
    ...Object.entries(report.latencyMs).filter(([, v]) => v !== null && typeof v !== 'number').map(([name, v]) => {
      const s = v as Latency;
      return `| ${name} | ${s.n} | ${f(s.p50, 1)} | ${f(s.p90, 1)} | ${f(s.max, 1)} |`;
    }),
    '',
    `Reranker load ${f(report.latencyMs.rerankerLoad as number | null, 0)} ms, first call ${f(report.latencyMs.rerankerFirstCall as number | null, 0)} ms; corpus embedding ${f(report.latencyMs.embedCorpus as number, 0)} ms`
  ];
  if (report.rerankSweep) {
    lines.push('', '| rerank candidates | n | p50 ms | p90 ms | CPU ms (mean) |', '|---:|---:|---:|---:|---:|');
    for (const [size, s] of Object.entries(report.rerankSweep)) lines.push(`| ${size} | ${s.n} | ${f(s.p50, 1)} | ${f(s.p90, 1)} | ${f(s.cpuMsMean, 1)} |`);
  }
  return lines.join('\n');
}

// Success lets the event loop drain instead of calling process.exit: exiting
// while the native embedding runtime is loaded aborts (see replay-hook-grounding.ts).
main().catch((error) => {
  process.stderr.write(`${error instanceof CliError ? error.message : redactPaths(String(error?.stack ?? error))}\n`);
  process.exitCode = error instanceof CliError ? 2 : 1;
});
