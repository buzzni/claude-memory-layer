# Spec: Memory Utilization Improvements

## 목표

f4d5c120 프로젝트 분석을 통해 확인된 메모리 시스템의 cascade failure를 해소하고,
저장된 메모리가 실제로 Claude 응답에 기여하는 비율을 높인다.

**성공 기준**:
- Retrieval trace 기록률 > 95% (현재 ~0%)
- 메모리 Graduation L1+ 비율 > 10% (현재 0%)
- Tool Observation 중 저장 비율 < 30% (현재 100%)
- 세션 요약 생성률 > 80% (현재 5%)

---

## 개선 항목 (우선순위 순)

---

### IMP-01: Retrieval Trace 동기 기록

**우선순위**: P0 (Blocker)

**문제**:
- `adherence: true` 이벤트가 존재 → 검색은 실행됨
- 하지만 retrieval_traces 테이블에 단 1건만 기록
- 비동기 trace INSERT가 hook 프로세스 종료 전에 완료되지 않는 것으로 추정

**원인 분석**:
```typescript
// user-prompt-submit.ts 추정 흐름
async function hook() {
  const memories = await retrieveMemories(query);   // 검색 실행
  await writeToStdout(memories);                    // 결과 출력 (hook 종료)
  await recordTrace(memories);                      // ← 여기서 프로세스가 이미 종료됨
}
```

**해결 방안**:
1. `recordTrace()`를 `retrieveMemories()` 직후, stdout 출력 전에 동기적으로 실행
2. better-sqlite3의 동기 API 사용 (이미 사용 중) → trace INSERT를 sync로 변경
3. trace 기록 실패 시 stderr에 경고 출력

**변경 파일**:
- `src/hooks/user-prompt-submit.ts` — trace 기록 위치를 stdout 출력 전으로 이동
- `src/core/sqlite-event-store.ts` — `recordRetrievalTrace()`를 동기 메서드로 변경

**검증**:
```sql
-- 개선 후: 세션당 retrieval_traces 수 확인
SELECT session_id, COUNT(*) as trace_count
FROM retrieval_traces
GROUP BY session_id
ORDER BY trace_count DESC;
```

---

### IMP-02: Tool Observation 선택적 저장

**우선순위**: P0

**문제**:
- 저장 이벤트의 93%가 tool observation
- 대부분 다음 세션에서 재사용 가치가 없는 ephemeral 데이터
- FTS5 검색 코퍼스 비대화 → 검색 노이즈 증가

**저장 가치 기준**:

| Tool | 저장 조건 | 이유 |
|------|---------|------|
| Bash | 오류(exit_code≠0), 또는 중요 출력 키워드 포함 | 성공적인 단순 명령은 가치 낮음 |
| Write | 항상 저장 | 파일 생성/수정은 중요 컨텍스트 |
| Edit | 항상 저장 | 코드 변경은 추적 필요 |
| Read | 저장 안 함 (기본값) | 파일 내용은 재현 가능 |
| Glob | 저장 안 함 | 디렉토리 구조는 변하지 않음 |
| Grep | 결과 10줄 초과 시만 저장 | 대용량 검색 결과만 의미있음 |
| TodoRead/Write | 저장 안 함 | 이미 제외됨 |

**중요 출력 키워드** (Bash 저장 트리거):
```
error, Error, ERROR, failed, Failed, FAILED,
warning, Warning, exception, Exception,
test passed, test failed, coverage,
successfully deployed, build complete
```

**변경 파일**:
- `src/hooks/post-tool-use.ts` — 툴별 저장 조건 필터링 로직 추가
- `src/core/metadata-extractor.ts` — 중요도 점수 계산 함수 추가

**예상 효과**:
- 저장 이벤트 수 60~70% 감소
- 검색 정밀도 향상
- DB/벡터 스토어 용량 절감

---

### IMP-03: 세션 요약 신뢰성 개선

**우선순위**: P1

**문제**:
- 40 세션 중 2건만 요약 (5%)
- Stop hook은 프로세스 강제 종료 시 실행되지 않음
- Session-start의 백필 로직이 요약을 생성하지 않고 있음

**해결 방안**:

**A. Session-start 백필에서 요약 생성 추가**:
```typescript
// session-start.ts
async function backfillPreviousSession(prevSessionId: string) {
  const events = await getSessionEvents(prevSessionId);
  if (events.length > 3 && !hasSummary(prevSessionId)) {
    const summary = await generateSummary(events);
    await storeSummaryEvent(prevSessionId, summary);
  }
}
```

