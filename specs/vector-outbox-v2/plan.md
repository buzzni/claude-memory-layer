# Vector Outbox V2 Implementation Plan

> **Version**: 2.0.0
> **Status**: Draft
> **Created**: 2026-01-31

## Phase 1: 스키마 및 타입 (P0)

### 1.1 타입 정의

**파일**: `src/core/types.ts` 수정

```typescript
// 추가할 타입들
export const ItemKindSchema = z.enum(['entry', 'task_title', 'session_summary']);
export type ItemKind = z.infer<typeof ItemKindSchema>;

export const OutboxStatusSchema = z.enum(['pending', 'processing', 'done', 'failed']);
export type OutboxStatus = z.infer<typeof OutboxStatusSchema>;

export const OutboxJobSchema = z.object({
  jobId: z.string(),
  itemKind: ItemKindSchema,
  itemId: z.string(),
  embeddingVersion: z.string(),
  status: OutboxStatusSchema,
  retryCount: z.number().int().nonnegative(),
  error: z.string().optional(),
  createdAt: z.date(),
  updatedAt: z.date()
});
export type OutboxJob = z.infer<typeof OutboxJobSchema>;
```

**작업 항목**:
- [x] ItemKind 스키마 추가
  - `OutboxItemKindSchema` now covers `entry`, `task_title`, `event`, and `perspective_observation` so Perspective Memory observations can be vectorized through the same outbox seam.
- [x] OutboxStatus 스키마 추가
- [x] OutboxJob 스키마 추가
- [ ] EnqueueResult, ProcessResult 타입 추가
  - `EnqueueResult`/`OutboxEnqueueInput` are implemented in `src/core/vector-outbox.ts`; `ProcessResult` remains future work for the worker loop API.

### 1.2 DB 스키마

**파일**: 마이그레이션 스크립트

```sql
-- 기존 outbox 테이블이 있다면 백업 후 마이그레이션
-- 신규 vector_outbox 테이블

CREATE TABLE vector_outbox (
  job_id            VARCHAR PRIMARY KEY,
  item_kind         VARCHAR NOT NULL,
  item_id           VARCHAR NOT NULL,
  embedding_version VARCHAR NOT NULL,
  status            VARCHAR NOT NULL DEFAULT 'pending',
  retry_count       INTEGER DEFAULT 0,
  error             VARCHAR,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(item_kind, item_id, embedding_version)
);

CREATE INDEX idx_outbox_status ON vector_outbox(status);
CREATE INDEX idx_outbox_created ON vector_outbox(created_at);
```

**작업 항목**:
- [x] vector_outbox 테이블 DDL
- [x] 인덱스 생성
  - `idx_outbox_status` and `idx_outbox_created` are created in both SQLite-backed store initialization paths.
- [x] UNIQUE 제약 추가
- [ ] 기존 데이터 마이그레이션 스크립트 (필요시)

## Phase 2: VectorOutbox 클래스 (P0)

### 2.1 Enqueue 구현

**파일**: `src/core/vector-outbox.ts` (신규)

```typescript
export class VectorOutbox {
  constructor(private db: Database);

  async enqueue(input: OutboxEnqueueInput): Promise<EnqueueResult> {
    const jobId = uuidv4();

    try {
      await this.db.run(`
        INSERT INTO vector_outbox
        (job_id, item_kind, item_id, embedding_version, status)
        VALUES (?, ?, ?, ?, 'pending')
        ON CONFLICT (item_kind, item_id, embedding_version)
        DO NOTHING
      `, [jobId, input.itemKind, input.itemId, input.embeddingVersion]);

      // 삽입 성공 여부 확인
      const inserted = await this.db.query(`
        SELECT job_id FROM vector_outbox
        WHERE item_kind = ? AND item_id = ? AND embedding_version = ?
      `, [input.itemKind, input.itemId, input.embeddingVersion]);

      const isNew = inserted[0]?.job_id === jobId;
      return { success: true, jobId: inserted[0].job_id, isNew };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}
```

**작업 항목**:
- [x] enqueue() 메서드 (중복 처리 포함)
  - `enqueue()` now returns the existing job id for duplicate item/version requests instead of a throwaway UUID, preserving idempotent caller semantics.
- [x] enqueueBatch() 배치 메서드
  - `enqueueBatch()` returns per-item `EnqueueResult` values with `isNew` for observability.
