# Evidence Aligner V2 Specification

> **Version**: 2.0.0
> **Status**: Draft
> **Created**: 2026-01-31

## 1. 개요

### 1.1 문제 정의

현재 시스템에서 LLM이 evidence의 spanStart/spanEnd를 직접 계산하는 방식의 문제:

1. **부정확한 오프셋**: LLM이 문자 위치를 정확히 계산하기 어려움
2. **환각 가능성**: 원문에 없는 내용을 증거로 제시할 수 있음
3. **검증 불가**: LLM이 준 오프셋이 실제 원문과 일치하는지 확인 어려움

### 1.2 해결 방향

**Quote-only 방식**:
- LLM은 **quote(인용문)**만 제공
- Pipeline(EvidenceAligner)이 원문에서 정확한 span 계산
- 매칭 실패 시 `evidenceAligned=false`로 표시 → Verified 승격 금지

## 2. 핵심 개념

### 2.1 Evidence 흐름

```
LLM Extractor                    EvidenceAligner               Database
     │                                  │                          │
     │  { quote: "JSONB 제거" }         │                          │
     ├─────────────────────────────────▶│                          │
     │                                  │  원문에서 검색            │
     │                                  │  ─────────────           │
     │                                  │                          │
     │  { spanStart: 142,               │                          │
     │    spanEnd: 150,                 │                          │
     │    confidence: 1.0 }             │                          │
     │◀─────────────────────────────────┤                          │
     │                                  │                          │
     │                                  │  evidence_aligned 이벤트  │
     │                                  ├─────────────────────────▶│
```

### 2.2 Extractor 출력 스키마 변경

**기존 (금지)**:
```json
{
  "evidence": [{
    "messageIndex": 3,
    "spanStart": 142,
    "spanEnd": 150
  }]
}
```

**신규 (권장)**:
```json
{
  "evidence": [{
    "messageIndex": 3,
    "quote": "content JSONB → JSON"
  }]
}
```

### 2.3 정렬 알고리즘

```typescript
interface AlignmentStep {
  method: 'exact' | 'normalized' | 'fuzzy';
  description: string;
}

const ALIGNMENT_STEPS: AlignmentStep[] = [
  { method: 'exact', description: '정확한 substring 매칭' },
  { method: 'normalized', description: '공백/개행 정규화 후 매칭' },
  { method: 'fuzzy', description: 'Levenshtein 거리 기반 유사 매칭 (threshold: 0.85)' }
];
```

## 3. 입출력 스키마

### 3.1 입력

```typescript
interface AlignInput {
  sessionMessages: string[];      // 원문 메시지 배열
  extractedJson: ExtractedData;   // LLM 추출 결과
}

interface ExtractedEvidence {
  messageIndex: number;
  quote: string;                  // 30~200자 권장
}
```

### 3.2 출력

```typescript
interface AlignedEvidence {
  messageIndex: number;
  quote: string;
  quoteHash: string;              // SHA256(quote)
  spanStart: number;              // 원문 내 시작 위치
  spanEnd: number;                // 원문 내 끝 위치
  confidence: number;             // 0.0 ~ 1.0
  matchMethod: 'exact' | 'normalized' | 'fuzzy' | 'none';
}

interface AlignResult {
  evidenceAligned: boolean;       // 모든 evidence가 정렬됨
  alignedEvidence: AlignedEvidence[];
  failedQuotes: string[];         // 정렬 실패한 quote 목록
}
```

## 4. 정렬 로직 상세

### 4.1 Exact Match

```typescript
function exactMatch(quote: string, source: string): AlignedSpan | null {
  const index = source.indexOf(quote);
  if (index === -1) return null;

  return {
    spanStart: index,
    spanEnd: index + quote.length,
    confidence: 1.0,
    matchMethod: 'exact'
  };
}
```

### 4.2 Normalized Match

```typescript
function normalizedMatch(quote: string, source: string): AlignedSpan | null {
  const normalizedQuote = normalize(quote);
  const normalizedSource = normalize(source);

  const index = normalizedSource.indexOf(normalizedQuote);
  if (index === -1) return null;

  // 원본 source에서 실제 위치 역추적 필요
  const originalSpan = mapToOriginal(source, normalizedSource, index, normalizedQuote.length);

  return {
    ...originalSpan,
    confidence: 0.95,
    matchMethod: 'normalized'
  };
}

function normalize(text: string): string {
  return text
    .replace(/\s+/g, ' ')     // 연속 공백 → 단일 공백
    .replace(/\n+/g, ' ')     // 개행 → 공백
    .trim()
    .toLowerCase();
}
```

