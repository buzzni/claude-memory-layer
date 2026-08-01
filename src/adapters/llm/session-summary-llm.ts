/**
 * LLM-backed session summary generation.
 *
 * The rule-based deriver emits a table of contents ("[date] N turn session.
 * Main task: <first prompt>"), which measured a 0.9% grounding rate: there is
 * no outcome inside it for a later answer to reuse. This module asks a local
 * Claude/Codex CLI for the durable outcomes instead.
 *
 * Two hazards drive the implementation shape:
 *
 * 1. Hook recursion. A child `claude` run re-executes the user-level hooks in
 *    ~/.claude/settings.json, whose Stop hook would request another summary,
 *    which would spawn another child. `--setting-sources project` keeps the
 *    user source (where the memory hooks live) out of the child, and running in
 *    an empty scratch cwd keeps any *project* hooks and CLAUDE.md out too.
 *    Verified empirically: without the flag a child run creates a new memory
 *    project store, with it the store count is unchanged.
 * 2. Blocking. The call is slow, so callers must run it off the hook response
 *    path (the daemon schedules it).
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type SummaryProviderName = 'claude' | 'codex';

export interface SummarySourceEvent {
  eventType: string;
  content: string;
}

export interface LlmSummaryResult {
  text: string;
  metadata: {
    generated: 'llm';
    provider: SummaryProviderName;
    model: string;
    eventCount: number;
  };
}

/** The model is told to emit this when a session holds nothing worth keeping. */
export const NO_DURABLE_CONTENT = 'NO_DURABLE_CONTENT';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_EVENT_CHARS = 2_000;
const MAX_EVENTS = 40;
const MAX_OUTPUT_CHARS = 2_000;

export class SummaryProviderError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'SummaryProviderError';
  }
}

export function getSummaryProviderName(env: NodeJS.ProcessEnv = process.env): SummaryProviderName {
  return env.CLAUDE_MEMORY_SUMMARY_PROVIDER === 'codex' ? 'codex' : 'claude';
}

export function getSummaryModel(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CLAUDE_MEMORY_SUMMARY_MODEL?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_MODEL;
}

export function isLlmSummaryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_MEMORY_SUMMARY_MODE !== 'rule' && env.CLAUDE_MEMORY_SUMMARY_MODE !== 'off';
}

/**
 * Only prompts and answers carry decisions. Tool observations are excluded on
 * purpose: they are 82% of stored volume, ground at 0.2%, and would dominate
 * the context window with content the summary must not describe anyway.
 */
export function buildSummaryPrompt(events: SummarySourceEvent[]): string | null {
  const usable = events
    .filter((event) => event.eventType === 'user_prompt' || event.eventType === 'agent_response')
    .filter((event) => typeof event.content === 'string' && event.content.trim().length > 0)
    .slice(-MAX_EVENTS);

  if (usable.length < 2) return null;

  const transcript = usable
    .map((event) => {
      const role = event.eventType === 'user_prompt' ? 'User' : 'Assistant';
      const content = event.content.length > MAX_EVENT_CHARS
        ? `${event.content.slice(0, MAX_EVENT_CHARS)}…`
        : event.content;
      return `[${role}] ${content.replace(/\r?\n/g, ' ')}`;
    })
    .join('\n');

  return [
    '다음은 한 개발 세션의 대화 기록이다. 다음 세션이 같은 것을 다시 알아내지 않아도 되도록,',
    '아래 세 가지에 해당하는 내용만 추출해라.',
    '',
    '- 결정: 무엇을 하기로 했고, 왜 그렇게 정했는가',
    '- 실패: 시도했으나 안 된 것과 그 원인',
    '- 제약: 새로 확인된 사실, 한계, 함정',
    '',
    '규칙:',
    '- 무엇을 "했다"는 나열(파일 수정, 명령 실행, 커밋)은 git이 이미 기록하므로 쓰지 마라.',
    '- 위 세 가지에 해당하는 내용이 하나도 없으면 다른 말 없이 정확히 ' + NO_DURABLE_CONTENT + ' 만 출력해라.',
    '- 최대 5줄. 각 줄은 "- " 로 시작. 머리말, 인사, 총평, 설명 금지.',
    '- 추측하지 마라. 기록에 근거가 있는 것만 써라.',
    '',
    '--- 기록 시작 ---',
    transcript,
    '--- 기록 끝 ---'
  ].join('\n');
}

