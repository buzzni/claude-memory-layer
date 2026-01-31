# Entity-Edge Model Context

> **Version**: 1.0.0
> **Created**: 2026-01-31

## 1. 배경

### 1.1 그래프 기반 지식 표현의 필요성

지식 시스템에서 관계(relationship)는 노드만큼 중요합니다:

- **Fact A**가 **Task B**의 증거가 된다
- **Task C**가 **Condition D**에 의해 blocked 되어있다
- **Entry E**가 **Entry F**를 대체(supersede)한다

이런 관계를 JSON 내부에 저장하면:
1. 쿼리가 복잡해짐 (JSON 파싱 필요)
2. 일관성 보장 어려움 (양방향 관계)
3. 성능 저하 (인덱스 활용 불가)

### 1.2 Property Graph 모델

```
(Entry)-[:EVIDENCE_OF]->(Entity)
(Entity)-[:BLOCKED_BY]->(Entity)
(Entry)-[:DERIVED_FROM]->(Entry)
```

**장점**:
- 관계가 1급 시민 (first-class citizen)
- 인덱스를 통한 빠른 탐색
- 복잡한 경로 쿼리 가능 (e.g., 증거 체인)

## 2. Memo.txt 참고 사항

### 2.1 스키마 분리 (섹션 4)

> **entries / entities / edges 분리**
> - entries: 불변 기록
> - entities: 상태 변화 개체
> - edges: 관계 그래프

### 2.2 edges 테이블 (섹션 4.3)

```sql
CREATE TABLE edges (
  edge_id     VARCHAR PRIMARY KEY,
  src_type    VARCHAR NOT NULL,  -- entry|entity
  src_id      VARCHAR NOT NULL,
  rel_type    VARCHAR NOT NULL,  -- evidence_of|blocked_by|...
  dst_type    VARCHAR NOT NULL,
  dst_id      VARCHAR NOT NULL,
  meta_json   JSON,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 2.3 관계 타입

**Entity ↔ Entity**:
- `blocked_by`: 확정된 blocker
- `blocked_by_suggested`: 제안된 blocker (미확정)
- `resolves_to`: Condition이 실제 Entity로 해결

**Entry ↔ Entity**:
- `evidence_of`: Entry가 Entity의 증거

### 2.4 Effective Blockers (섹션 9.1)

> **v_task_blockers_effective 뷰**:
> blocked_by edge의 대상이 condition이고 resolves_to가 있으면
> effective blocker를 resolved_to로 펼쳐서 반환

## 3. Idris2 영감 적용

### 3.1 Dependent Types로 관계 제약

**Idris2 개념**:
```idris
-- 타입 수준에서 유효한 관계만 허용
data Edge : NodeType -> RelationType -> NodeType -> Type where
  EvidenceOf : (src : Entry) -> (dst : Entity) -> Edge Entry EvidenceOf Entity
  BlockedBy  : (src : Task) -> (dst : Entity) -> Edge Entity BlockedBy Entity
```

**TypeScript 적용**:
```typescript
// Discriminated Union으로 유효 조합 정의
type ValidEdge =
  | { srcType: 'entry'; relType: 'evidence_of'; dstType: 'entity' }
  | { srcType: 'entity'; relType: 'blocked_by'; dstType: 'entity' }
  | { srcType: 'entity'; relType: 'resolves_to'; dstType: 'entity' };

// 타입 가드
function isValidEdge(edge: EdgeInput): edge is ValidEdge {
  const patterns: ValidEdge[] = [ ... ];
  return patterns.some(p =>
    p.srcType === edge.srcType &&
    p.relType === edge.relType &&
    p.dstType === edge.dstType
  );
}
```

### 3.2 관계 불변식

```typescript
// 불변식: blocked_by edge가 있으면 Task는 blocked 상태여야 함
const BlockedByInvariant = z.object({
  task: z.object({
    status: z.literal('blocked')
  }),
  edges: z.array(z.object({
    relType: z.literal('blocked_by')
  })).min(1)  // 최소 1개의 blocker
});

