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
- [ ] ItemKind 스키마 추가
- [ ] OutboxStatus 스키마 추가
- [ ] OutboxJob 스키마 추가
- [ ] EnqueueResult, ProcessResult 타입 추가

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
- [ ] vector_outbox 테이블 DDL
- [ ] 인덱스 생성
- [ ] UNIQUE 제약 추가
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
- [ ] enqueue() 메서드 (중복 처리 포함)
- [ ] enqueueBatch() 배치 메서드
- [ ] ON CONFLICT DO NOTHING 처리

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
- [ ] getContent() 콘텐츠 조회 (itemKind별)

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
- [ ] reconcileFailed() 재시도 메서드
- [ ] recoverStuck() stuck 복구 메서드
- [ ] cleanupDone() 정리 메서드

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
- [ ] upsert() 메서드 구현
- [ ] delete + add 패턴 적용
- [ ] 기존 add()와 구분

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
- [ ] getTableName() 버전별 테이블명
- [ ] getOrCreateTable() lazy 생성

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
- [ ] Task 생성 시 task_title enqueue
- [ ] Session 종료 시 session_summary enqueue

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
- [ ] WorkerLock 클래스
- [ ] acquire/release 메서드
- [ ] stale lock 처리

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
- [ ] `cli vector-status` 통계 조회
- [ ] `cli vector-reconcile` 수동 복구

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
- [ ] 상태 조회 커맨드
- [ ] 테이블 형식 출력

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
