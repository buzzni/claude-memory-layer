#!/usr/bin/env tsx
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

interface ParsedArgs {
  inputPath: string;
  outDir: string;
  checkpointPath: string;
  retrievalReportPath: string;
  fixtureOutPath: string;
  hypothesesOutPath: string;
  judgeOutPath: string;
  summaryOutPath: string;
  resume: boolean;
  force: boolean;
  skipJudge: boolean;
  granularity: 'session' | 'turn';
  retrievalMode: 'single' | 'hybrid';
  strategy: 'auto' | 'fast' | 'deep';
  hybridSessionWeight: number;
  hybridTurnWeight: number;
  expandPreferenceQueries: boolean;
  temporalDateBoost: boolean;
  includeAbstention: boolean;
  readerCommand: string;
  readerArgs: string[];
  readerTimeoutMs: number;
  judgeCommand: string;
  judgeArgs: string[];
  judgeTimeoutMs: number;
  limit?: number;
  topK: number;
}

interface ReplayFixture {
  queries: ReplayQuery[];
  memories: ReplayMemory[];
}

interface ReplayQuery {
  queryId: string;
  query: string;
  category?: string;
  temporalDateBoost?: ReplayTemporalDateBoost;
}

interface ReplayTemporalDateBoost {
  referenceDate: string;
  targetDate?: string;
  toleranceDays?: number;
  entityTerms?: string[];
}

interface ReplayMemory {
  id: string;
  content: string;
}

interface ReplayReport {
  perQuery: ReplayQueryMetric[];
}

interface ReplayQueryMetric {
  queryId: string;
  at?: Record<string, { hits?: number; recall?: number }>;
  expectedIds?: string[];
  retrievedIds: string[];
  category?: string;
}

interface ReaderPayload {
  question_id: string;
  question: string;
  category?: string;
  temporalDateBoost?: ReplayTemporalDateBoost;
  contexts: Array<{ id: string; rank: number; content: string }>;
}

interface HypothesisRow {
  question_id: string;
  hypothesis: string;
  [key: string]: unknown;
}

interface EvaluatedRow extends HypothesisRow {
  autoeval_label?: {
    model?: string;
    label?: boolean;
  };
}

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

class CliHelp extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliHelp';
  }
}

const CHECKPOINT_VERSION = 1;
const DEFAULT_READER_TIMEOUT_MS = 180_000;
const DEFAULT_JUDGE_TIMEOUT_MS = 180_000;

void main(process.argv.slice(2)).catch((error) => {
  if (error instanceof CliHelp) {
    process.stdout.write(`${error.message}\n`);
    process.exitCode = 0;
  } else if (error instanceof CliError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } else if (error instanceof Error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  }
});

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  await mkdir(options.outDir, { recursive: true });
  await prepareOutputFiles(options);
  await validateResumeCheckpoint(options);

  await writeCheckpoint(options, 'retrieval_running', { readerTotal: 0, readerCompleted: 0, judgeTotal: 0, judgeCompleted: 0 });
  await ensureRetrievalArtifacts(options);

  const fixture = await readJsonFile<ReplayFixture>(options.fixtureOutPath, 'retrieval fixture');
  const report = await readJsonFile<ReplayReport>(options.retrievalReportPath, 'retrieval report');
  validateFixtureAndReport(fixture, report);
  const fixtureQuestionIds = new Set(fixture.queries.map((query) => query.queryId));

  const hypotheses = await readRowsByQuestionId<HypothesisRow>(options.hypothesesOutPath, 'hypothesis');
  validateRowsBelongToFixture(hypotheses, fixtureQuestionIds, 'hypothesis', options.hypothesesOutPath);
  await runReaderPhase(options, fixture, report, hypotheses);

  process.stdout.write(`Reader hypotheses: ${hypotheses.size}/${fixture.queries.length}\n`);

  if (options.skipJudge) {
    await writeCheckpoint(options, 'reader_complete', {
      readerTotal: fixture.queries.length,
      readerCompleted: hypotheses.size,
      judgeTotal: 0,
      judgeCompleted: 0
    });
    process.stdout.write(`Saved hypotheses to ${options.hypothesesOutPath}\n`);
    return;
  }

  const evaluatedRows = await readRowsByQuestionId<EvaluatedRow>(options.judgeOutPath, 'judge result');
  validateRowsBelongToFixture(evaluatedRows, fixtureQuestionIds, 'judge result', options.judgeOutPath);
  await runJudgePhase(options, fixture, hypotheses, evaluatedRows);
  const evaluated = [...evaluatedRows.values()];
  const score = summarizeEvaluation(evaluated);
  const summary = buildEvaluationSummary(fixture, report, evaluated);
  await writeTextFile(options.summaryOutPath, `${JSON.stringify(summary, null, 2)}\n`);

  await writeCheckpoint(options, 'completed', {
    readerTotal: fixture.queries.length,
    readerCompleted: hypotheses.size,
    judgeTotal: hypotheses.size,
    judgeCompleted: evaluatedRows.size
  });
  process.stdout.write(`Codex-compatible accuracy: ${round4(score.accuracy)} (${score.correct}/${score.total})\n`);
  process.stdout.write(`Saved judge results to ${options.judgeOutPath}\n`);
  process.stdout.write(`Saved summary to ${options.summaryOutPath}\n`);
}

