# Task Entity System Context

> **Version**: 1.0.0
> **Created**: 2026-01-31

## 1. 배경

### 1.1 기존 설계의 한계

현재 code-memory 시스템에서 Task는 `entries` 테이블에 저장되는 불변 기록으로 관리됩니다:

```typescript
// 기존: entries 테이블에 Task를 저장
{
  entry_id: "ent_abc123",
  entry_type: "task",
  title: "벡터 검색 구현",
  content_json: { status: "in_progress", ... }
}
```

**문제점**:

1. **세션 A**에서 "벡터 검색 구현" Task 생성 → `ent_abc123`
2. **세션 B**에서 같은 Task 언급 → `ent_def456` (새 entry 생성!)
3. **세션 C**에서 "완료" 언급 → `ent_ghi789` (또 새 entry!)

결과: 하나의 Task가 3개의 분리된 entry로 존재하며, 상태 추적 불가

### 1.2 해결 방향

**Entry와 Entity 분리**:

| 구분 | Entry | Entity |
|------|-------|--------|
| 특성 | 불변 기록 | 상태 변화 개체 |
| 예시 | Fact, Decision, Insight | Task, Condition, Artifact |
| 생명주기 | 생성 후 변경 없음 | 이벤트로 상태 변화 |
| 식별 | UUID | canonical_key |

## 2. Memo.txt 참고 사항

### 2.1 핵심 원칙 (섹션 2)

> **5. Task는 entity**
> - Task 상태(status/priority/blockers)는 이벤트 fold 결과로 계산
> - 세션마다 Task entry를 새로 만들지 말고, 기존 task entity를 찾아 업데이트

### 2.2 DB 스키마 (섹션 4.3)

```sql
CREATE TABLE entities (
  entity_id      VARCHAR PRIMARY KEY,
  entity_type    VARCHAR NOT NULL,       -- task|condition|artifact
  canonical_key  VARCHAR NOT NULL,
  title          VARCHAR NOT NULL,
  stage          VARCHAR NOT NULL,
  status         VARCHAR NOT NULL,
  current_json   JSON NOT NULL,
  ...
);
```

### 2.3 Task 이벤트 타입 (섹션 7.2)

- `task_created`
- `task_status_changed`
- `task_priority_changed`
- `task_blockers_set` (mode=replace|suggest)
- `task_transition_rejected`

### 2.4 BlockerResolver 규칙 (섹션 7.3)

1. 강한 ID/URL/키 패턴 → artifact로 get-or-create
2. 명시 task_id → task로 연결
3. Task 제목 매칭 실패 → **condition으로 fallback** (스텁 Task 생성 금지)

## 3. Idris2 영감 적용

### 3.1 의존적 타입 개념

**Idris2의 Vector 타입**:
```idris
-- 길이가 타입에 인코딩됨
data Vect : Nat -> Type -> Type where
  Nil  : Vect 0 a
  (::) : a -> Vect n a -> Vect (S n) a
```

**TypeScript 적용**:
```typescript
// 상태에 따라 blockers 필드 타입이 달라짐
type TaskState =
  | { status: 'blocked'; blockers: BlockerRef[] }  // 필수, 1개 이상
  | { status: 'done'; blockers?: never };          // 없어야 함
```

### 3.2 불변식 (Invariants)

**Idris2에서**:
```idris
-- 타입 시스템이 강제
nonEmptyBlockers : (t : Task) -> t.status = Blocked -> NonEmpty t.blockers
```

**TypeScript + Zod에서**:
```typescript
// 런타임 검증
const BlockedTaskSchema = z.object({
  status: z.literal('blocked'),
  blockers: z.array(BlockerRefSchema).min(1)  // 최소 1개 강제
});
```

### 3.3 왜 실제 Idris2를 사용하지 않는가?

**Memo.txt 섹션 11**:
> "지금은 Python 쪽 구현이 핵심이므로, Idris는 Candidate/Verified 래퍼 기반으로만 최소 수정"

**실용적 이유**:

1. **학습 곡선**: 팀원 모두가 Idris2를 학습해야 함
2. **도구 체인**: idris2 컴파일러 설치/관리 필요
3. **통합 복잡도**: TypeScript ↔ Idris2 FFI 오버헤드
4. **디버깅**: 두 언어 간 스택 트레이스 추적 어려움

**TypeScript로 충분한 이유**:

