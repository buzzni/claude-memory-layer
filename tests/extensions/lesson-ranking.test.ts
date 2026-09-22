import { describe, expect, it } from 'vitest';
import { rankCuratedLessons } from '../../src/extensions/mcp/lesson-ranking.js';
import type { MemoryLesson } from '../../src/core/types.js';

// specs/lesson-recall-hooks R5 — mem-context-pack 의 Curated Lessons 는 질의와 무관하게 최신 3건만
// 붙었다(서로 다른 질의 2개에 순서까지 동일). 질의가 있으면 그 질의를 덮는 교훈이 올라와야 한다.
// specs/lesson-learning-reliability R3 — 질의가 있는 pack 은 남은 자리를 무관한 교훈으로 채우지 않는다.
function lesson(
  id: string,
  name: string,
  trigger: string,
  updatedAt: string,
  steps: string[] = ['step']
): MemoryLesson {
  return {
    lessonId: id, projectHash: 'p', name, trigger, steps, confidence: 1,
    sourceSessionIds: [], sourceEventIds: [], failureModes: [], skillCandidate: false,
    sourceClass: 'curated', createdAt: new Date(updatedAt), updatedAt: new Date(updatedAt)
  };
}
const newest = lesson('l-new', 'stacked PR 머지 후 base 재지정', '스택 PR 의 아래 PR 이 squash 머지된 직후', '2026-09-05T07:50:00Z');
const middle = lesson('l-mid', 'assertion flake 는 간섭이다', '전체 스위트에서만 깨지는 테스트를 만났을 때', '2026-09-05T05:43:00Z');
const oldest = lesson(
  'l-old',
  'preview 포트 충돌 복구 절차',
  'preview 서버가 EADDRINUSE 로 죽을 때',
  '2026-08-01T00:00:00Z',
  ['남은 프로세스를 정리해 포트를 회수한 뒤 서버를 다시 띄운다']
);
const byRecency = [newest, middle, oldest];