**B. LLM 없이 규칙 기반 요약 생성** (빠른 실행):
```
요약 템플릿:
"[날짜] [N]턴 세션. 주요 작업: [user_prompt 첫 문장들].
사용 툴: [tool 목록]. [오류 있으면: 발생한 오류: ...]"
```

**C. 주기적 요약 트리거** (선택적):
- 세션 시작 시 이전 7일간 미요약 세션 최대 3개 백필

**변경 파일**:
- `src/hooks/session-start.ts` — 백필 시 요약 생성 호출 추가
- `src/core/event-store.ts` — `generateRuleBasedSummary()` 함수 추가

---

### IMP-04: Graduation 수동 트리거 커맨드

**우선순위**: P1

**문제**:
- 1,587건 전부 L0에 고착
- IMP-01로 trace 기록이 정상화되어도 과거 데이터는 L0 유지
- access_count가 0이면 L1 승격 불가

**해결 방안**:

**A. 히스토리 기반 access_count 역산**:
```sql
-- 동일 session의 이벤트가 이후 세션에서 재등장한 경우 access로 카운트
-- user_prompt 이벤트 중 내용이 유사한 것들을 같은 토픽으로 그룹화
```

**B. CLI 커맨드 추가**:
```bash
claude-memory graduation --repair --project f4d5c120
# 출력: Analyzed 1587 events, promoted 42 to L1, 8 to L2
```

**C. 시간 기반 자동 L1 승격** (규칙):
- 생성 후 7일 이상 지난 user_prompt 이벤트
- content 길이 > 100자
- 동일 세션에서 3번 이상 유사 쿼리 존재

**변경 파일**:
- `src/core/graduation.ts` — 시간 기반 승격 규칙 추가
- `src/cli/index.ts` — `graduation --repair` 서브커맨드 추가

---

### IMP-05: Embedding 모델 상태 모니터링

**우선순위**: P1

**문제**:
- "Unknown model class 'eurobert'" 오류 반복
- "RotaryEmbedding node execution errors" 반복
- 사용자에게 오류가 노출되지만 자동 대처 없음

**해결 방안**:

**A. 모델 헬스체크 강화**:
```typescript
// semantic-daemon.ts
async function checkModelHealth(): Promise<boolean> {
  try {
    await embed("test query");
    return true;
  } catch (e) {
    logger.warn('Primary model failed, switching to fallback');
    await switchToFallbackModel();
    return false;
  }
}
```

**B. 대시보드에 모델 상태 표시**:
- 현재 사용 중인 모델명
- 최근 임베딩 성공률
- 오류 로그 최근 5건

**C. 임베딩 오류 시 키워드 전용 모드 자동 전환**:
- `CLAUDE_MEMORY_RETRIEVAL_MODE=keyword` 임시 설정
- 사용자에게 `<system>` 메시지로 알림

**변경 파일**:
- `src/hooks/semantic-daemon.ts` — 헬스체크 및 자동 폴백 강화
- `src/server/api/stats.ts` — 모델 상태 지표 추가

---

### IMP-06: Helpfulness 피드백 루프

**우선순위**: P2

**문제**:
- `sessions_helpfulness` 테이블 존재하나 데이터 없음
- 검색된 메모리가 실제로 유용했는지 측정 불가
- 유용하지 않은 메모리가 계속 상위에 노출될 수 있음

**해결 방안**:

**A. 휴리스틱 기반 자동 helpfulness 평가**:
```
Stop hook에서:
1. 이번 세션에서 검색된 eventId 목록 로드
2. agent_response에서 검색된 메모리의 canonicalKey가 언급되었는지 확인
3. 언급된 경우 helpfulness = 0.8, 아닌 경우 0.2로 기록
```

**B. Retrieval Score 가중치에 helpfulness 반영**:
```typescript
// matcher.ts
score = 0.35 × semanticScore +
        0.25 × ftsScore +
        0.20 × recencyBonus +
        0.10 × statusMultiplier +
        0.10 × helpfulnessScore;  // ← 신규 추가
```

**C. 낮은 helpfulness 이벤트 강등**:
- 3회 이상 검색 후 helpfulness 평균 < 0.3이면 min_score 요건 상향

