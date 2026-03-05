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
