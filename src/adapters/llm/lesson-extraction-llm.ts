/**
 * LLM-backed procedural lesson extraction.
 *
 * The rule-based candidate builder mapped seven recognized tool patterns onto
 * fixed strings, so every derived lesson came out as a variant of "Workflow
 * pattern: focused tests + typecheck + build" with a `failureModes` list that
 * was byte-identical across all of them. Nothing in that text can change how a
 * later session executes, which is the only thing a lesson is for. This module
 * asks a local Claude/Codex CLI for the reusable procedure instead.
 *
 * The prompt contract is ported from OpenViking's experience-memory schema
 * (openviking/prompts/templates/memory/experiences.yaml): mutual exclusivity
 * between steps and guardrails, an optimized execution path with the retry
 * loops trimmed, mandatory abstraction away from specific identifiers, and one
 * user intent per lesson with a hard bullet cap.
 *
 * The same two hazards as session-summary-llm.ts shape the implementation:
 *
 * 1. Hook recursion. A child `claude` run re-executes the user-level hooks in
 *    ~/.claude/settings.json, which would spawn further children.
 *    `--setting-sources project` plus an empty scratch cwd keeps user- and
 *    project-level hooks out of the child.
 * 2. Blocking. The call is slow, so the candidate service caches every result
 *    and callers must keep it off any latency-sensitive path.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type {
  ExtractedLesson,
  LessonExtractionSource
} from '../../core/operations/lesson-candidate-service.js';

export type LessonProviderName = 'claude' | 'codex';

/** The model emits this when a session group holds no reusable procedure. */
export const NO_DURABLE_LESSON = 'NO_DURABLE_LESSON';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const MAX_NAME_CHARS = 120;
const MAX_TRIGGER_CHARS = 400;
const MAX_STEP_CHARS = 240;
const MAX_STEPS = 8;
const MAX_FAILURE_MODES = 6;

export class LessonProviderError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'LessonProviderError';
  }
}

export function getLessonProviderName(env: NodeJS.ProcessEnv = process.env): LessonProviderName {
  return env.CLAUDE_MEMORY_LESSON_PROVIDER === 'codex' ? 'codex' : 'claude';
}

export function getLessonModel(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CLAUDE_MEMORY_LESSON_MODEL?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_MODEL;
}

/**
 * Extraction is on unless explicitly disabled. When it is off the candidate
 * service emits nothing rather than falling back to the template text this
 * module exists to replace.
 */
export function isLlmLessonExtractionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_MEMORY_LESSON_MODE !== 'off';
}

/**
 * The no-slash rule below isn't cosmetic: `sanitizeString` (applied to the
 * assembled candidate in lesson-candidate-service.ts) runs the audit path
 * redactor, whose absolute-path pattern matches from any "/" to the end of
 * the line rather than to the next whitespace. One path or "A/B" aside in the
 * model's output silently truncates the rest of that sentence into
 * "...[REDACTED]" — observed in production output before this rule existed.
 */
export function buildLessonPrompt(source: LessonExtractionSource): string {
  const facts = [
    `- 반복 횟수: 성공한 세션 ${source.sessionCount}개에서 같은 패턴이 관찰됨`,
    source.tools.length > 0 ? `- 공통 검증 도구: ${source.tools.join(', ')}` : null,
    source.fileCategories.length > 0 ? `- 공통 파일 종류: ${source.fileCategories.join(', ')}` : null,
    source.taskPatterns.length > 0 ? `- 공통 작업 유형: ${source.taskPatterns.join(', ')}` : null
  ].filter((line): line is string => line !== null);

  return [
    '아래는 같은 작업 패턴이 반복된 개발 세션들의 기록이다.',
    '다음 세션의 에이전트가 그대로 실행할 수 있는 재사용 가능한 절차 하나를 추출해라.',
    '',
    '## 관찰된 사실',
    ...facts,
    '',
    '## 출력 형식',
    '다른 말 없이 JSON 객체 하나만 출력해라.',
    '{',
    '  "name": "패턴 이름. 특정 사건이 아니라 일반화된 패턴을 지칭. 최대 8단어",',
    '  "trigger": "이 절차가 적용되는 진입 조건. 언제 이 절차를 꺼내 쓰는가",',
    '  "steps": ["실행 단계", "..."],',
    '  "failureModes": ["금지선", "..."]',
    '}',
    '',
    '## 규칙',
    `- 상호 배타: steps에는 실행할 것만, failureModes에는 하지 말 것만 쓴다. 같은 내용을 양쪽에 반복하지 마라.`,
    `- 경로 최적화: 기록에 남은 재시도 루프, 헛발질, 되돌린 작업, 잡담은 버리고 성공에 이른 최단 경로만 남겨라.`,
    `- 추상화: 특정 파일명, 세션 ID, 사람 이름, 절대 경로, 원문 인용을 제거하고 일반화해라.`,
    `  나쁜 예: "/src/core/auth.ts 의 토큰 검증 로직을 고쳐라"`,
    `  좋은 예: "인증 관련 검증 로직을 고쳐라"`,
    `- 슬래시(/) 금지: 파일 경로, "A/B" 같은 병기 표기를 포함해 "/" 문자를 절대 쓰지 마라.`,
    `  후처리 필터가 "/"부터 그 줄 끝까지를 통째로 지우므로, 슬래시 하나가 문장 나머지를 삼킨다.`,
    `  경로 대신 "인증 모듈", "테스트 설정 파일"처럼 역할로 지칭해라.`,
    `- 실행 우선: steps는 실제 도구 호출/명령만 담는다. "이제 X를 하겠습니다", "X를 완료했습니다" 같은 진행 보고는 빼라.`,
    `- 조건 분기 보존: 분기가 있었다면 "A이면 B, 아니면 C" 형태로 남겨라. 서로 다른 분기를 하나로 뭉개지 마라.`,
    `- 원자 범위: 절차 하나는 사용자 의도 하나만 다룬다. steps가 ${MAX_STEPS}개를 넘으면 범위가 넓은 것이니 가장 핵심인 의도 하나로 좁혀라.`,
    `- failureModes는 기록에 실제로 나타난 실패에서 끌어내라. 일반론을 지어내지 마라. 없으면 빈 배열로 둬라.`,
    `- 명령형으로 써라. 미래 에이전트에게 직접 지시하는 문장으로.`,
    `- 한국어로 써라.`,
    `- 재사용할 가치가 있는 절차가 없으면 다른 말 없이 정확히 ${NO_DURABLE_LESSON} 만 출력해라.`,
    '',
    '--- 기록 시작 ---',
    source.transcript,
    '--- 기록 끝 ---'
  ].join('\n');
}