**변경 파일**:
- `src/hooks/stop.ts` — 자동 helpfulness 평가 로직 추가
- `src/core/matcher.ts` — helpfulness 가중치 추가
- `src/core/graduation.ts` — helpfulness 기반 강등 규칙 추가

---

### IMP-07: 검색 결과 컨텍스트 포맷 개선

**우선순위**: P2

**문제**:
- 검색된 메모리가 Claude에게 전달될 때의 포맷 불명확
- 메모리 출처(세션 날짜, 프로젝트)가 표시되지 않을 수 있음
- 100% 선택률 → 품질 필터링 없이 모두 주입

**해결 방안**:

**A. 메모리 컨텍스트 포맷 구조화**:
```
<memory source="2026-02-25" session="5ef326be" confidence="0.87">
  [쇼핑 어시스턴트 LLM function call 구현 중]
  이전에 generalize_with_llm() 함수를 사용해서 상품 추천 로직을 개선했음.
  결과: 응답 속도 40% 향상.
</memory>
```

**B. 신뢰도 기준 필터링 강화**:
- `high` confidence만 자동 주입 (현재 ≥0.92)
- `suggested` confidence는 optional hint로 분리
- 100% 선택률 → 선택적 포함으로 변경

**변경 파일**:
- `src/hooks/user-prompt-submit.ts` — 컨텍스트 포맷 템플릿 개선
- `src/core/retriever.ts` — suggested confidence 분리 출력

---

### IMP-08: Vector/LanceDB schema mismatch fallback

**우선순위**: P0 (Agent workflow blocker)

**문제**:
- 2026-05-10 실제 `claude-memory-layer` project store에서 MCP `mem-context-pack`와 `mem-search`가 `No vector column found to match with the query vector dimension: 384`로 실패.
- CLI `search`는 같은 project data에서 3개 local memories를 반환했지만 MCP native tool은 전체 tool failure로 종료.
- 오래된 LanceDB table 또는 long-lived MCP service가 현재 embedder metadata와 다른 vector schema를 유지할 수 있음.

**해결 방안**:
1. Vector query boundary에서 dimension/schema mismatch를 typed recoverable error로 분류한다.
2. `mem-context-pack`은 semantic retrieval 실패 시 keyword search + recent project timeline fallback을 반환한다.
3. `mem-search`는 가능한 경우 keyword fallback 결과를 반환하고, 불가능하면 `isError=true` 대신 복구 지침이 포함된 safe diagnostic을 반환한다.
4. Stats/health에 embedder model, vector dimension, table schema, pending embeddings를 노출해 재색인 필요성을 알린다.

**검증**:
- 오래된 vector table fixture에서 `mem-context-pack(query="continue")`가 `isError=false`와 warning을 반환.
- 실제 project smoke에서 MCP `mem-context-pack`/`mem-search` 모두 실패 없이 완료.

---

### IMP-09: Project-scoped retrieval isolation

**우선순위**: P0 (Context contamination)

**문제**:
- Direct handler smoke에서 `projectPath=/Users/namsangboy/workspace/claude-memory-layer`인데 `predictor`, Streamlit 등 다른 workspace 내용이 context pack에 섞인 사례가 있었다.
- Hermes validation에서 project context 없는 session 66개가 관측되어 auto-refresh/import에서 오매칭 위험이 있다.
- 2026-05-10 dashboard dogfood에서 `claude-memory-layer` project storage 자체에 legacy unscoped Hermes imports가 남아 `predictor`, `Streamlit`, `alpha-ai-trader` snippets가 보였다. MCP context-pack은 strict metadata filter로 보호되지만 dashboard events/search는 project DB contents를 그대로 보여주므로 사용자-facing contamination으로 보일 수 있다.

**해결 방안**:
1. Imported event/session metadata에 canonical `projectPath`, `projectHash`, `sourceAgent`를 저장하고 retrieval query에 same-project filter를 강제한다.
2. Project context가 없는 Hermes sessions는 explicit `sessionId` import가 아닌 한 `mem-import-latest`/auto-refresh 대상에서 제외한다.
3. Generic continuation query는 same-project recent timeline을 먼저 구성하고 semantic results는 same-project 필터를 통과한 경우에만 병합한다.
4. Test fixture에 다른 project keywords(`predictor`, `Streamlit`)를 넣고 `containsOtherProject=false`를 검증한다.
5. Dashboard read APIs/events/search에서도 project DB 안의 legacy unscoped imported history를 별도 `legacy/unscoped` bucket으로 표시하거나 기본 project view에서 제외한다.
6. 기존 project DB를 안전하게 재분류하는 dry-run repair CLI를 제공한다: `claude-memory-layer repair legacy-project-scope --project <hash> --dry-run`.

