# Vector Outbox V2 Specification

> **Version**: 2.0.0
> **Status**: Draft
> **Created**: 2026-01-31

## 1. 개요

### 1.1 문제 정의

DuckDB와 LanceDB 간 데이터 정합성 문제:

1. **원자성 부재**: DuckDB 쓰기와 LanceDB 쓰기가 별도 트랜잭션
2. **중복 벡터**: 재처리 시 같은 벡터가 중복 저장될 수 있음
3. **일관성**: DuckDB에는 있지만 LanceDB에는 없는 상태 발생
4. **동시성**: 여러 프로세스가 동시에 벡터 저장 시 충돌

### 1.2 해결 방향

**Transactional Outbox Pattern**:
1. DuckDB에 먼저 기록 (vector_outbox 테이블)
2. 단일 writer가 outbox를 처리하여 LanceDB에 upsert
3. 성공 시 outbox 상태 업데이트

## 2. 핵심 개념

### 2.1 Outbox 패턴 흐름

```
Application                 DuckDB                    LanceDB
    │                         │                          │
    │  1. Entry 저장           │                          │
    ├────────────────────────▶│                          │
    │                         │                          │
    │  2. Outbox job 생성      │                          │
    ├────────────────────────▶│                          │
    │                         │                          │
    │  (트랜잭션 커밋)          │                          │
    │                         │                          │
                        ┌─────┴─────┐
                        │  Worker   │
                        └─────┬─────┘
                              │                          │
                              │  3. pending job 조회      │
                              │◀────────────────────────│
                              │                          │
                              │  4. 임베딩 생성           │
                              │                          │
                              │  5. LanceDB upsert       │
                              │─────────────────────────▶│
                              │                          │
                              │  6. status='done' 업데이트 │
                              │────────────────────────▶│
```

### 2.2 Job 상태 머신

```
┌─────────┐     Worker 픽업      ┌────────────┐
│ pending │ ──────────────────▶ │ processing │
└─────────┘                     └──────┬─────┘
     │                                 │
     │ 재시도 (reconcile)              │
     │                                 │
     │         ┌───────────────────────┼───────────────────────┐
     │         │                       │                       │
     │         ▼                       ▼                       ▼
     │    ┌─────────┐            ┌──────────┐           ┌─────────┐
     └───▶│ pending │            │   done   │           │ failed  │
          └─────────┘            └──────────┘           └─────────┘
                                                              │
                                                              │ retry < max
                                                              ▼
                                                        ┌─────────┐
                                                        │ pending │
                                                        └─────────┘
```

### 2.3 Item 종류

```typescript
type ItemKind =
  | 'entry'           // entries 테이블의 content 임베딩
  | 'task_title'      // entities 테이블의 task 제목 임베딩
  | 'session_summary' // 세션 요약 임베딩
  ;
```

## 3. DB 스키마

### 3.1 vector_outbox 테이블

```sql
CREATE TABLE vector_outbox (
  job_id            VARCHAR PRIMARY KEY,
  item_kind         VARCHAR NOT NULL,        -- entry|task_title|session_summary
  item_id           VARCHAR NOT NULL,
  embedding_version VARCHAR NOT NULL,        -- e.g., 'v1.0.0', 'minilm-v2'
  status            VARCHAR NOT NULL,        -- pending|processing|done|failed
  retry_count       INTEGER DEFAULT 0,
  error             VARCHAR,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- 중복 방지: 같은 아이템+버전은 하나만
  UNIQUE(item_kind, item_id, embedding_version)
);

CREATE INDEX idx_outbox_status ON vector_outbox(status);
CREATE INDEX idx_outbox_created ON vector_outbox(created_at);
```

### 3.2 vector_store_meta 테이블 (선택)

```sql
-- LanceDB 테이블 메타데이터 추적
CREATE TABLE vector_store_meta (
  table_name        VARCHAR PRIMARY KEY,     -- e.g., 'entry_vectors_v1'
  embedding_version VARCHAR NOT NULL,
  item_count        INTEGER DEFAULT 0,
  last_sync_at      TIMESTAMP,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## 4. Outbox API

### 4.1 Enqueue

```typescript
interface OutboxEnqueueInput {
  itemKind: ItemKind;
  itemId: string;
  embeddingVersion: string;
}

interface VectorOutbox {
  // Job 추가 (중복 시 무시)
  enqueue(input: OutboxEnqueueInput): Promise<EnqueueResult>;

  // 배치 추가
  enqueueBatch(inputs: OutboxEnqueueInput[]): Promise<EnqueueResult[]>;
}

