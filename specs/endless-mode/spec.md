# Endless Mode Specification

> **Version**: 1.0.0
> **Status**: Draft
> **Created**: 2026-02-01
> **Reference**: claude-mem (thedotmack/claude-mem)

## 1. 개요

### 1.1 문제 정의

현재 세션 기반 메모리의 한계:

1. **세션 경계**: 세션이 끝나면 컨텍스트 단절
2. **재시작 비용**: 새 세션마다 컨텍스트 재구성 필요
3. **연속성 부족**: 장기 프로젝트에서 연속적 학습 어려움

### 1.2 해결 방향

**Endless Mode (연속 세션)**:
- 세션 경계 없는 연속적 메모리 스트림
- Biomimetic Memory Architecture (생체 모방 기억 구조)
- 자동 컨텍스트 연속성 유지

## 2. 핵심 개념

### 2.1 Biomimetic Memory Architecture

인간 기억 시스템에서 영감:

```
┌─────────────────────────────────────────────────────────────┐
│                  Human Memory Model                          │
├─────────────────────────────────────────────────────────────┤
│  Sensory Memory → Working Memory → Long-term Memory         │
│  (즉각적)          (단기)            (장기)                   │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                  Endless Mode Memory                         │
├─────────────────────────────────────────────────────────────┤
│  Event Stream → Active Context → Consolidated Memory        │
│  (L0 Events)    (Working Set)    (L4 Memories)              │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 세션 vs Endless

| 기존 세션 모드 | Endless Mode |
|---------------|-------------|
| 명확한 시작/끝 | 연속적 스트림 |
| 세션별 요약 | 점진적 통합 |
| 재시작 시 빈 상태 | 이전 컨텍스트 유지 |
| session_end 훅 | 백그라운드 통합 |

### 2.3 모드 전환

```typescript
enum MemoryMode {
  SESSION = 'session',     // 기존 세션 기반
  ENDLESS = 'endless'      // 연속 모드
}
```

## 3. 아키텍처

### 3.1 레이어 구조

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 0: Event Stream (Raw)                                 │
│  - 모든 이벤트 즉시 기록                                      │
│  - 변환/필터 없음                                             │
│  - TTL: 무제한                                               │
└──────────────────────────────────────────┬──────────────────┘
                                           │
                                     (Background)
                                           │
┌──────────────────────────────────────────▼──────────────────┐
│  Layer 1: Working Set (Active Context)                       │
│  - 최근 N개 이벤트                                           │
│  - 현재 작업 관련 메모리                                      │
│  - TTL: 24시간 (sliding)                                     │
└──────────────────────────────────────────┬──────────────────┘
                                           │
                                     (Consolidation)
                                           │
┌──────────────────────────────────────────▼──────────────────┐
│  Layer 2: Consolidated Memory (Long-term)                    │
│  - 통합/요약된 지식                                          │
│  - 패턴 및 인사이트                                          │
│  - TTL: 무제한                                               │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Working Set 관리

```typescript
interface WorkingSet {
  // 최근 이벤트
  recentEvents: Event[];          // 최근 100개
  recentTimeWindow: number;       // 최근 24시간

  // 활성 컨텍스트
  activeTopics: Topic[];          // 현재 다루는 주제
  activeFiles: string[];          // 최근 접근 파일
  activeEntities: Entity[];       // 관련 엔티티

  // 메타데이터
  lastActivity: Date;
  continuityScore: number;        // 연속성 점수
}
```

### 3.3 Consolidation Process

```typescript
interface ConsolidationConfig {
  // 트리거 조건
  triggerInterval: number;        // 1시간마다
  triggerEventCount: number;      // 100개 이벤트마다
  triggerIdleTime: number;        // 30분 유휴 후

