# Lesson Recall Hooks Plan

> **Status**: Implemented (PR 대기)
> **Created**: 2026-09-05
> **Spec**: [spec.md](./spec.md)

## 아키텍처 영향

| 항목 | 내용 |
|------|------|
| 관련 모듈 | `src/adapters/claude/hooks/{session-start,user-prompt-submit,prompt-injection-policy}.ts`, `src/extensions/mcp/{handlers,tool-definitions}.ts`, `handlers/domains/graph-lessons.ts`, `src/core/memory-reference-context.ts` |
| 새 외부 의존성 | 없음 |
| 공개 API 변경 | MCP 도구 `mem-lesson-get` 추가(additive). 훅 stdout 에 `## Project Lessons` 절 추가(additive) |
| 스키마 변경 | 없음 — `memory_lessons` 그대로. `retrieval_traces.strategy` 에 새 값 `session-start-lessons` |

## 접근

기존 회수 기계를 그대로 쓰고 **선택 범위와 위치만 고친다.** 채점기(`scoreLessonEvidence`), 참조 포맷터,
`LessonRepository`, 원장(`recordQueryTrace`/`recordRetrieval`)은 전부 있다. 없는 것은 (a) 세션 시작
인덱스, (b) 전체 스캔, (c) 이벤트에 밀리지 않는 슬롯, (d) 단건 조회 도구다.

기각한 대안:
- **init-project 셸 훅에서 sqlite3 로 직접 읽어 주입** — 스키마·해시 계산(git 루트 기반 SHA-256)에
  결합되고, CML 훅이 이미 SessionStart 를 소유하므로 두 훅이 같은 절을 두 번 넣게 된다.
- **교훈 임베딩** — 151행 어휘 스캔이 ms 단위고 p90 0.98 이 나온다. 비용 대비 근거 없음.
- **인덱스에 lessonId(36자) 포함** — 15건이면 540자, 예산의 22%. `name` 이 프로젝트 내 UNIQUE 라
  `mem-lesson-get {name}` 으로 충분하다.

## 단계

- [x] **Phase 1 — 턴별 lane (R2, R3)**: `reserveLessonSlot` 순수 함수 + 테스트, `LESSON_SCAN_LIMIT`
      → 검증: `tests/adapters/claude-hook-prompt-injection-policy.test.ts`
- [x] **Phase 2 — 세션 시작 인덱스 (R1)**: `formatLessonIndexContext` 순수 함수 + 테스트, `session-start.ts` 배선
      → 검증: `tests/adapters/claude-hook-session-start.test.ts`
- [x] **Phase 3 — 단건 조회 (R4, R6)**: `mem-lesson-get` 정의·핸들러·도메인 등록, 참조 카드 문구
      → 검증: `tests/extensions/mcp-operation-tools.test.ts`, `mcp-tool-profiles.test.ts`, `memory-reference-context.test.ts`
- [x] **Phase 4 — context-pack (R5)**: `rankCuratedLessons(lessons, query)` 순수 함수 + `loadCuratedLessons` 배선
      → 검증: 신규 단위 테스트
- [x] **Phase 5 — 게이트·실기**: typecheck/lint/test, `CLAUDE_MEMORY_EVAL_MODE=true` 두 훅 연쇄 실행으로
      인덱스·질의 매칭 교훈이 stdout 에 나타나는지 확인, context.md 갱신

## 리스크

- **인덱스가 프롬프트를 비대화** → 문자 예산 2,400자(≈hermes MEMORY 2,200) 고정, env 로 0 가능.
- **슬롯 예약이 무관한 교훈을 밀어 넣음** → 이미 어휘 게이트(용어 3개 이상 겹침)를 통과한 후보만
  대상이고 1건으로 제한. 시뮬레이션상 84% 프롬프트는 후보 자체가 없다.
- **SessionStart 가 `compact` 에도 발화** → 재압축 뒤 인덱스가 다시 들어오는 것은 의도된 동작(hermes 동결 스냅샷과 같은 효과).
