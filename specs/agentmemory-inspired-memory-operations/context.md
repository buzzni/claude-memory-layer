# Context: AgentMemory-Inspired Memory Operations Layer

> **Version**: 0.1.0
> **Status**: Draft
> **Created**: 2026-05-18
> **Reference repository**: `agentmemory`
> **Target repository**: `claude-memory-layer`

## 1. 목적

`agentmemory` 오픈소스 프로젝트의 설계/코드/운영 도구를 분석하여 `claude-memory-layer`(CML)가 다음 단계로 발전할 수 있는 기능 계획을 정리한다.

이번 분석의 핵심 결론은 다음과 같다.

1. CML은 이미 **SQLite event store + vector search + MCP context tools + progressive disclosure + entity/edge + endless memory** 기반을 상당 부분 갖추고 있다.
2. `agentmemory`에서 바로 배울 만한 차별점은 단순 검색 성능보다 **운영 가능한 메모리 시스템**이다.
   - action/frontier/checkpoint/lease/routine/sentinel 같은 작업 운영 primitives
   - facets/tags 기반의 명시적 분류/필터
   - retention/decay/access/governance/audit 기반의 메모리 라이프사이클
   - weighted graph retrieval + temporal query + query expansion
   - benchmark/governance/diagnostics를 제품 표면으로 노출하는 방식
3. 기존 CML specs(`endless-mode`, `entity-edge-model`, `progressive-disclosure`, `memory-utilization-improvements`, `task-entity-system`)와 겹치는 기반은 많지만, 위 항목을 하나의 **운영 레이어**로 묶은 spec은 없으므로 신규 feature spec으로 작성한다.

## 2. 분석한 소스

### 2.1 agentmemory 문서/코드

- `README.md`
- `DESIGN.md`
- `ROADMAP.md`
- `GOVERNANCE.md`
- `benchmark/README.md`
- `integrations/hermes/README.md`
- `AGENTS.md`
- `package.json`
- `src/state/schema.ts`
- `src/mcp/tools-registry.ts`
- `src/state/hybrid-search.ts`
- `src/functions/working-memory.ts`
- `src/functions/actions.ts`
- `src/functions/frontier.ts`
- `src/functions/facets.ts`
- `src/functions/retention.ts`
- `src/functions/query-expansion.ts`
- `src/functions/graph-retrieval.ts`
- `src/functions/consolidation-pipeline.ts`

### 2.2 claude-memory-layer 문서/코드

- `README.md`
- `AGENTS.md`
- `package.json`
- `specs/*`
- `src/extensions/mcp/tools.ts`
- `src/extensions/mcp/handlers.ts`
- `src/core/sqlite-event-store.ts`
- `src/core/retriever.ts`
- `src/core/engine/retrieval-orchestrator.ts`
- `src/core/engine/retrieval-disclosure-service.ts`
- `src/core/entity-repo.ts`
- `src/core/edge-repo.ts`
- `src/core/progressive-retriever.ts`
- `src/core/retrieval-benchmark.ts`
- `tests/core/*`, `tests/apps/*`, `tests/extensions/*` 주요 검색 결과

## 3. agentmemory 핵심 아키텍처 요약

### 3.1 iii-engine 기반 Function/Trigger 중심 구조

`agentmemory/AGENTS.md`는 모든 기능이 `iii-sdk`의 `registerFunction` / `registerTrigger` / `sdk.trigger()` 흐름을 통과해야 한다고 규정한다. 이 구조의 의미는 다음과 같다.

- 기능은 독립된 function 단위로 추가된다.
- MCP tool, REST endpoint, hook이 function registry를 공유한다.
- 상태 변경 함수는 audit을 남기는 일관된 패턴을 따른다.
- tool/endpoint를 추가할 때 여러 레지스트리와 테스트의 count assertion을 함께 업데이트하도록 강제한다.

CML은 iii-engine을 쓰지 않지만, 같은 교훈은 적용 가능하다.

- MCP tool/CLI/API/대시보드가 공통 service/repository를 공유해야 한다.
- tool 추가 시 `src/extensions/mcp/tools.ts`, `handlers.ts`, tests, README/spec 문서를 같이 업데이트하는 체크리스트가 필요하다.
- 상태 변경 tool은 모두 audit log와 project scope 검증을 통과해야 한다.

### 3.2 넓은 KV scope가 보여주는 제품 표면

