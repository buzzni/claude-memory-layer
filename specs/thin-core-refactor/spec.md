# Thin Core Refactor Specification

> **Version**: 1.0.0
> **Status**: Draft
> **Created**: 2026-04-30
> **References**: memsearch, superlocalmemory, existing claude-memory-layer architecture

## 1. 개요

### 1.1 문제 정의

현재 `claude-memory-layer`는 기능적으로 강하지만 구조적으로 다음 문제가 누적되고 있다.

1. **코어와 확장 기능의 경계가 흐림**
   - `MemoryService`가 저장, 검색, vector indexing, shared memory, continuity, markdown mirror, workers, analytics 역할을 동시에 가진다.

2. **저장 계층의 책임이 명확하지 않음**
   - SQLite, LanceDB, markdown mirror, shared store, Mongo sync가 공존하지만 canonical/derived 관계가 코드와 문서에서 충분히 분명하지 않다.

3. **Claude-specific logic이 코어를 오염시킴**
   - hooks와 transcript recovery가 제품 강점이긴 하지만, core engine과 물리적으로 분리되지 않아 구조 이해와 테스트가 어려워진다.

4. **문서와 구현 drift**
   - README/문서 일부와 실제 저장/서버/MCP wiring 사이에 불일치가 존재한다.

5. **기능 추가 방향이 플랫폼 비대화로 이어질 위험**
   - shared memory, endless mode, graph-like concepts, MCP, analytics 등이 하나의 monolith 안에 누적되고 있다.

### 1.2 목표

이 스펙의 목표는 `claude-memory-layer`를 다음 구조로 재정의하는 것이다.

> **얇은 코어 메모리 엔진 + 강한 Claude adapter + 선택형 accelerators/extensions + 명확한 apps layer**

### 1.3 비목표

이번 리팩터링에서 다음은 직접 목표가 아니다.

- 모든 기능 제거
- 완전 재작성(rewrite from scratch)
- 모든 확장 기능을 즉시 폐기
- full code graph 플랫폼 구축
- multi-agent mesh / learning platform 추가

---

## 2. 핵심 설계 원칙

### 2.1 Canonical vs Derived 분리

시스템 내 저장 계층을 명시적으로 분리한다.

#### Canonical
- **SQLite**: machine canonical store

#### Canonical projection
- **Markdown journal**: human-readable canonical projection / export-friendly journal

#### Derived / rebuildable
- **LanceDB vector index**
- derived summaries
- retrieval traces
- shared replication state

#### Optional extension state
- shared memory sync
- Mongo sync metadata
- MCP-specific caches or adapters

### 2.2 Raw / Fact / Summary / Rule 4계층 모델

메모리 모델을 다음 4층으로 재정의한다.

1. **RawEvent**
   - 원본 prompt, assistant response, tool output, session markers, imported history
2. **MemoryFact**
   - 검색 단위로 사용할 정제된 사실 단위
3. **MemorySummary**
   - turn/session/project/continuity 등 상위 요약 단위
4. **MemoryRule**
   - 반복되는 선호, 패턴, 관례, 안정적 constraint

### 2.3 Core는 SQLite-only로 최소 기능 제공

필수 최소 기능은 vector index 없이도 동작해야 한다.

최소 기능:
- raw event 기록
- recent timeline / keyword search
- basic fact retrieval
- source tracing
- session/project registry

### 2.4 Claude lifecycle은 adapter 계층으로 격리

다음 로직은 core가 아니라 adapter다.

- hook payload parsing
- transcript reconstruction
- additionalContext formatting
- tool capture heuristics
- Claude plugin install/uninstall integration

### 2.5 실험 기능은 extension 경계 안에 둔다

다음은 extension으로 재배치한다.

- vector embedding/index pipeline
- semantic daemon
- shared store
- Mongo sync
- MCP server
- continuity/endless mode
- advanced graph/task-like models

---

## 3. 목표 아키텍처

### 3.1 Layer model

```text
Apps
  ├─ CLI
  ├─ Server/API
  └─ Dashboard

Adapters
  └─ Claude

Extensions
  ├─ Vector acceleration
  ├─ Analytics
  ├─ Shared memory
  ├─ Mongo sync
  ├─ MCP
  └─ Continuity

Core
  ├─ Models
  ├─ SQLite storage
  ├─ Fact/Summary derivation
  ├─ Retrieval engine
  ├─ Journal projection
  └─ Registry
```

