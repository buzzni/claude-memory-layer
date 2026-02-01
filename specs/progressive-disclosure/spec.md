# Progressive Disclosure Specification

> **Version**: 1.0.0
> **Status**: Draft
> **Created**: 2026-02-01
> **Reference**: claude-mem (thedotmack/claude-mem)

## 1. 개요

### 1.1 문제 정의

현재 시스템에서 메모리 검색 시 토큰 비효율 발생:

1. **전체 로드 문제**: 검색 결과를 한 번에 모든 내용을 가져옴
2. **토큰 낭비**: 관련 없는 내용도 컨텍스트에 포함
3. **컨텍스트 한계**: 대용량 메모리 사용 시 토큰 초과

### 1.2 해결 방향

**3-Layer Progressive Disclosure**:
- Layer 1: 검색 인덱스 (ID + 요약) - 최소 토큰
- Layer 2: 타임라인 컨텍스트 - 시간순 맥락
- Layer 3: 상세 정보 - 선택된 항목만 전체 로드

## 2. 핵심 개념

### 2.1 3-Layer 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│                    User Query                                │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: Search Index (~50-100 tokens per result)          │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ { id: "mem_1", summary: "파일 구조 설명", score: 0.95 } │  │
│  │ { id: "mem_2", summary: "타입 정의 논의", score: 0.87 } │  │
│  │ { id: "mem_3", summary: "버그 수정 방법", score: 0.82 } │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                    (선택적 확장)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: Timeline Context (~200 tokens)                    │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 2026-01-30 14:00: "파일 구조 변경 결정"                 │  │
│  │ 2026-01-30 14:15: "types.ts 분리" ← mem_1             │  │
│  │ 2026-01-30 14:30: "테스트 작성"                        │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                    (필요 시만)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: Full Details (~500-1000 tokens per result)        │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ mem_1: {                                               │  │
│  │   content: "전체 대화 내용...",                        │  │
│  │   metadata: {...},                                     │  │
│  │   evidence: [...]                                      │  │
│  │ }                                                      │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 토큰 효율성

| 방식 | 5개 결과 토큰 | 20개 결과 토큰 |
|------|--------------|---------------|
| 기존 (전체 로드) | ~5,000 | ~20,000 |
| Progressive L1 | ~500 | ~2,000 |
| Progressive L1+L2 | ~700 | ~2,200 |
| Progressive L1+L2+L3 (2개) | ~1,700 | ~2,200 |

**예상 토큰 절약: ~10배**

### 2.3 확장 트리거

```typescript
type ExpansionTrigger =
  | 'high_confidence'     // score ≥ 0.92 → 자동 L3 확장
  | 'user_request'        // "자세히 알려줘" → L3 확장
  | 'temporal_proximity'  // 시간적 근접 → L2 확장
  | 'explicit_id'         // "mem_1 보여줘" → L3 확장
  | 'ambiguity';          // 여러 유사 결과 → L2 확장
```

## 3. 데이터 스키마

### 3.1 Layer 1: SearchIndex

```typescript
const SearchIndexItemSchema = z.object({
  id: z.string(),                    // 이벤트/메모리 ID
  summary: z.string().max(100),      // 한 줄 요약
  score: z.number(),                 // 유사도 점수
  type: z.enum(['prompt', 'response', 'tool', 'insight']),
  timestamp: z.date(),
  sessionId: z.string()
});

type SearchIndexItem = z.infer<typeof SearchIndexItemSchema>;

// 반환 예시
{
  id: "evt_abc123",
  summary: "DuckDB 스키마 설계 논의",
  score: 0.94,
  type: "response",
  timestamp: "2026-01-30T14:00:00Z",
  sessionId: "session_xyz"
}
```

### 3.2 Layer 2: TimelineContext

