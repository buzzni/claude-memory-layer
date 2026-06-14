#!/usr/bin/env tsx
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

interface LongMemEvalReaderContext {
  id: string;
  rank: number;
  content: string;
}

interface LongMemEvalTemporalDateBoost {
  referenceDate: string;
  targetDate?: string;
  toleranceDays?: number;
  entityTerms?: string[];
}

interface LongMemEvalReaderPayload {
  question_id: string;
  question: string;
  category?: string;
  temporalDateBoost?: LongMemEvalTemporalDateBoost;
  contexts: LongMemEvalReaderContext[];
}

interface ProcessTreeChild {
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

class ReaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReaderError';
  }
}

const DEFAULT_CONTEXT_CHAR_LIMIT = 24_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_SANDBOX = 'read-only';
const ALLOWED_SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access']);

void main().catch((error) => {
  if (error instanceof ReaderError) {
    process.stderr.write(`${error.message}\n`);
  } else if (error instanceof Error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
  } else {
    process.stderr.write(`${String(error)}\n`);
  }
  process.exitCode = 1;
});

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h') || readEnv('LONGMEMEVAL_CODEX_HELP_ONLY') === '1') {
    process.stdout.write(helpText());
    return;
  }

  const payload = parsePayload(await readStdin());
  const contextCharLimit = parsePositiveInteger(readEnv('LONGMEMEVAL_CODEX_CONTEXT_CHAR_LIMIT'), DEFAULT_CONTEXT_CHAR_LIMIT, 'LONGMEMEVAL_CODEX_CONTEXT_CHAR_LIMIT');
  const timeoutMs = parsePositiveInteger(readEnv('LONGMEMEVAL_CODEX_TIMEOUT_MS'), DEFAULT_TIMEOUT_MS, 'LONGMEMEVAL_CODEX_TIMEOUT_MS', MAX_TIMEOUT_MS);
  const hypothesis = await runCodexReader(buildPrompt(payload, contextCharLimit), timeoutMs);
  process.stdout.write(`${hypothesis.trim() || 'I do not know'}\n`);
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { raw += chunk; });
    process.stdin.on('error', reject);
    process.stdin.on('end', () => resolve(raw));
  });
}

