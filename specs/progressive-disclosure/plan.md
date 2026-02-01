# Progressive Disclosure Implementation Plan

> **Version**: 1.0.0
> **Status**: Draft
> **Created**: 2026-02-01

## Phase 1: 타입 및 인터페이스 정의 (P0)

### 1.1 스키마 정의

**파일**: `src/core/types.ts` 수정

```typescript
// Layer 1: 검색 인덱스
export const SearchIndexItemSchema = z.object({
  id: z.string(),
  summary: z.string().max(100),
  score: z.number(),
  type: z.enum(['prompt', 'response', 'tool', 'insight']),
  timestamp: z.date(),
  sessionId: z.string()
});

// Layer 2: 타임라인
export const TimelineItemSchema = z.object({
  id: z.string(),
  timestamp: z.date(),
  type: z.enum(['prompt', 'response', 'tool', 'insight']),
  preview: z.string().max(200),
  isTarget: z.boolean()
});

// Layer 3: 상세
export const FullDetailSchema = z.object({
  id: z.string(),
  content: z.string(),
  type: z.enum(['prompt', 'response', 'tool', 'insight']),
  timestamp: z.date(),
  sessionId: z.string(),
  metadata: z.object({
    tokenCount: z.number(),
    hasCode: z.boolean(),
    files: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional()
  }),
  relations: z.object({
    parentId: z.string().optional(),
    childIds: z.array(z.string()),
    relatedIds: z.array(z.string())
  }).optional()
});
```

**작업 항목**:
- [ ] SearchIndexItemSchema 추가
- [ ] TimelineItemSchema 추가
- [ ] FullDetailSchema 추가
- [ ] ProgressiveSearchResultSchema 추가

### 1.2 설정 스키마 확장

**파일**: `src/core/types.ts` 수정

```typescript
export const ProgressiveDisclosureConfigSchema = z.object({
  enabled: z.boolean().default(true),
  layer1: z.object({
    topK: z.number().default(10),
    minScore: z.number().default(0.7)
  }),
  autoExpand: z.object({
    enabled: z.boolean().default(true),
    highConfidenceThreshold: z.number().default(0.92),
    scoreGapThreshold: z.number().default(0.1),
    maxAutoExpandCount: z.number().default(3)
  }),
  tokenBudget: z.object({
    maxTotalTokens: z.number().default(2000),
    layer1PerItem: z.number().default(50),
    layer2PerItem: z.number().default(40),
    layer3PerItem: z.number().default(500)
  }),
  cache: z.object({
    layer1Ttl: z.number().default(60000),
    layer2Ttl: z.number().default(300000),
    layer3Ttl: z.number().default(1800000)
  })
});
```

**작업 항목**:
- [ ] ProgressiveDisclosureConfigSchema 추가
- [ ] ConfigSchema에 progressiveDisclosure 필드 추가

## Phase 2: ProgressiveRetriever 구현 (P0)

### 2.1 기본 클래스 구조

**파일**: `src/core/progressive-retriever.ts` (신규)

```typescript
export class ProgressiveRetriever {
  constructor(
    private eventStore: EventStore,
    private vectorStore: VectorStore,
    private config: ProgressiveDisclosureConfig
  ) {}

  // Layer 1: 검색 인덱스
  async searchIndex(
    query: string,
    options?: { topK?: number; filter?: SearchFilter }
  ): Promise<SearchIndexItem[]> {
    const { topK = this.config.layer1.topK } = options || {};

    // 벡터 검색
    const vectorResults = await this.vectorStore.search(query, { topK });

    // 요약 생성 및 변환
    return vectorResults.map(r => ({
      id: r.id,
      summary: this.generateSummary(r.content),
      score: r.score,
      type: r.metadata.type,
      timestamp: r.metadata.timestamp,
      sessionId: r.metadata.sessionId
    }));
  }

  // Layer 2: 타임라인
  async getTimeline(
    targetIds: string[],
    options?: { windowSize?: number }
  ): Promise<TimelineItem[]> {
    const { windowSize = 3 } = options || {};

    const items: TimelineItem[] = [];

    for (const targetId of targetIds) {
      const event = await this.eventStore.findById(targetId);
      if (!event) continue;

      // 주변 이벤트 조회
      const surrounding = await this.eventStore.findSurrounding(
        event.sessionId,
        event.timestamp,
        windowSize
      );

      items.push(...surrounding.map(e => ({
        id: e.eventId,
        timestamp: e.timestamp,
        type: e.eventType,
        preview: this.generatePreview(e.payload),
        isTarget: e.eventId === targetId
      })));
    }

    return this.deduplicateTimeline(items);
  }

  // Layer 3: 상세 정보
  async getDetails(ids: string[]): Promise<FullDetail[]> {
    const details: FullDetail[] = [];

    for (const id of ids) {
      const event = await this.eventStore.findById(id);
      if (!event) continue;

      details.push({
        id: event.eventId,
        content: event.payload.content,
        type: event.eventType,
        timestamp: event.timestamp,
        sessionId: event.sessionId,
        metadata: this.extractMetadata(event),
        relations: await this.getRelations(event)
      });
    }

    return details;
  }
}
```

