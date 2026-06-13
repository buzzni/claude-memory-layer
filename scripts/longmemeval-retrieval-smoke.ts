#!/usr/bin/env tsx
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import {
  evaluateReplayFixture,
  formatReplayEvaluationMarkdown,
  createReplayRetrievalRunner,
  type ReplayEvaluationFixture,
  type ReplayEvaluationReport,
  type ReplayRetrievalRunner
} from '../src/core/replay-evaluator.js';
import {
  longMemEvalEntriesToReplayFixture,
  type LongMemEvalEntry,
  type LongMemEvalGranularity
} from '../src/core/longmemeval-adapter.js';
import {
  analyzeLongMemEvalRetrievalReport,
  formatLongMemEvalAnalysisMarkdown,
  type LongMemEvalRetrievalAnalysis
} from '../src/core/longmemeval-analysis.js';
import {
  createLongMemEvalHybridRetrievalRunner
} from '../src/core/longmemeval-hybrid-retrieval.js';
import type { RetrievalStrategy } from '../src/core/retriever.js';

interface ParsedArgs {
  inputPath: string;
  outPath: string;
  answersOutPath: string;
  fixtureOutPath: string;
  format: 'json' | 'markdown';
  granularity: LongMemEvalGranularity;
  includeAbstention: boolean;
  isolatePerQuestion: boolean;
  includePerQuery: boolean;
  retrievalMode: 'single' | 'hybrid';
  hybridSessionWeight: number;
  hybridTurnWeight: number;
  expandUserFacts: boolean;
  expandUserFactsToSearchContent: boolean;
  expandPreferenceQueries: boolean;
  expandTemporalQueries: boolean;
  temporalDateBoost: boolean;
  readerCommand: string;
  readerArgs: string[];
  limit?: number;
  topK?: number;
  strategy?: RetrievalStrategy;
  minScore?: number;
}

interface LongMemEvalHypothesis {
  question_id: string;
  hypothesis: string;
}

interface LongMemEvalReaderContext {
  id: string;
  rank: number;
  content: string;
}

interface LongMemEvalReaderPayload {
  question_id: string;
  question: string;
  category?: string;
  contexts: LongMemEvalReaderContext[];
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
  const entries = parseLongMemEvalEntries(await readFile(options.inputPath, 'utf8'), options.inputPath);
  const fixture = longMemEvalEntriesToReplayFixture(entries, {
    name: `longmemeval-${options.granularity}-retrieval-smoke`,
    description: 'LongMemEval retrieval-only smoke converted into the CML replay evaluator shape.',
    granularity: options.granularity,
    maxEntries: options.limit,
    includeAbstention: options.includeAbstention,
    expandUserFacts: options.expandUserFacts,
    expandUserFactsToSearchContent: options.expandUserFactsToSearchContent,
    expandPreferenceQueries: options.expandPreferenceQueries,
    expandTemporalQueries: options.expandTemporalQueries,
    temporalDateBoost: options.temporalDateBoost,
    ks: buildEvaluationKs(options.topK),
    sourceFileCount: 1
  });
  const hybridTurnFixture = options.retrievalMode === 'hybrid'
    ? longMemEvalEntriesToReplayFixture(entries, {
      name: 'longmemeval-turn-retrieval-smoke-hybrid-source',
      description: 'Turn-level LongMemEval fixture used internally for hybrid session retrieval.',
      granularity: 'turn',
      maxEntries: options.limit,
      includeAbstention: options.includeAbstention,
      expandUserFacts: options.expandUserFacts,
      expandUserFactsToSearchContent: options.expandUserFactsToSearchContent,
      expandPreferenceQueries: options.expandPreferenceQueries,
      expandTemporalQueries: options.expandTemporalQueries,
      temporalDateBoost: options.temporalDateBoost,
      ks: buildEvaluationKs(options.topK),
      sourceFileCount: 1
    })
    : undefined;

  if (options.fixtureOutPath) {
    await writeTextFile(options.fixtureOutPath, `${JSON.stringify(fixture, null, 2)}\n`);
  }

