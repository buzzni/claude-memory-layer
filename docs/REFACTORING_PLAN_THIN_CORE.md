# claude-memory-layer Thin-Core Refactoring Plan

> 목표: `claude-memory-layer`를 **더 가볍고, 더 설명 가능하고, 더 확장 가능한 구조**로 재편한다. 핵심 방향은 **얇은 코어 메모리 엔진 + 강한 Claude 어댑터 + 선택형 확장 모듈**이다.

---

## 0. 현재 진행 상태 요약 (2026-05-04)

현재 refactor branch에서는 초안 계획의 핵심인 “`MemoryService` 얇게 만들기”가 상당 부분 구현됐다.

완료/진행된 축:

- `MemoryService`는 대부분 compatibility facade가 되었고, 주요 책임은 `src/core/engine/*` 서비스로 이동했다.
- Registry/service-locator 책임은 `src/services/memory-service-registry.ts`로 분리됐다.
- Shared-store 기본 설정은 `src/services/memory-service-config.ts`가 소유한다.
- Retrieval은 `RetrievalOrchestrator`, `RetrievalDisclosureService`, `RetrievalAnalyticsService`, `createRetrievalServices(...)`로 분리됐다.
- Ingest/query/runtime/embedding/endless/shared/composition 책임은 각각 별도 서비스로 분리됐다.
- Claude hooks는 `src/adapters/claude/hooks/*`로 이동했고, 기존 `src/hooks/*`는 wrapper로 남았다.
- Progressive disclosure UX는 service/API/CLI/dashboard까지 `search -> expand -> source` 형태로 연결됐다.

남은 큰 판단:

- shared memory service는 `src/extensions/shared-memory/`로, endless memory service는 `src/extensions/endless-memory/`로, MCP implementation은 `src/extensions/mcp/`로 이동 완료. vector를 실제 `src/extensions/*`로 추가 물리 이동할지 여부
- README/release 문서에서 shipped/stable/experimental feature를 어떻게 표시할지
- `session-history-importer`, `codex-session-history-importer`, `mcp/handlers` 같은 app/adapter callsite를 `MemoryService` facade에서 더 멀리 떼어낼지

상세 commit checkpoint와 검증 결과는 `docs/REFACTORING_MILESTONES_AND_ISSUES.md`의 “현재 구현/검증 상태”를 기준으로 본다.

---

## 1. 왜 이 리팩터링이 필요한가

현재 구조는 기능적으로 강하다. 하지만 다음 문제가 보인다.

1. **코어와 확장 기능 경계가 흐리다**
   - `MemoryService`가 너무 많은 책임을 가진다.
   - 저장, 검색, shared store, endless mode, markdown mirror, workers, continuity, promotion이 한 서비스에 많이 몰려 있다.

2. **저장 계층이 많다**
   - SQLite
   - LanceDB
   - markdown mirror
   - shared store
   - optional Mongo sync
   
   각 계층의 역할은 유용하지만, source of truth가 명확하지 않으면 유지비가 커진다.

3. **Claude 통합이 코어와 강결합되어 있다**
   - 프로젝트 자체 강점이 Claude hooks인 것은 맞지만,
   - 이 때문에 코어 메모리 엔진 자체가 재사용 가능한 구조로 잘 드러나지 않는다.

4. **문서와 구현의 drift가 있다**
   - README 설명과 실제 구현의 차이가 신규 기여자와 미래 유지보수 비용을 높인다.

---

## 2. 리팩터링의 설계 원칙

### 원칙 1. Canonical과 Derived를 구분한다
- **Canonical**: 반드시 보존되는 진실한 저장소
- **Derived**: 언제든 재생성 가능한 저장소/인덱스/요약

권장 정의:
- **SQLite = machine canonical**
- **Markdown journal = human-readable canonical projection**
- **LanceDB = derived acceleration index**
- **shared / Mongo sync = optional extension replication layer**

### 원칙 2. Raw, Fact, Summary를 분리한다
메모리 계층을 최소 3단으로 나눈다.

1. **RawEvent**
   - 원본 prompt / assistant / tool output / markers / imports
2. **MemoryFact**
   - retrieval에 최적화된 작은 사실 단위
3. **MemorySummary**
   - turn/session/project/continuity 수준 요약

