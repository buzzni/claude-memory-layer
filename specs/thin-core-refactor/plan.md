# Thin Core Refactor Implementation Plan

> **Version**: 1.0.0
> **Status**: Draft
> **Created**: 2026-04-30
> **For Hermes:** Use this plan to execute the thin-core refactor incrementally without breaking the shipped Claude integration.

**Goal:** `claude-memory-layer`를 thin-core 구조로 재편해 core / adapter / extension / app 경계를 명확히 하고, SQLite 중심의 설명 가능한 메모리 엔진으로 정리한다.

**Architecture:** 기존 구현을 한 번에 갈아엎지 않고 strangler 방식으로 이동한다. 먼저 문서와 타입을 정리하고, 다음으로 `MemoryService` 책임을 작은 서비스들로 추출하며, 그 뒤 Claude hooks를 adapter 레이어로 분리하고, 마지막으로 vector/shared/MCP/continuity를 extension 계층으로 이동한다.

**Tech Stack:** TypeScript, Node.js 18+, better-sqlite3, Hono, LanceDB, existing hook/server/CLI architecture

---

## Phase 0: 문서와 현실 구현 정렬

### Task 0.1: Thin-core 스펙 문서 추가

**Objective:** 리팩터링의 기준 문서를 저장소 안에 정식으로 남긴다.

**Files:**
- Create: `specs/thin-core-refactor/spec.md`
- Create: `specs/thin-core-refactor/plan.md`
- Create: `specs/thin-core-refactor/context.md`

**Step 1: 문서 작성**
- 이 문서 세트를 저장소에 추가한다.

**Step 2: Commit**
```bash
git add specs/thin-core-refactor
git commit -m "docs: add thin-core refactor specification"
```

### Task 0.2: README drift 식별 체크리스트 작성

**Objective:** 구현과 불일치하는 문서를 식별해 추후 수정 범위를 고정한다.

**Files:**
- Modify: `README.md`
- Modify: `docs/OPERATIONS.md`
- Reference: `package.json`
- Reference: `src/services/memory-service.ts`

**Step 1: drift 항목 수집**
문서화할 항목 예:
- SQLite vs DuckDB
- Hono node server vs Bun 서술
- MCP shipped 여부/experimental 여부
- vector/shared 기능의 기본/옵션 구분

**Step 2: drift TODO 섹션 추가 또는 별도 문서화**
간단한 체크리스트 예시:
```markdown
## Architecture drift cleanup
- [ ] Primary store wording updated to SQLite
- [ ] Server runtime wording updated to Hono/@hono/node-server
- [ ] MCP marked as extension/experimental until fully packaged
- [ ] Canonical vs derived storage roles documented
```

**Step 3: Verification**
- README에 현재 shipped reality와 future/experimental을 구분했는지 확인

---

## Phase 1: 새 구조의 빈 뼈대 만들기

### Task 1.1: 새 폴더 구조 생성

**Objective:** 실제 코드 이동 전, 목표 구조의 빈 경계를 만든다.

**Files:**
- Create directories:
  - `src/core/model/`
  - `src/core/storage/`
  - `src/core/derive/`
  - `src/core/retrieval/`
  - `src/core/registry/`
  - `src/core/journal/`
  - `src/core/engine/`
  - `src/adapters/claude/hooks/`
  - `src/adapters/claude/transcript/`
  - `src/adapters/claude/capture/`
  - `src/adapters/claude/context/`
  - `src/extensions/vector/`
  - `src/extensions/analytics/`
  - `src/extensions/shared-memory/`
  - `src/extensions/mcp/`
  - `src/extensions/continuity/`
  - `src/apps/cli/`
  - `src/apps/server/`
  - `src/apps/dashboard/`
  - `src/compat/`

**Step 1: 디렉터리 생성**
- `write_file`로 `.gitkeep` 또는 index 파일을 만들며 구조 생성

**Step 2: 각 계층에 짧은 README 추가**
예:
```markdown
# core
Canonical memory engine. No adapter-specific logic.
```

**Step 3: Commit**
```bash
git add src/core src/adapters src/extensions src/apps src/compat
git commit -m "refactor: add thin-core directory skeleton"
```

### Task 1.2: 루트 barrel 또는 index 방침 정의

