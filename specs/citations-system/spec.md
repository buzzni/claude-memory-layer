# Citations System Specification

> **Version**: 1.0.0
> **Status**: Draft
> **Created**: 2026-02-01
> **Reference**: claude-mem (thedotmack/claude-mem)

## 1. 개요

### 1.1 문제 정의

현재 시스템에서 메모리 출처 추적이 어려움:

1. **출처 불명확**: 검색 결과가 어느 세션에서 왔는지 즉시 파악 어려움
2. **검증 불가**: AI가 참조한 정보의 원본 확인 어려움
3. **맥락 손실**: 인용된 정보의 전후 맥락 파악 어려움

### 1.2 해결 방향

**Citations (인용) 시스템**:
- 모든 메모리에 고유 인용 ID 부여
- 컨텍스트 주입 시 인용 표시
- 클릭/명령으로 원본 조회 가능

## 2. 핵심 개념

### 2.1 인용 형식

```
[mem:abc123] 에서 참조한 정보입니다.
```

### 2.2 인용 구조

```typescript
interface Citation {
  // 식별
  id: string;                    // 짧은 인용 ID (6-8자)
  eventId: string;               // 전체 이벤트 ID

  // 출처 정보
  sessionId: string;
  timestamp: Date;
  eventType: 'prompt' | 'response' | 'tool' | 'insight';

  // 메타데이터
  preview: string;               // 50자 미리보기
  confidence: number;            // 매칭 신뢰도
  relevanceScore: number;        // 검색 관련성 점수
}
```

### 2.3 인용 ID 생성

```typescript
// 짧고 읽기 쉬운 ID
function generateCitationId(eventId: string): string {
  // eventId의 해시에서 6자 추출
  const hash = crypto.createHash('sha256')
    .update(eventId)
    .digest('base64url')
    .slice(0, 6);

  return hash;  // 예: "a7Bc3x"
}
```

## 3. 데이터 스키마

### 3.1 인용 테이블

```sql
CREATE TABLE citations (
  citation_id   VARCHAR(8) PRIMARY KEY,
  event_id      VARCHAR NOT NULL REFERENCES events(event_id),
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- 인덱스
  UNIQUE(event_id)
);

CREATE INDEX idx_citations_event ON citations(event_id);
```

### 3.2 이벤트 확장

```typescript
const EventSchema = z.object({
  eventId: z.string(),
  // ... 기존 필드

  // 인용 정보 추가
  citationId: z.string().optional(),  // 생성된 인용 ID
});
```

## 4. 인용 생성 흐름

### 4.1 자동 생성

```typescript
// 이벤트 저장 시 자동으로 인용 ID 생성
async function storeEventWithCitation(event: Event): Promise<string> {
  const eventId = await eventStore.append(event);

  // 인용 ID 생성 및 저장
  const citationId = generateCitationId(eventId);
  await citationStore.create({
    citationId,
    eventId,
    createdAt: new Date()
  });

  return eventId;
}
```

### 4.2 지연 생성

```typescript
// 검색 시 필요할 때만 인용 ID 생성
async function getCitationId(eventId: string): Promise<string> {
  // 기존 인용 확인
  const existing = await citationStore.findByEventId(eventId);
  if (existing) {
    return existing.citationId;
  }

  // 새로 생성
  const citationId = generateCitationId(eventId);
  await citationStore.create({ citationId, eventId });
  return citationId;
}
```

## 5. 컨텍스트 주입

### 5.1 인용 포함 포맷

```markdown
## Relevant Context

Based on previous conversations:

> DuckDB를 사용하여 이벤트 소싱 패턴을 구현하는 것이 좋습니다.
> 이벤트는 불변이어야 하며, append-only 방식으로 저장합니다.
>
> [mem:a7Bc3x] - 2026-01-30, Session abc123

---

> 타입 안전성을 위해 Zod 스키마를 사용하세요.
>
> [mem:x9Yz2w] - 2026-01-29, Session def456
```

### 5.2 포맷터 구현

```typescript
interface CitedMemory {
  content: string;
  citation: Citation;
}

function formatCitedContext(memories: CitedMemory[]): string {
  const parts = memories.map(m => {
    const lines = [
      `> ${m.content}`,
      `>`,
      `> [mem:${m.citation.id}] - ${formatDate(m.citation.timestamp)}, ` +
      `Session ${m.citation.sessionId.slice(0, 6)}`
    ];
    return lines.join('\n');
  });

  return [
    '## Relevant Context',
    '',
    'Based on previous conversations:',
    '',
    parts.join('\n\n---\n\n')
  ].join('\n');
}
```

## 6. 인용 조회

### 6.1 CLI 명령