async function prepareOutputFiles(options: ParsedArgs): Promise<void> {
  const managed = [
    options.checkpointPath,
    options.retrievalReportPath,
    options.fixtureOutPath,
    options.hypothesesOutPath,
    options.judgeOutPath,
    options.summaryOutPath
  ];
  if (options.force) {
    await Promise.all(managed.map((filePath) => rm(filePath, { force: true }).catch(() => undefined)));
    return;
  }
  if (options.resume) return;
  const existing: string[] = [];
  for (const filePath of managed) {
    if (await fileExists(filePath)) existing.push(filePath);
  }
  if (existing.length > 0) {
    throw new CliError(`Output files already exist; use --resume to continue or --force to overwrite: ${existing.join(', ')}`);
  }
}

async function validateResumeCheckpoint(options: ParsedArgs): Promise<void> {
  if (!options.resume) return;
  if (!await fileExists(options.checkpointPath)) {
    throw new CliError(`Resume checkpoint is required at ${options.checkpointPath}; use --force to restart or choose a new --out-dir.`);
  }
  const checkpoint = await readJsonFile<Record<string, unknown>>(options.checkpointPath, 'checkpoint');
  if (!isRecord(checkpoint)) {
    throw new CliError(`Resume checkpoint at ${options.checkpointPath} must be a JSON object`);
  }
  if (checkpoint.version !== CHECKPOINT_VERSION) {
    throw new CliError(`Unsupported resume checkpoint version at ${options.checkpointPath}: ${String(checkpoint.version)}`);
  }
  if (!isRecord(checkpoint.run_options)) {
    throw new CliError(`Resume checkpoint at ${options.checkpointPath} is missing run_options; use --force to restart`);
  }

  const expected = buildRunOptionsFingerprint(options);
  const checkpointRunOptions = normalizeCheckpointRunOptions(checkpoint.run_options, checkpoint, options);
  const mismatches = collectObjectMismatches(checkpointRunOptions, expected, 'run_options');
  if (mismatches.length > 0) {
    throw new CliError(`Resume checkpoint does not match current options: ${mismatches.join(', ')}. Use matching options, a new --out-dir, or --force to restart.`);
  }
}

async function ensureRetrievalArtifacts(options: ParsedArgs): Promise<void> {
  if (options.resume && await fileExists(options.fixtureOutPath) && await fileExists(options.retrievalReportPath)) {
    process.stdout.write(`Reusing retrieval artifacts from ${options.outDir}\n`);
    return;
  }
  const args = [
    'tsx',
    'scripts/longmemeval-retrieval-smoke.ts',
    '--input',
    options.inputPath,
    '--out',
    options.retrievalReportPath,
    '--fixture-out',
    options.fixtureOutPath,
    '--format',
    'json',
    '--granularity',
    options.granularity,
    '--retrieval-mode',
    options.retrievalMode,
    '--strategy',
    options.strategy,
    '--top-k',
    String(options.topK),
    '--hybrid-session-weight',
    String(options.hybridSessionWeight),
    '--hybrid-turn-weight',
    String(options.hybridTurnWeight),
    options.includeAbstention ? '--include-abstention' : '--skip-abstention'
  ];
  if (options.limit !== undefined) args.push('--limit', String(options.limit));
  if (options.expandPreferenceQueries) args.push('--expand-preference-queries');
  else args.push('--no-expand-preference-queries');
  if (options.temporalDateBoost) args.push('--temporal-date-boost');
  else args.push('--no-temporal-date-boost');

  await runCommand('npx', args, '', 10 * 60_000, process.cwd(), 'retrieval smoke');
}

