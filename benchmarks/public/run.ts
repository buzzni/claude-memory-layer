#!/usr/bin/env tsx
/**
 * Runs the public benchmark set of docs/BENCHMARKS.md and writes one JSON per
 * run plus summary.json into --out-dir, which must be empty or absent.
 *
 *   npm run benchmark:public -- --out-dir <dir> [--model-cache <dir> [--download-models]] [--longmemeval <longmemeval_s_cleaned.json>]
 *
 * Without --model-cache the runs that need the e5-small embedder are skipped;
 * without --longmemeval the LongMemEval runs are skipped. Skipped runs are
 * listed in summary.json, never filled in. --download-models fetches e5-small
 * at a pinned revision into --model-cache and .cache/lesson-hybrid-e5; both
 * caches must then hash to the files the document was measured with. The
 * LongMemEval file must have the SHA-256 the document was measured on.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { modelArtifactSha256 } from '../../scripts/cross-encoder-reranker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const LONGMEMEVAL_S_SHA256 = 'd6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442';
/** The embedder's default model, pinned; sha256 is modelArtifactSha256 over these files. */
export const E5 = {
  model: 'Xenova/multilingual-e5-small',
  revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
  files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx'],
  sha256: 'a89c5cc413885d7c2af5906da0f77f30d2ce4ef4bb11751fc7e22d652373ec4d'
};
const GOLDEN = 'benchmarks/replay/golden-memory-usefulness-v1.json';
// The lesson evaluation reads e5-small from this fixed cache.
const LESSON_CACHE = path.join(ROOT, '.cache/lesson-hybrid-e5');

// The reports are other scripts' JSON output, read by field name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
export interface Run {
  name: string;
  script: string;
  args: string[];
  /** Whether the exit code still means "measured"; by default only 0 does. */
  acceptExit?: (status: number | null, report: Json) => boolean;
  /** The script writes `<out-dir>/<name>.json` itself; otherwise stdout is captured there. */
  writesOut?: boolean;
  needsModels?: boolean;
  summarize: (report: Json) => Json;
}
export type Exec = (script: string, args: string[], stdout: 'inherit' | number) => number | null;

/** The lesson evaluation exits 1 when its gate fails; that is a result, not an error. */
export const gateFailureIsMeasured = (status: number | null, report: Json) =>
  status === 0 || (status === 1 && report.gate?.passed === false);

const round = (value: unknown): unknown =>
  typeof value === 'number' ? Math.round(value * 10000) / 10000
    : Array.isArray(value) ? value.map(round)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, round(v)])) : value;

export const summarizeReplay = (report: Json) => {
  const { recallAtK, ndcgAtK, hitAtK, mrr, noMatchAccuracy, noMatchQueryCount, forbiddenHitCount, positiveQueryCount } = report.summary;
  return round({ positiveQueryCount, noMatchQueryCount, recallAtK, ndcgAtK, hitAtK, mrr, noMatchAccuracy, forbiddenHitCount }) as Json;
};

export const summarizeLongMemEval = (report: Json) => {
  const { k, queryCount, recallAnyAtK, recallAllAtK, fractionalRecallAtK, ndcgAtK, mrr } = report.longMemEvalAnalysis;
  const lengths = report.haystackLengths ? { haystackLengths: report.haystackLengths } : {};
  return round({ k, queryCount, memoryCount: report.fixtureStats.memoryCount, recallAnyAtK, recallAllAtK, fractionalRecallAtK, ndcgAtK, mrr, ...lengths }) as Json;
};

export const summarizeLanes = (report: Json) => round({
  queries: report.queries,
  memories: report.memories,
  rerunMaxAbsDelta: report.rerunMaxAbsDelta,
  embedder: report.models.embedder,
  at10: Object.fromEntries(Object.entries(report.pipeline.arms as Json).map(([arm, m]) =>
    [arm, { recall: m.recallAtK[10], ndcg: m.ndcgAtK[10], hit: m.hitAtK[10], mrr: m.mrr }])),
  atBudget: Object.fromEntries(Object.entries(report.pipelineAtBudget.arms as Json).map(([arm, m]) =>
    [arm, { recall: m.recall, ndcg: m.ndcg, ...(m.vsBaseline ? { vsCurrent: m.vsBaseline } : {}) }]))
}) as Json;

const summarizeLesson = (report: Json) => round({ lexical: report.lexical, hybrid: report.hybrid, gate: report.gate }) as Json;