1. **Discriminated Union**: 상태별 타입 분리 가능
2. **Zod**: 런타임 검증으로 불변식 강제
3. **타입 가드**: 조건부 타입 narrowing
4. **생태계**: 풍부한 라이브러리와 도구

## 4. 기존 코드와의 관계

### 4.1 types.ts

현재 정의된 타입 활용:

```typescript
// 기존
export type MatchConfidence = 'high' | 'suggested' | 'none';
export const MATCH_THRESHOLDS = {
  minCombinedScore: 0.92,
  minGap: 0.03,
  suggestionThreshold: 0.75
};

// 확장
export type EntityType = 'task' | 'condition' | 'artifact';
export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
```

### 4.2 canonical-key.ts

현재 함수 확장:

```typescript
// 기존: 이벤트용 canonical key
export function makeCanonicalKey(title: string, context?: {...}): string;

// 확장: 엔티티 타입별 canonical key
export function makeEntityCanonicalKey(
  entityType: EntityType,
  identifier: string,
  context?: { project?: string }
): string {
  switch (entityType) {
    case 'task':
      return `task:${context?.project ?? 'default'}:${normalize(identifier)}`;
    case 'condition':
      return `cond:${context?.project ?? 'default'}:${normalize(identifier)}`;
    case 'artifact':
      return makeArtifactKey(identifier);
  }
}
```

### 4.3 event-store.ts

현재 EventStore 활용:

```typescript
// 기존 append 메서드 재활용
// Task 이벤트도 동일하게 append-only로 저장
const event = {
  eventType: 'task_created',
  sessionId,
  content: JSON.stringify(payload),
  ...
};
await eventStore.append(event);
```

### 4.4 matcher.ts

현재 Matcher 로직 확장:

```typescript
// 기존: 이벤트 매칭
export class Matcher {
  matchSearchResults(results: SearchResult[]): MatchResult;
}

// 확장: Task 매칭에도 동일 로직 적용
export class TaskMatcher {
  // MATCH_THRESHOLDS 재활용
  findSimilar(title: string, project: string): MatchResult;
}
```

## 5. 경계 조건

### 5.1 Unknown Blocker 처리

```typescript
// Task가 blocked인데 blockedBy가 비어있으면
if (task.status === 'blocked' && blockedByTexts.length === 0) {
  // 자동으로 placeholder condition 생성
  const placeholder = await createCondition({
    text: `Unknown blocker for ${task.title}`,
    meta: { auto_placeholder: true }
  });
  blockers.push({ kind: 'condition', entity_id: placeholder.id });
}
```

### 5.2 상태 전이 거부

```typescript
// pending → done 직접 전이 시
if (from === 'pending' && to === 'done') {
  // task_transition_rejected 이벤트 발행
  await eventStore.append({
    eventType: 'task_transition_rejected',
    content: JSON.stringify({
      task_id: task.id,
      from_status: 'pending',
      to_status: 'done',
      reason: 'Direct transition from pending to done is not allowed'
    })
  });

  // in_progress로 보정
  return 'in_progress';
}
```

### 5.3 Condition → Task 해결

```typescript
// 나중에 "API 키 설정됨" condition이 실제 Task로 식별되면
await eventStore.append({
  eventType: 'condition_resolved_to',
  content: JSON.stringify({
    condition_id: 'cond_xyz',
    resolved_to: { kind: 'task', entity_id: 'task_abc' }
  })
});
```

## 6. 성능 고려사항

### 6.1 캐싱

```typescript
// Entity 조회 캐시 (LRU)
const entityCache = new LRUCache<string, Entity>({
  max: 1000,
  ttl: 1000 * 60 * 5  // 5분
});
```

### 6.2 배치 처리

```typescript
// Projector는 배치로 이벤트 처리
const BATCH_SIZE = 100;
const events = await eventStore.fetchSince(offset, { limit: BATCH_SIZE });
```

### 6.3 인덱스 활용

```sql
-- FTS 검색용
CREATE INDEX idx_entities_search ON entities USING GIN(to_tsvector('english', search_text));

-- canonical_key 조회용
CREATE INDEX idx_entities_type_key ON entities(entity_type, canonical_key);
```

## 7. 참고 자료

- **Memo.txt**: AxiomMind Memory Graduation Pipeline 지시서
- **spec.md**: `src/core/types.ts` - 기존 타입 정의
- **AXIOMMIND 원칙**: Principle 5 - Task는 Entity
- **Idris2 개념**: Dependent types, Linear types
