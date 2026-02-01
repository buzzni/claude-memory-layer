# Vector Outbox V2 Context

> **Version**: 2.0.0
> **Created**: 2026-01-31

## 1. 배경

### 1.1 분산 시스템의 정합성 문제

두 개의 서로 다른 저장소(DuckDB, LanceDB)에 데이터를 저장할 때:

```
Application
    │
    ├──▶ DuckDB (entries 저장) ✓
    │
    └──▶ LanceDB (벡터 저장) ✗ (실패)

결과: DuckDB에는 있지만 LanceDB에는 없는 불일치 상태
```

**문제 시나리오**:
1. Entry가 저장되었지만 임베딩이 실패
2. 재시작 시 어떤 entry가 임베딩되지 않았는지 알 수 없음
3. 검색 결과에서 해당 entry가 누락

### 1.2 Transactional Outbox Pattern

마이크로서비스 아키텍처에서 검증된 패턴:

```
┌─────────────────────────────────────┐
│ DuckDB Transaction                   │
│                                      │
│  1. INSERT INTO entries (...)        │
│  2. INSERT INTO vector_outbox (...)  │
│                                      │
│  COMMIT                              │
└─────────────────────────────────────┘
            │
            │ (비동기)
            ▼
┌─────────────────────────────────────┐
│ Vector Worker                        │
│                                      │
│  1. SELECT * FROM vector_outbox      │
│     WHERE status = 'pending'         │
│  2. Generate embedding               │
│  3. Upsert to LanceDB                │
│  4. UPDATE status = 'done'           │
└─────────────────────────────────────┘
```

**장점**:
- 원자성 보장 (DuckDB 트랜잭션 내)
- 실패 시 재시도 가능
- 상태 추적 가능

## 2. Memo.txt 참고 사항

### 2.1 핵심 원칙 (섹션 2.6)

> **6. Vector store 정합성**
> - DuckDB에 먼저 기록 → outbox → 단일 writer가 LanceDB에 upsert → DuckDB 상태 업데이트

### 2.2 스키마 (섹션 4.4)

```sql
CREATE TABLE vector_outbox (
  job_id            VARCHAR PRIMARY KEY,
  item_kind         VARCHAR NOT NULL,        -- entry|task_title
  item_id           VARCHAR NOT NULL,
  embedding_version VARCHAR NOT NULL,
  status            VARCHAR NOT NULL,        -- pending|done|failed
  error             VARCHAR,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(item_kind, item_id, embedding_version)
);
```

### 2.3 Worker 지시 (섹션 8)

**Outbox enqueue**:
- entry materialized 시: `item_kind='entry'`
- task_created/task_title_changed 시: `item_kind='task_title'`

**Single writer worker**:
- pending 배치 처리
- LanceDB **idempotent upsert**
- 같은 id는 중복 row가 쌓이지 않게

**reconcile()**:
- pending 재처리
- failed는 재시도 정책

## 3. Idris2 영감 적용

### 3.1 상태 머신 타입 안전성

**Idris2 개념**:
```idris
-- 상태 전이가 타입 수준에서 정의됨
data OutboxState = Pending | Processing | Done | Failed

data Transition : OutboxState -> OutboxState -> Type where
  Claim    : Transition Pending Processing
  Complete : Transition Processing Done
  Fail     : Transition Processing Failed
  Retry    : Transition Failed Pending
```

**TypeScript 적용**:
```typescript
// 유효한 전이만 타입으로 정의
type ValidTransition =
  | { from: 'pending'; to: 'processing' }
  | { from: 'processing'; to: 'done' }
  | { from: 'processing'; to: 'failed' }
  | { from: 'failed'; to: 'pending' };

// 런타임 검증
function assertValidTransition(from: OutboxStatus, to: OutboxStatus): void {
  const valid: ValidTransition[] = [...];
  if (!valid.some(t => t.from === from && t.to === to)) {
    throw new Error(`Invalid transition: ${from} → ${to}`);
  }
}
```

### 3.2 Idempotency 증명

**Idris2 개념**:
```idris
-- 같은 입력에 같은 결과
idempotent : (f : a -> a) -> Type
idempotent f = (x : a) -> f (f x) = f x
```

**TypeScript 적용**:
```typescript
// UNIQUE 제약으로 idempotency 보장
const UNIQUE_CONSTRAINT = `
  UNIQUE(item_kind, item_id, embedding_version)
