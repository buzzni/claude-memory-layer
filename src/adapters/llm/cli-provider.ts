/**
 * Shared CLI provider runner for LLM-backed derivation (session summaries,
 * lesson extraction).
 *
 * This existed as two near-identical copies in session-summary-llm.ts and
 * lesson-extraction-llm.ts, and they diverged within one branch: the stdin
 * error handler landed only in the lesson copy, the recursion-guard env vars
 * were asymmetric (the summary child disabled only summary mode, leaving
 * lesson extraction armed), and ENOENT classification differed. One runner
 * means one place for every future spawn fix.
 *
 * Two hazards shape this module (verified empirically for the summary path):
 *
 * 1. Hook recursion. A child `claude` run re-executes the user-level hooks in
 *    ~/.claude/settings.json, whose hooks would request more derivation and
 *    spawn further children. `--setting-sources project` keeps the user source
 *    out of the child, and an empty scratch cwd keeps project hooks and
 *    CLAUDE.md out too. As defence in depth the child env turns every
 *    derivation mode off, not just the caller's own.
 * 2. Blocking. The call is slow; callers must keep it off latency-sensitive
 *    paths and cache results.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  CIRCUIT_OPEN_CODE,
  MAX_PROVIDER_CALL_MS,
  PROBE_LEASE_MARGIN_MS,
  ProviderCircuitBreaker
} from './provider-circuit-breaker.js';

export type CliProviderName = 'claude' | 'codex';

export const DEFAULT_CLI_TIMEOUT_MS = 120_000;
/** Configured or explicit timeouts above this run with this; the breaker's probe lease relies on it. */
export const MAX_CLI_TIMEOUT_MS = MAX_PROVIDER_CALL_MS;

const FAILURE_STDOUT_TAIL_CHARS = 500;

/** Default model for the claude CLI. codex runs with its own configured default. */
export const DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

export class CliProviderError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'CliProviderError';
  }
}

/**
 * Quota, usage-limit and rate-limit wording from both CLIs. Overload (HTTP
 * 529) is deliberately absent: it clears on its own within seconds, while
 * these keep failing until a quota window resets. A bare "limit reached" is
 * absent too: a per-input limit (context length) says nothing about the next
 * call.
 */
const RATE_LIMIT_PATTERN = /rate[ _-]?limit|usage limit|hit your (?:usage )?limit|(?:\d+-hour|hourly|daily|weekly) limit|quota|too many requests|\b429\b|credit balance/;

export function classifyCliProviderFailure(detail: string, label: string): CliProviderError {
  const lowered = detail.toLowerCase();
  if (lowered.includes('enoent') || lowered.includes('not found')) {
    return new CliProviderError(`${label} CLI was not found`, 'provider-not-found');
  }
  if (lowered.includes('timed out') || lowered.includes('etimedout')) {
    return new CliProviderError(`${label} timed out`, 'provider-timeout');
  }
  if (RATE_LIMIT_PATTERN.test(lowered)) {
    return new CliProviderError(`${label} hit a usage or rate limit`, 'provider-rate-limit');
  }
  if (lowered.includes('auth') || lowered.includes('credential') || lowered.includes('login')) {
    return new CliProviderError(`${label} authentication failed`, 'provider-auth');
  }
  return new CliProviderError(`${label} failed`, 'provider-error');
}

/**
 * The claude default model id only makes sense for the claude CLI. Passing it
 * to `codex exec --model` made every codex run fail on an unknown model, and
 * the caller's catch swallowed the error into a permanently empty result. With
 * no explicit model configured, codex runs with its own default (null → no
 * --model argument).
 */
export function resolveCliModel(
  configured: string | undefined,
  provider: CliProviderName
): string | null {
  const explicit = configured?.trim();
  if (explicit && explicit.length > 0) return explicit;
  return provider === 'claude' ? DEFAULT_CLAUDE_MODEL : null;
}

export function buildCliArgs(provider: CliProviderName, model: string | null): string[] {
  const modelArgs = model ? ['--model', model] : [];
  if (provider === 'codex') {
    return ['exec', '--skip-git-repo-check', ...modelArgs];
  }
  // --setting-sources project: never load the user-level memory hooks.
  return ['-p', '--setting-sources', 'project', ...modelArgs];
}

export const SUMMARY_SCRATCH_DIR_NAME = 'cml-summary';
export const LESSON_SCRATCH_DIR_NAME = 'cml-lesson';

/**
 * Claude Code records each `claude -p` provider run under
 * ~/.claude/projects/<cwd with every non-alphanumeric char as '-'>/, so the
 * scratch cwd's project directory ends in `-<scratch dir name>`. Matched by
 * suffix because the temp dir differs by platform, symlink resolution
 * (/var → /private/var) and TMPDIR. Those transcripts hold other sessions'
 * content and must never be imported as sessions of their own (#230).
 */
