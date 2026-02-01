# Endless Mode Implementation Plan

> **Version**: 1.0.0
> **Status**: Draft
> **Created**: 2026-02-01

## Phase 1: 기본 구조 (P0)

### 1.1 설정 스키마

**파일**: `src/core/types.ts` 수정

```typescript
export const MemoryModeSchema = z.enum(['session', 'endless']);
export type MemoryMode = z.infer<typeof MemoryModeSchema>;

export const EndlessModeConfigSchema = z.object({
  enabled: z.boolean().default(false),

  workingSet: z.object({
    maxEvents: z.number().default(100),
    timeWindowHours: z.number().default(24),
    minRelevanceScore: z.number().default(0.5)
  }).default({}),

  consolidation: z.object({
    triggerIntervalMs: z.number().default(3600000),
    triggerEventCount: z.number().default(100),
    triggerIdleMs: z.number().default(1800000),
    useLLMSummarization: z.boolean().default(false)
  }).default({}),

  continuity: z.object({
    minScoreForSeamless: z.number().default(0.7),
    topicDecayHours: z.number().default(48)
  }).default({})
});

// ConfigSchema 확장
export const ConfigSchema = z.object({
  // ... 기존 설정
  mode: MemoryModeSchema.default('session'),
  endless: EndlessModeConfigSchema.optional()
});
```

**작업 항목**:
- [ ] MemoryModeSchema 추가
- [ ] EndlessModeConfigSchema 추가
- [ ] ConfigSchema 확장

### 1.2 DB 스키마

**파일**: `src/core/event-store.ts` 수정

