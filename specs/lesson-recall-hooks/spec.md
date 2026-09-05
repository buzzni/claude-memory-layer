# Lesson Recall Hooks Specification

> **Version**: 1.0.0
> **Status**: Approved (사용자 요청 2026-09-05: "훅에서 교훈이 잘 사용되게끔 개선")
> **Created**: 2026-09-05
> **Reference**: hermes-agent `tools/memory_tool.py`, `agent/prompt_builder.py`, `agent/memory_provider.py`

## 1. 개요

### 1.1 문제 정의

`mem-lesson-save` 로 저장한 교훈(`memory_lessons`)이 **거의 회수되지 않는다.** 저장은 되지만 쓰이지 않는
write-mostly 상태다. 2026-09-05 실측(프로젝트 `6ab6d837`, 교훈 151건):

| 경로 | 현재 동작 | 실측 |
|------|-----------|------|
| SessionStart 훅 | 교훈을 전혀 주입하지 않음 (`session-start.ts` 에 lesson 참조 0건) | 주입 0건 |
| UserPromptSubmit 훅 | **최신 15건**만 어휘 채점 → 이벤트(중앙값 0.83)와 슬롯 경쟁 → 컷 | 4,767 프롬프트 중 후보 196건, 선택 **5건(0.1%)** |
| `mem-context-pack` | 질의와 무관하게 **최신 3건** 고정 | 서로 다른 질의 2개에 순서까지 동일 3건 |
| 단건 조회 | 도구 없음 — 참조 카드가 "mem-lesson-list 로 전체를 받아 골라라"고 안내 | — |

실제 프롬프트 1,392건을 교훈 151건 전체에 대해 다시 채점한 시뮬레이션:

| 스캔 창 | 교훈 후보 ≥1 인 프롬프트 | best 점수 p50 / p90 |
|---------|--------------------------|---------------------|
| 3건 (context-pack) | 4.0% | 0.69 / 0.73 |
| 15건 (현재 훅) | 10.8% | 0.69 / 0.76 |
| **전체** | **16.0%** | **0.76 / 0.98** |

창을 넓히면 적중률이 1.5배가 되고, 무엇보다 **거의 문장 단위로 맞는 교훈(0.98)** 이 살아난다.

### 1.2 물리 저장

- 위치: `~/.claude-code/memory/projects/<projectHash>/events.sqlite`, 테이블 `memory_lessons`
  (`lesson_id`, `name`, `trigger`, `steps_json`, `failure_modes_json`, `confidence`, `source_class`, …).
  `projectHash` = git 체크아웃 루트 기준 경로의 SHA-256 앞 8자(워크트리는 같은 해시로 수렴).
- 벡터 임베딩 **없음**(`OutboxItemKindSchema` 에 `lesson` 부재), FTS 없음, HTTP 라우트 없음.
  → 회수는 SQLite 직접 조회 + 어휘 채점(`scoreLessonEvidence`)만 가능하며, 151행 전체 스캔은 ms 단위다.

### 1.3 해결 방향 — hermes 두 층 구조를 벤치마킹

| hermes | 우리 | 이유 |
|--------|------|------|
| `MEMORY.md`/`USER.md` 를 **하드 예산(2,200/1,375자) 안에서 전체를 세션 시작에 동결 주입** (`memory_tool.py:706-770`) | SessionStart 에 **교훈 인덱스**(이름+trigger)를 문자 예산 안에서 주입 | 프롬프트 캐시 안정 + "모델이 목록을 읽고 스스로 판단" |
| 스킬은 **이름+설명 인덱스만 상시**, 본문은 `skill_view` 로 요청 시 (`prompt_builder.py:1763+`, `skills_tool.py:1988`) | 인덱스에는 이름+trigger 만, 본문은 `mem-lesson-get` 으로 | progressive disclosure — 151건 본문(≈90k자)을 넣을 수 없다 |
| 외부 memory provider 의 턴별 `prefetch(query)` (`memory_provider.py:178-190`) | UserPromptSubmit 교훈 lane — **전체 스캔 + 슬롯 예약** | 인덱스에서 밀려난 오래된 교훈도 질의가 맞으면 그 턴에 올라온다 |
| 예산 초과 시 "consolidate now" 압박 (`memory_tool.py:448-456`) | 이번 범위 밖 (§3 비목표) | 먼저 회수부터 살린다 |

