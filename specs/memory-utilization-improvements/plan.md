# Plan: Memory Utilization Improvements

## 전체 목표

f4d5c120 실데이터 분석을 기반으로, 메모리 검색 → Trace 기록 → Graduation → Helpfulness의
cascade failure를 단계적으로 수정한다.

---

## Phase 1: Critical Fix (1주차)

### Task 1.1 — Retrieval Trace 동기 기록 수정 (IMP-01)

**목표**: 검색 실행 시 trace가 항상 DB에 기록되도록

**작업 단계**:

1. `src/hooks/user-prompt-submit.ts` 읽기
   - trace 기록 코드 위치 확인
   - stdout 출력과의 순서 관계 파악

2. `src/core/sqlite-event-store.ts` 읽기
   - `recordRetrievalTrace()` 구현 확인
   - async vs sync 여부 확인

3. 수정:
   ```typescript
   // Before (추정):
   const memories = await retrieve(query);
   process.stdout.write(formatOutput(memories));
   await store.recordRetrievalTrace({ ... }); // ← hook 종료 후 실행될 수 있음

   // After:
   const memories = await retrieve(query);
   store.recordRetrievalTraceSync({ ... }); // ← 동기 실행
   process.stdout.write(formatOutput(memories));
   ```

4. 검증:
   ```bash
   # 세션 시작 후 user_prompt 입력
   # 이후 확인:
   sqlite3 ~/.claude-code/memory/projects/f4d5c120/events.sqlite \
     "SELECT COUNT(*) FROM retrieval_traces WHERE created_at > datetime('now', '-1 hour');"
   ```

**완료 조건**: 검색이 실행된 모든 turn에서 trace 레코드 존재

---

### Task 1.2 — Tool Observation 필터링 (IMP-02)

**목표**: 저장 이벤트의 tool observation 비율을 93% → 30% 이하로

**작업 단계**:

1. `src/hooks/post-tool-use.ts` 읽기
   - 현재 저장 조건 파악
   - 기존 제외 목록 확인 (TodoRead, TodoWrite)

2. `src/core/metadata-extractor.ts` 읽기
   - 중요도 판별 로직 존재 여부 확인

3. 필터 로직 추가:
   ```typescript
   function shouldStoreToolObservation(toolName: string, input: unknown, output: string): boolean {
     // 항상 저장
     if (['Write', 'Edit', 'MultiEdit'].includes(toolName)) return true;

     // 항상 제외
     if (['Read', 'Glob', 'TodoRead', 'TodoWrite'].includes(toolName)) return false;

     // Bash: 오류 또는 중요 키워드
     if (toolName === 'Bash') {
       const exitCode = extractExitCode(output);
       if (exitCode !== 0) return true;
       return IMPORTANT_KEYWORDS.some(kw => output.toLowerCase().includes(kw));
     }

     // Grep: 결과 10줄 초과 시
     if (toolName === 'Grep') {
       return output.split('\n').length > 10;
     }

     return false;
   }
   ```

4. 기존 L0 데이터는 변경하지 않음 (append-only 원칙 유지)

**완료 조건**: 새 세션의 tool observation 비율 < 40%

---

## Phase 2: Quality (2주차)

### Task 2.1 — 세션 요약 신뢰성 (IMP-03)

**목표**: 세션 요약 생성률 5% → 80% 이상

**작업 단계**:

1. `src/hooks/session-start.ts` 읽기
   - 백필 로직 (`backfillPreviousSession`) 확인
   - 현재 요약 생성 여부 파악

2. `src/hooks/stop.ts` 읽기
   - 요약 생성 로직 위치
   - 실패 시 에러 처리 방식

3. session-start에 규칙 기반 요약 생성 추가:
   ```typescript
   async function generateRuleBasedSummary(sessionId: string): Promise<string> {
     const events = await store.getSessionEvents(sessionId);
     const prompts = events.filter(e => e.eventType === 'user_prompt');
     const tools = [...new Set(events.filter(e => e.eventType === 'tool_observation')
       .map(e => e.metadata?.toolName))];
     const errors = events.filter(e =>
       e.eventType === 'tool_observation' && e.metadata?.exitCode !== 0
     );

     return [
       `[${formatDate(events[0].timestamp)}] ${prompts.length}턴 세션.`,
       prompts.length > 0 ? `주요 작업: ${prompts[0].content.slice(0, 100)}` : '',
       tools.length > 0 ? `사용 툴: ${tools.join(', ')}` : '',
       errors.length > 0 ? `오류 발생: ${errors.length}건` : '',
     ].filter(Boolean).join(' ');
   }
   ```

4. session-start 백필 시 호출:
   ```typescript
   if (events.length >= 3 && !existingSummary) {
     const summary = await generateRuleBasedSummary(prevSessionId);
     await store.storeEvent({ eventType: 'session_summary', content: summary, ... });
   }
   ```

**완료 조건**: 백필 실행 후 기존 세션 중 80% 이상에 요약 생성

---

### Task 2.2 — Graduation Repair CLI (IMP-04)

**목표**: 기존 L0 이벤트 중 자격 있는 것들을 L1으로 승격

**작업 단계**:

1. `src/core/graduation.ts` 읽기
   - 현재 L0→L1 승격 기준 파악
   - `recordAccess()` 호출 위치