`;

// enqueue는 여러 번 호출해도 같은 결과
async function enqueue(input: EnqueueInput): Promise<EnqueueResult> {
  await db.run(`
    INSERT INTO vector_outbox (...)
    ON CONFLICT (item_kind, item_id, embedding_version)
    DO NOTHING
  `, [...]);
  // 결과는 항상 동일: 하나의 job만 존재
}
```

### 3.3 벡터 upsert 증명

```typescript
// upsert 후 조건: 정확히 하나의 레코드만 존재
interface UpsertInvariant {
  // Pre: record with id=X may or may not exist
  // Post: exactly one record with id=X exists, with latest values
}

async function upsert(record: VectorRecord): Promise<void> {
  // Delete existing (if any)
  await table.delete(`id = '${record.id}'`);
  // Insert new
  await table.add([record]);
  // Invariant: exactly one record with id exists
}
```

## 4. 기존 코드와의 관계

### 4.1 현재 vector-worker.ts

```typescript
// 현재 구현 (src/core/vector-worker.ts)
export class VectorWorker {
  private embedder: Embedder;
  private vectorStore: VectorStore;
  private db: Database;
}

export interface OutboxItem {
  id: string;
  eventId: string;
  content: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  retryCount: number;
  createdAt: Date;
  errorMessage?: string;
}
```

### 4.2 V2 확장 포인트

| 기존 | V2 확장 |
|-----|---------|
| eventId 기반 | item_kind + item_id |
| 단순 status | embedding_version 추가 |
| 재시도 없음 | reconcile + retry policy |
| 중복 가능 | UNIQUE + upsert |

### 4.3 현재 types.ts

```typescript
// 현재 OutboxItem 정의
export interface OutboxItem {
  id: string;
  eventId: string;
  content: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  retryCount: number;
  createdAt: Date;
  errorMessage?: string;
}
```

V2에서 OutboxJob으로 확장.

## 5. 설계 결정 사항

### 5.1 왜 embedding_version을 포함하는가?

**시나리오**:
1. 모델 v1으로 entry A 임베딩
2. 모델 v2로 업그레이드
3. entry A를 v2로 재임베딩 필요

**해결**:
```sql
-- v1과 v2 job이 별도로 존재 가능
UNIQUE(item_kind, item_id, embedding_version)

-- v1 job
(job_1, 'entry', 'e1', 'minilm-v1', 'done')

-- v2 job
(job_2, 'entry', 'e1', 'minilm-v2', 'pending')
```

### 5.2 왜 단일 writer인가?

**문제**: 여러 프로세스가 동시에 LanceDB에 쓰면
- 동일 id에 대해 race condition
- delete와 add 사이에 다른 write 끼어들 수 있음
- LanceDB 자체 락 메커니즘 미약

**해결**:
- 애플리케이션 레벨에서 단일 writer 보장
- 파일 락 또는 DB 락 사용

### 5.3 왜 delete + add인가?

LanceDB가 true upsert를 지원하지 않기 때문:

```typescript
// 방법 1: update 시도 (LanceDB 제한적 지원)
await table.update({ id: 'e1' }, { vector: newVector });  // 불완전

// 방법 2: delete + add (권장)
await table.delete(`id = 'e1'`);
await table.add([{ id: 'e1', vector: newVector, ... }]);  // 확실
```

## 6. Reconcile 전략

### 6.1 Failed Job 재시도

```typescript
const RETRY_POLICY = {
  maxRetries: 3,
  backoffMs: [1000, 5000, 30000]  // 1초, 5초, 30초
};

async function shouldRetry(job: OutboxJob): Promise<boolean> {
  return job.retryCount < RETRY_POLICY.maxRetries;
}

async function reconcileFailed(): Promise<number> {
  return db.run(`
    UPDATE vector_outbox
    SET status = 'pending',
        retry_count = retry_count + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'failed'
      AND retry_count < ?
  `, [RETRY_POLICY.maxRetries]);
}
```

### 6.2 Stuck Job 복구

Processing 상태에서 worker가 죽으면:

```typescript
const STUCK_THRESHOLD_MS = 5 * 60 * 1000;  // 5분

async function recoverStuck(): Promise<number> {
  const threshold = new Date(Date.now() - STUCK_THRESHOLD_MS);
  return db.run(`
    UPDATE vector_outbox
    SET status = 'pending',
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'processing'
      AND updated_at < ?
  `, [threshold]);
}
```

