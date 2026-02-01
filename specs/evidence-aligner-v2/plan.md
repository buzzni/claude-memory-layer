# Evidence Aligner V2 Implementation Plan

> **Version**: 2.0.0
> **Status**: Draft
> **Created**: 2026-01-31

## Phase 1: Extractor 수정 (P0)

### 1.1 프롬프트 변경

**작업 항목**:
- [ ] LLM 프롬프트에서 spanStart/spanEnd 요구 제거
- [ ] quote 필드 필수로 변경
- [ ] quote 길이 가이드라인 추가 (30~200자)

**프롬프트 예시**:
```
각 entry에 대해 evidence를 제공하세요.
- messageIndex: 증거가 있는 메시지 인덱스 (0-based)
- quote: 원문에서 발췌한 텍스트 (30~200자)

중요: spanStart/spanEnd는 제공하지 마세요. 시스템이 자동으로 계산합니다.
```

### 1.2 파서 수정

**파일**: `src/core/extractor.ts` (가정)

**작업 항목**:
- [ ] 출력 스키마에서 spanStart/spanEnd 제거
- [ ] quote 필수 검증 추가
- [ ] messageIndex 범위 검증

## Phase 2: Aligner 핵심 구현 (P0)

### 2.1 타입 정의

**파일**: `src/core/types.ts` 수정

```typescript
// 추가할 타입들
export const AlignMethodSchema = z.enum(['exact', 'normalized', 'fuzzy', 'none']);

export const AlignedEvidenceSchema = z.object({
  messageIndex: z.number().int().nonnegative(),
  quote: z.string(),
  quoteHash: z.string(),
  spanStart: z.number().int().nonnegative(),
  spanEnd: z.number().int().positive(),
  confidence: z.number().min(0).max(1),
  matchMethod: AlignMethodSchema
});
```

**작업 항목**:
- [ ] AlignMethod 타입 추가
- [ ] AlignedEvidence 스키마 추가
- [ ] AlignResult 스키마 추가
- [ ] EvidenceAlignedEvent 타입 추가

### 2.2 Aligner 클래스 확장

**파일**: `src/core/evidence-aligner.ts` 수정

```typescript
export class EvidenceAlignerV2 {
  constructor(private config: AlignerConfig);

  // 메인 정렬 함수
  async align(
    sessionMessages: string[],
    extractedJson: ExtractedData
  ): Promise<AlignResult>;

  // 단계별 매칭
  private exactMatch(quote: string, source: string): AlignedSpan | null;
  private normalizedMatch(quote: string, source: string): AlignedSpan | null;
  private fuzzyMatch(quote: string, source: string, threshold: number): AlignedSpan | null;

  // 헬퍼
  private normalize(text: string): string;
  private levenshteinSimilarity(a: string, b: string): number;
  private mapToOriginal(source: string, normalized: string, start: number, length: number): Span;
}
```

**작업 항목**:
- [ ] exactMatch 메서드 구현
- [ ] normalize 함수 구현
- [ ] normalizedMatch 메서드 구현 (위치 역추적 포함)
- [ ] levenshteinSimilarity 함수 구현
- [ ] fuzzyMatch 메서드 구현 (슬라이딩 윈도우)
- [ ] align 메인 함수 구현 (3단계 폴백)

### 2.3 설정

```typescript
interface AlignerConfig {
  fuzzyThreshold: number;        // default: 0.85
  maxQuoteLength: number;        // default: 500
  enableFuzzy: boolean;          // default: true
}
```

## Phase 3: 이벤트 연동 (P0)

### 3.1 이벤트 발행

**파일**: `src/core/event-store.ts` 수정

**작업 항목**:
- [ ] 'evidence_aligned' 이벤트 타입 추가
- [ ] payload 스키마 정의

### 3.2 Orchestrator 연동

**파일**: 파이프라인 연동 (graduation.ts 또는 신규)

```typescript
async function processSession(session: Session): Promise<void> {
  // 1. session_ingested 이벤트
  const ingestEvent = await eventStore.append({ eventType: 'session_ingested', ... });

  // 2. LLM 추출
  const extracted = await extractor.extract(session);
  await eventStore.append({ eventType: 'memory_extracted', ... });

  // 3. Evidence 정렬 (V2)
  const alignResult = await aligner.align(session.messages, extracted);
  await eventStore.append({
    eventType: 'evidence_aligned',
    content: JSON.stringify({
      source_event_id: ingestEvent.eventId,
      aligned_count: alignResult.alignedEvidence.length,
      failed_count: alignResult.failedQuotes.length,
      evidence: alignResult.alignedEvidence,
      failed_quotes: alignResult.failedQuotes
    })
  });

  // 4. Entry 저장 (alignResult 반영)
  for (const entry of extracted.entries) {
    const entryEvidence = alignResult.alignedEvidence.filter(
      e => e.entryId === entry.entryId
    );
    entry.evidenceAligned = entryEvidence.every(e => e.matchMethod !== 'none');
    // ...
  }
}
```

