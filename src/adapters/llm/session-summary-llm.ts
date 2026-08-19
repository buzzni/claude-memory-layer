/**
 * LLM-backed session summary generation.
 *
 * The rule-based deriver emits a table of contents ("[date] N turn session.
 * Main task: <first prompt>"), which measured a 0.9% grounding rate: there is
 * no outcome inside it for a later answer to reuse. This module asks a local
 * Claude/Codex CLI for the durable outcomes instead.
 *
 * Subprocess mechanics (hook-recursion guards, timeouts, failure
 * classification) live in the shared cli-provider module; callers must still
 * run this off the hook response path (the daemon schedules it).
 */

import {
  classifyCliProviderFailure,
  resolveCliModel,
  resolveCliTimeoutMs,
  runCliProvider,
  type CliProviderError,
  type CliProviderName
} from './cli-provider.js';

export type SummaryProviderName = CliProviderName;

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

const MAX_EVENT_CHARS = 2_000;
const MAX_EVENTS = 40;
const MAX_OUTPUT_CHARS = 2_000;

export function getSummaryProviderName(env: NodeJS.ProcessEnv = process.env): SummaryProviderName {
  return env.CLAUDE_MEMORY_SUMMARY_PROVIDER === 'codex' ? 'codex' : 'claude';
}

/**
 * Returns null when no model should be passed to the CLI (codex with no
 * explicit override runs on its own configured default).
 */
export function getSummaryModel(
  env: NodeJS.ProcessEnv = process.env,
  provider: SummaryProviderName = getSummaryProviderName(env)
): string | null {
  return resolveCliModel(env.CLAUDE_MEMORY_SUMMARY_MODEL, provider);
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

export function classifySummaryFailure(detail: string): CliProviderError {
  return classifyCliProviderFailure(detail, 'summary provider');
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
  const model = options.model ?? getSummaryModel(env, provider);
  const timeoutMs = options.timeoutMs ?? resolveCliTimeoutMs(env.CLAUDE_MEMORY_SUMMARY_TIMEOUT_MS);

  const raw = await runCliProvider({
    provider,
    model,
    prompt,
    timeoutMs,
    scratchDirName: 'cml-summary',
    label: 'summary provider'
  });
  const text = normalizeSummaryOutput(raw);
  if (!text) return null;

  return {
    text,
    metadata: {
      generated: 'llm',
      provider,
      model: model ?? `${provider}-default`,
      eventCount: events.length
    }
  };
}