### 원칙 3. 코어는 SQLite-only로도 최소 기능 동작해야 한다
- 검색 최소 모드는 SQLite keyword + recent timeline으로 동작 가능해야 한다.
- Vector/LanceDB는 성능 향상 계층으로 취급한다.
- semantic daemon도 optional accelerator여야 한다.

### 원칙 4. Claude lifecycle integration은 adapter로 분리한다
Claude Code hooks는 매우 중요하지만, 코어와 같은 층에 있으면 안 된다.

### 원칙 5. 실험 기능은 확장 모듈로 이동한다
- shared store
- Mongo sync
- MCP
- endless/consolidation 실험
- advanced graph/task systems

이런 것들은 코어를 무겁게 하지 않도록 feature boundary를 가져야 한다.

---

## 3. 목표 아키텍처

### Layer A. Core Memory Engine
항상 필요한 최소 시스템.

포함:
- project/session registry
- canonical SQLite store
- raw event model
- fact derivation pipeline
- summary pipeline
- retrieval engine
- citation/source tracing
- import/export

비포함:
- Claude-specific hook logic
- dashboard UI
- shared replication
- Mongo sync
- experimental graph layers

### Layer B. Claude Adapter
Claude Code lifecycle와의 결합층.

포함:
- `SessionStart`
- `UserPromptSubmit`
- `PostToolUse`
- `Stop`
- `SessionEnd`
- transcript extraction
- context injection formatting
- tool capture policy

### Layer C. Optional Accelerators
성능과 품질 향상용 옵션.

포함:
- vector index (LanceDB)
- embeddings / batch workers
- semantic daemon
- reranking
- helpfulness analytics
- retrieval traces visualization

### Layer D. Optional Extensions
실험 또는 고급 기능.

포함:
- shared store
- Mongo sync
- MCP server
- advanced continuity systems
- entity/task graph enhancements
- future code-aware memory anchors

### Layer E. Apps
사용자-facing 프로그램.

포함:
- CLI
- dashboard server
- static UI

---

## 4. 새 도메인 모델 제안

### 4.1 RawEvent
원본 이벤트 저장 단위.

필드 예시:
- `event_id`
- `project_hash`
- `session_id`
- `turn_id`
- `event_type` (`user_prompt`, `assistant_response`, `tool_output`, `session_marker`, `imported_turn`)
- `content`
- `tool_name`
- `metadata`
- `created_at`
- `privacy_level`
- `source_ref`

### 4.2 MemoryFact
검색에 쓰는 최소 사실 단위.

필드 예시:
- `fact_id`
- `project_hash`
- `fact_type`
- `text`
- `derived_from_event_ids[]`
- `source_kind`
- `tags`
- `confidence`
- `importance`
- `recency_bucket`
- `entity_refs[]`
- `file_refs[]`
- `symbol_refs[]`
- `created_at`
- `updated_at`

### 4.3 MemorySummary
상위 요약 레이어.

종류:
- turn summary
- session summary
- project summary
- continuity summary
- timeline digest

### 4.4 MemoryRule / Preference
장기적 반복 패턴/선호/관례.

예:
- preferred coding style
- recurring workflow preference
- stable project constraints

### 4.5 RetrievalTrace
검색 explainability와 개선용 로그.

필드 예시:
- `query`
- `selected_ids`
- `candidate_ids`
- `retrieval_reason`
- `strategy`
- `accepted`
- `helpful_score`
- `used_in_response`

---

## 5. 검색 제품 구조 재설계

현재의 검색 능력은 이미 나쁘지 않다. 문제는 **사용자/개발자 관점에서 구조가 덜 선명하다**는 점이다.

### 새 retrieval UX 제안

#### Level 1: Search
- 빠른 후보 목록
- 짧은 snippet
- why matched 표시

#### Level 2: Expand
- 더 넓은 맥락 복원
- 같은 turn / session / tool run 내 주변 기억 표시

#### Level 3: Source
- 원문 transcript / tool output / imported source로 drill-down
- citation trace 제공

### 결과 타입 표준화
모든 retrieval 결과는 아래 타입 중 하나를 가진다.
- `fact`
- `summary`
- `tool_evidence`
- `session_memory`
- `rule`
- `source`

### Retrieval reason 표준화
예:
- `semantic_match`
- `keyword_match`
- `recent_relevance`
- `continuity_link`
- `entity_overlap`
- `tool_followup`
- `summary_fallback`

---

## 6. 저장 전략 재정의