### 3.2 Dependency rules

1. `core`는 `adapters`를 import하지 않는다.
2. `core`는 `apps`를 import하지 않는다.
3. `extensions`는 `core`를 사용할 수 있지만, core의 기본 기능을 전제로 삼지 않는다.
4. `apps`는 composition root다. 도메인 로직은 두지 않는다.
5. `adapters/claude`는 Claude-specific heuristic과 serialization만 가진다.

---

## 4. 도메인 모델 명세

### 4.1 RawEvent

```typescript
interface RawEvent {
  eventId: string;
  projectHash: string;
  sessionId: string;
  turnId?: string;
  eventType:
    | 'user_prompt'
    | 'assistant_response'
    | 'tool_output'
    | 'session_marker'
    | 'imported_turn';
  content: string;
  toolName?: string;
  sourceRef?: string;
  metadata: Record<string, unknown>;
  privacyLevel: 'public' | 'internal' | 'private' | 'masked';
  createdAt: string;
}
```

### 4.2 MemoryFact

```typescript
interface MemoryFact {
  factId: string;
  projectHash: string;
  factType:
    | 'decision'
    | 'constraint'
    | 'task_state'
    | 'tool_observation'
    | 'preference'
    | 'code_context'
    | 'summary_fact';
  text: string;
  derivedFromEventIds: string[];
  sourceKind: 'prompt' | 'assistant' | 'tool' | 'import';
  confidence: number;
  importance: number;
  tags: string[];
  entityRefs?: string[];
  fileRefs?: string[];
  symbolRefs?: string[];
  createdAt: string;
  updatedAt: string;
}
```

### 4.3 MemorySummary

```typescript
interface MemorySummary {
  summaryId: string;
  summaryType:
    | 'turn'
    | 'session'
    | 'project'
    | 'continuity'
    | 'timeline_digest';
  refId: string;
  text: string;
  sourceEventIds: string[];
  sourceFactIds: string[];
  createdAt: string;
}
```

### 4.4 MemoryRule

```typescript
interface MemoryRule {
  ruleId: string;
  projectHash?: string;
  scope: 'project' | 'shared';
  ruleType: 'preference' | 'workflow' | 'convention' | 'constraint';
  text: string;
  confidence: number;
  evidenceIds: string[];
  createdAt: string;
  updatedAt: string;
}
```

### 4.5 RetrievalResultEnvelope

```typescript
interface RetrievalResultEnvelope {
  id: string;
  resultType: 'fact' | 'summary' | 'tool_evidence' | 'rule' | 'source';
  title?: string;
  snippet: string;
  score: number;
  reasons: RetrievalReason[];
  sourceRef?: string;
  sessionId?: string;
  turnId?: string;
  metadata?: Record<string, unknown>;
}

type RetrievalReason =
  | 'semantic_match'
  | 'keyword_match'
  | 'recent_relevance'
  | 'continuity_link'
  | 'entity_overlap'
  | 'tool_followup'
  | 'summary_fallback';
```

---

## 5. 검색 제품 동작 명세

### 5.1 3단 retrieval UX

검색 UX를 다음 세 단계로 통일한다.

#### Search
- compact results
- snippet + type + score + reasons 제공

#### Expand
- 선택된 result의 주변 fact/summary/source 맥락 제공
- 같은 turn/session/tool run 문맥 확장 가능

#### Source
- transcript / raw event / tool output / import source로 drill-down

### 5.2 Search contract

```typescript
interface MemoryQuery {
  query: string;
  topK?: number;
  scope?: 'project' | 'shared' | 'all';
  includeTypes?: Array<'fact' | 'summary' | 'rule' | 'tool_evidence'>;
}

interface SearchResponse {
  results: RetrievalResultEnvelope[];
  meta: {
    total: number;
    usedVector: boolean;
    usedKeyword: boolean;
    fallbackApplied: boolean;
  };
}
```

### 5.3 Expand contract

```typescript
interface ExpandResponse {
  target: RetrievalResultEnvelope;
  surroundingFacts?: RetrievalResultEnvelope[];
  summaries?: RetrievalResultEnvelope[];
  relatedSources?: SourceReference[];
}
```

