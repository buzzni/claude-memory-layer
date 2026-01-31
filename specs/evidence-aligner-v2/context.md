# Evidence Aligner V2 Context

> **Version**: 2.0.0
> **Created**: 2026-01-31

## 1. 배경

### 1.1 LLM 오프셋 계산의 문제

LLM에게 텍스트 내 정확한 문자 위치(spanStart/spanEnd)를 계산하도록 요청하면:

```json
// LLM 출력 (문제 있음)
{
  "quote": "JSONB 제거",
  "spanStart": 142,
  "spanEnd": 150
}
```

**실제 문제**:
1. LLM은 토큰 기반으로 동작하여 문자 단위 계산이 부정확
2. 멀티바이트 문자(한글 등)에서 오프셋 계산 오류 빈번
3. 원문을 보지 않고 추측하는 경우 발생

### 1.2 Quote-only 방식의 장점

```json
// LLM 출력 (개선)
{
  "messageIndex": 3,
  "quote": "DuckDB의 JSONB를 JSON으로 변경"
}
```

**장점**:
1. LLM은 인용만 담당 (잘하는 것)
2. 정확한 위치 계산은 시스템이 담당
3. 검증 가능: quote가 원문에 없으면 즉시 탐지

## 2. Memo.txt 참고 사항

### 2.1 핵심 원칙 (섹션 2.4)

> **4. EvidenceSpan은 파이프라인이 확정**
> - LLM에게 spanStart/spanEnd 요구 금지
> - LLM은 quote만 제공 → aligner가 원문에서 찾아 span을 계산

### 2.2 Extractor 출력 스키마 (섹션 6.1)

```json
{
  "entries":[
    {
      "entryId":"ent_...",
      "type":"fact",
      "title":"DuckDB JSONB 제거",
      "evidence":[{"messageIndex":3,"quote":"content JSONB → JSON"}]
    }
  ]
}
```

### 2.3 정렬 알고리즘 (섹션 6.2)

1. **exact substring match**
2. **normalize(공백/개행 collapse) 후 fuzzy match (최소 0.85 이상)** — optional
3. 실패 시 `evidenceAligned=false`로 표시하고, 해당 엔트리는 **Verified 승격 금지**

## 3. Idris2 영감 적용

### 3.1 Proof-Carrying Data

**Idris2 개념**:
```idris
-- 주장과 증거가 타입 수준에서 연결
data ProvenClaim : Type where
  MkClaim : (claim : String) ->
            (evidence : Span) ->
            (proof : InSource evidence) ->  -- 증거가 원문에 있다는 증명
            ProvenClaim
```

**TypeScript 적용**:
```typescript
// 정렬 성공한 증거만 특정 타입으로
type AlignedEvidence = {
  quote: string;
  span: { start: number; end: number };
  matchMethod: 'exact' | 'normalized' | 'fuzzy';
  confidence: number;  // matchMethod에 따라 범위 제한
};

// 정렬 실패는 별도 타입
type FailedEvidence = {
  quote: string;
  failureReason: 'not_found' | 'below_threshold' | 'ambiguous';
};

// Union으로 구분
type Evidence = AlignedEvidence | FailedEvidence;
```

### 3.2 Confidence 불변식

```typescript
// Zod refinement로 불변식 검증
const AlignedEvidenceSchema = z.object({
  matchMethod: z.enum(['exact', 'normalized', 'fuzzy']),
  confidence: z.number()
}).refine(data => {
  switch (data.matchMethod) {
    case 'exact':
      return data.confidence === 1.0;
    case 'normalized':
      return data.confidence >= 0.95 && data.confidence < 1.0;
    case 'fuzzy':
      return data.confidence >= 0.85 && data.confidence < 0.95;
  }
}, { message: 'Confidence must match method' });
```

## 4. 기존 코드와의 관계

### 4.1 현재 evidence-aligner.ts

```typescript
// 현재 구현 (src/core/evidence-aligner.ts)
export class EvidenceAligner {
  align(claims: string[], sourceContent: string): AlignmentResult {
    for (const claim of claims) {
      const exactSpan = this.findExactMatch(claim, sourceContent);
      if (exactSpan) {
        spans.push(exactSpan);
        continue;
      }
      missingClaims.push(claim);
    }
  }

  private findExactMatch(claim: string, source: string): EvidenceSpan | null {
    const index = source.indexOf(claim);
    if (index === -1) return null;
    return { start: index, end: index + claim.length, ... };
  }
}
```

### 4.2 V2 확장 포인트

| 기존 | V2 확장 |
|-----|---------|
| claims: string[] | extractedJson with messageIndex |
| sourceContent: string | sessionMessages: string[] |
| exactMatch only | exact → normalized → fuzzy fallback |
| 반환: spans + missingClaims | 반환: AlignResult with details |

### 4.3 하위 호환성

```typescript
// 기존 API 유지
class EvidenceAlignerV2 extends EvidenceAligner {
  // 기존 메서드 오버라이드
  align(claims: string[], sourceContent: string): AlignmentResult {
    // V2 로직으로 처리 후 기존 형식으로 변환
    const v2Result = this.alignV2([sourceContent], {
      evidence: claims.map((c, i) => ({ quote: c, messageIndex: 0 }))
    });
    return this.convertToV1Result(v2Result);
  }

  // 새 API
  alignV2(sessionMessages: string[], extractedJson: ExtractedData): AlignResult;
}
```

## 5. 정규화 전략

### 5.1 공백 정규화

```typescript
function normalizeWhitespace(text: string): string {
  return text
    .replace(/[\t\r]/g, ' ')      // 탭, CR → 공백
    .replace(/\n+/g, ' ')          // 개행 → 공백
    .replace(/ +/g, ' ')           // 연속 공백 → 단일 공백
    .trim();
}
```