2. 시간 기반 승격 규칙 추가:
   ```typescript
   // 7일 이상 된 user_prompt 이벤트 중 내용이 충분한 것
   const GRADUATION_RULES_L1 = {
     minAge: 7 * 24 * 60 * 60 * 1000,  // 7일
     minContentLength: 100,
     eventTypes: ['user_prompt', 'session_summary'],
   };
   ```

3. CLI 커맨드 추가:
   ```
   claude-memory graduation --repair [--project <hash>] [--dry-run]
   ```
   출력 예시:
   ```
   Analyzing 1587 events...
   Eligible for L1: 43 events (user_prompt: 38, session_summary: 5)
   Eligible for L2: 0 events
   [--dry-run: no changes made]
   Run without --dry-run to apply.
   ```

**완료 조건**: `--dry-run` 후 승격 후보 확인, 실제 실행 후 L1 이벤트 발생

---

### Task 2.3 — Embedding 모델 모니터링 (IMP-05)

**목표**: 모델 오류 시 자동 폴백 + 대시보드에 상태 표시

**작업 단계**:

1. `src/hooks/semantic-daemon.ts` 읽기
   - 현재 모델 로딩/폴백 로직
   - 오류 핸들링 방식

2. 헬스체크 강화:
   ```typescript
   class SemanticDaemon {
     private modelHealth: 'primary' | 'fallback' | 'keyword-only' = 'primary';

     async embed(text: string): Promise<number[]> {
       try {
         return await this.primaryModel.embed(text);
       } catch (e) {
         if (this.modelHealth === 'primary') {
           this.modelHealth = 'fallback';
           logger.warn('[embedding] switched to fallback model');
         }
         try {
           return await this.fallbackModel.embed(text);
         } catch (e2) {
           this.modelHealth = 'keyword-only';
           return []; // 키워드 전용 모드
         }
       }
     }
   }
   ```

3. `/api/stats` 응답에 모델 상태 추가:
   ```json
   {
     "embeddingModel": {
       "current": "fallback",
       "primaryErrors": 12,
       "fallbackErrors": 0,
       "successRate": 0.99
     }
   }
   ```

**완료 조건**: 모델 오류 시 자동 폴백 + 대시보드에 상태 표시

---

## Phase 3: Feedback Loop (3주차)

### Task 3.1 — Helpfulness 자동 평가 (IMP-06)

**목표**: sessions_helpfulness 테이블에 실제 데이터 축적 시작

**작업 단계**:

1. `src/hooks/stop.ts` 읽기
   - 세션 종료 시 처리 로직
   - agent_response 이벤트 저장 방식

2. 휴리스틱 평가 로직:
   ```typescript
   async function evaluateHelpfulness(sessionId: string) {
     const traces = await store.getSessionRetrievalTraces(sessionId);
     const responses = await store.getSessionEvents(sessionId, 'agent_response');
     const responseText = responses.map(r => r.content).join(' ');

     for (const trace of traces) {
       for (const eventId of trace.selectedEventIds) {
         const event = await store.getEvent(eventId);
         // canonicalKey나 내용의 핵심 명사가 응답에 포함되는지 확인
         const mentioned = responseText.includes(event.canonicalKey?.split('/').pop() ?? '');
         const score = mentioned ? 0.8 : 0.3;

         await store.recordHelpfulness({
           sessionId,
           eventId,
           helpfulness: score,
           evaluatedAt: new Date(),
         });
       }
     }
   }
   ```

3. `matcher.ts`에 helpfulness 가중치 추가:
   ```typescript
   const helpfulnessScore = await store.getAvgHelpfulness(eventId) ?? 0.5;
   finalScore = baseScore * 0.9 + helpfulnessScore * 0.1;
   ```

**완료 조건**: 각 세션 종료 후 sessions_helpfulness에 레코드 생성

---

### Task 3.2 — 컨텍스트 포맷 개선 (IMP-07)

**목표**: Claude가 메모리를 명확하게 인식하고 활용할 수 있는 포맷

**작업 단계**:

1. `src/hooks/user-prompt-submit.ts`의 stdout 출력 포맷 확인

2. 새 포맷으로 변경:
   ```
   <memory_context>
   [2026-02-25 | 신뢰도: 높음]
   주제: LLM function call generalization
   내용: generalize_with_llm() 함수를 사용해 상품 추천 로직 개선. 응답 속도 40% 향상.
   ---
   [2026-02-26 | 신뢰도: 중간]
   주제: ONNX embedding 오류 처리
   내용: RotaryEmbedding 노드 오류 시 fallback 모델로 자동 전환 구현.
   </memory_context>
   ```

3. `suggested` confidence 이벤트는 별도 섹션으로 분리:
   ```
   <memory_hints optional="true">
   (참고) 이전에 유사한 작업을 한 적 있음: ...
   </memory_hints>
   ```

**완료 조건**: 메모리 포함 시 Claude 응답에서 메모리 내용 참조 증가 확인

---

### Task 3.3 — Vector/LanceDB schema mismatch fallback (IMP-08)

**목표**: 오래된 vector index 또는 embedder dimension mismatch가 있어도 agent-facing MCP tools가 멈추지 않도록 한다.

**작업 단계**:

1. `src/core/progressive-retriever.ts`, vector adapter, `src/extensions/mcp/handlers.ts`에서 semantic/vector query 예외 경계를 확인한다.
2. LanceDB 오류 메시지(`No vector column found to match with the query vector dimension`)를 recoverable vector-unavailable 상태로 매핑한다.
3. `mem-context-pack` fallback 경로 추가:
   - relevant memories: keyword/FTS 가능한 결과만 사용
   - recent timeline/session summaries: 항상 반환
   - warning: semantic vector search unavailable
4. `mem-search` fallback 경로 추가:
   - keyword results가 있으면 반환
   - 없으면 safe diagnostic + `claude-memory-layer process -p <project>` 또는 rebuild 안내
5. Fixture/test 추가:
   - vector table dimension mismatch를 재현
   - `mem-context-pack`은 `isError=false`
   - `mem-search`는 fallback 또는 actionable diagnostic 반환

**완료 조건**: 실제 `/Users/namsangboy/workspace/claude-memory-layer` projectPath에서 MCP `mem-context-pack(query=continue)`와 `mem-search`가 오류 없이 완료

---

### Task 3.4 — Project-scoped retrieval isolation (IMP-09)

**목표**: `projectPath`가 지정된 context pack/timeline/search에 다른 workspace 프로젝트 내용이 섞이지 않도록 한다.

**작업 단계**:

1. Codex/Hermes/Claude importer가 저장하는 event/session metadata의 `projectPath`, `projectHash`, source 정보를 확인한다.
2. Retrieval/timeline query가 project service를 사용하더라도 metadata filter를 한 번 더 적용하도록 보강한다.
3. Hermes project context가 없는 sessions는 auto-refresh 대상에서 제외하고 validation warning을 유지한다.
4. Cross-project contamination fixture 구성:
   - target: `claude-memory-layer`
   - distractors: `predictor`, `Streamlit`
   - assertion: `containsOtherProject === false`
5. CLI/MCP parity test 추가:
   - 같은 `projectPath`의 stats/search storage label과 event/vector count가 일치
6. Dashboard dogfood 후속:
   - project DB 안에 이미 들어온 legacy unscoped Hermes imports를 기본 project view에서 제외하거나 `legacy/unscoped` bucket으로 분리
   - dry-run repair CLI 계획: `claude-memory-layer repair legacy-project-scope --project <hash> --dry-run`
   - dashboard keyword smoke: selected `claude-memory-layer` project에서 `predictor`, `Streamlit`, `alpha-ai-trader`가 일반 project 결과로 섞이지 않음

**완료 조건**: `mem-context-pack(projectPath=...)`, `mem-project-timeline(projectPath=...)`, CLI `search -p ...`, dashboard project filter가 모두 same-project 결과만 반환

---

### Task 3.5 — Dashboard read/search resilience (IMP-10a)

**목표**: Dashboard browsing/search가 embedder/vector backend 문제 때문에 500으로 깨지지 않게 한다.

**작업 단계**:

1. `/api/events`, `/api/sessions`가 SQLite-only 화면임을 확인하고 lightweight read service로 전환한다.
2. `tests/apps/dashboard-read-api-lightweight.test.ts` 추가:
   - events/sessions router가 `getLightweightServiceFromQuery()`를 사용
   - full `getServiceFromQuery()`가 호출되지 않음
3. `/api/search/disclosure` `strategy=auto`가 embedding backend init/query 실패 시 lightweight `strategy=fast`로 fallback한다.
4. `tests/apps/search-api-disclosure.test.ts`에 embedding backend unavailable fixture 추가:
   - primary initialize throws `Unable to get model file path or buffer.`
   - response 200
   - fallback service receives `{ strategy: 'fast' }`
5. Live dashboard dogfood:
   - login
   - project select
   - `/api/stats`, `/api/events`, `/api/sessions`, `/api/search/disclosure` 200
   - browser console error 0

**완료 조건**: fresh/local dashboard에서 exact keyword search가 200으로 동작하고, embedder unavailable 상태도 dashboard 전체를 막지 않음

---

### Task 3.6 — Ask Memory provider diagnostic + memory-only mode (IMP-10b)

**Status (2026-05-10)**: implemented and dogfooded locally.

**목표**: Ask Memory가 Claude CLI 인증/프로바이더 문제와 memory retrieval 품질을 분리해서 보여준다.

**작업 단계**:

1. `src/apps/server/api/chat.ts`에 provider preflight 추가:
   - `claude --version` 확인
   - auth failure를 감지하면 사용자 친화 diagnostic 반환
2. memory retrieval 단계와 LLM generation 단계를 분리해 response metadata에 표시:
   - `retrievedMemoryCount`
   - `searchMode`
   - `providerStatus`
3. LLM 없이도 검색 근거를 확인할 수 있는 memory-only mode 추가:
   - API: `POST /api/chat?mode=memory-only`
   - UI toggle: `Memory-only`
4. SSE error protocol 정리:
   - auth failure에서 `done`과 `error`를 동시에 보내지 않음
   - raw provider stderr/request id를 그대로 노출하지 않음
5. Test 추가:
   - Claude CLI auth failure fixture
   - memory retrieval success + provider failure fixture

**완료 조건**: Claude auth가 깨져도 사용자가 "검색된 기억은 무엇이고, 왜 답변 생성이 안 됐는지"를 dashboard에서 이해할 수 있음

**2026-05-10 구현 결과**:

