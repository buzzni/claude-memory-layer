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