  // 통합 규칙
  minEventsToConsolidate: number; // 최소 10개
  maxConsolidatedSize: number;    // 최대 1000자 요약
  preserveHighConfidence: boolean;// 고신뢰도 원본 유지
}
```

## 4. 컨텍스트 연속성

### 4.1 연속성 점수

```typescript
function calculateContinuityScore(
  currentContext: Context,
  previousContext: Context
): number {
  let score = 0;

  // 주제 연속성
  const topicOverlap = intersection(
    currentContext.topics,
    previousContext.topics
  ).length;
  score += topicOverlap * 0.3;

  // 파일 연속성
  const fileOverlap = intersection(
    currentContext.files,
    previousContext.files
  ).length;
  score += fileOverlap * 0.2;

  // 시간 근접성
  const timeDiff = currentContext.timestamp - previousContext.timestamp;
  const timeScore = Math.exp(-timeDiff / (24 * 60 * 60 * 1000));
  score += timeScore * 0.3;

  // 엔티티 연속성
  const entityOverlap = intersection(
    currentContext.entities,
    previousContext.entities
  ).length;
  score += entityOverlap * 0.2;

  return Math.min(score, 1.0);
}
```

### 4.2 컨텍스트 주입

```typescript
async function injectEndlessContext(
  currentPrompt: string
): Promise<string> {
  const workingSet = await getWorkingSet();

  // 연속성 점수 기반 컨텍스트 선택
  const relevantContext = workingSet.recentEvents
    .filter(e => e.relevanceScore >= 0.7)
    .slice(0, 10);

  // 통합된 메모리에서 관련 항목
  const consolidatedContext = await searchConsolidatedMemory(
    currentPrompt,
    { topK: 3 }
  );

  return formatEndlessContext({
    workingSet: relevantContext,
    consolidated: consolidatedContext,
    continuityScore: workingSet.continuityScore
  });
}
```

## 5. 통합 (Consolidation) 프로세스

### 5.1 자동 통합

```typescript
class ConsolidationWorker {
  private running = false;

  async start(): Promise<void> {
    this.running = true;

    while (this.running) {
      await this.checkAndConsolidate();
      await sleep(this.config.triggerInterval);
    }
  }

  private async checkAndConsolidate(): Promise<void> {
    const workingSet = await getWorkingSet();

    // 트리거 조건 확인
    if (this.shouldConsolidate(workingSet)) {
      await this.consolidate(workingSet);
    }
  }

  private shouldConsolidate(workingSet: WorkingSet): boolean {
    // 이벤트 수 기준
    if (workingSet.recentEvents.length >= this.config.triggerEventCount) {
      return true;
    }

    // 유휴 시간 기준
    const idleTime = Date.now() - workingSet.lastActivity.getTime();
    if (idleTime >= this.config.triggerIdleTime) {
      return true;
    }

    return false;
  }

  private async consolidate(workingSet: WorkingSet): Promise<void> {
    // 1. 관련 이벤트 그룹화
    const groups = groupByTopic(workingSet.recentEvents);

    // 2. 각 그룹 요약
    for (const group of groups) {
      const summary = await summarizeGroup(group);

      // 3. 통합 메모리에 저장
      await storeConsolidatedMemory({
        summary,
        sourceEvents: group.map(e => e.eventId),
        topics: group.topics,
        confidence: calculateGroupConfidence(group)
      });
    }

    // 4. Working Set 정리
    await pruneWorkingSet(workingSet);
  }
}
```

### 5.2 요약 생성

```typescript
async function summarizeGroup(events: Event[]): Promise<string> {
  // 옵션 1: 로컬 규칙 기반
  if (events.length < 5) {
    return extractKeyPoints(events);
  }

  // 옵션 2: LLM 기반 (비용 발생)
  if (config.useLLMSummarization) {
    return await llmSummarize(events);
  }

  // 옵션 3: 하이브리드
  const keyPoints = extractKeyPoints(events);
  return formatSummary(keyPoints);
}
```

## 6. 데이터 스키마

### 6.1 Working Set 테이블

```sql
CREATE TABLE working_set (
  id VARCHAR PRIMARY KEY,
  event_id VARCHAR NOT NULL REFERENCES events(event_id),
  added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  relevance_score FLOAT,
  topics JSON,
  expires_at TIMESTAMP
);

CREATE INDEX idx_working_set_expires ON working_set(expires_at);
CREATE INDEX idx_working_set_relevance ON working_set(relevance_score DESC);
```

### 6.2 Consolidated Memory 테이블

```sql
CREATE TABLE consolidated_memories (
  memory_id VARCHAR PRIMARY KEY,
  summary TEXT NOT NULL,
  topics JSON,
  source_events JSON,         -- 원본 이벤트 ID 목록
  confidence FLOAT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  accessed_at TIMESTAMP,
  access_count INTEGER DEFAULT 0
);

