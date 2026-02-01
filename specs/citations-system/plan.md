# Citations System Implementation Plan

> **Version**: 1.0.0
> **Status**: Draft
> **Created**: 2026-02-01

## Phase 1: 인용 저장소 (P0)

### 1.1 스키마 정의

**파일**: `src/core/types.ts` 수정

```typescript
export const CitationSchema = z.object({
  citationId: z.string().length(6),
  eventId: z.string(),
  createdAt: z.date()
});

export type Citation = z.infer<typeof CitationSchema>;

export const CitationUsageSchema = z.object({
  usageId: z.string(),
  citationId: z.string(),
  sessionId: z.string(),
  usedAt: z.date(),
  context: z.string().optional()
});

export type CitationUsage = z.infer<typeof CitationUsageSchema>;
```

**작업 항목**:
- [ ] Citation 스키마 추가
- [ ] CitationUsage 스키마 추가
- [ ] 설정 스키마 확장

### 1.2 DB 테이블

**파일**: `src/core/event-store.ts` 수정

```typescript
private async initSchema(): Promise<void> {
  // 기존 테이블...

  // 인용 테이블
  await this.db.exec(`
    CREATE TABLE IF NOT EXISTS citations (
      citation_id VARCHAR(8) PRIMARY KEY,
      event_id VARCHAR NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(event_id)
    );

    CREATE INDEX IF NOT EXISTS idx_citations_event ON citations(event_id);
  `);

  // 사용 로그 테이블
  await this.db.exec(`
    CREATE TABLE IF NOT EXISTS citation_usages (
      usage_id VARCHAR PRIMARY KEY,
      citation_id VARCHAR NOT NULL,
      session_id VARCHAR NOT NULL,
      used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      context VARCHAR
    );

    CREATE INDEX IF NOT EXISTS idx_usages_citation ON citation_usages(citation_id);
  `);
}
```

**작업 항목**:
- [ ] citations 테이블 생성
- [ ] citation_usages 테이블 생성
- [ ] 인덱스 생성

## Phase 2: 인용 ID 생성 (P0)

### 2.1 ID 생성기

**파일**: `src/core/citation-generator.ts` (신규)

```typescript
import { createHash } from 'crypto';

const ID_LENGTH = 6;
const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function generateCitationId(eventId: string): string {
  const hash = createHash('sha256')
    .update(eventId)
    .digest();

  let id = '';
  for (let i = 0; i < ID_LENGTH; i++) {
    id += CHARSET[hash[i] % CHARSET.length];
  }

  return id;
}

// 충돌 처리 (드문 경우)
export async function generateUniqueCitationId(
  eventId: string,
  store: CitationStore
): Promise<string> {
  let id = generateCitationId(eventId);
  let attempt = 0;

  while (await store.exists(id) && attempt < 10) {
    // 솔트 추가하여 재생성
    id = generateCitationId(`${eventId}:${attempt}`);
    attempt++;
  }

  if (attempt >= 10) {
    throw new Error('Failed to generate unique citation ID');
  }

  return id;
}
```

**작업 항목**:
- [ ] generateCitationId 함수 구현
- [ ] 충돌 처리 로직
- [ ] 유닛 테스트

### 2.2 인용 저장소

**파일**: `src/core/citation-store.ts` (신규)

```typescript
export class CitationStore {
  constructor(private db: Database) {}

  async create(citation: CitationInput): Promise<Citation> {
    await this.db.run(`
      INSERT INTO citations (citation_id, event_id, created_at)
      VALUES (?, ?, ?)
    `, [citation.citationId, citation.eventId, new Date()]);

    return { ...citation, createdAt: new Date() };
  }

  async findById(citationId: string): Promise<Citation | null> {
    return this.db.get(`
      SELECT * FROM citations WHERE citation_id = ?
    `, [citationId]);
  }

  async findByEventId(eventId: string): Promise<Citation | null> {
    return this.db.get(`
      SELECT * FROM citations WHERE event_id = ?
    `, [eventId]);
  }

  async exists(citationId: string): Promise<boolean> {
    const result = await this.db.get(`
      SELECT 1 FROM citations WHERE citation_id = ?
    `, [citationId]);
    return !!result;
  }

  async getOrCreate(eventId: string): Promise<Citation> {
    const existing = await this.findByEventId(eventId);
    if (existing) return existing;

    const citationId = await generateUniqueCitationId(eventId, this);
    return this.create({ citationId, eventId });
  }
}
```