  const retrievalRunner = createLongMemEvalRetrievalRunner(fixture, options, hybridTurnFixture);
  const report = await evaluateReplayFixture(fixture, {
    evaluator: buildEvaluatorName(options),
    includePerQuery: true,
    topK: options.topK,
    retrievalOptions: {
      ...(options.strategy ? { strategy: options.strategy } : {}),
      ...(options.minScore !== undefined ? { minScore: options.minScore } : {})
    },
    retrievalRunner
  });

  const analysis = analyzeLongMemEvalRetrievalReport(report, { k: options.topK ?? Math.max(...fixture.ks) });
  if (options.answersOutPath) {
    const hypotheses = await generateLongMemEvalHypotheses(fixture, report, options);
    await writeTextFile(options.answersOutPath, formatLongMemEvalHypothesesJsonl(hypotheses));
  }
  const outputReport = options.includePerQuery ? report : { ...report, perQuery: [] };
  const output = formatReport(outputReport, options.format, options.inputPath, analysis);
  if (options.outPath) {
    await writeTextFile(options.outPath, output);
  } else {
    process.stdout.write(output);
  }
}

function createLongMemEvalRetrievalRunner(
  fixture: ReplayEvaluationFixture,
  options: ParsedArgs,
  hybridTurnFixture?: ReplayEvaluationFixture
): ReplayRetrievalRunner | undefined {
  if (options.retrievalMode === 'hybrid') {
    if (options.granularity !== 'session') {
      throw new CliError('Hybrid retrieval currently evaluates session-level qrels; use --granularity session with --retrieval-mode hybrid.');
    }
    if (!hybridTurnFixture) {
      throw new CliError('Internal error: hybrid retrieval requires a turn-level fixture.');
    }
    return createLongMemEvalHybridRetrievalRunner({
      sessionFixture: fixture,
      turnFixture: hybridTurnFixture,
      sessionRunner: options.isolatePerQuestion ? createPerQuestionRetrievalRunner(fixture) : undefined,
      turnRunner: options.isolatePerQuestion ? createPerQuestionRetrievalRunner(hybridTurnFixture) : undefined,
      sessionWeight: options.hybridSessionWeight,
      turnWeight: options.hybridTurnWeight
    });
  }
  return options.isolatePerQuestion ? createPerQuestionRetrievalRunner(fixture) : undefined;
}

function buildEvaluationKs(topK: number | undefined): number[] {
  const maxK = topK ?? 10;
  const candidates = [1, 5, 10, ...(topK === undefined ? [] : [topK])];
  return [...new Set(candidates
    .map((k) => Math.floor(k))
    .filter((k) => k > 0 && k <= maxK))]
    .sort((a, b) => a - b);
}

function buildEvaluatorName(options: ParsedArgs): string {
  const corpus = options.isolatePerQuestion ? 'isolated' : 'global';
  const mode = options.retrievalMode === 'hybrid' ? 'hybrid' : options.granularity;
  return `cml-retriever-longmemeval-${mode}-${corpus}-v1`;
}

function createPerQuestionRetrievalRunner(fixture: ReplayEvaluationFixture): ReplayRetrievalRunner {
  const runnerByQueryId = new Map<string, ReplayRetrievalRunner>();

  return async (query, input) => {
    const queryId = input.query.queryId;
    let runner = runnerByQueryId.get(queryId);
    if (!runner) {
      const scopedMemories = fixture.memories.filter((memory) => memory.metadata?.questionId === queryId);
      const scopedFixture: ReplayEvaluationFixture = {
        ...fixture,
        queries: [input.query],
        memories: scopedMemories.length > 0 ? scopedMemories : fixture.memories
      };
      runner = createReplayRetrievalRunner(scopedFixture);
      runnerByQueryId.set(queryId, runner);
    }
    return runner(query, input);
  };
}