```typescript
private async initSchema(): Promise<void> {
  // 기존 테이블...

  // Working Set 테이블
  await this.db.exec(`
    CREATE TABLE IF NOT EXISTS working_set (
      id VARCHAR PRIMARY KEY,
      event_id VARCHAR NOT NULL,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      relevance_score FLOAT DEFAULT 1.0,
      topics JSON,
      expires_at TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_working_set_expires
      ON working_set(expires_at);
    CREATE INDEX IF NOT EXISTS idx_working_set_relevance
      ON working_set(relevance_score DESC);
  `);

  // Consolidated Memory 테이블
  await this.db.exec(`
    CREATE TABLE IF NOT EXISTS consolidated_memories (
      memory_id VARCHAR PRIMARY KEY,
      summary TEXT NOT NULL,
      topics JSON,
      source_events JSON,
      confidence FLOAT DEFAULT 0.5,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      accessed_at TIMESTAMP,
      access_count INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_consolidated_confidence
      ON consolidated_memories(confidence DESC);
  `);

  // Continuity Log 테이블
  await this.db.exec(`
    CREATE TABLE IF NOT EXISTS continuity_log (
      log_id VARCHAR PRIMARY KEY,
      from_context_id VARCHAR,
      to_context_id VARCHAR,
      continuity_score FLOAT,
      transition_type VARCHAR,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
```

**작업 항목**:
- [ ] working_set 테이블 생성
- [ ] consolidated_memories 테이블 생성
- [ ] continuity_log 테이블 생성
- [ ] 인덱스 생성

## Phase 2: Working Set 관리 (P0)

### 2.1 Working Set Store

**파일**: `src/core/working-set-store.ts` (신규)

```typescript
export class WorkingSetStore {
  constructor(private db: Database, private config: EndlessModeConfig) {}

  async add(event: Event): Promise<void> {
    const expiresAt = new Date(
      Date.now() + this.config.workingSet.timeWindowHours * 60 * 60 * 1000
    );

    await this.db.run(`
      INSERT OR REPLACE INTO working_set (id, event_id, added_at, expires_at)
      VALUES (?, ?, ?, ?)
    `, [crypto.randomUUID(), event.eventId, new Date(), expiresAt]);

    // 크기 제한 적용
    await this.enforceLimit();
  }

  async get(): Promise<WorkingSet> {
    // 만료된 항목 정리
    await this.db.run(`
      DELETE FROM working_set WHERE expires_at < datetime('now')
    `);

    const items = await this.db.all(`
      SELECT ws.*, e.*
      FROM working_set ws
      JOIN events e ON ws.event_id = e.event_id
      ORDER BY ws.relevance_score DESC, ws.added_at DESC
      LIMIT ?
    `, [this.config.workingSet.maxEvents]);

    return {
      recentEvents: items.map(i => i as Event),
      lastActivity: items[0]?.added_at || new Date(),
      continuityScore: await this.calculateContinuityScore()
    };
  }

  private async enforceLimit(): Promise<void> {
    await this.db.run(`
      DELETE FROM working_set
      WHERE id NOT IN (
        SELECT id FROM working_set
        ORDER BY relevance_score DESC, added_at DESC
        LIMIT ?
      )
    `, [this.config.workingSet.maxEvents]);
  }

  private async calculateContinuityScore(): Promise<number> {
    // 최근 연속성 로그 기반 계산
    const log = await this.db.get(`
      SELECT AVG(continuity_score) as avg_score
      FROM continuity_log
      WHERE created_at > datetime('now', '-1 hour')
    `);

    return log?.avg_score || 0.5;
  }
}
```

**작업 항목**:
- [ ] WorkingSetStore 클래스 구현
- [ ] add 메서드
- [ ] get 메서드
- [ ] enforceLimit 메서드
- [ ] calculateContinuityScore 메서드

### 2.2 훅 연동

**파일**: `src/hooks/stop.ts` 수정

```typescript
export async function handleStop(input: StopInput): Promise<void> {
  const memoryService = await MemoryService.getInstance();
  const config = await memoryService.getConfig();

  // 이벤트 저장 (기존)
  const eventId = await memoryService.storeResponse(input);

  // Endless Mode: Working Set에 추가
  if (config.mode === 'endless') {
    await memoryService.addToWorkingSet(eventId);
  }
}
```

**작업 항목**:
- [ ] stop 훅에서 Working Set 연동
- [ ] user-prompt-submit 훅에서 Working Set 연동
- [ ] post-tool-use 훅에서 Working Set 연동

## Phase 3: Consolidation Worker (P1)

### 3.1 Worker 구현

**파일**: `src/core/consolidation-worker.ts` (신규)

```typescript
export class ConsolidationWorker {
  private running = false;
  private timeout: NodeJS.Timeout | null = null;

  constructor(
    private workingSetStore: WorkingSetStore,
    private consolidatedStore: ConsolidatedStore,
    private config: EndlessModeConfig
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  private scheduleNext(): void {
    this.timeout = setTimeout(
      () => this.run(),
      this.config.consolidation.triggerIntervalMs
    );
  }

  private async run(): Promise<void> {
    if (!this.running) return;

    try {
      await this.checkAndConsolidate();
    } catch (error) {
      console.error('Consolidation error:', error);
    }

    this.scheduleNext();
  }

  private async checkAndConsolidate(): Promise<void> {
    const workingSet = await this.workingSetStore.get();

    if (!this.shouldConsolidate(workingSet)) {
      return;
    }

    // 그룹화
    const groups = this.groupByTopic(workingSet.recentEvents);

    // 각 그룹 통합
    for (const group of groups) {
      if (group.events.length >= 3) {  // 최소 3개 이벤트
        const summary = await this.summarize(group);

        await this.consolidatedStore.create({
          summary,
          topics: group.topics,
          sourceEvents: group.events.map(e => e.eventId),
          confidence: this.calculateConfidence(group)
        });
      }
    }

    // Working Set 정리 (통합된 이벤트 제거)
    await this.workingSetStore.prune(groups.flatMap(g => g.events));
  }

  private shouldConsolidate(workingSet: WorkingSet): boolean {
    return workingSet.recentEvents.length >= this.config.consolidation.triggerEventCount;
  }

  private groupByTopic(events: Event[]): EventGroup[] {
    // 간단한 키워드 기반 그룹화
    const groups = new Map<string, EventGroup>();

    for (const event of events) {
      const topics = extractTopics(event.payload.content);

      for (const topic of topics) {
        if (!groups.has(topic)) {
          groups.set(topic, { topics: [topic], events: [] });
        }
        groups.get(topic)!.events.push(event);
      }
    }

    return Array.from(groups.values());
  }

  private async summarize(group: EventGroup): Promise<string> {
    // 규칙 기반 요약
    const keyPoints = group.events
      .map(e => extractKeyPoint(e.payload.content))
      .filter(Boolean);

    return keyPoints.join('\n- ');
  }

  private calculateConfidence(group: EventGroup): number {
    // 이벤트 수, 시간 근접성, 토픽 일관성 기반
    const eventScore = Math.min(group.events.length / 10, 1);
    const timeScore = calculateTimeProximity(group.events);

    return (eventScore + timeScore) / 2;
  }
}
```

**작업 항목**:
- [ ] ConsolidationWorker 클래스 구현
- [ ] 스케줄링 로직
- [ ] 그룹화 로직
- [ ] 요약 생성
- [ ] 신뢰도 계산

### 3.2 Consolidated Store

**파일**: `src/core/consolidated-store.ts` (신규)

```typescript
export class ConsolidatedStore {
  constructor(private db: Database) {}

  async create(memory: ConsolidatedMemoryInput): Promise<string> {
    const memoryId = crypto.randomUUID();

    await this.db.run(`
      INSERT INTO consolidated_memories
        (memory_id, summary, topics, source_events, confidence)
      VALUES (?, ?, ?, ?, ?)
    `, [
      memoryId,
      memory.summary,
      JSON.stringify(memory.topics),
      JSON.stringify(memory.sourceEvents),
      memory.confidence
    ]);

    return memoryId;
  }

  async search(query: string, options?: { topK?: number }): Promise<ConsolidatedMemory[]> {
    // 벡터 검색 또는 FTS
    return this.db.all(`
      SELECT * FROM consolidated_memories
      WHERE summary LIKE ?
      ORDER BY confidence DESC
      LIMIT ?
    `, [`%${query}%`, options?.topK || 5]);
  }

  async markAccessed(memoryId: string): Promise<void> {
    await this.db.run(`
      UPDATE consolidated_memories
      SET accessed_at = datetime('now'),
          access_count = access_count + 1
      WHERE memory_id = ?
    `, [memoryId]);
  }
}
```

**작업 항목**:
- [ ] ConsolidatedStore 클래스 구현
- [ ] create 메서드
- [ ] search 메서드
- [ ] markAccessed 메서드

## Phase 4: 컨텍스트 연속성 (P1)

### 4.1 연속성 계산

**파일**: `src/core/continuity-manager.ts` (신규)

```typescript
export class ContinuityManager {
  constructor(
    private db: Database,
    private config: EndlessModeConfig
  ) {}

  async calculateScore(
    currentContext: ContextSnapshot,
    previousContext: ContextSnapshot
  ): Promise<ContinuityScore> {
    let score = 0;

    // 토픽 연속성 (30%)
    const topicOverlap = this.calculateOverlap(
      currentContext.topics,
      previousContext.topics
    );
    score += topicOverlap * 0.3;

    // 파일 연속성 (20%)
    const fileOverlap = this.calculateOverlap(
      currentContext.files,
      previousContext.files
    );
    score += fileOverlap * 0.2;

    // 시간 근접성 (30%)
    const timeDiff = currentContext.timestamp - previousContext.timestamp;
    const timeScore = Math.exp(-timeDiff / (this.config.continuity.topicDecayHours * 3600000));
    score += timeScore * 0.3;

    // 엔티티 연속성 (20%)
    const entityOverlap = this.calculateOverlap(
      currentContext.entities,
      previousContext.entities
    );
    score += entityOverlap * 0.2;

    // 전환 타입 결정
    const transitionType = this.determineTransitionType(score);

    // 로그 저장
    await this.logTransition(currentContext, previousContext, score, transitionType);

    return { score, transitionType };
  }

  private calculateOverlap(a: string[], b: string[]): number {
    if (a.length === 0 || b.length === 0) return 0;
    const intersection = a.filter(x => b.includes(x));
    return intersection.length / Math.max(a.length, b.length);
  }

  private determineTransitionType(score: number): TransitionType {
    if (score >= this.config.continuity.minScoreForSeamless) {
      return 'seamless';
    } else if (score >= 0.4) {
      return 'topic_shift';
    } else {
      return 'break';
    }
  }

  private async logTransition(
    current: ContextSnapshot,
    previous: ContextSnapshot,
    score: number,
    type: TransitionType
  ): Promise<void> {
    await this.db.run(`
      INSERT INTO continuity_log
        (log_id, from_context_id, to_context_id, continuity_score, transition_type)
      VALUES (?, ?, ?, ?, ?)
    `, [crypto.randomUUID(), previous.id, current.id, score, type]);
  }
}
```

**작업 항목**:
- [ ] ContinuityManager 클래스 구현
- [ ] calculateScore 메서드
- [ ] logTransition 메서드
- [ ] 전환 타입 결정 로직

### 4.2 컨텍스트 주입

**파일**: `src/hooks/user-prompt-submit.ts` 수정

```typescript
async function handleUserPromptSubmit(input: UserPromptInput): Promise<HookOutput> {
  const memoryService = await MemoryService.getInstance();
  const config = await memoryService.getConfig();

  if (config.mode === 'endless') {
    return await handleEndlessMode(input, memoryService);
  } else {
    return await handleSessionMode(input, memoryService);
  }
}

async function handleEndlessMode(
  input: UserPromptInput,
  memoryService: MemoryService
): Promise<HookOutput> {
  // Working Set에서 관련 컨텍스트
  const workingSet = await memoryService.getWorkingSet();

  // Consolidated Memory에서 검색
  const consolidated = await memoryService.searchConsolidated(
    input.prompt,
    { topK: 3 }
  );

  // 연속성 점수
  const continuityScore = workingSet.continuityScore;

  // 컨텍스트 포맷팅
  const context = formatEndlessContext({
    workingSet: workingSet.recentEvents.slice(0, 10),
    consolidated,
    continuityScore
  });

  return {
    context,
    meta: {
      mode: 'endless',
      continuityScore,
      workingSetSize: workingSet.recentEvents.length
    }
  };
}
```

**작업 항목**:
- [ ] Endless Mode 전용 컨텍스트 주입
- [ ] Working Set + Consolidated 조합
- [ ] 연속성 점수 포함

## Phase 5: CLI 및 UI (P1)

### 5.1 CLI 명령

**파일**: `src/cli/commands/endless.ts` (신규)

```typescript
export const endlessCommand = new Command('endless')
  .description('Manage Endless Mode');

endlessCommand
  .command('enable')
  .description('Enable Endless Mode')
  .action(async () => {
    const memoryService = await MemoryService.getInstance();
    await memoryService.setMode('endless');
    await memoryService.initializeEndlessMode();
    console.log('✓ Endless Mode enabled');
  });

endlessCommand
  .command('disable')
  .description('Disable Endless Mode (return to Session Mode)')
  .action(async () => {
    const memoryService = await MemoryService.getInstance();
    await memoryService.setMode('session');
    console.log('✓ Returned to Session Mode');
  });

endlessCommand
  .command('status')
  .description('Show Endless Mode status')
  .action(async () => {
    const memoryService = await MemoryService.getInstance();
    const status = await memoryService.getEndlessStatus();

    console.log(`Mode: ${status.mode}`);
    console.log(`Working Set: ${status.workingSetSize} events`);
    console.log(`Continuity Score: ${status.continuityScore.toFixed(2)}`);
    console.log(`Consolidated: ${status.consolidatedCount} memories`);
  });
```

**작업 항목**:
- [ ] enable 명령
- [ ] disable 명령
- [ ] status 명령
- [ ] consolidate 수동 트리거 명령

## 파일 목록

### 신규 파일
```
src/core/working-set-store.ts     # Working Set 저장소
src/core/consolidated-store.ts    # Consolidated Memory 저장소
src/core/consolidation-worker.ts  # 통합 워커
src/core/continuity-manager.ts    # 연속성 관리
src/cli/commands/endless.ts       # CLI 명령
```

### 수정 파일
```
src/core/types.ts                 # 스키마 추가
src/core/event-store.ts           # 테이블 추가
src/services/memory-service.ts    # Endless Mode 메서드
src/hooks/user-prompt-submit.ts   # 컨텍스트 주입
src/hooks/stop.ts                 # Working Set 연동
```

## 마일스톤

| 단계 | 완료 기준 |
|------|----------|
| M1 | 스키마 및 테이블 정의 |
| M2 | Working Set Store 구현 |
| M3 | Consolidated Store 구현 |
| M4 | Consolidation Worker 구현 |
| M5 | 연속성 관리 구현 |
| M6 | 훅 연동 |
| M7 | CLI 명령 |
| M8 | Web Viewer 대시보드 |
| M9 | 테스트 및 튜닝 |