CREATE INDEX idx_consolidated_confidence ON consolidated_memories(confidence DESC);
```

### 6.3 Continuity Log 테이블

```sql
CREATE TABLE continuity_log (
  log_id VARCHAR PRIMARY KEY,
  from_context_id VARCHAR,
  to_context_id VARCHAR,
  continuity_score FLOAT,
  transition_type VARCHAR,    -- 'seamless' | 'topic_shift' | 'break'
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## 7. 설정

### 7.1 Endless Mode 설정

```typescript
const EndlessModeConfigSchema = z.object({
  enabled: z.boolean().default(false),

  workingSet: z.object({
    maxEvents: z.number().default(100),
    timeWindowHours: z.number().default(24),
    minRelevanceScore: z.number().default(0.5)
  }),

  consolidation: z.object({
    triggerIntervalMs: z.number().default(3600000),  // 1시간
    triggerEventCount: z.number().default(100),
    triggerIdleMs: z.number().default(1800000),      // 30분
    useLLMSummarization: z.boolean().default(false)
  }),

  continuity: z.object({
    minScoreForSeamless: z.number().default(0.7),
    topicDecayHours: z.number().default(48)
  })
});
```

### 7.2 모드 전환

```bash
# Endless Mode 활성화
$ code-memory config set mode endless

# Session Mode로 복귀
$ code-memory config set mode session

# 현재 모드 확인
$ code-memory config get mode
```

## 8. UI 표시

### 8.1 CLI 상태

```
$ code-memory status

Mode: Endless
Working Set: 47 events (last 18 hours)
Continuity Score: 0.85 (seamless)
Consolidated: 23 memories
Last Consolidation: 2 hours ago

Active Topics:
  - DuckDB schema design
  - Event sourcing pattern
  - TypeScript types

Recent Files:
  - src/core/event-store.ts
  - src/core/types.ts
```

### 8.2 Web Viewer

```
┌─────────────────────────────────────────────────────────────┐
│  Endless Mode Dashboard                                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────┐  ┌─────────────────┐                   │
│  │ Continuity      │  │ Working Set     │                   │
│  │    0.85         │  │    47 events    │                   │
│  │  ████████░░     │  │    18 hours     │                   │
│  │  Seamless       │  └─────────────────┘                   │
│  └─────────────────┘                                         │
│                                                              │
│  Timeline (Continuous)                                       │
│  ──────────────────────────────────────────────────────────│
│  │    │    │    │    │    │    │    │    │    │    │      │
│  └────┴────┴────┴────┴────┴────┴────┴────┴────┴────┘      │
│  -24h                    -12h                     now       │
│                                                              │
│  Consolidated Memories (23)                                  │
│  ─────────────────────────────────────────────────────────  │
│  📝 DuckDB 스키마 설계 결정 (confidence: 0.92)               │
│  📝 이벤트 소싱 패턴 구현 (confidence: 0.88)                 │
│  📝 타입 시스템 리팩토링 (confidence: 0.85)                  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## 9. 마이그레이션

### 9.1 Session → Endless 전환

```typescript
async function migrateToEndless(): Promise<void> {
  // 1. 기존 세션 데이터 유지
  // 2. Working Set 초기화
  const recentSessions = await getRecentSessions(7);  // 최근 7일

  for (const session of recentSessions) {
    const events = await getSessionEvents(session.id);
    await addToWorkingSet(events);
  }

  // 3. 초기 통합 실행
  await runInitialConsolidation();

  // 4. 모드 변경
  await setConfig('mode', 'endless');
}
```

## 10. 성공 기준

- [ ] Endless Mode 활성화/비활성화 전환 가능
- [ ] Working Set이 24시간 슬라이딩 윈도우로 유지
- [ ] 자동 Consolidation이 백그라운드에서 실행
- [ ] 연속성 점수가 정확히 계산됨
- [ ] 세션 재시작 시 이전 컨텍스트 자동 로드
- [ ] Web Viewer에서 Endless Mode 대시보드 표시
- [ ] 기존 Session Mode와 호환 유지
