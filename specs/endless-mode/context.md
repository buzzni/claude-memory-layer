# Endless Mode Context

> **Version**: 1.0.0
> **Created**: 2026-02-01

## 1. 배경

### 1.1 claude-mem의 접근 방식

claude-mem은 "Endless Mode"를 Beta 기능으로 제공:

```
Biomimetic Memory Architecture for extended sessions
```

**특징**:
- 세션 경계 없는 연속 메모리
- 자동 컨텍스트 통합
- 장기 학습 지원

### 1.2 인간 기억 시스템 모방

```
Human Memory:
┌─────────────────────────────────────────┐
│ Sensory → Working → Long-term          │
│ (즉각)    (단기)    (장기)              │
└─────────────────────────────────────────┘

Endless Mode:
┌─────────────────────────────────────────┐
│ Events → Working Set → Consolidated    │
│ (L0)     (Active)      (Integrated)    │
└─────────────────────────────────────────┘
```

### 1.3 현재 code-memory의 세션 모델

```typescript
// 현재 세션 기반 모델
session_start → [conversations] → session_end
                                      ↓
                              session_summary
                                      ↓
                            (새 세션에서 검색)
```

**한계**:
1. 세션 경계에서 컨텍스트 단절
2. 재시작 시 처음부터 컨텍스트 구축
3. 장기 프로젝트에서 지식 파편화

## 2. Biomimetic Memory 개념

### 2.1 Working Memory (작업 기억)

인간의 작업 기억:
- 용량 제한: 7±2 항목
- 지속 시간: 15-30초
- 적극적 유지 필요

Endless Mode 적용:
```typescript
const workingSet = {
  maxEvents: 100,           // 용량 제한
  timeWindowHours: 24,      // 시간 제한
  activeRehearsal: true     // 관련성 높은 것 유지
};
```

### 2.2 Memory Consolidation (기억 통합)

인간의 기억 통합:
- 수면 중 발생
- 관련 기억 연결
- 불필요한 세부사항 제거
- 패턴 추출

Endless Mode 적용:
```typescript
const consolidation = {
  triggerIdleTime: 30 * 60 * 1000,  // 유휴 시 통합 (수면 유사)
  groupByTopic: true,                // 관련 기억 그룹화
  summarize: true,                   // 세부사항 요약
  extractPatterns: true              // 패턴 추출
};
```

### 2.3 Context-Dependent Memory

인간: 특정 맥락에서 관련 기억 활성화

Endless Mode:
```typescript
// 현재 컨텍스트와 유사한 과거 컨텍스트 활성화
const relevantContext = await findSimilarContext(currentQuery);
```

## 3. 기존 코드와의 관계

### 3.1 Graduation 파이프라인과의 관계

```
기존 Graduation:
L0 (Raw) → L1 (Structured) → L2 (Validated) → L3 (Verified) → L4 (Active)

Endless Mode 추가:
L0 (Raw) → Working Set → Consolidated Memory
              ↓              ↓
           (Active)     (Long-term)
```

**통합 방안**:
- Working Set은 L0-L2 이벤트 포함
- Consolidated Memory는 L3-L4 수준의 검증된 지식

### 3.2 Event Store

```typescript
// 기존: 세션 기반 저장
await eventStore.append({
  sessionId: currentSession,
  ...event
});

// Endless Mode: 세션 개념 유연화
await eventStore.append({
  sessionId: endlessSessionId,  // 고정 또는 날짜 기반
  workingSetId: currentWorkingSet,
  ...event
});
```

### 3.3 Retriever

```typescript
// 기존
async search(query): Promise<Event[]>

// Endless Mode 확장
async searchWithContext(query, options): Promise<{
  workingSet: Event[];
  consolidated: ConsolidatedMemory[];
  continuityScore: number;
}>
```

## 4. 설계 결정 사항

### 4.1 세션 ID 처리

**옵션 1: 고정 세션 ID**
```typescript
const ENDLESS_SESSION_ID = 'endless';
```
- 단순함
- 기존 코드 호환