**Objective:** 무분별한 cross-import를 막기 위한 import 규칙을 잡는다.

**Files:**
- Create: `src/core/index.ts`
- Create: `src/adapters/claude/index.ts`
- Create: `src/extensions/index.ts`

**Step 1: 최소 export만 노출**
- 각 계층별 public surface를 제한한다.

**Step 2: 경계 규칙 주석 추가**
예:
```ts
// core must not import adapters/apps.
```

---

## Phase 2: 도메인 타입 분리

### Task 2.1: RawEvent 타입 정의

**Objective:** 기존 이벤트 개념을 명시적인 raw 이벤트 모델로 정리한다.

**Files:**
- Create: `src/core/model/raw-event.ts`
- Modify: `src/core/types.ts`

**Step 1: 타입 정의 작성**
포함:
- eventType
- sourceRef
- privacyLevel
- metadata

**Step 2: 기존 타입과 연결**
- 기존 `MemoryEvent`, `MemoryEventInput`과의 대응 관계를 주석으로 명확히 기록

**Step 3: Verification**
- typecheck 시 순환 import 없는지 확인

### Task 2.2: MemoryFact 타입 정의

**Objective:** 검색 최적화 단위를 새 타입으로 정의한다.

**Files:**
- Create: `src/core/model/memory-fact.ts`
- Modify: `src/core/types.ts`

**Step 1: 최소 필드로 시작**
- `factId`, `text`, `factType`, `derivedFromEventIds`, `confidence`, `tags`

**Step 2: code-aware anchor 확장 포인트 남기기**
- `fileRefs`, `symbolRefs` optional

### Task 2.3: MemorySummary / MemoryRule / RetrievalResultEnvelope 정의

**Objective:** summary/rule/result model을 표준화한다.

**Files:**
- Create: `src/core/model/memory-summary.ts`
- Create: `src/core/model/memory-rule.ts`
- Create: `src/core/model/retrieval-result.ts`

**Step 1: retrieval reason taxonomy 추가**
- `semantic_match`, `keyword_match`, `recent_relevance`, 등

**Step 2: resultType enum 추가**
- `fact`, `summary`, `tool_evidence`, `rule`, `source`

**Step 3: Commit**
```bash
git add src/core/model src/core/types.ts
git commit -m "refactor: add thin-core domain model types"
```

---

## Phase 3: Registry 분리

### Task 3.1: Project path/hash 유틸 추출

**Objective:** 프로젝트 경로 normalize/hash/storage path 책임을 분리한다.

**Files:**
- Create: `src/core/registry/project-path.ts`
- Modify: `src/services/memory-service.ts`

**Step 1: 함수 이동**
- `normalizePath`
- `hashProjectPath`
- `getProjectStoragePath`

**Step 2: 기존 import 교체**
- `MemoryService`는 새 모듈을 import하도록 변경

### Task 3.2: Session registry service 추출

**Objective:** session registry의 파일 IO 책임을 core registry 계층으로 이동한다.

**Files:**
- Create: `src/core/registry/session-registry.ts`
- Modify: `src/services/memory-service.ts`

**Step 1: 함수 이동**
- `loadSessionRegistry`
- `registerSession`
- `getSessionProject`

**Step 2: 테스트 추가**
- existing registry 관련 동작 검증 테스트 신규 작성

**Step 3: Verification**
Run:
```bash
npm test -- --run
```
Expected:
- 기존 registry behavior 유지

---

## Phase 4: Ingest / Derive / Query 서비스 추출

### Task 4.1: MemoryIngestService 추출

**Objective:** raw event append 경로를 독립 서비스로 만든다.

**Files:**
- Create: `src/core/engine/memory-ingest-service.ts`
- Modify: `src/services/memory-service.ts`

**Step 1: append flow 이동**
- validation / privacy filter / sqlite append orchestration

**Step 2: 기존 public API 유지**
- `MemoryService.append*` 계열 메서드는 내부적으로 새 서비스 호출

### Task 4.2: FactDeriver 추출

**Objective:** raw event에서 facts를 뽑는 책임을 분리한다.

**Files:**
- Create: `src/core/derive/fact-deriver.ts`
- Modify: `src/services/memory-service.ts`