type EnqueueResult =
  | { success: true; jobId: string; isNew: true }
  | { success: true; jobId: string; isNew: false }  // 이미 존재
  | { success: false; error: string };
```

### 4.2 Process (Worker)

```typescript
interface VectorWorker {
  // pending job 가져오기 (락)
  claimJobs(limit: number): Promise<OutboxJob[]>;

  // 처리 완료 표시
  markDone(jobId: string): Promise<void>;

  // 실패 표시
  markFailed(jobId: string, error: string): Promise<void>;

  // 전체 처리 루프
  processAll(): Promise<ProcessResult>;
}

interface ProcessResult {
  processed: number;
  succeeded: number;
  failed: number;
  errors: { jobId: string; error: string }[];
}
```

### 4.3 Reconcile

```typescript
interface VectorOutbox {
  // 재시도 가능한 failed job을 pending으로 변경
  reconcileFailed(maxRetries: number): Promise<number>;

  // processing 상태로 오래 멈춘 job 복구
  recoverStuck(stuckThresholdMs: number): Promise<number>;

  // 완료된 job 정리
  cleanupDone(olderThanDays: number): Promise<number>;
}
```

## 5. 단일 Writer 패턴

### 5.1 왜 단일 Writer인가?

**문제**: 여러 프로세스가 동시에 LanceDB에 쓰면
- 충돌 발생 가능
- 중복 벡터 생성
- 트랜잭션 보장 어려움

**해결**: 하나의 worker만 LanceDB에 쓰기

```typescript
// 단일 writer 보장 방법들

// 방법 1: 프로세스 수준 락
const lockFile = '/tmp/vector-worker.lock';
if (fs.existsSync(lockFile)) {
  console.log('Another worker is running');
  process.exit(0);
}
fs.writeFileSync(lockFile, process.pid.toString());

// 방법 2: DB 수준 락
await db.run(`
  INSERT INTO worker_locks (worker_name, locked_at)
  VALUES ('vector_worker', CURRENT_TIMESTAMP)
  ON CONFLICT (worker_name)
  DO UPDATE SET locked_at = CURRENT_TIMESTAMP
  WHERE locked_at < datetime('now', '-5 minutes')
`);
```

### 5.2 Worker 구현

```typescript
class VectorWorkerImpl implements VectorWorker {
  private embedder: Embedder;
  private vectorStore: VectorStore;
  private db: Database;

  async processAll(): Promise<ProcessResult> {
    const result: ProcessResult = { processed: 0, succeeded: 0, failed: 0, errors: [] };

    while (true) {
      const jobs = await this.claimJobs(BATCH_SIZE);
      if (jobs.length === 0) break;

      for (const job of jobs) {
        try {
          await this.processJob(job);
          await this.markDone(job.jobId);
          result.succeeded++;
        } catch (error) {
          await this.markFailed(job.jobId, error.message);
          result.failed++;
          result.errors.push({ jobId: job.jobId, error: error.message });
        }
        result.processed++;
      }
    }

    return result;
  }

  private async processJob(job: OutboxJob): Promise<void> {
    // 1. 원본 콘텐츠 조회
    const content = await this.getContent(job.itemKind, job.itemId);

    // 2. 임베딩 생성
    const embedding = await this.embedder.embed(content);

    // 3. LanceDB upsert (idempotent)
    await this.vectorStore.upsert({
      id: job.itemId,
      vector: embedding,
      metadata: {
        itemKind: job.itemKind,
        embeddingVersion: job.embeddingVersion
      }
    });
  }
}
```

## 6. LanceDB Upsert 전략

### 6.1 Idempotent Upsert

```typescript
async function upsertVector(record: VectorRecord): Promise<void> {
  const table = await this.getTable(record.itemKind, record.embeddingVersion);

  // LanceDB에서 기존 레코드 확인
  const existing = await table
    .search([0])  // dummy search for filter
    .filter(`id = '${record.id}'`)
    .limit(1)
    .toArray();

  if (existing.length > 0) {
    // 업데이트: 삭제 후 재삽입
    await table.delete(`id = '${record.id}'`);
  }

  // 삽입
  await table.add([{
    id: record.id,
    vector: record.vector,
    content: record.content,
    timestamp: record.timestamp,
    metadata: record.metadata
  }]);
}
```

### 6.2 테이블 버전 관리

```typescript
// 임베딩 모델 버전별 테이블 분리
function getTableName(itemKind: ItemKind, embeddingVersion: string): string {
  // entry_vectors_minilm_v2
  // task_title_vectors_minilm_v2
  const versionSlug = embeddingVersion.replace(/[^a-z0-9]/gi, '_');
  return `${itemKind}_vectors_${versionSlug}`;
}
```

## 7. Idris2 영감 적용

### 7.1 상태 전이 타입 안전성

```typescript
// 타입 레벨에서 유효한 상태 전이만 허용
type ValidTransition =
  | { from: 'pending'; to: 'processing' }
  | { from: 'processing'; to: 'done' }
  | { from: 'processing'; to: 'failed' }
  | { from: 'failed'; to: 'pending' };  // retry

