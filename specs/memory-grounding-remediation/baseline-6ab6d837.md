# Baseline — projectHash 6ab6d837 (aplus-dev-studio-desktop)

채취 시각: 2026-08-01 (변경 전). 재측정 시 동일 쿼리를 사용할 것 — spec.md §2.

## 타입별 실사용률 (grounding)

```
event_type        evaluated  grounded  pct 
----------------  ---------  --------  ----
agent_response    1642       196       11.9
tool_observation  452        1         0.2 
session_summary   225        2         0.9 
user_prompt       102        5         4.9 

evaluated_total  grounded_total  pct
---------------  --------------  ---
2421             204             8.4
```

## 저장 구성

```
event_type        stored
----------------  ------
tool_observation  13609 
agent_response    1581  
user_prompt       838   
session_summary   518   

tool             n   
---------------  ----
Bash             7132
Edit             5007
Write            904 
Agent            291 
AskUserQuestion  137 
TaskUpdate       80  
```

## F1 대상: tool_observation 누수 경로

```
k                               traces
------------------------------  ------
answer_only                     878   
tool+answer (intent path)       188   
tool_only (gate fallback leak)  131   
```

---

## F1 배포 시각 (측정 분기점)

- **배포 UTC**: `2026-07-31T15:48:03Z`
- 배포 내용: tool_observation 질의 조건부 페널티, 게이트 fallback 제거, intent 정규식 축소 + anchor 검증
- 빌드: `/Users/justin/workspace/claude-memory-layer/dist/hooks/` (전역 훅이 참조하는 경로)

### F1 이후 재측정 쿼리

```sql
SELECT e.event_type, COUNT(*) evaluated,
  SUM(CASE WHEN h.content_overlap_score>=0.3 THEN 1 ELSE 0 END) grounded,
  ROUND(100.0*SUM(CASE WHEN h.content_overlap_score>=0.3 THEN 1 ELSE 0 END)/COUNT(*),1) pct
FROM memory_helpfulness h JOIN events e ON e.id=h.event_id
WHERE h.content_overlap_score IS NOT NULL
  AND h.created_at >= '2026-07-31T15:48:03Z'
GROUP BY e.event_type ORDER BY evaluated DESC;
```

기대: `tool_observation`의 `evaluated`가 거의 0에 수렴하고, `agent_response`의 `evaluated`가
늘어야 한다(슬롯이 답변 근거로 이전됐다는 증거). 유의미한 판단에는 세션이 몇 번 쌓여야 한다.

---

## F2-a 배포 시각 (측정 분기점)

- **배포 UTC**: `2026-07-31T16:07:32Z`
- 배포 내용: 규칙 기반 목차형 session_summary(`isPromptOnlySessionSummary`)를 semantic/keyword 레인
  (`rankHookCandidates`)에서도 제외. 기존엔 graduated 레인(`scoreGraduatedEvidence`)에만 연결돼 있었음.
- 빌드: `/Users/justin/workspace/claude-memory-layer/dist/hooks/`

### F2-a 이후 재측정 쿼리

```sql
SELECT e.event_type, COUNT(*) evaluated,
  SUM(CASE WHEN h.content_overlap_score>=0.3 THEN 1 ELSE 0 END) grounded,
  ROUND(100.0*SUM(CASE WHEN h.content_overlap_score>=0.3 THEN 1 ELSE 0 END)/COUNT(*),1) pct
FROM memory_helpfulness h JOIN events e ON e.id=h.event_id
WHERE h.content_overlap_score IS NOT NULL
  AND h.created_at >= '2026-07-31T16:07:32Z'
GROUP BY e.event_type ORDER BY evaluated DESC;
```

기대: `session_summary`의 `evaluated`가 급감(오염된 요약이 주입에서 빠짐). F2-b(LLM 요약)
배포 전까지는 session_summary가 아예 거의 주입되지 않는 것이 정상 — 지금 저장된 518건이
전부 목차형이기 때문.

