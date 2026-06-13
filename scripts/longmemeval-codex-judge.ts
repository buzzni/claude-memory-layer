#!/usr/bin/env tsx
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

interface ParsedArgs {
  hypPath: string;
  refPath: string;
  outPath: string;
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
  const hypotheses = parseHypotheses(await readFile(options.hypPath, 'utf8'), options.hypPath);
  const references = parseReferences(await readFile(options.refPath, 'utf8'), options.refPath);
  assertUniqueIds(hypotheses, 'hypothesis');
  assertUniqueIds(references, 'reference');
  if (hypotheses.length === 0) {
    throw new CliError('Hypothesis file contains no rows to evaluate');
  }
  const qidToReference = new Map(references.map((reference) => [reference.question_id, reference]));
  const categoryScores = new Map<string, number[]>();
  for (const reference of references) {
    categoryScores.set(reference.question_type, []);
  }

  const evaluated: EvaluatedRow[] = [];
  for (const hypothesis of hypotheses) {
    const reference = qidToReference.get(hypothesis.question_id);
    if (!reference) {
      throw new CliError(`${hypothesis.question_id} is not in reference data`);
    }
    const prompt = getAnscheckPrompt(
      reference.question_type,
      reference.question,
      reference.answer,
      hypothesis.hypothesis,
      hypothesis.question_id.includes('_abs')
    );
    const evalResponse = await runCodexPrompt(prompt, timeoutMs);
    const label = parseJudgeLabel(evalResponse);
    evaluated.push({
      ...hypothesis,
      autoeval_label: {
        model: 'codex-cli',
        label
      }
    });
    const scores = categoryScores.get(reference.question_type) ?? [];
    scores.push(label ? 1 : 0);
    categoryScores.set(reference.question_type, scores);
  }

  await writeTextFile(options.outPath, `${evaluated.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  const allScores = evaluated.map((entry) => entry.autoeval_label.label ? 1 : 0);
  process.stdout.write(`Accuracy: ${round4(mean(allScores))}\n`);
  for (const [category, scores] of [...categoryScores.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (scores.length === 0) continue;
    process.stdout.write(`\t${category}: ${round4(mean(scores))} (${scores.length})\n`);
  }
  process.stdout.write(`Saved to ${options.outPath}\n`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { hypPath: '', refPath: '', outPath: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--hyp' || arg === '--hyp-file') {
      parsed.hypPath = readOptionValue(argv, ++i, arg);
    } else if (arg === '--ref' || arg === '--ref-file') {
      parsed.refPath = readOptionValue(argv, ++i, arg);
    } else if (arg === '--out') {
      parsed.outPath = readOptionValue(argv, ++i, arg);
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
  return parsed;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function usage(): string {
  return `LongMemEval Codex-compatible judge

Usage:
  npx tsx scripts/longmemeval-codex-judge.ts --hyp hypotheses.jsonl --ref longmemeval_s_cleaned.json [--out results.jsonl]

Runs the LongMemEval answer-check prompt through local \`codex exec\` and writes JSONL rows with autoeval_label. This is useful when only Codex subscription auth is available, but it is not the unmodified upstream official evaluator. Upstream official QA still requires running LongMemEval's evaluate_qa.py with API-compatible judge credentials. Prompt content is piped to Codex stdin instead of argv, and Codex runs from an isolated temporary working directory with a pruned environment.

Environment:
  LONGMEMEVAL_CODEX_BIN          Codex executable path. Default: codex
  LONGMEMEVAL_CODEX_MODEL        Optional Codex model override passed as --model.
  LONGMEMEVAL_CODEX_SANDBOX      Codex sandbox mode. Default: read-only
  LONGMEMEVAL_CODEX_TIMEOUT_MS   Per-question Codex timeout. Default: ${DEFAULT_TIMEOUT_MS}; max ${MAX_TIMEOUT_MS}
`;
}