```typescript
const TimelineItemSchema = z.object({
  id: z.string(),
  timestamp: z.date(),
  type: z.enum(['prompt', 'response', 'tool', 'insight']),
  preview: z.string().max(200),      // 2-3문장 미리보기
  isTarget: z.boolean()              // 검색 결과에 해당하는지
});

type TimelineItem = z.infer<typeof TimelineItemSchema>;

// 반환 예시 (target ID 주변 ±3개)
[
  { id: "evt_1", preview: "이전 대화...", isTarget: false },
  { id: "evt_2", preview: "관련 질문...", isTarget: false },
  { id: "evt_abc123", preview: "DuckDB 스키마...", isTarget: true },  // 타겟
  { id: "evt_3", preview: "후속 논의...", isTarget: false }
]
```

### 3.3 Layer 3: FullDetail

```typescript
const FullDetailSchema = z.object({
  id: z.string(),
  content: z.string(),               // 전체 내용
  type: z.enum(['prompt', 'response', 'tool', 'insight']),
  timestamp: z.date(),
  sessionId: z.string(),

  // 메타데이터
  metadata: z.object({
    tokenCount: z.number(),
    hasCode: z.boolean(),
    files: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional()
  }),

  // 관계 정보
  relations: z.object({
    parentId: z.string().optional(),
    childIds: z.array(z.string()),
    relatedIds: z.array(z.string())
  }).optional()
});

type FullDetail = z.infer<typeof FullDetailSchema>;
```

## 4. API 인터페이스

### 4.1 ProgressiveRetriever

```typescript
interface ProgressiveRetriever {
  // Layer 1: 검색 인덱스 반환
  searchIndex(
    query: string,
    options?: {
      topK?: number;
      filter?: SearchFilter;
    }
  ): Promise<SearchIndexItem[]>;

  // Layer 2: 타임라인 컨텍스트 반환
  getTimeline(
    targetIds: string[],
    options?: {
      windowSize?: number;  // 앞뒤로 몇 개씩
    }
  ): Promise<TimelineItem[]>;

  // Layer 3: 상세 정보 반환
  getDetails(ids: string[]): Promise<FullDetail[]>;

  // 편의 메서드: 자동 확장
  smartSearch(
    query: string,
    options?: SmartSearchOptions
  ): Promise<ProgressiveSearchResult>;
}
```

### 4.2 SmartSearch 옵션

```typescript
interface SmartSearchOptions {
  // Layer 1 설정
  topK: number;                       // 기본: 10
  minScore: number;                   // 기본: 0.7

  // 자동 확장 설정
  autoExpandTimeline: boolean;        // 기본: true (score gap 클 때)
  autoExpandDetails: boolean;         // 기본: true (score ≥ 0.92)
  maxAutoExpandCount: number;         // 기본: 3

  // 토큰 제한
  maxTotalTokens: number;             // 기본: 2000
}
```

### 4.3 ProgressiveSearchResult

```typescript
interface ProgressiveSearchResult {
  // Layer 1 (항상 포함)
  index: SearchIndexItem[];

  // Layer 2 (선택적)
  timeline?: TimelineItem[];

  // Layer 3 (선택적)
  details?: FullDetail[];

  // 메타정보
  meta: {
    totalMatches: number;
    expandedCount: number;
    estimatedTokens: number;
    expansionReason?: string;
  };
}
```

## 5. 확장 규칙

### 5.1 자동 확장 조건

```typescript
function shouldAutoExpand(results: SearchIndexItem[]): ExpansionDecision {
  // Rule 1: 높은 신뢰도 단일 결과
  if (results[0]?.score >= 0.92 && results.length === 1) {
    return { expand: true, ids: [results[0].id], reason: 'high_confidence' };
  }

  // Rule 2: 명확한 1등 (2등과 gap이 큼)
  if (results.length >= 2) {
    const gap = results[0].score - results[1].score;
    if (results[0].score >= 0.85 && gap >= 0.1) {
      return { expand: true, ids: [results[0].id], reason: 'clear_winner' };
    }
  }

  // Rule 3: 모호한 결과 → 타임라인만 확장
  if (results.length >= 3 && results[2].score >= 0.8) {
    return {
      expand: true,
      expandTimeline: true,
      expandDetails: false,
      ids: results.slice(0, 3).map(r => r.id),
      reason: 'ambiguous_results'
    };
  }

  // Rule 4: 낮은 점수 → 확장 안 함
  return { expand: false, reason: 'low_confidence' };
}
```

