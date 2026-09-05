import { describe, expect, it } from 'vitest';
import { rankCuratedLessons } from '../../src/extensions/mcp/lesson-ranking.js';
import type { MemoryLesson } from '../../src/core/types.js';

// specs/lesson-recall-hooks R5 — mem-context-pack 의 Curated Lessons 는 질의와 무관하게 최신 3건만
// 붙었다(서로 다른 질의 2개에 순서까지 동일). 질의가 있으면 그 질의를 덮는 교훈이 올라와야 한다.
function lesson(id: string, name: string, trigger: string, updatedAt: string): MemoryLesson {
  return {
    lessonId: id, projectHash: 'p', name, trigger, steps: ['step'], confidence: 1,
    sourceSessionIds: [], sourceEventIds: [], failureModes: [], skillCandidate: false,
    sourceClass: 'curated', createdAt: new Date(updatedAt), updatedAt: new Date(updatedAt)
  };
}
const newest = lesson('l-new', 'stacked PR 머지 후 base 재지정', '스택 PR 의 아래 PR 이 squash 머지된 직후', '2026-09-05T07:50:00Z');
const middle = lesson('l-mid', 'assertion flake 는 간섭이다', '전체 스위트에서만 깨지는 테스트를 만났을 때', '2026-09-05T05:43:00Z');
const oldest = lesson('l-old', 'preview 포트 충돌 복구 절차', 'preview 서버가 EADDRINUSE 로 죽을 때', '2026-08-01T00:00:00Z');
const byRecency = [newest, middle, oldest];

describe('rankCuratedLessons', () => {
  it('puts the lesson that covers the query first even when it is the oldest', () => {
    const out = rankCuratedLessons(byRecency, 'preview 서버 EADDRINUSE 포트 충돌 복구', 3);
    expect(out[0]?.lessonId).toBe('l-old');
  });

  it('falls back to repository order when no lesson covers the query', () => {
    expect(rankCuratedLessons(byRecency, '데스크탑 앱 자동 업데이트 서명 오류', 3).map((l) => l.lessonId))
      .toEqual(['l-new', 'l-mid', 'l-old']);
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
    expect(out[0]?.lessonId).toBe('l-old');
    expect(out).toHaveLength(3);
  });
});