**작업 항목**:
- [ ] process_session 흐름에 aligner 삽입
- [ ] evidence_aligned 이벤트 발행
- [ ] entry에 evidenceAligned 플래그 설정

## Phase 4: 승격 정책 적용 (P0)

### 4.1 Graduation 조건 수정

**파일**: `src/core/graduation.ts` 수정

```typescript
async function promoteToVerified(entry: Entry): Promise<PromotionResult> {
  // Evidence 정렬 확인
  if (!entry.evidenceAligned) {
    return {
      success: false,
      reason: 'Evidence alignment failed. Cannot promote to Verified.'
    };
  }

  // 기타 조건 확인...
}
```

**작업 항목**:
- [ ] candidate → verified 승격 조건에 evidenceAligned 추가
- [ ] 실패 시 명확한 reason 제공

### 4.2 메타데이터 기록

**작업 항목**:
- [ ] entry.meta.promotionBlocked 플래그
- [ ] entry.meta.promotionBlockReason 기록
- [ ] entry.meta.failedQuotes 저장 (디버깅용)

## Phase 5: 유틸리티 및 테스트 (P1)

### 5.1 Levenshtein 구현

**파일**: `src/core/string-utils.ts` (신규)

```typescript
export function levenshteinDistance(a: string, b: string): number;
export function levenshteinSimilarity(a: string, b: string): number;
export function findBestFuzzyMatch(
  needle: string,
  haystack: string,
  threshold: number
): { start: number; end: number; score: number } | null;
```

**작업 항목**:
- [ ] Levenshtein 거리 함수
- [ ] 유사도 함수 (1 - distance / max_length)
- [ ] 슬라이딩 윈도우 최적 매칭

### 5.2 위치 역추적

```typescript
// 정규화된 문자열에서 원본 문자열 위치 매핑
interface PositionMap {
  normalizedToOriginal: Map<number, number>;
  originalToNormalized: Map<number, number>;
}

export function createPositionMap(original: string, normalized: string): PositionMap;
export function mapSpanToOriginal(map: PositionMap, normalizedSpan: Span): Span;
```

**작업 항목**:
- [ ] 위치 매핑 생성 함수
- [ ] span 역추적 함수

## 파일 목록

### 수정 파일
```
src/core/types.ts              # 타입 추가
src/core/evidence-aligner.ts   # V2 로직 추가
src/core/graduation.ts         # 승격 조건 수정
src/core/event-store.ts        # 이벤트 타입 추가
```

### 신규 파일
```
src/core/string-utils.ts       # 문자열 유틸리티
```

## 테스트

### 필수 테스트 케이스

1. **Exact Match**
   ```typescript
   // quote가 원문에 정확히 존재
   const source = "DuckDB의 JSONB를 JSON으로 변경";
   const quote = "JSONB를 JSON으로";
   expect(aligner.exactMatch(quote, source)).toEqual({
     spanStart: 7,
     spanEnd: 18,
     confidence: 1.0,
     matchMethod: 'exact'
   });
   ```

2. **Normalized Match**
   ```typescript
   // 공백 차이만 있는 경우
   const source = "JSONB를   JSON으로\n변경";
   const quote = "JSONB를 JSON으로 변경";
   expect(aligner.normalizedMatch(quote, source)).not.toBeNull();
   ```

3. **Fuzzy Match**
   ```typescript
   // 약간의 오타/변형
   const source = "DuckDB에서 JSONB 타입을 제거";
   const quote = "DuckDB JSONB 타입 제거";  // 조사 누락
   const result = aligner.fuzzyMatch(quote, source, 0.85);
   expect(result?.confidence).toBeGreaterThanOrEqual(0.85);
   ```

4. **No Match**
   ```typescript
   // 원문에 없는 내용
   const source = "벡터 검색을 구현합니다";
   const quote = "JSONB를 제거";
   expect(aligner.align([source], { evidence: [{ quote }] })).toEqual({
     evidenceAligned: false,
     failedQuotes: ["JSONB를 제거"]
   });
   ```

5. **승격 거부**
   ```typescript
   const entry = { evidenceAligned: false, stage: 'candidate' };
   const result = await graduation.promoteToVerified(entry);
   expect(result.success).toBe(false);
   expect(result.reason).toContain('Evidence alignment failed');
   ```

## 마일스톤

| 단계 | 완료 기준 |
|------|----------|
| M1 | 타입 정의 완료 |
| M2 | exactMatch + normalizedMatch 동작 |
| M3 | fuzzyMatch 동작 (Levenshtein) |
| M4 | evidence_aligned 이벤트 발행 |
| M5 | Graduation 승격 조건 적용 |
| M6 | 테스트 통과 |