**작업 항목**:
- [ ] searchIndex 메서드 구현
- [ ] getTimeline 메서드 구현
- [ ] getDetails 메서드 구현
- [ ] generateSummary 헬퍼 구현
- [ ] generatePreview 헬퍼 구현

### 2.2 스마트 검색 구현

**파일**: `src/core/progressive-retriever.ts` 계속

```typescript
async smartSearch(
  query: string,
  options?: SmartSearchOptions
): Promise<ProgressiveSearchResult> {
  const config = { ...this.config, ...options };

  // Layer 1: 항상 실행
  const index = await this.searchIndex(query, {
    topK: config.layer1.topK,
    filter: options?.filter
  });

  const result: ProgressiveSearchResult = {
    index,
    meta: {
      totalMatches: index.length,
      expandedCount: 0,
      estimatedTokens: this.estimateTokens(index, 'layer1')
    }
  };

  // 자동 확장 결정
  if (config.autoExpand.enabled) {
    const decision = this.shouldAutoExpand(index, config);

    if (decision.expandTimeline && decision.ids) {
      result.timeline = await this.getTimeline(decision.ids);
      result.meta.estimatedTokens += this.estimateTokens(result.timeline, 'layer2');
    }

    if (decision.expandDetails && decision.ids) {
      // 토큰 예산 체크
      const remainingBudget = config.tokenBudget.maxTotalTokens - result.meta.estimatedTokens;
      const idsToExpand = this.selectWithinBudget(decision.ids, remainingBudget);

      result.details = await this.getDetails(idsToExpand);
      result.meta.expandedCount = idsToExpand.length;
      result.meta.estimatedTokens += this.estimateTokens(result.details, 'layer3');
    }

    result.meta.expansionReason = decision.reason;
  }

  return result;
}
```

**작업 항목**:
- [ ] smartSearch 메서드 구현
- [ ] shouldAutoExpand 로직 구현
- [ ] selectWithinBudget 토큰 예산 관리

### 2.3 확장 규칙 엔진

**파일**: `src/core/expansion-rules.ts` (신규)

```typescript
interface ExpansionDecision {
  expand: boolean;
  expandTimeline?: boolean;
  expandDetails?: boolean;
  ids?: string[];
  reason: string;
}

export function shouldAutoExpand(
  results: SearchIndexItem[],
  config: ProgressiveDisclosureConfig
): ExpansionDecision {
  if (results.length === 0) {
    return { expand: false, reason: 'no_results' };
  }

  const topScore = results[0].score;

  // Rule 1: 높은 신뢰도 단일 결과
  if (topScore >= config.autoExpand.highConfidenceThreshold && results.length === 1) {
    return {
      expand: true,
      expandTimeline: true,
      expandDetails: true,
      ids: [results[0].id],
      reason: 'high_confidence_single'
    };
  }

  // Rule 2: 명확한 1등
  if (results.length >= 2) {
    const gap = results[0].score - results[1].score;
    if (topScore >= 0.85 && gap >= config.autoExpand.scoreGapThreshold) {
      return {
        expand: true,
        expandTimeline: true,
        expandDetails: true,
        ids: [results[0].id],
        reason: 'clear_winner'
      };
    }
  }

  // Rule 3: 모호한 결과 → 타임라인만
  const highScoreCount = results.filter(r => r.score >= 0.8).length;
  if (highScoreCount >= 3) {
    return {
      expand: true,
      expandTimeline: true,
      expandDetails: false,
      ids: results.slice(0, 3).map(r => r.id),
      reason: 'ambiguous_multiple_high'
    };
  }

  // Rule 4: 낮은 점수
  return { expand: false, reason: 'low_confidence' };
}
```

**작업 항목**:
- [ ] 확장 규칙 함수 구현
- [ ] 규칙별 테스트 케이스

## Phase 3: 요약 및 미리보기 생성 (P0)

### 3.1 요약 생성기

**파일**: `src/core/summarizer.ts` (신규)