function transition(job: OutboxJob, to: OutboxStatus): OutboxJob {
  const valid: ValidTransition[] = [
    { from: 'pending', to: 'processing' },
    { from: 'processing', to: 'done' },
    { from: 'processing', to: 'failed' },
    { from: 'failed', to: 'pending' }
  ];

  const isValid = valid.some(t => t.from === job.status && t.to === to);
  if (!isValid) {
    throw new InvalidTransitionError(`Cannot transition from ${job.status} to ${to}`);
  }

  return { ...job, status: to, updatedAt: new Date() };
}
```

### 7.2 Idempotency 불변식

```typescript
// Zod로 idempotency 검증
const OutboxJobSchema = z.object({
  itemKind: ItemKindSchema,
  itemId: z.string(),
  embeddingVersion: z.string()
}).refine(
  async (job) => {
    // 같은 조합은 하나만 존재해야 함
    const existing = await db.query(`
      SELECT COUNT(*) as cnt FROM vector_outbox
      WHERE item_kind = ? AND item_id = ? AND embedding_version = ?
    `, [job.itemKind, job.itemId, job.embeddingVersion]);
    return existing[0].cnt <= 1;
  },
  { message: 'Duplicate outbox job' }
);
```

## 8. 기존 코드와의 관계

### 8.1 현재 vector-worker.ts

```typescript
// 현재 구현 (src/core/vector-worker.ts)
export class VectorWorker {
  // OutboxItem 타입 사용
  // status: 'pending' | 'processing' | 'done' | 'failed'
}
```

### 8.2 V2 확장 포인트

| 기존 | V2 확장 |
|-----|---------|
| OutboxItem 타입 | itemKind, embeddingVersion 추가 |
| 단순 배치 처리 | claiming with lock |
| 재시도 없음 | reconcile + retry policy |
| 중복 가능 | UNIQUE 제약 + upsert |

### 8.3 현재 vector-store.ts

```typescript
// 현재 구현 (src/core/vector-store.ts)
export class VectorStore {
  async add(record: VectorRecord): Promise<void>;
  async search(query: number[], limit: number): Promise<SearchResult[]>;
}
```

V2에서 `upsert` 메서드 추가 필요.

## 9. 운영 고려사항

### 9.1 모니터링

```typescript
// 메트릭 수집
interface OutboxMetrics {
  pendingCount: number;
  processingCount: number;
  failedCount: number;
  doneCount: number;
  avgProcessingTimeMs: number;
  lastProcessedAt: Date | null;
}

async function getMetrics(): Promise<OutboxMetrics> {
  return db.query(`
    SELECT
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pendingCount,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processingCount,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failedCount,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as doneCount,
      MAX(updated_at) as lastProcessedAt
    FROM vector_outbox
  `);
}
```

### 9.2 알림

```typescript
// failed job이 임계값 초과 시 알림
const FAILED_THRESHOLD = 10;

async function checkAndAlert(): Promise<void> {
  const metrics = await getMetrics();
  if (metrics.failedCount >= FAILED_THRESHOLD) {
    console.error(`[ALERT] ${metrics.failedCount} failed vector jobs`);
    // 추가 알림 로직
  }
}
```

### 9.3 정리 작업

```typescript
// 정기적으로 완료된 job 정리
async function cleanup(): Promise<void> {
  const deleted = await db.run(`
    DELETE FROM vector_outbox
    WHERE status = 'done'
      AND updated_at < datetime('now', '-7 days')
  `);
  console.log(`Cleaned up ${deleted.changes} done jobs`);
}
```

## 10. 성공 기준

- [ ] vector_outbox 테이블 생성 및 UNIQUE 제약
- [ ] enqueue가 중복을 무시하고 idempotent하게 동작
- [ ] 단일 worker가 pending job을 처리
- [ ] LanceDB upsert로 중복 벡터 방지
- [ ] failed job 재시도 (reconcile) 동작
- [ ] processing 상태 stuck 복구 동작
- [ ] 기존 vector-worker.ts와 호환 유지