**검증**:
- `mem-project-timeline(projectPath=...)`와 `mem-context-pack(projectPath=...)` 결과에 다른 workspace path/topic이 포함되지 않음.
- CLI/MCP stats/search가 같은 `projectPath`에서 같은 storage scope와 event/vector count를 보고.
- Dashboard project filter에서 `claude-memory-layer` 선택 후 `predictor`, `Streamlit`, `alpha-ai-trader` keyword smoke가 0건 또는 legacy bucket warning으로 표시됨.

---

### IMP-10: Dashboard read/search resilience and memory-only usefulness mode

**우선순위**: P0 (Dashboard dogfood blocker)

**문제**:
- Live dashboard dogfood에서 read-only 화면은 정상 렌더됐지만, explicit `auto` disclosure search가 embedding/model backend 상태에 따라 500을 낼 수 있었다.
- `/api/events`, `/api/sessions`, `/api/health`, `/api/stats/*` read subroutes는 SQLite-only 화면임에도 full vector/embedder service를 초기화해 dashboard browsing을 불필요하게 깨뜨릴 수 있었다.
- Published `1.0.38` fresh-install dashboard UI smoke에서 `/api/stats/usefulness`는 200이었지만 `/api/stats/shared`, `/endless`, `/levels`, `/most-accessed`, `/timeline`, `/helpfulness`, `/retrieval-traces`, `/retrieval-review-queue`, `/kpi` 같은 stats subroute가 embedder/model 초기화 실패(`Unable to get model file path or buffer`)로 500을 낼 수 있음을 재현했다.
- Published `1.0.39` fresh-install dashboard API smoke에서 stats subroutes는 200이 됐지만 `/api/health`가 같은 embedder/model 초기화 실패로 500을 냈고, `1.0.40`에서 GET `/api/health`도 lightweight read path로 고정했다.
- Ask Memory는 서버의 Claude CLI 인증 상태에 의존한다. 인증이 깨지면 memory retrieval 여부와 무관하게 SSE에 auth failure가 표시되어 "메모리가 의미 있게 쓰이는지"를 확인하기 어렵다.
- 현재 실측 project는 vector nodes 0, embedding_outbox pending, helpfulness 0건이라 의미있는 semantic recall/feedback-loop 판단이 불가능하고 keyword-only recall에 의존한다.

**해결 방안**:
1. Dashboard read-only APIs(`/api/health`, `/api/events`, `/api/sessions`, `/api/stats`, `/api/stats/shared`, `/api/stats/endless`, `/api/stats/levels/:level`, `/api/stats/most-accessed`, `/api/stats/timeline`, `/api/stats/helpfulness`, `/api/stats/usefulness`, `/api/stats/retrieval-traces`, `/api/stats/retrieval-review-queue`, `/api/stats/kpi`)는 lightweight read service를 사용한다.
2. `/api/search/disclosure` `strategy=auto`가 embedding backend init/query 실패 시 lightweight `strategy=fast` keyword search로 fallback하고 500 대신 fallback trace를 반환한다.
3. Ask Memory에 provider/auth preflight와 memory-only fallback summary mode를 추가한다.
   - Claude CLI auth 실패 시 raw provider error만 노출하지 말고 "retrieved memories + provider auth diagnostic"을 반환한다.
   - `?mode=memory-only` 또는 UI toggle로 LLM 없이 검색 결과/근거만 요약한다.
4. Dashboard stats에 `vectorReady`, `pendingEmbeddings`, `searchMode(keyword-only|hybrid|semantic)`, `providerAuth`를 노출한다.
5. 실데이터 dogfood smoke script를 추가해 login → project select → stats/events/sessions/search/Ask Memory diagnostic을 자동 검증한다.

**검증**:
- Fresh install dashboard smoke에서 `/api/health`, `/api/events`, `/api/sessions`, `/api/search/disclosure(strategy=auto)`, `/api/stats/*` read subroutes가 embedding backend unavailable fixture에서도 200.
- Ask Memory Claude auth failure fixture에서 SSE가 사용자 친화적 diagnostic과 retrieved-memory evidence를 반환.
- `claude-memory-layer` project dogfood에서 search가 exact/keyword queries를 반환하고, semantic/vector 준비 안 됨 상태가 dashboard에 명확히 표시됨.

