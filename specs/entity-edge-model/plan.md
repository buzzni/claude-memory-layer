# Entity-Edge Model Implementation Plan

> **Version**: 1.0.0
> **Status**: Draft
> **Created**: 2026-01-31

## Phase 1: 스키마 정의 (P0)

### 1.1 타입 정의

**파일**: `src/core/types.ts` 수정

```typescript
// 추가할 타입들
export const NodeTypeSchema = z.enum(['entry', 'entity', 'event']);
export type NodeType = z.infer<typeof NodeTypeSchema>;

export const RelationTypeSchema = z.enum([
  // Entry ↔ Entry
  'derived_from',
  'supersedes',
  'contradicts',
  // Entry ↔ Entity
  'evidence_of',
  'mentions',
  // Entity ↔ Entity
  'blocked_by',
  'blocked_by_suggested',
  'resolves_to',
  'depends_on',
  // Event ↔ Entry/Entity
  'produced',
  'source_of'
]);
export type RelationType = z.infer<typeof RelationTypeSchema>;

export const EdgeSchema = z.object({
  edgeId: z.string(),
  srcType: NodeTypeSchema,
  srcId: z.string(),
  relType: RelationTypeSchema,
  dstType: NodeTypeSchema,
  dstId: z.string(),
  metaJson: z.record(z.unknown()).optional(),
  createdAt: z.date()
});
export type Edge = z.infer<typeof EdgeSchema>;
```

**작업 항목**:
- [ ] NodeType 스키마 추가
- [ ] RelationType 스키마 추가
- [ ] Edge 스키마 추가
- [ ] EdgeMeta 타입들 추가 (EvidenceOfMeta, BlockedByMeta 등)

### 1.2 DB 스키마

**파일**: 마이그레이션 스크립트

```sql
-- 신규 테이블
CREATE TABLE edges (...);

-- entries 테이블 수정 (필요시)
ALTER TABLE entries ADD COLUMN IF NOT EXISTS superseded_by VARCHAR;

-- 인덱스
CREATE INDEX idx_edges_src ON edges(src_id, rel_type);
CREATE INDEX idx_edges_dst ON edges(dst_id, rel_type);
CREATE UNIQUE INDEX idx_edges_unique ON edges(src_type, src_id, rel_type, dst_type, dst_id);
```

**작업 항목**:
- [ ] edges 테이블 DDL
- [ ] 인덱스 생성
- [ ] 중복 방지 unique 인덱스

## Phase 2: EdgeRepository 구현 (P0)

### 2.1 기본 CRUD

**파일**: `src/core/edge-repo.ts` (신규)

```typescript
export class EdgeRepository {
  constructor(private db: Database);

  async create(edge: EdgeInput): Promise<Edge> {
    const edgeId = uuidv4();
    await this.db.run(`
      INSERT INTO edges (edge_id, src_type, src_id, rel_type, dst_type, dst_id, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [edgeId, edge.srcType, edge.srcId, edge.relType, edge.dstType, edge.dstId,
        JSON.stringify(edge.metaJson || {})]);
    return { edgeId, ...edge, createdAt: new Date() };
  }

  async createMany(edges: EdgeInput[]): Promise<Edge[]> {
    // 배치 insert
  }
}
```

**작업 항목**:
- [ ] create() 메서드
- [ ] createMany() 배치 메서드
- [ ] findById() 메서드
- [ ] findBySrc() 메서드
- [ ] findByDst() 메서드

### 2.2 삭제 및 교체

```typescript
async deleteBySrc(srcId: string, relType: string): Promise<number> {
  const result = await this.db.run(`
    DELETE FROM edges WHERE src_id = ? AND rel_type = ?
  `, [srcId, relType]);
  return result.changes;
}

async replaceBySrc(
  srcId: string,
  relType: string,
  newEdges: EdgeInput[]
): Promise<void> {
  await this.db.transaction(async (tx) => {
    await tx.run('DELETE FROM edges WHERE src_id = ? AND rel_type = ?', [srcId, relType]);
    for (const edge of newEdges) {
      await tx.run('INSERT INTO edges ...', [...]);
    }
  });
}
```

**작업 항목**:
- [ ] deleteById() 메서드
- [ ] deleteBySrc() 메서드
- [ ] replaceBySrc() 트랜잭션 메서드
- [ ] exists() 중복 확인 메서드

### 2.3 유효성 검증

```typescript
// 유효한 관계 조합만 허용
const VALID_EDGE_PATTERNS = [
  { srcType: 'entry', relType: 'evidence_of', dstType: 'entity' },
  { srcType: 'entry', relType: 'derived_from', dstType: 'entry' },
  { srcType: 'entity', relType: 'blocked_by', dstType: 'entity' },
  // ...
];