- [x] ON CONFLICT DO NOTHING 처리

### 2.2 조회 메서드

```typescript
async getPendingJobs(limit: number = 100): Promise<OutboxJob[]> {
  return this.db.query(`
    SELECT * FROM vector_outbox
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT ?
  `, [limit]);
}

async getJobById(jobId: string): Promise<OutboxJob | null> {
  const rows = await this.db.query(`
    SELECT * FROM vector_outbox WHERE job_id = ?
  `, [jobId]);
  return rows[0] || null;
}

async getMetrics(): Promise<OutboxMetrics> {
  // 상태별 통계 조회
}
```

**작업 항목**:
- [ ] getPendingJobs() 메서드
- [ ] getJobById() 메서드
- [ ] getMetrics() 통계 메서드

## Phase 3: VectorWorker V2 (P0)

### 3.1 Worker 기본 구현

**파일**: `src/core/vector-worker.ts` 수정

```typescript
export class VectorWorkerV2 {
  constructor(
    private outbox: VectorOutbox,
    private embedder: Embedder,
    private vectorStore: VectorStore,
    private db: Database
  );

  // Job claiming with lock
  async claimJobs(limit: number): Promise<OutboxJob[]> {
    // 트랜잭션으로 pending → processing 변경
    return this.db.transaction(async (tx) => {
      const jobs = await tx.query(`
        SELECT * FROM vector_outbox
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT ?
        FOR UPDATE  -- DuckDB에서 지원 시
      `, [limit]);

      if (jobs.length === 0) return [];

      const jobIds = jobs.map(j => j.job_id);
      await tx.run(`
        UPDATE vector_outbox
        SET status = 'processing', updated_at = CURRENT_TIMESTAMP
        WHERE job_id IN (${jobIds.map(() => '?').join(',')})
      `, jobIds);

      return jobs.map(j => ({ ...j, status: 'processing' as const }));
    });
  }
}
```

**작업 항목**:
- [ ] claimJobs() 락 처리
- [ ] markDone() 메서드
- [ ] markFailed() 메서드

### 3.2 Process 루프

```typescript
async processAll(): Promise<ProcessResult> {
  const result: ProcessResult = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    errors: []
  };

  const BATCH_SIZE = 50;

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
  // 1. 콘텐츠 조회
  const content = await this.getContent(job.itemKind, job.itemId);
  if (!content) {
    throw new Error(`Content not found: ${job.itemKind}:${job.itemId}`);
  }

  // 2. 임베딩 생성
  const embedding = await this.embedder.embed(content);

  // 3. LanceDB upsert
  await this.vectorStore.upsert({
    id: `${job.itemKind}:${job.itemId}`,
    vector: embedding,
    content,
    metadata: {
      itemKind: job.itemKind,
      embeddingVersion: job.embeddingVersion,
      indexedAt: new Date().toISOString()
    }
  });
}
```

**작업 항목**:
- [ ] processAll() 메인 루프
- [ ] processJob() 단일 job 처리
- [x] getContent() 콘텐츠 조회 (itemKind별)
  - `DefaultContentProvider` now supports `entry`, `task_title`, `event`, and soft-delete-aware/legacy-safe `perspective_observation` content with privacy-minimal metadata counts.

### 3.3 Reconcile

```typescript
async reconcileFailed(maxRetries: number = 3): Promise<number> {
  const result = await this.db.run(`
    UPDATE vector_outbox
    SET status = 'pending',
        retry_count = retry_count + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'failed'
      AND retry_count < ?
  `, [maxRetries]);

  return result.changes;
}

async recoverStuck(stuckThresholdMs: number = 5 * 60 * 1000): Promise<number> {
  const threshold = new Date(Date.now() - stuckThresholdMs);
  const result = await this.db.run(`
    UPDATE vector_outbox
    SET status = 'pending',
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'processing'
      AND updated_at < ?
  `, [threshold.toISOString()]);

  return result.changes;
}
```

**작업 항목**:
- [x] reconcileFailed() 재시도 메서드
  - Implemented as `VectorOutbox.reconcile(referenceTime?)`, returning exact `retried` count for failed jobs under `maxRetries`.
