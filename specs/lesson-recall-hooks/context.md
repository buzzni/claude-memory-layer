# Lesson Recall Hooks Context

> **Status**: 완료 — PR #87 머지, v2.4.0 발행·전역 설치 반영 (2026-09-05)
> **Created**: 2026-09-05
> **Last Updated**: 2026-09-05

## 1. 배경 — 어떻게 발견됐나

Desktop 저장소 세션에서 교훈을 저장한 직후 `mem-context-pack` 으로 회수를 시험했더니 방금 저장한
교훈이 안 나왔다. 질의를 전혀 다른 것으로 바꿔도 **같은 3건이 같은 순서로** 나와 최신순 고정임을
확인했고, 이어서 훅 코드·원장(`memory_helpfulness`, `retrieval_traces`)·시뮬레이션으로 정량화했다
(수치는 spec §1.1). 핵심 사실: **교훈 주입은 원장에 거의 남지 않아, "잘 활용되는지"를 지금은 알 수 없다.**

## 2. 결정 로그 (최신이 위)

- [2026-09-05] SessionStart 인덱스는 CML 훅에 둔다 / 이유: `~/.claude/settings.json` 의 5개 훅을 CML 이
  전부 소유하고 있어 init-project 셸 훅에서 넣으면 같은 절이 두 번 들어간다.
- [2026-09-05] 인덱스 항목에 lessonId 를 넣지 않고 `name` 으로 단건 조회 / 이유: 예산의 22% 절약,
  `UNIQUE(project_hash, name)` 이 있어 안전.
- [2026-09-05] 교훈 임베딩은 비목표 / 이유: 어휘 스캔 전체 151건이 ms 단위이고 p90 0.98. 필요가 증명된 뒤.
- [2026-09-05] 슬롯 예약은 1건·minScore 이상·비어 있을 때만 / 이유: 이벤트 근거를 교훈이 밀어내면
  안 된다는 기존 정책 주석("a reviewed runbook must not outrank exact evidence")과 충돌하지 않게.

## 3. 시도했으나 실패한 접근

- 설치된 `user-prompt-submit.js` 에 가짜 stdin 을 넣는 단독 프로브 → **빈 봉투만 반환.** 원인: 훅은
  `session-registry.json` 의 세션→프로젝트 매핑으로 스토어를 찾는데, session-start 를 거치지 않은
  가짜 session_id 는 매핑이 없다. 검증은 `CLAUDE_MEMORY_EVAL_MODE=true` 로 session-start → user-prompt-submit
  을 **같은 session_id 로 연쇄 실행**해야 한다.
- 스크래치패드 경로에서 `npx tsx` 로 CML 소스를 import → `better-sqlite3` 해석 실패. 저장소 안에서 실행할 것.

## 4. 발견된 문제 (범위 밖)

- CLI `lesson list --json` 은 `count: 100` 인데 배열은 25건 — `sanitizeOperationOutput` 이 모든 배열을 25로 자른다.
- `retrieval_traces.candidate_details_json` 이 비어 있는 행이 많아 후보 점수 사후 분석이 불가하다.

## 5. 구현 결과 (2026-09-05)

| 항목 | 결과 |
|------|------|
| R1 SessionStart 인덱스 | `formatLessonIndexContext` — 실기 프로브에서 151건 중 **14건이 2,267자**에 주입, 꼬리에 "14 of 151" |
| R2 전체 스캔 | `LESSON_SCAN_LIMIT = 500` (저장소 상한) |
| R3 슬롯 예약 | `reserveLessonSlot` — 변이 3종(minScore 게이트·중복 가드·최약체 교체) 모두 red |
| R4 `mem-lesson-get` | id 또는 name, 타 프로젝트 행 차단, enforced 모드 권한 검사, 스키마 베이스라인 갱신(44→45) |
| R5 context-pack | `rankCuratedLessons` — 변이 2종 red |
| R6 참조 카드 | fetch 안내 → `mem-lesson-get` |

실기 검증(임시 HOME 에 DB `.backup` 복사, `CLAUDE_MEMORY_EVAL_MODE=true`, session-start → user-prompt-submit
같은 session_id 연쇄): 인덱스 주입 확인, 교훈과 거의 같은 문장을 넣은 프롬프트에서 **해당 교훈(806a9068)이
Memory evidence 에 `[lesson]` 로 등장.** 이전에는 같은 절차로 빈 봉투(원장 기준 4,767건 중 5건).

### 결정: `[event:<id>]` 라벨은 교훈에도 그대로 둔다
`formatMemoryContext` 는 교훈에도 `[event:<lessonId>]` 를 붙인다. 바꾸려 했으나 기존 테스트
("marks each memory with its event id for the evaluation harness")가 그 정규식을 평가 하네스 계약으로
고정하고 있어 유지. 모델이 이 id 로 `mem-details` 를 부르면 실패하지만, 안내 문구가 fetch 가 아니라
📎 인용을 요구하므로 실사용 영향은 작다. `[lesson:<id>]` 로 바꾸려면 하네스 정규식도 함께 바꿔야 한다 — 후속.

### 변이 검증에서 드러난 중복 1건
`formatLessonIndexContext` 의 `budgetChars <= 0 || lessons.length === 0` 조기 반환은 루프의 break 와
`items.length === 0` 반환이 이미 보장하는 동작이라 제거했다(변이 M3 가 red 가 되지 않아 드러남).

## 6. 배포 기록과 다음 단계

- 2026-09-05 PR #87 머지 → `chore(release): v2.4.0` → 태그 푸시. 첫 발행은 `npm audit --omit=dev` 에서
  실패(v2.3.5 이후 공개된 fast-uri·qs advisory, 의존성 변경은 없었음) → `npm audit fix` 로 lock 만 갱신
  (`22c4955`) → 미발행 태그 재지정 → 발행 성공. 전역 설치 2.3.5 → 2.4.0, 설치본으로 실기 프로브 확인.
- 함정: `npm audit fix --omit=dev` 는 node_modules 에서 devDependencies 를 지운다(tsc·vitest 사라짐).
  audit fix 는 omit 없이 실행하고, 검사만 `npm audit --omit=dev` 로 할 것.
- MCP 서버 프로세스는 세션 시작 시 로드되므로 이미 열려 있던 세션에는 `mem-lesson-get` 이 없다.

1. ~~발행·업그레이드~~ 완료.
2. 배포 뒤 init-project `session_start.sh` 의 안내 문구("mem-context-pack / mem-lesson-list 로 회수할 수
   있습니다")를 "인덱스는 위에 주입됨, 본문은 mem-lesson-get" 으로 갱신(별도 저장소, 서브모듈 bump 필요).
3. 활용 측정: `retrieval_traces.strategy='session-start-lessons'` 와 `memory_helpfulness.event_id IN
   memory_lessons` 로 주입·인용 비율을 본다. 지금까지는 이 숫자가 0 에 가까웠다.
4. 후속 후보: 예산 초과 시 통합 압박(hermes "consolidate now"), `[lesson:]` 라벨 + 하네스 정규식.