---

## 2차 개선 (실측 데이터 기반 후속)

### IMP-01b: 대시보드 API projectId 파라미터 불일치 수정

**문제**: 대시보드가 `?projectId=f4d5c120`으로 쿼리하는데 `getServiceFromQuery()`는 `?project=`만 읽음 → 항상 글로벌 서비스 반환

**수정**: `src/server/api/utils.ts`
```typescript
const project = c.req.query('project') || c.req.query('projectId');
```
**완료** ✅

---

### IMP-02b: Bash 출력 임계값 800 → 2000

**문제**: 800자 임계값이 너무 낮아 일반적인 bash 출력 대부분이 저장됨

**수정**: `src/hooks/post-tool-use.ts`
```typescript
return output.trim().length > 2000;
```
**완료** ✅

---

### IMP-06b: Helpfulness 평가 알고리즘 변별력 개선

**문제**: `was_reasked` 로직이 자연스러운 대화 연속을 penalty로 처리 → 모든 항목 0.62~0.68 수렴

**원인**:
- 쇼핑 어시스턴트처럼 같은 주제를 이어가면 `was_reasked=1` 항상 발생
- 가중치: `0.20 × (wasReasked ? 0 : 1)` → 모든 항목에 -0.20 penalty

**수정**: `src/core/sqlite-event-store.ts`
```typescript
// 기존 (변별력 낮음)
0.30 × retrievalScore + 0.25 × sessionContinued + 0.25 × toolSuccessRatio + 0.20 × !wasReasked

// 개선 (prompt_count_after 활용)
0.40 × retrievalScore + 0.30 × promptNorm + 0.20 × toolSuccessRatio + 0.10 × sessionContinued
// promptNorm = min(promptCountAfter / 2, 1.0)
// 0턴→0.0, 1턴→0.5, 2턴이상→1.0
```
**완료** ✅

---

## 구현 순서

```
Week 1 (Critical Path) - 완료:
  IMP-01: Trace projectHash 수정 ✅
  IMP-02: Tool Observation 필터링 ✅

Week 2 (Quality) - 완료:
  IMP-03: 세션 요약 신뢰성 ✅
  IMP-04: Graduation repair CLI
  IMP-05: Embedding 모델 모니터링

Week 2 (후속 실측 기반) - 완료:
  IMP-01b: 대시보드 projectId 파라미터 수정 ✅
  IMP-02b: Bash 임계값 800→2000 ✅
  IMP-06b: Helpfulness 알고리즘 개선 ✅

Week 3 (Feedback Loop):
  IMP-06: Helpfulness 피드백 루프 완성
  IMP-07: 컨텍스트 포맷 개선
```

---

## 리스크

| 리스크 | 가능성 | 영향 | 대응 |
|--------|--------|------|------|
| IMP-02로 중요 tool observation 누락 | 중 | 중 | 키워드 필터 화이트리스트 설정 |
| IMP-04 graduation repair로 L0 과잉 승격 | 저 | 중 | dry-run 모드 먼저 실행 |
| IMP-01 sync 변환으로 hook 응답 지연 | 저 | 저 | trace INSERT는 < 1ms (SQLite sync) |

## IMP-11: Evidence-based answer utilization (2026-07-14)

**문제**: 검색 성공과 답변 기여가 분리되어 있다. Claude adapter가 비표준 `{context}` JSON을 반환해 실제 모델에 전달되지 않았고, 전달 전 후보도 `user_prompt`나 단일 tool observation처럼 관련은 있지만 답을 만들 수 없는 조각이었다. 실데이터 평가 프롬프트가 운영 corpus에 다시 저장되어 다음 평가를 오염시키는 문제도 확인됐다.

**기능 계약**:

1. SessionStart/UserPromptSubmit은 Claude Code의 `hookSpecificOutput.hookEventName + additionalContext` envelope를 사용한다.
2. `CLAUDE_MEMORY_EVAL_MODE=true`에서는 prompt/access/helpfulness/trace/adherence/session event를 쓰지 않는다. 프로젝트 라우팅 registry만 허용한다.
3. 주입 후보는 semantic score뿐 아니라 evidence utility를 반영한다: `session_summary > agent_response > tool_observation > user_prompt`.
4. answer-seeking query에 prompt-only evidence만 있으면 abstain한다. continuation query에서만 prompt-only context를 허용한다.
5. relevant seed가 user prompt/tool observation이면 같은 session의 인접 episode를 확장해 agent response/session summary를 우선 evidence로 추가한다.
6. 주입 문맥은 source event ref와 “요청/시도와 확정 결과를 구분하라”는 grounding instruction을 포함한다.