- [x] recoverStuck() stuck 복구 메서드
  - Implemented as `VectorOutbox.reconcile(referenceTime?)`, returning exact `recovered` count for stale `processing` jobs.
- [x] cleanupDone() 정리 메서드
  - `VectorOutbox.cleanup(referenceTime?)` now returns exact deleted-row count for old `done` jobs.
- [x] CLI `process` 시작 전에 `recoverStuck()`을 호출하거나 `--recover-stuck` 옵션 제공
  - `process` now recovers stale `processing` and retryable failed embedding/vector outbox rows by default before processing pending embeddings; `--no-recover-stuck` opt-out remains available.
  - `--dry-run-recovery` previews the aggregate recovery effect without mutating rows or processing embeddings.
- [x] dashboard stats에 `processing` outbox count와 stuck threshold 초과 count 표시
  - 2026-05-25: `/api/health` now returns aggregate-only `processing`, `stuckProcessing`, and `oldestProcessingAgeMs` for embedding/vector outboxes and marks status `needs-attention` when stuck/failed work exists.
  - `mem-stats` MCP output mirrors the same aggregate stuck/oldest-age signals without item IDs, source content, or error payloads.
  - `SQLiteEventStore.getOutboxStats({ now, stuckThresholdMs })` has deterministic tested semantics for stuck processing counts and oldest processing age.
- [x] 2026-05-10 dogfood 회귀 fixture: `claude-memory-layer` project에서 `embedding_outbox.status='processing'` 34건인데 `process -p ...`가 `Processed 0 embeddings`로 끝난 사례
  - `tests/apps/process-command.test.ts` covers a 34-row stuck `embedding_outbox` dogfood fixture and verifies dry-run recovery reports the rows without mutating them or entering embedding processing.
- [x] stuck recovery dry-run 출력: recovered count, oldest processing age, next command
  - `process --dry-run-recovery` prints aggregate recovered/retried counts, oldest processing age, and the follow-up `claude-memory-layer process --project ...` command; raw event IDs/content/error payloads are not included.

## Phase 4: VectorStore Upsert (P0)

### 4.1 Upsert 메서드

**파일**: `src/core/vector-store.ts` 수정

```typescript
// 기존 add() 메서드 외에 upsert() 추가
async upsert(record: VectorRecord): Promise<void> {
  const table = await this.getOrCreateTable();

  // 기존 레코드 확인
  const existing = await table
    .search([0])  // dummy
    .filter(`id = '${record.id}'`)
    .limit(1)
    .toArray();

  if (existing.length > 0) {
    // 삭제 후 재삽입 (LanceDB upsert 패턴)
    await table.delete(`id = '${record.id}'`);
  }

  await table.add([{
    id: record.id,
    vector: record.vector,
    content: record.content,
    timestamp: record.timestamp,
    ...record.metadata
  }]);
}
```

**작업 항목**:
- [x] upsert() 메서드 구현
- [x] delete + add 패턴 적용
- [x] 기존 add()와 구분
  - 2026-05-25: `VectorStore.upsert()`/`upsertBatch()` now perform delete+add for existing LanceDB tables instead of append-only writes.
  - V2 outbox records infer table routing from privacy-minimal metadata (`itemKind`, `embeddingVersion`); legacy records without those fields continue to use the `conversations` table.
  - `tests/core/vector-store-v2.test.ts` covers delete+add, SQL-string escaping, and grouped batch behavior.

### 4.2 테이블 버전 관리

```typescript
// 임베딩 모델 버전별 테이블
private getTableName(itemKind: ItemKind, version: string): string {
  const versionSlug = version.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  return `${itemKind}_vectors_${versionSlug}`;
}

async getOrCreateTable(itemKind: ItemKind, version: string): Promise<Table> {
  const tableName = this.getTableName(itemKind, version);

  try {
    return await this.db.openTable(tableName);
  } catch {
    // 테이블 생성
    return await this.db.createTable(tableName, [
      { id: '', vector: [], content: '', timestamp: '' }
    ]);
  }
}
```

**작업 항목**:
- [x] getTableName() 버전별 테이블명
- [x] getOrCreateTable() lazy 생성
  - 2026-05-25: deterministic V2 table names use `<itemKind>_vectors_<embeddingVersionSlug>` (example: `perspective_observation_vectors_minilm_l6_v2_0`).
  - Tables are opened/created lazily per inferred route, avoiding eager access to the legacy `conversations` table for V2 writes.

