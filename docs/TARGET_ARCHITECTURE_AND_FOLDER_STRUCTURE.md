# claude-memory-layer Target Architecture & Folder Structure

## 목적
이 문서는 `claude-memory-layer`의 목표 구조를 **폴더 단위와 모듈 단위**로 제안한다.
핵심 목표는 다음 4개 경계를 명확히 나누는 것이다.

- `core`
- `adapters`
- `extensions`
- `apps`

---

## 1. 현재 문제 요약

현재 구조는 기능은 많지만 경계가 혼합돼 있다.
예를 들어:
- `src/core` 안에 저장/검색뿐 아니라 확장적 성격의 개념이 많음
- `src/services/memory-service.ts` 가 사실상 너무 많은 계층을 합성
- `src/hooks`는 실질적으로 `Claude adapter`인데 독립 layer로 안 보임
- `src/server`와 `src/ui`는 app layer인데 core와 논리 경계가 문서상 덜 명확함
- `src/mcp`는 extension인지 core surface인지 애매함

---

## 2. 목표 구조 개요

```text
src/
  core/
    model/
    storage/
    derive/
    retrieval/
    registry/
    journal/
    engine/
    privacy/
    shared-types/

  adapters/
    claude/
      hooks/
      transcript/
      capture/
      context/
      install/

  extensions/
    vector/
    analytics/
    shared-memory/
    mongo-sync/
    mcp/
    continuity/
    experiments/

  apps/
    cli/
    server/
    dashboard/

  compat/
    legacy-memory-service.ts
    legacy-hook-entrypoints.ts
```

---

## 3. 폴더별 상세 역할

## 3.1 `src/core/`
이곳은 **항상 살아남는 최소 메모리 엔진**이다.

### `src/core/model/`
도메인 타입/계약.

예:
- `raw-event.ts`
- `memory-fact.ts`
- `memory-summary.ts`
- `memory-rule.ts`
- `retrieval-trace.ts`
- `citation.ts`
- `types.ts`

역할:
- DB/adapter/UI가 공유하는 공통 개념 정의
- “이 시스템이 무엇을 다루는가”를 가장 명확히 보여주는 층

### `src/core/storage/`
SQLite canonical storage 계층.

예:
- `sqlite.ts`
- `session-repo.ts`
- `event-repo.ts`
- `fact-repo.ts`
- `summary-repo.ts`
- `rule-repo.ts`
- `retrieval-trace-repo.ts`
- `migrations/`

역할:
- canonical DB 접근
- table lifecycle / migration
- repo abstraction

### `src/core/derive/`
파생 메모리 생성 계층.

예:
- `fact-deriver.ts`
- `summary-deriver.ts`
- `tool-fact-deriver.ts`
- `session-summary-deriver.ts`
- `continuity-summary-deriver.ts`

역할:
- RawEvent → Facts/Summaries
- derived layers는 가능한 재생성 가능해야 함

### `src/core/retrieval/`
검색 및 결과 조립.

예:
- `retrieval-engine.ts`
- `keyword-retriever.ts`
- `hybrid-retriever.ts`
- `result-ranker.ts`
- `result-expander.ts`
- `source-resolver.ts`
- `retrieval-reasons.ts`

역할:
- search / expand / source drill-down
- why-matched metadata 부여

### `src/core/registry/`
프로젝트/세션 registry.

예:
- `project-path.ts`
- `project-registry.ts`
- `session-registry.ts`

### `src/core/journal/`
사람이 읽는 메모리 저널/markdown projection.

예:
- `journal-renderer.ts`
- `journal-writer.ts`
- `journal-export.ts`

### `src/core/engine/`
코어 orchestration.

예:
- `core-memory-engine.ts`
- `memory-query-service.ts`
- `memory-ingest-service.ts`
- `memory-maintenance-service.ts`

주의:
- 지금의 `MemoryService`처럼 everything facade가 되면 안 됨
- 조립은 하되, 각 기능 구현은 하위 모듈에 위임

