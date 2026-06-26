#!/usr/bin/env tsx
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

interface ParsedArgs {
  hypPath: string;
  refPath: string;
  outPath: string;
  checkpointPath: string;
  resume: boolean;
  force: boolean;
}

interface HypothesisRow {
  question_id: string;
  hypothesis: string;
  [key: string]: unknown;
}

interface ReferenceRow {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  [key: string]: unknown;
}

interface EvaluatedRow extends HypothesisRow {
  autoeval_label: {
    model: 'codex-cli';
    label: boolean;
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

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_SANDBOX = 'read-only';
const ALLOWED_SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const CHECKPOINT_VERSION = 1;

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
  const timeoutMs = parsePositiveInteger(readEnv('LONGMEMEVAL_CODEX_TIMEOUT_MS'), DEFAULT_TIMEOUT_MS, 'LONGMEMEVAL_CODEX_TIMEOUT_MS', MAX_TIMEOUT_MS);
  const hypRaw = await readFile(options.hypPath, 'utf8');
  const refRaw = await readFile(options.refPath, 'utf8');
  const runFingerprint = buildRunOptionsFingerprint(options, hypRaw, refRaw);
  const hypotheses = parseHypotheses(hypRaw, options.hypPath);
  const references = parseReferences(refRaw, options.refPath);
  assertUniqueIds(hypotheses, 'hypothesis');
  assertUniqueIds(references, 'reference');
  if (hypotheses.length === 0) {
    throw new CliError('Hypothesis file contains no rows to evaluate');
  }
  const qidToReference = new Map(references.map((reference) => [reference.question_id, reference]));
  for (const hypothesis of hypotheses) {
    if (!qidToReference.has(hypothesis.question_id)) {
      throw new CliError(`${hypothesis.question_id} is not in reference data`);
    }
  }

  const resumeCheckpoint = await prepareCheckpointedRun(options, hypotheses.length, runFingerprint);
  const evaluatedById = options.resume
    ? await readEvaluatedRowsByQuestionId(options.outPath, hypotheses)
    : new Map<string, EvaluatedRow>();
  if (options.resume && resumeCheckpoint) {
    validateResumeOutputConsistency(resumeCheckpoint, hypotheses.length, evaluatedById.size);
  }
  await writeCheckpoint(options, 'judge_running', hypotheses.length, evaluatedById.size, runFingerprint);

  for (const hypothesis of hypotheses) {
    if (evaluatedById.has(hypothesis.question_id)) continue;
    const reference = qidToReference.get(hypothesis.question_id);
    if (!reference) {
      throw new CliError(`${hypothesis.question_id} is not in reference data`);
    }
    try {
      const prompt = getAnscheckPrompt(
        reference.question_type,
        reference.question,
        reference.answer,
        hypothesis.hypothesis,
        hypothesis.question_id.includes('_abs')
      );
      const evalResponse = await runCodexPrompt(prompt, timeoutMs);
      const label = parseJudgeLabel(evalResponse);
      const evaluated: EvaluatedRow = {
        ...hypothesis,
        autoeval_label: {
          model: 'codex-cli',
          label
        }
      };
      await appendJsonlRow(options.outPath, evaluated);
      evaluatedById.set(hypothesis.question_id, evaluated);
      await writeCheckpoint(options, 'judge_running', hypotheses.length, evaluatedById.size, runFingerprint);
    } catch (error) {
      await writeCheckpoint(options, 'judge_failed', hypotheses.length, evaluatedById.size, runFingerprint).catch(() => undefined);
      const detail = error instanceof Error ? error.message : String(error);
      throw new CliError(`Codex judge failed for ${hypothesis.question_id}: ${detail}`);
    }
  }

  const evaluated = hypotheses.map((hypothesis) => evaluatedById.get(hypothesis.question_id)).filter((row): row is EvaluatedRow => row !== undefined);
  const allScores = evaluated.map((entry) => entry.autoeval_label.label ? 1 : 0);
  await writeCheckpoint(options, 'completed', hypotheses.length, evaluated.length, runFingerprint);
  process.stdout.write(`Accuracy: ${round4(mean(allScores))}\n`);
  for (const [category, scores] of buildCategoryScores(references, evaluated).entries()) {
    if (scores.length === 0) continue;
    process.stdout.write(`\t${category}: ${round4(mean(scores))} (${scores.length})\n`);
  }
  process.stdout.write(`Saved to ${options.outPath}\n`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { hypPath: '', refPath: '', outPath: '', checkpointPath: '', resume: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--hyp' || arg === '--hyp-file') {
      parsed.hypPath = readOptionValue(argv, ++i, arg);
    } else if (arg === '--ref' || arg === '--ref-file') {
      parsed.refPath = readOptionValue(argv, ++i, arg);
    } else if (arg === '--out') {
      parsed.outPath = readOptionValue(argv, ++i, arg);
    } else if (arg === '--checkpoint') {
      parsed.checkpointPath = readOptionValue(argv, ++i, arg);
    } else if (arg === '--resume') {
      parsed.resume = true;
    } else if (arg === '--force') {
      parsed.force = true;
    } else if (arg === '--help' || arg === '-h') {
      throw new CliHelp(usage());
    } else if (arg.startsWith('--')) {
      throw new CliError(`Unknown option: ${arg}\n\n${usage()}`);
    } else if (!parsed.hypPath) {
      parsed.hypPath = arg;
    } else if (!parsed.refPath) {
      parsed.refPath = arg;
    } else {
      throw new CliError(`Unexpected positional argument: ${arg}\n\n${usage()}`);
    }
  }
  if (!parsed.hypPath || !parsed.refPath) {
    throw new CliError(`Missing required --hyp/--ref path.\n\n${usage()}`);
  }
  if (!parsed.outPath) {
    parsed.outPath = `${parsed.hypPath}.eval-results-codex`;
  }
  if (!parsed.checkpointPath) {
    parsed.checkpointPath = `${parsed.outPath}.checkpoint.json`;
  }
  if (parsed.resume && parsed.force) {
    throw new CliError('Cannot combine --resume and --force');
  }
  return parsed;
}

type JudgeCheckpointStatus = 'judge_running' | 'judge_failed' | 'completed';

interface JudgeCheckpoint {
  version: number;
  status?: unknown;
  run_options?: unknown;
  judge?: unknown;
}

async function prepareCheckpointedRun(options: ParsedArgs, total: number, runFingerprint: Record<string, unknown>): Promise<JudgeCheckpoint | undefined> {
  assertSafeOutputPaths(options);
  if (options.resume) {
    return validateResumeCheckpoint(options, runFingerprint);
  }
  if (!options.force) {
    if (await fileExists(options.outPath)) {
      throw new CliError('Refusing to overwrite existing judge output; use --resume to continue or --force to restart.');
    }
    if (await fileExists(options.checkpointPath)) {
      throw new CliError('Refusing to overwrite existing judge checkpoint; use --resume to continue or --force to restart.');
    }
  }
  if (options.force) {
    await Promise.all([
      rm(options.outPath, { force: true }).catch(() => undefined),
      rm(options.checkpointPath, { force: true }).catch(() => undefined)
    ]);
  }
  await createEmptyOutputFile(options.outPath);
  await writeCheckpoint(options, 'judge_running', total, 0, runFingerprint);
  return undefined;
}

function assertSafeOutputPaths(options: ParsedArgs): void {
  const inputPaths = new Set([path.resolve(options.hypPath), path.resolve(options.refPath)]);
  const outPath = path.resolve(options.outPath);
  const checkpointPath = path.resolve(options.checkpointPath);
  if (inputPaths.has(outPath)) {
    throw new CliError('Refusing to use input file as judge output');
  }
  if (inputPaths.has(checkpointPath)) {
    throw new CliError('Refusing to use input file as checkpoint output');
  }
  if (outPath === checkpointPath) {
    throw new CliError('Managed output path collision: --out and --checkpoint must be different');
  }
}

async function validateResumeCheckpoint(options: ParsedArgs, runFingerprint: Record<string, unknown>): Promise<JudgeCheckpoint> {
  if (!await fileExists(options.checkpointPath)) {
    throw new CliError('Resume checkpoint is required; use --force to restart or choose a new --out path.');
  }
  const checkpoint = await readJsonFile<JudgeCheckpoint>(options.checkpointPath, 'checkpoint');
  if (!isRecord(checkpoint)) {
    throw new CliError('Resume checkpoint must be a JSON object');
  }
  if (checkpoint.version !== CHECKPOINT_VERSION) {
    throw new CliError(`Unsupported resume checkpoint version: ${String(checkpoint.version)}`);
  }
  if (!isRecord(checkpoint.run_options)) {
    throw new CliError('Resume checkpoint is missing run_options; use --force to restart');
  }
  const mismatches = collectObjectMismatches(checkpoint.run_options, runFingerprint, 'run_options');
  if (mismatches.length > 0) {
    throw new CliError(`Resume checkpoint does not match current options: ${mismatches.join(', ')}. Use matching options, a new --out path, or --force to restart.`);
  }
  return checkpoint;
}

function buildRunOptionsFingerprint(options: ParsedArgs, hypRaw: string, refRaw: string): Record<string, unknown> {
  return {
    hyp_path_hash: sha256(path.resolve(options.hypPath)),
    ref_path_hash: sha256(path.resolve(options.refPath)),
    out_path_hash: sha256(path.resolve(options.outPath)),
    hyp_sha256: sha256(hypRaw),
    ref_sha256: sha256(refRaw),
    codex_model: readEnv('LONGMEMEVAL_CODEX_MODEL') ?? null,
    codex_sandbox: readEnv('LONGMEMEVAL_CODEX_SANDBOX') ?? DEFAULT_SANDBOX
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function collectObjectMismatches(actual: Record<string, unknown>, expected: Record<string, unknown>, prefix: string): string[] {
  const mismatches: string[] = [];
  for (const key of Object.keys(expected).sort()) {
    const left = actual[key];
    const right = expected[key];
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      mismatches.push(`${prefix}.${key}`);
    }
  }
  return mismatches;
}

async function readEvaluatedRowsByQuestionId(filePath: string, expectedHypotheses: HypothesisRow[]): Promise<Map<string, EvaluatedRow>> {
  const rowsById = new Map<string, EvaluatedRow>();
  if (!await fileExists(filePath)) return rowsById;
  const raw = await readFile(filePath, 'utf8');
  if (!raw.trim()) return rowsById;
  const parsed = parseJsonOrJsonl(raw, 'resume output');
  for (const [index, entry] of parsed.entries()) {
    if (!isRecord(entry)) {
      throw new CliError(`Evaluated row ${index + 1} in resume output must be an object`);
    }
    const questionId = entry.question_id;
    const hypothesis = entry.hypothesis;
    const autoevalLabel = entry.autoeval_label;
    if (typeof questionId !== 'string' || questionId.trim() === '') {
      throw new CliError(`Evaluated row ${index + 1} requires non-empty string question_id`);
    }
    const expectedHypothesis = expectedHypotheses[index];
    if (!expectedHypothesis) {
      throw new CliError(`Unexpected extra evaluated row ${index + 1} in resumed output`);
    }
    if (questionId !== expectedHypothesis.question_id) {
      throw new CliError(`Resume output row ${index + 1} does not match current hypothesis order`);
    }
    if (hypothesis !== expectedHypothesis.hypothesis) {
      throw new CliError(`Resume output row ${index + 1} hypothesis does not match current hypotheses`);
    }
    if (rowsById.has(questionId)) {
      throw new CliError(`Duplicate evaluated question_id in resumed output: ${questionId}`);
    }
    if (typeof hypothesis !== 'string') {
      throw new CliError(`Evaluated row ${index + 1} requires string hypothesis`);
    }
    if (!isRecord(autoevalLabel) || typeof autoevalLabel.label !== 'boolean') {
      throw new CliError(`Evaluated row ${index + 1} requires boolean autoeval_label.label`);
    }
    rowsById.set(questionId, { ...entry, question_id: questionId, hypothesis } as EvaluatedRow);
  }
  return rowsById;
}

function validateResumeOutputConsistency(checkpoint: JudgeCheckpoint, total: number, rowCount: number): void {
  if (!isRecord(checkpoint.judge)) {
    throw new CliError('Resume checkpoint is missing judge progress; use --force to restart');
  }
  const rawTotal = checkpoint.judge.total;
  const rawCompleted = checkpoint.judge.completed;
  if (!Number.isInteger(rawTotal) || !Number.isInteger(rawCompleted)) {
    throw new CliError('Resume checkpoint has invalid judge progress; use --force to restart');
  }
  const checkpointTotal = rawTotal as number;
  const checkpointCompleted = rawCompleted as number;
  if (checkpointTotal !== total) {
    throw new CliError('Resume checkpoint total does not match current hypothesis rows; use --force to restart');
  }
  if (checkpointCompleted > 0 && rowCount === 0) {
    throw new CliError('Resume output is missing evaluated rows recorded by the checkpoint; use --force to restart');
  }
  if (rowCount < checkpointCompleted) {
    throw new CliError('Resume output row count is behind checkpoint progress; use --force to restart');
  }
}

async function createEmptyOutputFile(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, '', { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      throw new CliError('Refusing to overwrite existing judge output; use --resume to continue or --force to restart.');
    }
    throw error;
  }
}

async function appendJsonlRow(filePath: string, row: EvaluatedRow): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

async function writeCheckpoint(options: ParsedArgs, status: JudgeCheckpointStatus, total: number, completed: number, runFingerprint: Record<string, unknown>): Promise<void> {
  const checkpoint = {
    version: CHECKPOINT_VERSION,
    status,
    updated_at: new Date().toISOString(),
    run_options: runFingerprint,
    files: {
      hyp_path_hash: runFingerprint.hyp_path_hash,
      ref_path_hash: runFingerprint.ref_path_hash,
      out_path_hash: runFingerprint.out_path_hash
    },
    judge: {
      total,
      completed
    }
  };
  await writeTextFileAtomic(options.checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

async function readJsonFile<T>(filePath: string, label: string): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    const detail = error instanceof SyntaxError ? `: ${error.message}` : '';
    throw new CliError(`Failed to read ${label}${detail}`);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
}

function buildCategoryScores(references: ReferenceRow[], evaluated: EvaluatedRow[]): Map<string, number[]> {
  const qidToReference = new Map(references.map((reference) => [reference.question_id, reference]));
  const scores = new Map<string, number[]>();
  for (const category of [...new Set(references.map((reference) => reference.question_type))].sort((a, b) => a.localeCompare(b))) {
    scores.set(category, []);
  }
  for (const row of evaluated) {
    const reference = qidToReference.get(row.question_id);
    if (!reference) continue;
    const categoryScores = scores.get(reference.question_type) ?? [];
    categoryScores.push(row.autoeval_label.label ? 1 : 0);
    scores.set(reference.question_type, categoryScores);
  }
  return scores;
}

function parseHypotheses(raw: string, filePath: string): HypothesisRow[] {
  const parsed = parseJsonOrJsonl(raw, filePath);
  return parsed.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new CliError(`Hypothesis row ${index + 1} in ${filePath} must be an object`);
    }
    const questionId = entry.question_id;
    const hypothesis = entry.hypothesis;
    if (typeof questionId !== 'string' || questionId.trim() === '') {
      throw new CliError(`Hypothesis row ${index + 1} requires non-empty string question_id`);
    }
    if (typeof hypothesis !== 'string') {
      throw new CliError(`Hypothesis row ${index + 1} requires string hypothesis`);
    }
    return { ...entry, question_id: questionId, hypothesis } as HypothesisRow;
  });
}