## Phase 5: 통합 및 트리거 (P0)

### 5.1 Entry 저장 시 자동 enqueue

**파일**: Graduation 또는 Entry 저장 로직

```typescript
async function materializeEntry(entry: Entry): Promise<void> {
  // 1. Entry 저장
  await entryRepo.create(entry);

  // 2. Outbox에 자동 enqueue
  await outbox.enqueue({
    itemKind: 'entry',
    itemId: entry.entry_id,
    embeddingVersion: config.embedding.version
  });
}
```

**작업 항목**:
- [ ] Entry 저장 후 outbox.enqueue() 호출
  - 2026-05-25: production `entries` table/content provider exists, but no clear single writer/materializer was found in current source. Do not invent a second writer just to enqueue; wire `entry` only when the actual writer is introduced or located.
- [x] Event 저장/import 시 `event` enqueue
  - `SQLiteEventStore.append()` and `importEvents()` enqueue only committed/new events, with source writes and `vector_outbox` rows in the same SQLite transaction for non-duplicate writes.
- [x] Task 생성 시 task_title enqueue
  - `TaskResolver` enqueues `task_title` when a new task entity is materialized; high-confidence matched existing tasks do not create duplicate jobs.
- [x] Perspective observation 저장 시 `perspective_observation` enqueue
  - `PerspectiveObservationRepository.create()` enqueues the saved/upserted observation id idempotently.
- [x] Session 종료 시 session_summary enqueue
  - Current `OutboxItemKindSchema` has no separate `session_summary` kind, so `session_summary` records are covered as `event` jobs when they are appended/imported through the event store.
- [x] Transactional/privacy guarantees
  - `VectorOutbox.enqueueSync()`/`enqueueWithResultSync()` support same-transaction enqueue at writer boundaries.
  - Tests assert enqueue failure rolls back event/task/observation source rows and that `vector_outbox` contains only kind/id/version/status fields, not raw event content, task descriptions, observation text, source ids, paths, or errors.

### 5.2 단일 Writer 보장

**파일**: `src/core/worker-lock.ts` (신규)

```typescript
export class WorkerLock {
  private lockFile: string;

  constructor(lockPath: string = '/tmp/vector-worker.lock');

  acquire(): boolean {
    if (fs.existsSync(this.lockFile)) {
      const pid = parseInt(fs.readFileSync(this.lockFile, 'utf8'));
      if (this.isProcessRunning(pid)) {
        return false;  // 다른 worker 실행 중
      }
      // stale lock file 제거
      fs.unlinkSync(this.lockFile);
    }
    fs.writeFileSync(this.lockFile, process.pid.toString());
    return true;
  }

  release(): void {
    if (fs.existsSync(this.lockFile)) {
      fs.unlinkSync(this.lockFile);
    }
  }
}
```

**작업 항목**:
- [x] WorkerLock 클래스
- [x] acquire/release 메서드
- [x] stale lock 처리
- [x] `process` 커맨드가 recovery/embedding 처리 전 project-scoped lock 획득
- [x] lock contention 출력은 aggregate/sanitized 정보만 포함

### 5.3 Runtime/process worker 연결

**파일**: `src/core/engine/memory-runtime-service.ts` 수정

**작업 항목**:
- [x] Runtime service가 SQLite DB handle이 있을 때 `VectorWorkerV2`를 생성/시작
  - 2026-05-25: `RuntimeSQLiteStore.getDatabase?.()`가 제공되는 production SQLite store에서는 기존 legacy `VectorWorker` 시작 직후 V2 worker도 같은 `VectorStore`/`Embedder`로 시작한다.
- [x] `processPendingEmbeddings()`가 legacy embedding worker와 V2 `vector_outbox` worker를 모두 drain
  - 반환값은 legacy `embedding_outbox` 처리 건수와 V2 `vector_outbox` 처리 건수의 합계로 유지되어 기존 `process` flow가 두 큐를 함께 비운다.
- [x] shutdown lifecycle에서 V2 worker도 명시적으로 stop
- [x] Runtime/process integration 테스트
  - `tests/core/memory-runtime-service.test.ts`는 legacy worker 보존, V2 worker start/stop, combined drain count를 검증한다.
  - `tests/core/vector-outbox-v2.test.ts`는 pending V2 job이 content lookup → embedding → versioned vector upsert → done marking으로 처리되고, outbox rows에 content/session sentinel이 남지 않음을 검증한다.