const summarizeHook = (report: Json) => {
  const current = (report.arms as Json[]).find((arm) => arm.arm === 'current')!;
  return round({ turns: report.turns, selectionReproducedRate: report.selectionReproducedRate, current: current.all }) as Json;
};

function runs(outDir: string, modelCache?: string, longmemeval?: string): Run[] {
  const out = (name: string) => path.join(outDir, name);
  const lmeArgs = ['--input', longmemeval ?? '', '--strategy', 'fast', '--format', 'json', '--no-per-query'];
  const lanes = (fixture: string) => ['--fixture', fixture, '--model-cache', modelCache ?? '', '--reranker', 'none', '--format', 'json'];
  return [
    { name: 'golden-replay', script: 'scripts/replay-retrieval-benchmark.ts', args: ['--fixture', GOLDEN, '--format', 'json', '--no-per-query'], summarize: summarizeReplay },
    { name: 'golden-grep', script: 'benchmarks/public/grep-baseline.ts', args: ['--fixture', GOLDEN], summarize: summarizeReplay },
    { name: 'golden-lanes', script: 'scripts/evaluate-rank-fusion.ts', args: lanes(GOLDEN), needsModels: true, summarize: summarizeLanes },
    ...['release-v1-independent', 'release-v2-independent'].map((fixture): Run => ({
      name: `lesson-${fixture}`, script: 'scripts/evaluate-lesson-hybrid-heldout.ts',
      args: [`benchmarks/lesson-recall/${fixture}.json`, out(`lesson-${fixture}.json`), '--final-report'],
      acceptExit: gateFailureIsMeasured, writesOut: true, needsModels: true, summarize: summarizeLesson
    })),
    { name: 'hook-fixture', script: 'scripts/replay-hook-grounding.ts', args: ['--fixture', 'benchmarks/replay/hook-grounding-fixture-v1.json', '--format', 'json'], summarize: summarizeHook },
    ...(longmemeval ? longMemEvalRuns(outDir, lmeArgs, lanes) : [])
  ];
}

function longMemEvalRuns(outDir: string, lmeArgs: string[], lanes: (fixture: string) => string[]): Run[] {
  const out = (name: string) => path.join(outDir, name);
  return [
    { name: 'lme-session', script: 'scripts/longmemeval-retrieval-smoke.ts', args: [...lmeArgs, '--granularity', 'session', '--retrieval-mode', 'single', '--fixture-out', out('lme-session.fixture.json'), '--out', out('lme-session.json')], writesOut: true, summarize: summarizeLongMemEval },
    { name: 'lme-turn', script: 'scripts/longmemeval-retrieval-smoke.ts', args: [...lmeArgs, '--granularity', 'turn', '--retrieval-mode', 'single', '--fixture-out', out('lme-turn.fixture.json'), '--out', out('lme-turn.json')], writesOut: true, summarize: summarizeLongMemEval },
    { name: 'lme-hybrid', script: 'scripts/longmemeval-retrieval-smoke.ts', args: [...lmeArgs, '--granularity', 'session', '--retrieval-mode', 'hybrid', '--expand-preference-queries', '--temporal-date-boost', '--hybrid-session-weight', '1.75', '--hybrid-turn-weight', '5', '--out', out('lme-hybrid.json')], writesOut: true, summarize: summarizeLongMemEval },
    { name: 'lme-session-grep', script: 'benchmarks/public/grep-baseline.ts', args: ['--fixture', out('lme-session.fixture.json')], summarize: summarizeLongMemEval },
    { name: 'lme-session-grep-masked', script: 'benchmarks/public/grep-baseline.ts', args: ['--fixture', out('lme-session.fixture.json'), '--mask-session-header'], summarize: summarizeLongMemEval },
    { name: 'lme-turn-grep', script: 'benchmarks/public/grep-baseline.ts', args: ['--fixture', out('lme-turn.fixture.json')], summarize: summarizeLongMemEval },
    { name: 'lme-turn-30-fixture', script: 'scripts/longmemeval-retrieval-smoke.ts', args: [...lmeArgs, '--granularity', 'turn', '--retrieval-mode', 'single', '--limit', '30', '--fixture-out', out('lme-turn-30.fixture.json'), '--out', out('lme-turn-30-fixture.json')], writesOut: true, summarize: summarizeLongMemEval },
    { name: 'lme-turn-30-lanes', script: 'scripts/evaluate-rank-fusion.ts', args: [...lanes(out('lme-turn-30.fixture.json')), '--label', 'longmemeval-s-turn-30'], needsModels: true, summarize: summarizeLanes }
  ];
}

