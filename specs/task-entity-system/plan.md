# Task Entity System Implementation Plan

> **Version**: 1.0.0
> **Status**: Draft
> **Created**: 2026-01-31

## Phase 1: 기반 구조 (P0)

### 1.1 타입 정의

**파일**: `src/core/types.ts` 수정

```typescript
// 추가할 타입들
export const EntityTypeSchema = z.enum(['task', 'condition', 'artifact']);
export type EntityType = z.infer<typeof EntityTypeSchema>;

export const TaskStatusSchema = z.enum(['pending', 'in_progress', 'blocked', 'done', 'cancelled']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskEventTypeSchema = z.enum([
  'task_created',
  'task_status_changed',
  'task_priority_changed',
  'task_blockers_set',
  'task_transition_rejected'
]);
```

**작업 항목**:
- [ ] EntityType, TaskStatus 스키마 추가
- [ ] TaskEvent 타입 정의
- [ ] BlockerRef 타입 정의
- [ ] TaskState Discriminated Union 정의

### 1.2 DB 스키마 추가

**파일**: `src/core/schema.sql` 수정

**작업 항목**:
- [ ] entities 테이블 생성
- [ ] entity_aliases 테이블 생성
- [ ] edges 테이블 생성
- [ ] 인덱스 추가

### 1.3 Canonical Key 확장

**파일**: `src/core/canonical-key.ts` 수정

```typescript
// 추가할 함수
export function makeEntityCanonicalKey(
  entityType: EntityType,
  identifier: string,
  context?: { project?: string }
): string;
```

**작업 항목**:
- [ ] Task canonical key 함수
- [ ] Condition canonical key 함수
- [ ] Artifact canonical key 함수 (URL, JIRA, GitHub 패턴)

## Phase 2: 핵심 컴포넌트 (P0)

### 2.1 EntityRepository

**파일**: `src/core/entity-repo.ts` (신규)

```typescript
export class EntityRepository {
  constructor(private db: Database);

  // CRUD (Create, Read만 - append-only 철학)
  async create(entity: EntityInput): Promise<Entity>;
  async findById(entityId: string): Promise<Entity | null>;
  async findByCanonicalKey(type: EntityType, key: string): Promise<Entity | null>;

  // 검색
  async findSimilar(type: EntityType, searchText: string): Promise<Entity[]>;

  // Alias 관리
  async addAlias(entityId: string, alias: string): Promise<void>;
  async resolveAlias(type: EntityType, alias: string): Promise<string | null>;

  // 상태 업데이트 (이벤트 발행 후 projector가 호출)
  async updateCurrentState(entityId: string, state: EntityState): Promise<void>;
}
```

**작업 항목**:
- [ ] EntityRepository 클래스 구현
- [ ] findByCanonicalKey 구현
- [ ] findSimilar 구현 (FTS 활용)
- [ ] alias 관리 메서드 구현

### 2.2 TaskMatcher

**파일**: `src/core/task-matcher.ts` (신규)

```typescript
export class TaskMatcher {
  constructor(
    private entityRepo: EntityRepository,
    private vectorStore: VectorStore
  );

  async findExact(canonicalKey: string): Promise<Task | null>;
  async findSimilar(title: string, project: string): Promise<MatchResult>;
  async suggestCandidates(title: string, project: string, limit?: number): Promise<Task[]>;
}
```

**작업 항목**:
- [ ] 정확 매칭 (entity_aliases 활용)
- [ ] FTS 기반 유사 매칭
- [ ] Vector 기반 semantic 매칭
- [ ] 점수 계산 (stage weight, status weight, recency)
- [ ] strict 확정 로직 (score >= 0.92, gap >= 0.03)

### 2.3 BlockerResolver

**파일**: `src/core/blocker-resolver.ts` (신규)

**작업 항목**:
- [ ] URL/JIRA/GitHub 패턴 감지
- [ ] Artifact get-or-create 로직
- [ ] Task 제목 매칭 시도
- [ ] Condition fallback 생성
- [ ] candidates 저장 로직

### 2.4 TaskResolver

**파일**: `src/core/task-resolver.ts` (신규)

**작업 항목**:
- [ ] Task entry 처리 로직
- [ ] 기존 Task 찾기 (TaskMatcher 활용)
- [ ] 이벤트 발행 로직
- [ ] 상태 전이 검증
- [ ] blockers 정규화 (BlockerResolver 활용)

## Phase 3: Projection (P0)

### 3.1 TaskProjector

**파일**: `src/core/task-projector.ts` (신규)