`agentmemory/src/state/schema.ts`의 KV scope는 단순 raw memory를 넘어 다음 product primitives를 포함한다.

| 영역 | 예시 scope | CML에 주는 시사점 |
|---|---|---|
| Raw/session memory | `sessions`, `observations`, `memories`, `summaries` | CML의 `events`, `sessions`, `consolidated_memories`와 대응 |
| Graph | `relations`, `graphNodes`, `graphEdges`, `graphEdgeHistory` | CML `entities`, `edges`에 history/temporal semantics 추가 여지 |
| Semantic/procedural | `semantic`, `procedural`, `lessons`, `insights` | CML consolidation 결과를 실행 가능한 lessons/procedures로 분화 |
| Governance | `audit`, `retentionScores`, `accessLog` | CML retrieval traces/helpfulness를 lifecycle policy로 연결 |
| Work operations | `actions`, `actionEdges`, `leases`, `routines`, `routineRuns`, `signals`, `checkpoints`, `sentinels` | 메모리를 “검색 대상”에서 “작업 운영 시스템”으로 확장 |
| Classification | `facets`, `slots`, `globalSlots` | project/user/task/source별 facet filtering 및 slot형 state 지원 |
| Diagnostics | `health`, `metrics`, `crystals`, `sketches` | dashboard/API에 운영 상태와 quality gate 노출 |

### 3.3 MCP tool surface

분석 스크립트 기준 `agentmemory`는 53개 MCP tool을 정의한다. 대표 tool은 다음과 같다.

- 검색/회상: `memory_recall`, `memory_smart_search`, `memory_timeline`, `memory_file_history`
- 그래프: `memory_relations`, `memory_graph_query`
- 통합/반성: `memory_consolidate`, `memory_reflect`, `memory_insight_list`
- 작업 운영: `memory_action_create`, `memory_action_update`, `memory_frontier`, `memory_next`, `memory_lease`, `memory_checkpoint`, `memory_routine_run`
- 분류: `memory_facet_tag`, `memory_facet_query`
- 검증/거버넌스: `memory_verify`, `memory_audit`, `memory_governance_delete`
- 진단: `memory_diagnose`, `memory_heal`
- Lessons/slots: `memory_lesson_save`, `memory_lesson_recall`, `memory_slot_*`

CML 현재 MCP tool은 9개 중심이다.

- `mem-search`
- `mem-timeline`
- `mem-details`
- `mem-stats`
- `mem-context-pack`
- `mem-import-latest`
- `mem-project-timeline`
- `mem-source-ref`
- `external-market-context`

따라서 CML은 tool을 무조건 50개로 늘리기보다, product value가 높은 operational subset을 curated tool로 추가하는 편이 낫다.

### 3.4 Retrieval 관련 코드 패턴

#### Hybrid / progressive search

`agentmemory`는 `memory_smart_search`를 “Hybrid semantic+keyword search with progressive disclosure”로 노출한다. CML도 이미 `Retriever`, `RetrievalOrchestrator`, `RetrievalDisclosureService`, `ProgressiveRetriever`, `mem-context-pack`을 갖고 있으므로 이 영역은 “새 구현”보다 **facet/graph/retention signals를 기존 retriever scoring에 추가**하는 방향이 적절하다.

#### Query expansion

`src/functions/query-expansion.ts`는 LLM을 이용해 다음을 추출한다.

- 3-5개 reformulation
- temporal concretization
- named entities

CML `Retriever`에는 `intentRewrite` / `queryRewriter` hook이 존재한다. 이 spec에서는 LLM query expansion을 바로 기본값으로 켜기보다, rule-based entity extraction + opt-in LLM expansion으로 시작한다.

#### Graph retrieval

`src/functions/graph-retrieval.ts`는 다음 기능을 제공한다.

- entity name으로 graph node 찾기
- weighted graph traversal(Dijkstra, cost = `1 / weight`)
- chunk에서 linked node로 expand
- temporal `asOf` query
- edge의 `tvalid`, `tvalidEnd`, `tcommit`, `isLatest` 개념

CML에는 `entities`, `edges`, `EntityRepo`, `EdgeRepo`, `graphHop` retrieval option이 이미 있다. 그러나 현재 spec/code 관찰상 `agentmemory`처럼 **weighted k-hop path explanation**이나 **temporal edge state**가 product surface로 드러나지는 않는다. 이 부분이 P1 개선 후보이다.

### 3.5 Consolidation / procedural memory

