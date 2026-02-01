# Task Entity System Specification

> **Version**: 1.0.0
> **Status**: Draft
> **Created**: 2026-01-31

## 1. 개요

### 1.1 문제 정의

현재 시스템에서 Task는 세션별로 entry(기록)로 저장되어 다음 문제가 발생:

1. **중복 생성**: 같은 Task가 여러 세션에서 언급될 때마다 새 entry 생성
2. **상태 단절**: Task 상태 변경 이력이 세션 단위로 분리되어 추적 불가
3. **관계 손실**: Task 간 blockedBy 관계가 세션 경계에서 단절

### 1.2 해결 방향

**Task를 Entity로 승격**:
- Task는 고유한 Entity로 관리 (entries와 분리된 entities 테이블)
- 상태 변경은 이벤트로 기록 (event-sourced)
- fold 연산으로 현재 상태 계산

## 2. 핵심 개념

### 2.1 Entity vs Entry

| 구분 | Entry (기존) | Entity (신규) |
|------|-------------|--------------|
| 정의 | 세션에서 추출된 불변 기록 | 시간에 따라 상태가 변화하는 개체 |
| 예시 | Fact, Decision, Insight | Task, Condition, Artifact |
| 식별 | entry_id (UUID) | entity_id + canonical_key |
| 상태 | 불변 (created once) | 이벤트 fold로 계산 |

### 2.2 Canonical Key

Entity의 동일성을 판단하는 정규화된 키:

```typescript
// Task
task:{project}:{normalize(title)}
// 예: task:code-memory:implement-vector-search

// Condition
cond:{project}:{normalize(text)}
// 예: cond:code-memory:api-key-configured

// Artifact
art:url:{sha1(url)}           // URL
art:jira:{key}                // JIRA
art:gh_issue:{repo}:{num}     // GitHub Issue
```

### 2.3 Task 상태 머신

```
         ┌─────────────────────────────────────┐
         │                                     │
         ▼                                     │
    ┌─────────┐     ┌───────────┐     ┌────────┴───┐
    │ pending │────▶│in_progress│────▶│   done     │
    └────┬────┘     └─────┬─────┘     └────────────┘
         │                │
         │                ▼
         │          ┌──────────┐
         └─────────▶│ blocked  │
                    └──────────┘
                         │
                         │ (blockers 해결 시)
                         ▼
                    ┌──────────┐
                    │in_progress│
                    └──────────┘
```

**불변식 (Invariants)**:
- `blocked` 상태면 `blockers[]` 비어있으면 안 됨
- `done` 상태면 `blockers[]` 비어있어야 함
- `pending` → `done` 직접 전이 금지 (in_progress 거쳐야 함)

## 3. 이벤트 타입

### 3.1 Task 이벤트

```typescript
type TaskEventType =
  | 'task_created'           // 신규 생성
  | 'task_status_changed'    // 상태 변경
  | 'task_priority_changed'  // 우선순위 변경
  | 'task_blockers_set'      // blockers 설정/변경
  | 'task_transition_rejected'; // 전이 거부 (디버깅용)
```

### 3.2 이벤트 페이로드 스키마

```typescript
// task_created
interface TaskCreatedPayload {
  task_id: string;
  canonical_key: string;
  title: string;
  initial_status: 'pending' | 'in_progress'; // done 금지
  priority?: 'low' | 'medium' | 'high' | 'critical';
  source_entry_id: string;
}

// task_status_changed
interface TaskStatusChangedPayload {
  task_id: string;
  from_status: TaskStatus;
  to_status: TaskStatus;
  reason?: string;
}

// task_blockers_set
interface TaskBlockersSetPayload {
  task_id: string;
  mode: 'replace' | 'suggest';
  blockers: BlockerRef[];
  source_entry_id?: string;
}
```

## 4. 컴포넌트 설계

### 4.1 TaskMatcher

기존 Task 찾기:

```typescript
interface TaskMatcher {
  // 정확한 매칭
  findExact(canonicalKey: string): Task | null;

  // 유사도 기반 매칭
  findSimilar(title: string, project: string): MatchResult;

  // 후보 목록 반환
  suggestCandidates(title: string, project: string, limit?: number): Task[];
}

// 매칭 조건 (strict 확정)
const STRICT_MATCH = {
  minScore: 0.92,
  minGap: 0.03,  // top1 - top2
  status: ['active'],  // cancelled 제외
  taskStatus: ['pending', 'in_progress', 'blocked']  // done 제외
};
```

### 4.2 BlockerResolver