async function generateLongMemEvalHypotheses(
  fixture: ReplayEvaluationFixture,
  report: ReplayEvaluationReport,
  options: ParsedArgs
): Promise<LongMemEvalHypothesis[]> {
  const memoryById = new Map(fixture.memories.map((memory) => [memory.id, memory]));
  const metricByQueryId = new Map(report.perQuery.map((metric) => [metric.queryId, metric]));

  const hypotheses: LongMemEvalHypothesis[] = [];
  for (const query of fixture.queries) {
    const metric = metricByQueryId.get(query.queryId);
    const contexts = (metric?.retrievedIds ?? [])
      .map((id, index): LongMemEvalReaderContext | undefined => {
        const memory = memoryById.get(id);
        if (!memory) return undefined;
        return {
          id,
          rank: index + 1,
          content: memory.content
        };
      })
      .filter((context): context is LongMemEvalReaderContext => context !== undefined);

    const payload: LongMemEvalReaderPayload = {
      question_id: query.queryId,
      question: query.query,
      contexts
    };
    if (query.category !== undefined) {
      payload.category = query.category;
    }

    const hypothesis = await runReaderCommand(options.readerCommand, options.readerArgs, payload);
    hypotheses.push({
      question_id: query.queryId,
      hypothesis: hypothesis.trim() || 'I do not know'
    });
  }

  return hypotheses;
}

function formatLongMemEvalHypothesesJsonl(hypotheses: LongMemEvalHypothesis[]): string {
  return `${hypotheses.map((hypothesis) => JSON.stringify(hypothesis)).join('\n')}\n`;
}

function runReaderCommand(command: string, args: string[], payload: LongMemEvalReaderPayload): Promise<string> {
  const timeoutMs = 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let stdinError: Error | undefined;

    const finish = (error: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(value ?? '');
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.stdin.on('error', (error: Error & { code?: string }) => {
      stdinError = error;
      if (error.code !== 'EPIPE') {
        finish(new CliError(`Reader command stdin write failed for ${payload.question_id}: ${error.message}`));
      }
    });
    child.on('error', (error) => {
      finish(new CliError(`Reader command failed for ${payload.question_id}: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish(new CliError(`Reader command timed out for ${payload.question_id} after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        const detail = redactKnownSecrets(stderr.trim(), readerSecretValues(process.env)).slice(0, 2_000);
        finish(new CliError(`Reader command failed for ${payload.question_id} with exit code ${code ?? `signal ${signal ?? 'unknown'}`}${detail ? `: ${detail}` : ''}`));
        return;
      }
      if (stdinError) {
        finish(new CliError(`Reader command stdin write failed for ${payload.question_id}: ${stdinError.message}`));
        return;
      }
      finish(null, stdout.trim());
    });

    child.stdin.end(`${JSON.stringify(payload)}\n`, 'utf8');
  });
}