### 5.2 토큰 예산 관리

```typescript
function expandWithinBudget(
  index: SearchIndexItem[],
  budget: number
): ProgressiveSearchResult {
  let usedTokens = estimateTokens(index);  // ~50-100 per item
  const result: ProgressiveSearchResult = { index, meta: { ... } };

  // 예산 내에서 확장
  const sortedByScore = [...index].sort((a, b) => b.score - a.score);

  for (const item of sortedByScore) {
    if (usedTokens >= budget) break;

    // 타임라인 추가 (~200 tokens)
    if (usedTokens + 200 <= budget && !result.timeline) {
      result.timeline = await getTimeline([item.id]);
      usedTokens += estimateTokens(result.timeline);
    }

    // 상세 추가 (~500-1000 tokens)
    if (item.score >= 0.85 && usedTokens + 800 <= budget) {
      const detail = await getDetails([item.id]);
      result.details = [...(result.details || []), ...detail];
      usedTokens += estimateTokens(detail);
    }
  }

  result.meta.estimatedTokens = usedTokens;
  return result;
}
```

## 6. 컨텍스트 포맷

### 6.1 Layer 1 포맷 (최소)

```markdown
## Related Memories (5 matches)

| ID | Summary | Score |
|----|---------|-------|
| mem_1 | DuckDB 스키마 설계 논의 | 0.94 |
| mem_2 | 타입 시스템 리팩토링 | 0.87 |
| mem_3 | 벡터 저장소 설정 | 0.82 |
| mem_4 | 테스트 코드 작성 | 0.78 |
| mem_5 | CI/CD 파이프라인 | 0.75 |

*Use "show mem_1" for details*
```

### 6.2 Layer 2 포맷 (타임라인)

```markdown
## Related Memories with Timeline

### Context around mem_1 (2026-01-30)

14:00 - User: "DB 스키마를 어떻게 설계할까?"
14:05 - **[mem_1]** Assistant: "DuckDB를 사용하여 이벤트 소싱 패턴..."
14:15 - User: "인덱스는 어떻게?"
14:20 - Assistant: "다음 인덱스들을 추천..."
```

### 6.3 Layer 3 포맷 (상세)

```markdown
## Memory Detail: mem_1

**Session**: session_xyz | **Date**: 2026-01-30 14:05

### Content
DuckDB를 사용하여 이벤트 소싱 패턴을 구현하는 방법을 설명드립니다.

1. events 테이블 생성:
\`\`\`sql
CREATE TABLE events (
  event_id VARCHAR PRIMARY KEY,
  ...
);
\`\`\`

2. 인덱스 설계:
- event_type별 인덱스
- session_id별 인덱스
...

**Related Files**: src/core/event-store.ts, src/core/types.ts
**Tools Used**: Read, Write
```

## 7. 캐싱 전략

### 7.1 Layer별 캐싱

```typescript
interface CacheConfig {
  layer1: {
    ttl: 60 * 1000,        // 1분 (검색 결과)
    maxSize: 100           // 최근 100개 쿼리
  };
  layer2: {
    ttl: 5 * 60 * 1000,    // 5분 (타임라인)
    maxSize: 500
  };
  layer3: {
    ttl: 30 * 60 * 1000,   // 30분 (상세 정보)
    maxSize: 200
  };
}
```

### 7.2 캐시 키

```typescript
function getCacheKey(layer: number, params: unknown): string {
  switch (layer) {
    case 1:
      return `l1:${hash(params.query)}:${params.topK}`;
    case 2:
      return `l2:${params.targetIds.sort().join(',')}`;
    case 3:
      return `l3:${params.id}`;
  }
}
```

## 8. 성공 기준

- [ ] Layer 1 검색이 100ms 이내 반환
- [ ] Layer 2 타임라인이 200ms 이내 반환
- [ ] Layer 3 상세가 500ms 이내 반환
- [ ] 평균 토큰 사용량이 기존 대비 50% 이상 감소
- [ ] 자동 확장이 적절한 경우에만 동작
- [ ] 토큰 예산 내에서 최적의 결과 제공