**옵션 2: 날짜 기반 세션 ID**
```typescript
const sessionId = `endless_${format(new Date(), 'yyyy-MM-dd')}`;
```
- 일별 구분 가능
- 통계/분석 용이

**선택**: 하이브리드
- Endless Mode 내부: 날짜 기반
- 외부 인터페이스: 'endless'로 통합

### 4.2 통합 트리거

**옵션 1: 시간 기반만**
```typescript
setInterval(consolidate, 1 * 60 * 60 * 1000);  // 1시간마다
```

**옵션 2: 이벤트 수 기반만**
```typescript
if (workingSet.length >= 100) consolidate();
```

**옵션 3: 하이브리드 (선택)**
```typescript
// 세 가지 조건 중 하나라도 충족 시
if (
  timeSinceLastConsolidation >= 1 * 60 * 60 * 1000 ||
  workingSet.length >= 100 ||
  idleTime >= 30 * 60 * 1000
) {
  consolidate();
}
```

### 4.3 요약 생성

**옵션 1: 규칙 기반만**
```typescript
// 키포인트 추출
const summary = events
  .map(e => extractKeyPoint(e))
  .join('\n');
```
- 빠름, 무료
- 품질 제한

**옵션 2: LLM 기반**
```typescript
const summary = await llm.summarize(events);
```
- 고품질
- 비용, 지연

**선택**: 규칙 기반 기본, LLM 옵션
```typescript
if (config.useLLMSummarization) {
  return await llmSummarize(events);
} else {
  return extractKeyPoints(events);
}
```

### 4.4 연속성 점수 가중치

```typescript
const weights = {
  topicOverlap: 0.3,     // 주제 연속성
  timeProximity: 0.3,    // 시간 근접성
  fileOverlap: 0.2,      // 파일 연속성
  entityOverlap: 0.2     // 엔티티 연속성
};
```

**조정 필요 시**:
- 코드 작업 중심: fileOverlap 가중치 증가
- 연구/학습 중심: topicOverlap 가중치 증가

## 5. 성능 고려사항

### 5.1 Working Set 크기

```typescript
// 메모리 사용량 추정
// 100 이벤트 × 평균 2KB = 200KB
const maxWorkingSetSize = 100;
```

### 5.2 Consolidation 비용

```typescript
// 통합 작업 시간 추정
// 100 이벤트 그룹화 + 요약: ~100ms
// LLM 요약 사용 시: ~2s
```

### 5.3 검색 성능

```typescript
// Working Set 검색: O(n), n=100, ~1ms
// Consolidated 검색: 벡터 검색, ~50ms
```

## 6. 마이그레이션

### 6.1 Session → Endless

```typescript
async function migrateToEndless(): Promise<void> {
  // 1. 최근 세션 이벤트를 Working Set에 추가
  const recentEvents = await getRecentEvents(7 * 24);  // 7일

  for (const event of recentEvents) {
    await workingSetStore.add(event);
  }

  // 2. 기존 세션 요약을 Consolidated Memory로 이전
  const summaries = await getSessionSummaries();

  for (const summary of summaries) {
    await consolidatedStore.create({
      summary: summary.content,
      sourceEvents: [],  // 원본 연결 불가
      confidence: 0.6    // 낮은 신뢰도
    });
  }
}
```

### 6.2 Endless → Session 복귀

```typescript
async function revertToSession(): Promise<void> {
  // 모드만 변경, 데이터 유지
  await setConfig('mode', 'session');

  // Working Set과 Consolidated Memory는 유지
  // (향후 Endless Mode 재활성화 시 활용)
}
```

## 7. 참고 자료

- **claude-mem Beta**: Endless Mode, Biomimetic Memory Architecture
- **Cognitive Psychology**: Working Memory (Baddeley), Memory Consolidation
- **Spaced Repetition**: 장기 기억 강화 기법
- **기존 specs**: graduation.ts, vector-worker.ts