export function isProviderScratchProjectDir(projectDirName: string): boolean {
  return [SUMMARY_SCRATCH_DIR_NAME, LESSON_SCRATCH_DIR_NAME]
    .some((scratchDirName) => projectDirName.endsWith(`-${scratchDirName}`));
}

/**
 * A scratch cwd keeps project-level hooks and CLAUDE.md out of the child run.
 * `--setting-sources project` alone would still load them when the child
 * inherits a real project directory.
 */
function createScratchCwd(scratchDirName: string): string {
  const dir = path.join(os.tmpdir(), scratchDirName);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Host-session markers a daemon inherits when a Claude Code hook spawned it.
 * With these set the child `claude -p` answers "Not logged in" even when a
 * local credential exists: it expects the hosting session to supply auth, and
 * hosts (Saycode/happy) never pass their token to child processes. Verified
 * on a hosted session — dropping exactly these made a local login work.
 */
const HOST_SESSION_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH'
] as const;

export function buildCliProviderEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of HOST_SESSION_ENV_KEYS) delete env[key];
  // Defence in depth: if a child hook ever does run, disable every
  // derivation mode — not just the caller's own — so a summary child
  // cannot recurse into lesson extraction or vice versa.
  env.CLAUDE_MEMORY_SUMMARY_MODE = 'off';
  env.CLAUDE_MEMORY_LESSON_MODE = 'off';
  env.CLAUDE_MEMORY_DISABLE_HOOKS = 'true';
  return env;
}

export interface RunCliProviderOptions {
  provider: CliProviderName;
  model: string | null;
  prompt: string;
  timeoutMs: number;
  /** Per-caller scratch directory name under the OS temp dir, e.g. 'cml-lesson'. */
  scratchDirName: string;
  /** Label used in error messages, e.g. 'lesson provider'. */
  label: string;
  /** Defaults to the shared on-disk breaker configured from the environment. */
  breaker?: Pick<ProviderCircuitBreaker, 'admit' | 'recordSuccess' | 'recordFailure'>;
}

/**
 * Every provider call goes through the circuit breaker: an open breaker
 * rejects with CIRCUIT_OPEN_CODE without starting the CLI, and each outcome
 * feeds the breaker so a logged-out or rate-limited provider stops costing a
 * CLI start per call.
 */
export async function runCliProvider(options: RunCliProviderOptions): Promise<string> {
  const { provider, label } = options;
  const timeoutMs = Math.min(options.timeoutMs, MAX_CLI_TIMEOUT_MS);
  const breaker = options.breaker ?? new ProviderCircuitBreaker();
  // The call is killed at timeoutMs, so a probe's outcome lands within its lease.
  const admission = breaker.admit(provider, timeoutMs + PROBE_LEASE_MARGIN_MS);
  if (!admission.allowed) {
    throw new CliProviderError(
      `${label} skipped: provider circuit is open until ${admission.nextProbeAt}`,
      CIRCUIT_OPEN_CODE
    );
  }
  try {
    const output = await spawnCliProvider({ ...options, timeoutMs });
    breaker.recordSuccess(provider, admission);
    return output;
  } catch (error) {
    breaker.recordFailure(provider, error instanceof CliProviderError ? error.code : undefined, admission);
    throw error;
  }
}

function spawnCliProvider(options: RunCliProviderOptions): Promise<string> {
  const { provider, model, prompt, timeoutMs, scratchDirName, label } = options;
  const classify = (detail: string) => classifyCliProviderFailure(detail, label);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(provider, buildCliArgs(provider, model), {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: createScratchCwd(scratchDirName),
        env: buildCliProviderEnv(process.env)
      });
    } catch (error) {
      reject(classify(String(error)));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value ?? '');
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(classify('timed out'));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error: NodeJS.ErrnoException) => {
      settle(classify(error.code === 'ENOENT' ? 'ENOENT' : error.message));
    });
    child.on('close', (code) => {
      if (code === 0) settle(undefined, stdout);
      // `claude -p` prints its own errors ("Not logged in", usage limits) on
      // stdout and leaves stderr empty, so classify from both. Only the tail:
      // the error line comes last, and model text is no classification input.
      else settle(classify([stderr, stdout.slice(-FAILURE_STDOUT_TAIL_CHARS)].filter(Boolean).join('\n') || `exit code ${code}`));
    });

    child.stdin.on('error', (error) => {
      settle(classify(`stdin: ${error.message}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export function resolveCliTimeoutMs(
  configured: string | undefined,
  fallback: number = DEFAULT_CLI_TIMEOUT_MS
): number {
  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_CLI_TIMEOUT_MS) : fallback;
}