### 6.3 Done Job 정리

저장 공간 관리:

```typescript
async function cleanupDone(olderThanDays: number = 7): Promise<number> {
  return db.run(`
    DELETE FROM vector_outbox
    WHERE status = 'done'
      AND updated_at < datetime('now', '-${olderThanDays} days')
  `);
}
```

## 7. 모니터링 및 알림

### 7.1 메트릭

```typescript
interface OutboxMetrics {
  pendingCount: number;
  processingCount: number;
  doneCount: number;
  failedCount: number;
  avgProcessingTimeMs: number;
  oldestPendingAge: number;  // 가장 오래된 pending job의 나이 (ms)
}
```

### 7.2 알림 조건

```typescript
const ALERT_THRESHOLDS = {
  failedCount: 10,           // failed가 10개 이상
  pendingAge: 60 * 60 * 1000 // pending이 1시간 이상 된 경우
};

async function checkAlerts(): Promise<Alert[]> {
  const metrics = await getMetrics();
  const alerts: Alert[] = [];

  if (metrics.failedCount >= ALERT_THRESHOLDS.failedCount) {
    alerts.push({
      level: 'warning',
      message: `${metrics.failedCount} vector jobs failed`
    });
  }

  if (metrics.oldestPendingAge >= ALERT_THRESHOLDS.pendingAge) {
    alerts.push({
      level: 'warning',
      message: `Oldest pending job is ${metrics.oldestPendingAge / 1000}s old`
    });
  }

  return alerts;
}
```

## 8. 에러 처리

### 8.1 임베딩 실패

```typescript
try {
  const embedding = await embedder.embed(content);
} catch (error) {
  if (error.message.includes('rate limit')) {
    // 재시도 가능
    throw new RetryableError('Rate limited', { retryAfterMs: 60000 });
  } else if (error.message.includes('too long')) {
    // 영구 실패
    throw new PermanentError('Content too long for embedding');
  }
  throw error;
}
```

### 8.2 LanceDB 실패

```typescript
try {
  await vectorStore.upsert(record);
} catch (error) {
  if (error.message.includes('disk full')) {
    throw new PermanentError('Disk full');
  } else if (error.message.includes('connection')) {
    throw new RetryableError('Connection failed');
  }
  throw error;
}
```

### 8.3 콘텐츠 없음

```typescript
const content = await getContent(job.itemKind, job.itemId);
if (!content) {
  // Entry가 삭제되었거나 존재하지 않음
  // Job을 done으로 마크하고 건너뜀
  await markDone(job.jobId, { skipped: true, reason: 'content_not_found' });
  return;
}
```

## 9. 성능 고려사항

### 9.1 배치 처리

```typescript
const BATCH_SIZE = 50;

// 한 번에 여러 job claim
const jobs = await claimJobs(BATCH_SIZE);

// 임베딩도 배치로
const contents = jobs.map(j => j.content);
const embeddings = await embedder.embedBatch(contents);

// LanceDB 배치 insert
await vectorStore.addBatch(jobs.map((j, i) => ({
  id: j.itemId,
  vector: embeddings[i],
  ...
})));
```

### 9.2 병렬 처리 (주의)

```typescript
// 단일 writer 내에서 병렬 처리
// LanceDB 쓰기는 순차적으로, 임베딩은 병렬로

const jobs = await claimJobs(BATCH_SIZE);

// 임베딩 병렬 생성
const embeddings = await Promise.all(
  jobs.map(async (job) => {
    const content = await getContent(job.itemKind, job.itemId);
    return embedder.embed(content);
  })
);

// LanceDB 순차 쓰기
for (let i = 0; i < jobs.length; i++) {
  await vectorStore.upsert({ id: jobs[i].itemId, vector: embeddings[i], ... });
  await markDone(jobs[i].jobId);
}
```

## 10. 참고 자료

- **Memo.txt**: 섹션 8 - Vector Outbox + LanceDB writer 구현 지시
- **현재 구현**: `src/core/vector-worker.ts`
- **Transactional Outbox**: 마이크로서비스 패턴
- **AXIOMMIND**: Principle 6 - 벡터 정합성