```typescript
export function generateSummary(content: string, maxLength: number = 100): string {
  // 1. 코드 블록 제거
  const withoutCode = content.replace(/```[\s\S]*?```/g, '[code]');

  // 2. 첫 문장 추출
  const firstSentence = withoutCode.match(/^[^.!?]+[.!?]/)?.[0] || '';

  // 3. 길이 제한
  if (firstSentence.length <= maxLength) {
    return firstSentence.trim();
  }

  // 4. 단어 경계에서 자르기
  return withoutCode.slice(0, maxLength).replace(/\s+\S*$/, '') + '...';
}

export function generatePreview(content: string, maxLength: number = 200): string {
  // 1. 코드 블록 축약
  const withCodeSummary = content.replace(
    /```(\w+)[\s\S]*?```/g,
    (_, lang) => `[${lang} code]`
  );

  // 2. 줄바꿈 정리
  const singleLine = withCodeSummary.replace(/\n+/g, ' ').trim();

  // 3. 길이 제한
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return singleLine.slice(0, maxLength).replace(/\s+\S*$/, '') + '...';
}
```

**작업 항목**:
- [ ] generateSummary 함수 구현
- [ ] generatePreview 함수 구현
- [ ] 코드 블록 처리 로직
- [ ] 특수 문자 처리

### 3.2 토큰 추정기

**파일**: `src/core/token-estimator.ts` (신규)

```typescript
// 간단한 토큰 추정 (GPT tokenizer 근사)
export function estimateTokens(text: string): number {
  // 평균적으로 4자 = 1토큰
  return Math.ceil(text.length / 4);
}

export function estimateLayerTokens(
  items: unknown[],
  layer: 'layer1' | 'layer2' | 'layer3',
  config: ProgressiveDisclosureConfig
): number {
  switch (layer) {
    case 'layer1':
      return items.length * config.tokenBudget.layer1PerItem;
    case 'layer2':
      return items.length * config.tokenBudget.layer2PerItem;
    case 'layer3':
      // Layer 3는 실제 콘텐츠 기반
      return (items as FullDetail[]).reduce(
        (sum, item) => sum + estimateTokens(item.content),
        0
      );
  }
}
```

**작업 항목**:
- [ ] estimateTokens 함수 구현
- [ ] estimateLayerTokens 함수 구현

## Phase 4: 캐싱 (P1)

### 4.1 캐시 매니저

**파일**: `src/core/cache-manager.ts` (신규)

```typescript
import { LRUCache } from 'lru-cache';

export class ProgressiveCache {
  private layer1Cache: LRUCache<string, SearchIndexItem[]>;
  private layer2Cache: LRUCache<string, TimelineItem[]>;
  private layer3Cache: LRUCache<string, FullDetail>;

  constructor(config: ProgressiveDisclosureConfig) {
    this.layer1Cache = new LRUCache({
      max: 100,
      ttl: config.cache.layer1Ttl
    });

    this.layer2Cache = new LRUCache({
      max: 500,
      ttl: config.cache.layer2Ttl
    });

    this.layer3Cache = new LRUCache({
      max: 200,
      ttl: config.cache.layer3Ttl
    });
  }

  // Layer 1 캐시
  getLayer1(query: string, options: SearchOptions): SearchIndexItem[] | undefined {
    const key = this.buildLayer1Key(query, options);
    return this.layer1Cache.get(key);
  }

  setLayer1(query: string, options: SearchOptions, results: SearchIndexItem[]): void {
    const key = this.buildLayer1Key(query, options);
    this.layer1Cache.set(key, results);
  }

  // ... Layer 2, 3 유사 구현
}
```

**작업 항목**:
- [ ] ProgressiveCache 클래스 구현
- [ ] Layer별 캐시 키 생성
- [ ] TTL 및 크기 제한 적용

## Phase 5: 포맷터 (P0)

### 5.1 컨텍스트 포맷터

**파일**: `src/core/context-formatter.ts` (신규)

```typescript
export class ContextFormatter {
  formatProgressiveResult(result: ProgressiveSearchResult): string {
    const parts: string[] = [];

    // Layer 1: 항상 포함
    parts.push(this.formatLayer1(result.index));

    // Layer 2: 타임라인
    if (result.timeline) {
      parts.push(this.formatLayer2(result.timeline));
    }

    // Layer 3: 상세
    if (result.details) {
      parts.push(this.formatLayer3(result.details));
    }

    // 메타 정보
    parts.push(this.formatMeta(result.meta));

    return parts.join('\n\n');
  }

  private formatLayer1(items: SearchIndexItem[]): string {
    const header = `## Related Memories (${items.length} matches)\n`;
    const table = items.map((item, i) =>
      `${i + 1}. [${item.id}] ${item.summary} (score: ${item.score.toFixed(2)})`
    ).join('\n');

    return header + table;
  }

  private formatLayer2(items: TimelineItem[]): string {
    const header = '## Timeline Context\n';
    const timeline = items.map(item => {
      const marker = item.isTarget ? '**→**' : '  ';
      const time = item.timestamp.toLocaleTimeString();
      return `${marker} ${time}: ${item.preview}`;
    }).join('\n');

    return header + timeline;
  }

  private formatLayer3(items: FullDetail[]): string {
    return items.map(item => {
      const header = `## Detail: ${item.id}\n`;
      const meta = `*Session: ${item.sessionId} | ${item.timestamp.toLocaleDateString()}*\n`;
      return header + meta + '\n' + item.content;
    }).join('\n\n---\n\n');
  }
}
```

**작업 항목**:
- [ ] ContextFormatter 클래스 구현
- [ ] Layer별 포맷 함수
- [ ] Markdown 출력 최적화

## Phase 6: 통합 (P0)

### 6.1 Retriever 교체

**파일**: `src/core/retriever.ts` 수정

```typescript
export class Retriever {
  private progressiveRetriever: ProgressiveRetriever;