- [x] API `POST /api/chat`가 `mode: 'memory-only'` 또는 `memoryOnly: true`를 지원한다.
- [x] memory-only mode에서는 Claude CLI/provider를 호출하지 않고 retrieval diagnostic + retrieved context만 SSE로 반환한다.
- [x] provider failure는 generic stream error가 아니라 `event: provider_error`로 분리한다.
- [x] provider failure 시에도 retrieved memory context 기반 fallback message를 제공한다.
- [x] dashboard chat UI에서 `/memory <query>` slash command로 memory-only mode를 사용할 수 있다.
- [x] SSE parser가 named event(`diagnostic`, `provider_error`)를 처리해 UI notice로 표시한다.
- [x] local dashboard smoke에서 `/api/chat` memory-only가 `event: diagnostic`, `event: message`, `event: done`을 반환한다.

**Dogfood에서 확인한 남은 품질 이슈**:

- project DB 내부에 legacy/mis-scoped Hermes imports가 남아 있어, generic query(`dashboard`)가 CML project view에서 Alpha AI Trader/Streamlit 관련 기억을 high score로 반환할 수 있었다.
- 이는 provider 문제가 아니라 candidate corpus 품질 문제이며, IMP-09의 legacy project-scope repair/quarantine 후속으로 추적한다.

---

### Task 3.7 — Legacy project-scope repair/quarantine (IMP-10c)

**목표**: project-scoped store 내부에 이미 잘못 들어온 다른 프로젝트 memory를 기본 검색/Ask Memory에서 제외한다.

**작업 단계**:

1. Mis-scoped row detector를 설계한다. ✅
   - metadata `scope.project.path/hash`와 content 안의 명시적 workspace path가 충돌하는지 확인
   - GitHub repo URL 또는 workspace path가 현재 project basename과 충돌하는 already-scoped legacy import도 탐지
   - content에 다른 repo slug(`alpha-ai-trader`, `predictor`, `Streamlit`)가 반복적으로 등장하는 suspect row를 privacy-safe aggregate로 집계
2. `repair legacy-project-scope --project <path|hash> --dry-run` CLI를 추가한다. ✅
   - 기본은 dry-run, `--apply`일 때만 metadata mutation
   - raw content/local path 출력 금지
   - counts/event IDs/action reason만 bounded sample로 표시
3. 기본 query path에서 quarantine flag 또는 scope confidence를 반영한다. ✅
   - `keywordSearch`, `getRecentEvents`, `getEvent`, `getSessionEvents`, `getEventsSince`, `getEventsSinceRowid`, `getEventsPage`, `getEventsByTurn`, `getSessionTurns`, `countSessionTurns`, `getMostAccessed`, `getHelpfulMemories`, `countEvents`, `getEventsByLevel`, `getLevelStats`는 active quarantine rows를 제외
   - invalid legacy metadata JSON은 default read에서 crash하지 않고 metadata를 비워 읽으며, session project path evidence가 있으면 repair/quarantine 대상이 된다
   - explicit foreign `projectPath`/`sourceProjectPath`/session project path evidence는 current hash/tag보다 우선해 `project-path-mismatch` quarantine으로 처리
   - core repair API와 CLI helper 모두 `projectPath`/`projectHash` mismatch를 fail-closed 처리
   - maintenance/audit callers만 `includeQuarantined` opt-in 사용
4. dashboard에 "suspected cross-project memories" aggregate card를 추가한다. ⏳
   - 이번 릴리스는 CLI/API repair와 기본 view suppression 우선
   - 다음 단계에서 quarantine review/aggregate card 추가
5. regression fixture: ✅
   - target project: `claude-memory-layer`
   - distractor content: `alpha-ai-trader` / `predictor` / `Streamlit` legacy memory
   - assertion: default search/recent/level reads가 distractor를 반환하지 않음

**검증 결과(2026-05-10, project `b7f03a73`)**:

- dry-run: scanned 61, already scoped 50, quarantined 11, repaired 0
- apply 후 재 dry-run: quarantined 0, skipped 11
- ongoing live import 후 재 dry-run: scanned 73, already scoped 62, quarantined 0, skipped 11
- `justinbuzzni predictor pull ac48518` raw contamination is no longer returned; current CML repair explanation memories may still match predictor-contamination audit queries and are intentionally kept searchable
- stats after quarantine filtering: active Total Events 62, Vector Count 51, Memory Levels L0 43 / L1 19 after ongoing live imports; first apply baseline was active Total Events 50, L0 31 / L1 19
- dashboard/API smoke: `/health` 200, unauth `/`/`/api/stats` 401, login 200, authenticated `/`, `/api/health`, `/api/stats`, `/api/stats/shared`, `/api/stats/endless`, `/api/stats/levels/L0`, `/api/stats/most-accessed`, `/api/stats/timeline`, `/api/stats/helpfulness`, `/api/stats/usefulness`, `/api/stats/retrieval-traces`, `/api/stats/retrieval-review-queue`, `/api/stats/kpi`, `/api/events`, `/api/sessions`, `/api/search/disclosure`, `/api/chat` memory-only all 200
- dashboard UI smoke: `/memory legacy project scope repair quarantine` submits through `/api/chat` 200, page remains on dashboard, console/js errors 0
- privacy smoke: CLI `--password ...` / `--password=...`, prefixed options(`--client-secret ...`, `--db-password ...`, `--access-token ...`), hyphenated assignments, and URL-next-line password paste are redacted before future memory storage; benign URL-next-line status words are not over-redacted; existing live DB credential-like rows cleaned to 0 unredacted matches
- split tests: core 44 files / 240 tests, apps 22 files / 101 tests, extensions+adapters 14 files / 82 tests passed
- replay: Precision@1 1.0, MRR 1.0, forbidden hits 0, failed queries 0