**성공 기준**:

- 공식 envelope contract test 및 실제 `claude -p` memory-on smoke 통과.
- 테스트 세션을 제외한 `recsys_justin` 실제 corpus에서 answerable evidence precision ≥80%.
- unrelated/meta no-match injection ≤5%, prompt-only answer injection 0.
- 소규모 5-case gate 통과 후 20+ case로 확대하며, 확대 평가에서 quality가 악화되면 enforce하지 않는다.

## IMP-12: Hook-only automatic graduation (2026-07-14)

**문제**: Claude hook은 짧게 실행되는 lightweight process이고 semantic daemon은 `embeddingOnly`라서, 검색·접근 증거는 자동으로 쌓여도 L0→L1+ graduation pass는 사용자가 `process`를 실행하지 않으면 시작되지 않는다. 일반 full service의 5분 worker만으로는 hook-only 설치의 pipeline liveness를 보장할 수 없다.

**기능 계약**:

1. semantic daemon은 retrieval response의 critical path 밖에서 project별 bounded graduation pass를 예약한다.
2. 자동 pass는 기본 활성화하되 project별 cooldown과 in-flight dedupe를 적용한다. `CLAUDE_MEMORY_AUTO_GRADUATION=false`로 비활성화할 수 있다.
3. `CLAUDE_MEMORY_EVAL_MODE=true` request는 corpus뿐 아니라 graduation level/telemetry도 변경하지 않는다.
4. embedding-only runtime은 주기 worker/endless/shared service를 켜지 않고 재사용 가능한 one-shot graduation만 수행한다.
5. candidate batch는 단순 최신순이 아니라 접근된 memory를 우선해 오래된 useful memory의 starvation을 방지한다.
6. 자동 pass 실패는 retrieval response를 실패시키거나 민감한 오류를 stdout에 노출하지 않으며, 다음 cooldown 이후 재시도한다.

**성공 기준**:

- hook-only daemon request 후 bounded 시간 내 graduation attempt telemetry가 기록된다.
- eligible fixture는 별도 수동 CLI 없이 L1로 승격되고, evaluation request는 level/telemetry가 불변이다.
- retrieval latency는 background scheduling 전후 동등하며 자동 pass 동시 실행은 project당 1개 이하이다.

## IMP-13: Graduated evidence utilization (2026-07-14)

**문제**: L0→L1/L2 승격 후에도 retrieval ranking은 `memory_levels`를 읽지 않아 승격이 실제 recall을 바꾸지 않았다. 반대로 단순 level boost를 적용하면 promoted user prompt, task notification, 긴 운영 가이드가 정확한 답변보다 앞서는 noise amplification이 발생했다.

**기능 계약**:

1. Hook retrieval은 기존 semantic/keyword lane과 별도로 L1+ graduated lane을 bounded하게 조회한다.
2. direct answer 후보는 `agent_response`와 answer-capable `session_summary`로 제한한다. template summary와 tool output은 level이 높아도 direct answer가 아니다.
3. promoted `user_prompt`는 같은 turn의 response를 찾는 episode seed로만 사용할 수 있고 최종 answer evidence로 주입하지 않는다.
4. graduated score는 level/access만이 아니라 query term coverage, identifier/entity coverage, entity proximity, FTS rank, diagnostic intent/outcome contract를 결합한다.
5. 기존 semantic candidate가 L1+ lane에도 존재하면 서로 다른 score scale 중 graduated calibration을 사용한다.
6. calibrated graduated top result에는 더 엄격한 score-cliff를 적용해 관련 있지만 다른 incident/entity의 답변이 함께 주입되는 것을 막는다.
7. 주입 citation에 L1/L2 level을 표시하되, level은 근거의 정확성을 보장하지 않는 작은 prior로만 취급한다.
8. semantic/no-match alignment은 질문 보일러플레이(`어떻게`, `확인해줘` 등)를 topic overlap으로 계산하지 않고, 최소 2개의 meaningful term overlap을 요구한다.
9. graduated calibration 내부에서 적용한 level/access prior는 최종 ranking에서 다시 더하지 않는다. 넓은 L2가 정확한 L1을 밀어내지 않아야 한다.