export function prepareOutDir(dir: string): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`--out-dir ${dir} is not empty; use a new directory so no earlier report is read as this run's`);
  mkdirSync(dir, { recursive: true });
}

/** Runs one evaluation and summarizes the report it wrote; an existing report is never read. */
export function executeRun(run: Run, outDir: string, exec: Exec): Json {
  const file = path.join(outDir, `${run.name}.json`);
  if (existsSync(file)) return { status: 'failed', reason: 'report already exists' };
  const started = Date.now();
  const fd = run.writesOut ? 'inherit' : openSync(file, 'w');
  let status: number | null;
  try {
    status = exec(run.script, run.args, fd);
  } finally {
    if (typeof fd === 'number') closeSync(fd);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  let report: Json;
  try {
    report = JSON.parse(readFileSync(file, 'utf8')) as Json;
  } catch {
    return { status: 'failed', exitCode: status, seconds, reason: existsSync(file) ? 'unreadable report' : 'no report' };
  }
  if (!(run.acceptExit ?? ((code) => code === 0))(status, report)) return { status: 'failed', exitCode: status, seconds };
  return { status: 'measured', seconds, ...run.summarize(report) };
}

async function downloadE5(cacheDir: string): Promise<void> {
  for (const file of E5.files) {
    const target = path.join(cacheDir, E5.model, file);
    if (existsSync(target)) continue;
    const response = await fetch(`https://huggingface.co/${E5.model}/resolve/${E5.revision}/${file}`);
    if (!response.ok || !response.body) throw new Error(`download of ${E5.model}/${file} failed: HTTP ${response.status}`);
    mkdirSync(path.dirname(target), { recursive: true });
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(`${target}.part`));
    renameSync(`${target}.part`, target);
  }
}

async function verifyE5(cacheDir: string): Promise<void> {
  const sha = await modelArtifactSha256(cacheDir, E5.model);
  if (sha !== E5.sha256) {
    throw new Error(`${E5.model} in ${cacheDir} hashes to ${sha ?? 'nothing'}, not ${E5.sha256} (revision ${E5.revision}); use --download-models with an empty cache`);
  }
}

const sha256File = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const git = (...args: string[]) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout.trim();

async function main(argv: string[]): Promise<void> {
  const opts: { outDir?: string; modelCache?: string; longmemeval?: string; downloadModels: boolean } = { downloadModels: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out-dir') opts.outDir = path.resolve(argv[++i]);
    else if (argv[i] === '--model-cache') opts.modelCache = path.resolve(argv[++i]);
    else if (argv[i] === '--longmemeval') opts.longmemeval = path.resolve(argv[++i]);
    else if (argv[i] === '--download-models') opts.downloadModels = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!opts.outDir) throw new Error('usage: npm run benchmark:public -- --out-dir <dir> [--model-cache <dir> [--download-models]] [--longmemeval <file>]');
  if (opts.longmemeval && sha256File(opts.longmemeval) !== LONGMEMEVAL_S_SHA256) {
    throw new Error(`${path.basename(opts.longmemeval)} is not the LongMemEval_S file the document was measured on (sha256 ${LONGMEMEVAL_S_SHA256})`);
  }
  prepareOutDir(opts.outDir);
  if (opts.modelCache) {
    for (const cache of [opts.modelCache, LESSON_CACHE]) {
      if (opts.downloadModels) await downloadE5(cache);
      await verifyE5(cache);
    }
  }

  const exec: Exec = (script, args, stdout) =>
    spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { cwd: ROOT, stdio: ['ignore', stdout, 'inherit'] }).status;
  const results: Json = {};
  for (const run of runs(opts.outDir, opts.modelCache, opts.longmemeval)) {
    if (run.needsModels && !opts.modelCache) {
      results[run.name] = { status: 'not run', reason: 'needs --model-cache' };
      continue;
    }
    process.stderr.write(`[benchmark:public] ${run.name}\n`);
    results[run.name] = executeRun(run, opts.outDir, exec);
  }

  const summary = {
    gitSha: git('rev-parse', 'HEAD'),
    gitDirty: git('status', '--porcelain').length > 0,
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: `${os.cpus()[0]?.model ?? 'unknown'} x${os.cpus().length}`,
    memoryGb: Math.round(os.totalmem() / 2 ** 30),
    longMemEvalSha256: opts.longmemeval ? LONGMEMEVAL_S_SHA256 : null,
    embedder: opts.modelCache ? { model: E5.model, revision: E5.revision, artifactSha256: E5.sha256 } : null,
    results
  };
  writeFileSync(path.join(opts.outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (Object.values(results).some((result) => result.status === 'failed')) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
