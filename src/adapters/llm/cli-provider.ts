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

export type CliProviderName = 'claude' | 'codex';

export const DEFAULT_CLI_TIMEOUT_MS = 120_000;

/** Default model for the claude CLI. codex runs with its own configured default. */
export const DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

export class CliProviderError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'CliProviderError';
  }
}

export function classifyCliProviderFailure(detail: string, label: string): CliProviderError {
  const lowered = detail.toLowerCase();
  if (lowered.includes('enoent') || lowered.includes('not found')) {
    return new CliProviderError(`${label} CLI was not found`, 'provider-not-found');
  }
  if (lowered.includes('timed out') || lowered.includes('etimedout')) {
    return new CliProviderError(`${label} timed out`, 'provider-timeout');
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

export interface RunCliProviderOptions {
  provider: CliProviderName;
  model: string | null;
  prompt: string;
  timeoutMs: number;
  /** Per-caller scratch directory name under the OS temp dir, e.g. 'cml-lesson'. */
  scratchDirName: string;
  /** Label used in error messages, e.g. 'lesson provider'. */
  label: string;
}

export function runCliProvider(options: RunCliProviderOptions): Promise<string> {
  const { provider, model, prompt, timeoutMs, scratchDirName, label } = options;
  const classify = (detail: string) => classifyCliProviderFailure(detail, label);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(provider, buildCliArgs(provider, model), {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: createScratchCwd(scratchDirName),
        env: {
          ...process.env,
          // Defence in depth: if a child hook ever does run, disable every
          // derivation mode — not just the caller's own — so a summary child
          // cannot recurse into lesson extraction or vice versa.
          CLAUDE_MEMORY_SUMMARY_MODE: 'off',
          CLAUDE_MEMORY_LESSON_MODE: 'off',
          CLAUDE_MEMORY_DISABLE_HOOKS: 'true'
        }
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
      else settle(classify(stderr || `exit code ${code}`));
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
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