**완료 조건**: live CML project dashboard memory-only query에서 unrelated Alpha AI Trader/Streamlit memories가 기본 top results에 섞이지 않음

---

## 검증 계획

각 Phase 완료 후 f4d5c120 프로젝트로 아래 지표 확인:

```bash
# Phase 1 완료 후
sqlite3 ~/.claude-code/memory/projects/f4d5c120/events.sqlite << 'EOF'
SELECT
  'retrieval_traces' as metric,
  COUNT(*) as value
FROM retrieval_traces
UNION ALL
SELECT
  'tool_obs_ratio',
  ROUND(100.0 * SUM(CASE WHEN event_type='tool_observation' THEN 1 END) / COUNT(*), 1)
FROM events
WHERE created_at > datetime('now', '-3 days');
EOF

# Phase 2 완료 후
SELECT
  'l0_count', COUNT(*) FROM events WHERE level = 0
UNION ALL
SELECT
  'l1_plus_count', COUNT(*) FROM events WHERE level >= 1
UNION ALL
SELECT
  'session_summary_count', COUNT(*) FROM events WHERE event_type = 'session_summary';

# Phase 3 완료 후
SELECT
  'helpfulness_records', COUNT(*) FROM sessions_helpfulness
UNION ALL
SELECT
  'avg_helpfulness', ROUND(AVG(helpfulness), 2) FROM sessions_helpfulness;
```

---

## 담당 파일 목록

| 파일 | 변경 이유 | Phase |
|------|---------|-------|
| `src/hooks/user-prompt-submit.ts` | Trace 동기 기록, 컨텍스트 포맷 | 1, 3 |
| `src/hooks/post-tool-use.ts` | Tool observation 필터링 | 1 |
| `src/core/sqlite-event-store.ts` | recordRetrievalTraceSync 추가 | 1 |
| `src/hooks/session-start.ts` | 세션 요약 백필 | 2 |
| `src/hooks/stop.ts` | Helpfulness 평가 추가 | 2, 3 |
| `src/core/graduation.ts` | 시간 기반 승격 규칙 | 2 |
| `src/core/matcher.ts` | Helpfulness 가중치 | 3 |
| `src/hooks/semantic-daemon.ts` | 모델 헬스체크 강화 | 2 |
| `src/server/api/stats.ts` | 모델 상태 지표 추가 | 2 |
| `src/cli/index.ts` | graduation --repair 커맨드 | 2 |

## Phase 4 — Evidence-to-answer loop (2026-07-14)

### Task 4.1 — Claude delivery contract

- [x] SessionStart/UserPromptSubmit output을 official `additionalContext` envelope로 변경한다.
- [x] empty/error fallback도 valid event envelope로 통일한다.
- [x] 실제 Claude CLI가 `additionalContext`를 읽고 주입 event 내용을 명시적으로 판정하는 것을 확인했다. 최종 answer-quality gate는 Task 4.4에서 계속 추적한다.

### Task 4.2 — Evaluation isolation

- [x] `CLAUDE_MEMORY_EVAL_MODE=true`에서 corpus/trace/helpfulness/adherence mutation을 차단한다.
- [x] semantic daemon request까지 evaluation flag를 전달해 `events=2023`, `retrieval_traces=241` 전후 불변을 확인했다.
- [ ] 과거 synthetic `7777...`/`8888...` 세션은 운영 성능평가 집계에서 제외한다. 삭제는 별도 승인 작업이다.

### Task 4.3 — Evidence utility and episode expansion

- [x] event-type utility prior와 prompt-only answerability abstention을 추가한다.
- [x] user/tool seed에서 ±4 event episode를 확장하고 response/summary evidence를 병합한다.
- [x] episode-linked evidence는 seed relevance를 상속하되 source ref를 보존한다.
- [ ] episode를 canonical artifact로 저장하는 후속 단계는 shadow 평가 후 결정한다.

### Task 4.4 — Progressive field evaluation

1. `recsys_justin` 5-case smoke: PR review, production incident, feature change, GitOps, unrelated control.
2. gate: unrelated=0, prompt-only answer=0, answerable relevant ≥4/5, cross-project=0.
3. gate 통과 시 20+ queries로 확대: incident/procedure/decision/review/continuation/no-match 균형 표본.
4. memory off/on actual-answer 비교에서 grounded fact coverage, unsupported claim, abstention을 판정한다.
5. 결과에 따라 evidence bonus, episode window, score-cliff를 조정하되 no-match gate는 악화시키지 않는다.

**Definition of Done**:

- typecheck/test/lint/build/architecture/privacy/retrieval replay green.
- small→expanded field report에 corpus 규모, 제외 규칙, case별 selected evidence type, latency, pass/fail을 기록.
- 실제 Claude가 injected evidence를 사용한 사례와 올바르게 abstain한 사례를 각각 확보.

### 2026-07-14 실행 결과

