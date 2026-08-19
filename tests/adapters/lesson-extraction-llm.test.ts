import { describe, expect, it } from 'vitest';

import {
  NO_DURABLE_LESSON,
  buildLessonPrompt,
  classifyLessonFailure,
  getLessonModel,
  getLessonProviderName,
  isLlmLessonExtractionEnabled,
  parseLessonOutput
} from '../../src/adapters/llm/lesson-extraction-llm.js';
import type { LessonExtractionSource } from '../../src/core/operations/lesson-candidate-service.js';

function source(overrides: Partial<LessonExtractionSource> = {}): LessonExtractionSource {
  return {
    sessionCount: 3,
    tools: ['typecheck', 'build'],
    fileCategories: ['source:ts', 'test:ts'],
    taskPatterns: ['code-change'],
    transcript: '## 세션 1\n[사용자] 서비스 추가\n[도구] npm run typecheck exit_code 0',
    ...overrides
  };
}

describe('buildLessonPrompt', () => {
  it('carries the extraction rules that keep steps and guardrails separate', () => {
    const prompt = buildLessonPrompt(source());

    expect(prompt).toContain('상호 배타');
    expect(prompt).toContain('경로 최적화');
    expect(prompt).toContain('추상화');
    expect(prompt).toContain('실행 우선');
    expect(prompt).toContain('원자 범위');
    expect(prompt).toContain(NO_DURABLE_LESSON);
  });

  it('bans literal slashes so the audit redactor cannot truncate a sentence mid-way', () => {
    const prompt = buildLessonPrompt(source());

    // The redactor's absolute-path pattern eats from any "/" to end of line,
    // so the prompt must forbid the character outright rather than only
    // asking for "no absolute paths" in the abstract.
    expect(prompt).toContain('슬래시(/) 금지');
    expect(prompt).toContain('나쁜 예');
    expect(prompt).toContain('좋은 예');
  });

  it('states the observed facts and embeds the transcript', () => {
    const prompt = buildLessonPrompt(source());

    expect(prompt).toContain('성공한 세션 3개');
    expect(prompt).toContain('typecheck, build');
    expect(prompt).toContain('source:ts, test:ts');
    expect(prompt).toContain('[도구] npm run typecheck exit_code 0');
  });

  it('omits fact lines that have no content rather than emitting empty labels', () => {
    const prompt = buildLessonPrompt(source({ fileCategories: [], taskPatterns: [], tools: [] }));

    expect(prompt).not.toContain('공통 검증 도구');
    expect(prompt).not.toContain('공통 파일 종류');
    expect(prompt).not.toContain('공통 작업 유형');
    expect(prompt).toContain('반복 횟수');
  });
});