// 불변식: done 상태면 blocked_by edge가 없어야 함
const DoneInvariant = z.object({
  task: z.object({
    status: z.literal('done')
  }),
  edges: z.array(z.object({
    relType: z.literal('blocked_by')
  })).max(0)  // blocker 없음
});
```

### 3.3 양방향 탐색 안전성

```typescript
// Idris2: 양방향 탐색이 타입 안전
interface BidirectionalEdge<S, R, D> {
  from(src: S): Edge<S, R, D>[];
  to(dst: D): Edge<S, R, D>[];

  // 불변식: from(x).filter(e => e.dst === y) === to(y).filter(e => e.src === x)
}

// TypeScript: 인덱스로 보장
// idx_edges_src: (src_id, rel_type)
// idx_edges_dst: (dst_id, rel_type)
```

## 4. 기존 코드와의 관계

### 4.1 types.ts

현재 Edge 관련 타입 없음 → 추가 필요:

```typescript
// 현재
export const EvidenceSpanSchema = z.object({
  start: z.number(),
  end: z.number(),
  confidence: z.number(),
  matchType: z.enum(['exact', 'fuzzy', 'none']),
  ...
});

// 추가
export const EdgeSchema = z.object({
  edgeId: z.string(),
  srcType: NodeTypeSchema,
  srcId: z.string(),
  relType: RelationTypeSchema,
  dstType: NodeTypeSchema,
  dstId: z.string(),
  metaJson: z.record(z.unknown()).optional()
});
```

### 4.2 event-store.ts

Edge 생성은 Projector가 담당, EventStore와 직접 연관 없음.
단, source_of edge를 통해 이벤트와 Entry/Entity 연결 가능:

```typescript
// 세션 이벤트와 생성된 Entry 연결
edges.create({
  srcType: 'event',
  srcId: sessionIngestedEvent.id,
  relType: 'source_of',
  dstType: 'entry',
  dstId: newEntry.id
});
```

### 4.3 matcher.ts

현재 Matcher는 이벤트 매칭용 → Entity 매칭으로 확장 시 edge 활용:

```typescript
// Entity 검색 시 관계 정보도 반환
async function findTaskWithRelations(taskId: string): Promise<TaskWithRelations> {
  const task = await entityRepo.findById(taskId);
  const blockedByEdges = await edgeRepo.findBySrc(taskId, 'blocked_by');
  const evidenceEdges = await edgeRepo.findByDst(taskId, 'evidence_of');

  return {
    ...task,
    blockers: blockedByEdges.map(e => e.dstId),
    evidence: evidenceEdges.map(e => e.srcId)
  };
}
```

## 5. 설계 결정 사항

### 5.1 왜 별도 edges 테이블인가?

**대안 1: JSON 내 저장**
```json
{
  "id": "task_1",
  "blockers": ["cond_a", "task_b"]
}
```
- 단점: 역방향 쿼리 어려움 ("cond_a를 blocker로 가진 Task는?")

**대안 2: 관계형 테이블**
```sql
CREATE TABLE task_blockers (
  task_id VARCHAR,
  blocker_id VARCHAR
);
```
- 단점: 관계 타입마다 테이블 필요

**선택: 범용 edges 테이블**
- 장점: 모든 관계를 하나의 패턴으로 처리
- 장점: 메타데이터 유연하게 저장
- 장점: 인덱스로 양방향 탐색 최적화

### 5.2 왜 meta_json을 사용하는가?

관계마다 필요한 메타데이터가 다름:

```typescript
// evidence_of: span, confidence, method
{ span: { start: 10, end: 50 }, confidence: 0.95, method: 'fuzzy' }

// blocked_by: mode, raw_text
{ mode: 'suggest', raw_text: '인증 API 완료 필요' }

// resolves_to: resolution_type, resolved_at
{ resolution_type: 'exact_match', resolved_at: '2026-01-31T10:00:00Z' }
```

JSON 컬럼으로 유연하게 처리.

### 5.3 중복 방지 전략

**Unique 인덱스**:
```sql
CREATE UNIQUE INDEX idx_edges_unique
ON edges(src_type, src_id, rel_type, dst_type, dst_id);
```

**INSERT OR IGNORE / ON CONFLICT**:
```sql
INSERT INTO edges (...)
VALUES (...)
ON CONFLICT (src_type, src_id, rel_type, dst_type, dst_id)
DO NOTHING;  -- 또는 UPDATE meta_json
```

## 6. 쿼리 패턴 예시

### 6.1 Task의 모든 관계 조회

```sql
-- Task를 중심으로 한 모든 관계
SELECT
  'outgoing' AS direction,
  e.rel_type,
  e.dst_type,
  e.dst_id,
  e.meta_json