### `src/core/privacy/`
개인정보/민감정보 필터 계층.
현재 있는 privacy 관련 코드가 이 층으로 자연스럽게 모인다.

### `src/core/shared-types/`
app/adapter/extension이 공유하는 직렬화 스키마.
예:
- API response DTO
- hook context payload
- search result envelope

---

## 3.2 `src/adapters/`
외부 시스템과의 통합층.

## `src/adapters/claude/`
Claude Code 통합 전용.

### `hooks/`
- `session-start.ts`
- `user-prompt-submit.ts`
- `post-tool-use.ts`
- `stop.ts`
- `session-end.ts`

### `transcript/`
- `transcript-reader.ts`
- `assistant-extractor.ts`
- `turn-reconstructor.ts`

### `capture/`
- `tool-capture-policy.ts`
- `prompt-capture-policy.ts`
- `response-capture-policy.ts`

### `context/`
- `context-formatter.ts`
- `retrieval-prompt-builder.ts`
- `additional-context-writer.ts`

### `install/`
- plugin install/uninstall wiring
- `.claude-plugin` manifest coordination

핵심:
- Claude-specific heuristic과 lifecycle은 모두 여기로 모은다.

---

## 3.3 `src/extensions/`
선택 기능 / 고급 기능 / 가속 기능.

### `vector/`
LanceDB와 embedding 처리.

예:
- `vector-store.ts`
- `embedder.ts`
- `vector-worker.ts`
- `vector-outbox.ts`
- `vector-index-maintenance.ts`

원칙:
- vector 계층이 없어도 core는 최소 기능 동작

### `analytics/`
관찰/분석 계층.

예:
- `helpfulness-service.ts`
- `retrieval-trace-service.ts`
- `stats-service.ts`
- `health-service.ts`

### `shared-memory/`
cross-project shared memory.

예:
- `shared-event-store.ts`
- `shared-store.ts`
- `shared-promoter.ts`

### `mongo-sync/`
Mongo replication 및 sync workers.

### `mcp/`
MCP server, tools, handlers.

중요:
- MCP는 코어가 아니라 extension surface로 보는 것이 맞다.

### `continuity/`
현재 endless mode / working set / consolidated store / continuity manager 성격의 기능을 모은다.

예:
- `working-set-store.ts`
- `consolidated-store.ts`
- `continuity-manager.ts`
- `consolidation-worker.ts`
- `graduation-worker.ts`

### `experiments/`
아직 제품 경계가 덜 명확한 기능들을 수용.

예:
- entity-edge/task 고도화
- future code-aware memory anchors
- speculative retrieval policies

---

## 3.4 `src/apps/`
사용자-facing 실행 표면.

### `apps/cli/`
현재 `src/cli`를 이리로 이동.

역할:
- command parsing
- app service composition
- install/uninstall
- dashboard start
- ops commands

### `apps/server/`
현재 `src/server` 이동.

역할:
- API routing
- app-layer composition
- auth/local safety
- static UI serving

### `apps/dashboard/`
현재 `src/ui` 자산 정리.

권장 구조:
- `dashboard/index.html`
- `dashboard/styles/`
- `dashboard/scripts/`
- `dashboard/components/` (프레임워크 없이도 모듈 분리 가능)

---

## 3.5 `src/compat/`
점진 이전용 호환 레이어.

예:
- `legacy-memory-service.ts`
- `legacy-hook-entrypoints.ts`

역할:
- 기존 import path 깨짐 방지
- 단계적 이동 허용
- 대규모 rewrite 없이 strangler migration 지원

---

## 4. 현재 파일의 추천 이동 예시

### 현재 `src/services/memory-service.ts`
분해 대상.