function parseReferences(raw: string, filePath: string): ReferenceRow[] {
  const parsed = parseJsonOrJsonl(raw, filePath);
  return parsed.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new CliError(`Reference row ${index + 1} in ${filePath} must be an object`);
    }
    const questionId = entry.question_id;
    const questionType = entry.question_type;
    const question = entry.question;
    const answer = entry.answer;
    if (typeof questionId !== 'string' || questionId.trim() === '') {
      throw new CliError(`Reference row ${index + 1} requires non-empty string question_id`);
    }
    if (typeof questionType !== 'string' || questionType.trim() === '') {
      throw new CliError(`Reference row ${index + 1} requires non-empty string question_type`);
    }
    if (typeof question !== 'string') {
      throw new CliError(`Reference row ${index + 1} requires string question`);
    }
    return { ...entry, question_id: questionId, question_type: questionType, question, answer: stringifyReferenceValue(answer) } as ReferenceRow;
  });
}

function stringifyReferenceValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyReferenceValue(item)).join(', ')}]`;
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function parseJsonOrJsonl(raw: string, filePath: string): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed;
    throw new CliError(`${filePath} must contain a JSON array or JSONL rows`);
  } catch (jsonError) {
    const rows: unknown[] = [];
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as unknown);
      } catch (error) {
        throw new CliError(`Failed to parse ${filePath} line ${index + 1} as JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (rows.length > 0) return rows;
    throw new CliError(`Failed to parse ${filePath}: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}`);
  }
}