function buildArgs(provider: SummaryProviderName, model: string): string[] {
  if (provider === 'codex') {
    return ['exec', '--skip-git-repo-check', '--model', model];
  }
  // --setting-sources project: never load the user-level memory hooks.
  return ['-p', '--setting-sources', 'project', '--model', model];
}

export function classifySummaryFailure(detail: string): SummaryProviderError {
  const lowered = detail.toLowerCase();
  if (lowered.includes('enoent') || lowered.includes('not found')) {
    return new SummaryProviderError('summary provider CLI was not found', 'provider-not-found');
  }
  if (lowered.includes('timed out') || lowered.includes('etimedout')) {
    return new SummaryProviderError('summary provider timed out', 'provider-timeout');
  }
  if (lowered.includes('auth') || lowered.includes('credential') || lowered.includes('login')) {
    return new SummaryProviderError('summary provider authentication failed', 'provider-auth');
  }
  return new SummaryProviderError('summary provider failed', 'provider-error');
}

/**
 * Strip anything that is not one of the requested bullet lines so a chatty
 * preamble cannot become the stored "summary".
 */
export function normalizeSummaryOutput(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes(NO_DURABLE_CONTENT)) return null;

  const bullets = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*•]\s+/.test(line))
    .map((line) => `- ${line.replace(/^[-*•]\s+/, '').trim()}`)
    .filter((line) => line.length > 2)
    .slice(0, 5);

  if (bullets.length === 0) return null;
  const text = bullets.join('\n');
  return text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS) : text;
}

/**
 * A scratch cwd keeps project-level hooks and CLAUDE.md out of the child run.
 * `--setting-sources project` alone would still load them when the child
 * inherits a real project directory.
 */
function createScratchCwd(): string {
  const dir = path.join(os.tmpdir(), 'cml-summary');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runProvider(
  provider: SummaryProviderName,
  model: string,
  prompt: string,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(provider, buildArgs(provider, model), {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: createScratchCwd(),
        env: {
          ...process.env,
          // Defence in depth: if a child hook ever does run, these keep it from
          // recursing back into summary generation.
          CLAUDE_MEMORY_SUMMARY_MODE: 'off',
          CLAUDE_MEMORY_DISABLE_HOOKS: 'true'
        }
      });
    } catch (error) {
      reject(classifySummaryFailure(String(error)));
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
      settle(classifySummaryFailure('timed out'));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error: NodeJS.ErrnoException) => {
      settle(classifySummaryFailure(error.code === 'ENOENT' ? 'ENOENT not found' : String(error)));
    });
    child.on('close', (code) => {
      if (code === 0) settle(undefined, stdout);
      else settle(classifySummaryFailure(stderr || `exit code ${code}`));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Returns null when the session holds nothing durable. Callers must treat that
 * as "store nothing" rather than falling back to the rule-based text, which is
 * the content this module exists to stop producing.
 */
export async function generateLlmSessionSummary(
  events: SummarySourceEvent[],
  options: {
    provider?: SummaryProviderName;
    model?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<LlmSummaryResult | null> {
  const env = options.env ?? process.env;
  const prompt = buildSummaryPrompt(events);
  if (!prompt) return null;

  const provider = options.provider ?? getSummaryProviderName(env);
  const model = options.model ?? getSummaryModel(env);
  const configuredTimeout = Number(env.CLAUDE_MEMORY_SUMMARY_TIMEOUT_MS);
  const timeoutMs = options.timeoutMs
    ?? (Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : DEFAULT_TIMEOUT_MS);

  const raw = await runProvider(provider, model, prompt, timeoutMs);
  const text = normalizeSummaryOutput(raw);
  if (!text) return null;

  return {
    text,
    metadata: {
      generated: 'llm',
      provider,
      model,
      eventCount: events.length
    }
  };
}