`agentmemory/src/functions/consolidation-pipeline.ts`는 통합을 semantic/procedural/decay tier로 나눈다.

- semantic: session summaries에서 fact를 추출/병합, confidence/source/access/strength 보존
- procedural: recurring pattern에서 procedure(name, trigger, steps)를 추출
- decay: 오래 접근하지 않은 semantic/procedural memory strength 감소
- reflect tier와 연결

CML `endless-mode`와 `consolidation-worker`는 working set과 consolidated memories를 이미 다룬다. 다만 procedural lessons는 별도 first-class 모델로 아직 약하다. CML에는 Hermes skill 생태계와 궁합이 있으므로, repeated workflow를 `lesson` 또는 `skill_candidate`로 분리하면 제품 가치가 크다.

### 3.6 Actions / frontier / leases / checkpoints

`agentmemory`의 중요한 차별점은 메모리를 “과거 기록”으로만 보지 않는다는 점이다.

- `actions`: 해야 할 일과 상태 전이
- `actionEdges`: 작업 간 dependency/causality
- `frontier` / `next`: 다음으로 할 만한 작업 surface
- `leases`: 여러 agent가 같은 작업을 중복 수행하지 않도록 잠금
- `checkpoints`: 긴 작업의 복구 지점
- `routines` / `sentinels`: 반복 작업과 이벤트 기반 트리거

CML에는 `task-entity-system`과 `entities/edges` 기반이 있어 action model의 토대는 있다. 하지만 MCP/API에서 agent에게 직접 “다음 할 일/lease/checkpoint”를 제공하는 운영 레이어는 별도 spec이 필요하다.

### 3.7 Facets / retention / governance

`agentmemory`는 `facets`로 memory를 다차원 분류하고, `retention`으로 점수화/evict를 제어하며, `audit/governance_delete`로 운영 행위를 추적한다.

CML에는 다음 기반이 있다.

- `retrieval_traces`
- `memory_helpfulness`
- `memory_levels`
- `quarantine` metadata/filtering
- `getMostAccessed`, `getHelpfulMemories`, dashboard stats
- `private-tags`, `privacy/filter`

다만 이들이 아직 하나의 “retention/governance policy”로 연결되지는 않는다. 이 spec의 P0/P1은 CML의 기존 telemetry를 사용해 lifecycle score와 audit surface를 만든다.

## 4. CML 현황과 기존 specs 관계

### 4.1 현재 구현 기반

`src/core/sqlite-event-store.ts` 기준 CML은 다음 테이블/기능을 이미 갖고 있다.

- source of truth: `events`, `sessions`, `event_dedup`
- embeddings/outbox: `embedding_outbox`, `vector_outbox`
- entity/graph: `entities`, `entity_aliases`, `edges`
- endless memory: `working_set`, `consolidated_memories`, `consolidated_rules`, `continuity_log`
- evaluation/analytics: `retrieval_traces`, `memory_helpfulness`, `memory_levels`, `pipeline_metrics`
- sync/projection: `projection_offsets`, `sync_positions`

주요 코드 기반도 이미 존재한다.

- `src/core/retriever.ts`: vector/keyword/recency/decay/graphHop/projectScopeMode/fallback chain
- `src/core/engine/retrieval-orchestrator.ts`: service orchestration
- `src/core/engine/retrieval-disclosure-service.ts`: search → expand → source progressive disclosure
- `src/core/entity-repo.ts`, `src/core/edge-repo.ts`: task/entity/edge repository
- `src/core/retrieval-benchmark.ts`, `scripts/replay-retrieval-benchmark.ts`: replay metrics and gates
- `src/extensions/mcp/tools.ts`, `handlers.ts`: MCP surface

### 4.2 기존 specs와의 중복/확장 관계

| Existing spec | 이미 다루는 것 | 이번 신규 spec에서 추가할 것 |
|---|---|---|
| `endless-mode` | working set, consolidated memory, continuity | lifecycle scoring, retention/decay policy, procedural lessons, checkpoint/lease integration |
| `entity-edge-model` | edges, relation types, entity graph | weighted path traversal, temporal edge history, graph retrieval explanations |
| `task-entity-system` | task/condition/artifact entities, blockers | action/frontier/checkpoint/lease operational tools |
| `progressive-disclosure` | compact search → timeline → details | facet/retention/graph reasons in disclosure envelopes |
| `memory-utilization-improvements` | retrieval traces, helpfulness, quarantine, replay | governance/audit/retention policy that consumes those signals |
| `mcp-desktop-integration` | MCP server and core context tools | curated operational MCP tools with strict project scope/privacy |
| `vector-outbox-v2` | worker outbox/lock pattern | reuse lease semantics for operational actions, avoid duplicate workers |