async function runReaderPhase(
  options: ParsedArgs,
  fixture: ReplayFixture,
  report: ReplayReport,
  hypotheses: Map<string, HypothesisRow>
): Promise<void> {
  const memoryById = new Map(fixture.memories.map((memory) => [memory.id, memory]));
  const metricByQueryId = new Map(report.perQuery.map((metric) => [metric.queryId, metric]));

  for (const query of fixture.queries) {
    if (hypotheses.has(query.queryId)) continue;
    const metric = metricByQueryId.get(query.queryId);
    const payload: ReaderPayload = {
      question_id: query.queryId,
      question: query.query,
      contexts: (metric?.retrievedIds ?? [])
        .map((id, index) => {
          const memory = memoryById.get(id);
          if (!memory) return undefined;
          return { id, rank: index + 1, content: memory.content };
        })
        .filter((context): context is { id: string; rank: number; content: string } => context !== undefined)
    };
    if (query.category !== undefined) payload.category = query.category;
    if (query.temporalDateBoost !== undefined) payload.temporalDateBoost = sanitizeTemporalDateBoost(query.temporalDateBoost);

    await writeCheckpoint(options, 'reader_running', {
      readerTotal: fixture.queries.length,
      readerCompleted: hypotheses.size,
      judgeTotal: 0,
      judgeCompleted: 0,
      lastQuestionId: query.queryId
    });

    let hypothesisText: string;
    try {
      hypothesisText = await runCommand(
        options.readerCommand,
        options.readerArgs,
        `${JSON.stringify(payload)}\n`,
        options.readerTimeoutMs,
        process.cwd(),
        `reader command for ${query.queryId}`
      );
    } catch (error) {
      await writeCheckpoint(options, 'reader_failed', {
        readerTotal: fixture.queries.length,
        readerCompleted: hypotheses.size,
        judgeTotal: 0,
        judgeCompleted: 0,
        lastQuestionId: query.queryId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw new CliError(`Reader command failed for ${query.queryId}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const row: HypothesisRow = {
      question_id: query.queryId,
      hypothesis: hypothesisText.trim() || 'I do not know'
    };
    await appendJsonl(options.hypothesesOutPath, row);
    hypotheses.set(query.queryId, row);
    await writeCheckpoint(options, 'reader_running', {
      readerTotal: fixture.queries.length,
      readerCompleted: hypotheses.size,
      judgeTotal: 0,
      judgeCompleted: 0,
      lastQuestionId: query.queryId
    });
  }
}

function sanitizeTemporalDateBoost(value: unknown): ReplayTemporalDateBoost {
  if (!isRecord(value)) {
    throw new CliError('Replay query temporalDateBoost must be an object');
  }
  const referenceDate = value.referenceDate;
  if (typeof referenceDate !== 'string' || referenceDate.trim() === '') {
    throw new CliError('Replay query temporalDateBoost requires non-empty string referenceDate');
  }
  const boost: ReplayTemporalDateBoost = { referenceDate };
  if (value.targetDate !== undefined) {
    if (typeof value.targetDate !== 'string' || value.targetDate.trim() === '') {
      throw new CliError('Replay query temporalDateBoost targetDate must be a non-empty string');
    }
    boost.targetDate = value.targetDate;
  }
  if (value.toleranceDays !== undefined) {
    if (typeof value.toleranceDays !== 'number' || !Number.isFinite(value.toleranceDays) || value.toleranceDays < 0) {
      throw new CliError('Replay query temporalDateBoost toleranceDays must be a non-negative number');
    }
    boost.toleranceDays = value.toleranceDays;
  }
  if (value.entityTerms !== undefined) {
    if (!Array.isArray(value.entityTerms) || !value.entityTerms.every((term) => typeof term === 'string')) {
      throw new CliError('Replay query temporalDateBoost entityTerms must be a string array');
    }
    boost.entityTerms = value.entityTerms.filter((term) => term.trim() !== '');
  }
  return boost;
}

async function runJudgePhase(
  options: ParsedArgs,
  fixture: ReplayFixture,
  hypotheses: Map<string, HypothesisRow>,
  evaluatedRows: Map<string, EvaluatedRow>
): Promise<void> {
  for (const query of fixture.queries) {
    const hypothesis = hypotheses.get(query.queryId);
    if (!hypothesis) {
      throw new CliError(`Cannot judge ${query.queryId}: missing hypothesis row`);
    }
    if (evaluatedRows.has(query.queryId)) continue;

    await writeCheckpoint(options, 'judge_running', {
      readerTotal: fixture.queries.length,
      readerCompleted: hypotheses.size,
      judgeTotal: hypotheses.size,
      judgeCompleted: evaluatedRows.size,
      lastQuestionId: query.queryId
    });

    let row: EvaluatedRow;
    try {
      row = await runJudgeForOneHypothesis(options, hypothesis);
    } catch (error) {
      await writeCheckpoint(options, 'judge_failed', {
        readerTotal: fixture.queries.length,
        readerCompleted: hypotheses.size,
        judgeTotal: hypotheses.size,
        judgeCompleted: evaluatedRows.size,
        lastQuestionId: query.queryId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw new CliError(`Codex-compatible judge failed for ${query.queryId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await appendJsonl(options.judgeOutPath, row);
    evaluatedRows.set(query.queryId, row);
    await writeCheckpoint(options, 'judge_running', {
      readerTotal: fixture.queries.length,
      readerCompleted: hypotheses.size,
      judgeTotal: hypotheses.size,
      judgeCompleted: evaluatedRows.size,
      lastQuestionId: query.queryId
    });
  }
}

async function runJudgeForOneHypothesis(options: ParsedArgs, hypothesis: HypothesisRow): Promise<EvaluatedRow> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'cml-longmemeval-codex-batch-judge-row-'));
  const hypPath = path.join(tempDir, 'hypothesis.jsonl');
  const outPath = path.join(tempDir, 'eval.jsonl');
  try {
    await writeFile(hypPath, `${JSON.stringify(hypothesis)}\n`, 'utf8');
    await runCommand(
      options.judgeCommand,
      [...options.judgeArgs, '--hyp', hypPath, '--ref', options.inputPath, '--out', outPath],
      '',
      options.judgeTimeoutMs,
      process.cwd(),
      `Codex-compatible judge for ${hypothesis.question_id}`
    );
    const rows = await readJsonlRows<EvaluatedRow>(outPath, 'single judge result');
    if (rows.length !== 1) {
      throw new CliError(`Expected one judge row for ${hypothesis.question_id}, got ${rows.length}`);
    }
    if (rows[0].question_id !== hypothesis.question_id) {
      throw new CliError(`Judge row id mismatch: expected ${hypothesis.question_id}, got ${rows[0].question_id}`);
    }
    return rows[0];
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeCheckpoint(
  options: ParsedArgs,
  status: string,
  counts: {
    readerTotal: number;
    readerCompleted: number;
    judgeTotal: number;
    judgeCompleted: number;
    lastQuestionId?: string;
    error?: string;
  }
): Promise<void> {
  const checkpoint = {
    version: CHECKPOINT_VERSION,
    status,
    updated_at: new Date().toISOString(),
    input_path: options.inputPath,
    out_dir: options.outDir,
    files: {
      retrieval_report: options.retrievalReportPath,
      fixture: options.fixtureOutPath,
      hypotheses: options.hypothesesOutPath,
      judge_results: options.judgeOutPath,
      summary: options.summaryOutPath,
      checkpoint: options.checkpointPath
    },
    run_options: buildRunOptionsFingerprint(options),
    retrieval: {
      report_path: options.retrievalReportPath,
      fixture_path: options.fixtureOutPath
    },
    reader: {
      total: counts.readerTotal,
      completed: counts.readerCompleted
    },
    judge: {
      total: counts.judgeTotal,
      completed: counts.judgeCompleted
    },
    ...(counts.lastQuestionId ? { last_question_id: counts.lastQuestionId } : {}),
    ...(counts.error ? { error: redactKnownSecrets(counts.error) } : {})
  };
  await writeTextFile(options.checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

function validateFixtureAndReport(fixture: ReplayFixture, report: ReplayReport): void {
  if (!Array.isArray(fixture.queries) || !Array.isArray(fixture.memories)) {
    throw new CliError('Retrieval fixture must contain queries and memories arrays');
  }
  if (!Array.isArray(report.perQuery)) {
    throw new CliError('Retrieval report must include perQuery rows; do not run with --no-per-query');
  }

  const queryIds = new Set<string>();
  for (const query of fixture.queries) {
    if (typeof query.queryId !== 'string' || query.queryId.trim() === '') {
      throw new CliError('Retrieval fixture query requires non-empty queryId');
    }
    if (queryIds.has(query.queryId)) {
      throw new CliError(`Duplicate retrieval fixture queryId: ${query.queryId}`);
    }
    queryIds.add(query.queryId);
  }

  const metricIds = new Set<string>();
  for (const metric of report.perQuery) {
    if (typeof metric.queryId !== 'string' || metric.queryId.trim() === '') {
      throw new CliError('Retrieval report perQuery row requires non-empty queryId');
    }
    if (metricIds.has(metric.queryId)) {
      throw new CliError(`Duplicate retrieval report queryId: ${metric.queryId}`);
    }
    metricIds.add(metric.queryId);
  }

  for (const query of fixture.queries) {
    if (!metricIds.has(query.queryId)) {
      throw new CliError(`Retrieval report missing perQuery row for ${query.queryId}`);
    }
  }
}

function validateRowsBelongToFixture<T extends { question_id: string }>(
  rows: Map<string, T>,
  fixtureQuestionIds: Set<string>,
  label: string,
  filePath: string
): void {
  for (const questionId of rows.keys()) {
    if (!fixtureQuestionIds.has(questionId)) {
      throw new CliError(`Stale ${label} question_id in resumed output ${filePath}: ${questionId}`);
    }
  }
}

async function readRowsByQuestionId<T extends { question_id: string }>(filePath: string, label: string): Promise<Map<string, T>> {
  const rows = await readJsonlRows<T>(filePath, label);
  const map = new Map<string, T>();
  for (const row of rows) {
    if (typeof row.question_id !== 'string' || row.question_id.trim() === '') {
      throw new CliError(`${label} row requires non-empty string question_id`);
    }
    if (map.has(row.question_id)) {
      throw new CliError(`Duplicate ${label} question_id in ${filePath}: ${row.question_id}`);
    }
    map.set(row.question_id, row);
  }
  return map;
}

async function readJsonlRows<T extends Record<string, unknown>>(filePath: string, label: string): Promise<T[]> {
  if (!await fileExists(filePath)) return [];
  const raw = await readFile(filePath, 'utf8');
  const rows: T[] = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new CliError(`Failed to parse ${label} ${filePath} line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(parsed)) {
      throw new CliError(`${label} ${filePath} line ${index + 1} must be a JSON object`);
    }
    rows.push(parsed as T);
  }
  return rows;
}

async function readJsonFile<T>(filePath: string, label: string): Promise<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    throw new CliError(`Failed to read ${label} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed as T;
}

async function appendJsonl(filePath: string, row: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

function runCommand(command: string, args: string[], stdin: string, timeoutMs: number, cwd: string, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== 'win32',
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let stdinError: Error | undefined;

    const finish = (error?: CliError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout.trim());
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.stdin.on('error', (error: Error & { code?: string }) => {
      stdinError = error;
      if (error.code !== 'EPIPE') {
        finish(new CliError(`${label} stdin write failed: ${redactKnownSecrets(error.message)}`));
      }
    });
    child.on('error', (error) => finish(new CliError(`${label} failed to start: ${redactKnownSecrets(error.message)}`)));
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish(new CliError(`${label} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        const detail = redactKnownSecrets(stderr.trim()).slice(0, 2_000);
        finish(new CliError(`${label} exited with code ${code ?? `signal ${signal ?? 'unknown'}`}${detail ? `: ${detail}` : ''}`));
        return;
      }
      if (stdinError) {
        finish(new CliError(`${label} stdin write failed: ${redactKnownSecrets(stdinError.message)}`));
        return;
      }
      finish();
    });
    child.stdin.end(stdin, 'utf8');
  });
}

function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, 'SIGKILL');
      return;
    }
  } catch {
    // Fall through to direct child kill.
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // ignore best-effort cleanup failure
  }
}

function summarizeEvaluation(rows: EvaluatedRow[]): { total: number; correct: number; accuracy: number } {
  const total = rows.length;
  const correct = rows.filter((row) => row.autoeval_label?.label === true).length;
  return { total, correct, accuracy: total === 0 ? 0 : correct / total };
}

function buildEvaluationSummary(fixture: ReplayFixture, report: ReplayReport, rows: EvaluatedRow[]): Record<string, unknown> {
  const queryById = new Map(fixture.queries.map((query) => [query.queryId, query]));
  const metricByQueryId = new Map(report.perQuery.map((metric) => [metric.queryId, metric]));
  const categoryBreakdown = new Map<string, { total: number; correct: number }>();
  const overallRetrievalVsQa = createRetrievalVsQaCounters();
  const retrievalVsQaByCategory = new Map<string, ReturnType<typeof createRetrievalVsQaCounters>>();

  for (const row of rows) {
    const metric = metricByQueryId.get(row.question_id);
    const category = queryById.get(row.question_id)?.category ?? metric?.category ?? 'unknown';
    const correct = row.autoeval_label?.label === true;
    const categoryStats = categoryBreakdown.get(category) ?? { total: 0, correct: 0 };
    categoryStats.total += 1;
    if (correct) categoryStats.correct += 1;
    categoryBreakdown.set(category, categoryStats);

    const hit10 = hasRetrievalHitAt10(metric);
    addRetrievalVsQa(overallRetrievalVsQa, hit10, correct);
    const categoryRetrievalVsQa = retrievalVsQaByCategory.get(category) ?? createRetrievalVsQaCounters();
    addRetrievalVsQa(categoryRetrievalVsQa, hit10, correct);
    retrievalVsQaByCategory.set(category, categoryRetrievalVsQa);
  }

  return {
    generatedAt: new Date().toISOString(),
    score: summarizeEvaluation(rows),
    categoryBreakdown: Object.fromEntries(
      [...categoryBreakdown.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([category, stats]) => [category, {
        ...stats,
        accuracy: stats.total === 0 ? 0 : stats.correct / stats.total
      }])
    ),
    retrievalVsQa: {
      overall: overallRetrievalVsQa,
      byCategory: Object.fromEntries([...retrievalVsQaByCategory.entries()].sort(([a], [b]) => a.localeCompare(b)))
    }
  };
}

function createRetrievalVsQaCounters(): { hit10Correct: number; hit10Wrong: number; miss10Correct: number; miss10Wrong: number } {
  return { hit10Correct: 0, hit10Wrong: 0, miss10Correct: 0, miss10Wrong: 0 };
}

function addRetrievalVsQa(
  counters: ReturnType<typeof createRetrievalVsQaCounters>,
  hit10: boolean,
  correct: boolean
): void {
  if (hit10 && correct) counters.hit10Correct += 1;
  else if (hit10) counters.hit10Wrong += 1;
  else if (correct) counters.miss10Correct += 1;
  else counters.miss10Wrong += 1;
}

function hasRetrievalHitAt10(metric: ReplayQueryMetric | undefined): boolean {
  if (!metric) return false;
  const at10 = metric.at?.['10'];
  if ((at10?.hits ?? 0) > 0 || (at10?.recall ?? 0) > 0) return true;
  const expectedIds = metric.expectedIds ?? [];
  if (expectedIds.length === 0) return false;
  const retrievedAt10 = new Set((metric.retrievedIds ?? []).slice(0, 10));
  return expectedIds.some((id) => retrievedAt10.has(id));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const cwd = process.cwd();
  let outDir = '';
  let checkpointPath = '';
  let retrievalReportPath = '';
  let fixtureOutPath = '';
  let hypothesesOutPath = '';
  let judgeOutPath = '';
  let summaryOutPath = '';
  let customReaderCommand = false;
  let customJudgeCommand = false;
  const parsed: ParsedArgs = {
    inputPath: '',
    outDir,
    checkpointPath,
    retrievalReportPath,
    fixtureOutPath,
    hypothesesOutPath,
    judgeOutPath,
    summaryOutPath,
    resume: false,
    force: false,
    skipJudge: false,
    granularity: 'session',
    retrievalMode: 'hybrid',
    strategy: 'fast',
    hybridSessionWeight: 1.75,
    hybridTurnWeight: 5,
    expandPreferenceQueries: true,
    temporalDateBoost: true,
    includeAbstention: false,
    readerCommand: 'npx',
    readerArgs: ['tsx', 'scripts/longmemeval-codex-reader.ts'],
    readerTimeoutMs: parseTimeoutEnv('LONGMEMEVAL_BATCH_READER_TIMEOUT_MS', DEFAULT_READER_TIMEOUT_MS),
    judgeCommand: 'npx',
    judgeArgs: ['tsx', 'scripts/longmemeval-codex-judge.ts'],
    judgeTimeoutMs: parseTimeoutEnv('LONGMEMEVAL_BATCH_JUDGE_TIMEOUT_MS', DEFAULT_JUDGE_TIMEOUT_MS),
    topK: 10
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      throw new CliHelp(usage());
    } else if (arg === '--input' || arg === '--in-file') {
      parsed.inputPath = readOptionValue(argv, ++i, arg);
    } else if (arg === '--out-dir') {
      outDir = readOptionValue(argv, ++i, arg);
    } else if (arg === '--checkpoint') {
      checkpointPath = readOptionValue(argv, ++i, arg);
    } else if (arg === '--retrieval-report-out') {
      retrievalReportPath = readOptionValue(argv, ++i, arg);
    } else if (arg === '--fixture-out') {
      fixtureOutPath = readOptionValue(argv, ++i, arg);
    } else if (arg === '--hypotheses-out' || arg === '--answers-out') {
      hypothesesOutPath = readOptionValue(argv, ++i, arg);
    } else if (arg === '--judge-out') {
      judgeOutPath = readOptionValue(argv, ++i, arg);
    } else if (arg === '--summary-out') {
      summaryOutPath = readOptionValue(argv, ++i, arg);
    } else if (arg === '--resume') {
      parsed.resume = true;
    } else if (arg === '--force') {
      parsed.force = true;
    } else if (arg === '--skip-judge' || arg === '--reader-only') {
      parsed.skipJudge = true;
    } else if (arg === '--limit') {
      parsed.limit = parsePositiveInteger(readOptionValue(argv, ++i, arg), arg);
    } else if (arg === '--top-k' || arg === '--topK') {
      parsed.topK = parsePositiveInteger(readOptionValue(argv, ++i, arg), arg);
    } else if (arg === '--granularity') {
      const value = readOptionValue(argv, ++i, arg);
      if (value !== 'session' && value !== 'turn') throw new CliError(`Invalid --granularity: ${value}`);
      parsed.granularity = value;
    } else if (arg === '--retrieval-mode') {
      const value = readOptionValue(argv, ++i, arg);
      if (value !== 'single' && value !== 'hybrid') throw new CliError(`Invalid --retrieval-mode: ${value}`);
      parsed.retrievalMode = value;
    } else if (arg === '--strategy') {
      const value = readOptionValue(argv, ++i, arg);
      if (value !== 'auto' && value !== 'fast' && value !== 'deep') throw new CliError(`Invalid --strategy: ${value}`);
      parsed.strategy = value;
    } else if (arg === '--hybrid-session-weight') {
      parsed.hybridSessionWeight = parsePositiveNumber(readOptionValue(argv, ++i, arg), arg);
    } else if (arg === '--hybrid-turn-weight') {
      parsed.hybridTurnWeight = parsePositiveNumber(readOptionValue(argv, ++i, arg), arg);
    } else if (arg === '--expand-preference-queries') {
      parsed.expandPreferenceQueries = true;
    } else if (arg === '--no-expand-preference-queries') {
      parsed.expandPreferenceQueries = false;
    } else if (arg === '--temporal-date-boost') {
      parsed.temporalDateBoost = true;
    } else if (arg === '--no-temporal-date-boost') {
      parsed.temporalDateBoost = false;
    } else if (arg === '--include-abstention') {
      parsed.includeAbstention = true;
    } else if (arg === '--skip-abstention') {
      parsed.includeAbstention = false;
    } else if (arg === '--reader-command') {
      parsed.readerCommand = readOptionValue(argv, ++i, arg);
      if (!customReaderCommand) parsed.readerArgs = [];
      customReaderCommand = true;
    } else if (arg === '--reader-arg') {
      parsed.readerArgs.push(readRawOptionValue(argv, ++i, arg));
    } else if (arg === '--reader-timeout-ms') {
      parsed.readerTimeoutMs = parsePositiveInteger(readOptionValue(argv, ++i, arg), arg);
    } else if (arg === '--judge-command') {
      parsed.judgeCommand = readOptionValue(argv, ++i, arg);
      if (!customJudgeCommand) parsed.judgeArgs = [];
      customJudgeCommand = true;
    } else if (arg === '--judge-arg') {
      parsed.judgeArgs.push(readRawOptionValue(argv, ++i, arg));
    } else if (arg === '--judge-timeout-ms') {
      parsed.judgeTimeoutMs = parsePositiveInteger(readOptionValue(argv, ++i, arg), arg);
    } else if (arg.startsWith('--')) {
      throw new CliError(`Unknown option: ${arg}\n\n${usage()}`);
    } else if (!parsed.inputPath) {
      parsed.inputPath = arg;
    } else {
      throw new CliError(`Unexpected positional argument: ${arg}\n\n${usage()}`);
    }
  }

  if (!parsed.inputPath) {
    throw new CliError(`Missing required --input path.\n\n${usage()}`);
  }
  if (!outDir) {
    outDir = path.resolve(cwd, 'benchmarks/longmemeval/runs/codex-full-batch');
  }
  parsed.outDir = path.resolve(cwd, outDir);
  parsed.checkpointPath = checkpointPath ? path.resolve(cwd, checkpointPath) : path.join(parsed.outDir, 'checkpoint.json');
  parsed.retrievalReportPath = retrievalReportPath ? path.resolve(cwd, retrievalReportPath) : path.join(parsed.outDir, 'retrieval-report.json');
  parsed.fixtureOutPath = fixtureOutPath ? path.resolve(cwd, fixtureOutPath) : path.join(parsed.outDir, 'fixture.json');
  parsed.hypothesesOutPath = hypothesesOutPath ? path.resolve(cwd, hypothesesOutPath) : path.join(parsed.outDir, 'hypotheses.jsonl');
  parsed.judgeOutPath = judgeOutPath ? path.resolve(cwd, judgeOutPath) : path.join(parsed.outDir, 'eval-results-codex.jsonl');
  parsed.summaryOutPath = summaryOutPath ? path.resolve(cwd, summaryOutPath) : path.join(parsed.outDir, 'summary.json');
  parsed.inputPath = path.resolve(cwd, parsed.inputPath);
  validatePathSafety(parsed);
  return parsed;
}

function validatePathSafety(options: ParsedArgs): void {
  if (options.resume && options.force) {
    throw new CliError('Cannot combine --resume and --force; resume an existing run or force a restart, not both');
  }
  const outputs = new Map<string, string>();
  for (const [label, filePath] of Object.entries({
    checkpoint: options.checkpointPath,
    retrieval_report: options.retrievalReportPath,
    fixture: options.fixtureOutPath,
    hypotheses: options.hypothesesOutPath,
    judge_results: options.judgeOutPath,
    summary: options.summaryOutPath
  })) {
    if (path.resolve(filePath) === options.inputPath) {
      throw new CliError(`Refusing to use input file as ${label} output: ${filePath}`);
    }
    const previous = outputs.get(filePath);
    if (previous) {
      throw new CliError(`Managed output path collision between ${previous} and ${label}: ${filePath}`);
    }
    outputs.set(filePath, label);
  }
}

function buildRunOptionsFingerprint(options: ParsedArgs): Record<string, unknown> {
  return {
    input_path: options.inputPath,
    files: {
      retrieval_report: options.retrievalReportPath,
      fixture: options.fixtureOutPath,
      hypotheses: options.hypothesesOutPath,
      judge_results: options.judgeOutPath,
      summary: options.summaryOutPath,
      checkpoint: options.checkpointPath
    },
    retrieval: {
      granularity: options.granularity,
      retrieval_mode: options.retrievalMode,
      strategy: options.strategy,
      limit: options.limit ?? null,
      top_k: options.topK,
      hybrid_session_weight: options.hybridSessionWeight,
      hybrid_turn_weight: options.hybridTurnWeight,
      expand_preference_queries: options.expandPreferenceQueries,
      temporal_date_boost: options.temporalDateBoost,
      include_abstention: options.includeAbstention
    }
  };
}

function normalizeCheckpointRunOptions(
  runOptions: Record<string, unknown>,
  checkpoint: Record<string, unknown>,
  options: ParsedArgs
): Record<string, unknown> {
  if (!isRecord(runOptions.files) || runOptions.files.summary !== undefined) {
    return runOptions;
  }
  const summary = isRecord(checkpoint.files) && typeof checkpoint.files.summary === 'string'
    ? checkpoint.files.summary
    : defaultSummaryOutPath(options) === options.summaryOutPath
      ? options.summaryOutPath
      : undefined;
  if (summary === undefined) return runOptions;
  return {
    ...runOptions,
    files: {
      ...runOptions.files,
      summary
    }
  };
}

function defaultSummaryOutPath(options: ParsedArgs): string {
  return path.join(options.outDir, 'summary.json');
}

function collectObjectMismatches(actual: unknown, expected: unknown, pathPrefix: string): string[] {
  if (isRecord(expected)) {
    if (!isRecord(actual)) return [pathPrefix];
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    const mismatches: string[] = [];
    for (const key of [...keys].sort()) {
      mismatches.push(...collectObjectMismatches(actual[key], expected[key], `${pathPrefix}.${key}`));
    }
    return mismatches;
  }
  return Object.is(actual, expected) ? [] : [pathPrefix];
}

function parseTimeoutEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  return value ? parsePositiveInteger(value, name) : fallback;
}

function readOptionValue(argv: string[], index: number, optionName: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new CliError(`Missing value for ${optionName}`);
  }
  return value;
}

function readRawOptionValue(argv: string[], index: number, optionName: string): string {
  const value = argv[index];
  if (value === undefined) {
    throw new CliError(`Missing value for ${optionName}`);
  }
  return value;
}

function parsePositiveInteger(value: string, optionName: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new CliError(`Invalid ${optionName}: expected a positive integer, got ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliError(`Invalid ${optionName}: expected a positive integer, got ${value}`);
  }
  return parsed;
}

function parsePositiveNumber(value: string, optionName: string): number {
  if (!/^(?:0?\.\d+|[1-9]\d*(?:\.\d+)?)$/.test(value)) {
    throw new CliError(`Invalid ${optionName}: expected a positive number, got ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliError(`Invalid ${optionName}: expected a positive number, got ${value}`);
  }
  return parsed;
}

function redactKnownSecrets(input: string): string {
  let output = input;
  for (const value of collectSecretEnvValues()) {
    output = output.split(value).join('[REDACTED]');
  }
  output = output.replace(/\b(api[_-]?key|token|secret|password|client[_-]?secret)\s*[:=]\s*[^\s;&]+/gi, '$1=[REDACTED]');
  output = output.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]');
  output = output.replace(/\b(?:sk|gh[pousr]|github_pat)_[A-Za-z0-9_]{12,}\b/g, '[REDACTED]');
  return output;
}

function collectSecretEnvValues(): string[] {
  const values = new Set<string>();
  for (const [key, rawValue] of Object.entries(process.env)) {
    if (!rawValue || rawValue.length < 8) continue;
    if (!/(api|key|token|secret|password|credential|auth)/i.test(key)) continue;
    if (/^(true|false|null|undefined|none|placeholder|redacted)$/i.test(rawValue)) continue;
    values.add(rawValue);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function usage(): string {
  return `LongMemEval Codex-compatible full batch runner

Usage:
  npx tsx scripts/longmemeval-codex-batch.ts --input longmemeval_s_cleaned.json --out-dir /tmp/LongMemEval/cml-codex-run [options]

Runs the current CML LongMemEval retrieval smoke, then generates reader hypotheses and optional Codex-compatible judge rows with incremental JSONL checkpoints. This is designed for long Codex subscription runs where interruption is likely. Use --resume to continue from existing checkpoint/output files without duplicating completed question_ids.

Options:
  --input PATH                 LongMemEval cleaned JSON array.
  --out-dir DIR                Run directory. Default: benchmarks/longmemeval/runs/codex-full-batch.
  --checkpoint PATH            Checkpoint JSON path. Default: OUT_DIR/checkpoint.json.
  --retrieval-report-out PATH  Retrieval JSON report path. Default: OUT_DIR/retrieval-report.json.
  --fixture-out PATH           Converted replay fixture path. Default: OUT_DIR/fixture.json.
  --hypotheses-out PATH        Reader hypothesis JSONL path. Default: OUT_DIR/hypotheses.jsonl.
  --judge-out PATH             Codex-compatible judge JSONL path. Default: OUT_DIR/eval-results-codex.jsonl.
  --summary-out PATH           Compact score/breakdown JSON path. Default: OUT_DIR/summary.json.
  --resume                     Reuse existing retrieval artifacts and skip completed hypothesis/judge rows by question_id.
  --force                      Delete managed output files before starting.
  --skip-judge                 Stop after reader hypotheses; checkpoint status becomes reader_complete.
  --limit N                    Limit examples passed to retrieval smoke.
  --top-k N                    Retrieval cutoff. Default: 10.
  --granularity session|turn   Retrieval fixture granularity. Default: session.
  --retrieval-mode single|hybrid
                               Default: hybrid.
  --strategy auto|fast|deep    CML retrieval strategy. Default: fast.
  --hybrid-session-weight N    Default: 1.75.
  --hybrid-turn-weight N       Default: 5.
  --expand-preference-queries / --no-expand-preference-queries
                               Default: enabled.
  --temporal-date-boost / --no-temporal-date-boost
                               Default: enabled.
  --include-abstention / --skip-abstention
                               Default: skip abstention, matching retrieval smoke reporting.
  --reader-command PATH        Reader executable. Default: npx tsx scripts/longmemeval-codex-reader.ts.
  --reader-arg VALUE           Extra reader arg. Repeatable.
  --reader-timeout-ms N        Outer per-question reader timeout. Env: LONGMEMEVAL_BATCH_READER_TIMEOUT_MS.
  --judge-command PATH         Judge executable. Default: npx tsx scripts/longmemeval-codex-judge.ts.
  --judge-arg VALUE            Extra judge arg before --hyp/--ref/--out. Repeatable.
  --judge-timeout-ms N         Outer per-question judge timeout. Env: LONGMEMEVAL_BATCH_JUDGE_TIMEOUT_MS.

Default output files:
  OUT_DIR/checkpoint.json
  OUT_DIR/retrieval-report.json
  OUT_DIR/fixture.json
  OUT_DIR/hypotheses.jsonl
  OUT_DIR/eval-results-codex.jsonl
  OUT_DIR/summary.json

Notes:
  - Reader and judge prompts are piped through stdin by the existing Codex wrappers.
  - The judge is Codex-compatible, not the unmodified upstream official LongMemEval evaluator.
  - A full LongMemEval_S non-abstention run is roughly 470 reader calls plus 470 judge calls.
`;
}
