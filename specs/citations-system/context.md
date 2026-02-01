# Citations System Context

> **Version**: 1.0.0
> **Created**: 2026-02-01

## 1. 배경

### 1.1 claude-mem의 접근 방식

claude-mem은 observation에 ID를 부여하여 참조 가능하게 함:

```
[mem:abc123] 에서 참조한 정보입니다.
```

**특징**:
- 모든 observation에 고유 ID
- 검색 결과에 ID 표시
- ID로 원본 조회 가능

### 1.2 현재 code-memory의 상황

현재 이벤트 ID는 존재하지만 인용 시스템 없음:

```typescript
// 현재 검색 결과
{
  eventId: "evt_abc123def456...",  // 긴 UUID
  content: "...",
  score: 0.9
}
```

**문제**:
1. eventId가 너무 길어서 참조하기 불편
2. 컨텍스트에 인용 표시 없음
3. 출처 확인 어려움

### 1.3 인용의 가치

| 인용 없음 | 인용 있음 |
|----------|----------|
| 출처 불명 | 명확한 출처 |
| 검증 불가 | 원본 확인 가능 |
| 맥락 손실 | 전후 관계 파악 |
| 신뢰도 낮음 | 신뢰도 높음 |

## 2. ID 설계

### 2.1 고려사항

| 요소 | 요구사항 |
|------|----------|
| 길이 | 짧고 기억하기 쉬움 |
| 고유성 | 충돌 확률 낮음 |
| 가독성 | 쉽게 읽고 말할 수 있음 |
| 생성 | 빠르고 결정적 |

### 2.2 옵션 비교

| 옵션 | 예시 | 조합 수 | 장점 | 단점 |
|------|------|--------|------|------|
| 4자 base62 | a7Bc | 14.7M | 매우 짧음 | 충돌 위험 |
| **6자 base62** | a7Bc3x | 56.8B | 균형 | - |
| 8자 base62 | a7Bc3xYz | 218T | 충돌 없음 | 다소 김 |
| 8자 hex | ab12cd34 | 4.3B | 익숙함 | 효율 낮음 |

**선택**: 6자 base62 (56.8억 조합)
- 1000만 이벤트에서 충돌 확률 < 0.0001%

### 2.3 생성 알고리즘

```typescript
// SHA256 해시 기반 (결정적, 빠름)
function generateCitationId(eventId: string): string {
  const hash = crypto.createHash('sha256').update(eventId).digest();

  // base62 인코딩
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += charset[hash[i] % 62];
  }
  return id;
}
```

## 3. 기존 코드와의 관계

### 3.1 event-store.ts

인용 테이블 추가:

```sql
-- events 테이블과 1:1 관계
CREATE TABLE citations (
  citation_id VARCHAR(8) PRIMARY KEY,
  event_id VARCHAR NOT NULL UNIQUE REFERENCES events(event_id)
);
```

### 3.2 retriever.ts

검색 결과에 인용 포함:

```typescript
// 현재
async search(query): Promise<SearchResult[]>

// 확장
async searchWithCitations(query): Promise<CitedSearchResult[]>
```

### 3.3 context-formatter.ts

인용 표시 포맷:

```typescript
// 현재
> DuckDB를 사용하여...

// 확장
> DuckDB를 사용하여...
>
> [mem:a7Bc3x] - 2026-01-30, Session abc123
```

## 4. 설계 결정 사항

### 4.1 생성 시점

**옵션 1: 이벤트 저장 시 즉시 생성**
- 장점: 항상 인용 ID 존재
- 단점: 저장 오버헤드

**옵션 2: 검색 시 지연 생성**
- 장점: 필요할 때만 생성
- 단점: 첫 검색 약간 느림

**선택**: 지연 생성 (getOrCreate 패턴)
- 저장 시 오버헤드 없음
- 대부분 이벤트는 검색되지 않음

### 4.2 인용 포맷

**옵션들**:
1. `[mem:a7Bc3x]` - 명확하고 검색 가능
2. `(ref: a7Bc3x)` - 간결
3. `¹` (각주 스타일) - 학술적
4. `<a7Bc3x>` - 태그 스타일

**선택**: `[mem:a7Bc3x]`
- `mem:` 접두사로 명확한 의미
- 대괄호로 시각적 구분
- 검색/복사 용이

### 4.3 컨텍스트 포함 방식

**인라인 방식** (선택):
```markdown
> 내용...
> [mem:a7Bc3x] - 2026-01-30
```

**각주 방식**:
```markdown
DuckDB를 사용[1]...

---
[1] mem:a7Bc3x - 2026-01-30
```

**참조 방식**:
```markdown
## Content
DuckDB를 사용...

## References
- [mem:a7Bc3x] Session abc123, 2026-01-30
```

## 5. 사용 추적

### 5.1 목적

- 인기 있는 메모리 파악
- 자주 참조되는 지식 식별
- graduation 우선순위 결정

### 5.2 추적 데이터

```sql
CREATE TABLE citation_usages (
  usage_id VARCHAR PRIMARY KEY,
  citation_id VARCHAR NOT NULL,
  session_id VARCHAR NOT NULL,
  used_at TIMESTAMP,
  context VARCHAR  -- 검색 쿼리
);
```

### 5.3 통계 활용

```typescript
// 인기 인용 → graduation 우선순위
async function graduationCandidates(): Promise<Event[]> {
  const popular = await getPopularCitations({ limit: 100 });
  return popular.filter(c => c.usageCount >= 5);
}
```

## 6. 성능 고려사항

### 6.1 ID 생성

- SHA256 해시: ~1µs
- DB 조회 (exists): ~1ms
- 충돌 시 재시도: 드묾

### 6.2 인덱스

```sql
-- 빠른 조회를 위한 인덱스
CREATE INDEX idx_citations_event ON citations(event_id);
CREATE INDEX idx_usages_citation ON citation_usages(citation_id);
```

### 6.3 캐싱

```typescript
// 최근 사용된 인용 캐싱
const citationCache = new LRUCache<string, Citation>({
  max: 1000,
  ttl: 3600000  // 1시간
});
```

## 7. 참고 자료

- **claude-mem**: Citation system with observation IDs
- **학술 인용**: APA, MLA 스타일
- **GitHub**: Issue/PR 참조 (#123)
- **Notion**: 블록 ID 참조 시스템