**작업 항목**:
- [ ] CitationStore 클래스 구현
- [ ] CRUD 메서드
- [ ] getOrCreate 패턴

## Phase 3: 컨텍스트 통합 (P0)

### 3.1 인용 포함 검색

**파일**: `src/core/retriever.ts` 수정

```typescript
export interface CitedSearchResult {
  event: Event;
  citation: Citation;
  score: number;
}

export class Retriever {
  async searchWithCitations(
    query: string,
    options?: SearchOptions
  ): Promise<CitedSearchResult[]> {
    const results = await this.search(query, options);

    return Promise.all(
      results.map(async (result) => {
        const citation = await this.citationStore.getOrCreate(result.eventId);
        return {
          event: result,
          citation,
          score: result.score
        };
      })
    );
  }
}
```

**작업 항목**:
- [ ] searchWithCitations 메서드 추가
- [ ] 인용 자동 생성/조회

### 3.2 컨텍스트 포맷터 수정

**파일**: `src/core/context-formatter.ts` 수정

```typescript
export function formatContextWithCitations(
  results: CitedSearchResult[],
  options?: FormatOptions
): string {
  const format = options?.format ?? 'inline';

  switch (format) {
    case 'inline':
      return formatInline(results);
    case 'footnote':
      return formatFootnote(results);
    case 'reference':
      return formatReference(results);
  }
}

function formatInline(results: CitedSearchResult[]): string {
  return results.map(r => {
    const date = r.event.timestamp.toLocaleDateString();
    const session = r.event.sessionId.slice(0, 6);

    return [
      `> ${r.event.payload.content}`,
      `>`,
      `> [mem:${r.citation.citationId}] - ${date}, Session ${session}`
    ].join('\n');
  }).join('\n\n---\n\n');
}
```

**작업 항목**:
- [ ] 인라인 포맷 구현
- [ ] 각주 포맷 구현
- [ ] 참조 포맷 구현

## Phase 4: 조회 인터페이스 (P0)

### 4.1 CLI 명령

**파일**: `src/cli/commands/show.ts` (신규)

```typescript
import { Command } from 'commander';

export const showCommand = new Command('show')
  .argument('<citation>', 'Citation ID (e.g., mem:a7Bc3x or just a7Bc3x)')
  .description('Show full content of a cited memory')
  .action(async (citation: string) => {
    const memoryService = await MemoryService.getInstance();

    // mem: 접두사 제거
    const citationId = citation.replace(/^mem:/, '');

    const result = await memoryService.getCitedMemory(citationId);

    if (!result) {
      console.log(chalk.red(`Citation not found: ${citationId}`));
      return;
    }

    // 출력 포맷팅
    console.log(chalk.bold(`📄 Memory Citation: ${citationId}`));
    console.log();
    console.log(`Session: ${result.event.sessionId}`);
    console.log(`Date: ${result.event.timestamp.toLocaleString()}`);
    console.log(`Type: ${result.event.eventType}`);
    console.log();
    console.log('Content:');
    console.log('─'.repeat(40));
    console.log(result.event.payload.content);
    console.log('─'.repeat(40));

    if (result.related) {
      console.log();
      console.log('Related:');
      if (result.related.previous) {
        console.log(`  Previous: [mem:${result.related.previous.citationId}]`);
      }
      if (result.related.next) {
        console.log(`  Next: [mem:${result.related.next.citationId}]`);
      }
    }
  });
```

**작업 항목**:
- [ ] show 명령 구현
- [ ] 출력 포맷팅
- [ ] 관련 인용 표시

### 4.2 API 엔드포인트

**파일**: `src/server/api/citations.ts` (신규)

```typescript
import { Hono } from 'hono';

export const citationsRouter = new Hono();

// GET /api/citations/:id
citationsRouter.get('/:id', async (c) => {
  const { id } = c.req.param();
  const memoryService = await MemoryService.getInstance();

  const result = await memoryService.getCitedMemory(id);

  if (!result) {
    return c.json({ error: 'Citation not found' }, 404);
  }

  return c.json(result);
});

// GET /api/citations/:id/related
citationsRouter.get('/:id/related', async (c) => {
  const { id } = c.req.param();
  const memoryService = await MemoryService.getInstance();

  const related = await memoryService.getRelatedCitations(id);

  return c.json({ related });
});
```