function parsePayload(raw: string): LongMemEvalReaderPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ReaderError(`Reader stdin must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new ReaderError('Reader stdin must be a JSON object');
  }
  const questionId = parsed.question_id;
  const question = parsed.question;
  const contexts = parsed.contexts;
  if (typeof questionId !== 'string' || questionId.trim() === '') {
    throw new ReaderError('Reader payload requires non-empty string question_id');
  }
  if (typeof question !== 'string' || question.trim() === '') {
    throw new ReaderError('Reader payload requires non-empty string question');
  }
  if (!Array.isArray(contexts)) {
    throw new ReaderError('Reader payload requires contexts array');
  }

  return {
    question_id: questionId,
    question,
    ...(typeof parsed.category === 'string' ? { category: parsed.category } : {}),
    ...(parsed.temporalDateBoost !== undefined ? { temporalDateBoost: parseTemporalDateBoost(parsed.temporalDateBoost) } : {}),
    contexts: contexts.map((context, index) => parseContext(context, index))
  };
}

function parseTemporalDateBoost(value: unknown): LongMemEvalTemporalDateBoost {
  if (!isRecord(value)) {
    throw new ReaderError('Reader payload temporalDateBoost must be an object');
  }
  const referenceDate = value.referenceDate;
  if (typeof referenceDate !== 'string' || referenceDate.trim() === '') {
    throw new ReaderError('Reader payload temporalDateBoost requires non-empty string referenceDate');
  }
  const boost: LongMemEvalTemporalDateBoost = { referenceDate };
  if (value.targetDate !== undefined) {
    if (typeof value.targetDate !== 'string' || value.targetDate.trim() === '') {
      throw new ReaderError('Reader payload temporalDateBoost targetDate must be a non-empty string');
    }
    boost.targetDate = value.targetDate;
  }
  if (value.toleranceDays !== undefined) {
    if (typeof value.toleranceDays !== 'number' || !Number.isFinite(value.toleranceDays) || value.toleranceDays < 0) {
      throw new ReaderError('Reader payload temporalDateBoost toleranceDays must be a non-negative number');
    }
    boost.toleranceDays = value.toleranceDays;
  }
  if (value.entityTerms !== undefined) {
    if (!Array.isArray(value.entityTerms) || !value.entityTerms.every((term) => typeof term === 'string')) {
      throw new ReaderError('Reader payload temporalDateBoost entityTerms must be a string array');
    }
    boost.entityTerms = value.entityTerms.filter((term) => term.trim() !== '');
  }
  return boost;
}

function parseContext(context: unknown, index: number): LongMemEvalReaderContext {
  if (!isRecord(context)) {
    throw new ReaderError(`Reader payload context ${index + 1} must be an object`);
  }
  const id = context.id;
  const rank = context.rank;
  const content = context.content;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new ReaderError(`Reader payload context ${index + 1} requires non-empty string id`);
  }
  if (typeof rank !== 'number' || !Number.isFinite(rank)) {
    throw new ReaderError(`Reader payload context ${index + 1} requires numeric rank`);
  }
  if (typeof content !== 'string') {
    throw new ReaderError(`Reader payload context ${index + 1} requires string content`);
  }
  return { id, rank, content };
}

function buildPrompt(payload: LongMemEvalReaderPayload, contextCharLimit: number): string {
  const lines = [
    'You are a LongMemEval reader.',
    'Answer only from the retrieved context below.',
    'If the retrieved context is insufficient, answer exactly: I do not know.',
    'Return only the final concise answer text. Do not include citations, markdown, reasoning, or explanation.',
    ...buildReaderGuidanceLines(payload),
    '',
    `Question ID: ${payload.question_id}`,
    ...(payload.category ? [`Category: ${payload.category}`] : []),
    `Question: ${payload.question}`,
    '',
    'Retrieved Contexts:'
  ];

  let usedChars = 0;
  for (const context of [...payload.contexts].sort((a, b) => a.rank - b.rank)) {
    if (usedChars >= contextCharLimit) break;
    const remaining = contextCharLimit - usedChars;
    const content = context.content.length > remaining
      ? `${context.content.slice(0, Math.max(0, remaining - 16))}\n[truncated]`
      : context.content;
    usedChars += content.length;
    lines.push(`[${context.rank}] ${context.id}`);
    lines.push(content);
    lines.push('');
  }
  if (payload.contexts.length === 0) {
    lines.push('[no retrieved contexts]');
  }
  return lines.join('\n');
}

function buildReaderGuidanceLines(payload: LongMemEvalReaderPayload): string[] {
  const lines: string[] = [];
  const category = payload.category?.toLowerCase() ?? '';
  if (category.includes('multi')) {
    lines.push('For multi-session questions, inspect all retrieved contexts and synthesize every required evidence item before answering.');
    lines.push('Do not answer from only the top-ranked context when the question asks for comparisons, changes, counts, or multiple facts.');
  }
  if (category.includes('temporal')) {
    lines.push('For temporal-reasoning questions, use the dates in context headers and prefer evidence matching the temporal target.');
  }
  if (payload.temporalDateBoost !== undefined) {
    lines.push(formatTemporalDateBoostLine(payload.temporalDateBoost));
    const entityTerms = payload.temporalDateBoost.entityTerms ?? [];
    if (entityTerms.length > 0) {
      lines.push(`Temporal entity terms: ${entityTerms.join(', ')}.`);
    }
  }
  return lines;
}

function formatTemporalDateBoostLine(boost: LongMemEvalTemporalDateBoost): string {
  const target = boost.targetDate ? `Temporal target date: ${boost.targetDate}; ` : '';
  const tolerance = boost.toleranceDays !== undefined ? `; tolerance: ±${boost.toleranceDays} day${boost.toleranceDays === 1 ? '' : 's'}` : '';
  return `${target}reference date: ${boost.referenceDate}${tolerance}.`;
}

async function runCodexReader(prompt: string, timeoutMs: number): Promise<string> {
  const bin = readEnv('LONGMEMEVAL_CODEX_BIN') ?? 'codex';
  const sandbox = parseSandbox(readEnv('LONGMEMEVAL_CODEX_SANDBOX') ?? DEFAULT_SANDBOX);
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'cml-longmemeval-codex-reader-'));
  const outputPath = path.join(tmpDir, 'last-message.txt');
  const args = buildCodexArgs(sandbox, tmpDir, outputPath);

  try {
    await runCodexCommand(bin, args, prompt, timeoutMs, tmpDir, 'reader');
    return await readFile(outputPath, 'utf8');
  } catch (error) {
    if (error instanceof ReaderError) throw error;
    throw new ReaderError(`Codex reader output could not be read: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function buildCodexArgs(sandbox: string, cwd: string, outputPath: string): string[] {
  const args = [
    '--sandbox',
    sandbox,
    '--ask-for-approval',
    'never'
  ];
  const model = readEnv('LONGMEMEVAL_CODEX_MODEL');
  if (model) {
    args.push('--model', model);
  }
  args.push(
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--cd',
    cwd,
    '--output-last-message',
    outputPath,
    '-'
  );
  return args;
}

function runCodexCommand(bin: string, args: string[], prompt: string, timeoutMs: number, cwd: string, label: 'reader'): Promise<void> {
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
    const finish = (error?: ReaderError) => {
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
    child.on('error', (error) => {
      finish(new ReaderError(`Codex ${label} command failed to start: ${redactSensitiveText(error.message)}`));
    });
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish(new ReaderError(`Codex ${label} command timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        const detail = redactSensitiveText(stderr).trim().slice(0, 2_000);
        finish(new ReaderError(`Codex ${label} command failed with exit code ${code ?? `signal ${signal ?? 'unknown'}`}${detail ? `: ${detail}` : ''}`));
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

function killProcessTree(child: ProcessTreeChild): void {
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

function parseSandbox(value: string): string {
  if (!ALLOWED_SANDBOXES.has(value)) {
    throw new ReaderError(`LONGMEMEVAL_CODEX_SANDBOX must be one of: ${[...ALLOWED_SANDBOXES].join(', ')}`);
  }
  return value;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new ReaderError(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ReaderError(`${name} must be a positive integer`);
  }
  if (parsed > max) {
    throw new ReaderError(`${name} must be <= ${max}`);
  }
  return parsed;
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

function helpText(): string {
  return `LongMemEval Codex CLI reader

Reads one LongMemEval reader payload JSON object from stdin and prints only the answer hypothesis to stdout. It uses local Codex subscription auth through \`codex exec\`, not an OpenAI API key. Prompt content is piped to Codex stdin instead of argv.

Environment:
  LONGMEMEVAL_CODEX_BIN                 Codex executable path. Default: codex
  LONGMEMEVAL_CODEX_MODEL               Optional Codex model override passed as --model.
  LONGMEMEVAL_CODEX_SANDBOX             Codex sandbox mode. Default: read-only
  LONGMEMEVAL_CODEX_TIMEOUT_MS          Per-question Codex timeout. Default: ${DEFAULT_TIMEOUT_MS}; max ${MAX_TIMEOUT_MS}
  LONGMEMEVAL_CODEX_CONTEXT_CHAR_LIMIT  Retrieved-context prompt budget. Default: ${DEFAULT_CONTEXT_CHAR_LIMIT}

Notes:
  - Requires a working standalone Codex CLI login / Codex subscription auth.
  - Runs Codex from an isolated temporary working directory with a pruned environment.
  - This can generate Codex-reader hypotheses for --answers-out.
  - It is not the unmodified upstream LongMemEval official judge; evaluate_qa.py still requires API-compatible judge credentials.
`;
}