### 4.3 Fuzzy Match

```typescript
function fuzzyMatch(
  quote: string,
  source: string,
  threshold: number = 0.85
): AlignedSpan | null {
  const normalizedQuote = normalize(quote);
  const windowSize = Math.ceil(normalizedQuote.length * 1.2);

  let bestMatch: { start: number; end: number; score: number } | null = null;

  // 슬라이딩 윈도우로 유사도 검사
  for (let i = 0; i <= source.length - windowSize; i++) {
    const window = normalize(source.slice(i, i + windowSize));
    const score = levenshteinSimilarity(normalizedQuote, window);

    if (score >= threshold && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { start: i, end: i + windowSize, score };
    }
  }

  if (!bestMatch) return null;

  return {
    spanStart: bestMatch.start,
    spanEnd: bestMatch.end,
    confidence: bestMatch.score,
    matchMethod: 'fuzzy'
  };
}
```

## 5. 이벤트 스키마

### 5.1 evidence_aligned 이벤트

```typescript
interface EvidenceAlignedEvent {
  event_type: 'evidence_aligned';
  session_id: string;
  payload: {
    source_event_id: string;        // session_ingested event
    extraction_event_id: string;    // memory_extracted event
    entry_id: string;
    aligned_count: number;
    failed_count: number;
    evidence: AlignedEvidence[];
    failed_quotes: string[];
  };
}
```

## 6. Idris2 영감 적용

### 6.1 증거 기반 타입 (Proof-Carrying)

**Idris2 개념**:
```idris
-- 타입이 증거를 포함
data EvidencedFact : Type where
  MkFact : (claim : String) -> (proof : Span) -> EvidencedFact
```

**TypeScript 적용**:
```typescript
// Discriminated Union으로 증거 유무 구분
type Evidence =
  | { aligned: true; span: AlignedSpan }
  | { aligned: false; failureReason: string };

// 증거가 있는 entry만 Verified로 승격 가능
type VerifiedEntry = {
  evidence: Extract<Evidence, { aligned: true }>[];  // 모든 evidence가 aligned
};
```

### 6.2 불변식

```typescript
// Zod로 불변식 검증
const AlignedEvidenceSchema = z.object({
  confidence: z.number().min(0).max(1),
  matchMethod: z.enum(['exact', 'normalized', 'fuzzy']),
  // fuzzy면 confidence < 1.0
}).refine(
  (e) => e.matchMethod !== 'exact' || e.confidence === 1.0,
  { message: 'Exact match must have confidence 1.0' }
);
```

## 7. 승격 정책

### 7.1 Evidence 기반 승격 조건

| Stage | Evidence 요구사항 |
|-------|------------------|
| raw → working | 없음 |
| working → candidate | 없음 |
| candidate → verified | **evidenceAligned=true** 필수 |
| verified → certified | 추가 검증 필요 |

### 7.2 실패 처리

```typescript
async function processEntry(entry: Entry): Promise<void> {
  const alignResult = await aligner.align(sessionMessages, entry.evidence);

  if (!alignResult.evidenceAligned) {
    // Verified 승격 금지
    entry.meta.promotionBlocked = true;
    entry.meta.promotionBlockReason = 'Evidence alignment failed';
    entry.meta.failedQuotes = alignResult.failedQuotes;
  }
}
```

## 8. 기존 EvidenceAligner와 차이점

### 8.1 현재 구현 (src/core/evidence-aligner.ts)

```typescript
// 현재: quote 기반 정렬 지원
align(claims: string[], sourceContent: string): AlignmentResult {
  // exact match만 지원
  const exactSpan = this.findExactMatch(claim, sourceContent);
}
```

### 8.2 V2 개선사항

| 항목 | 현재 | V2 |
|------|-----|-----|
| 정규화 매칭 | 없음 | 공백/개행 정규화 |
| Fuzzy 매칭 | 없음 | Levenshtein 기반 (threshold 0.85) |
| 이벤트 기록 | 없음 | evidence_aligned 이벤트 발행 |
| 승격 연동 | 없음 | evidenceAligned → Verified 조건 |
| 메시지 인덱스 | 없음 | messageIndex 기반 정확한 소스 식별 |

## 9. 성공 기준

- [ ] LLM Extractor가 quote만 출력하도록 프롬프트 수정
- [ ] EvidenceAligner가 3단계 정렬 (exact → normalized → fuzzy) 수행
- [ ] 정렬 결과가 evidence_aligned 이벤트로 기록됨
- [ ] evidenceAligned=false인 entry는 Verified 승격 불가
- [ ] 기존 evidence-aligner.ts와 호환 유지