describe('parseLessonOutput', () => {
  it('parses a well-formed lesson object', () => {
    const parsed = parseLessonOutput(JSON.stringify({
      name: '검증 절차',
      trigger: '커밋 전',
      steps: ['테스트를 돌린다', '타입체크를 돌린다'],
      failureModes: ['검증 전 커밋 금지']
    }));

    expect(parsed).toEqual({
      name: '검증 절차',
      trigger: '커밋 전',
      steps: ['테스트를 돌린다', '타입체크를 돌린다'],
      failureModes: ['검증 전 커밋 금지']
    });
  });

  it('recovers the object from a chatty response', () => {
    const parsed = parseLessonOutput([
      '분석해보겠습니다. 아래가 결과입니다:',
      '```json',
      '{"name":"n","trigger":"t","steps":["s"],"failureModes":[]}',
      '```',
      '도움이 되었길 바랍니다.'
    ].join('\n'));

    expect(parsed?.name).toBe('n');
    expect(parsed?.steps).toEqual(['s']);
  });

  it('scans past a brace inside prose instead of anchoring on the first "{"', () => {
    // Anchoring on the first "{" made "{핵심}" the only parse candidate and
    // discarded the valid JSON that followed.
    const parsed = parseLessonOutput([
      '분석 결과 {핵심}은 다음과 같습니다:',
      '{"name":"n","trigger":"t","steps":["s"],"failureModes":[]}'
    ].join('\n'));

    expect(parsed?.name).toBe('n');
  });

  it('skips a parseable object that is not a lesson and keeps scanning', () => {
    const parsed = parseLessonOutput([
      '{"note":"메타데이터"}',
      '{"name":"n","trigger":"t","steps":["s"],"failureModes":[]}'
    ].join('\n'));

    expect(parsed?.name).toBe('n');
  });

  it('returns null for the no-lesson sentinel', () => {
    expect(parseLessonOutput(NO_DURABLE_LESSON)).toBeNull();
  });

  it.each([
    ['empty output', ''],
    ['no JSON at all', '재사용할 절차가 없습니다.'],
    ['malformed JSON', '{"name": "n", '],
    ['missing name', JSON.stringify({ trigger: 't', steps: ['s'] })],
    ['missing trigger', JSON.stringify({ name: 'n', steps: ['s'] })],
    ['no steps', JSON.stringify({ name: 'n', trigger: 't', steps: [] })],
    ['blank steps only', JSON.stringify({ name: 'n', trigger: 't', steps: ['   '] })]
  ])('returns null for %s', (_label, raw) => {
    expect(parseLessonOutput(raw)).toBeNull();
  });

  it('drops bullet markers, collapses whitespace, and de-duplicates steps', () => {
    const parsed = parseLessonOutput(JSON.stringify({
      name: '  이름  ',
      trigger: '조건',
      steps: ['- 테스트를   돌린다', '테스트를 돌린다', '• 빌드한다'],
      failureModes: []
    }));

    expect(parsed?.name).toBe('이름');
    expect(parsed?.steps).toEqual(['테스트를 돌린다', '빌드한다']);
  });

  it('caps steps at the bullet limit the prompt asks for', () => {
    const parsed = parseLessonOutput(JSON.stringify({
      name: 'n',
      trigger: 't',
      steps: Array.from({ length: 20 }, (_, index) => `단계 ${index}`),
      failureModes: Array.from({ length: 20 }, (_, index) => `금지 ${index}`)
    }));

    expect(parsed?.steps).toHaveLength(8);
    expect(parsed?.failureModes).toHaveLength(6);
  });

  it('accepts a lesson with no failure modes', () => {
    const parsed = parseLessonOutput(JSON.stringify({
      name: 'n',
      trigger: 't',
      steps: ['s'],
      failureModes: []
    }));

    expect(parsed?.failureModes).toEqual([]);
  });
});

describe('provider configuration', () => {
  it('defaults to claude and switches to codex on request', () => {
    expect(getLessonProviderName({})).toBe('claude');
    expect(getLessonProviderName({ CLAUDE_MEMORY_LESSON_PROVIDER: 'codex' })).toBe('codex');
  });

  it('honours a configured model', () => {
    expect(getLessonModel({})).toContain('claude');
    expect(getLessonModel({ CLAUDE_MEMORY_LESSON_MODEL: 'custom-model' })).toBe('custom-model');
  });

  it('passes no model to codex unless one is configured', () => {
    // The claude default model id is unknown to the codex CLI; passing it made
    // every codex extraction fail on an invalid-model error.
    expect(getLessonModel({ CLAUDE_MEMORY_LESSON_PROVIDER: 'codex' })).toBeNull();
    expect(getLessonModel({
      CLAUDE_MEMORY_LESSON_PROVIDER: 'codex',
      CLAUDE_MEMORY_LESSON_MODEL: 'codex-custom'
    })).toBe('codex-custom');
  });

  it('is enabled unless explicitly turned off', () => {
    expect(isLlmLessonExtractionEnabled({})).toBe(true);
    expect(isLlmLessonExtractionEnabled({ CLAUDE_MEMORY_LESSON_MODE: 'off' })).toBe(false);
  });
});

describe('classifyLessonFailure', () => {
  it.each([
    ['spawn ENOENT claude', 'provider-not-found'],
    ['request timed out', 'provider-timeout'],
    ['invalid credential supplied', 'provider-auth'],
    ['something else broke', 'provider-error']
  ])('classifies %s', (detail, code) => {
    expect(classifyLessonFailure(detail).code).toBe(code);
  });
});