---

## F2-b 배포 시각 (측정 분기점)

- **배포 UTC**: `2026-08-01T01:31:52Z`
- 배포 내용: 규칙 기반 요약 생성기 → LLM(claude CLI) 요약으로 교체.
  Stop 훅은 데몬에 `summarize`를 요청만 하고 즉시 반환(논블로킹), 데몬이 백그라운드에서 생성.

### ✅ 배포 절차: 수동 재시작 불필요 (자동화 완료)

`semantic-daemon`은 long-lived 프로세스라 원래는 **빌드만 해서는 새 코드가 적용되지 않았다.**
E2E 검증 중 실제로 이 문제를 만났다 — 구버전 데몬이 `summarize` 요청을
`invalid request`로 거부했고, Stop 훅은 이를 삼켜서(try/catch) **아무 오류 없이 요약만 누락**됐다.
`npm install` 업그레이드도 `dist/`만 교체할 뿐 데몬을 재시작하지 않아 동일한 문제가 있었다
(postinstall·install 커맨드 모두 데몬을 건드리지 않고, `ensureDaemonRunning()`은 연결만 확인).
idle 타임아웃(10분)이 있으나 **연결마다 리셋**되므로 작업 중에는 무기한 유지될 수 있었다.

이제 데몬이 기동 시 자기 스크립트의 fingerprint(mtime:size)를 기록하고, 연결 수립 시 현재 값과
비교해 다르면 **응답하지 않고 소켓을 끊은 뒤 스스로 종료**한다. 모든 클라이언트가 이미
연결 오류 시 `ensureDaemonRunning()` 후 재시도하므로, 재시도가 새 빌드 데몬으로 자동으로 넘어간다.
따라서 `npm run build` / `npm install` 후 **추가 조치가 필요 없다.**

검증(실측): 재빌드만 하고 `pkill` 없이 Stop 훅 실행 → 데몬 PID 9954 → 16273 자동 교체,
요약 정상 생성(`generated=llm`). fingerprint를 읽을 수 없으면 stale로 판정하지 않아
(모든 요청 거부 방지) 안전 측으로 동작한다.

### E2E 검증 결과 (실제 훅 전체 경로)

생성된 요약:
```
- 제약: 현재 빌드가 arm64 전용이라 intel mac에서는 업데이트 채널이 비어있음
- 제약: intel 호환성을 위해 universal 빌드로 전환하거나 x64 타깃을 따로 배포해야 함
```
metadata: `generated=llm, provider=claude, model=claude-haiku-4-5-20251001`

- Stop 훅 즉시 반환 확인(논블로킹)
- **재귀 없음 확인**: 프로젝트 저장소 수 67 → 68(테스트 프로젝트 1개만). 재귀였다면 다수 생성.

### F2-b 이후 확인 쿼리

```sql
-- 새로 생성되는 요약이 LLM 산출물인지
SELECT json_extract(metadata,'$.generated') gen, COUNT(*)
FROM events WHERE event_type='session_summary' GROUP BY gen;
```

기대: `llm`이 증가. 기존 518건(`rule-based`)은 F2-a로 주입이 이미 차단돼 있어 무해.

---

## F3 배포 시각 (측정 분기점)

- **배포 UTC**: `2026-08-01T02:01:38Z`

### F3-a: lesson 주입 레인 신설 (핵심)

착수 전 확인한 사실: **lesson 은 주입 경로에 전혀 연결돼 있지 않았다.**
`memory_lessons` 는 events 테이블 밖에 있어 semantic/keyword 검색에 잡히지 않고,
MCP 도구로 에이전트가 직접 호출해야만 보였다. 즉 후보 탐지만 고쳤다면
**"만들지만 안 쓰임"** 이라는 이 spec 이 막으려던 실패를 그대로 반복했을 것이다.