**성공 기준**:

- 실제 promoted answer 6개 + prompt-only/no-match 2개 gate에서 정확한 answer 6/6, abstention 2/2.
- 20+ 확대 field set에서 promoted precision ≥90%, prompt-only/unrelated injection 0.
- eval mode 전후 events/traces/levels/graduation attempts 불변.
- 실제 Claude Code hook event에서 relevant promoted evidence가 citation과 함께 전달되고, 관련 없는 질문은 `additionalContext`를 생성하지 않는다.

## IMP-14: Local 100-case field evaluation and reusable Skill (2026-07-14)

**문제**: 소규 hand-labeled canary는 정확한 회귀를 잡지만 실제 메모리 분포의 다양성과 일반화를 보장하지 않는다. raw transcript를 공개 fixture로 커밋하지 않으면서 반복 실행 가능한 대규모 field gate가 필요하다.

**기능 계약**:

1. project-local SQLite를 read-only로 열고 same-turn user prompt/agent response pair에서 deterministic하게 평가 질문을 생성한다.
2. 기본 200건은 promoted/L0 positive, identifier counterfactual, unrelated no-match를 포함하고 level·intent·session·difficulty·query-style 다양성을 보고한다.
3. raw query가 든 dataset은 local-only/ignored artifact로 저장하고, 커밋 가능 report는 aggregate·opaque case ID·failure reason만 포함한다.
4. 평가는 실제 `UserPromptSubmit` hook을 eval mode로 실행해 top-1 hit, positive hit, no-match accuracy, wrong injection, latency p50/p95를 계산한다.
5. eval mode 전후 events/traces/levels는 불변이어야 하고, hook 라우팅용 transient session mapping은 성공·실패와 무관하게 `finally`에서 제거한다. dataset/report는 secret/local path를 stdout에 노출하지 않는다.
6. 같은 workflow를 다른 project/dataset에 적용할 수 있는 Codex Skill로 패키징하고 deterministic runner를 재사용한다.
7. 회귀 기준선은 dataset만 고정하지 않고 해당 dataset을 생성한 `events.sqlite` 스냅샷도 별도 local-only fixture 디렉터리에 함께 동결한다.
8. fixture 평가는 격리된 `HOME`, project store, session registry를 사용해 이후 live 프로젝트 메모리 추가·승격·semantic daemon 상태의 영향을 받지 않아야 한다.
9. fixture 생성은 SQLite backup API로 WAL-consistent snapshot을 만들고 dataset/store checksum과 corpus count를 local manifest에 기록한다.

**성공 기준**:

- 100-case field set을 생성·실행하고 positive top-1/hit·no-match·latency를 보고한다.
- baseline failure를 유형화해 최소 1회 정책을 개선하고 동일 dataset으로 재평가한다.
- Skill folder가 `quick_validate.py`를 통과하고 실제 runner smoke를 성공한다.
- live store에 평가와 무관한 메모리를 추가하지 않고도 frozen fixture 재평가 결과가 동일한 품질 gate를 통과한다.
- positive에는 원문 exact recall뿐 아니라 압축 단서, 비연속 multi-clue, 동의어 치환, 제한적 typo/noise가 포함되어야 하며 난이도별 hit/top-1을 별도로 보고한다.
- negative에는 명백한 무관 질문뿐 아니라 원문 구조를 유지한 plausible identifier counterfactual을 포함해 strict no-match를 압박한다.

## 2026-05-10 구현 업데이트 — Ask Memory diagnostics + memory-only

### 추가된 기능 contract

- `POST /api/chat` body는 `mode: 'assistant' | 'memory-only'`와 `memoryOnly: boolean`을 지원한다.
- memory-only request는 provider process를 spawn하지 않고 memory retrieval 결과와 diagnostic만 stream한다.
- provider/generation 실패는 retrieval 실패와 분리해 `event: provider_error`로 stream한다.
- provider 실패 시 retrieval 결과가 있으면 context를 직접 보여주는 fallback message를 반환한다.
- provider 실패 시 retrieval 결과가 없으면 "provider skipped/unavailable + no relevant memories"를 명확히 표시한다.
- dashboard UI는 `/memory <query>` slash command를 memory-only mode로 보낸다.

