# Progressive Disclosure Context

> **Version**: 1.0.0
> **Created**: 2026-02-01

## 1. 배경

### 1.1 claude-mem의 접근 방식

claude-mem은 토큰 효율성을 위해 3-Layer Progressive Disclosure 패턴을 사용:

```
Layer 1: Search Index (~50-100 tokens per result)
    ↓ (필터링)
Layer 2: Timeline (~200 tokens)
    ↓ (선택)
Layer 3: Full Details (~500-1000 tokens per result)
```

**주요 특징**:
- "필터링 후 상세 조회" 전략
- 약 10배 토큰 절약
- 사용자/AI가 필요한 것만 확장

**구현 방식**:
- MCP 도구로 각 레이어 노출
- `search` → `timeline` → `get_observations` 순서
- `__IMPORTANT` 도구로 워크플로우 문서화

### 1.2 현재 code-memory의 상황

현재 검색은 단일 레이어:

```typescript
// 현재 Retriever.search()
async search(query: string): Promise<SearchResult[]> {
  const vectorResults = await this.vectorStore.search(query, { topK: 5 });
  const events = await this.enrichWithEvents(vectorResults);
  return events;  // 전체 내용 반환
}
```

**문제점**:
1. 모든 결과의 전체 내용을 가져옴
2. 컨텍스트 크기가 토큰 제한에 쉽게 도달
3. 관련성 낮은 내용도 포함됨

### 1.3 토큰 비용 분석

| 시나리오 | 현재 방식 | Progressive 방식 |
|----------|----------|-----------------|
| 5개 결과, 1개만 관련 | ~5,000 tokens | ~600 tokens |
| 10개 결과, 2개만 관련 | ~10,000 tokens | ~1,200 tokens |
| 20개 결과, 3개만 관련 | ~20,000 tokens | ~2,000 tokens |

**절약 효과**: 평균 80-90% 토큰 감소

## 2. MCP 도구 설계 참고

### 2.1 claude-mem의 MCP 도구

```typescript
// claude-mem MCP tools (추정)
{
  tools: [
    {
      name: 'search',
      description: 'Search memories, returns index only',
      input_schema: {
        query: 'string',
        filters: { type: 'string', date: 'string' }
      },
      output: 'SearchIndexItem[]'
    },
    {
      name: 'timeline',
      description: 'Get timeline context around observations',
      input_schema: {
        observation_ids: 'string[]',
        window_size: 'number'
      },
      output: 'TimelineItem[]'
    },
    {
      name: 'get_observations',
      description: 'Get full observation details by IDs',
      input_schema: {
        ids: 'string[]'
      },
      output: 'Observation[]'
    },
    {
      name: '__IMPORTANT',
      description: 'Workflow documentation for Claude',
      // Claude가 이 도구를 보고 검색 워크플로우를 이해
    }
  ]
}
```

### 2.2 워크플로우 문서화

```markdown
# Memory Search Workflow

1. **Always start with `search`** to get compact index
2. **Review scores** before expanding
3. **Use `timeline`** if context is needed
4. **Only call `get_observations`** for selected IDs
5. **Never** fetch all details at once
```

## 3. 기존 코드와의 관계

### 3.1 retriever.ts

현재 Retriever 구조:

```typescript
export class Retriever {
  async search(query: string): Promise<SearchResult[]> {
    // 1. 벡터 검색
    const vectorResults = await this.vectorStore.search(query);

    // 2. 이벤트 enrichment (전체 로드)
    const enriched = await Promise.all(
      vectorResults.map(async (r) => {
        const event = await this.eventStore.findById(r.id);
        return { ...r, content: event.payload.content };  // 전체 내용
      })
    );

    return enriched;
  }
}
```

**수정 방향**:
- `search()` → `searchIndex()` (Layer 1)
- `getTimeline()` 추가 (Layer 2)
- `getDetails()` 추가 (Layer 3)
- `smartSearch()` 추가 (자동 확장)

### 3.2 matcher.ts

현재 Matcher는 confidence 기반 분류:

```typescript
export function matchSearchResults(results: SearchResult[]): MatchResult {
  const high = results.filter(r => r.score >= 0.92);
  const suggested = results.filter(r => r.score >= 0.75 && r.score < 0.92);

  return { high, suggested, none: [] };
}
```

**확장 방향**:
- 기존 Matcher 로직을 확장 규칙에 통합
- `high` → 자동 확장 대상
- `suggested` → Layer 1만 표시

### 3.3 vector-store.ts

현재 VectorStore 검색:

```typescript
async search(query: string, options: { topK: number }): Promise<VectorSearchResult[]> {
  const queryVector = await this.embedder.embed(query);
  return this.db.search(queryVector, options.topK);
}
```

**변경 불필요** - 기존 벡터 검색 그대로 사용

### 3.4 event-store.ts

필요한 추가 메서드:

```typescript
// 주변 이벤트 조회 (타임라인용)
async findSurrounding(
  sessionId: string,
  timestamp: Date,
  windowSize: number
): Promise<Event[]> {
  return this.db.query(`
    SELECT * FROM events
    WHERE session_id = ?
      AND timestamp BETWEEN
        datetime(?, '-${windowSize} hours') AND
        datetime(?, '+${windowSize} hours')
    ORDER BY timestamp
  `, [sessionId, timestamp, timestamp]);
}
```

## 4. 설계 결정 사항

### 4.1 왜 3개 레이어인가?

**대안 1: 2개 레이어 (Index + Detail)**
- 단점: 시간 맥락 파악 어려움
- 단점: 모호한 결과 처리 어려움

**대안 2: 4개 이상 레이어**
- 단점: 복잡도 증가
- 단점: 실용적 이점 미미

**선택: 3개 레이어**
- Layer 1: What (무엇이 있는지)
- Layer 2: When (언제 발생했는지)
- Layer 3: How (구체적으로 어떻게)

### 4.2 자동 확장 vs 수동 확장

**자동 확장 장점**:
- 사용자 경험 향상
- "자세히 알려줘" 명령 불필요
- 높은 신뢰도 결과 즉시 제공

**자동 확장 단점**:
- 토큰 예측 어려움
- 때로는 불필요한 확장

**결론: 하이브리드 접근**
- 높은 신뢰도 → 자동 확장
- 중간 신뢰도 → Index만 제공 + 힌트
- 낮은 신뢰도 → Index만 제공

### 4.3 요약 생성 전략

**Option 1: LLM 요약**
- 장점: 고품질 요약
- 단점: 비용, 지연시간

**Option 2: 규칙 기반 추출**
- 장점: 빠름, 무료
- 단점: 품질 제한

**선택: 규칙 기반 + 캐싱**
- 첫 문장 추출
- 코드 블록 축약
- 결과 캐싱

### 4.4 토큰 추정 방식

```typescript
// 간단한 추정 (정확도 ~85%)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// 또는 정확한 추정 (tiktoken 사용)
import { encoding_for_model } from 'tiktoken';
const enc = encoding_for_model('gpt-4');
function estimateTokens(text: string): number {
  return enc.encode(text).length;
}
```

**결론**: 간단한 추정 사용 (성능 우선)

## 5. 성능 고려사항

### 5.1 검색 지연시간

| 레이어 | 목표 지연시간 | 병목 |
|--------|-------------|------|
| Layer 1 | < 100ms | 벡터 검색 |
| Layer 2 | < 200ms | DB 쿼리 |
| Layer 3 | < 500ms | 다중 조회 |

**최적화 전략**:
- Layer 1: 벡터 인덱스 최적화
- Layer 2: 세션별 인덱스 활용
- Layer 3: 배치 조회

### 5.2 캐싱 전략

```typescript
// 레이어별 캐시 TTL
const CACHE_CONFIG = {
  layer1: {
    ttl: 60 * 1000,      // 1분 (검색 결과는 자주 변함)
    maxSize: 100
  },
  layer2: {
    ttl: 5 * 60 * 1000,  // 5분 (타임라인은 안정적)
    maxSize: 500
  },
  layer3: {
    ttl: 30 * 60 * 1000, // 30분 (상세 내용은 거의 안 변함)
    maxSize: 200
  }
};
```

### 5.3 메모리 사용

- Layer 1 캐시: ~10KB per entry × 100 = ~1MB
- Layer 2 캐시: ~2KB per entry × 500 = ~1MB
- Layer 3 캐시: ~10KB per entry × 200 = ~2MB
- **총 메모리**: ~4MB (허용 범위)

## 6. UI/UX 고려사항

### 6.1 CLI 출력 포맷

```
🔍 Search Results (5 matches)

#1 [mem_abc] DuckDB 스키마 설계 논의 (0.94)
#2 [mem_def] 타입 시스템 리팩토링 (0.87)
#3 [mem_ghi] 벡터 저장소 설정 (0.82)

💡 Tip: Use "show mem_abc" for details

---

📅 Timeline (auto-expanded for high confidence)

14:00 → User asked about schema design
14:05 → **[mem_abc]** Discussed DuckDB approach
14:15 → Follow-up on indexing
```

### 6.2 확장 힌트

```typescript
function formatExpansionHint(result: ProgressiveSearchResult): string {
  if (result.meta.expandedCount === 0) {
    return `Use "show [id]" to see details`;
  }
  if (result.meta.expansionReason === 'ambiguous_multiple_high') {
    return `Multiple matches found. Use "show [id]" for specific details`;
  }
  return '';
}
```

## 7. 참고 자료

- **claude-mem README**: Progressive disclosure pattern, MCP tools
- **OpenAI Cookbook**: Token counting and optimization
- **AXIOMMIND**: Principle 7 (Standard JSON) - 포맷 일관성
- **기존 specs**: retriever.ts, matcher.ts 구현