- 5-case gate: 5/5. incident/feature/GitOps는 answer evidence를 주입했고 PR prompt-only와 unrelated control은 abstain했다.
- 확대 23-case: TP=12, FN=0, FP=0, TN=11; selection precision/recall/accuracy=1.0. p50=123.1ms, p95=371.8ms.
- 확대 표본은 identifier가 분명한 hand-labeled field smoke이므로 일반화 성능의 최종 수치가 아니다. golden replay no-match accuracy=1, forbidden hits=0도 별도 통과했다.
- 실제 Claude delivery는 확인됐다. 첫 relevant answer run은 GitHub/Argo 인접 tool evidence가 섞여 안전하게 `근거 부족` 처리했고, 이후 answer가 있으면 tool attempt를 기본 제외하도록 튜닝했다. post-tuning direct hook은 올바른 Argo agent response 1건만 반환했다.
- post-tuning actual provider run 두 번은 CLI stdout이 비어 최종 generated-answer 개선 판정은 미완료다. selection gate는 green이지만 answer-quality enforce 승격은 아직 보류한다.

## Phase 5 — Hook-only automatic graduation (2026-07-14)

### Task 5.1 — One-shot runtime contract

- [x] embedding-only writable runtime에서 periodic worker를 시작하지 않고 `forceGraduation()` one-shot을 허용한다.
- [x] read-only/lightweight runtime은 기존처럼 mutation 없는 empty result를 유지한다.
- [x] one-shot worker는 호출마다 새 인스턴스를 만들지 않고 runtime 동안 재사용한다.

### Task 5.2 — Semantic daemon scheduler

- [x] strict-filtered access/helpfulness evidence를 저장한 뒤 Hook이 daemon에 project별 background graduation을 예약한다.
- [x] default cooldown 5분, 짧은 post-response delay, in-flight dedupe를 적용한다.
- [x] eval mode/환경변수 disable을 지원하고 daemon shutdown에서 pending timer/running promise를 정리한다.
- [x] schedule ack만 Hook에서 기다리고 worker failure가 retrieval response에 영향을 주지 않게 한다.

### Task 5.3 — Candidate fairness and verification

- [x] SQLite graduation candidate를 `access_count`, `last_accessed_at`, timestamp 순으로 선택한다.
- [x] distinct retrieval session을 durable cross-session evidence로 복원한다.
- [x] scheduler/runtime/store 단위 테스트와 hook integration test를 추가한다.
- [x] `recsys_justin` 실제 store에서 attempt telemetry, L1+ delta, retrieval latency를 소규모→확대 검수한다.

### 2026-07-14 실행 결과

- 기준선: events=2,023, L0=2,014, L1=9, accessed L0=285, graduation attempts=0.
- 첫 실제 Hook canary: 수동 `process` 없이 attempt=1, worker latency=5ms, L0 50건이 L1로 승격됐다. Hook wall time은 0.88s였다.
- 6개 동시 semantic retrieval burst: wall time=203.6ms, attempt는 1회만 증가해 in-flight dedupe를 확인했고 추가 50건이 L1로 승격됐다.
- access-write race 제거 후 실제 Hook 재검증: attempt=3, 최종 L0=1,866/L1=126/L2=33. durable cross-session evidence로 L1→L2도 33건 발생했다.
- eval canary는 levels/attempts/events/retrieval traces가 모두 불변이었다.
- 전체 회귀: 158 test files/920 tests, typecheck/lint(0 errors)/architecture/replay/privacy/build green.

## Phase 6 — Graduated evidence utilization (2026-07-14)

### Task 6.1 — Level-aware answer lane

- [x] L1+ `user_prompt`/`agent_response`/`session_summary` FTS lane을 추가한다.
- [x] prompt는 episode seed로만, response와 non-template summary만 direct answer로 사용한다.
- [x] semantic result와 graduated result가 같은 event면 calibrated graduated score로 통일한다.

### Task 6.2 — Entity and intent calibration

- [x] query/identifier/entity coverage와 entity proximity를 점수에 반영한다.
- [x] 원인·장애 질문에는 causal/outcome evidence가 없는 일반 가이드를 제외한다.
- [x] graduated top plateau에는 0.02 strict score-cliff를 적용한다.
- [x] level/access prior는 answer-capable type에만 작게 적용한다.
- [x] question boilerplate를 lexical overlap에서 제거하고 graduated level prior 중복 가중치를 제거한다.

### Task 6.3 — Progressive validation

- [x] 8-case promoted-memory gate를 before/after 비교한다.
- [x] 20+ topic/no-match field set으로 확대한다.
- [x] 실제 Claude answer에서 injected L1/L2 citation의 grounded fact coverage를 확인한다.
- [x] 전체 regression/privacy/build gate와 eval immutability를 재확인한다.

### 소규모 실행 결과

