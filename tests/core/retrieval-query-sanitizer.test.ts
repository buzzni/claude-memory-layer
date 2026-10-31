import { describe, expect, it } from 'vitest';
import { sanitizeRetrievalQuery } from '../../src/core/retrieval-query-sanitizer.js';

const logLines = (count: number) =>
  Array.from({ length: count }, (_, i) => `[build] step ${i} finished without warnings`).join('\n');

describe('sanitizeRetrievalQuery', () => {
  it('passes queries of 200 characters or less through unchanged', () => {
    const query = '세션 시작 훅에서 교훈 목록이 두 번 주입되는 이유를 찾아줘. src/adapters/claude/hooks/session-start.ts 확인';
    const exactly200 = 'a'.repeat(200);

    expect(sanitizeRetrievalQuery(query)).toEqual({ query, method: 'passthrough' });
    expect(sanitizeRetrievalQuery(exactly200)).toEqual({ query: exactly200, method: 'passthrough' });
  });

  it('extracts the last sentence ending with a question mark from a long query', () => {
    const query = `${logLines(8)}\n이 빌드는 왜 캐시를 다시 만들까? 로그는 위와 같다.\n${logLines(2)}`;

    expect(sanitizeRetrievalQuery(query)).toEqual({
      query: '이 빌드는 왜 캐시를 다시 만들까?',
      method: 'question'
    });
  });

  it('prefers an explicit question mark over a Korean question ending', () => {
    const query = `${logLines(8)}\nWhy does the cache rebuild on every run?\n다시 시도해 주세요\n${logLines(1)}`;

    expect(sanitizeRetrievalQuery(query)).toMatchObject({
      query: 'Why does the cache rebuild on every run?',
      method: 'question'
    });
  });

  it.each([
    ['이 마이그레이션을 되돌려도 안전한가요'],
    ['어느 레인이 이 결과를 골랐을까'],
    ['이 경고는 무시해도 되나요'],
    ['실패 원인을 정리해줘.'],
    ['임베딩 큐를 비우는 방법을 알려 주세요']
  ])('treats a sentence with a Korean question or request ending as the intent: %s', (intent) => {
    const query = `${intent}\n${logLines(8)}`;

    expect(sanitizeRetrievalQuery(query)).toEqual({ query: intent, method: 'korean_intent' });
  });

  it('falls back to the last sentence when no sentence asks anything', () => {
    const query = `${logLines(8)}\n빌드 캐시는 매번 새로 만들어진다.`;

    expect(sanitizeRetrievalQuery(query)).toEqual({
      query: '빌드 캐시는 매번 새로 만들어진다.',
      method: 'tail_sentence'
    });
  });

  it('truncates to the tail when no sentence is long enough to stand alone', () => {
    const query = Array.from({ length: 80 }, (_, i) => `x${i}`).join('\n');

    const result = sanitizeRetrievalQuery(query);

    expect(result.method).toBe('tail_truncation');
    expect(result.query.length).toBeLessThanOrEqual(250);
    expect(result.query.endsWith('x79')).toBe(true);
  });

  it('never starts a truncated tail in the middle of a token', () => {
    const query = Array.from({ length: 60 }, (_, i) => `token${i}`).join(' ');

    const result = sanitizeRetrievalQuery(query);

    expect(result.method).toBe('tail_sentence');
    expect(result.query.length).toBeLessThanOrEqual(250);
    expect(query.split(' ')).toContain(result.query.split(' ')[0]);
  });

  it('keeps identifiers that only appear in the dropped part of the query', () => {
    const query = [
      'PR #122 이후 src/adapters/claude/hooks/user-prompt-submit.ts 의 쿼리 생성이 바뀌었고 커밋 687f6dc 에서 확인했다.',
      logLines(8),
      '이 변경이 회귀를 만들었나요?'
    ].join('\n');

    const result = sanitizeRetrievalQuery(query);

    expect(result.method).toBe('question');
    expect(result.query.startsWith('이 변경이 회귀를 만들었나요?')).toBe(true);
    expect(result.query).toContain('#122');
    expect(result.query).toContain('src/adapters/claude/hooks/user-prompt-submit.ts');
    expect(result.query).toContain('687f6dc');
  });

  it('strips Korean particles and brackets around preserved identifiers', () => {
    const query = `(#122)에서 바꾼 src/core/prompt-normalizer.ts를 687f6dc에서 봤다.\n${logLines(8)}\n이 변경이 회귀를 만들었나요?`;

    expect(sanitizeRetrievalQuery(query).query)
      .toBe('이 변경이 회귀를 만들었나요? #122 src/core/prompt-normalizer.ts 687f6dc');
  });

  it('keeps files, deep paths, and URLs but not slash-separated words or slash commands', () => {
    const query = [
      'A/B 비교와 translation/localization 메모, /role-context 실행, src/core 확인.',
      '파일 ./scripts/x.sh 와 /Users/justin/workspace/repo 그리고 hooks/user-prompt-submit.ts:417 참고.',
      'https://github.com/buzzni/claude-memory-layer/pull/122 도 봤다.',
      logLines(8),
      '이 변경이 회귀를 만들었나요?'
    ].join('\n');

    expect(sanitizeRetrievalQuery(query).query).toBe([
      '이 변경이 회귀를 만들었나요?',
      './scripts/x.sh',
      '/Users/justin/workspace/repo',
      'hooks/user-prompt-submit.ts:417',
      'https://github.com/buzzni/claude-memory-layer/pull/122'
    ].join(' '));
  });

  it('does not pick a lone markup tag as the last sentence', () => {
    const query = `<task>\n${logLines(8)}\n빌드 캐시는 매번 새로 만들어진다.\n</default_follow_through_policy>\n</task>`;

    expect(sanitizeRetrievalQuery(query)).toEqual({
      query: '빌드 캐시는 매번 새로 만들어진다.',
      method: 'tail_sentence'
    });
  });

  it('stays fast on a long pasted blob without whitespace', () => {
    const query = `${'A'.repeat(30_000)}\n${'!'.repeat(30_000)}a\n이 덤프는 어디서 생겼나요?`;

    const started = performance.now();
    const result = sanitizeRetrievalQuery(query);

    expect(result.query).toBe('이 덤프는 어디서 생겼나요?');
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('does not split paths or version numbers into sentences', () => {
    const query = `${logLines(8)}\nscripts/guard-release-artifact.cjs 는 v2.4.17 에서 왜 실패했나요?`;

    expect(sanitizeRetrievalQuery(query).query).toBe('scripts/guard-release-artifact.cjs 는 v2.4.17 에서 왜 실패했나요?');
  });

  it('does not repeat identifiers the extracted sentence already contains', () => {
    const query = `${logLines(8)}\n#119 는 왜 아직 열려 있나요?`;

    expect(sanitizeRetrievalQuery(query).query).toBe('#119 는 왜 아직 열려 있나요?');
  });

  it('does not treat plain hex-free words or bare numbers as commit SHAs', () => {
    const query = `facade 1234567 deadline 메모\n${logLines(8)}\n마감 시각은 어디서 정하나요?`;

    expect(sanitizeRetrievalQuery(query).query).toBe('마감 시각은 어디서 정하나요?');
  });
});