### 5.4 Source contract

```typescript
interface SourceReference {
  sourceRef: string;
  sourceType: 'raw_event' | 'transcript' | 'tool_output' | 'imported_history';
  eventIds: string[];
}
```

---

## 6. 저장 및 인덱싱 명세

### 6.1 SQLite canonical requirements

SQLite는 다음을 지원해야 한다.

- append-only raw events
- fact and summary storage
- session/project registry linkage
- keyword search and timeline lookup
- source tracing
- optional retrieval traces

### 6.2 Vector acceleration requirements

Vector 계층은 optional이며 다음을 만족해야 한다.

- disabled 상태에서도 search는 동작
- enabled 상태에서는 hybrid retrieval을 제공
- rebuildable index여야 함
- canonical source를 절대 직접 수정하지 않음

### 6.3 Journal requirements

Markdown journal은 다음을 만족해야 한다.

- 사람이 읽기 쉬운 요약/사실/세션 흐름 제공
- export/import friendly
- SQLite canonical을 기반으로 projection 가능
- journal만으로 고급 검색을 책임지지 않음

---

## 7. API / service boundary requirements

### 7.1 Core service interfaces

필수 core interface:
- `ProjectRegistryService`
- `MemoryIngestService`
- `FactDeriver`
- `SummaryDeriver`
- `RetrievalEngine`
- `JournalService`

### 7.2 Compatibility requirement

기존 `MemoryService`는 즉시 제거하지 않는다.

요구사항:
- transitional facade로 유지 가능
- 내부적으로 새 서비스를 호출하도록 점진 교체
- 기존 CLI/server/hooks 호출 경로를 당분간 깨지 않음

### 7.3 Adapter requirements

Claude adapter는 다음을 제공해야 한다.

- hook handlers
- transcript reconstruction
- capture policy
- context formatter
- install/uninstall workflow support

---

## 8. 마이그레이션 요구사항

### 8.1 Non-breaking migration

- 기존 저장 데이터를 최대한 유지
- 대규모 destructive migration 지양
- compatibility wrappers 허용

### 8.2 Feature-flagged extraction

다음 기능은 feature flag 또는 lazy initialization을 허용한다.
- vector acceleration
- semantic daemon
- shared memory
- MCP
- continuity systems

### 8.3 Documentation synchronization

리팩터링 중 반드시 다음이 동기화되어야 한다.
- README
- docs/OPERATIONS.md
- architecture docs
- package metadata / shipped entrypoints

---

## 9. 수용 기준

이 스펙이 충족되었다고 보려면 다음 조건이 만족되어야 한다.

1. 프로젝트 구조상 `core`, `adapters`, `extensions`, `apps` 경계가 물리적으로 존재한다.
2. SQLite-only 모드에서 최소 ingest/search/source tracing이 동작한다.
3. vector disabled 상태에서도 CLI/server 기본 기능이 깨지지 않는다.
4. Claude hooks entrypoints는 adapter layer 하위에 위치한다.
5. retrieval 결과는 result type과 retrieval reason을 포함한다.
6. `MemoryService`가 얇은 orchestration facade로 축소되거나 compat layer로 이동한다.
7. README와 구현 현실의 drift가 제거된다.

---

## 10. 기대 효과

### 개발자 관점
- 구조 이해가 빨라짐
- 테스트 경계가 분명해짐
- 신규 기능의 위치를 판단하기 쉬워짐

### 제품 관점
- 코어가 가벼워져 유지보수성이 높아짐
- Claude integration 강점은 유지됨
- shared/MCP/vector 기능을 옵션화하기 쉬워짐

### 장기 관점
- 다른 adapter 가능성이 열림
- code-aware memory나 light graph 기능을 더 안전하게 추가 가능
- 플랫폼 비대화 리스크를 통제할 수 있음

---

## 11. 최종 판단

이 스펙의 핵심은 기능 감축이 아니라 **책임 분리와 구조의 재정의**다.

즉, `claude-memory-layer`는 앞으로도 강한 기능을 유지할 수 있다. 다만 그 기능들이 **코어를 짓누르지 않도록 올바른 층에 배치되어야 한다.**