- 변경 전: answerable 6개 중 정확한 top evidence 3개, prompt-only/no-match 2개는 abstain.
- 단순 level boost 실험은 긴 promoted 문서가 다수 주입되는 회귀를 보여 폐기했다.
- 최종 calibrated lane: git author L2, wshop deploy L2, TRIGGER_SEARCH L1, S3 limit L1, release scope L2, ssgshop CrashLoop L1을 각각 1건씩 정확히 선택했다.
- PR 167 prompt-only와 unrelated travel은 모두 abstain하여 8/8 통과. latency p50≈138ms, max=172ms.
- 정밀 positive 12건 + prompt-only/unrelated 8건 확대 gate는 20/20 통과했다. final run latency는 p50=141.6ms, p95=425.1ms였다.
- 실제 Claude Code `UserPromptSubmit` event에서 S3 PutObject L1 `a6d442e2…`가 주입되었고, Claude가 5GB single-PUT limit·8.3GB artifact·multipart 해결을 근거와 일치하게 답했다.
- 실 provider no-match에서 `화성의 대기 조성`에 CI runner L0가 잘못 주입되는 경계 사례를 발견했다. `어떻게`를 question boilerplate로 제거하고 2개 strong-term gate를 유지해, 수정 후 동일 hook은 `additionalContext` 없이 abstain했다.
- `95b2c36 / No changes`에서 넓은 L2 release 문서가 정확한 L1 incident를 앞서는 중복 level-prior를 제거했고, 수정 후 L1 `6c9bbdab…`를 선택했다.
- 최종 gate: 158 test files/926 tests, typecheck, lint(0 errors/41 existing warnings), architecture(221 files), golden replay(no-match 1.0/forbidden 0/failed 0), public-output privacy(0 findings), build, `git diff --check` 모두 통과했다.
- eval 전후 `recsys_justin` canonical store는 events=2,025, retrieval traces=251, L0/L1/L2=1,866/126/33으로 불변이었다.

## Phase 7 — 100-case field benchmark and evaluation Skill (2026-07-14)

### Task 7.1 — Privacy-safe local dataset generation

- [x] same-turn prompt/response pair에서 deterministic 80 positive case를 생성한다.
- [x] identifier counterfactual 10건과 unrelated no-match 10건을 추가한다.
- [x] raw dataset을 ignored local artifact로 저장하고 aggregate manifest만 공유한다.

### Task 7.2 — Hook-realistic evaluator

- [x] eval-mode `UserPromptSubmit` runner와 top-1/hit/no-match/latency metric을 구현한다.
- [x] level/kind breakdown과 query-free failure diagnostics를 출력한다.
- [x] evaluation 전후 store immutability를 검증한다.

### Task 7.3 — Iterative quality improvement

- [x] 100-case baseline을 실행하고 failure taxonomy를 작성한다.
- [x] precision/recall/no-match 저하 원인을 정책에 반영한다.
- [x] 동일 frozen dataset으로 재평가해 개선폭과 남은 한계를 기록한다.

### Task 7.4 — Reusable Skill and gates

- [x] `evaluate-memory-retrieval` Skill을 `~/.codex/skills`에 생성하고 runner workflow를 연결한다.
- [x] Skill metadata/validation/smoke를 통과한다.
- [x] 전체 test/typecheck/lint/architecture/replay/privacy/build gate를 통과한다.

### 2026-07-14 실행 결과

- 629 same-turn pair에서 privacy/quality filter를 통과한 positive 80건, counterfactual 10건, unrelated 10건을 생성했다. positive중 28건은 L1/L2, source session은 42개다.
- raw query dataset/report는 `benchmarks/field-memory/*.local*.json`(0600, gitignored)에만 저장하고 schema와 runner만 커밋 대상으로 둔다.
- 초기 baseline은 overall 32%, positive hit 22.5%, top-1 10%, no-match 70%였다.
- exact prompt를 answer ranking과 분리한 episode seed, same-turn 전체 조회, weak numeric/boilerplate 차단, counterfactual 생성 수정, FTS candidate pool 확대를 반영했다.
- 가장 큰 원인은 BM25 ascending rank를 반대로 정규화해 exact result=0, weak tail=1로 만들던 버그였다. 방향 수정과 semantic/keyword duplicate의 stronger calibration merge를 추가했다.
- 최종 frozen-set gate는 overall 100%, positive hit 100%, positive top-1 98.75%, no-match 100%, unexpected injection/error 0이다.
- concurrency=1 latency는 p50=148.1ms/p95=439.5ms, concurrency=4 burst는 p50=268.3ms/p95=1,043.5ms였다. 두 실행 모두 `storeImmutable=true`였다.
- Skill `quick_validate.py`, Python compile, bundled wrapper 100-case mature gate가 통과했다.
- 전체 회귀 게이트는 159 test files/935 tests, typecheck, lint(0 errors/41 existing warnings), architecture(222 files), golden replay(no-match 1.0/forbidden 0/failed 0), public-output privacy(0 findings), build, `git diff --check`를 통과했다.
- Skill 전방 테스트에서 저장소 루트 기준 wrapper 경로가 모호한 문제를 발견해, 어느 작업 디렉터리에서도 실행 가능한 `${CODEX_HOME:-$HOME/.codex}` 경로와 transient session 정리 규칙을 명시했다.
- 과거 field eval이 남긴 transient session mapping 9개를 정리하고 evaluator에 `finally` unregister를 추가했다. 최종 재실행 후 canonical store는 events=2,025, retrieval traces=251, L0/L1/L2=1,866/126/33, transient eval sessions=0으로 확인됐다.
- threshold를 의도적으로 실패시킨 100-case 실행과 unit test에서도 transient eval sessions=0을 확인해 실패 경로 정리를 고정했다.

## Phase 8 — Frozen field fixture and npm release (2026-07-14)

### Task 8.1 — Corpus freeze

- [x] 기존 100-case dataset과 평가 당시 SQLite corpus를 별도 ignored `.local` fixture 디렉터리로 동결한다.
- [x] WAL-consistent backup, file mode `0600`, checksum, corpus count manifest를 구현한다.