```typescript
export class TaskProjector {
  constructor(
    private eventStore: EventStore,
    private entityRepo: EntityRepository,
    private edgeRepo: EdgeRepository
  );

  async projectIncremental(): Promise<ProjectionResult>;
  async rebuild(): Promise<void>;

  private async handleTaskCreated(event: TaskEvent): Promise<void>;
  private async handleStatusChanged(event: TaskEvent): Promise<void>;
  private async handleBlockersSet(event: TaskEvent): Promise<void>;
}
```

**작업 항목**:
- [ ] projection_offsets 관리
- [ ] 증분 이벤트 읽기
- [ ] 이벤트 타입별 핸들러
- [ ] mode=replace 처리 (기존 edge 삭제 + 새 edge 삽입)
- [ ] mode=suggest 처리 (suggested edge만)
- [ ] current_json 갱신

### 3.2 EdgeRepository

**파일**: `src/core/edge-repo.ts` (신규)

```typescript
export class EdgeRepository {
  async createEdge(edge: EdgeInput): Promise<Edge>;
  async findEdges(srcId: string, relType?: string): Promise<Edge[]>;
  async deleteEdges(srcId: string, relType: string): Promise<number>;
  async replaceEdges(srcId: string, relType: string, newEdges: EdgeInput[]): Promise<void>;
}
```

**작업 항목**:
- [ ] Edge CRUD 구현
- [ ] 관계 타입별 조회
- [ ] replace 로직 (트랜잭션)

## Phase 4: 통합 (P0)

### 4.1 Graduation Pipeline 연동

**파일**: `src/core/graduation.ts` 수정

**작업 항목**:
- [ ] Task entry 처리 시 TaskResolver 호출
- [ ] 이벤트 발행 후 TaskProjector 호출
- [ ] evidence edge 생성 로직

### 4.2 EventStore 확장

**파일**: `src/core/event-store.ts` 수정

**작업 항목**:
- [ ] Task 이벤트 타입 지원
- [ ] fetch_since 메서드 추가 (projector용)
- [ ] replay 메서드 추가 (rebuild용)

## Phase 5: CLI 및 조회 (P1)

### 5.1 조회 API

**작업 항목**:
- [ ] list_blocked_tasks()
- [ ] list_tasks_with_only_suggested_blockers()
- [ ] get_task_detail(task_id)
- [ ] v_task_blockers_effective 뷰

### 5.2 CLI 커맨드

**파일**: `src/cli/index.ts` 수정

**작업 항목**:
- [ ] `cli blocked` - blocked task 목록
- [ ] `cli task show <task_id>` - task 상세
- [ ] `cli tasks --status <status>` - 상태별 목록

## 파일 목록

### 신규 파일
```
src/core/entity-repo.ts
src/core/edge-repo.ts
src/core/task-matcher.ts
src/core/blocker-resolver.ts
src/core/task-resolver.ts
src/core/task-projector.ts
```

### 수정 파일
```
src/core/types.ts
src/core/canonical-key.ts
src/core/event-store.ts
src/core/graduation.ts
src/cli/index.ts
```

## 테스트

### 필수 테스트 케이스

1. **Task 동일성**
   - 같은 제목의 Task가 여러 세션에서 언급되어도 하나의 Entity로 관리

2. **상태 전이**
   - pending → done 직접 전이 시 에러
   - blocked 상태에서 blockers가 비어있으면 에러

3. **Idempotency**
   - 동일 세션 재처리 시 중복 이벤트 없음
   - 동일 edge 중복 생성 없음

4. **Blocker 해결**
   - URL → Artifact 정상 생성
   - Task 제목 매칭 실패 → Condition 생성 + candidates 저장

## 의존성 그래프

```
types.ts
    │
    ├── entity-repo.ts
    │       │
    │       ├── task-matcher.ts
    │       │
    │       └── edge-repo.ts
    │               │
    │               └── task-projector.ts
    │
    ├── blocker-resolver.ts ─────────┐
    │                                │
    └── task-resolver.ts ◀───────────┘
            │
            └── graduation.ts
```

## 마일스톤

| 단계 | 완료 기준 |
|------|----------|
| M1 | 타입 정의 + DB 스키마 |
| M2 | EntityRepo + EdgeRepo 동작 |
| M3 | TaskMatcher 동작 (정확 매칭만) |
| M4 | BlockerResolver + TaskResolver 동작 |
| M5 | TaskProjector 동작 (증분 처리) |
| M6 | Graduation 연동 완료 |
| M7 | CLI 조회 커맨드 완료 |
