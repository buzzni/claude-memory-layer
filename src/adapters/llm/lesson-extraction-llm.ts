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
 * Subprocess mechanics (hook-recursion guards, timeouts, failure
 * classification) live in the shared cli-provider module.
 */

import {
  CliProviderError,
  classifyCliProviderFailure,
  resolveCliModel,
  resolveCliTimeoutMs,
  runCliProvider,
  type CliProviderName
} from './cli-provider.js';
import type {
  ExtractedLesson,
  LessonExtractionSource
} from '../../core/operations/lesson-candidate-service.js';

export type LessonProviderName = CliProviderName;

/** The model emits this when a session group holds no reusable procedure. */
export const NO_DURABLE_LESSON = 'NO_DURABLE_LESSON';

const MAX_NAME_CHARS = 120;
const MAX_TRIGGER_CHARS = 400;
const MAX_STEP_CHARS = 240;
const MAX_STEPS = 8;
const MAX_FAILURE_MODES = 6;
/** Bail out of JSON-candidate scanning on pathological brace-heavy output. */
const MAX_JSON_SCAN_ATTEMPTS = 10;

export function getLessonProviderName(env: NodeJS.ProcessEnv = process.env): LessonProviderName {
  return env.CLAUDE_MEMORY_LESSON_PROVIDER === 'codex' ? 'codex' : 'claude';
}

/**
 * Returns null when no model should be passed to the CLI (codex with no
 * explicit override runs on its own configured default).
 */
export function getLessonModel(
  env: NodeJS.ProcessEnv = process.env,
  provider: LessonProviderName = getLessonProviderName(env)
): string | null {
  return resolveCliModel(env.CLAUDE_MEMORY_LESSON_MODEL, provider);
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
 * redactor, which eats a bounded but large window after any "/". One path or
 * "A/B" aside in the model's output silently truncates that sentence into
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
    `  후처리 필터가 "/" 뒤의 긴 구간을 통째로 지우므로, 슬래시 하나가 문장 나머지를 삼킨다.`,
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

export function classifyLessonFailure(detail: string): CliProviderError {
  return classifyCliProviderFailure(detail, 'lesson provider');
}

/**
 * Matches one balanced brace span starting at `start`, string-aware. Returns
 * the end index (inclusive) or null when the braces never balance.
 */
function matchBraceSpan(raw: string, start: number): number | null {
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
      if (depth === 0) return index;
    }
  }
  return null;
}

/**
 * Yields parseable JSON objects found in the output, scanning past braces that
 * belong to prose. Anchoring on only the first '{' meant a preamble like
 * "분석 결과 {핵심}은..." discarded the valid JSON that followed it.
 */
function* parseableJsonObjects(raw: string): Generator<unknown> {
  let searchFrom = 0;
  for (let attempt = 0; attempt < MAX_JSON_SCAN_ATTEMPTS; attempt += 1) {
    const start = raw.indexOf('{', searchFrom);
    if (start === -1) return;
    const end = matchBraceSpan(raw, start);
    if (end === null) {
      searchFrom = start + 1;
      continue;
    }
    try {
      yield JSON.parse(raw.slice(start, end + 1));
      searchFrom = end + 1;
    } catch {
      searchFrom = start + 1;
    }
  }
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

function toLesson(parsed: unknown): ExtractedLesson | null {
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
 * Returns null for anything that is not a usable lesson so a chatty preamble or
 * a half-filled object cannot become stored guidance. A lesson without a name,
 * a trigger, or at least one step has nothing for a later session to execute.
 */
export function parseLessonOutput(raw: string): ExtractedLesson | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes(NO_DURABLE_LESSON)) return null;

  for (const parsed of parseableJsonObjects(trimmed)) {
    const lesson = toLesson(parsed);
    if (lesson) return lesson;
  }
  return null;
}

/**
 * Maps provider output onto the caller's caching contract: null only for the
 * model's *explicit* no-lesson verdict (which the candidate service caches as
 * deterministic), a lesson when one parses, and a thrown error for anything
 * else. Folding unparseable output into null let one truncated or chatty
 * response be cached as a permanent "no lesson" for the group.
 */
export function resolveLessonVerdict(raw: string): ExtractedLesson | null {
  if (raw.includes(NO_DURABLE_LESSON)) return null;
  const lesson = parseLessonOutput(raw);
  if (!lesson) {
    throw classifyLessonFailure('unparseable lesson output');
  }
  return lesson;
}

/**
 * Returns null only when the model's verdict is that the session group holds
 * no reusable procedure — callers cache that as deterministic. Anything that
 * prevented a verdict (extraction disabled, empty transcript, unparseable
 * output) throws instead: returning null for those would let a config toggle
 * or one bad response be cached as a permanent false "no lesson" for the
 * group. Callers must treat null as "emit no candidate" rather than falling
 * back to the template text this module exists to stop producing.
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
  if (!isLlmLessonExtractionEnabled(env)) {
    throw new CliProviderError('lesson extraction is disabled', 'provider-disabled');
  }
  if (source.transcript.trim().length === 0) {
    throw new CliProviderError('lesson extraction needs a non-empty transcript', 'empty-transcript');
  }

  const provider = options.provider ?? getLessonProviderName(env);
  const model = options.model ?? getLessonModel(env, provider);
  const timeoutMs = options.timeoutMs ?? resolveCliTimeoutMs(env.CLAUDE_MEMORY_LESSON_TIMEOUT_MS);

  const raw = await runCliProvider({
    provider,
    model,
    prompt: buildLessonPrompt(source),
    timeoutMs,
    scratchDirName: 'cml-lesson',
    label: 'lesson provider'
  });
  return resolveLessonVerdict(raw);
}