function validateEdge(edge: EdgeInput): boolean {
  return VALID_EDGE_PATTERNS.some(p =>
    p.srcType === edge.srcType &&
    p.relType === edge.relType &&
    p.dstType === edge.dstType
  );
}
```

**작업 항목**:
- [ ] 유효 패턴 정의
- [ ] validateEdge() 함수
- [ ] create() 호출 시 검증 적용

## Phase 3: 뷰 및 쿼리 (P0)

### 3.1 Effective Blockers 뷰

**파일**: SQL 마이그레이션

```sql
CREATE VIEW v_task_blockers_effective AS
WITH blocked AS (
  SELECT
    ed.src_id AS task_id,
    ed.dst_id AS blocker_id,
    ent.entity_type AS blocker_type,
    ed.meta_json
  FROM edges ed
  JOIN entities ent ON ent.entity_id = ed.dst_id
  WHERE ed.src_type = 'entity'
    AND ed.rel_type = 'blocked_by'
),
resolved AS (
  SELECT
    b.task_id,
    COALESCE(r.dst_id, b.blocker_id) AS effective_blocker_id,
    COALESCE(
      (SELECT entity_type FROM entities WHERE entity_id = r.dst_id),
      b.blocker_type
    ) AS effective_blocker_type
  FROM blocked b
  LEFT JOIN edges r ON r.src_type = 'entity'
                   AND r.src_id = b.blocker_id
                   AND r.rel_type = 'resolves_to'
)
SELECT * FROM resolved;
```

**작업 항목**:
- [ ] v_task_blockers_effective 뷰 생성

### 3.2 조회 함수

**파일**: `src/core/queries.ts` (신규 또는 기존 확장)

```typescript
// Task의 effective blockers 조회
async function getEffectiveBlockers(taskId: string): Promise<EffectiveBlocker[]> {
  return db.query(`
    SELECT * FROM v_task_blockers_effective WHERE task_id = ?
  `, [taskId]);
}