추천 분리:
- `src/core/engine/core-memory-engine.ts`
- `src/core/registry/session-registry.ts`
- `src/core/registry/project-path.ts`
- `src/extensions/vector/vector-index-service.ts`
- `src/extensions/shared-memory/shared-memory-service.ts`
- `src/extensions/continuity/continuity-service.ts`
- `src/core/journal/journal-service.ts`

### 현재 `src/hooks/*`
→ `src/adapters/claude/hooks/*`

### 현재 `src/server/*`
→ `src/apps/server/*`

### 현재 `src/ui/*`
→ `src/apps/dashboard/*`

### 현재 `src/mcp/*`
→ `src/extensions/mcp/*`

### 현재 `src/core/sqlite-event-store.ts`
→ `src/core/storage/event-repo.ts` 또는 `sqlite-event-store.ts`

### 현재 `src/core/vector-store.ts`
→ `src/extensions/vector/vector-store.ts`

### 현재 `src/core/progressive-retriever.ts`
→ `src/core/retrieval/result-expander.ts` 또는 `progressive-retrieval.ts`

### 현재 endless/shared 관련 파일
→ `src/extensions/continuity/*`, `src/extensions/shared-memory/*`

---

## 5. 권장 공개 인터페이스

외부에서 많이 쓰는 interface는 적게 유지하는 것이 좋다.

### Core public API
```ts
interface CoreMemoryEngine {
  appendEvent(input: RawEventInput): Promise<AppendResult>
  deriveFacts(eventId: string): Promise<FactDerivationResult>
  deriveSummary(scope: SummaryScope, refId: string): Promise<SummaryResult>
  search(query: MemoryQuery): Promise<SearchResult>
  expand(resultId: string): Promise<ExpandedResult>
  getSource(sourceRef: string): Promise<SourcePayload>
}
```

### Claude adapter public API
```ts
interface ClaudeMemoryAdapter {
  onSessionStart(payload: ClaudeSessionStart): Promise<HookResponse>
  onUserPromptSubmit(payload: ClaudeUserPrompt): Promise<HookResponse>
  onPostToolUse(payload: ClaudeToolUse): Promise<HookResponse>
  onStop(payload: ClaudeStopPayload): Promise<HookResponse>
  onSessionEnd(payload: ClaudeSessionEnd): Promise<HookResponse>
}
```

### Extension registration concept
```ts
interface MemoryExtension {
  name: string
  initialize(ctx: ExtensionContext): Promise<void>
  shutdown?(): Promise<void>
}
```

---

## 6. 경계 규칙

### 규칙 1
`core`는 `adapters`를 import하면 안 된다.

### 규칙 2
`core`는 `apps`를 import하면 안 된다.

### 규칙 3
`extensions`는 `core`를 사용할 수 있지만, core의 기본 동작을 필수로 바꾸면 안 된다.

### 규칙 4
`apps`는 composition root다. 조립은 하되, 도메인 로직을 담지 않는다.

### 규칙 5
Claude-specific types와 heuristics는 `adapters/claude` 안에 둔다.

---

## 7. 이 구조의 장점

1. 코어가 무엇인지 한눈에 보인다.
2. Claude hooks가 코어를 오염시키지 않는다.
3. vector/shared/MCP 같은 기능을 옵션으로 다루기 쉬워진다.
4. 테스트 경계가 분명해진다.
5. 장기적으로 다른 adapter를 붙이기 쉬워진다.
6. “무거운 기능을 버리지 않고도” 코어를 다시 얇게 만들 수 있다.

---

## 8. 최종 권고

이 구조는 단번에 완성할 필요 없다.
가장 현실적인 방법은:

1. 새 폴더 구조 먼저 만들고
2. 기존 파일을 한 번에 다 옮기지 말고
3. 새 모듈로 조금씩 기능을 빼며
4. `compat` 레이어로 기존 호출을 유지하는 방식이다.

즉,
**폴더 구조 재설계는 단순 미관 문제가 아니라, 앞으로 기능이 늘어도 코어를 지키기 위한 운영 전략**이다.