  constructor(/* ... */) {
    this.progressiveRetriever = new ProgressiveRetriever(
      this.eventStore,
      this.vectorStore,
      config.progressiveDisclosure
    );
  }

  // 기존 메서드를 progressive로 위임
  async search(query: string): Promise<SearchResult[]> {
    if (this.config.progressiveDisclosure?.enabled) {
      const result = await this.progressiveRetriever.smartSearch(query);
      return this.convertToLegacyFormat(result);
    }

    // 기존 로직 유지 (fallback)
    return this.legacySearch(query);
  }

  // 새로운 progressive 검색
  async progressiveSearch(query: string, options?: SmartSearchOptions): Promise<ProgressiveSearchResult> {
    return this.progressiveRetriever.smartSearch(query, options);
  }
}
```

**작업 항목**:
- [ ] Retriever에 progressiveRetriever 통합
- [ ] 기존 API 호환성 유지
- [ ] 새 API 추가

### 6.2 user-prompt-submit 훅 수정

**파일**: `src/hooks/user-prompt-submit.ts` 수정

```typescript
async function handleUserPromptSubmit(input: UserPromptInput): Promise<HookOutput> {
  const memoryService = await MemoryService.getInstance();
  const config = memoryService.getConfig();

  // Progressive 검색 사용
  const searchResult = await memoryService.progressiveSearch(input.prompt, {
    maxTotalTokens: config.retrieval.maxTokens
  });

  // 포맷팅
  const formatter = new ContextFormatter();
  const context = formatter.formatProgressiveResult(searchResult);

  return {
    context,
    meta: {
      matchCount: searchResult.meta.totalMatches,
      expandedCount: searchResult.meta.expandedCount,
      estimatedTokens: searchResult.meta.estimatedTokens
    }
  };
}
```

**작업 항목**:
- [ ] 훅에서 progressive 검색 사용
- [ ] 메타 정보 반환

## 파일 목록

### 신규 파일
```
src/core/progressive-retriever.ts   # 메인 검색 클래스
src/core/expansion-rules.ts         # 확장 규칙 엔진
src/core/summarizer.ts              # 요약/미리보기 생성
src/core/token-estimator.ts         # 토큰 추정
src/core/cache-manager.ts           # 캐시 관리
src/core/context-formatter.ts       # 출력 포맷팅
```

### 수정 파일
```
src/core/types.ts                   # 스키마 추가
src/core/retriever.ts               # Progressive 통합
src/hooks/user-prompt-submit.ts     # 검색 방식 변경
src/services/memory-service.ts      # 서비스 메서드 추가
```

## 테스트

### 필수 테스트 케이스

1. **Layer 1 검색**
   ```typescript
   test('should return index with summaries', async () => {
     const result = await retriever.searchIndex('DuckDB 스키마');
     expect(result[0]).toHaveProperty('summary');
     expect(result[0].summary.length).toBeLessThanOrEqual(100);
   });
   ```

2. **자동 확장 규칙**
   ```typescript
   test('should expand on high confidence', async () => {
     const result = await retriever.smartSearch('unique term');
     expect(result.details).toBeDefined();
     expect(result.meta.expansionReason).toBe('high_confidence_single');
   });
   ```

3. **토큰 예산**
   ```typescript
   test('should respect token budget', async () => {
     const result = await retriever.smartSearch('query', { maxTotalTokens: 500 });
     expect(result.meta.estimatedTokens).toBeLessThanOrEqual(500);
   });
   ```

4. **캐싱**
   ```typescript
   test('should use cache on repeat query', async () => {
     await retriever.searchIndex('test');
     const start = Date.now();
     await retriever.searchIndex('test');
     expect(Date.now() - start).toBeLessThan(10);
   });
   ```

## 마일스톤

| 단계 | 완료 기준 |
|------|----------|
| M1 | 타입 정의 완료 |
| M2 | ProgressiveRetriever 기본 구현 |
| M3 | 확장 규칙 엔진 |
| M4 | 요약/미리보기 생성 |
| M5 | 토큰 예산 관리 |
| M6 | 캐싱 구현 |
| M7 | 포맷터 및 통합 |
| M8 | 테스트 통과 |