## Phase 6: CLI 및 모니터링 (P1)

### 6.1 CLI 커맨드

**파일**: `src/cli/index.ts` 수정

```typescript
// 벡터 워커 실행
program
  .command('vector-worker')
  .description('Process pending vector jobs')
  .option('--once', 'Process once and exit')
  .option('--reconcile', 'Also reconcile failed jobs')
  .action(async (options) => {
    const lock = new WorkerLock();
    if (!lock.acquire()) {
      console.log('Another worker is running');
      process.exit(0);
    }

    try {
      if (options.reconcile) {
        const recovered = await worker.reconcileFailed(3);
        console.log(`Recovered ${recovered} failed jobs`);
      }

      const result = await worker.processAll();
      console.log(`Processed: ${result.processed}, Succeeded: ${result.succeeded}, Failed: ${result.failed}`);

      if (!options.once) {
        // 주기적 실행
        setInterval(async () => {
          await worker.processAll();
        }, 10000);
      }
    } finally {
      lock.release();
    }
  });
```

**작업 항목**:
- [ ] `cli vector-worker` 커맨드
- [x] `cli vector-status` 통계 조회
  - 2026-05-26: added aggregate-only `vector-status` command using the lightweight project service. Output shows vector count, total events, embedding/vector queue bucket counts, totals, oldest processing age, and attention status without row ids, item ids, raw errors, content, or project paths.
- [ ] `cli vector-reconcile` 수동 복구
- [x] Dashboard vector health card
  - 2026-05-26: overview dashboard loads `/api/health` with current project scope and renders aggregate-only vector counts, outbox pending/processing/failed/stuck totals, oldest processing age, and last dashboard recovery result.
  - Recovery button calls `/api/health/recover` and displays only recovered aggregate counts; raw row ids, item ids, source content, storage paths, and error payload fields are ignored.
  - Recovery display is scoped to the active project hash and derives post-recovery attention state from remaining aggregate failed/stuck outbox counts.
  - `/api/health` and `/api/health/recover` failure responses now return generic messages so private service errors, paths, row ids, and item ids are not exposed.

### 6.2 상태 조회

```typescript
program
  .command('vector-status')
  .description('Show vector outbox status')
  .action(async () => {
    const metrics = await outbox.getMetrics();
    console.log('Vector Outbox Status:');
    console.log(`  Pending:    ${metrics.pendingCount}`);
    console.log(`  Processing: ${metrics.processingCount}`);
    console.log(`  Done:       ${metrics.doneCount}`);
    console.log(`  Failed:     ${metrics.failedCount}`);
    console.log(`  Last sync:  ${metrics.lastProcessedAt || 'Never'}`);
  });
```

**작업 항목**:
- [x] 상태 조회 커맨드
- [x] 테이블 형식 출력
  - 2026-05-26: `formatVectorStatusReport()` renders a bounded aggregate table for embedding/vector/total queues plus overall status and recovery guidance. Tests include sentinel-rich payloads to assert private paths, raw row/item ids, source content, and raw errors are ignored.

## 파일 목록

### 신규 파일
```
src/core/vector-outbox.ts    # Outbox 관리
src/core/worker-lock.ts      # 단일 worker 락
```

### 수정 파일
```
src/core/types.ts            # 타입 추가
src/core/vector-worker.ts    # V2 로직 추가
src/core/vector-store.ts     # upsert 추가
src/cli/index.ts             # CLI 커맨드 추가
```

## 테스트

### 필수 테스트 케이스

1. **Idempotent Enqueue**
   ```typescript
   await outbox.enqueue({ itemKind: 'entry', itemId: 'e1', embeddingVersion: 'v1' });
   await outbox.enqueue({ itemKind: 'entry', itemId: 'e1', embeddingVersion: 'v1' });
   // 두 번째는 isNew: false
   const count = await db.query('SELECT COUNT(*) FROM vector_outbox');
   expect(count[0].count).toBe(1);
   ```