function readerSecretValues(env: Record<string, string | undefined>): string[] {
  return [env.LONGMEMEVAL_READER_API_KEY, env.OPENAI_API_KEY]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function redactKnownSecrets(value: string, secrets: string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length < 2) continue;
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    inputPath: '',
    outPath: '',
    answersOutPath: '',
    fixtureOutPath: '',
    format: 'markdown',
    granularity: 'session',
    includeAbstention: false,
    isolatePerQuestion: true,
    includePerQuery: true,
    retrievalMode: 'hybrid',
    hybridSessionWeight: 1,
    hybridTurnWeight: 1.5,
    expandUserFacts: false,
    expandUserFactsToSearchContent: false,
    expandPreferenceQueries: false,
    expandTemporalQueries: false,
    temporalDateBoost: false,
    readerCommand: '',
    readerArgs: [],
    strategy: 'fast',
    topK: 10
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' || arg === '--in-file') {
      parsed.inputPath = readOptionValue(argv, ++i, arg);
    } else if (arg === '--out' || arg === '--report-out') {
      parsed.outPath = readOptionValue(argv, ++i, arg);
    } else if (arg === '--answers-out') {
      parsed.answersOutPath = readOptionValue(argv, ++i, arg);
    } else if (arg === '--reader-command') {
      parsed.readerCommand = readOptionValue(argv, ++i, arg);
    } else if (arg === '--reader-arg') {
      parsed.readerArgs.push(readOptionValue(argv, ++i, arg));
    } else if (arg === '--fixture-out') {
      parsed.fixtureOutPath = readOptionValue(argv, ++i, arg);
    } else if (arg === '--format') {
      const value = readOptionValue(argv, ++i, arg);
      if (value !== 'json' && value !== 'markdown') {
        throw new CliError(`Invalid --format: expected json or markdown, got ${value}`);
      }
      parsed.format = value;
    } else if (arg === '--granularity') {
      const value = readOptionValue(argv, ++i, arg);
      if (value !== 'session' && value !== 'turn') {
        throw new CliError(`Invalid --granularity: expected session or turn, got ${value}`);
      }
      parsed.granularity = value;
    } else if (arg === '--limit') {
      parsed.limit = parseNonNegativeInteger(readOptionValue(argv, ++i, arg), arg);
    } else if (arg === '--top-k' || arg === '--topK') {
      parsed.topK = parseNonNegativeInteger(readOptionValue(argv, ++i, arg), arg, { min: 1 });
    } else if (arg === '--strategy') {
      const value = readOptionValue(argv, ++i, arg);
      if (value !== 'auto' && value !== 'fast' && value !== 'deep') {
        throw new CliError(`Invalid --strategy: expected auto, fast, or deep, got ${value}`);
      }
      parsed.strategy = value;
    } else if (arg === '--retrieval-mode') {
      const value = readOptionValue(argv, ++i, arg);
      if (value !== 'single' && value !== 'hybrid') {
        throw new CliError(`Invalid --retrieval-mode: expected single or hybrid, got ${value}`);
      }
      parsed.retrievalMode = value;
    } else if (arg === '--hybrid-retrieval') {
      parsed.retrievalMode = 'hybrid';
    } else if (arg === '--hybrid-session-weight') {
      parsed.hybridSessionWeight = parsePositiveNumber(readOptionValue(argv, ++i, arg), arg);
    } else if (arg === '--hybrid-turn-weight') {
      parsed.hybridTurnWeight = parsePositiveNumber(readOptionValue(argv, ++i, arg), arg);
    } else if (arg === '--min-score') {
      parsed.minScore = parseRate(readOptionValue(argv, ++i, arg), arg);
    } else if (arg === '--expand-user-facts') {
      parsed.expandUserFacts = true;
    } else if (arg === '--no-expand-user-facts') {
      parsed.expandUserFacts = false;
    } else if (arg === '--expand-user-facts-to-search-content') {
      parsed.expandUserFactsToSearchContent = true;
    } else if (arg === '--no-expand-user-facts-to-search-content') {
      parsed.expandUserFactsToSearchContent = false;
    } else if (arg === '--expand-preference-queries') {
      parsed.expandPreferenceQueries = true;
    } else if (arg === '--no-expand-preference-queries') {
      parsed.expandPreferenceQueries = false;
    } else if (arg === '--expand-temporal-queries') {
      parsed.expandTemporalQueries = true;
    } else if (arg === '--no-expand-temporal-queries') {
      parsed.expandTemporalQueries = false;
    } else if (arg === '--temporal-date-boost') {
      parsed.temporalDateBoost = true;
    } else if (arg === '--no-temporal-date-boost') {
      parsed.temporalDateBoost = false;
    } else if (arg === '--include-abstention') {
      parsed.includeAbstention = true;
    } else if (arg === '--skip-abstention') {
      parsed.includeAbstention = false;
    } else if (arg === '--global-corpus') {
      parsed.isolatePerQuestion = false;
    } else if (arg === '--isolate-per-question') {
      parsed.isolatePerQuestion = true;
    } else if (arg === '--no-per-query') {
      parsed.includePerQuery = false;
    } else if (arg === '--help' || arg === '-h') {
      throw new CliHelp(usage());
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
  if (parsed.answersOutPath && !parsed.readerCommand) {
    throw new CliError('--reader-command is required when --answers-out is set');
  }

  return parsed;
}