blockedBy 텍스트를 Entity 참조로 변환:

```typescript
interface BlockerRef {
  kind: 'task' | 'condition' | 'artifact';
  entity_id: string;
  raw_text: string;
  confidence: 'high' | 'suggested' | 'none';
  candidates?: EntityRef[];  // confidence='none'일 때
}

interface BlockerResolver {
  resolve(
    blockedByTexts: string[],
    project: string,
    sourceEntryId: string
  ): Promise<BlockerRef[]>;
}
```

**해결 규칙**:
1. 강한 패턴 (URL, JIRA key) → Artifact로 get-or-create
2. 명시 task_id → Task 연결 (없으면 Condition으로 fallback)
3. Task 제목 매칭 실패 → Condition으로 생성 + candidates 저장
4. **스텁 Task 생성 금지** (중복 지옥 방지)

### 4.3 TaskResolver

세션에서 추출된 Task entry 처리:

```typescript
interface TaskResolver {
  processTaskEntry(entry: TaskEntry): Promise<{
    task_id: string;
    events: TaskEvent[];
    isNew: boolean;
  }>;
}
```

**처리 흐름**:
1. canonical_key로 기존 Task 찾기
2. 없으면 `task_created` 이벤트 발행
3. priority/status 변경 필요 시 이벤트 발행
4. blockers가 있으면 BlockerResolver로 정규화
5. evidenceAligned → `mode=replace`, 아니면 `mode=suggest`
6. `task_blockers_set` 이벤트 발행

### 4.4 TaskProjector

이벤트를 entities/edges에 반영:

```typescript
interface TaskProjector {
  // 증분 처리
  projectIncremental(): Promise<ProjectionResult>;

  // 전체 rebuild
  rebuild(): Promise<void>;
}
```

**mode=replace**:
- 기존 blocked_by edges 삭제
- 새 edges 삽입
- entities.current_json.blockers 갱신

**mode=suggest**:
- blocked_by_suggested edges만 insert/replace
- entities.current_json.blocker_suggestions 누적

## 5. DB 스키마

### 5.1 entities 테이블

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

CREATE INDEX idx_entities_type_key ON entities(entity_type, canonical_key);
CREATE INDEX idx_entities_status ON entities(status);
```

### 5.2 entity_aliases 테이블

동일 Entity의 여러 이름:

```sql
CREATE TABLE entity_aliases (
  entity_type   VARCHAR NOT NULL,
  canonical_key VARCHAR NOT NULL,
  entity_id     VARCHAR NOT NULL,
  is_primary    BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(entity_type, canonical_key)
);
```

## 6. Idris2 영감 적용

### 6.1 타입 레벨 보장 (TypeScript)

```typescript
// Discriminated Union으로 상태별 타입 분리
type TaskState =
  | { status: 'pending'; blockers?: never }
  | { status: 'in_progress'; blockers?: never }
  | { status: 'blocked'; blockers: BlockerRef[] }  // 비어있으면 안 됨
  | { status: 'done'; blockers?: never };

// 타입 가드
function isBlocked(task: TaskState): task is { status: 'blocked'; blockers: BlockerRef[] } {
  return task.status === 'blocked' && task.blockers.length > 0;
}
```

### 6.2 불변식 검증

```typescript
// Zod 스키마로 런타임 검증
const TaskInvariantSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('blocked'),
    blockers: z.array(BlockerRefSchema).min(1)  // 최소 1개
  }),
  z.object({
    status: z.literal('done'),
    blockers: z.array(BlockerRefSchema).max(0)  // 0개
  }),
  // ...
]);
```

### 6.3 왜 실제 Idris2를 사용하지 않는가?

**Memo.txt 지침** (섹션 11):
> "지금은 Python 쪽 구현이 핵심이므로, Idris는 Candidate/Verified 래퍼 기반으로만 최소 수정"

**실용적 이유**:
1. 팀 학습 곡선 최소화
2. 도구 체인 단순화 (idris2 설치/관리 불필요)
3. TypeScript + Zod로 충분한 타입 안전성 확보
4. 런타임 검증이 실제 버그 방지에 더 효과적

## 7. 성공 기준

- [ ] Task가 세션 간 동일성 유지 (canonical_key 기반)
- [ ] 상태 변경 이력이 이벤트로 추적 가능
- [ ] blockers가 Entity 참조로 정규화됨
- [ ] 불변식 위반 시 에러 발생 (blocked인데 blockers 비어있음 등)
- [ ] 기존 entry 시스템과 호환 유지