- `MemoryQueryService.listProjectLessons()` 신설 → `MemoryService` 로 노출
- `scoreLessonEvidence()` — graduated 레인과 같은 결정론적 lexical 스코어링
  (curated 라는 이유로 정확한 증거를 이기지 않도록 confidence 는 작은 tie-breaker)
- 게이트에서 lesson 을 answer evidence 로 인정, `evidenceUtilityBonus('lesson') = 0.16` (최고)

### F3-b: 후보 탐지 결함 2건 수정

| 결함 | 수정 |
|---|---|
| `ORDER BY timestamp ASC LIMIT 2000` → **가장 오래된** 구간만 스캔 (207세션 중 32개) | 최신 구간을 스캔하도록 변경 |
| 세션에 `error/failed/blocked` 토큰이 하나라도 있으면 통째 탈락 (**실측 93.7% 세션이 해당**) | "실패 후 복구했는가"(마지막 성공이 마지막 실패 이후)로 대체 |

실측 개선: 적격 세션 0 → 9, 후보 0건 → **1건**(3개 세션 근거, 신뢰도 0.85).
가장 배울 가치가 큰 "오류를 만나 해결한 세션"이 정확히 배제되던 문제가 해소됐다.

### E2E 검증

실제 lesson 저장 후 훅 실행:
- 관련 질의 → `- [lesson] preview 포트 충돌 복구 절차` + 적용 시점/절차 3단계/주의사항 **전문 주입**
- 무관한 질의 → 주입 없음 (오주입 없음)

### F3 이후 확인 쿼리

```sql
-- lesson 이 실제로 주입되고 사용되는지 (F3 이전에는 구조적으로 0이었음)
SELECT COUNT(*) injected,
  SUM(CASE WHEN content_overlap_score>=0.3 THEN 1 ELSE 0 END) grounded
FROM memory_helpfulness
WHERE created_at >= '2026-08-01T02:01:38Z' AND event_id IN (SELECT lesson_id FROM memory_lessons);
```

주의: lesson 은 event 가 아니므로 `memory_helpfulness.event_id` 에 lesson_id 가 기록된다.
집계 시 events 조인이 아니라 위처럼 lesson 테이블과 대조해야 한다.

---

## ⚠️ 측정 교란 요인 — 같은 기간에 배포된 다른 변경들

이 spec 의 F1~F3 만으로 전후 차이를 귀속하면 **F1 효과를 과대평가하게 된다.**
baseline 채취(2026-08-01) 전후로 `main` 에 tool_observation 노이즈를 겨냥한 별개 작업이 머지됐다.

| PR | 내용 | 층 |
|---|---|---|
| #37 / #38 | tool_observation 을 벡터 임베딩에서 제외 | 임베딩 |
| #39 | 이미 오염된 tool_observation 벡터 self-heal | 저장소 |
| #40 | keywordSearch 기본 레인에서 tool_observation 제외 (`includeToolObservations` opt-in) | 검색 |
| **F1 (본 spec)** | 주입 슬롯 경쟁·게이트 fallback 차단 | **주입 정책** |

네 층이 같은 증상을 각각 다른 지점에서 막는다. 특히 **#40 이 검색 단계에서 이미 걸러내므로,
F1 배포 후 tool_observation 주입이 0 에 수렴하더라도 그 공은 F1 단독이 아니다.**
F1 이 여전히 유효한 범위는 (a) episode seeding 이 `includeToolObservations: true` 로
의도적으로 끌어오는 tool 근거, (b) semantic/graduated 레인을 통해 들어오는 경우,
(c) 게이트 fallback 이라는 마지막 방어선이다.

**해석 규칙**: tool_observation 지표 개선은 #37~#40 과 F1 의 합작으로 보고,
F1 단독 효과를 주장하지 말 것. 반면 `session_summary`(F2) 와 `lesson`(F3) 지표는
다른 PR 이 건드리지 않았으므로 본 spec 에 귀속 가능하다.