describe('rankCuratedLessons', () => {
  it.each([
    'Explain applyHttpCachePolicy. 도구 호출/파일 수정은 하지 마세요.',
    'applyHttpCachePolicy 설정을 설명해 주세요. 도구 호출 및 파일 수정은 하지 마세요.',
    '도구 호출은 하지 마세요. Explain applyHttpCachePolicy.',
    'Explain applyHttpCachePolicy\n파일 수정은 하지 마세요.',
    'Explain applyHttpCachePolicy. Do not call tools or edit files.',
    'Explain applyHttpCachePolicy; Please do not use tools and modify files.',
    "Don't edit files. Explain applyHttpCachePolicy.",
    'Explain applyHttpCachePolicy\nNever invoke tools.',
  ])('keeps a requested subject searchable with a standalone execution-only constraint: %s', query => {
    const exact = lesson('cache', 'applyHttpCachePolicy response rules', 'When applyHttpCachePolicy configures browser caching', '2026-09-01');
    expect(rankCuratedLessons([exact], query, 3)).toEqual([exact]);
  });

  it.each([
    'Do not use applyHttpCachePolicy. Do not call tools or edit files.',
    'Explain applyHttpCachePolicy. Do not call tools or edit files. Ignore this procedure.',
    'applyHttpCachePolicy를 적용하지 마세요. 도구 호출/파일 수정은 하지 마세요.',
    'applyHttpCachePolicy 설명. 도구 호출/파일 수정은 하지 마세요. 이 교훈을 무시해.',
    'Explain applyHttpCachePolicy. Do not call tools to run this procedure.',
    'Explain applyHttpCachePolicy. 도구 호출/파일 수정과 교훈 적용은 하지 마세요.',
    'Explain applyHttpCachePolicy. 도구 호출, 수동 메모리 조회, 파일 수정은 하지 마세요.',
    'Explain applyHttpCachePolicy but do not call tools or edit files.',
    'Do not call tools or edit files.',
    '도구 호출/파일 수정은 하지 마세요.',
  ])('does not remove targeted, mixed, ambiguous or subject-free prohibitions: %s', query => {
    const exact = lesson('cache', 'applyHttpCachePolicy response rules', 'When applyHttpCachePolicy configures browser caching', '2026-09-01');
    expect(rankCuratedLessons([exact], query, 3)).toEqual([]);
  });

  it('recalls an exact technical subject despite unrelated question boilerplate, without accepting a partial or conflicting identifier', () => {
    const exact = lesson('cache', 'applyHttpCachePolicy response rules', 'When applyHttpCachePolicy configures browser caching', '2026-09-01');
    const other = lesson('other', 'applyHttpCachePolicyUnsafe legacy rules', 'Legacy browser caching', '2026-09-01');
    const pool = [other, exact];
    expect(rankCuratedLessons(pool, 'Investigate applyHttpCachePolicy tomorrow.', 3)).toEqual([exact]);
    expect(rankCuratedLessons(pool, 'applyHttpCachePolicy 설정을 조사해 주세요', 3)).toEqual([exact]);
    expect(rankCuratedLessons(pool, 'Explain applyHttpCachePolicy legacy rules browser caching', 3)).toEqual([exact]);
    expect(rankCuratedLessons(pool, 'Investigate applyHttpCachePolicy and retryWithJitter tomorrow.', 3)).toEqual([]);
    expect(rankCuratedLessons(pool, 'Investigate applyHttpCachePolicyMissing tomorrow.', 3)).toEqual([]);
    expect(rankCuratedLessons(pool, 'Skip applyHttpCachePolicy tomorrow.', 3)).toEqual([]);
    expect(rankCuratedLessons(pool, 'Do not use applyHttpCachePolicy tomorrow.', 3)).toEqual([]);
  });

  it('does not interpret a data structure name as an imperative prohibition', () => {
    const skipList = lesson('skip', 'Skip list indexing', 'Skip list indexing performance', '2026-09-01');
    expect(rankCuratedLessons([skipList], 'Explain skip list indexing performance', 3)).toEqual([skipList]);
  });

  it.each([
    'Skip the preview 서버 EADDRINUSE 포트 충돌 복구 procedure',
    'Ignore the preview 서버 EADDRINUSE 포트 충돌 복구 procedure',
    'Omit the preview 서버 EADDRINUSE 포트 충돌 복구 procedure',
    'Do-not apply the preview 서버 EADDRINUSE 포트 충돌 복구 procedure',
    'preview 서버 EADDRINUSE 포트 충돌 복구 절차를 건너뛰어.',
    'preview 서버 EADDRINUSE 포트 충돌 복구 절차는 사용 금지.',
    'preview 서버 EADDRINUSE 포트 충돌 복구 절차를 무시해.',
    'preview 서버 EADDRINUSE 포트 충돌 복구 절차를 적용하지 않는다.',
  ])('does not let lexical matches bypass an explicit instruction to omit a procedure: %s', query => {
    expect(rankCuratedLessons(byRecency, query, 3)).toEqual([]);
  });

  it('keeps a safety constraint searchable when the procedure itself is requested', () => {
    expect(rankCuratedLessons(byRecency, 'preview 서버 EADDRINUSE 포트 충돌 복구 without losing data', 3))
      .toEqual([oldest]);
  });

  it.each([
    'preview 서버 포트 충돌 복구를 적용하지 마라.',
    'preview 서버 포트 충돌 복구를 적용하지마세요.',
    'Do not apply the preview 서버 포트 충돌 복구 procedure',
  ])('abstains when an otherwise exact query explicitly prohibits the procedure: %s', query => {
    expect(rankCuratedLessons(byRecency, query, 3)).toEqual([]);
  });

  it('puts the lesson that covers the query first even when it is the oldest', () => {
    const out = rankCuratedLessons(byRecency, 'preview 서버 EADDRINUSE 포트 충돌 복구', 3);
    expect(out[0]?.lessonId).toBe('l-old');
  });

  it('회수한다: 같은 문제를 다른 한국어 표현으로 물어도 그 교훈을 찾는다', () => {
    const out = rankCuratedLessons(byRecency, '프리뷰 서버가 포트 충돌로 재시작에 실패했어', 3);
    expect(out.map((l) => l.lessonId)).toEqual(['l-old']);
  });

  it('질의가 있으면 남은 자리를 무관한 교훈으로 채우지 않는다', () => {
    expect(rankCuratedLessons(byRecency, '데스크탑 앱 자동 업데이트 서명 오류', 3)).toEqual([]);
  });

  it('무관한 한국어 질문에는 아무 교훈도 내보내지 않는다', () => {
    expect(rankCuratedLessons(byRecency, '오늘 회의록 요약해줘', 3)).toEqual([]);
  });

  it('keeps repository order when there is no query at all', () => {
    expect(rankCuratedLessons(byRecency, undefined, 2).map((l) => l.lessonId)).toEqual(['l-new', 'l-mid']);
  });

  it('never returns more than the limit', () => {
    expect(rankCuratedLessons(byRecency, 'preview 서버 EADDRINUSE 포트 충돌 복구', 1)).toHaveLength(1);
  });

  it('lists matching lessons before non-matching ones so a scan wider than the limit still surfaces them', () => {
    const many = [...Array.from({ length: 10 }, (_, i) => lesson(`f${i}`, `filler ${i}`, `무관한 트리거 ${i}`, '2026-09-05T08:00:00Z')), oldest];
    const out = rankCuratedLessons(many, 'preview 서버 EADDRINUSE 포트 충돌 복구', 3);
    expect(out.map((l) => l.lessonId)).toEqual(['l-old']);
  });

  // NOTE: 이 테스트는 넘겨받은 후보 전체를 훑는다는 것만 보장한다. 저장소의 500건 스캔 상한
  // (LessonRepository.list — confidence DESC, updated_at DESC 정렬)은 여기서 검증되지 않는다.
  it('후보가 랭킹 한도보다 훨씬 많아도 최신순 잘림으로 오래된 교훈을 버리지 않는다', () => {
    const many = [
      ...Array.from({ length: 520 }, (_, i) => lesson(`f${i}`, `filler ${i}`, `무관한 트리거 ${i}`, '2026-09-05T08:00:00Z')),
      oldest
    ];
    expect(rankCuratedLessons(many, '프리뷰 서버가 포트 충돌로 재시작에 실패했어', 3)[0]?.lessonId).toBe('l-old');
  });
});