// Entry의 증거 체인 조회
async function getEvidenceChain(entryId: string): Promise<Evidence[]> {
  return db.query(`
    SELECT ent.*, ed.meta_json as evidence_meta
    FROM entities ent
    JOIN edges ed ON ed.dst_id = ent.entity_id
    WHERE ed.src_type = 'entry' AND ed.src_id = ?
      AND ed.rel_type = 'evidence_of'
  `, [entryId]);
}
```

**작업 항목**:
- [ ] getEffectiveBlockers() 함수
- [ ] getEvidenceChain() 함수
- [ ] getBlockedTasks() 함수
- [ ] getResolvedConditions() 함수

## Phase 4: Projector 연동 (P0)

### 4.1 TaskProjector 수정

**파일**: `src/core/task-projector.ts`

```typescript
// mode=replace 처리
async handleBlockersSet(event: TaskEvent): Promise<void> {
  const payload = event.payload as TaskBlockersSetPayload;

  if (payload.mode === 'replace') {
    // 기존 blocked_by edge 모두 삭제
    await this.edgeRepo.deleteBySrc(payload.task_id, 'blocked_by');

    // 새 edge 생성
    for (const blocker of payload.blockers) {
      await this.edgeRepo.create({
        srcType: 'entity',
        srcId: payload.task_id,
        relType: 'blocked_by',
        dstType: 'entity',
        dstId: blocker.entity_id,
        metaJson: {
          mode: 'replace',
          raw_text: blocker.raw_text,
          confidence: blocker.confidence
        }
      });
    }
  } else if (payload.mode === 'suggest') {
    // blocked_by_suggested edge만 추가/갱신
    await this.edgeRepo.replaceBySrc(
      payload.task_id,
      'blocked_by_suggested',
      payload.blockers.map(b => ({
        srcType: 'entity',
        srcId: payload.task_id,
        relType: 'blocked_by_suggested',
        dstType: 'entity',
        dstId: b.entity_id,
        metaJson: { raw_text: b.raw_text }
      }))
    );
  }
}
```

**작업 항목**:
- [ ] handleBlockersSet에서 edge 생성
- [ ] mode=replace 처리
- [ ] mode=suggest 처리
- [ ] handleStatusChanged에서 done 시 edge 삭제

### 4.2 Evidence Edge 생성

**파일**: `src/core/graduation.ts` 또는 별도 projector

```typescript
// Entry 저장 시 evidence edge 생성
async function materializeEntry(entry: Entry, alignResult: AlignResult): Promise<void> {
  // Entry 저장
  await entryRepo.create(entry);

  // Evidence edge 생성
  for (const ev of alignResult.alignedEvidence) {
    if (ev.matchMethod !== 'none') {
      // Entity 찾기 또는 생성
      const entity = await resolveEvidenceTarget(ev);

      await edgeRepo.create({
        srcType: 'entry',
        srcId: entry.entry_id,
        relType: 'evidence_of',
        dstType: 'entity',
        dstId: entity.entity_id,
        metaJson: {
          confidence: ev.confidence,
          span: { start: ev.spanStart, end: ev.spanEnd },
          alignment_method: ev.matchMethod
        }
      });
    }
  }
}
```

**작업 항목**:
- [ ] Entry 저장 시 evidence edge 생성
- [ ] source_of edge 생성 (세션 이벤트 연결)

## Phase 5: 마이그레이션 (P1)

### 5.1 기존 데이터 변환 스크립트

**파일**: `scripts/migrate-to-edges.ts`

```typescript
async function migrateExistingData(): Promise<MigrationResult> {
  const stats = { entries: 0, edges: 0, errors: 0 };

  // 1. evidence_json → evidence_of edge
  const entriesWithEvidence = await db.query(`
    SELECT * FROM entries WHERE evidence_json IS NOT NULL
  `);

  for (const entry of entriesWithEvidence) {
    try {
      const evidence = JSON.parse(entry.evidence_json);
      // ... edge 생성
      stats.edges++;
    } catch (e) {
      stats.errors++;
    }
  }

  // 2. Task blockers → blocked_by edge
  const tasks = await db.query(`
    SELECT * FROM entities WHERE entity_type = 'task'
  `);

  for (const task of tasks) {
    const currentJson = JSON.parse(task.current_json);
    if (currentJson.blockers) {
      // ... edge 생성
    }
  }

  return stats;
}
```

**작업 항목**:
- [ ] evidence_json → edge 변환
- [ ] Task blockers → edge 변환
- [ ] 변환 통계 리포트
- [ ] 롤백 스크립트

### 5.2 이중 쓰기 기간

```typescript
// 마이그레이션 기간 동안 JSON과 edge 모두 기록
async function createBlockerWithDualWrite(
  taskId: string,
  blockers: BlockerRef[]
): Promise<void> {
  // 1. 기존 방식: current_json에 blockers 저장
  await entityRepo.updateCurrentState(taskId, { blockers });

  // 2. 신규 방식: edge 생성
  for (const b of blockers) {
    await edgeRepo.create({ ... });
  }
}
```

**작업 항목**:
- [ ] 이중 쓰기 래퍼 함수
- [ ] 마이그레이션 완료 후 JSON 쓰기 제거

## 파일 목록

### 신규 파일
```
src/core/edge-repo.ts         # Edge CRUD
src/core/queries.ts           # 복합 쿼리 함수
scripts/migrate-to-edges.ts   # 마이그레이션 스크립트
```

### 수정 파일
```
src/core/types.ts             # Edge 타입 추가
src/core/task-projector.ts    # Edge 생성 연동
src/core/graduation.ts        # Evidence edge 생성
```

## 테스트

### 필수 테스트 케이스

1. **Edge 생성 유효성**
   ```typescript
   // 유효한 조합
   await edgeRepo.create({
     srcType: 'entry', relType: 'evidence_of', dstType: 'entity', ...
   }); // OK

   // 무효한 조합
   await edgeRepo.create({
     srcType: 'entry', relType: 'blocked_by', dstType: 'entry', ...
   }); // Error
   ```

2. **중복 방지**
   ```typescript
   await edgeRepo.create({ srcId: 'a', dstId: 'b', relType: 'evidence_of', ... });
   await edgeRepo.create({ srcId: 'a', dstId: 'b', relType: 'evidence_of', ... });
   // 두 번째는 무시 또는 에러
   ```

3. **replace 동작**
   ```typescript
   await edgeRepo.replaceBySrc('task1', 'blocked_by', [
     { dstId: 'blocker1' },
     { dstId: 'blocker2' }
   ]);
   // 기존 blocked_by edge 모두 삭제 후 새로 생성
   ```

4. **Effective blockers**
   ```typescript
   // Condition → Task로 resolve된 경우
   // v_task_blockers_effective에서 Task가 effective blocker로 나와야 함
   ```

## 마일스톤

| 단계 | 완료 기준 |
|------|----------|
| M1 | 타입 정의 + edges 테이블 생성 |
| M2 | EdgeRepository 기본 CRUD |
| M3 | v_task_blockers_effective 뷰 |
| M4 | TaskProjector edge 연동 |
| M5 | Evidence edge 생성 |
| M6 | 마이그레이션 스크립트 |
| M7 | 테스트 통과 |
