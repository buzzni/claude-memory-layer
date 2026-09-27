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

  // 실사용 2026-09-26: "응 진행 해줘"에 무관한 교훈 3건이 붙었다. 의미 있는 단어가 0개면
  // 겹침 기준 min(3, 0)이 0이 되어 모든 교훈이 기본 점수로 통과하던 결함.
  it.each(['응 진행 해줘', '응', 'ok', '네 해주세요'])(
    '의미 있는 단어가 없는 짧은 응답에는 아무 교훈도 내보내지 않는다: %s',
    query => {
      expect(rankCuratedLessons(byRecency, query, 3)).toEqual([]);
    }
  );

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


describe('bilingual read-only lesson recall', () => {
  const runtime = lesson('runtime', 'happy-running-version-from-startup-diagnostic',
    'Verify the Happy CLI running version rather than the installed package version', '2026-09-23',
    ['Read the process startup diagnostic to confirm its running version']);
  it.each([
    '이 프로젝트에서 현재 대화가 실제 사용 중인 Happy CLI 버전을 확인해주세요. 설치된 패키지 버전과 구분해서 근거와 함께 짧게 알려주세요. 읽기 전용으로 확인하고 파일 수정·설치·교훈 저장은 하지 마세요. 인증정보나 대화 로그 전체는 출력하지 마세요.',
    '실행 중인 Happy CLI 버전을 확인할 때 이 프로젝트에 저장된 관련 교훈이 있으면 찾아서 적용하고, 실제로 참고한 교훈 이름과 검증 근거를 구분해 알려주세요. 읽기 전용으로 확인하고 파일/교훈 저장·설치는 하지 마세요. 로그 전체나 인증정보는 출력하지 마세요.',
  ])('recalls an English runbook for a Korean request with non-mutating constraints: %s', query => {
    expect(rankCuratedLessons([runtime], query, 3)).toEqual([runtime]);
  });
  it.each([
    'Happy CLI 버전 교훈을 적용하지 마세요.',
    'Happy CLI 버전 확인. 교훈 검색은 하지 마세요.',
    'Happy CLI 버전 확인. 파일 수정과 교훈 적용은 하지 마세요.',
    '다른 도구의 버전을 확인해주세요.',
    'Happy CLI 설치 방법을 알려주세요.',
  ])('does not widen recall to prohibited or different tasks: %s', query => {
    expect(rankCuratedLessons([runtime], query, 3)).toEqual([]);
  });
});

// Frozen applicability cases from the cross-session audit (2026-09-27).
// Common downstream steps cannot establish a special condition.
describe('applicability rather than incidental procedure vocabulary', () => {
  const pool = [
    lesson('conflict', 'merge-conflict-preserve-intent', 'PR merge 충돌 conflict 해결이 필요한 때', '2026-09-01',
      ['commit push PR 생성 전에 Desktop 자식 패널 표시 코드를 확인한다']),
    lesson('stale', 'closing-stale-pr-preserves-knowledge', '오래된 stale PR 닫기 close 직전', '2026-09-01',
      ['commit push PR 작업 이력을 확인한다']),
    lesson('stack', 'stacked-pr-branch-before-commit', 'stacked 스택 PR 브랜치 여러 개 작업 시', '2026-09-01',
      ['commit push PR 전에 branch 를 확인한다']),
    lesson('mapping', 'error-code-mapping-core-extension', 'Extension 오류 코드 매핑 변경 시', '2026-09-01',
      ['Desktop 자식 패널 표시까지 확인한다']),
  ];
  it.each(['push & pr 해줘', 'commit & pr', 'commit push PR 해줘', 'Desktop 자식 패널 표시는 왜 안되는거지?'])(
    'abstains without the special condition: %s', query => {
      expect(rankCuratedLessons(pool, query, 3)).toEqual([]);
    });
  it.each([
    ['PR merge 충돌 해결', 'conflict'],
    ['resolve PR merge conflict', 'conflict'],
    ['오래된 PR 닫기', 'stale'],
    ['close stale PR', 'stale'],
    ['스택 PR 브랜치 작업', 'stack'],
    ['stacked PR branch', 'stack'],
    ['Extension 오류 코드 매핑 변경', 'mapping'],
  ])('retains an applicable condition: %s', (query, id) => {
    expect(rankCuratedLessons(pool, query, 3).map(item => item.lessonId)).toEqual([id]);
  });
  it('preserves queryless exploration independently of automatic applicability', () => {
    expect(rankCuratedLessons(pool, undefined, 3)).toEqual(pool.slice(0, 3));
  });
});

it('requires the specific condition even when two subject words overlap', () => {
  const squash = lesson('squash', 'stacked-pr-after-bottom-squash-merge', '스택 PR 아래 PR squash 머지 직후', '2026-09-01', ['merge 충돌 해결 전에 기록을 확인']);
  const iframe = lesson('iframe', 'extension-panel-sandboxed-iframe', 'Extension 패널 테스트 작성 시', '2026-09-01', ['오류 코드 매핑을 확인']);
  expect(rankCuratedLessons([squash], 'PR merge 충돌 해결', 3)).toEqual([]);
  expect(rankCuratedLessons([iframe], 'Extension 패널 오류 코드 매핑', 3)).toEqual([]);
  expect(rankCuratedLessons([squash], 'stacked PR squash merge', 3)).toEqual([squash]);
  expect(rankCuratedLessons([iframe], 'Extension 패널 테스트', 3)).toEqual([iframe]);
});

it('ignores delivery locations and bare particles but preserves bilingual conflict conditions', () => {
  const stack = lesson('stack', 'stacked-pr-branch-before-commit', '스택 PR 브랜치 작업 시', '2026-09-01', ['commit push PR 준비']);
  const hygiene = lesson('hygiene', 'branch-hygiene-one-worktree', 'worktree 에서 branch commit PR 정리 시', '2026-09-01', ['commit push PR 확인']);
  const conflict = lesson('conflict', 'merge-conflict-resolution', 'PR이 main과 conflicting 상태가 돼 실제 merge로 해소할 때', '2026-09-01', ['PR merge 충돌 해결']);
  for (const query of ['새 브랜치 만들어서 commit push PR 해줘', 'commit & push to a new branch and open a PR', 'PR merge 해줘', 'worktree 에서 commit push PR 해줘', 'PR 브랜치 에서 commit 해줘']) {
    expect(rankCuratedLessons([stack, hygiene, conflict], query, 3)).toEqual([]);
  }
  expect(rankCuratedLessons([conflict], 'PR merge 충돌 해결', 3)).toEqual([conflict]);
  expect(rankCuratedLessons([conflict], 'resolve PR merge conflict', 3)).toEqual([conflict]);
});

it('does not use git itself as a special-condition clue', () => {
  const hygiene = lesson('hygiene', 'branch-hygiene-one-worktree', 'main 브랜치 git worktree 에서 checkout 전', '2026-09-01', ['git pull 받고 push 전에 기록 확인']);
  for (const query of ['main 브랜치에서 git pull 받고 push', 'git worktree 에서 main pull 해줘']) {
    expect(rankCuratedLessons([hygiene], query, 3)).toEqual([]);
  }
  expect(rankCuratedLessons([hygiene], 'git checkout main', 3)).toEqual([hygiene]);
});