function parseLongMemEvalEntries(raw: string, inputPath: string): LongMemEvalEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliError(`Failed to parse ${inputPath} as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (Array.isArray(parsed)) {
    return parsed as LongMemEvalEntry[];
  }
  if (parsed !== null && typeof parsed === 'object') {
    const object = parsed as Record<string, unknown>;
    if (Array.isArray(object.data)) return object.data as LongMemEvalEntry[];
    if (Array.isArray(object.examples)) return object.examples as LongMemEvalEntry[];
  }
  throw new CliError(`Invalid LongMemEval input ${inputPath}: expected a JSON array or an object with data/examples array`);
}

function formatReport(
  report: ReplayEvaluationReport,
  format: ParsedArgs['format'],
  inputPath: string,
  analysis: LongMemEvalRetrievalAnalysis
): string {
  if (format === 'json') {
    return `${JSON.stringify({ ...report, longMemEvalAnalysis: analysis }, null, 2)}\n`;
  }
  return `${formatReplayEvaluationMarkdown(report, { qrelsPath: inputPath })}\n${formatLongMemEvalAnalysisMarkdown(analysis)}`;
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

function readOptionValue(argv: string[], index: number, optionName: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new CliError(`Missing value for ${optionName}`);
  }
  return value;
}

function parseRate(value: string, optionName: string): number {
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)) {
    throw new CliError(`Invalid ${optionName}: expected a number between 0 and 1, got ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new CliError(`Invalid ${optionName}: expected a number between 0 and 1, got ${value}`);
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

function parseNonNegativeInteger(value: string, optionName: string, bounds: { min?: number } = {}): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new CliError(`Invalid ${optionName}: expected a non-negative integer, got ${value}`);
  }
  const parsed = Number(value);
  const min = bounds.min ?? 0;
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new CliError(`Invalid ${optionName}: expected an integer >= ${min}, got ${value}`);
  }
  return parsed;
}

function usage(): string {
  return `Usage: tsx scripts/longmemeval-retrieval-smoke.ts --input /path/to/longmemeval_s_cleaned.json [options]

Options:
  --limit N                 Evaluate only the first N examples after abstention filtering.
  --granularity session|turn Convert session-level or turn-level qrels. Default: session.
  --top-k N                 Retrieval cutoff passed to the CML replay evaluator. Default: 10.
  --strategy auto|fast|deep CML retrieval strategy. Default: fast.
  --retrieval-mode single|hybrid
                            Benchmark fixture mode. hybrid evaluates session qrels with session+turn replay retrieval. Default: hybrid.
                            This is distinct from production MCP retrievalMode=session-event-hybrid.
  --hybrid-retrieval        Shortcut for --retrieval-mode hybrid.
  --hybrid-session-weight RATE
                            Session-level rank-fusion weight for hybrid mode. Default: 1.
  --hybrid-turn-weight RATE Turn-level rank-fusion weight for hybrid mode. Default: 1.5.
  --expand-user-facts       Append answer-independent user preference/fact summaries extracted from haystack text.
  --no-expand-user-facts    Disable user-fact expansion. Default.
  --expand-user-facts-to-search-content
                            Append user preference/fact summaries to private replay searchContent only; reader context remains raw.
  --no-expand-user-facts-to-search-content
                            Disable private searchContent user-fact expansion. Default.
  --expand-preference-queries
                            Append retrieval-only preference/context hint terms to single-session-preference questions.
  --no-expand-preference-queries
                            Disable preference query expansion. Default.
  --expand-temporal-queries
                            Append question-date and temporal relation hint terms to temporal-reasoning questions.
  --no-expand-temporal-queries
                            Disable temporal query expansion. Default.
  --temporal-date-boost    Attach structured question-date metadata and rerank explicit relative-date temporal hits without appending date tokens.
  --no-temporal-date-boost Disable temporal date boost. Default.
  --min-score RATE          Override retriever minScore.
  --include-abstention      Include *_abs questions as no-match qrels.
  --skip-abstention         Skip *_abs questions, matching LongMemEval retrieval reporting. Default.
  --global-corpus           Search all converted memories together. Default isolates each question's haystack.
  --answers-out PATH        Write LongMemEval-compatible JSONL hypotheses: {"question_id","hypothesis"}.
  --reader-command PATH     Executable reader/model wrapper. Receives JSON on stdin with question and retrieved contexts; writes hypothesis text to stdout.
  --reader-arg VALUE        Extra argument for --reader-command. Repeat for multiple args.
  --fixture-out PATH        Write the converted replay fixture JSON.
  --out PATH                Write the report instead of stdout.
  --format json|markdown    Report format. Default: markdown.
  --no-per-query            Omit per-query rows from the report.
`;
}