function assertUniqueIds(rows: Array<{ question_id: string }>, label: 'hypothesis' | 'reference'): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.question_id)) {
      throw new CliError(`Duplicate ${label} question_id: ${row.question_id}`);
    }
    seen.add(row.question_id);
  }
}

function getAnscheckPrompt(task: string, question: string, answer: string, response: string, abstention = false): string {
  if (!abstention) {
    if (['single-session-user', 'single-session-assistant', 'multi-session'].includes(task)) {
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    }
    if (task === 'temporal-reasoning') {
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    }
    if (task === 'knowledge-update') {
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    }
    if (task === 'single-session-preference') {
      return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${question}\n\nRubric: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
    }
    throw new CliError(`Unsupported LongMemEval question_type: ${task}`);
  }
  return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${question}\n\nExplanation: ${answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
}

function parseJudgeLabel(evalResponse: string): boolean {
  const normalized = evalResponse.trim().toLowerCase();
  if (/^yes[.!?]?$/.test(normalized)) return true;
  return false;
}

async function runCodexPrompt(prompt: string, timeoutMs: number): Promise<string> {
  const bin = readEnv('LONGMEMEVAL_CODEX_BIN') ?? 'codex';
  const sandbox = parseSandbox(readEnv('LONGMEMEVAL_CODEX_SANDBOX') ?? DEFAULT_SANDBOX);
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'cml-longmemeval-codex-judge-'));
  const outputPath = path.join(tmpDir, 'last-message.txt');
  const args = buildCodexArgs(sandbox, tmpDir, outputPath);
  try {
    await runCodexCommand(bin, args, prompt, timeoutMs, tmpDir, 'judge');
    return await readFile(outputPath, 'utf8');
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Codex judge output could not be read: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function buildCodexArgs(sandbox: string, cwd: string, outputPath: string): string[] {
  const args = ['--sandbox', sandbox, '--ask-for-approval', 'never'];
  const model = readEnv('LONGMEMEVAL_CODEX_MODEL');
  if (model) args.push('--model', model);
  args.push('exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--cd', cwd, '--output-last-message', outputPath, '-');
  return args;
}

function runCodexCommand(bin: string, args: string[], prompt: string, timeoutMs: number, cwd: string, label: 'judge'): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      detached: true,
      env: buildCodexEnv(),
      stdio: ['pipe', 'ignore', 'pipe']
    });
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (error?: CliError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    child.stdin.on('error', () => undefined);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => finish(new CliError(`Codex ${label} command failed to start: ${redactSensitiveText(error.message)}`)));
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish(new CliError(`Codex ${label} command timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        const detail = redactSensitiveText(stderr).trim().slice(0, 2_000);
        finish(new CliError(`Codex ${label} command failed with exit code ${code ?? `signal ${signal ?? 'unknown'}`}${detail ? `: ${detail}` : ''}`));
        return;
      }
      finish();
    });
    child.stdin.end(prompt, 'utf8');
  });
}

function buildCodexEnv(): NodeJS.ProcessEnv {
  const allowedKeys = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'CODEX_HOME',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR'
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) {
    if (process.env[key]) env[key] = process.env[key];
    const lower = key.toLowerCase();
    if (process.env[lower]) env[lower] = process.env[lower];
  }
  return env;
}

function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore best-effort cleanup failure
    }
  }
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

async function writeTextFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tmpPath, content, { encoding: 'utf8', flag: 'wx' });
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function readOptionValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new CliError(`Missing value for ${option}`);
  }
  return value;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parseSandbox(value: string): string {
  if (!ALLOWED_SANDBOXES.has(value)) {
    throw new CliError(`LONGMEMEVAL_CODEX_SANDBOX must be one of: ${[...ALLOWED_SANDBOXES].join(', ')}`);
  }
  return value;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new CliError(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliError(`${name} must be a positive integer`);
  }
  if (parsed > max) {
    throw new CliError(`${name} must be <= ${max}`);
  }
  return parsed;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function redactSensitiveText(input: string): string {
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

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function usage(): string {
  return `LongMemEval Codex-compatible judge

Usage:
  npx tsx scripts/longmemeval-codex-judge.ts --hyp hypotheses.jsonl --ref longmemeval_s_cleaned.json [--out results.jsonl] [--checkpoint PATH] [--resume|--force]

Options:
  --checkpoint PATH  Checkpoint file for resumable judging. Default: <out>.checkpoint.json
  --resume           Continue from an existing checkpoint and append only missing question_id rows.
  --force            Remove existing output/checkpoint and restart from scratch. Cannot be combined with --resume.

Runs the LongMemEval answer-check prompt through local \`codex exec\` and writes JSONL rows with autoeval_label. This is useful when only Codex subscription auth is available, but it is not the unmodified upstream official evaluator. Upstream official QA still requires running LongMemEval's evaluate_qa.py with API-compatible judge credentials. Prompt content is piped to Codex stdin instead of argv, and Codex runs from an isolated temporary working directory with a pruned environment.

Environment:
  LONGMEMEVAL_CODEX_BIN          Codex executable path. Default: codex
  LONGMEMEVAL_CODEX_MODEL        Optional Codex model override passed as --model.
  LONGMEMEVAL_CODEX_SANDBOX      Codex sandbox mode. Default: read-only
  LONGMEMEVAL_CODEX_TIMEOUT_MS   Per-question Codex timeout. Default: ${DEFAULT_TIMEOUT_MS}; max ${MAX_TIMEOUT_MS}
`;
}