**작업 항목**:
- [ ] 인용 조회 API
- [ ] 관련 인용 API
- [ ] 에러 처리

## Phase 5: 사용 추적 (P1)

### 5.1 사용 로깅

**파일**: `src/core/citation-store.ts` 수정

```typescript
export class CitationStore {
  async logUsage(
    citationId: string,
    sessionId: string,
    context?: string
  ): Promise<void> {
    const usageId = crypto.randomUUID();

    await this.db.run(`
      INSERT INTO citation_usages (usage_id, citation_id, session_id, used_at, context)
      VALUES (?, ?, ?, ?, ?)
    `, [usageId, citationId, sessionId, new Date(), context]);
  }

  async getUsageStats(citationId: string): Promise<CitationStats> {
    const result = await this.db.get(`
      SELECT
        COUNT(*) as usage_count,
        MAX(used_at) as last_used
      FROM citation_usages
      WHERE citation_id = ?
    `, [citationId]);

    return {
      usageCount: result.usage_count,
      lastUsed: result.last_used ? new Date(result.last_used) : null
    };
  }
}
```

**작업 항목**:
- [ ] 사용 로깅 구현
- [ ] 통계 조회
- [ ] user-prompt-submit 훅에서 로깅

### 5.2 인기 인용 통계

```typescript
async getPopularCitations(options?: { limit?: number; days?: number }): Promise<PopularCitation[]> {
  const { limit = 10, days = 30 } = options || {};

  return this.db.query(`
    SELECT
      c.citation_id,
      e.event_type,
      SUBSTR(JSON_EXTRACT(e.payload_json, '$.content'), 1, 100) as preview,
      COUNT(u.usage_id) as usage_count,
      MAX(u.used_at) as last_used
    FROM citations c
    JOIN events e ON c.event_id = e.event_id
    LEFT JOIN citation_usages u ON c.citation_id = u.citation_id
      AND u.used_at > datetime('now', '-${days} days')
    GROUP BY c.citation_id
    ORDER BY usage_count DESC
    LIMIT ?
  `, [limit]);
}
```

**작업 항목**:
- [ ] 인기 인용 조회
- [ ] 기간별 필터링
- [ ] Stats API에 추가

## 파일 목록

### 신규 파일
```
src/core/citation-generator.ts   # ID 생성
src/core/citation-store.ts       # 인용 저장소
src/cli/commands/show.ts         # show 명령
src/server/api/citations.ts      # 인용 API
```

### 수정 파일
```
src/core/types.ts                # 스키마 추가
src/core/event-store.ts          # 테이블 추가
src/core/retriever.ts            # 인용 포함 검색
src/core/context-formatter.ts    # 인용 포맷
src/hooks/user-prompt-submit.ts  # 사용 로깅
src/cli/index.ts                 # show 명령 등록
src/server/api/index.ts          # citations 라우터 추가
```

## 테스트

### 필수 테스트 케이스

1. **ID 생성**
   ```typescript
   test('should generate 6-char citation ID', () => {
     const id = generateCitationId('event_123');
     expect(id.length).toBe(6);
     expect(/^[A-Za-z0-9]+$/.test(id)).toBe(true);
   });
   ```

2. **충돌 처리**
   ```typescript
   test('should handle ID collision', async () => {
     // 첫 번째 이벤트 저장
     await store.create({ citationId: 'abc123', eventId: 'event_1' });

     // 충돌 시 다른 ID 생성
     const id = await generateUniqueCitationId('event_2', store);
     expect(id).not.toBe('abc123');
   });
   ```

3. **컨텍스트 포맷**
   ```typescript
   test('should format context with citations', () => {
     const formatted = formatContextWithCitations([{
       event: mockEvent,
       citation: { citationId: 'a7Bc3x', ... },
       score: 0.9
     }]);

     expect(formatted).toContain('[mem:a7Bc3x]');
   });
   ```

## 마일스톤

| 단계 | 완료 기준 |
|------|----------|
| M1 | 스키마 및 테이블 생성 |
| M2 | ID 생성기 구현 |
| M3 | CitationStore 구현 |
| M4 | 검색에 인용 통합 |
| M5 | CLI show 명령 |
| M6 | API 엔드포인트 |
| M7 | 사용 추적 |
| M8 | 테스트 통과 |
