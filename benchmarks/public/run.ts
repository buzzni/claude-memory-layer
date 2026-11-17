#!/usr/bin/env tsx
/**
 * Runs the public benchmark set of docs/BENCHMARKS.md and writes one JSON per
 * run plus summary.json into --out-dir.
 *
 *   npm run benchmark:public -- --out-dir <dir> [--model-cache <dir> [--download-models]] [--longmemeval <longmemeval_s_cleaned.json>]
 *
 * Without --model-cache the runs that need the e5-small embedder are skipped;
 * without --longmemeval the LongMemEval runs are skipped. Skipped runs are
 * listed in summary.json, never filled in. The LongMemEval file must have the
 * SHA-256 the document was measured on.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const LONGMEMEVAL_S_SHA256 = 'd6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442';
const GOLDEN = 'benchmarks/replay/golden-memory-usefulness-v1.json';
const LESSON_CACHE = '.cache/lesson-hybrid-e5';

// The reports are other scripts' JSON output, read by field name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
interface Run {
  name: string;
  script: string;
  args: string[];
  /** Exit codes that still mean "measured" (the lesson gate exits 1 when it fails). */
  okExit?: number[];
  /** The script writes its own output file; otherwise stdout is captured. */
  writesOut?: boolean;
  needsModels?: boolean;
  summarize: (report: Json) => Json;
}

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
  return round({ k, queryCount, memoryCount: report.fixtureStats.memoryCount, recallAnyAtK, recallAllAtK, fractionalRecallAtK, ndcgAtK, mrr }) as Json;
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
      okExit: [0, 1], writesOut: true, needsModels: true, summarize: summarizeLesson
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
    { name: 'lme-turn-grep', script: 'benchmarks/public/grep-baseline.ts', args: ['--fixture', out('lme-turn.fixture.json')], summarize: summarizeLongMemEval },
    { name: 'lme-turn-30-fixture', script: 'scripts/longmemeval-retrieval-smoke.ts', args: [...lmeArgs, '--granularity', 'turn', '--retrieval-mode', 'single', '--limit', '30', '--fixture-out', out('lme-turn-30.fixture.json'), '--out', out('lme-turn-30-fixture.json')], writesOut: true, summarize: summarizeLongMemEval },
    { name: 'lme-turn-30-lanes', script: 'scripts/evaluate-rank-fusion.ts', args: [...lanes(out('lme-turn-30.fixture.json')), '--label', 'longmemeval-s-turn-30'], needsModels: true, summarize: summarizeLanes }
  ];
}

const sha256File = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const git = (...args: string[]) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout.trim();

function main(argv: string[]): void {
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
  mkdirSync(opts.outDir, { recursive: true });

  const node = (script: string, args: string[], stdout: 'inherit' | number = 'inherit') =>
    spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { cwd: ROOT, stdio: ['ignore', stdout, 'inherit'] }).status;
  if (opts.modelCache && opts.downloadModels) {
    mkdirSync(path.join(ROOT, LESSON_CACHE), { recursive: true });
    // The lesson evaluation reads e5-small from a fixed cache; this run only fills it.
    node('scripts/evaluate-lesson-hybrid.ts', ['benchmarks/lesson-recall/calibration-v1.json', LESSON_CACHE, '--download-model'], openSync(os.devNull, 'w'));
  }

  const results: Json = {};
  for (const run of runs(opts.outDir, opts.modelCache, opts.longmemeval)) {
    if (run.needsModels && !opts.modelCache) {
      results[run.name] = { status: 'not run', reason: 'needs --model-cache' };
      continue;
    }
    const file = path.join(opts.outDir, `${run.name}.json`);
    const args = run.name.endsWith('-lanes') && opts.downloadModels ? [...run.args, '--download-models'] : run.args;
    process.stderr.write(`[benchmark:public] ${run.name}\n`);
    const started = Date.now();
    const fd = run.writesOut ? 'inherit' : openSync(file, 'w');
    const status = node(run.script, args, fd);
    if (typeof fd === 'number') closeSync(fd);
    const seconds = Math.round((Date.now() - started) / 1000);
    if (!(run.okExit ?? [0]).includes(status ?? -1) || !existsSync(file)) {
      results[run.name] = { status: 'failed', exitCode: status, seconds };
      continue;
    }
    results[run.name] = { status: 'measured', seconds, ...run.summarize(JSON.parse(readFileSync(file, 'utf8')) as Json) };
  }

  const summary = {
    gitSha: git('rev-parse', 'HEAD'),
    gitDirty: git('status', '--porcelain').length > 0,
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: `${os.cpus()[0]?.model ?? 'unknown'} x${os.cpus().length}`,
    memoryGb: Math.round(os.totalmem() / 2 ** 30),
    longMemEvalSha256: opts.longmemeval ? LONGMEMEVAL_S_SHA256 : null,
    results
  };
  writeFileSync(path.join(opts.outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (Object.values(results).some((result) => result.status === 'failed')) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