### Task 8.2 — Isolated replay

- [x] evaluator에 `--fixture`/`--freeze-to` workflow를 추가한다.
- [x] fixture 전용 disposable `HOME`과 transient registry를 사용해 live project store/daemon과 분리한다.
- [x] frozen fixture로 기존 mature gate와 store immutability를 재검증한다.

### Task 8.3 — Release

- [x] Skill과 문서에 frozen fixture workflow를 반영한다.
- [x] self-dependency/package contents/full regression gate를 확인한다.
- [x] patch version을 배포하고 npm registry에서 설치 가능 여부를 확인한다.

### 2026-07-14 실행 결과

- `benchmarks/field-memory/fixtures/recsys-justin-100-2026-07-14.local/`에 100-case dataset, SQLite snapshot, checksum/count manifest를 모두 `0600`으로 동결했다. 전체 디렉터리는 gitignored다.
- fixture snapshot은 events=2,025, retrieval traces=251, L0/L1/L2=1,866/126/33이며 dataset/store SHA-256 검증을 매 실행 선행한다.
- Hook이 canonical snapshot에 WAL/SHM을 만들지 않도록 매 실행마다 OS temp 아래 disposable HOME/DB copy를 만들고 종료 시 삭제한다. live semantic daemon 영향도 차단하기 위해 fixture replay는 keyword mode로 고정했다.
- frozen replay 결과는 concurrency=1/4 모두 overall 100%, positive hit 100%, positive top-1 98.75%, no-match 100%, unexpected injection/error 0, `storeImmutable=true`였다.
- 두 번의 반복 replay 뒤 canonical fixture checksum은 모두 일치했고 snapshot 디렉터리에 WAL/SHM 파일은 0개였다.
- self-dependency `(empty)`, npm dry-run 56 files/5.3MB, 159 files/935 tests, typecheck, lint(0 errors/41 existing warnings), architecture, replay, privacy, build gate를 통과했다.
- `claude-memory-layer@1.0.56`을 npm `latest`로 publish했고 registry integrity 조회와 clean temp install에서 package version/bin entry를 재확인했다.

## Phase 9 — 200-case hard-query field benchmark (2026-07-14)

### Task 9.1 — Difficulty taxonomy

- [x] 기본 구성을 positive 150/counterfactual 25/unrelated 25로 확대한다.
- [x] exact/contextual/compressed/paraphrased/noisy query style과 easy/standard/hard 난이도 label을 추가한다.
- [x] plausible identifier swap과 기술 인접 no-match 질문으로 negative 난이도를 높인다.

### Task 9.2 — Evaluation and fixture

- [x] difficulty/style별 hit/top-1/no-match metric과 query-free failure metadata를 추가한다.
- [x] deterministic/privacy/schema 단위 테스트를 추가한다.
- [x] 200-case dataset+SQLite snapshot을 새 ignored frozen fixture로 생성한다.

### Task 9.3 — Iterative improvement

- [x] frozen hard set baseline을 실행하고 miss/wrong-top1/unexpected-injection을 분류한다.
- [x] case-specific 예외 없이 일반 retrieval 정책을 개선하고 같은 fixture로 재평가한다.
- [x] full regression/privacy/build gate와 Skill workflow를 갱신한다.

### 2026-07-15 실행 결과

- 새 fixture `recsys-justin-200-hard-2026-07-14.local`은 positive 150/counterfactual 25/unrelated 25이며 easy 30/standard 40/hard 130이다.
- positive는 exact/contextual/compressed/paraphrased/noisy를 각 30건 포함한다. counterfactual은 `zz` 표식 대신 plausible identifier를 사용하면서 원문 구조를 유지한다.
- 최초 hard baseline은 overall 98%, positive hit 97.33%, top-1 95.33%, no-match 100%였고 miss 4건이 모두 noisy-clue L0에 집중됐다.
- episode seed를 3→5로 확대하고 seed별 episode budget을 분리했으며, direct injection pool을 늘리지 않고 episode 전용 FTS 후보를 50까지 조회했다.
- 모든 distinctive identifier와 lexical clue 4개 이상이 일치한 prompt만 strong-aligned로 승격해 same-turn answer가 lexical distractor보다 우선하도록 했다. plausible counterfactual은 anchor coverage가 0이라 이 경로를 통과하지 않는다.
- 최종 concurrency=1/4 gate는 overall 99.5%, positive hit 99.33%, top-1 98%, no-match 100%, hard hit 99.23%, hard top-1 97.69%, unexpected injection/error 0, `storeImmutable=true`다.
- 남은 noisy L0 1건은 동일 identifier를 공유하는 FTS prompt 후보가 50개 이상인 모호성 사례로 유지했다. case-specific 예외나 무제한 후보 확장은 적용하지 않았다.
- 전체 회귀는 159 test files/938 tests, typecheck, lint(0 errors/41 existing warnings), architecture(222 files), golden replay(no-match 1/forbidden 0/failed 0), privacy(0 findings), build를 통과했고 Skill validator와 dataset schema JSON 검증도 통과했다.
- `claude-memory-layer@1.0.57`을 npm `latest`로 publish했다. registry의 integrity/shasum 조회와 `--prefer-online` clean temp install에서 package version과 CLI bin entry를 재검증했다.