function buildArgs(provider: LessonProviderName, model: string): string[] {
  if (provider === 'codex') {
    return ['exec', '--skip-git-repo-check', '--model', model];
  }
  // --setting-sources project: never load the user-level memory hooks.
  return ['-p', '--setting-sources', 'project', '--model', model];
}

export function classifyLessonFailure(detail: string): LessonProviderError {
  const lowered = detail.toLowerCase();
  if (lowered.includes('enoent') || lowered.includes('not found')) {
    return new LessonProviderError('lesson provider CLI was not found', 'provider-not-found');
  }
  if (lowered.includes('timed out') || lowered.includes('etimedout')) {
    return new LessonProviderError('lesson provider timed out', 'provider-timeout');
  }
  if (lowered.includes('auth') || lowered.includes('credential') || lowered.includes('login')) {
    return new LessonProviderError('lesson provider authentication failed', 'provider-auth');
  }
  return new LessonProviderError('lesson provider failed', 'provider-error');
}

function firstJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return null;
}

function cleanLine(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').replace(/^[-*•]\s+/, '').trim();
  if (normalized.length === 0) return null;
  return normalized.length > maxChars ? normalized.slice(0, maxChars) : normalized;
}

function cleanLines(value: unknown, maxChars: number, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const line = cleanLine(item, maxChars);
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
    if (lines.length >= maxItems) break;
  }
  return lines;
}

/**
 * Returns null for anything that is not a usable lesson so a chatty preamble or
 * a half-filled object cannot become stored guidance. A lesson without a name,
 * a trigger, or at least one step has nothing for a later session to execute.
 */
export function parseLessonOutput(raw: string): ExtractedLesson | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes(NO_DURABLE_LESSON)) return null;

  const jsonText = firstJsonObject(trimmed);
  if (!jsonText) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const name = cleanLine(record.name, MAX_NAME_CHARS);
  const trigger = cleanLine(record.trigger, MAX_TRIGGER_CHARS);
  const steps = cleanLines(record.steps, MAX_STEP_CHARS, MAX_STEPS);
  const failureModes = cleanLines(record.failureModes, MAX_STEP_CHARS, MAX_FAILURE_MODES);

  if (!name || !trigger || steps.length === 0) return null;

  return { name, trigger, steps, failureModes };
}

/**
 * A scratch cwd keeps project-level hooks and CLAUDE.md out of the child run.
 * `--setting-sources project` alone would still load them when the child
 * inherits a real project directory.
 */
function createScratchCwd(): string {
  const dir = path.join(os.tmpdir(), 'cml-lesson');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runProvider(
  provider: LessonProviderName,
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
          // recursing back into memory generation.
          CLAUDE_MEMORY_LESSON_MODE: 'off',
          CLAUDE_MEMORY_SUMMARY_MODE: 'off',
          CLAUDE_MEMORY_DISABLE_HOOKS: 'true'
        }
      });
    } catch (error) {
      reject(classifyLessonFailure(String(error)));
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
      settle(classifyLessonFailure('timed out'));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error: NodeJS.ErrnoException) => {
      settle(classifyLessonFailure(error.code === 'ENOENT' ? 'ENOENT not found' : String(error)));
    });
    child.on('close', (code) => {
      if (code === 0) settle(undefined, stdout);
      else settle(classifyLessonFailure(stderr || `exit code ${code}`));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Returns null when the session group holds no reusable procedure. Callers must
 * treat that as "emit no candidate" rather than falling back to the template
 * text, which is the content this module exists to stop producing.
 */
export async function extractLessonWithLlm(
  source: LessonExtractionSource,
  options: {
    provider?: LessonProviderName;
    model?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<ExtractedLesson | null> {
  const env = options.env ?? process.env;
  if (!isLlmLessonExtractionEnabled(env)) return null;
  if (source.transcript.trim().length === 0) return null;

  const provider = options.provider ?? getLessonProviderName(env);
  const model = options.model ?? getLessonModel(env);
  const configuredTimeout = Number(env.CLAUDE_MEMORY_LESSON_TIMEOUT_MS);
  const timeoutMs = options.timeoutMs
    ?? (Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : DEFAULT_TIMEOUT_MS);

  const raw = await runProvider(provider, model, buildLessonPrompt(source), timeoutMs);
  return parseLessonOutput(raw);
}