**Step 1: 최소 도출 규칙 구현**
- prompt/assistant/tool event 각각의 기본 fact derivation 규칙

**Step 2: deterministic key 전략 도입 설계 자리 만들기**
- event-derived fact id 생성 함수 추가

### Task 4.3: SummaryDeriver 추출

**Objective:** turn/session/project summary 로직을 분리한다.

**Files:**
- Create: `src/core/derive/summary-deriver.ts`
- Modify: `src/services/memory-service.ts`

**Step 1: turn/session summary부터 이동**
- continuity/project summary는 나중 단계에서 추가 가능

### Task 4.4: RetrievalEngine 추출

**Objective:** 검색/확장/소스 조회를 명시적 서비스로 분리한다.

**Files:**
- Create: `src/core/retrieval/retrieval-engine.ts`
- Create: `src/core/retrieval/source-resolver.ts`
- Create: `src/core/retrieval/result-expander.ts`
- Modify: `src/services/memory-service.ts`

**Step 1: search contract 정의**
- resultType / reasons 포함

**Step 2: expand/source API 뼈대 추가**
- CLI/API에서 추후 사용 가능하도록 별도 메서드 확보

**Step 3: Commit**
```bash
git add src/core/engine src/core/derive src/core/retrieval src/services/memory-service.ts
git commit -m "refactor: extract ingest derive and retrieval services"
```

---

## Phase 5: Claude Adapter Isolation

### Task 5.1: hooks 물리 이동

**Objective:** Claude hooks를 adapter layer 하위로 옮긴다.

**Files:**
- Move/Copy:
  - `src/hooks/session-start.ts` → `src/adapters/claude/hooks/session-start.ts`
  - `src/hooks/user-prompt-submit.ts` → `src/adapters/claude/hooks/user-prompt-submit.ts`
  - `src/hooks/post-tool-use.ts` → `src/adapters/claude/hooks/post-tool-use.ts`
  - `src/hooks/stop.ts` → `src/adapters/claude/hooks/stop.ts`
  - `src/hooks/session-end.ts` → `src/adapters/claude/hooks/session-end.ts`

**Step 1: 새 위치에 파일 이동 또는 thin wrapper 추가**
- 기존 entrypoint는 compat wrapper로 유지 가능

**Step 2: import paths 고치기**
- core service / registry / retrieval imports 재정리

### Task 5.2: transcript parsing 모듈화

**Objective:** stop/session-end 내부 transcript 복원 코드를 분리한다.

**Files:**
- Create: `src/adapters/claude/transcript/transcript-reader.ts`
- Create: `src/adapters/claude/transcript/turn-reconstructor.ts`
- Modify: `src/adapters/claude/hooks/stop.ts`
- Modify: `src/adapters/claude/hooks/session-end.ts`

### Task 5.3: capture policy 분리

**Objective:** 어떤 tool/prompt/response를 저장할지 정책 모듈로 분리한다.

**Files:**
- Create: `src/adapters/claude/capture/tool-capture-policy.ts`
- Create: `src/adapters/claude/capture/prompt-capture-policy.ts`
- Create: `src/adapters/claude/capture/response-capture-policy.ts`

### Task 5.4: context formatter 분리

**Objective:** retrieval result를 Claude `additionalContext` 문자열로 바꾸는 책임을 분리한다.

**Files:**
- Create: `src/adapters/claude/context/context-formatter.ts`
- Modify: `src/adapters/claude/hooks/user-prompt-submit.ts`

---

## Phase 6: Vector / Accelerator Optionalization

### Task 6.1: vector 계층을 extension으로 이동

**Objective:** vector implementation을 core 밖으로 이동한다.

**Files:**
- Move/Copy:
  - `src/core/vector-store.ts` → `src/extensions/vector/vector-store.ts`
  - `src/core/embedder.ts` → `src/extensions/vector/embedder.ts`
  - `src/core/vector-worker.ts` → `src/extensions/vector/vector-worker.ts`
  - `src/core/vector-outbox.ts` → `src/extensions/vector/vector-outbox.ts`

**Step 1: re-export 유지**
- 기존 import 안정성을 위해 compat export 추가

### Task 6.2: SQLite-only fallback 검증