따라서 신규 spec은 기존 기능을 대체하지 않고, 기존 source-of-truth와 projection을 이용하는 상위 운영 레이어로 둔다.

## 5. Gap analysis

### 5.1 Must-have gaps

1. **Facet taxonomy가 first-class가 아님**
   - tag taxonomy는 있지만 memory별 facet assignment/query/audit가 명시적 MCP tool로 노출되지 않는다.
2. **Action frontier가 product surface가 아님**
   - task entity 기반은 있지만 “다음 작업 추천”, “작업 lease”, “checkpoint resume”이 통합 API로 없다.
3. **Retention/governance policy가 흩어져 있음**
   - helpfulness, access count, level, quarantine, trace가 각각 존재하지만 lifecycle score/decision/audit로 묶이지 않는다.
4. **Graph retrieval 설명력이 약함**
   - graphHop은 있으나 weighted path, temporal query, path explanation, edge history는 더 발전 가능하다.
5. **Procedural lesson extraction이 약함**
   - consolidation memory는 있으나 repeated workflow를 lesson/procedure/skill candidate로 구조화하는 표면이 없다.
6. **Operational benchmark가 부족함**
   - retrieval replay는 좋지만 action/frontier/facet/governance가 회귀 테스트와 fixture로 관리되지 않는다.

### 5.2 Should-not-copy

`agentmemory`의 모든 tool/scope를 그대로 이식하면 CML이 다시 비대해질 위험이 있다. CML은 현재 thin-core refactor 방향과 SQLite source-of-truth 철학이 강하므로 다음을 지킨다.

- raw `events`는 source of truth로 유지한다.
- facets/actions/retention/lessons는 projection/derived table로 둔다.
- MCP tool은 작고 curated한 set으로 시작한다.
- destructive deletion은 기본 금지하고 quarantine/tombstone/audit 우선으로 처리한다.
- LLM 기반 extraction은 opt-in 또는 review queue를 거치게 한다.

## 6. 우선순위 제안

### P0 — 바로 제품 가치가 큰 것

1. Facet assignment/query + retrieval filter
2. Retention score + audit-only dry-run
3. Action/checkpoint minimal model
4. MCP tools: `mem-facet-query`, `mem-action-list`, `mem-frontier`, `mem-retention-audit`
5. Replay/e2e tests for project-scoped, privacy-safe results

### P1 — CML 차별화

1. Weighted graph path expansion and path explanation
2. Temporal edge history / `asOf` query
3. Lease-based action claiming for multi-agent workflows
4. Procedural lesson extraction from repeated successful workflows
5. Dashboard cards for lifecycle and operational memory health

### P2 — Agent platform features

1. Routines/sentinels/signals
2. Team/mesh sharing
3. Image/vision search
4. Automatic skill generation/publishing

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Tool surface가 너무 커짐 | 4-6개 curated tool로 시작하고 CLI/API는 내부 service 재사용 |
| 기존 retrieval quality 회귀 | replay benchmark + retrieval trace fixtures에 facet/graph/retention category 추가 |
| Privacy leak | source-ref redaction, private tag filter, project scope fail-closed, audit logs에는 payload preview only 저장 |
| Derived state drift | projection offsets + rebuild command + idempotent repositories |
| Destructive governance 사고 | delete는 P0에서 실제 삭제 금지, quarantine/tombstone + dry-run + explicit opt-in |
| LLM extraction hallucination | evidence spans, source event ids, confidence threshold, review queue |

## 8. 설계 원칙

1. **CML source-of-truth 유지**: 모든 사실은 raw event 또는 explicit user action에서 출발한다.
2. **Derived projection 격리**: facets/actions/retention/lessons는 rebuild 가능한 projection이다.
3. **Project scope fail-closed**: projectPath/projectHash 불일치 시 기본 거부한다.
4. **Privacy by default**: raw content 대신 source-ref/preview를 우선 노출한다.
5. **Small MCP, rich internals**: MCP tool은 적게, 내부 service는 재사용 가능하게 만든다.
6. **Evaluation first**: new surface마다 replay fixture와 CLI smoke를 만든다.