```bash
# 인용 ID로 원본 조회
$ code-memory show mem:a7Bc3x

📄 Memory Citation: a7Bc3x

Session: abc123
Date: 2026-01-30 14:05
Type: assistant_response

Content:
────────────────────────────────────────
DuckDB를 사용하여 이벤트 소싱 패턴을 구현하는 것이 좋습니다.
이벤트는 불변이어야 하며, append-only 방식으로 저장합니다.

스키마 예시:
```sql
CREATE TABLE events (
  event_id VARCHAR PRIMARY KEY,
  ...
);
```
────────────────────────────────────────

Related:
  Previous: [mem:b8Xc2y] - User question about DB design
  Next: [mem:c9Yd3z] - Follow-up on indexing
```

### 6.2 API 엔드포인트

```typescript
// GET /api/citations/:id
router.get('/citations/:id', async (c) => {
  const { id } = c.req.param();

  const citation = await citationStore.findById(id);
  if (!citation) {
    return c.json({ error: 'Citation not found' }, 404);
  }

  const event = await eventStore.findById(citation.eventId);
  const related = await getRelatedEvents(citation.eventId);

  return c.json({
    citation,
    event,
    related
  });
});
```

### 6.3 슬래시 명령

```
User: /show a7Bc3x

---
이 메모리의 전체 내용을 보여드립니다:

[원본 내용 표시]
---
```

## 7. 인용 검색

### 7.1 인용 ID로 검색

```typescript
async function searchByCitation(citationId: string): Promise<Event | null> {
  const citation = await citationStore.findById(citationId);
  if (!citation) return null;

  return eventStore.findById(citation.eventId);
}
```

### 7.2 역참조 검색

```typescript
// 특정 이벤트를 인용한 세션들 조회
async function findCitingSession(citationId: string): Promise<string[]> {
  // 인용 사용 로그에서 검색
  const usages = await citationUsageStore.findByCitationId(citationId);
  return [...new Set(usages.map(u => u.sessionId))];
}
```

## 8. 인용 사용 추적

### 8.1 사용 로그

```sql
CREATE TABLE citation_usages (
  usage_id      VARCHAR PRIMARY KEY,
  citation_id   VARCHAR NOT NULL,
  session_id    VARCHAR NOT NULL,
  used_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  context       VARCHAR  -- 어떤 쿼리에서 사용됐는지
);

CREATE INDEX idx_usages_citation ON citation_usages(citation_id);
CREATE INDEX idx_usages_session ON citation_usages(session_id);
```

### 8.2 인기 인용 통계

```typescript
async function getPopularCitations(limit: number = 10): Promise<CitationStats[]> {
  return db.query(`
    SELECT
      c.citation_id,
      COUNT(u.usage_id) as usage_count,
      MAX(u.used_at) as last_used
    FROM citations c
    LEFT JOIN citation_usages u ON c.citation_id = u.citation_id
    GROUP BY c.citation_id
    ORDER BY usage_count DESC
    LIMIT ?
  `, [limit]);
}
```

## 9. UI 표시

### 9.1 CLI

```
$ code-memory search "DuckDB"

🔍 Search Results:

#1 [mem:a7Bc3x] (score: 0.94)
   "DuckDB를 사용하여 이벤트 소싱 패턴을..."
   📅 2026-01-30 | 🔗 Session abc123

#2 [mem:d4Ef5g] (score: 0.87)
   "DuckDB의 인덱싱 전략..."
   📅 2026-01-29 | 🔗 Session def456

💡 Use "code-memory show mem:a7Bc3x" for full content
```

### 9.2 Web Viewer

```html
<div class="search-result">
  <div class="result-header">
    <span class="citation-badge" title="Click to copy">
      [mem:a7Bc3x]
    </span>
    <span class="score">0.94</span>
  </div>
  <p class="preview">DuckDB를 사용하여 이벤트 소싱 패턴을...</p>
  <div class="metadata">
    <span>📅 2026-01-30</span>
    <a href="/sessions/abc123">🔗 Session abc123</a>
  </div>
  <button onclick="showCitation('a7Bc3x')">View Full</button>
</div>
```

## 10. 설정

```typescript
const CitationsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  idLength: z.number().default(6),          // 인용 ID 길이
  includeInContext: z.boolean().default(true),  // 컨텍스트에 포함
  trackUsage: z.boolean().default(true),    // 사용 추적
  format: z.enum(['inline', 'footnote', 'reference']).default('inline')
});
```

## 11. 성공 기준

- [ ] 모든 이벤트에 인용 ID 자동 생성
- [ ] 컨텍스트 주입 시 인용 표시
- [ ] `code-memory show mem:xxx` 명령 동작
- [ ] Web Viewer에서 인용 클릭 시 원본 표시
- [ ] 인용 사용 통계 수집
- [ ] 인용 ID 충돌 없음 (6자, 64^6 = 687억 조합)