### Acceptance criteria

- [x] Claude CLI auth/provider failure가 있어도 dashboard가 검색된 memory context와 provider diagnostic을 구분해 보여준다.
- [x] memory-only mode는 provider 호출 없이 deterministic하게 동작한다.
- [x] SSE stream은 `diagnostic` 또는 `provider_error` 후 `message`/`done`을 반환한다.
- [x] local dashboard smoke에서 selected CML project의 memory-only query가 retrievedMemories count와 context를 반환한다.
- [x] project DB 내부 mis-scoped legacy imports를 repair/quarantine하여 generic query noise를 줄인다.

## 2026-05-10 구현 업데이트 — Legacy project-scope repair/quarantine

### 추가된 기능 contract

- `MemoryService.repairLegacyProjectScope()`와 `SQLiteEventStore.repairLegacyProjectScope()`는 project-scoped store 내부의 legacy/imported rows를 검사한다.
- same-project legacy rows는 canonical `scope.project.hash`, `projectScopeConfidence`, `proj:<hash>` tag로 repair한다.
- 다른 project path/hash 또는 content 안의 GitHub repo/workspace basename이 현재 project와 충돌하는 row는 `quarantine.status = active`로 표시한다.
- project scope를 증명할 수 없는 legacy imported row는 `missing_project_scope` reason으로 quarantine한다.
- 기본 read path(`keywordSearch`, `getRecentEvents`, `getEvent`, `getSessionEvents`, `getEventsSince`, `getEventsSinceRowid`, `getEventsPage`, `getEventsByTurn`, `getSessionTurns`, `countSessionTurns`, `getMostAccessed`, `getHelpfulMemories`, `countEvents`, `getEventsByLevel`, `getLevelStats`)는 active quarantine rows를 제외한다. 유지보수/감사용으로만 `includeQuarantined` opt-in을 허용한다.
- CLI `repair legacy-project-scope -p <project>`는 기본 dry-run이며, `--apply`일 때만 mutation한다.
- `--project`와 `--project-hash`가 함께 주어졌을 때 hash가 path-derived hash와 다르면 CLI helper와 core store boundary 모두 실패해 foreign hash로 target store를 repair하지 않는다.
- 이미 current hash/tag가 있더라도 explicit `projectPath`/`sourceProjectPath`/session project path가 foreign project를 가리키면 `project-path-mismatch`로 quarantine한다.
- invalid legacy metadata JSON row는 default read에서 crash하지 않고, session project path evidence가 있으면 repair/quarantine 대상이 된다.
- hash-only dry-run에서 missing store는 empty aggregate로 보고하고 readonly open으로 storage directory를 만들지 않는다.
- repair CLI output은 raw local path/raw content를 출력하지 않고 aggregate count와 bounded sample만 보여준다.
- privacy filter는 memory 저장 전 CLI `--password ...`/`--password=...`, prefixed CLI secret options(`--client-secret ...`, `--db-password ...`, `--access-token ...`), hyphenated secret assignments(`db-password=...` 등), URL 다음 줄에 붙여넣은 password-looking 문자열을 `[REDACTED]` 처리한다. URL 다음 줄의 일반 상태 단어(`success` 등)는 과잉 redact하지 않는다.

### Acceptance criteria

- [x] mis-scoped legacy rows are excluded from search/recent/level dashboard reads after repair/quarantine.
- [x] already-scoped but content-conflicting legacy imports are detected as `content-project-mismatch`.
- [x] dry-run does not mutate; `--apply` mutates only the target project store.
- [x] live CML dogfood query for a predictor PR contamination trap returns 0 default results after apply.
- [x] stats/level distribution are consistent after quarantine filtering.
- [x] access/helpfulness/turn read paths also suppress active quarantined rows by default, while `includeQuarantined` stays available for explicit audit reads.
- [x] invalid legacy metadata JSON does not crash default event reads and can still be quarantined from session project path evidence.
- [x] explicit foreign project path evidence wins over current hash/tag so wrongly-current-scoped legacy rows are quarantined.
- [x] core repair API and CLI helper both fail closed on `projectPath`/`projectHash` mismatch.
- [x] explicit empty `--project` is rejected; hash-only dry-run on a missing store has no storage directory side effect.
- [x] password-bearing dashboard smoke commands, prefixed CLI secret options, and pasted URL+password prompts are redacted before future memory storage without over-redacting benign URL-next-line status words.