### 권장 기본 원칙
- SQLite는 **항상 진실의 중심**
- LanceDB는 **재생성 가능한 index**
- markdown은 **사람이 읽는 projection/journal**
- shared/Mongo는 **replication/extension**

### 실전 운영 의미
1. SQLite만 있어도 데이터는 살아 있어야 함
2. LanceDB가 깨져도 rebuild 가능해야 함
3. markdown journal만 봐도 사람은 전체 흐름을 이해할 수 있어야 함
4. shared 기능이 꺼져도 코어는 정상 동작해야 함

---

## 7. `MemoryService` 분해 계획

현재 `MemoryService`는 지나치게 큰 facade다. 완전 제거가 아니라 **얇은 orchestration facade**로 축소하는 게 좋다.

### 목표 분해

#### 1) `CoreMemoryEngine`
- raw event append
- fact derivation trigger
- summary derivation trigger
- retrieval dispatch

#### 2) `ProjectRegistryService`
- project path hashing
- session registry 관리

#### 3) `FactDeriver`
- raw event → fact 변환
- tool outputs / prompts / assistant responses에서 핵심 사실 추출

#### 4) `SummaryDeriver`
- turn/session/project digest 생성

#### 5) `RetrievalEngine`
- keyword / vector / fallback dispatch
- result typing
- explanation metadata 부착

#### 6) `VectorIndexService`
- embedding queue
- batch embed
- LanceDB sync

#### 7) `JournalService`
- markdown journal append
- export/import friendly rendering

#### 8) `SharedMemoryExtension`
- shared promotion
- shared search
- Mongo sync integration

이렇게 나누면 `MemoryService`는 호환성 wrapper 또는 app-level composition root로 남길 수 있다.

---

## 8. Claude adapter 재설계

Claude 전용 로직은 `adapters/claude`로 모아야 한다.

### 여기 들어갈 것
- hooks entrypoints
- hook payload parsing
- transcript extraction
- tool observation filtering
- additionalContext formatting
- Claude-specific heuristics

### 이점
- Claude integration이 더 읽기 쉬워짐
- 다른 agent adapter 가능성 열림
- core testing이 훨씬 쉬워짐

---

## 9. 이행 전략

완전 재작성은 비추천. **strangler pattern**으로 단계적 이전을 권장한다.

### Phase 0. 용어/문서 정리
- SQLite / LanceDB / markdown / shared의 역할을 문서화
- README drift 해소
- canonical vs derived 정의 확정

### Phase 1. 코드 경계 만들기
- 새 폴더 구조 생성
- 기존 구현은 유지하되 re-export로 연결
- `MemoryService` 내부에서 새 서비스 호출 시작

### Phase 2. 도메인 모델 분리
- RawEvent / MemoryFact / MemorySummary 타입 도입
- 기존 table/flow를 새 모델에 맞춰 점진 변환

### Phase 3. Retrieval product 정리
- result types, reasons, expand/source API 추가
- CLI/API/dashboard에 동일한 개념 노출

### Phase 4. 가속 계층 분리
- vector, daemon, analytics를 optional 계층으로 명시
- SQLite-only fallback을 공식 지원

### Phase 5. extension 격리
- shared/Mongo/MCP/experimental graph를 extension 폴더와 feature flag로 이동

---

## 10. 성공 기준

이 리팩터링이 성공했다는 기준은 다음이다.

1. **새 개발자가 30분 내 구조를 설명할 수 있다**
2. **SQLite만으로 최소 검색/기억 기능이 동작한다**
3. **LanceDB/daemon이 꺼져도 시스템이 깨지지 않는다**
4. **Claude hooks 코드와 core memory 코드가 물리적으로 분리된다**
5. **검색 결과가 왜 나왔는지 설명 가능하다**
6. **shared/Mongo/MCP를 제거해도 core는 영향이 작다**
7. **README와 실제 구현이 다시 일치한다**

---

## 11. 최종 판단

이 계획의 핵심은 “더 많은 기능 추가”가 아니다.

핵심은:
- 구조를 정돈하고
- 코어를 얇게 만들고
- 이미 만든 강한 기능을 잃지 않으면서
- 확장을 안전하게 계속할 수 있게 만드는 것

즉, `claude-memory-layer`는 앞으로
**feature-rich monolith**가 아니라,
**composable local memory architecture**로 진화해야 한다.