2. **Process All**
   ```typescript
   await outbox.enqueue({ itemKind: 'entry', itemId: 'e1', ... });
   await outbox.enqueue({ itemKind: 'entry', itemId: 'e2', ... });
   const result = await worker.processAll();
   expect(result.processed).toBe(2);
   expect(result.succeeded).toBe(2);
   ```

3. **Reconcile Failed**
   ```typescript
   // 실패한 job 생성
   await db.run(`
     INSERT INTO vector_outbox (job_id, item_kind, item_id, embedding_version, status, retry_count)
     VALUES ('j1', 'entry', 'e1', 'v1', 'failed', 1)
   `);
   const recovered = await worker.reconcileFailed(3);
   expect(recovered).toBe(1);
   // status가 pending으로 변경됨
   ```

4. **LanceDB Upsert**
   ```typescript
   await vectorStore.upsert({ id: 'e1', vector: [0.1, 0.2], ... });
   await vectorStore.upsert({ id: 'e1', vector: [0.3, 0.4], ... });
   // 중복 없이 최신 벡터만 존재
   const results = await vectorStore.search([0.3, 0.4], 10);
   expect(results.filter(r => r.id === 'e1').length).toBe(1);
   ```

5. **Single Writer Lock**
   ```typescript
   const lock1 = new WorkerLock();
   const lock2 = new WorkerLock();
   expect(lock1.acquire()).toBe(true);
   expect(lock2.acquire()).toBe(false);
   lock1.release();
   expect(lock2.acquire()).toBe(true);
   ```

## 마일스톤

| 단계 | 완료 기준 |
|------|----------|
| M1 | 타입 정의 + vector_outbox 테이블 |
| M2 | VectorOutbox enqueue/getPending |
| M3 | VectorWorkerV2 claimJobs/markDone |
| M4 | VectorStore upsert |
| M5 | processAll() 전체 루프 |
| M6 | reconcile + recoverStuck |
| M7 | CLI 커맨드 |
| M8 | 테스트 통과 |

## 2026-05-10 구현 업데이트 — stuck outbox recovery + vector count 검증

### 완료된 항목

- [x] `SQLiteEventStore.recoverStuckOutboxItems()` 추가
  - stale `embedding_outbox.status='processing'` row를 `pending`으로 복구
  - stale `vector_outbox.status='processing'` row를 `pending`으로 복구
  - retry 가능한 `failed` row를 `pending`으로 재시도 가능 상태로 전환
- [x] `MemoryQueryService` / `MemoryService`에 recovery delegation 추가
- [x] CLI `process` 기본 동작에 stuck recovery 선행 실행 추가
- [x] CLI `process --no-recover-stuck` 추가
- [x] Dashboard maintenance API `POST /api/health/recover` 추가
  - read-only dashboard resolver가 아니라 writable lightweight resolver 사용
  - response에 before/after outbox 상태와 post-recovery storage stats 포함
- [x] `VectorStore.count()`가 lazy table initialization 후 실제 LanceDB row count를 반환하도록 수정

### 실제 프로젝트 검증 결과

대상 projectPath: `/Users/namsangboy/workspace/claude-memory-layer`

- 수정 전 dry-run 성격의 `process --no-recover-stuck`: `Processed 0 embeddings`
- recovery 적용 후 `process`: `Recovered stuck outbox work: embedding=34/0, vector=0/0`, `Processed 32 embeddings`
- 이후 outbox 상태: embedding/vector `pending=0`, `processing=0`, `failed=0`
- vector count 표시 회귀 수정 후 CLI/API stats 모두 `eventCount=51`, `vectorCount=51`

### 추가 테스트

- `tests/core/sqlite-event-store-outbox-recovery.test.ts`
- `tests/core/memory-query-service.test.ts`
- `tests/apps/health-api-outbox-recovery.test.ts`
- `tests/core/vector-store-count.test.ts`

### 남은 후속 계획

- [ ] legacy/mis-scoped imported events repair CLI 설계/구현
  - 이번 dogfood에서 project DB 내부에 과거 Hermes import가 다른 프로젝트 내용을 CML project scope로 저장한 사례를 확인했다.
  - storage-level project filter만으로는 이 데이터를 배제할 수 없으므로 repair 또는 quarantine 경로가 필요하다.
- [ ] dashboard에 outbox/vector health card 추가
  - `vectorCount`, outbox pending/processing/failed, last recovery result를 한 화면에서 확인한다.