### 5.2 위치 역추적 문제

정규화 후 매칭 시, 원본 위치를 찾아야 함:

```typescript
// 원본: "Hello   World\n\nTest"
// 정규화: "Hello World Test"
// 매칭: "World Test" at 6-16 (정규화)
// 역추적: 원본에서 "World\n\nTest" 찾기

function mapToOriginal(
  original: string,
  normalized: string,
  normalizedStart: number,
  normalizedEnd: number
): { start: number; end: number } {
  // 각 문자 위치 매핑 테이블 생성
  const posMap = buildPositionMap(original, normalized);
  return {
    start: posMap.normalizedToOriginal.get(normalizedStart)!,
    end: posMap.normalizedToOriginal.get(normalizedEnd - 1)! + 1
  };
}
```

### 5.3 유니코드 고려

```typescript
// 한글, 이모지 등 멀티바이트 문자 처리
function normalizeUnicode(text: string): string {
  return text
    .normalize('NFKC')             // 유니코드 정규화
    .replace(/\p{Zs}/gu, ' ')      // 모든 공백 문자 → 일반 공백
    .replace(/\p{Cf}/gu, '');      // 보이지 않는 포맷 문자 제거
}
```

## 6. Fuzzy Matching 전략

### 6.1 Levenshtein 거리

```typescript
function levenshteinDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // 삭제
        dp[i][j - 1] + 1,      // 삽입
        dp[i - 1][j - 1] + cost // 대체
      );
    }
  }
  return dp[m][n];
}

function similarity(a: string, b: string): number {
  const dist = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  return 1 - dist / maxLen;
}
```

### 6.2 슬라이딩 윈도우 최적화

```typescript
function findBestMatch(
  quote: string,
  source: string,
  threshold: number
): { start: number; end: number; score: number } | null {
  const quoteLen = quote.length;
  const windowSizes = [quoteLen, quoteLen * 1.1, quoteLen * 1.2];  // 다양한 윈도우

  let best: { start: number; end: number; score: number } | null = null;

  for (const windowSize of windowSizes) {
    const size = Math.ceil(windowSize);
    for (let i = 0; i <= source.length - size; i++) {
      const window = source.slice(i, i + size);
      const score = similarity(quote, window);

      if (score >= threshold && (!best || score > best.score)) {
        best = { start: i, end: i + size, score };
      }
    }
  }

  return best;
}
```

## 7. 에러 케이스 처리

### 7.1 messageIndex 범위 초과

```typescript
function validateEvidence(evidence: ExtractedEvidence, messageCount: number): ValidationResult {
  if (evidence.messageIndex >= messageCount) {
    return {
      valid: false,
      error: `messageIndex ${evidence.messageIndex} out of range (max: ${messageCount - 1})`
    };
  }
  return { valid: true };
}
```

### 7.2 빈 quote

```typescript
if (!evidence.quote || evidence.quote.trim().length === 0) {
  return {
    aligned: false,
    failureReason: 'empty_quote'
  };
}
```

### 7.3 애매한 매칭 (여러 위치에서 발견)

```typescript
function handleAmbiguousMatch(
  quote: string,
  source: string
): AlignResult {
  const matches = findAllMatches(quote, source);

  if (matches.length > 1) {
    // 첫 번째 매칭 사용, 단 애매함 표시
    return {
      ...matches[0],
      meta: { ambiguous: true, alternativeCount: matches.length - 1 }
    };
  }
  return matches[0];
}
```

## 8. 성능 고려사항

### 8.1 캐싱

```typescript
// 정규화 결과 캐싱 (동일 소스 반복 사용 시)
const normalizeCache = new Map<string, { normalized: string; posMap: PositionMap }>();

function getCachedNormalized(source: string): { normalized: string; posMap: PositionMap } {
  if (!normalizeCache.has(source)) {
    const normalized = normalize(source);
    const posMap = buildPositionMap(source, normalized);
    normalizeCache.set(source, { normalized, posMap });
  }
  return normalizeCache.get(source)!;
}
```

### 8.2 조기 종료

```typescript
// Exact match 성공 시 fuzzy 시도 안 함
function align(quote: string, source: string): AlignedSpan | null {
  // Step 1: Exact (가장 빠름)
  const exact = exactMatch(quote, source);
  if (exact) return exact;

  // Step 2: Normalized (중간)
  const normalized = normalizedMatch(quote, source);
  if (normalized) return normalized;

  // Step 3: Fuzzy (가장 느림, 필요할 때만)
  return fuzzyMatch(quote, source, 0.85);
}
```

### 8.3 긴 텍스트 처리

```typescript
// 매우 긴 소스의 경우 분할 처리
const CHUNK_SIZE = 10000;

function alignLongSource(quote: string, source: string): AlignedSpan | null {
  if (source.length <= CHUNK_SIZE) {
    return align(quote, source);
  }

  // 청크 단위로 검색 (오버랩 적용)
  const overlap = quote.length * 2;
  for (let i = 0; i < source.length; i += CHUNK_SIZE - overlap) {
    const chunk = source.slice(i, i + CHUNK_SIZE);
    const result = align(quote, chunk);
    if (result) {
      return { ...result, start: result.start + i, end: result.end + i };
    }
  }
  return null;
}
```

## 9. 참고 자료

- **Memo.txt**: 섹션 6 - Evidence Align 구현 지시
- **현재 구현**: `src/core/evidence-aligner.ts`
- **타입 정의**: `src/core/types.ts` - EvidenceSpan
- **AXIOMMIND**: Principle 4 - 증거 범위 확정