**Objective:** vector 초기화 실패/비활성 상태에서도 최소 search가 동작하게 한다.

**Files:**
- Modify: `src/core/retrieval/retrieval-engine.ts`
- Modify: `src/services/memory-service.ts`
- Test: `tests/*`

**Step 1: fallback path 명시화**
- keyword + recent timeline 기반 search 보장

**Step 2: 실패 테스트 추가**
- vector unavailable 시 graceful degradation 검증

---

## Phase 7: Extensions Extraction

### Task 7.1: shared-memory 분리

**Objective:** shared store와 promotion을 core 경계 밖으로 이동한다.

**Files:**
- Move/Copy:
  - `src/core/shared-event-store.ts` → `src/extensions/shared-memory/shared-event-store.ts`
  - `src/core/shared-store.ts` → `src/extensions/shared-memory/shared-store.ts`
  - `src/core/shared-vector-store.ts` → `src/extensions/shared-memory/shared-vector-store.ts`
  - `src/core/shared-promoter.ts` → `src/extensions/shared-memory/shared-promoter.ts`

### Task 7.2: continuity/endless mode 분리

**Objective:** working set / consolidated / continuity 계층을 extension으로 이동한다.

**Files:**
- Move/Copy relevant files to `src/extensions/continuity/`

### Task 7.3: MCP 분리

**Objective:** MCP를 extension으로 명시한다.

**Files:**
- `src/mcp/*` → `src/extensions/mcp/*`

**Step 1: package/build wiring 명시화**
- shipped인지 experimental인지 분명히 표기

---

## Phase 8: Apps Cleanup

### Task 8.1: CLI app 이동

**Objective:** CLI를 app layer로 재배치한다.

**Files:**
- `src/cli/index.ts` → `src/apps/cli/index.ts`
- compat wrapper 유지 가능

### Task 8.2: server app 이동

**Objective:** server/API를 app layer로 재배치한다.

**Files:**
- `src/server/*` → `src/apps/server/*`

### Task 8.3: dashboard asset modularization

**Objective:** `src/ui/app.js` 단일 파일을 기능별 모듈로 나눈다.

**Files:**
- `src/ui/*` → `src/apps/dashboard/*`

**Step 1: 최소 분리 단위**
- search
- sessions
- stats/health
- projects
- chat

---

## Phase 9: Hardening & Documentation Finish

### Task 9.1: compat layer 정리

**Objective:** 남은 legacy import wrapper를 줄인다.

**Files:**
- `src/compat/*`
- legacy path files

### Task 9.2: test matrix 재정리

**Objective:** core / adapters / extensions / apps 테스트 구분을 명확히 한다.

**Files:**
- `tests/core/*`
- `tests/adapters/claude/*`
- `tests/extensions/*`
- `tests/apps/*`

### Task 9.3: docs refresh

**Objective:** 실제 구조와 문서를 일치시킨다.

**Files:**
- `README.md`
- `docs/OPERATIONS.md`
- architecture docs

### Task 9.4: graphify update

**Objective:** 코드 변경 후 프로젝트 graphify를 갱신한다.

**Step 1: Run**
```bash
graphify update .
```

**Step 2: Verify**
- `graphify-out/` 보고서에 새 구조 반영 확인

---

## 검증 전략

### 각 Phase 공통 검증
Run:
```bash
npm run typecheck
npm test -- --run
npm run build
```

Expected:
- type errors 없음
- 기존 핵심 테스트 유지
- build 통과

### 중요 시나리오 검증
- hook ingest still works
- session registry still works
- search returns typed envelope
- vector off path works
- shared/mcp disabled path works

---

## 권장 커밋 전략

- docs/specs 단위
- type/model 단위
- registry extraction 단위
- ingest/derive/retrieval extraction 단위
- adapter isolation 단위
- vector/shared/mcp extraction 단위
- app cleanup 단위

각 커밋은 **작고 되돌리기 쉬워야 한다.**

---

## 실행 후 기대 상태

리팩터링이 완료되면:
- 새 기여자는 구조를 훨씬 빨리 이해할 수 있고
- core는 SQLite-only로도 설명 가능하며
- Claude integration은 강점으로 유지되고
- vector/shared/MCP 기능은 extension으로 안전하게 진화할 수 있다.