FROM edges e
WHERE e.src_type = 'entity' AND e.src_id = :task_id

UNION ALL

SELECT
  'incoming' AS direction,
  e.rel_type,
  e.src_type,
  e.src_id,
  e.meta_json
FROM edges e
WHERE e.dst_type = 'entity' AND e.dst_id = :task_id;
```

### 6.2 Blocked Tasks 조회 (blocker 정보 포함)

```sql
SELECT
  t.entity_id AS task_id,
  t.title AS task_title,
  JSON_GROUP_ARRAY(
    JSON_OBJECT(
      'blocker_id', e.dst_id,
      'blocker_type', ent.entity_type,
      'blocker_title', ent.title
    )
  ) AS blockers
FROM entities t
JOIN edges e ON e.src_id = t.entity_id AND e.rel_type = 'blocked_by'
JOIN entities ent ON ent.entity_id = e.dst_id
WHERE t.entity_type = 'task'
  AND JSON_EXTRACT(t.current_json, '$.status') = 'blocked'
GROUP BY t.entity_id;
```

### 6.3 증거 체인 탐색 (2-hop)

```sql
-- Entry → Entity → 관련 Entry
WITH first_hop AS (
  SELECT
    e1.src_id AS entry_id,
    e1.dst_id AS entity_id
  FROM edges e1
  WHERE e1.src_type = 'entry'
    AND e1.rel_type = 'evidence_of'
    AND e1.src_id = :start_entry_id
),
second_hop AS (
  SELECT
    f.entry_id AS origin_entry,
    f.entity_id,
    e2.src_id AS related_entry_id
  FROM first_hop f
  JOIN edges e2 ON e2.dst_id = f.entity_id
               AND e2.rel_type = 'evidence_of'
               AND e2.src_type = 'entry'
  WHERE e2.src_id != f.entry_id  -- 자기 자신 제외
)
SELECT * FROM second_hop;
```

## 7. 성능 고려사항

### 7.1 인덱스 전략

```sql
-- 출발점 기준 탐색 (가장 빈번)
CREATE INDEX idx_edges_src ON edges(src_id, rel_type);

-- 도착점 기준 탐색 (역방향)
CREATE INDEX idx_edges_dst ON edges(dst_id, rel_type);

-- 관계 타입별 통계
CREATE INDEX idx_edges_rel ON edges(rel_type);
```

### 7.2 캐싱

```typescript
// 자주 조회되는 관계 캐싱
const relationCache = new LRUCache<string, Edge[]>({
  max: 5000,
  ttl: 1000 * 60 * 5  // 5분
});

async function getBlockers(taskId: string): Promise<Edge[]> {
  const key = `blockers:${taskId}`;
  if (relationCache.has(key)) {
    return relationCache.get(key)!;
  }

  const edges = await edgeRepo.findBySrc(taskId, 'blocked_by');
  relationCache.set(key, edges);
  return edges;
}
```

### 7.3 배치 처리

```typescript
// 대량 edge 생성 시 배치 insert
async function createManyEdges(edges: EdgeInput[]): Promise<void> {
  const BATCH_SIZE = 1000;

  for (let i = 0; i < edges.length; i += BATCH_SIZE) {
    const batch = edges.slice(i, i + BATCH_SIZE);
    await db.transaction(async (tx) => {
      for (const edge of batch) {
        await tx.run('INSERT INTO edges ...', [...]);
      }
    });
  }
}
```

## 8. 참고 자료

- **Memo.txt**: 섹션 4.3 (edges 테이블), 섹션 9.1 (effective blockers)
- **Property Graph**: Neo4j, AWS Neptune 모델 참고
- **AXIOMMIND**: Principle 5 (Task는 Entity)
