# Spec: Selective Storage Filtering

## 개요

모든 이벤트 타입에 걸쳐 메모리 가치가 낮은 데이터를 선별적으로 필터링하여
저장량 55% 감소, 임베딩 backlog 해소, retrieval 품질 향상을 목표로 한다.

## 목표

- 전체 이벤트 저장량 **-55%** (10,536 → ~4,693)
- 임베딩 pending 증가 속도 감소
- retrieval signal-to-noise 향상
- Ctrl+C, 메뉴번호 같은 쓰레기 데이터 제거

## 비목표

- 저장 스키마 변경 없음
- 기존 저장된 이벤트 소급 삭제 없음
- session_summary 로직 변경 없음

---

## 필터 규칙 1: tool_observation (post-tool-use.ts)

### Blocklist 확장

**추가 제외 도구** (현재: TodoWrite, TodoRead만 제외):

```
Read, Grep, Glob, ToolSearch,
WebFetch, WebSearch, NotebookRead,
Skill, EnterPlanMode,
mcp__*  (MCP 도구 전체, 조건부 예외 적용)
```

**항상 저장 (allowlist)**:
- `Write`, `Edit`, `MultiEdit` — 파일 변경 기록
- `Agent`, `Task` — 서브태스크 결과
- `Bash` — 조건부 (output 필터 적용)
- `ExitPlanMode` — 계획 완료 기록 (조건부)

### Output-level 필터 (Bash 등 조건부 도구)

| 조건 | 동작 |
|------|------|
| `stderr` 존재 | 저장 (에러 컨텍스트) |
| `stdout` 길이 ≥ 100 chars | 저장 |
| Write/Edit/Agent/Task | 길이 무관 저장 |
| 그 외 | 스킵 |

### 환경변수

```bash
CLAUDE_MEMORY_TOOL_BLOCKLIST="Read,Grep,Glob,..."   # 커스텀 blocklist
CLAUDE_MEMORY_TOOL_MIN_OUTPUT_LEN=100               # Bash 최소 출력 길이
```

---

## 필터 규칙 2: agent_response (stop.ts)

### Min-length 필터

**150자 미만 agent_response는 저장 안 함**

근거: 50자 미만 608개 (27%), 50~200자 587개 (26%) 가 도구 체인 전환 메시지.
독립적 retrieval 가치 없음.

```bash
CLAUDE_MEMORY_AGENT_RESPONSE_MIN_LEN=150  # 기본값
```

**예외 (짧아도 저장):**
- 세션의 마지막 agent_response (최종 답변일 가능성)

---

## 필터 규칙 3: user_prompt (importer + hook)

### 임포터에 shouldStorePrompt() 적용

현재 import 시 transcript의 모든 user 메시지를 무조건 저장.
Ctrl+C(`\x03`), 숫자 `'1'`, `'go'` 등이 저장되는 원인.

**변경:** `session-history-importer.ts`에서 각 user_prompt 저장 전
`shouldStorePrompt()` 동일 조건 적용:
- 길이 < 15자 → 스킵
- `/`로 시작 → 스킵
- 제어문자 포함 → 스킵
- 한글/영문 2글자 이상 포함 여부 확인

---

## 적용 파일

| 파일 | 변경 |
|------|------|
| `src/hooks/post-tool-use.ts` | blocklist 확장 + output-level 필터 |
| `src/hooks/stop.ts` | agent_response min-length 필터 |
| `src/services/session-history-importer.ts` | shouldStorePrompt() 임포트 적용 |

---

## 판단 흐름

```
[PostToolUse]
  tool_name이 blocklist? → 스킵
  tool_name이 allowlist(Write/Edit/Agent/Task)? → 저장
  Bash/기타: output length ≥ 100 OR stderr 있음? → 저장 else 스킵

[Stop - agent_response]
  마지막 메시지? → 저장
  length ≥ 150? → 저장 else 스킵

[Importer - user_prompt]
  shouldStorePrompt() 통과? → 저장 else 스킵
```

---

## 성공 지표

- 신규 세션 tool_observation 비율 < 40% (현재 68.5%)
- agent_response 저장 비율 < 50% (현재 전량 저장)
- user_prompt 쓰레기 입력 0건
- 임베딩 pending 증가 속도 현재 대비 -50%
