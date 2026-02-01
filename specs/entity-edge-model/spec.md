# Entity-Edge Model Specification

> **Version**: 1.0.0
> **Status**: Draft
> **Created**: 2026-01-31

## 1. 개요

### 1.1 문제 정의

현재 시스템에서 데이터 관계가 명시적으로 모델링되지 않음:

1. **Entry 간 관계 없음**: Fact와 이를 지지하는 Decision이 분리됨
2. **Entity 관계 없음**: Task와 Blocker 간 관계가 JSON 내부에만 존재
3. **증거 추적 불가**: Entry가 어떤 세션에서 왔는지 추적 어려움

### 1.2 해결 방향

**entries / entities / edges 분리**:
- `entries`: 불변 기록 (Fact, Decision, Insight 등)
- `entities`: 상태 변화 개체 (Task, Condition, Artifact)
- `edges`: 관계 그래프 (evidence_of, blocked_by 등)

## 2. 핵심 개념

### 2.1 3-Layer 모델

```
┌─────────────────────────────────────────────────────────────┐
│                        edges                                 │
│  ┌──────────┐    evidence_of    ┌──────────┐               │
│  │  Entry   │ ─────────────────▶│  Entity  │               │
│  └──────────┘                   └──────────┘               │
│       │                              │                       │
│       │ derived_from                 │ blocked_by           │
│       ▼                              ▼                       │
│  ┌──────────┐                   ┌──────────┐               │
│  │  Entry   │                   │  Entity  │               │
│  └──────────┘                   └──────────┘               │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Node 타입

| 타입 | 테이블 | 예시 |
|-----|--------|-----|
| entry | entries | Fact, Decision, Insight, TaskNote |
| entity | entities | Task, Condition, Artifact |
| event | events | session_ingested, memory_extracted |

### 2.3 관계 타입

```typescript
type RelationType =
  // Entry ↔ Entry
  | 'derived_from'        // 이 Entry가 다른 Entry에서 파생됨
  | 'supersedes'          // 이 Entry가 다른 Entry를 대체함
  | 'contradicts'         // 이 Entry가 다른 Entry와 모순됨

  // Entry ↔ Entity
  | 'evidence_of'         // Entry가 Entity의 증거
  | 'mentions'            // Entry가 Entity를 언급

  // Entity ↔ Entity
  | 'blocked_by'          // Task가 다른 Entity에 의해 blocked
  | 'blocked_by_suggested'// 제안된 blocker (미확정)
  | 'resolves_to'         // Condition이 실제 Entity로 해결됨
  | 'depends_on'          // 일반적인 의존 관계

  // Event ↔ Entry/Entity
  | 'produced'            // Event가 Entry/Entity를 생성함
  | 'source_of'           // Event가 증거의 원본 소스