hermes 의 내장 기억은 **관련도 검색이 없다** — "작은 파일 전체를 항상 넣는다"가 답이다. 우리는 교훈이
151건이라 전체를 넣을 수 없으므로, 인덱스(항상) + 질의 기반 lane(턴별)의 두 층으로 같은 효과를 낸다.

## 2. 요구사항

- **R1. SessionStart 교훈 인덱스.** `session-start.ts` 가 `## Project Lessons` 절을 주입한다.
  항목 = `- <name> — <trigger 앞 N자>`, 순서 = 저장소 정렬(`confidence DESC, updated_at DESC`),
  문자 예산(기본 2,400자, env `CLAUDE_MEMORY_SESSION_START_LESSON_BUDGET`, `0` 이면 끔) 안에서 채운다.
  꼬리에 총 건수와 "본문은 `mem-lesson-get`, 전체는 `mem-lesson-list`" 안내를 붙인다.
  `CLAUDE_MEMORY_EVAL_DISABLE_SESSION_CONTEXT=true` 면 생략. 주입을 `recordQueryTrace`
  (`strategy: 'session-start-lessons'`) + `recordRetrieval(source: 'session_start')` 로 기록해
  **활용이 측정 가능**해야 한다(지금은 교훈 주입이 원장에 안 남아 "잘 쓰이는지"를 알 수 없다).
- **R2. UserPromptSubmit 전체 스캔.** 교훈 lane 이 최신 15건이 아니라 저장소 상한(500)까지 채점한다.
- **R3. 교훈 슬롯 예약.** 필터를 통과한 결과에 교훈이 없고, 교훈 후보 중 최고점이 `policy.minScore`
  이상이면 그 1건을 넣는다. 총 건수는 `policy.maxMemories` 를 넘지 않는다(가득 차 있으면 가장 낮은
  비교훈 1건을 뺀다). 순수 함수 `reserveLessonSlot` 으로 분리해 단위 테스트한다.
- **R4. `mem-lesson-get`.** `lessonId` 또는 `name`(프로젝트 내 UNIQUE) 으로 교훈 1건을 반환한다.
  없으면 `operation:'mem-lesson-get', found:false`. 권한 검사는 `mem-lesson-list` 와 같다.
- **R5. `mem-context-pack` 질의 반영.** `query` 가 있으면 교훈 전체(≤500)를 `scoreLessonEvidence` 로
  채점해 상위 3건, 채점 통과가 없거나 `query` 가 없으면 기존 최신순 3건.
- **R6. 참조 카드 안내 갱신.** `memory-reference-context.ts` 의 교훈 fetch 문구를 `mem-lesson-get` 으로.

## 3. 비목표 (Non-Goals)

- 교훈 임베딩·의미 검색 — 어휘 채점으로 p90 0.98 이 나온다. 필요가 증명되기 전엔 넣지 않는다.
- 예산 초과 시 통합(consolidate) 압박 — hermes 패턴이지만 회수부터 살린 뒤 별도 spec.
- `init-project` 훅 문구 변경 — CML 배포·설치 뒤에야 참이 되므로 후속.
- CLI `lesson list --json` 이 25건에서 잘리는 것(`sanitizeOperationOutput` 배열 상한) — 발견만 기록.

## 4. 완료 기준

- R1~R6 각각 실패→통과 테스트 존재, 변이 검증(핵심 분기 제거 시 red)
- `npm run typecheck`, `npm run lint`, `npm test` 통과
- 실기 검증: `CLAUDE_MEMORY_EVAL_MODE=true` 로 session-start → user-prompt-submit 순 실행 시
  교훈 인덱스와 질의 매칭 교훈이 실제 stdout 에 나타남