```

## 3. DB 스키마

### 3.1 entries 테이블

```sql
CREATE TABLE entries (
  entry_id      VARCHAR PRIMARY KEY,
  created_ts    TIMESTAMP NOT NULL,
  entry_type    VARCHAR NOT NULL,        -- fact|decision|insight|task_note|reference
  title         VARCHAR NOT NULL,
  content_json  JSON NOT NULL,
  stage         VARCHAR NOT NULL,        -- raw|working|candidate|verified|certified
  status        VARCHAR DEFAULT 'active',-- active|contested|deprecated|superseded
  superseded_by VARCHAR,                 -- 대체된 경우 새 entry_id
  build_id      VARCHAR,
  evidence_json JSON,                    -- aligned spans
  canonical_key VARCHAR,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_entries_type ON entries(entry_type);
CREATE INDEX idx_entries_stage ON entries(stage);
CREATE INDEX idx_entries_status ON entries(status);
CREATE INDEX idx_entries_canonical ON entries(canonical_key);
```

### 3.2 entities 테이블

```sql
CREATE TABLE entities (
  entity_id      VARCHAR PRIMARY KEY,
  entity_type    VARCHAR NOT NULL,       -- task|condition|artifact
  canonical_key  VARCHAR NOT NULL,
  title          VARCHAR NOT NULL,
  stage          VARCHAR NOT NULL,       -- raw|working|candidate|verified|certified
  status         VARCHAR NOT NULL,       -- active|contested|deprecated|superseded
  current_json   JSON NOT NULL,          -- fold된 현재 상태
  title_norm     VARCHAR,                -- 정규화된 제목 (검색용)
  search_text    VARCHAR,                -- FTS용 텍스트
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_entities_type_key ON entities(entity_type, canonical_key);
CREATE INDEX idx_entities_status ON entities(status);
```

### 3.3 edges 테이블

```sql
CREATE TABLE edges (
  edge_id     VARCHAR PRIMARY KEY,
  src_type    VARCHAR NOT NULL,  -- entry|entity|event
  src_id      VARCHAR NOT NULL,
  rel_type    VARCHAR NOT NULL,  -- evidence_of|blocked_by|...
  dst_type    VARCHAR NOT NULL,  -- entry|entity|event
  dst_id      VARCHAR NOT NULL,
  meta_json   JSON,              -- 관계 메타데이터
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 복합 인덱스
CREATE INDEX idx_edges_src ON edges(src_id, rel_type);
CREATE INDEX idx_edges_dst ON edges(dst_id, rel_type);
CREATE INDEX idx_edges_rel ON edges(rel_type);

-- 중복 방지 (동일 관계 재생성 방지)
CREATE UNIQUE INDEX idx_edges_unique ON edges(src_type, src_id, rel_type, dst_type, dst_id);
```

## 4. Edge 메타데이터

### 4.1 evidence_of

```typescript
interface EvidenceOfMeta {
  confidence: number;        // 증거 신뢰도
  span?: {
    start: number;
    end: number;
  };
  alignment_method: 'exact' | 'normalized' | 'fuzzy';
  source_event_id: string;   // 원본 세션 이벤트
}
```

### 4.2 blocked_by

```typescript
interface BlockedByMeta {
  mode: 'replace' | 'suggest';
  raw_text: string;          // 원본 텍스트
  resolved_at?: Date;        // 해결된 시간
  resolved_by?: string;      // 해결한 세션
}
```

### 4.3 resolves_to

```typescript
interface ResolvesToMeta {
  resolution_type: 'exact_match' | 'user_confirmed' | 'auto_resolved';
  confidence: number;
  resolved_at: Date;
}
```

## 5. 쿼리 패턴

### 5.1 Entity의 모든 증거 조회

```sql
SELECT e.*, ed.meta_json
FROM entries e
JOIN edges ed ON ed.src_type = 'entry' AND ed.src_id = e.entry_id
WHERE ed.rel_type = 'evidence_of'
  AND ed.dst_type = 'entity'
  AND ed.dst_id = :entity_id
ORDER BY e.created_ts DESC;
```

### 5.2 Task의 effective blockers (Condition 해결 적용)

```sql
-- v_task_blockers_effective 뷰
CREATE VIEW v_task_blockers_effective AS
WITH blocked AS (
  -- 직접 blocker
  SELECT
    ed.src_id AS task_id,
    ed.dst_id AS blocker_id,
    ed.dst_type AS blocker_type,
    ed.meta_json
  FROM edges ed
  WHERE ed.src_type = 'entity'
    AND ed.rel_type = 'blocked_by'
),
resolved AS (
  -- Condition이 해결된 경우
  SELECT
    b.task_id,
    COALESCE(r.dst_id, b.blocker_id) AS effective_blocker_id,
    COALESCE(r.dst_type, b.blocker_type) AS effective_blocker_type
  FROM blocked b
  LEFT JOIN edges r ON r.src_type = 'entity'
                   AND r.src_id = b.blocker_id
                   AND r.rel_type = 'resolves_to'
)
SELECT * FROM resolved;
```

### 5.3 Entry의 파생 체인 (lineage)

```sql
WITH RECURSIVE lineage AS (
  -- Base: 시작 entry
  SELECT entry_id, 0 AS depth
  FROM entries
  WHERE entry_id = :start_id

  UNION ALL

  -- Recursive: derived_from 관계 따라가기
  SELECT e.src_id, l.depth + 1
  FROM edges e
  JOIN lineage l ON e.dst_id = l.entry_id
  WHERE e.rel_type = 'derived_from'
    AND l.depth < 10  -- 무한 루프 방지
)
SELECT * FROM lineage;
```

## 6. Idris2 영감 적용

### 6.1 관계 타입 안전성

```typescript
// 타입 레벨에서 유효한 관계만 허용
type ValidEdge =
  | { srcType: 'entry'; relType: 'evidence_of'; dstType: 'entity' }
  | { srcType: 'entry'; relType: 'derived_from'; dstType: 'entry' }
  | { srcType: 'entity'; relType: 'blocked_by'; dstType: 'entity' }
  | { srcType: 'entity'; relType: 'resolves_to'; dstType: 'entity' };

// 잘못된 조합은 타입 에러
// { srcType: 'entry'; relType: 'blocked_by'; dstType: 'entry' }  // Error!
```

### 6.2 Zod 스키마로 검증

```typescript
const EdgeSchema = z.discriminatedUnion('relType', [
  z.object({
    srcType: z.literal('entry'),
    relType: z.literal('evidence_of'),
    dstType: z.literal('entity')
  }),
  z.object({
    srcType: z.literal('entity'),
    relType: z.literal('blocked_by'),
    dstType: z.literal('entity')
  }),
  // ...
]);
```

### 6.3 불변식

```typescript
// blocked_by edge 생성 시 Task 상태도 blocked여야 함
async function createBlockedByEdge(
  taskId: string,
  blockerId: string
): Promise<Edge> {
  const task = await entityRepo.findById(taskId);

  // 불변식 검증
  if (task.current_json.status !== 'blocked') {
    throw new InvariantViolationError(
      `Cannot create blocked_by edge: Task ${taskId} is not in blocked status`
    );
  }

  return edgeRepo.create({
    srcType: 'entity',
    srcId: taskId,
    relType: 'blocked_by',
    dstType: 'entity',
    dstId: blockerId
  });
}
```

## 7. EdgeRepository API

```typescript
interface EdgeRepository {
  // 생성
  create(edge: EdgeInput): Promise<Edge>;
  createMany(edges: EdgeInput[]): Promise<Edge[]>;

  // 조회
  findById(edgeId: string): Promise<Edge | null>;
  findBySrc(srcId: string, relType?: string): Promise<Edge[]>;
  findByDst(dstId: string, relType?: string): Promise<Edge[]>;

  // 삭제 (projector용)
  deleteById(edgeId: string): Promise<void>;
  deleteBySrc(srcId: string, relType: string): Promise<number>;

  // 교체 (mode=replace용)
  replaceBySrc(
    srcId: string,
    relType: string,
    newEdges: EdgeInput[]
  ): Promise<void>;

  // 중복 확인
  exists(
    srcType: string,
    srcId: string,
    relType: string,
    dstType: string,
    dstId: string
  ): Promise<boolean>;
}
```

## 8. 마이그레이션 전략

### 8.1 기존 데이터 변환

```typescript
// 기존 entry의 evidence → edges로 변환
async function migrateEvidence(): Promise<void> {
  const entries = await db.query('SELECT * FROM entries WHERE evidence_json IS NOT NULL');

  for (const entry of entries) {
    const evidence = JSON.parse(entry.evidence_json);

    for (const ev of evidence) {
      // Entity 찾기 (canonical_key 기반)
      const entity = await entityRepo.findByCanonicalKey(
        'task',
        ev.canonical_key
      );

      if (entity) {
        await edgeRepo.create({
          srcType: 'entry',
          srcId: entry.entry_id,
          relType: 'evidence_of',
          dstType: 'entity',
          dstId: entity.entity_id,
          metaJson: { confidence: ev.confidence, span: ev.span }
        });
      }
    }
  }
}
```

### 8.2 점진적 적용

1. **Phase 1**: edges 테이블 생성, 신규 데이터만 edge 기록
2. **Phase 2**: 기존 데이터 마이그레이션 (백그라운드)
3. **Phase 3**: 쿼리를 edges 기반으로 전환
4. **Phase 4**: 기존 JSON 필드 deprecated

## 9. 성공 기준

- [ ] entries/entities/edges 3개 테이블 분리 동작
- [ ] evidence_of edge로 Entry→Entity 증거 관계 추적
- [ ] blocked_by edge로 Task 의존성 그래프 구축
- [ ] resolves_to edge로 Condition→Entity 해결 추적
- [ ] v_task_blockers_effective 뷰로 effective blocker 조회
- [ ] 기존 JSON 기반 관계와 호환 유지
